// issue #134 回归：目录同名模型跨厂商方言不一致时，禁止写入 reasoningEfforts
// （pi-ai 会按探测默认方言序列化，真实网关可能直接 400），方言统一时连同 compat 一起写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, canApplyReasoningEfforts, mergeCatalog, patchesFrom, pickDialect } from '../lib/index.js'

const conflictSnapshot = {
  source: 'test',
  models: {
    'glm-5.3-flash': [
      {
        provider: 'opencode-go', api: 'openai-completions', reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
        compat: { maxTokensField: 'max_tokens' },
      },
      {
        provider: 'zai', api: 'openai-completions', reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
        compat: { thinkingFormat: 'zai', supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
      },
    ],
    'zai-only': [
      {
        provider: 'zai', api: 'openai-completions', reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high' },
        compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
      },
    ],
  },
}

function emptyReport(route) {
  return { route, fetched: [], models: [], unknown: [], notes: [] }
}

test('pickDialect requires a thinkingFormat and drops unrelated compat keys', () => {
  assert.equal(pickDialect(undefined), undefined)
  assert.equal(pickDialect({ maxTokensField: 'max_tokens' }), undefined)
  assert.deepEqual(
    pickDialect({ thinkingFormat: 'zai', supportsReasoningEffort: true, chatTemplateArgs: {} }),
    { thinkingFormat: 'zai', supportsReasoningEffort: true },
  )
})

test('mergeCatalog skips reasoningEfforts when the catalog dialect conflicts', () => {
  const merged = mergeCatalog(emptyReport('mhs'), ['glm-5.3-flash'], conflictSnapshot, 'openai-completions')
  const model = merged.models.find((m) => m.id === 'glm-5.3-flash')
  assert.equal(model.reasoningEfforts, undefined)
  assert.equal(model.compat, undefined)
  assert.ok(merged.notes.some((note) => note.includes('推理序列化信息不足')))
})

test('API-specific gate uses Responses without Completions thinkingFormat', () => {
  assert.equal(canApplyReasoningEfforts('openai-responses', undefined), true)
  assert.equal(canApplyReasoningEfforts('openai-completions', undefined), false)
  assert.equal(canApplyReasoningEfforts('openai-completions', { thinkingFormat: 'openai' }), false)
  assert.equal(canApplyReasoningEfforts('openai-completions', { thinkingFormat: 'openai', supportsReasoningEffort: true }), true)
  assert.equal(canApplyReasoningEfforts(undefined, { thinkingFormat: 'openai' }), false)
})

test('explicit route/model declarations gate and take precedence without being rewritten', () => {
  const snapshot = {
    models: {
      custom: [{ provider: 'catalog-a', api: 'openai-completions', reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high' }, compat: { thinkingFormat: 'zai' } }],
    },
  }
  const configured = {
    api: 'openai-completions',
    compat: { thinkingFormat: 'openai' },
    modelProfiles: { custom: { compat: { thinkingFormat: 'deepseek' }, reasoningEfforts: false } },
  }
  const merged = mergeCatalog(emptyReport('route'), ['custom'], snapshot, configured.api, configured)
  const model = merged.models[0]
  assert.equal(model.reasoningEfforts, undefined, 'an explicit false declaration must block discovery')
  assert.equal(model.compat, undefined, 'explicit model and route fields are not copied into write-back patches')
  assert.deepEqual(patchesFrom(merged), [])
})

test('Responses catalog maps do not require compat and duplicate wire values collapse', () => {
  const snapshot = { models: {
    response: [{ provider: 'catalog', api: 'openai-responses', reasoning: true,
      thinkingLevelMap: { low: 'medium', medium: 'medium', high: 'high' } }],
  } }
  const merged = mergeCatalog(emptyReport('route'), ['response'], snapshot, 'openai-responses')
  assert.deepEqual(merged.models[0].reasoningEfforts, { low: 'medium', high: 'high' })
  assert.equal(merged.models[0].compat, undefined)
})

test('unknown protocol and ambiguous catalog protocol preserve unknown reasoning', () => {
  const snapshot = { models: { custom: [
    { provider: 'a', api: 'openai-responses', reasoning: true, thinkingLevelMap: { high: 'high' } },
    { provider: 'b', api: 'openai-completions', reasoning: true, thinkingLevelMap: { high: 'high' }, compat: { thinkingFormat: 'openai' } },
  ] } }
  const merged = mergeCatalog(emptyReport('route'), ['custom'], snapshot)
  assert.equal(merged.models[0].reasoningEfforts, undefined)
  assert.ok(merged.notes.some((note) => note.includes('API=unknown')))
})

test('mergeCatalog writes the dialect beside efforts when the catalog is unanimous', () => {
  const merged = mergeCatalog(emptyReport('zai'), ['zai-only'], conflictSnapshot, 'openai-completions')
  const model = merged.models.find((m) => m.id === 'zai-only')
  assert.deepEqual(model.reasoningEfforts, { low: 'low', high: 'high' })
  assert.deepEqual(model.compat, { thinkingFormat: 'zai', supportsReasoningEffort: true })
  const patches = patchesFrom(merged)
  assert.deepEqual(patches[0].compat, { thinkingFormat: 'zai', supportsReasoningEffort: true })
  assert.deepEqual(patches[0].reasoningEfforts, { low: 'low', high: 'high' })
})

test('DSH compat merge fills only absent fields while explicit route compat wins field by field', () => {
  const snapshot = { models: {
    'new-model': [{ provider: 'catalog', api: 'openai-completions', reasoning: true,
      thinkingLevelMap: { high: 'high', max: 'max' },
      compat: { thinkingFormat: 'zai', supportsReasoningEffort: true } }],
  } }
  const configured = { api: 'openai-completions', compat: { supportsReasoningEffort: true } }
  const merged = mergeCatalog(emptyReport('route'), ['new-model'], snapshot, configured.api, configured)
  assert.deepEqual(merged.models[0].compat, { thinkingFormat: 'zai' })
  assert.deepEqual(merged.models[0].reasoningEfforts, { high: 'high', max: 'max' })
  assert.deepEqual(patchesFrom(merged)[0].compat, { thinkingFormat: 'zai' })
})

test('confirmed Responses active probe uses the Responses dialect after passive discovery', async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const parsed = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), method: init?.method ?? 'GET', effort: parsed?.reasoning?.effort })
    if (String(url).endsWith('/models')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'm' }] }) }
    }
    if (parsed?.reasoning?.effort === '__dsh_invalid_effort__') {
      return { ok: false, status: 400, text: async () => 'invalid reasoning effort' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'response' }) }
  }
  let dispose = () => {}
  const tools = []
  apply({
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      route: { api: 'openai-responses', baseURL: 'https://example.test/v1', models: ['m'] },
    } }, revision: 1 }] },
    logger: () => ({}),
    effect: (fn) => { dispose = fn() },
    get: () => undefined,
    // cordis：可选依赖声明（本用例的 ctx 没有 webServer 服务，回调不会跑）。
    inject: () => {},
    tools: { register: (tool) => tools.push(tool) },
  }, { autoApply: false, modelsDev: false })
  t.after(() => { dispose(); globalThis.fetch = originalFetch })
  const tool = tools.find((item) => item.name === 'model_capability_probe')
  const result = await tool.execute({ provider: 'route', source: 'endpoint', active: true, confirm: true })
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://example.test/v1/models',
    'https://example.test/v1/responses',
    'https://example.test/v1/responses',
    'https://example.test/v1/responses',
    'https://example.test/v1/responses',
  ])
  assert.deepEqual(calls.slice(1).map(({ effort }) => effort), [
    '__dsh_invalid_effort__', 'low', 'medium', 'high',
  ])
  assert.equal(result.report.models[0].sources.reasoningEfforts, 'active-probe')
})
