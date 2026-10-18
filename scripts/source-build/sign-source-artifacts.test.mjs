import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalApks } from './sign-source-artifacts.mjs'

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
