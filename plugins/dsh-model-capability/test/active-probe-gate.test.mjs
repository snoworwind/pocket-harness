import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runConfirmedActiveProbe } from '../lib/index.js'

function report() {
  return { route: 'custom', fetched: [], models: [], unknown: ['m'], notes: [] }
}

function provider(overrides = {}) {
  return { route: 'custom', api: 'openai-responses', baseURL: 'https://gw.example/v1', models: ['m'], ...overrides }
}

test('active request requires both active and confirm; offline mode also blocks it', async () => {
  for (const options of [
    { active: true },
    { confirm: true },
    { active: true, confirm: true, offline: true },
    { active: true, confirm: true, source: 'catalog' },
  ]) {
    let calls = 0
    const result = report()
    await runConfirmedActiveProbe(provider(), result, {
      ...options,
      fetchImpl: async () => { calls++; throw new Error('must not request') },
    })
    assert.equal(calls, 0)
    assert.equal(result.models.length, 0)
  }
})

test('Completions without an explicit known serializer does not send a request', async () => {
  let calls = 0
  const result = report()
  await runConfirmedActiveProbe(provider({ api: 'openai-completions' }), result, {
    active: true, confirm: true,
    fetchImpl: async () => { calls++; throw new Error('must not request') },
  })
  assert.equal(calls, 0)
  assert.equal(result.models.length, 0)
  assert.match(result.notes.join('\n'), /没有已验证的主动请求序列化|缺少明确的 thinkingFormat=openai/)
})

test('known OpenAI Completions serializer uses chat/completions and requires a validating negative control', async () => {
  const result = report()
  const calls = []
  await runConfirmedActiveProbe(provider({
    api: 'openai-completions',
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
  }), result, {
    active: true, confirm: true, levels: ['low'],
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body })
      if (body.reasoning_effort === '__dsh_invalid_effort__') {
        return { ok: false, status: 400, text: async () => 'unsupported reasoning_effort value' }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    },
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(({ url }) => url.endsWith('/chat/completions')))
  assert.deepEqual(calls.map(({ body }) => body.reasoning_effort), ['__dsh_invalid_effort__', 'low'])
  assert.deepEqual(result.models[0].reasoningEfforts, { low: 'low' })
  assert.equal(result.models[0].sources.reasoningEfforts, 'active-probe')
  assert.deepEqual(result.unknown, [])
})

test('Completions with unknown serializer and MiMo toggle never send effort probes', async () => {
  for (const compat of [
    { thinkingFormat: 'qwen', supportsReasoningEffort: true },
    { thinkingFormat: 'mimo', supportsReasoningEffort: true },
    { supportsReasoningEffort: true },
  ]) {
    let calls = 0
    const result = report()
    await runConfirmedActiveProbe(provider({ api: 'openai-completions', compat }), result, {
      active: true, confirm: true,
      fetchImpl: async () => { calls++; throw new Error('must not request') },
    })
    assert.equal(calls, 0)
    assert.equal(result.models.length, 0)
    assert.deepEqual(result.unknown, ['m'])
  }
})

test('declared reasoningEfforts are never overwritten by active probing', async () => {
  let calls = 0
  const result = report()
  await runConfirmedActiveProbe(provider({
    modelProfiles: { m: { reasoningEfforts: { high: 'high' } } },
  }), result, {
    active: true, confirm: true,
    fetchImpl: async () => { calls++; throw new Error('must not request') },
  })
  assert.equal(calls, 0)
  assert.equal(result.models.length, 0)
})

test('active-probe source is written only after a rejecting negative control and accepted candidate', async () => {
  const result = report()
  const calls = []
  await runConfirmedActiveProbe(provider(), result, {
    active: true,
    confirm: true,
    levels: ['low'],
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body })
      if (body.reasoning.effort === '__dsh_invalid_effort__') {
        return { ok: false, status: 422, text: async () => 'invalid reasoning effort' }
      }
      return { ok: true, status: 200, text: async () => '{"id":"response"}' }
    },
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(({ url }) => url.endsWith('/responses')))
  assert.deepEqual(calls.map(({ body }) => body.reasoning.effort), ['__dsh_invalid_effort__', 'low'])
  assert.deepEqual(result.models[0].reasoningEfforts, { low: 'low' })
  assert.equal(result.models[0].sources.reasoningEfforts, 'active-probe')
  assert.deepEqual(result.unknown, [])
})

test('accepting the negative control never writes active-probe capability', async () => {
  const result = report()
  await runConfirmedActiveProbe(provider(), result, {
    active: true,
    confirm: true,
    levels: ['low'],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  })
  assert.equal(result.models.length, 0)
  assert.match(result.notes.join('\n'), /负控未能证明/)
})
