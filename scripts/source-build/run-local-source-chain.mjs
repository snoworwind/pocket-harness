#!/usr/bin/env node
// 在本地（WSL/Linux）跑**与 CI 同一条**来源审计链。
//
// 设计要点：命令**不是**在这里重写一遍，而是直接从 `.github/workflows/build-apk-source.yml`
// 抽出各步骤的 `run:` 脚本原样执行——本地跑的命令与远程跑的逐字节同一份，只有就地解析、
// 不会各写一套然后漂移。`uses:` 步骤（checkout / setup-*）跳过，改为本地前置检查。
//
// 为什么要它：远程一次 60-90 分钟；引擎、快照、APK 门禁那几面无法靠「输入侧预检」覆盖，
// 只能在本地把链跑起来。分阶段 + `--from/--to` 让失败后从中间续跑，不必每次从头。
//
// 阶段语义：STAGES 只登记**核心阶段**；未命中任何阶段的步骤**继承前一个具名阶段**，
// 而不是一律归入 misc（索引 -1）。这条规则是 A09 的修法：构建之后的最终复验
// （快照语义归一化、APK 文件复验）没有独立阶段名，必须跟随 `apk`，否则
// `--from apk` / `--only apk` 会把它们过滤掉，续跑看起来成功但最终产物没有复验。
// 开头尚未遇到具名阶段的本地前置步骤（分支检查、npm 缓存隔离）保持 misc：
// 阶段过滤契约从 `verify` 开始，`--list` 仍把它们显示为 misc。
//
// 用法（在 WSL/Linux 的仓库根执行）：
//   node scripts/source-build/run-local-source-chain.mjs --list
//   node scripts/source-build/run-local-source-chain.mjs                 # 全链
//   node scripts/source-build/run-local-source-chain.mjs --from snapshot # 从快照阶段续跑
//   node scripts/source-build/run-local-source-chain.mjs --only apk      # 只跑打包阶段
//   node scripts/source-build/run-local-source-chain.mjs --dry-run       # 只打印将要执行什么
//   node scripts/source-build/run-local-source-chain.mjs --build-workspace /tmp/dsh-build --from snapshot
// 实际执行只使用 HEAD 的隔离检出；不包含原工作树未提交文件。隔离目录保留用于续跑与取件。
//
// 环境：ANDROID_HOME 默认取 `.deploy-tmp/android-sdk`（缺失即判红并给出铺法）。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMaintainedSource, committedWorkflow, prepareSourceWorkspace, sourceCommit } from './local-source-workspace.mjs'
import { resolveSourceRepository } from './record-project-components.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** 步骤名 → 阶段。未列出的步骤按「跟随前一个具名阶段」处理（见文件头注释）。 */
export const STAGES = [
  { key: 'verify', label: '输入与工具自检', match: /^Verify pinned source replacement/ },
  { key: 'apksigner', label: '解析 apksigner（含签名自证）', match: /^Resolve the Android SDK apksigner/ },
  { key: 'sources', label: '取固定来源（Harness / 组件 / 市场产物）', match: /^Checkout pinned/ },
  { key: 'harness', label: '从源码构建 Harness 并打包', match: /^Build and pack DeepSeek Harness/ },
  { key: 'plugins', label: '构建插件与市场补丁', match: /^Build project plugins|^Apply project patches/ },
  // 注意：bootstrap 认证/取密钥那一步在文件里排得靠前（紧跟 harness 之后），但它属于 Termux 链
  // ——归到 termux 阶段，`--from termux` 才不会再把它跳过（曾因此报「Termux 签名密钥不在场」）。
  { key: 'termux', label: '组装并验签 Termux 基座', match: /^Authenticate official Termux bootstrap|^Add Node\.js to the clean Termux base|^Verify signed Termux repository|^Cross-compile node-pty|^Assemble clean Termux base/ },
  { key: 'linux-assets', label: '构建签名校验的离线 ARM64 Linux 资产', match: /^Install Linux asset cross-build tools|^Prepare pinned Debian archive trust keys|^Build source-owned offline ARM64 Linux assets/ },
  { key: 'snapshot', label: '构建运行时快照', match: /^Build runtime snapshot/ },
  // Kotlin 单测门禁是 APK 步的**前置输入**（build-apk.mjs 的 check-kotlin-test-count 会读它产出的
  // 结果目录）。不归 snapshot：`--to snapshot` 不应顺带跑十几分钟单测；归 apk 使 `--only apk`
  // 自带它所需的测试结果。
  { key: 'apk', label: '门禁 + 注入 + 打包 ARM64 APK', match: /^单元测试门禁前置|^Build ARM64 APK/ },
]
const SKIP_STEP = /^(Set up job|Checkout project source|Prepare build tools|Run actions\/setup-|Install archive and signature tools|Upload APK and provenance|Post )/

/** 极简 YAML 步骤解析：只取 steps[].name/.run/.shell/.uses（够用且不引依赖）。
 *
 * 只处理两种 `run` 写法：行内（`- run: cmd`）与块标量（`run: |` + 缩进块）。块标量的内容缩进
 * **由第一行内容动态确定**（不写死 10 空格——workflow 一旦调整层级，写死就会静默少读脚本）。
 *
 * 解析是纯函数（不读全局、不 exit），供 CLI 与回归测试共用；解析结果必须覆盖 YAML 里全部
 * 步骤条目——一旦 workflow 换了写法而解析器没跟上，必须当场判红，不能少跑几步还报「跑完」。
 */
export function parseWorkflowSteps(workflowText) {
  // Windows 检出是 CRLF：行尾的 \r 会让 `(.*)$` 直接失配（JS 的 `.` 不匹配 \r），
  // 表现为「一个步骤都解析不到」。统一成 LF 再解析。
  // Local execution owns one build replica, never the CI verifier/private signer.
  const text = workflowText.replaceAll('\r\n', '\n').split('\n  verify-arm64:')[0]
  const lines = text.split('\n')
  const steps = []
  let current = null
  let runIndent = null // 正在收集的 run 块的内容缩进；null = 不在块里
  const assign = (key, rest) => {
    const value = rest.trim()
    if (key === 'name') current.name = value
    else if (key === 'uses') current.uses = value
    else if (key === 'shell') current.shell = value
    else if (key === 'run') {
      if (value === '|' || value === '|-' || value === '>') {
        runIndent = -1 // -1 = 首个内容行定缩进
        current.run = '' // 必须先置空串：留 null 会在拼接时变成字面量 "null 脚本"
      } else current.run = `${value}\n`
    }
  }
  const pushStep = () => { if (current) steps.push(current) }
  for (const line of lines) {
    const itemStart = /^ {6}- (name|uses|run|shell):(.*)$/.exec(line)
    if (itemStart) {
      pushStep()
      current = { name: null, run: null, shell: null, uses: null }
      runIndent = null
      assign(itemStart[1], itemStart[2])
      continue
    }
    if (runIndent !== null && current) {
      if (line.trim() === '') { current.run += '\n'; continue }
      if (runIndent === -1) runIndent = line.match(/^ */)[0].length
      if (line.length >= runIndent && line.slice(0, runIndent).trim() === '') {
        current.run += `${line.slice(runIndent)}\n`
        continue
      }
      runIndent = null // 缩进回退 = 块结束，落到下面按普通键处理
    }
    const kv = /^ {8}(name|uses|run|shell):(.*)$/.exec(line)
    if (kv && current) assign(kv[1], kv[2])
  }
  pushStep()
  const declared = (text.match(/^ {6}- (name|uses):/gm) ?? []).length
  if (steps.length !== declared) {
    throw new Error(`workflow 步骤解析不完整：解析到 ${steps.length} 个，YAML 里声明 ${declared} 个。`
      + '\n（build-apk-source.yml 的步骤写法变了？请同步本脚本的解析器。）')
  }
  const runnable = steps.filter((s) => s.run || s.uses)
  const withoutRun = steps.filter((s) => !s.run && !s.uses)
  if (withoutRun.length) {
    throw new Error(`有 ${withoutRun.length} 个步骤既无 run 也无 uses —— 解析器漏读了：${withoutRun.map((s) => s.name ?? '(无名)').join(', ')}`)
  }
  return runnable
}

/** 把解析出的步骤整理成可执行计划。`stageSource` 记录阶段来源，便于审计与负控：
 *  named = 明确命中 STAGES；inherited = 跟随前一个具名阶段；pre-stage = 首个具名阶段之前。
 */
export function planSteps(workflowText) {
  const planned = []
  let inheritedStage = null
  for (const step of parseWorkflowSteps(workflowText)) {
    if (SKIP_STEP.test(step.name ?? '')) continue
    if (!step.run) continue
    const matched = STAGES.find((stage) => stage.match.test(step.name ?? ''))
    if (matched) inheritedStage = matched.key
    planned.push({
      name: step.name ?? '(未命名)',
      stage: matched?.key ?? inheritedStage ?? 'misc',
      stageSource: matched ? 'named' : (inheritedStage ? 'inherited' : 'pre-stage'),
      shell: step.shell,
      run: step.run.trimEnd(),
    })
  }
  return planned
}

/** 阶段过滤（纯函数）：与 CLI 的 --from/--to/--only/--from-step 同一份实现。 */
export function selectPlanned(planned, { from = null, to = null, only = null, fromStep = null } = {}) {
  const stageIndex = (key) => STAGES.findIndex((stage) => stage.key === key)
  return planned.filter((item, index) => {
    if (fromStep !== null) return index >= fromStep
    if (only) return item.stage === only
    if (from && stageIndex(item.stage) < stageIndex(from)) return false
    if (to && stageIndex(item.stage) > stageIndex(to)) return false
    return true
  })
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name, fallback = null) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : fallback
  }

  const ANDROID_HOME = resolve(process.env.ANDROID_HOME || join(ROOT, '.deploy-tmp', 'android-sdk'))
  const repoCommit = sourceCommit(ROOT)
  if (flag('--build-workspace') && (!value('--build-workspace') || value('--build-workspace').startsWith('--'))) {
    console.error('--build-workspace 需要指定独立的目录路径')
    process.exit(2)
  }

  let planned
  try {
    planned = planSteps(committedWorkflow(ROOT, repoCommit))
  } catch (error) {
    console.error(error.message)
    process.exit(3)
  }

  if (flag('--list')) {
    for (const [i, item] of planned.entries()) console.log(`${String(i).padStart(2)}  [${item.stage}]  ${item.name}`)
    process.exit(0)
  }

  const from = value('--from', null)
  const to = value('--to', null)
  const only = value('--only', null)
  // 同阶段内续跑：--from-step 用 `--list` 打印的序号（阶段粒度太粗，同一阶段里前几步已完成时用得上）。
  const fromStep = value('--from-step', null) === null ? null : Number(value('--from-step'))
  if (fromStep !== null && (!Number.isInteger(fromStep) || fromStep < 0 || fromStep >= planned.length)) {
    console.error(`--from-step 需为 0..${planned.length - 1} 的整数`)
    process.exit(2)
  }
  const stageIndex = (key) => STAGES.findIndex((s) => s.key === key)
  if (from && stageIndex(from) < 0) { console.error(`未知阶段: ${from}（可选：${STAGES.map((s) => s.key).join(', ')}）`); process.exit(2) }
  if (to && stageIndex(to) < 0) { console.error(`未知阶段: ${to}`); process.exit(2) }
  if (only && !STAGES.some((s) => s.key === only)) { console.error(`未知阶段: ${only}`); process.exit(2) }

  const selected = selectPlanned(planned, { from, to, only, fromStep })

  // ── 本地前置检查（代替被跳过的 uses: 步骤）────────────────────────────────
  const preflight = () => {
    const missing = []
    if (!existsSync(ANDROID_HOME)) missing.push(`ANDROID_HOME 不在场：${ANDROID_HOME}`)
    for (const rel of ['build-tools/36.0.0/apksigner', 'platforms/android-36/android.jar']) {
      if (!existsSync(join(ANDROID_HOME, rel))) missing.push(`Android SDK 缺少 ${rel}（在 ${ANDROID_HOME}）`)
    }
    // NDK 不作为前置：它由链自己的 node-pty 步骤下载并按 sha1 校验后解包。**预解一份反而有害**——
    // 该步骤用 `unzip`（无 -o），已有目录会触发交互式覆盖确认，在非交互环境读到 EOF 即判死。
    // 注意 `python`（不带 3）：链里的编排器（build-apk.mjs）调的就是它，而 Ubuntu 默认只装 python3。
    // 缺它时报错发生在编排器内部，表现为**静默退出码 1**（无任何输出），极难定位——故列进前置检查，
    // 让它在开跑前就带着说明判红。
    for (const cmd of ['node', 'python', 'python3', 'java', 'xz', 'gpg', 'unzip', 'git', 'curl', 'tar']) {
      const probe = spawnSync('bash', ['--noprofile', '--norc', '-c', `command -v ${cmd}`], { encoding: 'utf8' })
      if (probe.status !== 0) missing.push(`缺少命令：${cmd}`)
    }
    if (missing.length) {
      console.error('本地前置检查未过：')
      for (const item of missing) console.error(`  - ${item}`)
      if (missing.some((item) => item.includes('python'))) {
        console.error('  提示：`python` 缺失时链会在编排器内部静默退出 1；用户级 shim 即可：')
        console.error('        mkdir -p ~/.local/bin && ln -sf "$(command -v python3)" ~/.local/bin/python')
        console.error('        （本脚本会把 ~/.local/bin 置于 PATH 前部）')
      }
      process.exit(2)
    }
    console.log(`前置检查通过（ANDROID_HOME=${ANDROID_HOME}）`)
  }

  console.log(`本地来源链：共 ${planned.length} 个可执行步骤，本次选中 ${selected.length} 个`)
  if (flag('--dry-run')) {
    for (const item of selected) console.log(`  将执行 [${item.stage}] ${item.name}`)
    process.exit(0)
  }
  try { assertMaintainedSource(ROOT) } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  preflight()

  let buildRoot
  try {
    buildRoot = prepareSourceWorkspace(ROOT, repoCommit, value('--build-workspace'))
  } catch (error) {
    console.error(`无法准备隔离来源构建目录：${error.message}`)
    process.exit(2)
  }
  console.log(`来源输入：HEAD ${repoCommit}（不包含原工作树的未提交内容）`)
  console.log(`隔离构建目录：${buildRoot}（保留用于续跑与取件）`)
  // Node 优先用用户级 v24（`~/.local/node24`）：CI 跑的就是 v24，而 Ubuntu apt 装的是 v22，
  // 且系统 corepack 的 `enable` 要往 /usr/bin 写符号链接（非 root 必失败）。
  const userNodeBin = join(homedir(), '.local', 'node24', 'bin')
  const nodePathPrefix = existsSync(join(userNodeBin, 'node'))
    ? `${userNodeBin}:`
    : ''
  if (nodePathPrefix) {
    const version = execFileSync(join(userNodeBin, 'node'), ['--version'], { encoding: 'utf8' }).trim()
    console.log(`使用用户级 Node：${userNodeBin}（${version}）`)
  }
  // npm 镜像：国内直连 registry.npmjs.org 会慢到超时（实测 pnpm 下到一半 fetch failed）。
  // 镜像只改取件地址，不改字节——pnpm 按 lockfile 的 integrity 校验每个 tarball。
  const npmMirror = value('--npm-mirror', process.env.DSH_NPM_MIRROR ?? null)
  if (npmMirror) console.log(`npm 镜像：${npmMirror}`)
  const baseEnv = {
    ...process.env,
    // Resolve before entering the remote-free checkout; all phases share this identity.
    DSH_SOURCE_REPOSITORY: resolveSourceRepository(ROOT),
    ANDROID_HOME,
    ANDROID_SDK_ROOT: ANDROID_HOME,
    DSH_APK_DIR: buildRoot,
    GITHUB_WORKSPACE: buildRoot,
    GITHUB_SHA: repoCommit,
    SOURCE_REF: 'refs/heads/main',
    RUNNER_TEMP: join(buildRoot, '.deploy-tmp', 'runner-temp'),
    GITHUB_ENV: join(buildRoot, '.deploy-tmp', 'local-github-env'),
    PATH: `${nodePathPrefix}${join(homedir(), '.local', 'bin')}:${join(ANDROID_HOME, 'build-tools', '36.0.0')}:${join(ANDROID_HOME, 'platform-tools')}:${process.env.PATH}`,
    // pnpm 11 只认自己的前缀：实测 `npm_config_registry` 被忽略、`pnpm_config_registry` 生效
    // （npm 侧仍用 npm_config_registry，两条链各自生效）。
    // 放宽 fetch 超时/重试：国内取件会偶发长尾，默认超时会在大半下载完之后整步判死（实测 1371/1385 被掐）。
    ...(npmMirror ? {
      npm_config_registry: npmMirror,
      pnpm_config_registry: npmMirror,
      pnpm_config_fetch_timeout: '1200000',
      pnpm_config_fetch_retries: '8',
      pnpm_config_fetch_retry_maxtimeout: '180000',
      COREPACK_NPM_REGISTRY: npmMirror,
    } : {}),
  }
  mkdirSync(baseEnv.RUNNER_TEMP, { recursive: true })
  writeFileSync(baseEnv.GITHUB_ENV, '', { flag: 'a' })
  const applyStepEnvironment = () => {
    const allowed = new Set(['npm_config_cache', 'POCKET_SIGNING_KEYSTORE_PATH', 'POCKET_SIGNING_KEYSTORE_PASSWORD', 'POCKET_BUILD_CERTIFICATE_FILE'])
    for (const line of readFileSync(baseEnv.GITHUB_ENV, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const at = line.indexOf('=')
      const key = line.slice(0, at)
      if (at < 1 || !allowed.has(key)) throw new Error('Unsupported local GITHUB_ENV key')
      baseEnv[key] = line.slice(at + 1)
    }
  }
  applyStepEnvironment()

  // 抹掉 WSL_DISTRO_NAME：本链的步骤全部按 **CI 的原生 Linux 语义**写死路径
  // （`build-snapshot-013.mjs` 的 IN_WSL 分支会把 stage 改到 `~/.dsh-stage/<abi>`，而 workflow 的
  // 后续步骤——materialize / 重打包 / 副本收敛 / 快照检查器——都按 `.deploy-tmp/snapshot-013/<abi>/stage`
  // 取件，stage 一挪就必然 ENOENT）。本地工作区本来就在 ext4，那条 WSL 分支省不到 I/O，
  // 只有害处。shell.mjs 里对 WSL_DISTRO_NAME 的另一处用法只在 Windows 宿主侧生效，不受影响。
  delete baseEnv.WSL_DISTRO_NAME
  // Do not let caller Git path overrides escape the isolated checkout.
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete baseEnv[name]

  let failed = 0
  for (const [i, item] of selected.entries()) {
    const started = Date.now()
    console.log(`\n=== [${i + 1}/${selected.length}] [${item.stage}] ${item.name} ===`)
    // 与 GitHub 的 shell 语义对齐：显式 shell: bash → `--noprofile --norc -eo pipefail`；
    // 未声明 shell 的步骤用默认 `bash -e`。
    const shellArgs = item.shell === 'bash'
      ? ['--noprofile', '--norc', '-eo', 'pipefail', '-c', item.run]
      : ['-e', '-c', item.run]
    const res = spawnSync('bash', shellArgs, { cwd: buildRoot, env: baseEnv, stdio: 'inherit' })
    applyStepEnvironment()
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (res.status !== 0) {
      failed += 1
      console.error(`\n[FAIL] 步骤失败：${item.name}（${seconds}s，退出码 ${res.status}）`)
      console.error(`续跑时使用 --build-workspace ${JSON.stringify(buildRoot)} --from ${item.stage}`)
      break
    }
    console.log(`--- 完成（${seconds}s）`)
  }

  if (failed) process.exit(1)
  console.log(`\n本地来源构建阶段完成（${join(buildRoot, 'out', 'v*')}）。这是临时签名的构建副本；仅 CI 双构建验证与正式签名完成后的 artifact 可交付。`)
}

// 用 realpath 比较入口：macOS 的 /var 是 /private/var 的符号链接，临时目录里的脚本
// 若按字面 argv[1] 比较会认不出自己（表现为退出码 0 但一步都没跑）。
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main()
