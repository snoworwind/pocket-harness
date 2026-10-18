import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareSigning, verifySigningIdentity } from './prepare-signing.mjs'

test('missing private key cannot silently fall back to repository debug signing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-signing-'))
  try {
    assert.throws(() => prepareSigning(root, { POCKET_SIGNING_KEYSTORE_PATH: join(root, 'absent.keystore') }), /private signing key is missing/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the historical public key is rejected as the independent release identity', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => verifySigningIdentity(resolve('keystore/debug.keystore')), /not the Pocket Harness/)
})
