#!/usr/bin/env node
// Install the source-built engine overlay captured in a trusted engine-base cache.
// A cache hit skips build-engine.sh, so its checked overlay transformations must be
// restored before build-snapshot-013 reads snapshot-config/engine-overlay.json.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const fail = message => { throw new Error('restore-effective-engine-overlay: ' + message) }
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonicalJson = value => {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function readRegularJson(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) fail('input must be a regular non-symlink file: ' + path)
  const bytes = readFileSync(path)
  return { bytes, value: JSON.parse(bytes.toString('utf8')) }
}

function packageMap(value, label) {
  if (!isRecord(value) || Object.entries(value).some(([name, version]) => !name || typeof version !== 'string' || !version)) {
    fail(label + ' must be a package-to-version object')
  }
  return value
}

function withoutOverlayPayload(value) {
  const { packages: _packages, vendorTop: _vendorTop, ...metadata } = value
  return metadata
}

/** Validate that the cached effective overlay is exactly the pinned transformation of the checked-in input. */
export function validateEffectiveOverlay(originalPath, effectivePath, policyPath) {
  const originalFile = readRegularJson(originalPath)
  const effectiveFile = readRegularJson(effectivePath)
  const policyFile = readRegularJson(policyPath)
  const { value: original } = originalFile
  const { value: effective } = effectiveFile
  const { value: policy } = policyFile
  if (!isRecord(original) || !isRecord(effective) || !isRecord(policy)) fail('overlay and policy roots must be JSON objects')

  const vendorPolicy = policy.sourceOnlyVendorTop
  if (!isRecord(vendorPolicy) || vendorPolicy.baseOverlaySha256 !== sha256(originalFile.bytes)) {
    fail('source-only vendor pins are not bound to the checked-in overlay bytes')
  }
  const sourceOnlyVendorTop = packageMap(vendorPolicy.packages, 'sourceOnlyVendorTop.packages')
  const originalPackages = packageMap(original.packages, 'original.packages')
  const effectivePackages = packageMap(effective.packages, 'effective.packages')
  const originalVendorTop = packageMap(original.vendorTop, 'original.vendorTop')
  const effectiveVendorTop = packageMap(effective.vendorTop, 'effective.vendorTop')

  const omitted = policy.omittedFirstPartyPackageOverlays
  const injection = policy.firstPartySourceInjection
  if (!Array.isArray(omitted) || omitted.length === 0 || !isRecord(injection)
      || !Array.isArray(injection.packages) || injection.packageCount !== injection.packages.length
      || injection.packageCount !== omitted.length) {
    fail('source package omission list does not match the source injection receipt')
  }
  const packagePairs = entries => entries.map(item => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.startsWith('@deepseek-ai/')
        || typeof item.version !== 'string' || !item.version) {
      fail('source package receipt contains an invalid package identity')
    }
    return { name: item.name, version: item.version }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const omittedPairs = packagePairs(omitted)
  const injectedPairs = packagePairs(injection.packages)
  if (new Set(omittedPairs.map(item => item.name)).size !== omittedPairs.length
      || canonicalJson(omittedPairs) !== canonicalJson(injectedPairs)) {
    fail('source package omission list differs from the injected package receipt')
  }

  const expectedPackages = { ...originalPackages }
  for (const { name, version } of omittedPairs) {
    if (expectedPackages[name] !== version) fail('source package version differs from the original overlay: ' + name)
    delete expectedPackages[name]
  }
  if (canonicalJson(effectivePackages) !== canonicalJson(expectedPackages)) {
    fail('effective packages differ from the original overlay plus source injection receipt')
  }

  const expectedVendorTop = { ...originalVendorTop }
  for (const [name, version] of Object.entries(sourceOnlyVendorTop)) {
    if (expectedVendorTop[name] !== undefined && expectedVendorTop[name] !== version) {
      fail('source-only vendor pin conflicts with the original overlay: ' + name)
    }
    expectedVendorTop[name] = version
  }
  if (canonicalJson(effectiveVendorTop) !== canonicalJson(expectedVendorTop)) {
    fail('effective vendorTop differs from the source-only runtime pin receipt')
  }
  if (canonicalJson(withoutOverlayPayload(effective)) !== canonicalJson(withoutOverlayPayload(original))) {
    fail('effective overlay metadata differs from the checked-in original')
  }

  return {
    schema: 1,
    originalSha256: sha256(originalFile.bytes),
    effectiveSha256: sha256(effectiveFile.bytes),
    sourceBuildPolicySha256: sha256(policyFile.bytes),
    sourcePackageCount: omittedPairs.length,
    sourceOnlyVendorTop,
  }
}

function assertSafeOutput(path) {
  const target = resolve(path)
  if (existsSync(target)) {
    const info = lstatSync(target)
    if (info.isSymbolicLink() || !info.isFile()) fail('output must be a regular non-symlink file: ' + path)
  }
}

function atomicWrite(path, bytes) {
  const target = resolve(path)
  assertSafeOutput(target)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Exercise the trusted transformation and one tampered-cache rejection without touching the repo. */
export function selfTest(negative = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'effective-overlay-self-test-'))
  try {
    const originalPath = resolve(root, 'original.json')
    const effectivePath = resolve(root, 'effective.json')
    const policyPath = resolve(root, 'policy.json')
    const targetPath = resolve(root, 'target.json')
    const reportPath = resolve(root, 'report.json')
    const original = {
      engineVersion: '0.2.1-rc.2',
      rootPackage: { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' },
      packages: { '@deepseek-ai/dsh-app': '0.2.1-rc.2', '@deepseek-ai/dsh-client': '0.2.1-rc.2', zod: '4.4.3' },
      vendorTop: { got: '14.6.6' },
      pins: { semver: '7.6.0' },
    }
    const originalBytes = JSON.stringify(original, null, 2) + '\n'
    const omitted = [
      { name: '@deepseek-ai/dsh-app', version: '0.2.1-rc.2' },
      { name: '@deepseek-ai/dsh-client', version: '0.2.1-rc.2' },
    ]
    const effective = {
      ...original,
      packages: { zod: '4.4.3' },
      vendorTop: { got: '14.6.6', 'partial-json': '0.1.7' },
    }
    const policy = {
      sourceOnlyVendorTop: { baseOverlaySha256: sha256(Buffer.from(originalBytes)), packages: { 'partial-json': '0.1.7' } },
      omittedFirstPartyPackageOverlays: omitted,
      firstPartySourceInjection: { packageCount: omitted.length, packages: omitted.map(item => ({ ...item, preservedPnpmLink: true })) },
    }
    writeFileSync(originalPath, originalBytes)
    writeFileSync(effectivePath, JSON.stringify(effective, null, 2) + '\n')
    writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n')

    if (negative) {
      writeFileSync(effectivePath, JSON.stringify({ ...effective, vendorTop: { ...effective.vendorTop, 'partial-json': '9.9.9' } }, null, 2) + '\n')
      assert.throws(() => validateEffectiveOverlay(originalPath, effectivePath, policyPath), /effective vendorTop/)
      assert.equal(existsSync(targetPath), false)
      return 'tampered source-only vendor pin rejected before writing target'
    }
    const report = validateEffectiveOverlay(originalPath, effectivePath, policyPath)
    atomicWrite(targetPath, JSON.stringify(effective, null, 2) + '\n')
    atomicWrite(reportPath, JSON.stringify({ ...report, target: 'target.json' }, null, 2) + '\n')
    assert.deepEqual(JSON.parse(readFileSync(targetPath, 'utf8')), effective)
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).sourcePackageCount, 2)
    return 'trusted source overlay restored and receipt written'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-test') {
    console.log(selfTest(false))
  } else if (args.length === 1 && args[0] === '--self-test-negative') {
    console.log(selfTest(true))
  } else if (args.length === 5) {
    const [originalPath, effectivePath, policyPath, targetPath, reportPath] = args
    const report = validateEffectiveOverlay(originalPath, effectivePath, policyPath)
    assertSafeOutput(targetPath)
    assertSafeOutput(reportPath)
    atomicWrite(targetPath, readFileSync(effectivePath))
    atomicWrite(reportPath, JSON.stringify({ ...report, target: targetPath.replaceAll('\\', '/') }, null, 2) + '\n')
    console.log(`restored ${report.sourcePackageCount} source-built engine packages and ${Object.keys(report.sourceOnlyVendorTop).length} source-only vendor pins`)
  } else {
    console.error('usage: restore-effective-engine-overlay.mjs <original> <effective> <policy> <target> <report> | --self-test | --self-test-negative')
    process.exit(2)
  }
}
