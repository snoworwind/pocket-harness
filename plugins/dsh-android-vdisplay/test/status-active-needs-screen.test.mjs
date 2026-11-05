// Status must reconcile the reported state with the current screen inventory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotFromRaw } from '../lib/status.js'

const real = { alias: 'real', displayId: 0, kind: 'physical', label: 'real', state: 'on', width: 1080, height: 2400, densityDpi: 440, selectable: false, reason: '' }
const virtual = { alias: 'virtual-1', displayId: 25, kind: 'virtual', label: 'virtual-1', state: 'on', width: 800, height: 600, densityDpi: 160, selectable: true, reason: '' }

test('active and ready with an empty screen inventory are unavailable', () => {
  for (const state of ['active', 'ready']) {
    const result = snapshotFromRaw({ enabled: true, state, screens: [] })
    assert.equal(result.ok, false, state)
    assert.equal(result.code, 'vdisplay-no-screens')
  }
})

test('active displayId must identify an app-owned virtual screen', () => {
  for (const displayId of [7, 0]) {
    const result = snapshotFromRaw({ enabled: true, state: 'active', displayId, screens: [real, virtual] })
    assert.equal(result.ok, false, String(displayId))
    assert.equal(result.code, 'vdisplay-display-missing')
  }
})

test('active without displayId is unavailable even when a virtual screen exists', () => {
  const result = snapshotFromRaw({ enabled: true, state: 'active', screens: [real, virtual] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'vdisplay-display-missing')
})

test('active with a registered virtual display remains available', () => {
  const result = snapshotFromRaw({ enabled: true, state: 'active', displayId: 25, screens: [real, virtual] })
  assert.equal(result.ok, true)
  assert.equal(result.displayId, 25)
})

test('ready with the current display inventory remains available', () => {
  const result = snapshotFromRaw({ enabled: true, state: 'ready', screens: [real] })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'ready')
})

test('blocked and disabled states retain their existing fail-closed behavior', () => {
  assert.equal(snapshotFromRaw({ enabled: true, state: 'blocked', screens: [] }).ok, false)
  assert.equal(snapshotFromRaw({ enabled: false, state: 'disabled', screens: [] }).ok, false)
})
