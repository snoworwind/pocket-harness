import test from 'node:test'
import assert from 'node:assert/strict'
import { compareDebVersion } from './deb-version.mjs'

test('orders by epoch before anything else', () => {
  assert.ok(compareDebVersion('1:1.0', '2.0') > 0)
  assert.ok(compareDebVersion('1.0', '1:1.0') < 0)
  assert.equal(compareDebVersion('0:1.0', '1.0'), 0)
})

test('compares the upstream version numerically and by Debian character order', () => {
  assert.ok(compareDebVersion('79.1', '78.3') > 0)
  assert.ok(compareDebVersion('1.10', '1.9') > 0)
  assert.ok(compareDebVersion('1.0~rc1', '1.0') < 0)
  assert.ok(compareDebVersion('1.0~rc1', '1.0~rc2') < 0)
  assert.ok(compareDebVersion('1.0a', '1.0') > 0)
  assert.ok(compareDebVersion('1.0a', '1.0+') < 0)
  assert.equal(compareDebVersion('1.0', '1.0'), 0)
})

test('compares the revision and ignores leading zeros', () => {
  assert.ok(compareDebVersion('1.0-2', '1.0-1') > 0)
  assert.ok(compareDebVersion('1.0', '1.0-1') < 0)
  assert.equal(compareDebVersion('1.007', '1.7'), 0)
})
