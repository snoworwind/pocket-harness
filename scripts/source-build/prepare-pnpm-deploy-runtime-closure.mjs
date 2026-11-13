#!/usr/bin/env node
// Temporarily add every source-built first-party overlay package to the actual
// pnpm deploy target's production graph, updating its frozen importer directly.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'

if (process.argv[2] === '--self-test') {
  execFileSync(process.execPath, ['--test', new URL('./linux-runtime-closure.test.mjs', import.meta.url).pathname], { stdio: 'inherit' })
  process.exit(0)
}

const args = process.argv.slice(2)
let abi = 'arm64'
if (args.length === 5) abi = args.pop()
const [sourceArg, overlayArg, backupArg, reportArg] = args
if (args.length !== 4 || !sourceArg || !overlayArg || !backupArg || !reportArg) {
  console.error('usage: node prepare-pnpm-deploy-runtime-closure.mjs <harness-source-root> <engine-overlay.json> <backup-dir> <report.json> [arm64]')
  process.exit(2)
}
if (abi !== 'arm64') throw new Error('Linux experiment requires ARM64')
const koffiLinuxPackage = '@koromix/koffi-linux-arm64'

const sourceRoot = resolve(sourceArg)
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
if (sourceCommit !== '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db' || sourceManifest.version !== '0.2.2-rc.1'
  || sourceManifest.packageManager !== 'pnpm@11.28.5') {
  throw new Error('production deployment requires official 0.2.2-rc.1 source and pnpm 11.28.5')
}
const cliDir = join(sourceRoot, 'apps', 'cli')
const packageFile = join(cliDir, 'package.json')
const lockFile = join(sourceRoot, 'pnpm-lock.yaml')
const workspaceFile = join(sourceRoot, 'pnpm-workspace.yaml')
const backupDir = resolve(backupArg)
const reportFile = resolve(reportArg)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const originalPackage = readFileSync(packageFile)
const originalLock = readFileSync(lockFile)
const originalWorkspace = readFileSync(workspaceFile)
const manifest = JSON.parse(originalPackage.toString('utf8'))
const overlay = JSON.parse(readFileSync(resolve(overlayArg), 'utf8'))
if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.2-rc.1'
  || overlay.engineVersion !== '0.2.2-rc.1' || overlay.rootPackage?.version !== '0.2.2-rc.1') {
  throw new Error('production deployment manifest/overlay must target 0.2.2-rc.1')
}
const packages = Object.entries(overlay.packages ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/'))
  .sort(([a], [b]) => a.localeCompare(b))
if (packages.length < 200) throw new Error(`expected the pinned first-party package set, found ${packages.length}`)

const requireFromCli = createRequire(packageFile)
const yaml = requireFromCli('js-yaml')
const lock = yaml.load(originalLock.toString('utf8'))
const workspaceConfig = yaml.load(originalWorkspace.toString('utf8'))
const importer = lock.importers?.['apps/cli']
if (!importer) throw new Error('pnpm-lock.yaml is missing the apps/cli importer')

// Resolve the guest's actual native packages and reviewed JavaScript pins through pnpm.
// No bootstrap-era overlay downloader or Android fallback packages participate.
const linuxRuntimeDependencies = {
  [koffiLinuxPackage]: '3.2.1',
  '@koromix/koffi-linux-x64': '3.2.1',
  '@img/sharp-linux-arm64': '0.35.5',
  '@img/sharp-linux-x64': '0.35.5',
}
const thirdPartyPins = Object.fromEntries(Object.entries({ ...overlay.vendorTop, ...overlay.pins, 'partial-json': '0.1.7' })
  .filter(([name]) => !name.startsWith('@deepseek-ai/')))
const dependencies = { ...(manifest.dependencies ?? {}), ...thirdPartyPins, ...linuxRuntimeDependencies }
const importerDependencies = { ...(importer.dependencies ?? {}) }
for (const [name, version] of Object.entries({ ...thirdPartyPins, ...linuxRuntimeDependencies })) {
  importerDependencies[name] = { specifier: version, version }
}
workspaceConfig.overrides = { ...(workspaceConfig.overrides ?? {}), koffi: '3.2.1' }
for (const [host, children] of Object.entries(overlay.nested ?? {})) {
  for (const [dependency, version] of Object.entries(children)) workspaceConfig.overrides[`${host}>${dependency}`] = version
}
workspaceConfig.supportedArchitectures = { os: ['current', 'linux'], cpu: ['current', 'arm64', 'x64'], libc: ['glibc'] }

const packageDirs = new Map()
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.name === 'package.json') {
      let candidate
      try { candidate = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (typeof candidate.name === 'string') packageDirs.set(candidate.name, dirname(file))
    }
  }
}
walk(sourceRoot)

mkdirSync(backupDir, { recursive: true })
copyFileSync(packageFile, join(backupDir, 'apps-cli-package.json.original'))
copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml.original'))

const sections = ['devDependencies', 'optionalDependencies', 'peerDependencies']
const removedFrom = Object.fromEntries(sections.map((section) => [section, []]))
const removedFromImporter = Object.fromEntries(['devDependencies', 'optionalDependencies', 'peerDependencies'].map((section) => [section, []]))
const forcedWorkspacePackages = []
for (const [name] of packages) {
  const packageDir = packageDirs.get(name)
  if (!packageDir) throw new Error(`no pinned workspace source package found for ${name}`)
  const linkPath = relative(cliDir, packageDir).replaceAll('\\', '/')
  if (!linkPath.startsWith('../')) throw new Error(`${name} resolves inside apps/cli instead of a sibling workspace package: ${linkPath}`)
  dependencies[name] = 'workspace:*'
  importerDependencies[name] = { specifier: 'workspace:*', version: `link:${linkPath}` }
  for (const section of sections) {
    if (manifest[section] && Object.hasOwn(manifest[section], name)) {
      delete manifest[section][name]
      removedFrom[section].push(name)
    }
  }
  for (const section of Object.keys(removedFromImporter)) {
    if (importer[section] && Object.hasOwn(importer[section], name)) {
      delete importer[section][name]
      removedFromImporter[section].push(name)
    }
  }
  forcedWorkspacePackages.push({ name, path: linkPath })
}

manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
for (const section of sections) {
  if (manifest[section] && !Object.keys(manifest[section]).length) delete manifest[section]
}
importer.dependencies = Object.fromEntries(Object.entries(importerDependencies).sort(([a], [b]) => a.localeCompare(b)))
for (const section of Object.keys(removedFromImporter)) {
  if (importer[section] && !Object.keys(importer[section]).length) delete importer[section]
}

const temporaryPackage = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
const temporaryLock = Buffer.from(yaml.dump(lock, { lineWidth: -1, noRefs: true, quotingType: "'" }))
writeFileSync(packageFile, temporaryPackage)
writeFileSync(lockFile, temporaryLock)
const temporaryWorkspace = Buffer.from(yaml.dump(workspaceConfig, { lineWidth: -1, noRefs: true, quotingType: "'" }))
writeFileSync(workspaceFile, temporaryWorkspace)
writeFileSync(reportFile, JSON.stringify({
  sourceCommit,
  deployTarget: 'apps/cli (@deepseek-ai/dsh)',
  originalPackageJsonSha256: sha256(originalPackage),
  temporaryPackageJsonSha256: sha256(temporaryPackage),
  originalLockfileSha256: sha256(originalLock),
  temporaryLockfileSha256: sha256(temporaryLock),
  originalWorkspaceConfigSha256: sha256(originalWorkspace),
  temporaryWorkspaceConfigSha256: sha256(temporaryWorkspace),
  packageCount: forcedWorkspacePackages.length,
  productionWorkspacePackages: forcedWorkspacePackages,
  linuxRuntimeDependencies: {
    ...linuxRuntimeDependencies,
    abi,
    koffiLinuxPackage,
    koffiOverride: '3.2.1',
    supportedArchitectures: workspaceConfig.supportedArchitectures,
    thirdPartyPins,
    consumerOverrides: overlay.nested ?? {},
  },
  removedFromManifestSections: removedFrom,
  removedFromImporterSections: removedFromImporter,
  purpose: 'Temporarily resolve the fixed source-built first-party packages and the Linux ARM64 glibc dependency closure. Restore all upstream manifests and locks after deploy.',
}, null, 2) + '\n')
console.log(`prepared apps/cli production dependency closure for ${forcedWorkspacePackages.length} first-party packages`)
