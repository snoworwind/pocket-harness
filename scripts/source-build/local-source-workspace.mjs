import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MARKER = '.dsh-local-source-workspace.json'
/** marker 格式版本：2 起登记工作树源码字节摘要（A11）；旧 schema 不再静默续跑。 */
const MARKER_SCHEMA = 2
/** 预期写入登记版本：白名单内容变化时必须同步递增，旧目录会明确判红而不是沿用旧口径。 */
const EXPECTED_SOURCE_CHANGES_VERSION = 1
const gitEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' }
for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name]
const gitArgs = (root, args) => ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-C', root, ...args]
const git = (root, ...args) => execFileSync('git', gitArgs(root, args), { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** 与 git() 相同，但不 trim：-z 输出按 NUL 分隔，路径首尾空格不能被吞掉。 */
const gitRaw = (root, ...args) => execFileSync('git', gitArgs(root, args), { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * 构建链**预期**会改写/生成的路径（A11 的有限白名单）。
 *
 * 续跑不能简单一律要求工作树干净：checkout pinned component sources 会整目录替换
 * vendor/dshmarketplace-plugin，Harness 步会改写 engine-overlay.json，快照/APK 步会
 * 生成补丁夹具、许可资产与 notices，插件安装会更新各自 lockfile。这些路径之外，
 * 任何已跟踪文件的字节变化或未跟踪（且未被 .gitignore 忽略）的文件都视为对
 * 「只构建已提交 HEAD」的偏离。
 *
 * 规则只允许有限前缀/精确文件/插件 lockfile，不覆盖 app/src、scripts/source-build 等
 * 产品源码；禁止用「忽略所有未跟踪文件」这种宽口径。
 */
const EXPECTED_SOURCE_CHANGES = [
  MARKER,
  // 本地链与 workflow 的产物根（多数本就被 .gitignore 忽略；列在这里是为了让
  // 「允许生成」本身可审计，而不是靠 ignore 规则隐式放行）。
  '.deploy-tmp/',
  'out/',
  'base/',
  'build/',
  '.gradle/',
  '.gradle-home/',
  '.kotlin/',
  'local.properties',
  'snapshot/',
  'app/build/',
  'app/src/main/assets/snapshot.tar.xz',
  'app/src/main/assets/snapshot.sha256',
  // build-apk.mjs 从 LICENSES 重新生成 assets/licenses，并重写第三方 notices。
  'app/src/main/assets/licenses/',
  'THIRD_PARTY_NOTICES.md',
  // APK 步临时替换 overlay 门禁脚本，随后由 trap 还原；中断时可能仍停在替换形态。
  'scripts/check-engine-overlay.mjs',
  // Harness / termux 步按构建期策略改写并（通常）还原的配置输入。
  'scripts/snapshot-config/engine-overlay.json',
  'scripts/snapshot-config/preinstall.json',
  // probe-engine-anchors --fixtures --capture-only 会重写当前版本的补丁夹具。
  'scripts/patches/tests/fixtures/',
  // 组件源按固定 npm 产物整目录替换，并施加已登记的 market-* 补丁。
  'vendor/dshmarketplace-plugin/',
  // build-apk.mjs 的 apply-patches 会就地改写 undo 补丁目标。
  'vendor/dsh-undo-savepoint/lib/client.js',
  'vendor/dsh-undo-savepoint/lib/core.mjs',
  'vendor/dsh-undo-savepoint/lib/index.js',
  // install-project-dependencies.mjs 先 npm install --package-lock-only 再 npm ci，会更新 lock。
  'dsh-shell-termux/package-lock.json',
  'dsh-client-ui-responsive/package-lock.json',
]
/** 插件 lockfile 的形态只允许这一个：plugins/<name>/package-lock.json。 */
const EXPECTED_SOURCE_CHANGE_PATTERNS = [
  /^plugins\/[^/]+\/package-lock\.json$/,
]

function isExpectedSourceChange(rel) {
  const path = rel.replaceAll('\\', '/')
  return EXPECTED_SOURCE_CHANGES.some((entry) => (entry.endsWith('/')
    ? path === entry.slice(0, -1) || path.startsWith(entry)
    : path === entry)) || EXPECTED_SOURCE_CHANGE_PATTERNS.some((pattern) => pattern.test(path))
}

/** 把单个工作树条目的类型与字节喂进摘要；文件模式只取可执行位（Git 只跟踪这一位）。 */
function appendSourceEntry(hash, workspace, kind, rel) {
  const full = join(workspace, rel)
  hash.update(`${kind}\0${rel}\0`)
  let info
  try {
    info = lstatSync(full)
  } catch (error) {
    if (error.code === 'ENOENT') { hash.update('missing\0'); return }
    throw error
  }
  if (info.isSymbolicLink()) {
    hash.update(`symlink\0${readlinkSync(full)}\0`)
  } else if (info.isFile()) {
    hash.update(`file\0${info.mode & 0o111 ? 'x' : '-'}\0`)
    hash.update(readFileSync(full))
    hash.update('\0')
  } else {
    throw new Error(`来源构建目录含不支持的文件类型：${rel}`)
  }
}

/**
 * 工作树源码字节摘要：已跟踪文件按当前工作树字节计算，未跟踪但未被忽略的文件一并纳入。
 * 预期生成路径（白名单）既不计入摘要也不要求干净；白名单之外的任何改动都会改变摘要。
 */
function sourceTreeDigest(workspace) {
  const tracked = gitRaw(workspace, 'ls-files', '-z').split('\0').filter(Boolean).sort()
  const untracked = gitRaw(workspace, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  let trackedCount = 0
  let untrackedCount = 0
  for (const rel of tracked) {
    if (isExpectedSourceChange(rel)) continue
    trackedCount += 1
    appendSourceEntry(hash, workspace, 'tracked', rel)
  }
  for (const rel of untracked) {
    if (isExpectedSourceChange(rel)) continue
    untrackedCount += 1
    appendSourceEntry(hash, workspace, 'untracked', rel)
  }
  // 计数也进摘要：删除/新增文件即使字节都为空，集合变化也必须可见。
  hash.update(`counts\0${trackedCount}\0${untrackedCount}\0`)
  return hash.digest('hex')
}

function canonicalPath(path, links = new Set()) {
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(canonicalPath(dirname(path), links), basename(path))
  }
  if (info.isSymbolicLink()) {
    if (links.has(path)) throw new Error(`来源构建路径包含循环链接：${path}`)
    links.add(path)
    return canonicalPath(resolve(dirname(path), readlinkSync(path)), links)
  }
  return realpathSync(path)
}

function contains(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

// These are host write/cleanup roots in build-apk-source.yml. Check each root,
// not just .deploy-tmp: a resumed checkout can contain a nested directory link.
// Do not reject all runtime links: bootstrap extraction intentionally retains
// Android /data/data/com.termux links until the snapshot sanitizer runs.
function rejectEscapedWriteRoots(workspace) {
  const writeRoots = [
    '.deploy-tmp', 'scripts', 'vendor', 'plugins', 'dsh-shell-termux',
    'dsh-client-ui-responsive', 'dsh-host-web-compat', 'out', 'base', 'app',
  ]
  for (const path of writeRoots) {
    if (!contains(workspace, canonicalPath(join(workspace, path)))) throw new Error(`来源构建写入路径逃出隔离目录：${path}`)
  }
  // Resolve internal aliases, but visit every physical directory only once:
  // an internal reports alias must not hide an escaping leaf, while pnpm's
  // dependency graph must not cause exponential traversal. Raw Android links
  // are permitted only in the concrete staging trees that produce them.
  const androidStagingRoots = [
    '.deploy-tmp/source-build/bootstrap-extracted/usr',
    '.deploy-tmp/source-build/node-deb-extracted/data/data/com.termux/files/usr',
    '.deploy-tmp/arm64-base/.bootstrap-stage/termux',
    '.deploy-tmp/arm64-base/.bootstrap-stage/base/usr',
    '.deploy-tmp/snapshot-013/arm64/stage/root',
  ].map(path => join(workspace, path))
  const visited = new Set()
  const scan = directory => {
    directory = realpathSync(directory)
    if (visited.has(directory)) return
    visited.add(directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = canonicalPath(path)
        // Snapshot relocation changes Termux's prefix to the shell app's
        // /data/user/0 prefix. Resolve relative aliases such as rvim -> vim
        // before applying the same narrow runtime exemption.
        const androidRuntimeLink = ['/data/data/com.termux/files/usr/', '/data/user/0/com.snoworwind.pocketharness/files/usr/']
          .some(prefix => target.startsWith(prefix)) && !existsSync(target)
          && androidStagingRoots.some(root => contains(root, path))
        if (!androidRuntimeLink && !contains(workspace, target)) {
          throw new Error(`来源构建写入路径逃出隔离目录：${relative(workspace, path)}`)
        }
        if (!androidRuntimeLink && existsSync(path) && statSync(path).isDirectory()) scan(path)
      } else if (entry.isDirectory()) scan(path)
    }
  }
  for (const root of writeRoots) {
    const path = join(workspace, root)
    if (existsSync(path)) scan(path)
  }
}

function rejectSourceLinks(workspace, sourceRoot, directory = workspace) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        const worktree = canonicalPath(git(directory, 'rev-parse', '--show-toplevel'))
        if (contains(sourceRoot, worktree) || contains(worktree, sourceRoot)) throw new Error(`来源构建 Git 工作树可触及原仓：${relative(workspace, path)}`)
      }
      rejectSourceLinks(workspace, sourceRoot, path)
    }
    else if (entry.isSymbolicLink()) {
      const target = canonicalPath(resolve(directory, readlinkSync(path)))
      if (contains(sourceRoot, target) || contains(target, sourceRoot)) throw new Error(`来源构建链接可触及原工作树：${relative(workspace, path)}`)
    } else if (entry.name === '.git' && entry.isFile()) {
      const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(path, 'utf8'))?.[1]
      if (gitdir) {
        const target = canonicalPath(resolve(directory, gitdir.trim()))
        if (contains(sourceRoot, target) || contains(target, sourceRoot)) throw new Error(`来源构建 Git 链接可触及原工作树：${relative(workspace, path)}`)
      }
    }
  }
}

export function sourceCommit(source) {
  return git(source, 'rev-parse', 'HEAD')
}

/** Real APK execution is limited to the maintained branch, including resumed runs. */
export function assertMaintainedSource(source) {
  let ref
  try { ref = git(source, 'symbolic-ref', '--quiet', 'HEAD') } catch { /* Detached input is rejected. */ }
  if (ref !== 'refs/heads/main') throw new Error('APK 来源构建仅允许 main 分支；其他分支只能 --list 或 --dry-run。')
}

export function committedWorkflow(source, commit) {
  return git(source, 'show', `${commit}:.github/workflows/build-apk-source.yml`)
}

/** A private shallow checkout keeps workflow cleanup away from developer files. */
export function prepareSourceWorkspace(source, commit, requested = null) {
  const sourceRoot = realpathSync(source)
  const tempRoot = canonicalPath(tmpdir())
  if (!requested && contains(sourceRoot, tempRoot)) throw new Error('临时目录位于原工作树内；请用 --build-workspace 指定外部目录。')
  const workspace = requested ? canonicalPath(resolve(requested)) : mkdtempSync(join(tempRoot, 'dsh-source-chain-'))
  if (contains(sourceRoot, workspace) || contains(workspace, sourceRoot)) {
    throw new Error('来源构建目录必须在原工作树之外，且不能是它的父目录。')
  }
  const marker = join(workspace, MARKER)
  if (existsSync(workspace) && readdirSync(workspace).length) {
    if (!existsSync(marker)) throw new Error(`拒绝使用非空且未登记的来源构建目录：${workspace}`)
    const saved = JSON.parse(readFileSync(marker, 'utf8'))
    if (saved.source !== sourceRoot || saved.commit !== commit) {
      throw new Error('来源构建目录的原仓或 HEAD 不匹配；请指定新的空目录。')
    }
    if (saved.schema !== MARKER_SCHEMA) {
      throw new Error('来源构建目录的登记格式已过期（旧版未绑定工作树源码字节）；请指定新的空目录。')
    }
    if (!saved.sourceTree || saved.sourceTree.expectedWritesVersion !== EXPECTED_SOURCE_CHANGES_VERSION
      || !/^[0-9a-f]{64}$/.test(saved.sourceTree.sha256 ?? '')) {
      throw new Error('来源构建目录缺少当前版本的源码字节登记；请指定新的空目录。')
    }
    // A worktree or linked .git would let destructive steps reach the source repository.
    if (!statSync(join(workspace, '.git')).isDirectory() || realpathSync(join(workspace, '.git')) !== join(workspace, '.git') || existsSync(join(workspace, '.git/commondir')) || existsSync(join(workspace, '.git/objects/info/alternates')) || git(workspace, 'rev-parse', '--show-toplevel') !== workspace || sourceCommit(workspace) !== commit) {
      throw new Error('来源构建目录不再是登记 HEAD 的独立 Git 检出。')
    }
    rejectEscapedWriteRoots(workspace)
    rejectSourceLinks(workspace, sourceRoot)
    // A11：续跑只认「同一 HEAD + 同一工作树源码字节」。白名单外的未提交修改（含未跟踪源文件）
    // 曾经能以 accepted:true 通过，使「只构建已提交 HEAD」对本地续跑不成立。
    if (sourceTreeDigest(workspace) !== saved.sourceTree.sha256) {
      throw new Error('来源构建目录的工作树源码字节已偏离登记 HEAD（存在未登记的修改或新增源文件）；请恢复已提交内容或指定新的空目录。')
    }
    return workspace
  }
  mkdirSync(workspace, { recursive: true })
  // Fetch only this commit, without copying LFS objects or historical runtime archives.
  // LFS stays as pointers, matching the source workflow checkout (lfs: false).
  git(workspace, 'init', '-q')
  git(workspace, 'fetch', '--depth=1', '--no-tags', sourceRoot, commit)
  git(workspace, 'checkout', '--detach', commit)
  rejectEscapedWriteRoots(workspace)
  rejectSourceLinks(workspace, sourceRoot)
  writeFileSync(marker, JSON.stringify({
    schema: MARKER_SCHEMA,
    source: sourceRoot,
    commit,
    sourceTree: {
      sha256: sourceTreeDigest(workspace),
      expectedWritesVersion: EXPECTED_SOURCE_CHANGES_VERSION,
    },
  }, null, 2) + '\n', { flag: 'wx' })
  return workspace
}
