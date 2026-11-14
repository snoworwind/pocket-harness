import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describeInstallProgress } from '../src/status.js'
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

test('a duplicate install follows current status instead of displaying a 409 failure', async () => {
  const calls = []
  const service = createHttpBootstrap(async (url) => {
    calls.push(url)
    return url.endsWith('/install')
      ? { ok: false, status: 409, json: async () => ({ error: 'busy' }) }
      : { ok: true, json: async () => ({ busy: true, progress: { stage: 'extract', asset: 'debian-minimal-aarch64.tar.xz' } }) }
  })
  assert.equal((await service.install({})).progress.stage, 'extract')
  assert.equal(calls.length, 2)
})

test('progress describes asset, real byte counts, duration and bounded expectations', () => {
  const text = describeInstallProgress({ busy: true, progress: { stage: 'download', asset: 'node.tar.xz', receivedBytes: 1048576, totalBytes: 2097152, startedAt: new Date(Date.now() - 5000).toISOString() } })
  assert.match(text, /下载.*秒.*node.tar.xz.*1 \/ 2 MB.*数分钟/)
  assert.match(describeInstallProgress({ busy: true, progress: { stage: 'extract' } }), /解包/)
  assert.doesNotMatch(describeInstallProgress({ busy: true, progress: { stage: 'probe' } }), /%/)
  assert.equal(describeInstallProgress({ busy: false, progress: { stage: 'complete' } }), '')
  assert.match(describeInstallProgress({ busy: false, progress: { stage: 'failed', failedStage: 'probe' } }), /失败（健康检查）/)
})

test('leaving the panel cancels polling even when the first status request is still in flight', async () => {
  let finish
  let calls = 0
  const updates = []
  const service = createHttpBootstrap(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const stop = service.subscribe(value => updates.push(value))
  stop()
  finish({ ok: true, json: async () => ({ busy: true }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(updates.length, 0)
})
