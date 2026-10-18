// models.dev 百科源（S3）单测 + 来源梯合流判据（E-P2-1..4）。
//
// E-P2-1 的形状断言用的是**真实抓取**后裁剪的夹具
// （test/fixtures/models-dev-sample.min.json），字段路径不是照抄任何实现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODELS_DEV_MAX_BYTES,
  MODELS_DEV_TTL_MS,
  buildModelsDevSnapshot,
  effortsFromLevels,
  isStale,
  lookupModelsDev,
  mergeModelsDev,
  mergeModelsDevInto,
  mergeFallbacks,
  mergeCatalog,
  modelsDevCachePath,
  parseModelsDev,
  readModelsDevSnapshot,
  thinkingLevelsFrom,
  writeModelsDevSnapshot,
  patchesFrom,
} from '../lib/index.js'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/models-dev-sample.min.json', import.meta.url), 'utf8'))

const emptyReport = (route, models = []) => ({ route, fetched: [], models: [], unknown: [...models], notes: [] })

// ── E-P2-1：真实响应的字段路径 ────────────────────────────────────────────────
test('E-P2-1 真实夹具：limit.context -> contextWindow（非 0）', () => {
  const entries = parseModelsDev(FIXTURE)
  assert.ok(entries.length >= 5, '夹具应解析出至少 5 条')
  const hy3 = entries.find((e) => e.id === 'tencent/Hy3' && e.provider === 'deepinfra')
  assert.ok(hy3, 'tencent/Hy3 应在 deepinfra 下')
  assert.equal(hy3.contextWindow, 262144)
  assert.equal(hy3.maxTokens, 128000)
  assert.deepEqual(hy3.input, ['text'])
})

test('E-P2-1 真实夹具：limit.output -> maxTokens 与 context 是两个不同字段', () => {
  const entries = parseModelsDev(FIXTURE)
  const qwen = entries.find((e) => e.id === 'Qwen/Qwen3.8-2.4T-A95B' && e.provider === 'deepinfra')
  assert.ok(qwen)
  assert.equal(qwen.contextWindow, 262144)
  assert.equal(qwen.maxTokens, 131072)
  assert.notEqual(qwen.contextWindow, qwen.maxTokens, '不能把 output 当成 context')
})

test('E-P2-1 真实夹具：modalities.input -> input（别名归一 + 顺序固定）', () => {
  const entries = parseModelsDev(FIXTURE)
  const withImage = entries.filter((e) => e.input && e.input.includes('image'))
  assert.ok(withImage.length > 0, '夹具应含至少一个多模态条目')
  for (const entry of entries) {
    if (!entry.input) continue
    assert.ok(entry.input.every((m) => ['text', 'image', 'audio', 'pdf'].includes(m)))
  }
})

test('E-P2-1 reasoning_options 只有 effort 变体带 values（四种形状实测）', () => {
  // toggle（无 values）不产生档位
  assert.equal(thinkingLevelsFrom([{ type: 'toggle' }]), undefined)
  // budget_tokens（min/max）不产生档位
  assert.equal(thinkingLevelsFrom([{ type: 'budget_tokens', min: 0, max: 31999 }]), undefined)
  assert.equal(thinkingLevelsFrom([{ type: 'budget_tokens', min: 1024 }]), undefined)
  // effort 变体才命名档位，且按引擎顺序输出
  assert.deepEqual(thinkingLevelsFrom([{ type: 'effort', values: ['xhigh', 'low', 'medium'] }]), ['low', 'medium', 'xhigh'])
  // 词表外的词被丢弃，不映射到未命名的等级
  assert.deepEqual(thinkingLevelsFrom([{ type: 'effort', values: ['low', 'nonexistent'] }]), ['low'])
})

test('E-P2-1 真实夹具：effort 变体解析出 thinkingLevels，toggle 条目没有', () => {
  const entries = parseModelsDev(FIXTURE)
  const qwen = entries.find((e) => e.id === 'Qwen/Qwen3.8-2.4T-A95B' && e.provider === 'deepinfra')
  assert.deepEqual(qwen.thinkingLevels, ['low', 'medium', 'xhigh'])
  const hy3 = entries.find((e) => e.id === 'tencent/Hy3')
  assert.equal(hy3.thinkingLevels, undefined, 'reasoning_options 为空时不得凭空给档位')
})

test('E-P2-1 只保留约定字段（其余 models.dev 字段全部丢弃）', () => {
  const entries = parseModelsDev(FIXTURE)
  const allowed = new Set(['id', 'name', 'provider', 'contextWindow', 'maxTokens', 'input', 'thinkingLevels'])
  for (const entry of entries) {
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), '不应保留字段 ' + key)
  }
})

// ── 三级查找 + 大小写不敏感 ───────────────────────────────────────────────────
test('查找：精确 -> 去 provider 前缀 -> 尾巴，且大小写不敏感', () => {
  const snap = buildModelsDevSnapshot(parseModelsDev(FIXTURE))
  assert.ok(lookupModelsDev(snap, 'tencent/Hy3').length > 0, '精确命中')
  assert.ok(lookupModelsDev(snap, 'TENCENT/HY3').length > 0, '大小写不敏感')
  // 尾巴：库里的全名是 XiaomiMiMo/MiMo-V2.6-Pro，用户只写 MiMo-V2.6-Pro 也要命中。
  // 返回的条目保留其完整 id（我们不改写百科的 id），命中判据看末段。
  const tail = lookupModelsDev(snap, 'MiMo-V2.6-Pro')
  assert.ok(tail.length > 0, '尾巴反查应命中')
  assert.ok(tail.every((e) => e.id.toLowerCase().endsWith('/mimo-v2.6-pro')))
  assert.ok(tail.some((e) => e.id === 'XiaomiMiMo/MiMo-V2.6-Pro'))
})

test('查找：不存在的 id 返回空，不猜', () => {
  const snap = buildModelsDevSnapshot(parseModelsDev(FIXTURE))
  assert.deepEqual(lookupModelsDev(snap, 'definitely-not-a-real-model-xyz'), [])
  assert.deepEqual(lookupModelsDev(undefined, 'anything'), [])
})

// ── 陈旧判定边界（TTL±1ms）────────────────────────────────────────────────────
test('isStale 边界：age=TTL-1ms 新鲜，age=TTL / TTL+1ms 陈旧', () => {
  const now = Date.parse('2026-09-26T00:00:00.000Z')
  /** 构造一个「已存在 ageMs 毫秒」的时间戳。 */
  const aged = (ageMs) => new Date(now - ageMs).toISOString()
  assert.equal(isStale(aged(MODELS_DEV_TTL_MS - 1), now), false, '比 TTL 年轻 1ms 应新鲜')
  assert.equal(isStale(aged(MODELS_DEV_TTL_MS), now), true, '恰好 TTL 应陈旧')
  assert.equal(isStale(aged(MODELS_DEV_TTL_MS + 1), now), true, '比 TTL 老 1ms 应陈旧')
  assert.equal(isStale('not-a-date', now), true, '不可解析的时间戳按陈旧处理')
})

// ── 一致性仲裁（多声明方冲突不写）─────────────────────────────────────────────
test('多声明方冲突：不一致的字段记冲突且不采用，一致的字段保留', () => {
  const merged = mergeModelsDev([
    { id: 'm', provider: 'a', contextWindow: 262144, maxTokens: 128000, input: ['text'] },
    { id: 'm', provider: 'b', contextWindow: 1049000, maxTokens: 128000, input: ['text'] },
  ])
  assert.equal(merged.contextWindow, undefined, '冲突字段必须不采用')
  assert.ok(merged.conflicts.some((c) => c.includes('contextWindow')))
  assert.equal(merged.maxTokens, 128000, '一致字段仍保留')
  assert.deepEqual(merged.input, ['text'])
})

test('E-P2-2 一致性仲裁真的作用于报告：冲突时不写该字段，别的不受影响', () => {
  const snap = buildModelsDevSnapshot([
    { id: 'long-tail-x', provider: 'a', contextWindow: 1000, maxTokens: 500, input: ['text'] },
    { id: 'long-tail-x', provider: 'b', contextWindow: 2000, maxTokens: 500, input: ['text'] },
  ])
  const report = emptyReport('gw', ['long-tail-x'])
  mergeModelsDevInto(report, ['long-tail-x'], snap)
  const model = report.models.find((m) => m.id === 'long-tail-x')
  assert.equal(model.contextWindow, undefined, '冲突的 contextWindow 不得写入')
  assert.equal(model.maxTokens, 500, '一致的 maxTokens 应写入')
  assert.equal(model.sources.maxTokens, 'models-dev')
  assert.ok(report.notes.some((n) => n.includes('contextWindow') && n.includes('不一致')), '应记 contextWindow 冲突 note')
})

// ── E-P2-2：S3 命中长尾 + S1-S4 全空时不写 ────────────────────────────────────
test('E-P2-2 S3 命中引擎目录没有的 id 并给出字段（source=models-dev）', () => {
  const snap = buildModelsDevSnapshot([
    { id: 'vendor-unknown-model', provider: 'encyclopedia', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'] },
  ])
  const report = emptyReport('gw', ['vendor-unknown-model'])
  mergeModelsDevInto(report, ['vendor-unknown-model'], snap)
  const model = report.models.find((m) => m.id === 'vendor-unknown-model')
  assert.equal(model.contextWindow, 131072)
  assert.equal(model.maxTokens, 8192)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.sources.contextWindow, 'models-dev')
  assert.equal(report.unknown.length, 0, '被 S3 覆盖后不再是 unknown')
})

test('Responses models.dev multi-effort lists remain unknown without evidence of distinct semantics', () => {
  const snap = buildModelsDevSnapshot([
    { id: 'mimo-like', provider: 'declared-source', thinkingLevels: ['low', 'medium', 'high'] },
  ])
  const report = emptyReport('route', ['mimo-like'])
  mergeModelsDevInto(report, ['mimo-like'], snap, new Map(), {
    route: 'route', api: 'openai-responses', baseURL: 'https://example.invalid', models: ['mimo-like'],
  })
  assert.equal(report.models[0].reasoningEfforts, undefined)
  assert.ok(report.notes.some((note) => note.includes('无法证明 Responses 各等级语义不同')))
})

test('E-P2-2 反证：S1-S4 全空且无 S5 -> 不写任何字段，unknown 保留', () => {
  const report = emptyReport('gw', ['nobody-knows-this'])
  mergeModelsDevInto(report, ['nobody-knows-this'], buildModelsDevSnapshot([]))
  mergeCatalog(report, ['nobody-knows-this'], { source: 'test', models: {} }, 'openai-completions')
  mergeFallbacks(report, ['nobody-knows-this'], undefined, false)
  const model = report.models.find((m) => m.id === 'nobody-knows-this')
  assert.deepEqual(Object.keys(model.sources), [], '无来源 => 不得有任何来源标记')
  assert.equal(model.contextWindow, undefined)
  assert.equal(model.maxTokens, undefined)
  assert.deepEqual(patchesFrom(report), [], '未匹配不得产出任何 patch（未知保持未知）')
  assert.deepEqual(report.unknown, ['nobody-knows-this'])
})

// ── E-P2-3：S5 只在用户显式配置时存在 ────────────────────────────────────────
test('E-P2-3 未配 fallbacks：configured=false -> 不写（出厂无默认值）', () => {
  const report = emptyReport('gw', ['m1'])
  mergeModelsDevInto(report, ['m1'], buildModelsDevSnapshot([]))
  mergeFallbacks(report, ['m1'], { contextWindow: 262144, maxTokens: 32768 }, false)
  const model = report.models.find((m) => m.id === 'm1')
  assert.equal(model.contextWindow, undefined, '没有配置就没有 S5')
  assert.equal(model.maxTokens, undefined)
  assert.deepEqual(patchesFrom(report), [])
})

test('E-P2-3 配了 fallbacks：写入且 source == user-fallback', () => {
  const report = emptyReport('gw', ['m1'])
  mergeModelsDevInto(report, ['m1'], buildModelsDevSnapshot([]))
  mergeFallbacks(report, ['m1'], { contextWindow: 262144, maxTokens: 32768 }, true)
  const model = report.models.find((m) => m.id === 'm1')
  assert.equal(model.contextWindow, 262144)
  assert.equal(model.maxTokens, 32768)
  assert.equal(model.sources.contextWindow, 'user-fallback')
  assert.equal(model.sources.maxTokens, 'user-fallback')
  const patches = patchesFrom(report)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].source, 'user-fallback')
  assert.equal(report.unknown.length, 0)
})

test('E-P2-3 S5 只在 S1-S4 都空时才补：已有声明的字段不被兜底值覆盖', () => {
  const report = emptyReport('gw', ['m1'])
  report.models.push({
    id: 'm1',
    contextWindow: 4096,
    sources: { contextWindow: 'endpoint-descriptor' },
  })
  mergeFallbacks(report, ['m1'], { contextWindow: 262144, maxTokens: 32768 }, true)
  const model = report.models.find((m) => m.id === 'm1')
  assert.equal(model.contextWindow, 4096, 'S1 已有值不得被 S5 覆盖')
  assert.equal(model.sources.contextWindow, 'endpoint-descriptor', '来源标记不得被改写')
  assert.equal(model.maxTokens, 32768, '缺失的字段才由 S5 补')
  assert.equal(model.sources.maxTokens, 'user-fallback')
})

// ── 尺寸上限 ─────────────────────────────────────────────────────────────────
test('尺寸：超过上限时 writeModelsDevSnapshot 拒绝落盘（返回 undefined）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelsdev-'))
  try {
    const path = join(dir, 'models-dev.json')
    const huge = buildModelsDevSnapshot([
      { id: 'x'.repeat(MODELS_DEV_MAX_BYTES), provider: 'p' },
    ])
    assert.equal(writeModelsDevSnapshot(path, huge), undefined, '超限必须拒绝')
    assert.equal(readModelsDevSnapshot(path), undefined, '拒绝后不应留下文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('尺寸：真实抓取裁剪后的全量快照在 8 MiB 以内（夹具只裁条目数，不裁字段）', () => {
  const entries = parseModelsDev(FIXTURE)
  const snap = buildModelsDevSnapshot(entries)
  const bytes = Buffer.byteLength(JSON.stringify(snap))
  assert.ok(bytes < MODELS_DEV_MAX_BYTES, '夹具快照 ' + bytes + ' 字节应在上限内')
})

// ── 拉取失败沿用旧缓存 / 无缓存不阻断 ────────────────────────────────────────
test('缓存：写入后可读回；缺失或损坏文件视为源缺席（不抛）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelsdev-'))
  try {
    const path = join(dir, 'models-dev.json')
    assert.equal(readModelsDevSnapshot(path), undefined, '文件不存在 => 缺席')
    const snap = buildModelsDevSnapshot([{ id: 'a', provider: 'p', contextWindow: 1 }])
    assert.ok(writeModelsDevSnapshot(path, snap) > 0)
    assert.deepEqual(readModelsDevSnapshot(path), snap)
    writeFileSync(path, '{ not json')
    assert.equal(readModelsDevSnapshot(path), undefined, '损坏文件 => 缺席，不抛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缓存路径与 diag 同口径：DSH_HOME 缺席时退回壳私有目录', () => {
  assert.equal(modelsDevCachePath('/home/x/.dsh'), '/home/x/.dsh/models-dev.json')
  assert.equal(modelsDevCachePath('/home/x/.dsh/'), '/home/x/.dsh/models-dev.json', '多余斜杠被归一')
  // 不读进程 env（本机可能已设 DSH_HOME，凭环境差异断言会把环境当缺陷）；
  // 直接验证「未提供 home」时的兜底常量。
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    const fallback = modelsDevCachePath(undefined)
    assert.equal(fallback, '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/models-dev.json')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

// ── 档位与方言门的关系 ───────────────────────────────────────────────────────
test('effortsFromLevels：只认引擎词表，空输入返回 undefined', () => {
  assert.equal(effortsFromLevels(undefined), undefined)
  assert.equal(effortsFromLevels([]), undefined)
  assert.deepEqual(effortsFromLevels(['low', 'bogus']), { low: 'low' })
})

// 回归：models.dev 关闭/无缓存时 S5 仍必须生效（这是 S5 最该用的场景）。
// 曾漏：mergeModelsDevInto 在 snapshot 为 undefined 时提前返回、不建 declared 条目，
// 于是 mergeFallbacks 没有可写的条目 -> 用户配了兜底值却什么都没发生。
test('E-P2-3 回归：无 models.dev 快照时 S5 仍然生效', () => {
  const report = emptyReport('gw', ['m1'])
  mergeModelsDevInto(report, ['m1'], undefined)
  mergeFallbacks(report, ['m1'], { contextWindow: 262144, maxTokens: 32768 }, true)
  const patches = patchesFrom(report)
  assert.equal(patches.length, 1, '无 models.dev 时 S5 哑掉（patches=' + patches.length + '）')
  assert.equal(patches[0].source, 'user-fallback')
  assert.equal(patches[0].contextWindow, 262144)
  assert.equal(patches[0].maxTokens, 32768)
})
