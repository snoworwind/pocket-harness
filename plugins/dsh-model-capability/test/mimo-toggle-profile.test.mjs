import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMimoThinkingProfile, MIMO_THINKING_PROFILES } from '../lib/index.js'

function report(models = [], unknown = ['m']) {
  return { route: 'custom', fetched: [], models, unknown, notes: [] }
}

test('versioned official profile is exact-id and OpenAI Completions only', () => {
  assert.deepEqual(MIMO_THINKING_PROFILES[0].modelIds, ['mimo-v2.5', 'mimo-v2.5-pro'])
  for (const api of ['openai-responses', 'anthropic-messages', undefined]) {
    const r = report()
    applyMimoThinkingProfile({ route: 'xiaomimimo', api, baseURL: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.5'] }, r)
    assert.deepEqual(r.models, [])
    assert.deepEqual(r.unknown, ['m'])
  }
  for (const id of ['mimo-v2.6-pro', 'xiaomi/mimo-v2.5', 'mimo2.5']) {
    const r = report([], [id])
    applyMimoThinkingProfile({ route: 'mimo', api: 'openai-completions', baseURL: 'https://api.xiaomimimo.com/v1', models: [id] }, r)
    assert.deepEqual(r.models, [], 'model names or URL-like aliases are not heuristics')
    assert.deepEqual(r.unknown, [id])
  }
})

test('official profile emits exactly off plus one canonical on value and protocol compat', () => {
  const r = report([], ['mimo-v2.5'])
  applyMimoThinkingProfile({
    route: 'unrelated-route-name', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['mimo-v2.5'],
  }, r)
  assert.deepEqual(r.models[0].reasoningEfforts, { off: 'off', low: 'low' })
  assert.deepEqual(r.models[0].compat, {
    thinkingFormat: 'mimo',
    supportsReasoningEffort: false,
    requiresReasoningContentOnAssistantMessages: true,
  })
  assert.equal(r.models[0].sources.reasoningEfforts, 'protocol-profile')
  assert.deepEqual(r.unknown, [])
})

test('official protocol profile narrows passive multi-level claims to the real binary switch', () => {
  const r = report([{
    id: 'mimo-v2.5',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
    sources: { reasoningEfforts: 'engine-catalog' },
  }], [])
  applyMimoThinkingProfile({
    route: 'route', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['mimo-v2.5'],
  }, r)
  assert.deepEqual(r.models[0].reasoningEfforts, { off: 'off', low: 'low' })
  assert.equal(r.models[0].compat.thinkingFormat, 'mimo')
  assert.equal(r.models[0].sources.reasoningEfforts, 'protocol-profile')
})

test('an explicit mimo compat is a supported profile for an otherwise unknown model id', () => {
  const r = report([], ['private-model'])
  applyMimoThinkingProfile({
    route: 'route', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['private-model'],
    compat: { thinkingFormat: 'mimo' },
  }, r)
  assert.deepEqual(r.models[0].reasoningEfforts, { off: 'off', low: 'low' })
  assert.deepEqual(r.models[0].compat, {
    thinkingFormat: 'mimo', requiresReasoningContentOnAssistantMessages: true, supportsReasoningEffort: false,
  })
  assert.deepEqual(r.unknown, [])
})

test('explicit user effort and compat values are retained exactly', () => {
  const declared = { high: 'user-high', max: 'user-max' }
  const userCompat = { thinkingFormat: 'mimo', supportsReasoningEffort: true, maxTokensField: 'max_tokens' }
  const r = report([{ id: 'mimo-v2.5', reasoningEfforts: declared, compat: userCompat, sources: { reasoningEfforts: 'user-fallback' } }], [])
  applyMimoThinkingProfile({
    route: 'route', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['mimo-v2.5'],
    modelProfiles: { 'mimo-v2.5': { reasoningEfforts: declared, compat: userCompat } },
  }, r)
  assert.deepEqual(r.models[0].reasoningEfforts, declared)
  assert.deepEqual(r.models[0].compat, { ...userCompat, requiresReasoningContentOnAssistantMessages: true })
})

test('legacy user high map stays unchanged while official MiMo mode supplies binary compat', () => {
  const declared = { high: 'high' }
  const r = report([{
    id: 'mimo-v2.5', reasoningEfforts: declared, sources: { reasoningEfforts: 'endpoint-descriptor' },
  }], [])
  applyMimoThinkingProfile({
    route: 'xiaomimimo', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['mimo-v2.5'],
    modelProfiles: { 'mimo-v2.5': { reasoningEfforts: declared } },
  }, r)
  assert.deepEqual(r.models[0].reasoningEfforts, { high: 'high' })
  assert.equal(r.models[0].sources.reasoningEfforts, 'user-fallback')
  assert.deepEqual(r.models[0].compat, {
    thinkingFormat: 'mimo', supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true,
  })
})

test('a user compat dialect override that conflicts with the official profile is not replaced', () => {
  const userCompat = { thinkingFormat: 'qwen', supportsReasoningEffort: true }
  const r = report([], ['mimo-v2.5'])
  applyMimoThinkingProfile({
    route: 'route', api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: ['mimo-v2.5'],
    modelProfiles: { 'mimo-v2.5': { compat: userCompat } },
  }, r)
  assert.deepEqual(r.models, [])
  assert.deepEqual(r.unknown, ['mimo-v2.5'])
})
