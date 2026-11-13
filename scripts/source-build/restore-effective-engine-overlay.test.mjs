import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateEffectiveOverlay } from './restore-effective-engine-overlay.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'restore-effective-overlay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const originalPath = join(root, 'original.json')
  const effectivePath = join(root, 'effective.json')
  const policyPath = join(root, 'policy.json')
  const targetPath = join(root, 'snapshot-config', 'engine-overlay.json')
  const reportPath = join(root, 'receipt.json')
  const original = {
    engineVersion: '0.2.1-rc.2',
    rootPackage: { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' },
    packages: { '@deepseek-ai/dsh-app': '0.2.1-rc.2', '@deepseek-ai/dsh-client': '0.2.1-rc.2', zod: '4.4.3' },
    vendorTop: { got: '14.6.6' },
    pins: { semver: '7.6.0' },
  }
  const originalBytes = Buffer.from(JSON.stringify(original, null, 2) + '\n')
  const omitted = [
    { name: '@deepseek-ai/dsh-app', version: '0.2.1-rc.2' },
    { name: '@deepseek-ai/dsh-client', version: '0.2.1-rc.2' },
  ]
  const effective = {
    ...original,
    packages: { zod: '4.4.3' },
    vendorTop: { got: '14.6.6', 'partial-json': '0.1.7' },
  }
  const effectiveBytes = Buffer.from(JSON.stringify(effective, null, 2) + '\n')
  const policy = {
    sourceOnlyVendorTop: { baseOverlaySha256: digest(originalBytes), packages: { 'partial-json': '0.1.7' } },
    omittedFirstPartyPackageOverlays: omitted,
    firstPartySourceInjection: { packageCount: omitted.length, packages: omitted.map(item => ({ ...item, preservedPnpmLink: true })) },
  }
  writeFileSync(originalPath, originalBytes)
  writeFileSync(effectivePath, effectiveBytes)
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n')
  return { root, originalPath, effectivePath, policyPath, targetPath, reportPath, original, effective, policy, originalBytes, effectiveBytes }
}

test('trusted effective overlay restores the exact source-built packages and vendor pins', t => {
  const data = fixture(t)
  const receipt = validateEffectiveOverlay(data.originalPath, data.effectivePath, data.policyPath)
  assert.equal(receipt.sourcePackageCount, 2)
  assert.deepEqual(receipt.sourceOnlyVendorTop, { 'partial-json': '0.1.7' })
  execFileSync(process.execPath, [
    'scripts/source-build/restore-effective-engine-overlay.mjs',
    data.originalPath, data.effectivePath, data.policyPath, data.targetPath, data.reportPath,
  ])
  assert.deepEqual(JSON.parse(readFileSync(data.targetPath, 'utf8')), data.effective)
  const report = JSON.parse(readFileSync(data.reportPath, 'utf8'))
  assert.equal(report.effectiveSha256, digest(data.effectiveBytes))
  assert.equal(report.sourceBuildPolicySha256, digest(readFileSync(data.policyPath)))
})

test('source-only pin must be hash-bound to the original overlay', t => {
  const data = fixture(t)
  data.policy.sourceOnlyVendorTop.baseOverlaySha256 = '0'.repeat(64)
  writeFileSync(data.policyPath, JSON.stringify(data.policy, null, 2) + '\n')
  assert.throws(() => validateEffectiveOverlay(data.originalPath, data.effectivePath, data.policyPath), /not bound to the checked-in overlay bytes/)
})

test('effective vendor pin drift is rejected', t => {
  const data = fixture(t)
  const tampered = { ...data.effective, vendorTop: { ...data.effective.vendorTop, 'partial-json': '9.9.9' } }
  writeFileSync(data.effectivePath, JSON.stringify(tampered, null, 2) + '\n')
  assert.throws(() => validateEffectiveOverlay(data.originalPath, data.effectivePath, data.policyPath), /effective vendorTop differs/)
})

test('package omission receipt must agree with actual source injection', t => {
  const data = fixture(t)
  data.policy.firstPartySourceInjection.packages[0].version = '0.2.0'
  writeFileSync(data.policyPath, JSON.stringify(data.policy, null, 2) + '\n')
  assert.throws(() => validateEffectiveOverlay(data.originalPath, data.effectivePath, data.policyPath), /omission list differs from the injected package receipt/)
})

test('symlinked effective overlay is rejected', t => {
  const data = fixture(t)
  const realPath = join(data.root, 'real-effective.json')
  writeFileSync(realPath, data.effectiveBytes)
  rmSync(data.effectivePath)
  symlinkSync(realPath, data.effectivePath)
  assert.throws(() => validateEffectiveOverlay(data.originalPath, data.effectivePath, data.policyPath), /regular non-symlink file/)
})

test('symlinked receipt output is rejected before replacing the snapshot overlay', t => {
  const data = fixture(t)
  const sinkPath = join(data.root, 'sink.json')
  mkdirSync(join(data.root, 'snapshot-config'))
  writeFileSync(data.targetPath, 'existing target\n')
  writeFileSync(sinkPath, 'receipt sink\n')
  symlinkSync(sinkPath, data.reportPath)
  assert.throws(() => execFileSync(process.execPath, [
    'scripts/source-build/restore-effective-engine-overlay.mjs',
    data.originalPath, data.effectivePath, data.policyPath, data.targetPath, data.reportPath,
  ], { stdio: 'ignore' }))
  assert.equal(readFileSync(data.targetPath, 'utf8'), 'existing target\n')
  assert.equal(readFileSync(sinkPath, 'utf8'), 'receipt sink\n')
})
