// Capability probe regression (2026-09-08): the discovery pipeline must report only
// what the configured endpoint explicitly states — never a URL or model-name guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  THINKING_LEVELS,
  effortsFrom,
  parseDescriptor,
  parseOllamaShow,
  probePassive,
  probeResponsesReasoningEfforts,
  probeReasoningEfforts,
} from '../lib/capability-probe.js'
import { providerFromSettings } from '../lib/settings-config.js'

test('Gemini credentials use a header and never appear in the passive report', async () => {
  let seen
  const report = await probePassive({ route: 'gemini', api: 'google-generative-ai', baseURL: 'https://example.test/v1', apiKey: 'secret-gemini-key' }, {
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return jsonResponse({ models: [] })
    },
  })
  assert.equal(seen.url, 'https://example.test/v1/models')
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret-gemini-key')
  assert.equal(JSON.stringify(report).includes('secret-gemini-key'), false)
})

test('all probe diagnostics redact URL and header secrets while retaining useful errors', async () => {
  const secrets = ['url-user-secret', 'url-password-secret', 'query-secret /+', 'header-secret /+', 'bearer-secret /+']
  const baseURL = `https://${secrets[0]}:${secrets[1]}@example.test/v1?key=${encodeURIComponent(secrets[2])}`
  const headers = { 'x-api-key': secrets[3], authorization: `Bearer ${secrets[4]}` }
  const echoed = `invalid model: ${baseURL} ${secrets.join(' ')} ${secrets.map(encodeURIComponent).join(' ')}`
  const assertSafe = (value) => {
    const text = JSON.stringify(value)
    for (const secret of secrets.flatMap((value) => [value, encodeURIComponent(value)])) assert.equal(text.includes(secret), false, secret)
    assert.ok(text.includes('invalid model'))
  }
  const passiveError = await probePassive({ route: 'test', baseURL, headers }, { fetchImpl: async () => { throw new Error(echoed) } })
  assertSafe(passiveError)
  const passiveSuccess = await probePassive({ route: 'test', baseURL, headers }, { fetchImpl: async () => jsonResponse({ data: [{ id: 'example-model' }] }) })
  for (const secret of secrets) assert.equal(JSON.stringify(passiveSuccess).includes(secret), false)
  for (const negativeControlBody of [undefined, {}]) {
    for (const throws of [true, false]) {
      const result = await probeReasoningEfforts({ url: baseURL, headers, levels: ['low'], body: () => ({}), negativeControlBody,
        fetchImpl: async () => { if (throws) throw new Error(echoed); return { ok: false, status: 400, text: async () => echoed } },
      })
      assertSafe(result)
    }
  }
})

test('malformed Unicode credentials cannot crash diagnostic redaction', async () => {
  const secret = 'malformed-\ud800-secret'
  const headers = { 'x-api-key': secret }
  const fetchImpl = async () => { throw new Error(`invalid model: ${secret}`) }
  const passive = await probePassive({ route: 'test', baseURL: 'https://example.test', headers }, { fetchImpl })
  assert.ok(passive.notes.some((note) => note.includes('invalid model: [redacted]')))
  assert.equal(JSON.stringify(passive).includes('malformed-'), false)
  for (const negativeControlBody of [undefined, {}]) {
    const active = await probeReasoningEfforts({ url: 'https://example.test/responses', headers, levels: ['low'], body: () => ({}), negativeControlBody, fetchImpl })
    assert.equal(JSON.stringify(active).includes('malformed-'), false)
    assert.ok(JSON.stringify(active).includes('invalid model: [redacted]'))
  }
})

test('real fetch refuses redirect credential forwarding in passive and active probes', async (t) => {
  const received = []
  const listen = async (handler) => {
    const server = createServer(handler)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
    return `http://127.0.0.1:${server.address().port}`
  }
  const target = await listen((req, res) => {
    received.push(req.headers)
    res.end(JSON.stringify({ data: [] }))
  })
  let destination = target + '/sink'
  let successful = false
  const origin = await listen((req, res) => {
    if (successful) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [] })); return }
    res.writeHead(307, { location: destination }); res.end()
  })
  for (const sameOrigin of [false, true]) {
    destination = sameOrigin ? origin + '/sink' : target + '/sink'
    for (const config of [
      { api: 'anthropic-messages', apiKey: 'anthropic-secret' },
      { api: 'google-generative-ai', apiKey: 'gemini-secret' },
      { api: 'openai-completions', apiKey: 'bearer-secret', headers: { 'x-tenant-key': 'tenant-secret' } },
      {},
    ]) {
      const report = await probePassive({ route: 'test', baseURL: origin, ...config })
      assert.equal(report.fetched.length, 0)
      assert.ok(report.notes.some((note) => note.includes('failed')))
    }
    const headers = { 'x-api-key': 'active-secret', 'x-tenant-key': 'tenant-secret' }
    for (const negativeControlBody of [undefined, { invalid: true }]) {
      const result = await probeReasoningEfforts({ url: origin + '/responses', headers, levels: ['low'], body: () => ({}), negativeControlBody })
      assert.deepEqual(result.accepted, [])
      assert.equal(result.inconclusive.length, 1)
    }
    assert.deepEqual(received, [])
  }
  successful = true
  const normal = await probePassive({ route: 'test', baseURL: origin })
  assert.equal(normal.fetched.length, 1)
  assert.equal(normal.notes.some((note) => note.includes('failed')), false)
})

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}

test('generic OpenAI /models yields ids only and states why', () => {
  const parsed = parseDescriptor({ object: 'list', data: [{ id: 'my-model-a' }, { id: 'my-model-b' }] }, 'https://gw.example/v1/models')
  assert.deepEqual(parsed.models.map((m) => m.id), ['my-model-a', 'my-model-b'])
  for (const model of parsed.models) {
    assert.equal(model.input, undefined)
    assert.equal(model.reasoningEfforts, undefined)
  }
  assert.ok(parsed.notes.some((note) => note.includes('model ids only')))
})

test('OpenRouter descriptor reads declared modalities but never invents effort levels', () => {
  const parsed = parseDescriptor({
    data: [{
      id: 'vendor/model-x',
      architecture: { input_modalities: ['text', 'image', 'video'] },
      supported_parameters: ['temperature', 'reasoning'],
      context_length: 200000,
    }],
  }, 'https://openrouter.ai/api/v1/models')
  const model = parsed.models[0]
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.contextWindow, 200000)
  assert.equal(model.reasoningEfforts, undefined)
  assert.ok(parsed.notes.some((note) => note.includes('levels stay unknown')))
})

test('explicit reasoning_efforts maps only the engine vocabulary', () => {
  const parsed = parseDescriptor({
    data: [{ id: 'vendor/model-y', reasoning_efforts: ['low', 'medium', 'high', 'turbo'] }],
  }, 'https://gw.example/v1/models')
  assert.deepEqual(parsed.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' })
  assert.ok(parsed.notes.some((note) => note.includes('turbo')))
  const { efforts, dropped } = effortsFrom(['HIGH', 'max', 'none'])
  assert.deepEqual(efforts, { high: 'high', max: 'max' })
  assert.deepEqual(dropped, ['none'])
})

test('Google descriptor strips the models/ prefix and reads declared limits', () => {
  const parsed = parseDescriptor({
    models: [{ name: 'models/gemini-x', inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }],
  }, 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.deepEqual(parsed.models, [{ id: 'gemini-x', contextWindow: 1048576, maxTokens: 8192 }])
})

test('Ollama tags give ids and /api/show gives explicit capabilities', () => {
  const tags = parseDescriptor({ models: [{ name: 'qwen3:8b', size: 5 }] }, 'http://127.0.0.1:11434/api/tags')
  assert.deepEqual(tags.models, [{ id: 'qwen3:8b' }])
  const show = parseOllamaShow({ model: 'qwen3:8b', capabilities: ['completion', 'vision', 'thinking'], model_info: { 'llm.context_length': 40960 } })
  assert.deepEqual(show.models[0].input, ['image'])
  assert.equal(show.models[0].contextWindow, 40960)
  assert.ok(show.notes.some((note) => note.includes('effort vocabulary')))
})

test('passive probe fetches only the configured endpoint and reports unknowns', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    return jsonResponse({ data: [{ id: 'known-model', context_length: 8192 }] })
  }
  const report = await probePassive({
    route: 'my-gateway',
    api: 'openai-completions',
    baseURL: 'https://gw.example/v1/',
    apiKey: 'secret-key',
    models: ['known-model', 'declared-but-absent'],
  }, { fetchImpl })

  assert.deepEqual(calls.map((c) => c.url), ['https://gw.example/v1/models'])
  assert.equal(calls[0].headers.authorization, 'Bearer secret-key')
  assert.equal(report.fetched.length, 1)
  assert.deepEqual(report.models.map((m) => m.id), ['known-model'])
  assert.equal(report.models[0].contextWindow, 8192)
  assert.equal(report.models[0].sources.contextWindow, 'endpoint-descriptor')
  assert.deepEqual(report.unknown, ['declared-but-absent'])
})

test('passive reasoning descriptors require a known serializer and distinct Responses evidence', async () => {
  const payload = { data: [{ id: 'm', reasoning_efforts: ['low', 'medium', 'high'] }] }
  const fetchImpl = async () => jsonResponse(payload)
  const response = await probePassive({ route: 'r', api: 'openai-responses', baseURL: 'https://gw/v1', models: ['m'] }, { fetchImpl })
  assert.equal(response.models[0].reasoningEfforts, undefined, 'multi-level descriptor is not proof of distinct Responses semantics')
  assert.ok(response.notes.some((note) => note.includes('保持未知')))

  const completions = await probePassive({
    route: 'r', api: 'openai-completions', baseURL: 'https://gw/v1', models: ['m'],
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
  }, { fetchImpl })
  assert.deepEqual(completions.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' })

  const unconfigured = await probePassive({ route: 'r', baseURL: 'https://gw/v1', models: ['m'] }, { fetchImpl })
  assert.equal(unconfigured.models[0].reasoningEfforts, undefined, 'unknown route protocol cannot select a serializer')
})

test('anthropic-shaped routes authenticate with x-api-key', async () => {
  let seen = {}
  const fetchImpl = async (url, init) => {
    seen = init?.headers ?? {}
    return jsonResponse({ data: [{ id: 'claude-x' }] })
  }
  await probePassive({ route: 'claude', api: 'anthropic-messages', baseURL: 'https://api.example', apiKey: 'k' }, { fetchImpl })
  assert.equal(seen['x-api-key'], 'k')
  assert.equal(seen.authorization, undefined)
})

test('active probe classifies acceptance, rejection and uncertainty', async () => {
  const fetchImpl = async (_url, init) => {
    const level = JSON.parse(init.body).reasoning_effort
    if (level === 'low') return jsonResponse({ ok: true })
    if (level === 'medium') return { ok: false, status: 400, text: async () => 'unsupported reasoning_effort' }
    return { ok: false, status: 500, text: async () => 'upstream exploded' }
  }
  const result = await probeReasoningEfforts({
    url: 'https://gw.example/v1/chat/completions',
    headers: { authorization: 'Bearer k' },
    levels: ['low', 'medium', 'high'],
    fetchImpl,
    body: (level) => ({ model: 'm', messages: [], max_tokens: 1, reasoning_effort: level }),
  })
  assert.deepEqual(result.accepted, ['low'])
  assert.deepEqual(result.rejected, [{ level: 'medium', status: 400 }])
  assert.equal(result.inconclusive.length, 1)
  assert.equal(result.inconclusive[0].level, 'high')
  assert.deepEqual(result.efforts, { low: 'low' })
})

test('Responses active probe uses /responses reasoning.effort and requires an effective negative control', async () => {
  const calls = []
  const result = await probeResponsesReasoningEfforts({
    route: 'responses', api: 'openai-responses', baseURL: 'https://gw.example/v1', apiKey: 'k', models: ['m'],
  }, 'm', ['low', 'medium'], {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      if (body.reasoning.effort === '__dsh_invalid_effort__') {
        return { ok: false, status: 400, text: async () => 'invalid reasoning effort' }
      }
      return jsonResponse({ id: 'resp_1' })
    },
  })
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.url === 'https://gw.example/v1/responses'))
  assert.ok(calls.every((call) => call.init.method === 'POST'))
  assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer k'))
  assert.deepEqual(calls[0].body.reasoning, { effort: '__dsh_invalid_effort__' })
  assert.deepEqual(calls[1].body.reasoning, { effort: 'low' })
  assert.equal(calls[1].body.model, 'm')
  assert.equal(result.negativeControl.accepted, false)
  assert.deepEqual(result.accepted, ['low', 'medium'])
  assert.deepEqual(result.efforts, { low: 'low', medium: 'medium' })

  let candidateRequests = 0
  const ineffective = await probeResponsesReasoningEfforts({
    route: 'responses', api: 'openai-responses', baseURL: 'https://gw.example/v1', models: ['m'],
  }, 'm', ['low'], {
    fetchImpl: async () => { candidateRequests++; return jsonResponse({ id: 'ignored-control' }) },
  })
  assert.equal(candidateRequests, 1, 'only the negative control is sent when it is accepted')
  assert.deepEqual(ineffective.accepted, [])
  assert.equal(ineffective.inconclusive[0].level, 'low')
})

test('generic model errors cannot validate the reasoning.effort negative control or reject a candidate', async () => {
  let controlCalls = 0
  const falseControl = await probeResponsesReasoningEfforts({
    route: 'responses', api: 'openai-responses', baseURL: 'https://gw.example/v1', models: ['missing-model'],
  }, 'missing-model', ['low'], {
    fetchImpl: async () => {
      controlCalls++
      return { ok: false, status: 400, text: async () => 'invalid model' }
    },
  })
  assert.equal(controlCalls, 1, 'a generic control error must stop candidate probing')
  assert.deepEqual(falseControl.accepted, [])
  assert.equal(falseControl.negativeControl.reason, 'invalid model')

  let candidateCalls = 0
  const falseCandidate = await probeResponsesReasoningEfforts({
    route: 'responses', api: 'openai-responses', baseURL: 'https://gw.example/v1', models: ['m'],
  }, 'm', ['low'], {
    fetchImpl: async (_url, init) => {
      candidateCalls++
      const body = JSON.parse(init.body)
      if (body.reasoning.effort === '__dsh_invalid_effort__') {
        return { ok: false, status: 422, text: async () => 'unsupported reasoning effort' }
      }
      return { ok: false, status: 400, text: async () => 'invalid model' }
    },
  })
  assert.equal(candidateCalls, 2)
  assert.deepEqual(falseCandidate.rejected, [])
  assert.equal(falseCandidate.inconclusive[0].reason, 'invalid model')
})

test('active probe helper rejects unsupported wire dialects without requests', async () => {
  let calls = 0
  const result = await probeResponsesReasoningEfforts({
    route: 'mimo', api: 'openai-completions', baseURL: 'https://gw.example/v1', models: ['m'],
    compat: { thinkingFormat: 'mimo' },
  }, 'm', ['low', 'high'], { fetchImpl: async () => { calls++; return jsonResponse({}) } })
  assert.equal(calls, 0)
  assert.equal(result.inconclusive.length, 2)
  assert.match(result.inconclusive[0].reason, /only for the openai-responses/)
})

test('providerFromSettings maps declared models and never fabricates a route', () => {
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 7,
      value: {
        providers: {
          'my-gateway': {
            api: 'openai-completions',
            baseURL: 'https://gw.example/v1',
            compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
            apiKey: 'k',
            headers: { 'x-tenant': 't' },
            models: [{ id: 'a', compat: { thinkingFormat: 'deepseek' }, reasoningEfforts: false }, 'b'],
            modelOverrides: {
              a: { compat: { thinkingFormat: 'openai', supportsReasoningEffort: true } },
              b: { reasoningEfforts: { high: 'high' } },
              ignored: { compat: { thinkingFormat: 'openai' } },
            },
          },
          'no-base-url': { models: ['c'] },
        },
      },
    }],
  }
  const config = providerFromSettings(settings, 'my-gateway')
  assert.deepEqual(config, {
    route: 'my-gateway',
    api: 'openai-completions',
    compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
    baseURL: 'https://gw.example/v1',
    apiKey: 'k',
    headers: { 'x-tenant': 't' },
    models: ['a', 'b'],
    modelProfiles: {
      a: { compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true }, reasoningEfforts: false },
      b: { reasoningEfforts: { high: 'high' } },
    },
  })
  assert.equal(providerFromSettings(settings, 'no-base-url'), undefined)
  assert.equal(providerFromSettings(settings, 'unknown'), undefined)
  assert.equal(providerFromSettings(undefined, 'my-gateway'), undefined)
  assert.ok(THINKING_LEVELS.includes('medium'))
})

test('多命名空间时按 ns 查找 llm-pi-ai，而不是取第一个（0.13.5 实机踩坑回归）', () => {
  // describe(options) 的实现忽略 options，返回全部命名空间；若用 [0] 会拿到 llm-deepseek，
  // 自定义路由永远查不到 → 自动补全静默失效（2026-09-10 模拟器实测）。
  const settings = {
    describe: () => [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 3 },
      {
        ns: 'llm-pi-ai',
        value: { providers: { mhs: { api: 'openai-completions', baseURL: 'https://api.mhsapi.top/v1', apiKeyEnv: 'MHS_API_KEY', models: ['glm-5.3-flash'] } } },
        revision: 4,
      },
    ],
  }
  const config = providerFromSettings(settings, 'mhs')
  assert.deepEqual(config, {
    route: 'mhs',
    api: 'openai-completions',
    baseURL: 'https://api.mhsapi.top/v1',
    apiKey: undefined,
    apiKeyEnv: 'MHS_API_KEY',
    headers: undefined,
    models: ['glm-5.3-flash'],
    modelProfiles: {},
  })
})
