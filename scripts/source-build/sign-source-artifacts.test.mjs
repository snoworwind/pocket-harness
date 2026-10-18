import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalApks, verifyRebuildProof } from './sign-source-artifacts.mjs'
import { createHash } from 'node:crypto'

test('final signing accepts only one ARM64 source APK and rejects extra or wrong ABI inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-final-apks-'))
  const out = join(root, 'out')
  mkdirSync(out)
  try {
    assert.throws(() => finalApks(root), /exactly one/)
    const apk = join(out, 'dsh-mobile-apk-v0.14.7-source-arm64.apk')
    writeFileSync(apk, 'candidate')
    assert.deepEqual(finalApks(root), [apk])
    const extra = join(out, 'unexpected.apk')
    writeFileSync(extra, 'extra')
    assert.throws(() => finalApks(root), /exactly one/)
    rmSync(extra)
    rmSync(apk)
    writeFileSync(join(out, 'dsh-mobile-apk-v0.14.7-source-x86_64.apk'), 'wrong ABI')
    assert.throws(() => finalApks(root), /exactly one/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('signing refuses stale bytes, wrong commit and unverified claims before loading a key', () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-sign-proof-'))
  const report = join(root, '.deploy-tmp/source-build/independent-rebuild-verification.json')
  mkdirSync(join(root, '.deploy-tmp/source-build'), { recursive: true })
  const apk = join(root, 'candidate.apk')
  writeFileSync(apk, 'candidate')
  const proof = { independentRebuildMatched: true, normalizationVersion: 3, sourceCommit: 'a'.repeat(40),
    primaryUnsignedApkSha256: createHash('sha256').update('candidate').digest('hex') }
  try {
    writeFileSync(report, JSON.stringify(proof))
    assert.deepEqual(verifyRebuildProof(root, apk, 'a'.repeat(40)), proof)
    assert.throws(() => verifyRebuildProof(root, apk, 'b'.repeat(40)), /independent proof/)
    writeFileSync(apk, 'tampered')
    assert.throws(() => verifyRebuildProof(root, apk, 'a'.repeat(40)), /independent proof/)
    writeFileSync(apk, 'candidate')
    writeFileSync(report, JSON.stringify({ ...proof, independentRebuildMatched: false }))
    assert.throws(() => verifyRebuildProof(root, apk, 'a'.repeat(40)), /independent proof/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
