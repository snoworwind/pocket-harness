import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { checkLinuxCi } from './check-linux-ci.mjs'
const source = readFileSync(new URL('../../.github/workflows/build-apk-source.yml', import.meta.url), 'utf8')
test('Linux inventory follows final APK bytes and survives verifier artifact boundary', () => checkLinuxCi(source))
test('controlled negatives reject lost payload verification or inventory propagation', () => {
  for (const bad of [source.replace('verify-linux-payload.py --apk-dir out', 'true'), source.replace('            .deploy-tmp/source-build/linux-payload-identity.json\n', '')]) {
    assert.throws(() => checkLinuxCi(bad))
  }
})
test('Linux inventory executes digest, missing payload, legacy snapshot and ABI controls', () => {
  const result = spawnSync('python3', [new URL('./verify-linux-payload.py', import.meta.url).pathname, '--self-test'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
