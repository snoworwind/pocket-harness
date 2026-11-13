#!/usr/bin/env node
// Independently replay source package payloads and patches against the Linux composition tree.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  cpSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
// 并行上限的唯一真源（scripts/lib/shell.mjs）：本文件只用它解压校验用快照，见下方 xz 调用。
// 不写死数字、更不用 `-T0`——`-T0` = 吃满全部逻辑核，本地跑链时会与模拟器抢满 CPU
// （check-build-parallel-cap.mjs 明文禁止；本文件此前是漏网的一处）。
import { linuxAbi } from './linux-abi.mjs'
import { XZ_THREADS } from '../lib/shell.mjs'
import { checkDshRuntimeDependencies } from './check-dsh-runtime-dependencies.mjs'
import { checkPresetCarriers } from './preset-carriers.mjs'
import { verifyPackagePayload, packagePayload } from './verify-package-payload.mjs'
import { collectPhysicalFiles, matchesPatchTarget, enginePatchTargets, verifyCanonicalEnginePatch } from './reconcile-engine-patch-copies.mjs'

import { checkEngineArtifacts } from './check-linux-runtime-packages.mjs'
if (process.argv[2] === '--artifacts-only') {
  if (!process.argv[3]) throw new Error('engine root required')
  checkEngineArtifacts(resolve(process.argv[3]))
  console.log('Linux engine development metadata check passed')
  process.exit(0)
}
const compositionArg = process.argv[2]
if (!compositionArg) {
  console.error('usage: node check-linux-engine.mjs <composition-root>')
  process.exit(2)
}

const composition = resolve(compositionArg)
const sourceBuildRoot = resolve('.deploy-tmp/source-build')
const sourceManifestPath = resolve('.deploy-tmp/engine-overlay/source-build-manifest.json')
const reportPath = process.argv[3] ? resolve(process.argv[3]) : join(sourceBuildRoot, 'linux-engine-check.json')
const packageCache = resolve('.deploy-tmp/engine-overlay')
const contract = JSON.parse(readFileSync('scripts/contract.json', 'utf8'))
const expectedCommit = contract.upstream.commit
const packagePrefix = 'usr/lib/node_modules/@deepseek-ai/dsh'
const overlayPath = join(sourceBuildRoot, 'engine-overlay.original.json')
const overridePath = join(sourceBuildRoot, 'harness-vendor-overrides.json')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const within = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
if (sourceManifest.commit !== expectedCommit) throw new Error(`unexpected Harness source commit: ${sourceManifest.commit}`)
const sourceOverlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
if (sourceOverlay.engineVersion !== contract.upstream.rootVersion || sourceOverlay.rootPackage?.version !== contract.upstream.rootVersion) {
  throw new Error('Linux engine overlay must match the pinned source contract')
}
const expectedPackages = new Map(Object.entries(sourceOverlay.packages ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/')))
expectedPackages.set(sourceOverlay.rootPackage.name, sourceOverlay.rootPackage.version)
if (sourceManifest.packageCount !== sourceManifest.packages?.length || sourceManifest.packageCount !== expectedPackages.size) {
  throw new Error(`source package manifest is incomplete: ${sourceManifest.packageCount}, expected ${expectedPackages.size}`)
}
const overrideReport = JSON.parse(readFileSync(overridePath, 'utf8'))
if (overrideReport.harnessSourceCommit !== expectedCommit
  || overrideReport.mode !== 'pinned-target-source-evidence' || overrideReport.rewoundSourceCount !== 0
  || !Array.isArray(overrideReport.overrides) || overrideReport.overrides.length === 0
  || overrideReport.overrides.some((item) => item.sourceCommit !== expectedCommit)) {
  throw new Error('Harness vendor evidence must audit the official target without source rewinds')
}
const overrideByPackage = new Map((overrideReport.overrides ?? []).map((item) => [item.package, item]))
const sourcePackageNames = new Set()
for (const item of sourceManifest.packages) {
  if (sourcePackageNames.has(item.name)) throw new Error(`duplicate source package entry: ${item.name}`)
  sourcePackageNames.add(item.name)
  if (expectedPackages.get(item.name) !== item.version) {
    throw new Error(`source manifest has an unexpected overlay package: ${item.name}@${item.version}`)
  }
  const override = overrideByPackage.get(item.name)
  if ((override?.sourceCommit ?? expectedCommit) !== item.sourceCommit) {
    throw new Error(`source manifest commit mismatch for ${item.name}: ${item.sourceCommit}`)
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'linux-source-check-'))
try {
  const engineRoot = join(composition, packagePrefix)
  const physicalEngineRoot = realpathSync(engineRoot)
  // Reconstruct source-owned payload from hash-bound packs, then independently replay
  // reviewed patches. Do not use candidate bytes as their own expected JS reference.
  const referenceStage = join(tempRoot, 'reference')
  const referenceEngine = join(referenceStage, packagePrefix)
  cpSync(engineRoot, referenceEngine, { recursive: true, dereference: false, verbatimSymlinks: true })
  for (const item of sourceManifest.packages) {
    const archive = resolve(packageCache, item.file)
    if (!within(packageCache, archive) || sha256(readFileSync(archive)) !== item.sha256) {
      throw new Error(`${item.name} source archive is not hash-bound`)
    }
    const target = item.name === '@deepseek-ai/dsh' ? referenceEngine
      : join(referenceEngine, 'node_modules', ...item.name.split('/'))
    const physical = realpathSync(target)
    if (!within(referenceEngine, physical)) throw new Error('Reference package escaped engine')
    for (const child of readdirSync(physical)) {
      if (child !== 'node_modules') rmSync(join(physical, child), { recursive: true, force: true })
    }
    execFileSync('tar', ['-xzf', archive, '-C', physical, '--strip-components=1', '--no-same-owner'])
  }
  execFileSync(process.execPath, ['scripts/patches/apply-patches.mjs', referenceStage, '--apply', '--scope', 'engine'], { stdio: 'inherit' })
  execFileSync(process.execPath, ['scripts/check-browser-syntax-floor.mjs', '--degrade', '--stage', referenceStage], { stdio: 'inherit' })
  const physicalFiles = collectPhysicalFiles(engineRoot)
  const physicalRelative = physicalFiles.map(file => ({ file, rel: relative(engineRoot, file).split(sep).join('/') }))
  const packageChecks = []
  for (const item of sourceManifest.packages) {
    const packageDir = item.name === '@deepseek-ai/dsh'
      ? engineRoot
      : join(engineRoot, 'node_modules', ...item.name.split('/'))
    const packageJson = join(packageDir, 'package.json')
    if (!existsSync(packageJson)) throw new Error(`Linux engine is missing source package ${item.name}@${item.version}`)
    const physicalPackageDir = realpathSync(packageDir)
    if (!within(physicalEngineRoot, physicalPackageDir)) throw new Error(`${item.name} link escapes the source engine tree`)
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8'))
    if (manifest.name !== item.name || manifest.version !== item.version) {
      throw new Error(`${item.name} Linux engine identity mismatch: ${manifest.name}@${manifest.version}, expected ${item.version}`)
    }
    const archive = join(packageCache, item.file)
    if (!existsSync(archive) || sha256(readFileSync(archive)) !== item.sha256) {
      throw new Error(`${item.name}@${item.version} source tarball hash mismatch`)
    }
    const referenceDir = item.name === '@deepseek-ai/dsh' ? referenceEngine
      : join(referenceEngine, 'node_modules', ...item.name.split('/'))
    const payloadFiles = verifyPackagePayload(referenceDir, packageDir, item.name)
    if (item.name !== '@deepseek-ai/dsh') {
      const prefix = `node_modules/${item.name}/`
      const expectedPayload = packagePayload(referenceDir)
      for (const { file, rel } of physicalRelative) {
        const offset = rel.lastIndexOf(prefix)
        if (offset < 0) continue
        const inner = rel.slice(offset + prefix.length)
        if (inner.includes('/node_modules/') || inner.startsWith('node_modules/') || inner === 'package.json'
          || !/\.(?:js|cjs|mjs|json|wasm|node)$/.test(inner)) continue
        if (sha256(readFileSync(file)) !== expectedPayload.get(inner)) {
          throw new Error(`${item.name}: physical payload copy differs: ${rel}`)
        }
      }
    }
    packageChecks.push({
      name: item.name,
      version: item.version,
      sourceCommit: item.sourceCommit,
      sourceTarballSha256: item.sha256,
      payloadFiles,
    })
  }

  // pnpm may resolve a physical store package rather than the top-level materialized
  // copy. Follow its payload links within the engine and compare every such package.
  const storeRoot = join(engineRoot, 'node_modules', '.pnpm')
  if (existsSync(storeRoot)) {
    const checked = new Set()
    for (const store of readdirSync(storeRoot)) {
      const scope = join(storeRoot, store, 'node_modules', '@deepseek-ai')
      if (!existsSync(scope)) continue
      for (const short of readdirSync(scope)) {
        const name = `@deepseek-ai/${short}`
        if (!sourcePackageNames.has(name)) continue
        const candidate = join(scope, short)
        const physical = realpathSync(candidate)
        if (!within(physicalEngineRoot, physical)) throw new Error(`${name} pnpm payload escapes engine`)
        if (checked.has(physical)) continue
        checked.add(physical)
        const expected = name === '@deepseek-ai/dsh' ? referenceEngine : join(referenceEngine, 'node_modules', name)
        verifyPackagePayload(expected, candidate, `${name} pnpm store`, engineRoot)
      }
    }
  }

  console.log(`source payload byte check passed: ${packageChecks.length} source packages and pnpm physical payloads`)
  const dependencyCheck = checkDshRuntimeDependencies(engineRoot)
  // The engine argv moved into the guest boot contract when the primary engine switched to
  // PRoot/Debian; the fallback still needs the V8 internals flag on that same argv.
  const launcher = readFileSync('app/src/main/java/com/snoworwind/pocketharness/LinuxGuestBoot.kt', 'utf8')
  if (!launcher.includes('"--expose-internals"')) {
    throw new Error('the guest engine argv no longer exposes Node internals for the JavaScript loader fallback')
  }
  const patchRegistry = JSON.parse(readFileSync('scripts/patches/registry.json', 'utf8'))
  const patchChecks = []
  const runtimePrefix = `${packagePrefix}/`
  const engineFiles = collectPhysicalFiles(engineRoot)
  const enginePatches = patchRegistry.patches.filter((item) => item.scope === 'engine' && item.overlayCheck !== false)
  // 空过守卫：marker 为空时旧实现直接 `continue`，该补丁便既不参与本判据、也不参与
  // reconcile-engine-patch-copies.mjs 的副本收敛（同一过滤条件）——**两条路径一起静默跳过**。
  // 于是「新增补丁自动纳入，无需再手改本文件」（下方原注释的承诺）落空：删掉 marker 字段、
  // 或把它写成全角括号注释（`replace(/（.*$/)` 后为空）即可让任一 engine 补丁退出核验。
  // 故不再静默：要么补 marker，要么在 registry 显式写 `overlayCheck: false` 走豁免
  // （豁免在 registry 里留档，是有记录的选择，与本处「忘了写 marker」不是一回事）。
  const markerless = enginePatches
    .filter((item) => !String(item.marker ?? '').replace(/（.*$/, '').trim())
    .map((item) => item.id)
  if (markerless.length > 0) {
    throw new Error(`engine patches without a usable marker would be skipped silently: ${markerless.join(', ')}`
      + '（marker 为空 ⇒ 该补丁在来源链上完全没有判据；请补 marker 或在 registry 显式登记 overlayCheck:false）')
  }
  for (const patch of enginePatches) verifyCanonicalEnginePatch(engineRoot, patch)
  for (const patch of enginePatches.flatMap(patch => enginePatchTargets(patch, engineRoot))) {
    const marker = String(patch.marker ?? '').replace(/（.*$/, '').trim()
    if (!marker) continue
    if (!patch.target.startsWith(runtimePrefix)) throw new Error(`engine patch target escaped the source runtime: ${patch.target}`)
    const targetRel = patch.target.slice(runtimePrefix.length)
    const target = resolve(engineRoot, targetRel)
    if (!within(engineRoot, target) || !existsSync(target)) throw new Error(`Linux engine patch target missing: ${patch.id}`)
    const physicalTarget = realpathSync(target)
    if (!within(physicalEngineRoot, physicalTarget)) throw new Error(`Linux engine patch target link escaped: ${patch.id}`)
    const content = readFileSync(target, 'utf8')
    if (!patch.verifier && !content.includes(marker)) throw new Error(`Linux engine patch marker missing: ${patch.id} (${marker})`)
    // 副本面（设备实锤，0.14.2 追版后）：pnpm 布局下同一包在上层与 `.pnpm/**` store 各有一份物理文件，
    // 引擎补丁只按顶层 target 写入 ⇒ store 副本保持原样；而运行时按依赖查找可能解析到 store 那份
    // （`node-addon-require-builtin` 就是这样 ⇒ 未打补丁 ⇒ 引擎 boot 硬崩；同批 `pi-toolcall-G2` 亦然）。
    // 故判据不只看 target 本身：**同一目标的任何物理副本都必须带 marker**。
    const copies = engineFiles.filter((file) => matchesPatchTarget(relative(engineRoot, file).split(sep).join('/'), targetRel))
    const canonicalBytes = readFileSync(target)
    const unpatched = copies.filter((file) => !readFileSync(file).equals(canonicalBytes))
    if (unpatched.length > 0) {
      const paths = unpatched.map((file) => relative(engineRoot, file).split(sep).join('/')).sort()
      throw new Error(`Linux engine has unpatched copies of ${patch.id}: ${paths.join(', ')}`
        + '（同一补丁目标在 pnpm store 里有副本没打上 ⇒ 运行时可能加载到未打补丁的那份）')
    }
    patchChecks.push({ id: patch.id, target: patch.target, marker, physicalCopies: copies.length })
  }

  // 内置预设载体：口径与权威门禁 check-engine-overlay.mjs 的 CARRIERS 同源，漂移由
  // preset-carriers.test.mjs 双向复核。此处曾盯 0.1.5-rc.1 时代的 `dsh-agent-presets/presets`
  // ——该包在 0.1.7 被拆分，本链抬 pin 后旧断言必然判红（坑 200）。
  const carrierChecks = checkPresetCarriers(engineRoot)

  const report = {
    source: sourceManifest.source,
    sourceCommit: sourceManifest.commit,
    sourceLockfileSha256: sourceManifest.lockfileSha256,
    vendorSourceOverrides: overrideReport.overrides.map(({ package: name, version, sourceCommit, sourceTree }) => ({
      package: name,
      version,
      sourceCommit,
      sourceTree,
    })),
    runtime: linuxAbi().runtime,
    packageCount: packageChecks.length,
    packages: packageChecks,
    dependencyCheck,
    patchChecks,
    presetCarriers: carrierChecks,
  }
  mkdirSync(sourceBuildRoot, { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  const carriers = carrierChecks.map((carrier) => `${carrier.label} ${carrier.fileCount}`).join(', ')
  console.log(`Linux engine check passed: ${packageChecks.length} pinned packages, ${dependencyCheck.dependencyCount} dependency links, ${patchChecks.length} engine patch markers, preset carriers: ${carriers}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
