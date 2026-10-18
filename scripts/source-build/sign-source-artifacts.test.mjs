import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
    const apk = join(out, 'pocket-harness-v0.14.7-source-arm64.apk')
    writeFileSync(apk, 'candidate')
    assert.deepEqual(finalApks(root), [apk])
    const extra = join(out, 'unexpected.apk')
    writeFileSync(extra, 'extra')
    assert.throws(() => finalApks(root), /exactly one/)
    rmSync(extra)
    rmSync(apk)
    writeFileSync(join(out, 'pocket-harness-v0.14.7-source-x86_64.apk'), 'wrong ABI')
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

test('actual final signer binds new bytes and refuses a wrong certificate before replacing input', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-sign-cli-'))
  const apk = join(root, 'out/pocket-harness-v1-source-arm64.apk')
  const reports = join(root, '.deploy-tmp/source-build')
  const expected = 'ab'.repeat(32)
  mkdirSync(join(root, 'out')); mkdirSync(reports, { recursive: true }); mkdirSync(join(root, 'keystore'))
  writeFileSync(join(root, 'keystore/pocket-harness-cert-sha256.txt'), expected)
  const signer = join(root, 'signer')
  writeFileSync(signer, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='sign'){if(a[a.indexOf('--ks-pass')+1]!=='env:POCKET_SIGNING_KEYSTORE_PASSWORD')process.exit(9);fs.writeFileSync(a[a.indexOf('--out')+1],'signed candidate')}else{for(const n of [1,2,3])console.log('Verified using v'+n+' scheme (test): true');console.log('Signer #1 certificate SHA-256 digest: '+process.env.TEST_CERT)}\n`)
  chmodSync(signer, 0o755)
  try {
    for (const certificate of ['cd'.repeat(32), expected]) {
      writeFileSync(apk, 'candidate')
      const proof = { independentRebuildMatched: true, normalizationVersion: 3, sourceCommit: 'a'.repeat(40), primaryUnsignedApkSha256: createHash('sha256').update('candidate').digest('hex') }
      writeFileSync(join(reports, 'independent-rebuild-verification.json'), JSON.stringify(proof))
      const result = spawnSync(process.execPath, [new URL('./sign-source-artifacts.mjs', import.meta.url).pathname], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'a'.repeat(40), POCKET_SIGNING_KEYSTORE_BASE64: Buffer.from('test key, not production').toString('base64'), POCKET_SIGNING_KEYSTORE_PASSWORD: 'test-only', APKSIGNER: signer, TEST_CERT: certificate } })
      assert.equal(result.status, certificate === expected ? 0 : 1, result.stderr)
      assert.equal(readFileSync(apk, 'utf8'), certificate === expected ? 'signed candidate' : 'candidate')
      if (certificate === expected) {
        const signed = JSON.parse(readFileSync(join(reports, 'independent-rebuild-verification.json')))
        assert.equal(signed.signedApkSha256, createHash('sha256').update('signed candidate').digest('hex'))
        assert.match(readFileSync(join(reports, 'apk-sha256.txt'), 'utf8'), new RegExp(signed.signedApkSha256))
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
