import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const checker = fileURLToPath(new URL('./check-third-party.mjs', import.meta.url))
const sourceMatrix = JSON.parse(readFileSync(new URL('./third-party-licenses.json', import.meta.url)))
const sdkLicense = readFileSync(new URL('../LICENSES/Shizuku-API-MIT.txt', import.meta.url))
const backendConfig = JSON.parse(readFileSync(new URL('./source-build/linux-backend-packages.json', import.meta.url)))
const shimSource = JSON.parse(readFileSync(new URL('../vendor/linux-proot/compat/SOURCE.json', import.meta.url)))
const shimBytes = readFileSync(new URL('../vendor/linux-proot/compat/termfold_compat.c', import.meta.url))

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-third-party-'))
  for (const sub of ['scripts', 'LICENSES', 'app', 'usr/var/lib/dpkg']) mkdirSync(join(dir, sub), { recursive: true })
  const matrix = { ...sourceMatrix, packages: { fixture: 'MIT' } }
  writeFileSync(join(dir, 'scripts/third-party-licenses.json'), JSON.stringify(matrix))
  writeFileSync(join(dir, 'LICENSES/Shizuku-API-MIT.txt'), sdkLicense)
  writeFileSync(join(dir, 'LICENSES/GPL-2.0.txt'), readFileSync(new URL('../LICENSES/GPL-2.0.txt', import.meta.url)))
  writeFileSync(join(dir, 'usr/var/lib/dpkg/status'), 'Package: fixture\nVersion: 1.0\n\n')
  writeFileSync(join(dir, 'app/build.gradle.kts'), 'implementation("dev.rikka.shizuku:api:13.1.5")\nimplementation("dev.rikka.shizuku:provider:13.1.5")\n')
  const check = () => spawnSync(process.execPath, [checker, join(dir, 'usr'), '--write-notices', join(dir, 'notices.md')], { cwd: dir, encoding: 'utf8' })
  try { run({ dir, matrix, check }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('notices retain dpkg and include all four fixed Shizuku artifacts and MIT text', () => fixture(({ dir, check }) => {
  const result = check()
  assert.equal(result.status, 0, result.stderr)
  const notices = readFileSync(join(dir, 'notices.md'), 'utf8')
  assert.match(notices, /fixture \| 1\.0 \| MIT/)
  assert.match(notices, /dev\.rikka\.shizuku:\{api, provider, aidl, shared\} \| 13\.1\.5 \| MIT/)
  assert.match(notices, /Shizuku-API-MIT\.txt/)
}))

test('missing SDK license refuses packaging', () => fixture(({ dir, check }) => {
  rmSync(join(dir, 'LICENSES/Shizuku-API-MIT.txt'))
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /许可全文缺失/)
}))

test('altered SDK license refuses packaging', () => fixture(({ dir, check }) => {
  writeFileSync(join(dir, 'LICENSES/Shizuku-API-MIT.txt'), 'not the pinned MIT text')
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SHA256 不符/)
}))

test('unregistered Gradle version refuses packaging', () => fixture(({ dir, check }) => {
  writeFileSync(join(dir, 'app/build.gradle.kts'), 'implementation("dev.rikka.shizuku:api:99.0.0")')
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /许可版本未登记/)
}))

test('missing SDK matrix refuses packaging', () => fixture(({ dir, matrix, check }) => {
  delete matrix.androidComponents
  writeFileSync(join(dir, 'scripts/third-party-licenses.json'), JSON.stringify(matrix))
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SDK 许可矩阵缺失/)
}))

test('unverifiable Gradle dependencies refuse packaging', () => fixture(({ dir, check }) => {
  writeFileSync(join(dir, 'app/build.gradle.kts'), '// dependency declaration missing')
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /依赖不可核实/)
}))

test('direct usr mode accepts real copyright under usr/share/doc', () => fixture(({ dir, matrix, check }) => {
  matrix.packages.fixture = 'GPL-2.0'
  writeFileSync(join(dir, 'scripts/third-party-licenses.json'), JSON.stringify(matrix))
  mkdirSync(join(dir, 'usr/share/doc/fixture'), { recursive: true })
  writeFileSync(join(dir, 'usr/share/doc/fixture/copyright'), 'fixture license text')
  const result = check()
  assert.equal(result.status, 0, result.stderr)
}))

test('direct usr mode refuses missing copyleft copyright', () => fixture(({ dir, matrix, check }) => {
  matrix.packages.fixture = 'GPL-2.0'
  writeFileSync(join(dir, 'scripts/third-party-licenses.json'), JSON.stringify(matrix))
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /copyleft 包缺 copyright 全文/)
}))

function linuxBackendFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-linux-notices-'))
  for (const sub of ['scripts/source-build', 'scripts', 'vendor/linux-proot/compat', 'LICENSES', 'app', 'usr/var/lib/dpkg', 'linux-licenses/proot']) {
    mkdirSync(join(dir, sub), { recursive: true })
  }
  const matrix = { ...sourceMatrix, packages: { fixture: 'MIT' } }
  writeFileSync(join(dir, 'scripts/third-party-licenses.json'), JSON.stringify(matrix))
  writeFileSync(join(dir, 'scripts/source-build/linux-backend-packages.json'), JSON.stringify(backendConfig))
  writeFileSync(join(dir, 'vendor/linux-proot/compat/SOURCE.json'), JSON.stringify(shimSource))
  writeFileSync(join(dir, 'vendor/linux-proot/compat/termfold_compat.c'), shimBytes)
  writeFileSync(join(dir, 'LICENSES/Shizuku-API-MIT.txt'), sdkLicense)
  writeFileSync(join(dir, 'LICENSES/GPL-2.0.txt'), readFileSync(new URL('../LICENSES/GPL-2.0.txt', import.meta.url)))
  writeFileSync(join(dir, 'usr/var/lib/dpkg/status'), 'Package: fixture\nVersion: 1.0\n\n')
  writeFileSync(join(dir, 'app/build.gradle.kts'), 'implementation("dev.rikka.shizuku:api:13.1.5")\nimplementation("dev.rikka.shizuku:provider:13.1.5")\n')

  const licensePath = 'proot/copyright'
  const licenseBytes = Buffer.from('PRoot license fixture\n')
  writeFileSync(join(dir, 'linux-licenses', licensePath), licenseBytes)
  const packages = backendConfig.requiredClosure.map(name => {
    const source = backendConfig.packageSources[name]
    return {
      package: name,
      version: backendConfig.expectedVersions[name],
      license: source.license,
      sourceUrl: source.sourceUrl,
      sourceSha256: source.sourceSha256,
      recipe: source.recipe,
      sha256: 'a'.repeat(64),
    }
  })
  const provenance = {
    schemaVersion: 1,
    target: 'proot',
    repository: 'https://packages.termux.dev/apt/termux-main',
    targetVersion: backendConfig.expectedVersions.proot,
    packages,
    compatibilityShim: {
      ...shimSource,
      localSourceSha256: createHash('sha256').update(shimBytes).digest('hex'),
    },
    licenseFiles: [{
      path: licensePath,
      size: licenseBytes.length,
      sha256: createHash('sha256').update(licenseBytes).digest('hex'),
    }],
  }
  const provenancePath = join(dir, 'linux-provenance.json')
  writeFileSync(provenancePath, JSON.stringify(provenance))
  const check = () => spawnSync(process.execPath, [
    checker,
    join(dir, 'usr'),
    '--write-notices', join(dir, 'notices.md'),
    '--linux-backend-provenance', provenancePath,
    '--linux-backend-licenses', join(dir, 'linux-licenses'),
  ], { cwd: dir, encoding: 'utf8' })
  try { run({ dir, check, licensePath }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('PRoot notice validates and lists provenance-bound license files', () => linuxBackendFixture(({ dir, check }) => {
  const result = check()
  assert.equal(result.status, 0, result.stderr)
  const notices = readFileSync(join(dir, 'notices.md'), 'utf8')
  assert.match(notices, /Linux PRoot backend/)
  assert.match(notices, /TermFold 兼容 shim/)
}))

test('PRoot notice refuses a symlink in the license tree', () => linuxBackendFixture(({ dir, check, licensePath }) => {
  const target = join(dir, 'outside-license.txt')
  writeFileSync(target, 'PRoot license fixture\n')
  rmSync(join(dir, 'linux-licenses', licensePath))
  symlinkSync(target, join(dir, 'linux-licenses', licensePath))
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /不允许符号链接/)
}))

test('PRoot notice refuses a symlink license root', () => linuxBackendFixture(({ dir, check }) => {
  const root = join(dir, 'linux-licenses')
  const realRoot = join(dir, 'linux-licenses-real')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(realRoot, { recursive: true })
  writeFileSync(join(realRoot, 'license.txt'), 'outside license')
  symlinkSync(realRoot, root, 'dir')
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /普通目录/)
}))

function sourceBackendFixture(run) {
  linuxBackendFixture(({ dir, check }) => {
    const helper = fileURLToPath(new URL('./source-build', import.meta.url))
    const generated = spawnSync(process.env.PYTHON || 'python3', ['-c',
      'import sys,json; sys.path.insert(0,sys.argv[1]); from test_proot_source_backend import receipt; print(json.dumps(receipt()))', helper,
    ], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const receipt = JSON.parse(generated.stdout)
    const receiptName = 'proot-source-build-arm64.json'
    writeFileSync(join(dir, receiptName), generated.stdout)
    const path = join(dir, 'linux-provenance.json')
    const old = JSON.parse(readFileSync(path))
    const report = {
      schemaVersion: 2, provenanceKind: 'source-build', target: 'proot', architecture: 'arm64',
      targetVersion: receipt.sources.proot.version, sourceBuildReceipt: receiptName,
      sourceBuildReceiptSha256: createHash('sha256').update(generated.stdout).digest('hex'),
      nativeLibraries: receipt.nativeLibraries,
      licenseOrigins: Object.entries(receipt.sources).map(([name, row]) => ({ package: name, sourceArchiveSha256: row.sha256 })),
      compatibilityShim: old.compatibilityShim, licenseFiles: old.licenseFiles,
    }
    writeFileSync(path, JSON.stringify(report))
    run({ dir, check, path, report })
  })
}

test('source-built PRoot notice describes source compilation without claiming signed Termux packages', () => sourceBackendFixture(({ dir, check }) => {
  const result = check()
  assert.equal(result.status, 0, result.stderr)
  const notices = readFileSync(join(dir, 'notices.md'), 'utf8')
  assert.match(notices, /固定摘要源码使用官方 NDK 构建/)
  assert.doesNotMatch(notices, /Termux 官方签名仓库包提供|动态依赖名作了受审查的 ELF 字符串修正/)
}))

test('source-built PRoot notice rejects a forged receipt and package masquerade', () => sourceBackendFixture(({ check, path, report }) => {
  for (const candidate of [
    { ...report, sourceBuildReceiptSha256: '0'.repeat(64) },
    { ...report, repository: 'https://packages.termux.dev' },
  ]) {
    writeFileSync(path, JSON.stringify(candidate))
    const result = check()
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /source provenance 不符合源码构建协议/)
  }
}))
