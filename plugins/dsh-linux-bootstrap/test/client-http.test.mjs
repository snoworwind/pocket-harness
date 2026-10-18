import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Stub only host React; execute the actual browser entry with no engine services.
const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  .replace(/import React[^\n]+/, 'const React = { createElement() {} }; const useEffect = () => {}; const useState = () => {}')
  .replace(/import \{ EXPERIMENTAL_NOTICE[^\n]+/, '')
const { apply, inject, createHttpBootstrap } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

test('browser activates without engine Cordis service', () => {
  assert.deepEqual(inject, ['slots'])
  let registered = false
  apply({ slots: { inject: (_slot, register) => register(), register: () => { registered = true } } })
  assert.equal(registered, true)
})
test('HTTP adapter preserves confirmation and authenticated status', async () => {
  const calls = []
  const service = createHttpBootstrap(async (url, init) => {
    calls.push({ url, ...init })
    return { ok: true, json: async () => ({ installed: true, availableVersion: '2', plugins: { bootstrap: { releaseUrl: 'https://github.com/example/release' } } }) }
  })
  assert.equal((await service.status()).updateAvailable, true)
  await service.install({ confirmed: true, activate: true, runtimeId: 'debian-minimal' })
  await service.setAutoUpdateEnabled(false)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].credentials, 'same-origin')
  assert.equal(JSON.parse(calls[1].body).confirmed, true)
  assert.equal(calls[2].url.endsWith('/auto-update-off'), true)
  const denied = createHttpBootstrap(async () => ({ ok: false, status: 503, json: async () => ({ error: 'bootstrap unavailable' }) }))
  await assert.rejects(denied.status(), /bootstrap unavailable/)
})
