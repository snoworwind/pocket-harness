// check-third-party.mjs — 第三方许可合规门禁（GPL 义务 A1-A5/B1-B3 的自动化面）
//
// 职责（对 .deploy-tmp/snapshot-013/<abi>/stage/root/usr 的快照运行时树）：
// ① 矩阵完整：dpkg status 每个已装包都在 scripts/third-party-licenses.json 有记录；
// ② copyleft（GPL/LGPL 族）包的 usr/share/doc/<pkg>/copyright 在快照内存在（A1：GPL 全文随包分发）；
// ③ LICENSES/ 标准文本覆盖矩阵所需族（A2 源）；
// ④ --write-notices <out>：生成 THIRD_PARTY_NOTICES.md（组件/版本/许可/上游，B1）。
// 退出 0=通过；非 0=拒绝打包（build-apk-013.ps1 门禁接入）。
//
// 用法：node scripts/check-third-party.mjs <usrDir> [--write-notices <path>] [--licenses <dir>]
import { readFileSync, existsSync, statSync, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { wslPath, sh } from './lib/shell.mjs'

const usr = process.argv[2]?.startsWith('--') ? null : process.argv[2]
const licensesDir = process.argv.includes('--licenses') ? process.argv[process.argv.indexOf('--licenses') + 1] : 'LICENSES'
const writeIdx = process.argv.indexOf('--write-notices')
const noticesPath = writeIdx >= 0 ? process.argv[writeIdx + 1] : null
const tarIdx = process.argv.indexOf('--tar')
const tarPath = tarIdx >= 0 ? process.argv[tarIdx + 1] : null
const linuxBackendProvenancePath = process.argv.includes('--linux-backend-provenance')
  ? process.argv[process.argv.indexOf('--linux-backend-provenance') + 1] : null
const linuxBackendLicensesDir = process.argv.includes('--linux-backend-licenses')
  ? process.argv[process.argv.indexOf('--linux-backend-licenses') + 1] : null
if ((!usr && !tarPath) || (!tarPath && !existsSync(join(usr, 'var/lib/dpkg/status')))) {
  console.error('用法: node scripts/check-third-party.mjs <usrDir|--tar <snapshot.tar.xz>> [--write-notices <path>]')
  process.exit(2)
}

const matrix = JSON.parse(readFileSync('scripts/third-party-licenses.json', 'utf8'))

function readLinuxBackendEvidence() {
  if (!linuxBackendProvenancePath && !linuxBackendLicensesDir) return null
  if (!linuxBackendProvenancePath || !linuxBackendLicensesDir) {
    failures.push('PRoot 许可核验需要同时提供 provenance 和 license 目录')
    return null
  }
  let report
  let config
  let shim
  try {
    report = JSON.parse(readFileSync(linuxBackendProvenancePath, 'utf8'))
    config = JSON.parse(readFileSync('scripts/source-build/linux-backend-packages.json', 'utf8'))
    shim = JSON.parse(readFileSync('vendor/linux-proot/compat/SOURCE.json', 'utf8'))
  } catch (error) {
    failures.push(`PRoot 许可 provenance 或组件锁不可读: ${String(error.message ?? error)}`)
    return null
  }
  if (report.schemaVersion !== 1 || report.target !== 'proot'
    || report.repository !== 'https://packages.termux.dev/apt/termux-main'
    || report.targetVersion !== config.expectedVersions.proot) {
    failures.push('PRoot provenance 的目标、来源或版本不符合锁定值')
  }
  const expectedPackages = config.requiredClosure ?? []
  const packagesByName = new Map((Array.isArray(report.packages) ? report.packages : []).map(item => [item.package, item]))
  if (packagesByName.size !== expectedPackages.length
    || expectedPackages.some(name => !packagesByName.has(name))) {
    failures.push('PRoot provenance 软件包集合与审核闭包不一致')
  }
  for (const name of expectedPackages) {
    const item = packagesByName.get(name)
    const source = config.packageSources?.[name]
    if (!item || !source || item.version !== config.expectedVersions?.[name]
      || item.license !== source.license || item.sourceUrl !== source.sourceUrl
      || item.sourceSha256 !== source.sourceSha256 || item.recipe !== source.recipe
      || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(item.sourceSha256 ?? '')) {
      failures.push(`PRoot provenance 软件包信息与锁不一致: ${name}`)
    }
  }
  const compatibilitySourceHash = createHash('sha256').update(readFileSync('vendor/linux-proot/compat/termfold_compat.c')).digest('hex')
  if (report.compatibilityShim?.repository !== shim.repository
    || report.compatibilityShim?.commit !== shim.commit
    || report.compatibilityShim?.path !== shim.path
    || report.compatibilityShim?.license !== shim.license
    || report.compatibilityShim?.upstreamSha256 !== shim.upstreamSha256
    || report.compatibilityShim?.localSourceSha256 !== compatibilitySourceHash
    || !/^[a-f0-9]{64}$/.test(report.compatibilityShim?.localSourceSha256 ?? '')) {
    failures.push('TermFold 兼容 shim 的许可证或来源 provenance 不一致')
  }

  const expectedFiles = new Map()
  if (!Array.isArray(report.licenseFiles)) failures.push('PRoot license provenance 必须是文件记录数组')
  for (const item of Array.isArray(report.licenseFiles) ? report.licenseFiles : []) {
    const relative = item.path
    if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/')
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
      failures.push(`PRoot license 清单路径或摘要无效: ${String(relative)}`)
      continue
    }
    if (expectedFiles.has(relative)) {
      failures.push(`PRoot license provenance 路径重复: ${relative}`)
      continue
    }
    expectedFiles.set(relative, item)
  }
  const root = resolve(linuxBackendLicensesDir)
  const actualFiles = []
  const walk = directory => {
    let directoryInfo
    try { directoryInfo = lstatSync(directory) }
    catch (error) { failures.push(`PRoot license 目录不可读: ${String(error.message ?? error)}`); return }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      failures.push(`PRoot license 路径必须是普通目录: ${directory}`)
      return
    }
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) { failures.push(`PRoot license 目录不可读: ${String(error.message ?? error)}`); return }
    for (const entry of entries) {
      const file = join(directory, entry.name)
      const info = lstatSync(file)
      if (info.isSymbolicLink()) {
        failures.push(`PRoot license 路径不允许符号链接: ${file}`)
      } else if (info.isDirectory()) walk(file)
      else if (info.isFile()) actualFiles.push(file)
      else failures.push(`PRoot license 路径必须是普通文件或目录: ${file}`)
    }
  }
  try { walk(root) }
  catch (error) { failures.push(`PRoot license 目录检查失败: ${String(error.message ?? error)}`) }
  const actualRel = actualFiles.map(file => relative(root, file).replace(/\\/g, '/')).sort()
  const expectedRel = [...expectedFiles.keys()].sort()
  if (JSON.stringify(actualRel) !== JSON.stringify(expectedRel)) failures.push('PRoot license 文件集合与 provenance 不一致')
  for (const relativePath of expectedRel) {
    const file = join(root, ...relativePath.split('/'))
    try {
      const bytes = readFileSync(file)
      const expected = expectedFiles.get(relativePath)
      if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
        failures.push(`PRoot license 文件摘要不符: ${relativePath}`)
      }
    } catch (error) {
      failures.push(`PRoot license 文件缺失或不可读: ${relativePath} (${String(error.message ?? error)})`)
    }
  }
  return { report, shim }
}

/** 目标存在性视图：Windows 直接 stat 对 9p 上的 root-600 文件会 EACCES 误报，
 *  因此支持 --tar 经 WSL/原生 shell 列归档（tar -tvf 带大小），成员存在且 size>0 才算在场。 */
function availability() {
  const map = new Map()
  if (tarPath) {
    const abs = wslPath(resolve(tarPath))
    const out = sh(`tar -tvf "${abs}" 2>/dev/null | grep -E 'usr/share/LICENSES/|usr/share/doc/[^/]+/copyright'`, { maxBuffer: 96 * 1024 * 1024 })
    for (const line of out.split('\n')) {
      if (!line.includes('usr/share/LICENSES/') && !/usr\/share\/doc\/[^/]+\/copyright/.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pathIdx = parts.findIndex((t) => t.startsWith('usr/share/'))
      if (pathIdx < 0) continue
      const path = parts[pathIdx]
      const size = Number(parts[pathIdx - 3] ?? 0)
      const linkIdx = line.indexOf(' -> ')
      if (linkIdx >= 0) {
        map.set(path, { size, target: line.slice(linkIdx + 4).trim() })
      } else {
        map.set(path, size)
      }
    }
  } else {
    const record = (rel) => {
      try { map.set(rel, statSync(join(usr, rel.slice(4))).size) } catch { /* absent */ }
    }
    for (const pkg of packagesAvailable()) {
      try {
        for (const file of readdirSync(join(usr, 'share/doc', pkg))) {
          if (file === 'copyright' || file.startsWith('COPYING')) record(`usr/share/doc/${pkg}/${file}`)
        }
      } catch { /* absent */ }
    }
    try {
      for (const file of readdirSync(join(usr, 'share/LICENSES'))) record(`usr/share/LICENSES/${file}`)
    } catch { /* absent */ }
  }
  return map
}

/** 直读模式（无 --tar）：从 dpkg status 取包列表；tar 模式同。 */
function packagesAvailable() {
  const text = readFileSync(join(usr, 'var/lib/dpkg/status'), 'utf8')
  const out = []
  for (const b of text.split('\n\n')) {
    const pkg = /^Package: (.+)$/m.exec(b)?.[1]
    if (pkg) out.push(pkg)
  }
  return out
}

/** dpkg status → [{pkg, version}]（--tar 模式经 WSL 从归档内抽取；直读模式读本地 usr）。 */
function readPackages() {
  let text
  if (tarPath) {
    const abs = wslPath(resolve(tarPath))
    text = sh(`tar -xOf "${abs}" usr/var/lib/dpkg/status`, { maxBuffer: 32 * 1024 * 1024 })
  } else {
    text = readFileSync(join(usr, 'var/lib/dpkg/status'), 'utf8')
  }
  const blocks = text.split('\n\n')
  const out = []
  for (const b of blocks) {
    const pkg = /^Package: (.+)$/m.exec(b)?.[1]
    const version = /^Version: (.+)$/m.exec(b)?.[1]
    if (pkg) out.push({ pkg, version: version ?? '?' })
  }
  return out
}

const packages = readPackages()
const failures = []
const copyleft = []
const rows = []
const avail = availability()
const linuxBackendEvidence = readLinuxBackendEvidence()

for (const { pkg, version } of packages) {
  const license = matrix.packages[pkg]
  if (!license) {
    failures.push(`矩阵缺条目: ${pkg}@${version}（加入 scripts/third-party-licenses.json）`)
    rows.push({ pkg, version, license: '???', copyleft: false })
    continue
  }
  const isCopyleft = matrix.copyleftFamilies.some((f) => license.includes(f))
  if (isCopyleft) copyleft.push(pkg)
  rows.push({ pkg, version, license, copyleft: isCopyleft })
  // A1：copyleft 包许可证全文必须在场。Termux 布局不一致——三种形态任一即可：
  //  a) doc/<pkg>/copyright 软链 → usr/share/LICENSES/<fam>.txt（size>0）
  //  b) doc/<pkg>/COPYING* 实体文件（liblzma/util-linux 等）
  //  c) usr/share/LICENSES/<fam>.txt 标准文本在场（兜底：共享许可证库）
  const famMap = {
    'GPL-1.0+': 'GPL-2.0.txt', 'GPL-2.0': 'GPL-2.0.txt', 'GPL-2.0+': 'GPL-2.0.txt',
    'GPL-3.0+': 'GPL-3.0.txt', 'LGPL-2.1+': 'LGPL-2.1.txt', 'LGPL-3.0+': 'LGPL-3.0.txt',
  }
  const famFile = Object.entries(famMap).find(([f]) => license.includes(f))?.[1] ?? null
  const rel = `usr/share/doc/${pkg}/copyright`
  const entry = avail.get(rel)
  let okSize = typeof entry === 'number' ? entry > 0 : false
  let diag = ''
  if (!okSize && typeof entry === 'object' && entry) {
    // symlink 目标相对「自身所在目录」解析（doc/<pkg>/ + ../../ = share/）——不是相对 doc/
    const target = join(dirname(rel), entry.target).replace(/\\/g, '/')
    const t = avail.get(target)
    okSize = typeof t === 'number' ? t > 0 : false
    diag = `(link -> ${target} size=${typeof t === 'number' ? t : 'missing'})`
  }
  // b) COPYING* 实体文件
  if (!okSize) {
    for (const k of [...avail.keys()]) {
      if (k.startsWith(`usr/share/doc/${pkg}/COPYING`) && typeof avail.get(k) === 'number' && (avail.get(k) ?? 0) > 0) {
        okSize = true
        diag = `(COPYING*)`
        break
      }
    }
  }
  // c) 共享标准文本
  if (!okSize && famFile) {
    const t = avail.get(`usr/share/LICENSES/${famFile}`)
    okSize = typeof t === 'number' ? t > 0 : false
    if (okSize) diag = `(shared LICENSES/${famFile})`
  }
  if (isCopyleft && !okSize) {
    failures.push(`copyleft 包缺 copyright 全文: ${rel} ${diag}`)
  }
}

// A2：LICENSES 标准文本覆盖矩阵所需族
const neededTexts = new Set()
for (const { license } of rows) {
  for (const fam of ['GPL-2.0+', 'GPL-3.0+', 'LGPL-2.1+', 'LGPL-3.0+']) {
    if (license.includes(fam.split('+')[0])) neededTexts.add(matrix.licenseTexts[fam])
  }
}
for (const rel of neededTexts) {
  if (!existsSync(rel)) failures.push(`LICENSES 标准文本缺失: ${rel}`)
}

// Gradle SDKs are outside dpkg; validate the fixed metadata and packaged text too.
const androidComponents = matrix.androidComponents
if (!Array.isArray(androidComponents) || androidComponents.length === 0) {
  failures.push('Android SDK 许可矩阵缺失')
} else {
  const gradlePath = existsSync('app/build.gradle.kts')
    ? 'app/build.gradle.kts' : 'dsh-mobile-apk/app/build.gradle.kts'
  const gradle = existsSync(gradlePath) ? readFileSync(gradlePath, 'utf8') : ''
  const sdkDeps = [...gradle.matchAll(/implementation\("(dev\.rikka\.shizuku):([^:"]+):([^"\s]+)"\)/g)]
  if (sdkDeps.length === 0) failures.push('Gradle Shizuku SDK 依赖不可核实')
  for (const [, group, artifact, version] of sdkDeps) {
    if (!androidComponents.some(c => c.group === group && c.artifacts?.includes(artifact) && c.version === version)) {
      failures.push(`Android SDK 许可版本未登记: ${group}:${artifact}:${version}`)
    }
  }
  for (const component of androidComponents) {
    const text = join(licensesDir, component.licenseText ?? '')
    if (!component.licenseText || !existsSync(text)) {
      failures.push(`Android SDK 许可全文缺失: ${text}`)
    } else if (createHash('sha256').update(readFileSync(text)).digest('hex') !== component.licenseSha256) {
      failures.push(`Android SDK 许可全文 SHA256 不符: ${text}`)
    }
    if (!sdkDeps.some(([, group, artifact, version]) => group === component.group && component.artifacts?.includes(artifact) && version === component.version)) {
      failures.push(`Android SDK 矩阵没有对应 Gradle 依赖: ${component.group}@${component.version}`)
    }
  }
}

if (noticesPath) {
  const lines = [
    '# THIRD_PARTY_NOTICES',
    '',
    '> 本清单由 `scripts/check-third-party.mjs --write-notices` 从快照 dpkg 清单与固定 Android SDK 许可矩阵生成；',
    '> 与快照一起分发（APK assets/）。每个组件的许可证全文随快照包分发于 `usr/share/doc/<pkg>/copyright`，',
    '> 标准 GNU 文本及 Android SDK 许可副本另见 APK `assets/licenses/` 与仓库 `LICENSES/`。',
    '',
    '| 组件 | 版本 | 许可证 | 上游源码 |',
    '|---|---|---|---|',
  ]
  const src = 'https://github.com/termux/termux-packages/tree/master/packages'
  for (const { pkg, version, license } of rows.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    lines.push(`| ${pkg} | ${version} | ${license} | [termux-packages/${pkg}](${src}/${pkg}) |`)
  }
  lines.push('')
  if (linuxBackendEvidence) {
    const { report, shim } = linuxBackendEvidence
    lines.push('## Linux PRoot backend')
    lines.push('')
    lines.push('PRoot launcher、loader 和依赖由 Termux 官方签名仓库包提供。来源链使用官方 Termux bootstrap keyring 验证 InRelease，再验证 Packages.gz 与每个 `.deb` 的签名索引摘要；完整签名、索引、包及拆分后 APK native library 摘要见 `proot-backend-inputs.json`。')
    lines.push('')
    lines.push('| 组件 | 版本 | 许可证 | 来源归档 SHA-256 | 上游源码 | Termux 构建配方 |')
    lines.push('|---|---|---|---|---|---|')
    for (const item of [...report.packages].sort((a, b) => a.package.localeCompare(b.package))) {
      lines.push(`| ${item.package} | ${item.version} | ${item.license} | \`${item.sourceSha256}\` | [源码归档](${item.sourceUrl}) | [Termux 配方](${item.recipe}) |`)
    }
    lines.push('')
    lines.push(`TermFold 兼容 shim：${shim.license}，来源 [${shim.repository}，commit ${shim.commit}](${shim.repository}/blob/${shim.commit}/${shim.path})；上游文件 SHA-256 \`${shim.upstreamSha256}\`。本仓适配源码及完整许可证一并随 APK 分发；源代码路径为 \`vendor/linux-proot/compat/\`。`)
    lines.push('')
    lines.push('Linux native 库及兼容 shim 的逐包 copyright / 许可证全文位于 APK `assets/licenses/linux-native/`；对应源码与本仓改写说明随本仓发布。PRoot 的 `-0` 只伪装 guest 身份，PRoot 不是安全沙箱。')
    lines.push('')
  }
  lines.push('## Android SDK')
  lines.push('')
  lines.push('| 组件 | 版本 | 许可证 | 许可全文 | 上游源码 |')
  lines.push('|---|---|---|---|---|')
  for (const c of androidComponents ?? []) {
    lines.push(`| ${c.group}:{${c.artifacts.join(', ')}} | ${c.version} | ${c.license} | ${c.licenseText}（assets/licenses/；仓库 LICENSES/） | [Shizuku-API](${c.source}) |`)
  }
  lines.push('')
  lines.push('## 源码要约（GPL §3）')
  lines.push('')
  lines.push('上表各 copyleft 组件的对应源码及完整构建脚本，见 <https://github.com/termux/termux-packages>（按版本标签对应）。')
  lines.push('PRoot Linux 资产由 `scripts/source-build/build-linux-assets.sh` 构建；Termux PRoot 及依赖来自经签名仓库索引验证的官方包。')
  lines.push('本仓对 PRoot 的 `libtalloc.so.2` 动态依赖名作了受审查的 ELF 字符串修正，并将 launcher、loader 与依赖放入 APK native library 目录；')
  lines.push('另由 `vendor/linux-proot/compat/` 构建 TermFold 派生的 Android 兼容 preload，并由同一来源链生成 Debian rootfs 与许可证 provenance。')
  lines.push('对应源码、改写点、依赖锁与构建脚本随本仓发布；APK 从本仓 `main` 的源码来源链生成（见 `docs/RELEASE.md` 合规声明）。')
  mkdirSync(join(noticesPath, '..'), { recursive: true })
  writeFileSync(noticesPath, lines.join('\n'))
  console.log(`notices written: ${noticesPath}（${rows.length} 组件，${copyleft.length} copyleft）`)
}

if (failures.length) {
  console.error(`THIRD-PARTY CHECK FAILED（${failures.length}）`)
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`third-party ok: ${packages.length} 组件（copyleft ${copyleft.length}: ${copyleft.join(', ')}）`)
