// 输入模态过滤（0.14.6 A 轨修复，2026-10-11 设备实锤）回归。
//
// 判据来源：Lead 裁定（方案 a）+ 设备证据。核心要求：
//   ① 过滤白名单必须来自**出货 schema**，不得自己维护第二份常量；
//   ② 命中 audio/pdf 时，写出的 input 仍合法，**且 reasoningEfforts 不连坐**（正面证据）；
//   ③ 反向：只声明 text/image 时行为不变（不因过滤误删）；
//   ④ 被丢弃的模态不得静默 —— 要能在 skipped/诊断里看到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { allowedInputModalities, filterInputModalities, planModelPatch } from '../lib/settings-writer.js'

const ENGINE = process.env.DSH_ENGINE_TREE
  ?? 'D:/coding/dsh-mobile/.deploy-tmp/fx2/tree/node_modules/@deepseek-ai'
const PI_AI = ENGINE + '/dsh-llm-pi-ai/lib/index.js'

/** 出货 pi-ai 的 Config（写回校验器同源）。缺席则跳过依赖真实引擎的用例。 */
async function loadSchema() {
  if (!existsSync(PI_AI)) return undefined
  const mod = await import('file:///' + PI_AI)
  return mod.Config
}

test('白名单真源：从出货 schema 反推 = schema 实际接受集合（两者必须一致）', async (t) => {
  const Config = await loadSchema()
  if (!Config) { t.diagnostic('出货引擎树缺席，跳过'); return }
  const allowed = allowedInputModalities(Config.toJSON())
  assert.ok(Array.isArray(allowed) && allowed.length > 0, '未从 schema 提取到模态白名单')

  // oracle：直接把候选喂给 schema，看它到底接受谁。
  const accepts = (m) => {
    try {
      Config({ providers: { gw: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'm', input: [m] }] } } })
      return true
    } catch { return false }
  }
  const CANDIDATES = ['text', 'image', 'audio', 'pdf', 'video', 'file']
  const oracle = CANDIDATES.filter(accepts)
  t.diagnostic('schema 反推=' + JSON.stringify(allowed) + ' oracle=' + JSON.stringify(oracle))
  assert.deepEqual(allowed, oracle,
    '反推出的白名单与 schema 实际接受的不一致（说明提取逻辑或漂移了）')
  // pi-ai 当前是 text|image；若将来升级加了模态，本断言会提醒（不是静默通过）。
  assert.deepEqual(oracle, ['text', 'image'], '出货 schema 接受的模态集合变了，请复核本插件的映射')
})

test('白名单是真源而非硬编码：schema 结构不认识时返回 undefined（保守放行）', () => {
  assert.equal(allowedInputModalities(undefined), undefined)
  assert.equal(allowedInputModalities({}), undefined)
  assert.equal(allowedInputModalities({ refs: {} }), undefined)
  assert.equal(allowedInputModalities({ refs: { 1: { type: 'string' } } }), undefined)
})

test('filterInputModalities：allowed 缺席 => 原样保留（不凭空裁掉可能合法的新模态）', () => {
  const r = filterInputModalities(['text', 'audio'], undefined)
  assert.deepEqual(r.kept, ['text', 'audio'])
  assert.deepEqual(r.dropped, [])
})

test('filterInputModalities：保留接受项、丢弃拒绝项，且顺序保持', () => {
  const r = filterInputModalities(['audio', 'text', 'pdf', 'image'], ['text', 'image'])
  assert.deepEqual(r.kept, ['text', 'image'])
  assert.deepEqual(r.dropped, ['audio', 'pdf'])
})

// ── 核心判据：不连坐（正面证据）────────────────────────────────────────────
test('目录声明含 audio：input 裁到合法集，且 reasoningEfforts 照常写入（不连坐）', async (t) => {
  const Config = await loadSchema()
  const allowed = Config ? allowedInputModalities(Config.toJSON()) : ['text', 'image']
  const patches = [{
    id: 'mimo-v2.5',
    input: ['text', 'image', 'audio'],          // models.dev 真实形态（empiriolabs mimo-v2-5）
    reasoningEfforts: { off: 'off', low: 'low' },
    contextWindow: 1000000,
    maxTokens: 128000,
    source: 'models-dev',
  }]
  const plan = planModelPatch([{ id: 'mimo-v2.5' }], patches, undefined, allowed)
  const entry = plan.models[0]
  t.diagnostic('written=' + JSON.stringify(plan.written) + ' changes=' + JSON.stringify(plan.changes) + ' skipped=' + JSON.stringify(plan.skipped))

  // ① input 合法（不含 audio）
  assert.deepEqual(entry.input, ['text', 'image'], 'input 未裁到 schema 接受集')
  // ② 丢弃可见（不静默）
  assert.deepEqual(plan.droppedModalities, [{ id: 'mimo-v2.5', dropped: ['audio'] }],
    '被丢弃的模态未被记录（静默降级）')
  // ③ **不连坐**：reasoningEfforts 真的写进去了（这才是功能 A 的主目标）
  assert.deepEqual(entry.reasoningEfforts, { off: 'off', low: 'low' },
    'reasoningEfforts 被 input 的非法模态连坐（真机 mutate-rejected 的根因）')
  assert.equal(entry.contextWindow, 1000000, 'contextWindow 被连坐')
  assert.equal(entry.maxTokens, 128000, 'maxTokens 被连坐')

  // ④ 若出货 schema 在场，用**它的校验器**证明这条写回真的能过（不是我们自己的宽松校验）
  if (Config) {
    assert.doesNotThrow(() => {
      Config({ providers: { gw: { api: 'openai-completions', baseURL: 'https://x/v1', models: plan.models } } })
    }, '裁切后的写回仍被出货 schema 拒绝（说明裁切不对）')
  }
})

test('反向：目录只声明 text/image 时行为不变（过滤不误删）', () => {
  const patches = [{ id: 'm', input: ['text', 'image'], source: 'engine-catalog' }]
  const plan = planModelPatch([{ id: 'm' }], patches, undefined, ['text', 'image'])
  assert.deepEqual(plan.models[0].input, ['text', 'image'])
  assert.deepEqual(plan.droppedModalities, [], '合法输入被误报为丢弃')
})

test('反向：全部模态都被拒时不写 input，但其它字段仍写入（且不触发空写）', () => {
  const patches = [{ id: 'm', input: ['audio', 'pdf'], reasoningEfforts: { low: 'low' }, source: 'models-dev' }]
  const plan = planModelPatch([{ id: 'm' }], patches, undefined, ['text', 'image'])
  assert.equal(plan.models[0].input, undefined, '非法 input 不该被写入')
  assert.deepEqual(plan.droppedModalities, [{ id: 'm', dropped: ['audio', 'pdf'] }])
  assert.deepEqual(plan.models[0].reasoningEfforts, { low: 'low' }, 'reasoningEfforts 应照常写入')
  // changes 必须只反映真实写入（否则会触发一次空 mutate）
  assert.ok(!plan.changes.some((c) => c.includes('补 input')),
    'changes 里不应出现 input 写入（它没被写）')
  assert.ok(plan.changes.some((c) => c.includes('补 reasoningEfforts')),
    'changes 缺少 reasoningEfforts 写入记录')
})

test('不静默：丢弃的模态写进 skipped 供用户与日志查看', () => {
  const patches = [{ id: 'm', input: ['text', 'audio'], source: 'models-dev' }]
  const plan = planModelPatch([{ id: 'm' }], patches, undefined, ['text', 'image'])
  const joined = plan.skipped.join(' | ')
  assert.ok(joined.includes('audio'), 'skipped 未提及被丢弃的 audio：' + joined)
})

// ── 2026-10-15 设备实锤：audio 在**既有条目**上时同样连坐 ────────────────────
//
// 上一条用例只覆盖「补丁带来 input」。真机上 audio 的来源是**补全器自己**：
// 它从 models.dev 查到 input=[text,image,audio] 并成功写进条目一次，
// 此后每一次补齐都被自己写的 audio 挡下（schemastery: input[2] expected text|image but got audio）。
// 实锤：31 次 runAutoPass 全部 wrote=false reason=mutate-rejected，reasoningEfforts 一次都没写进去。

test('既有条目带 audio：同样裁到合法集，且本轮 reasoningEfforts 能写入（真机自锁回归）', () => {
  // 复刻真机条目：id/name/contextWindow 是用户声明的，input 是补全器**上一次**写进去的。
  const existing = [{
    id: 'mimo-v2.5',
    name: 'MiMo 2.5',
    contextWindow: 262144,
    input: ['text', 'image', 'audio'],   // 补全器自写；schema 不接受 audio
    compat: { thinkingFormat: 'mimo' },
  }]
  const patches = [{ id: 'mimo-v2.5', reasoningEfforts: { off: 'off', low: 'low' }, source: 'protocol-profile' }]
  const plan = planModelPatch(existing, patches, undefined, ['text', 'image'])
  const entry = plan.models[0]

  // (1) 既有非法模态被裁掉（否则写回必被 schema 整条拒）
  assert.deepEqual(entry.input, ['text', 'image'],
    '既有条目的 audio 未被裁掉：写回仍会被 schema 整条拒绝')
  // (2) 丢弃可见（不静默）
  assert.deepEqual(plan.droppedModalities, [{ id: 'mimo-v2.5', dropped: ['audio'] }],
    '被丢弃的既有模态未被记录')
  assert.ok(plan.skipped.join(' | ').includes('audio'), 'skipped 未提及 audio')
  // (3) 主目标达成：reasoningEfforts 真的写进去了
  assert.deepEqual(entry.reasoningEfforts, { off: 'off', low: 'low' },
    'reasoningEfforts 被既有条目的非法 input 连坐（真机 31 次 mutate-rejected 的根因）')
  // (4) 用户声明的其它字段原样保留
  assert.equal(entry.name, 'MiMo 2.5')
  assert.equal(entry.contextWindow, 262144)
  // (5) 仅裁切也算一次真实写入（否则该条裁切永远不落盘、下一轮再被挡）
  assert.ok(plan.changes.length > 0, 'changes 为空 => mutate 不会发生，裁切与补齐都不会落盘')
})

test('既有条目只有非法模态、且本轮无其它字段：裁切仍要落盘（不得 no-change）', () => {
  // 退化场景：用户改了无关字段触发一轮，补丁里恰好没有该模型的任何新字段。
  // 若不把裁切计入 changes，plan.changes 为空 => 直接 return no-change => audio 永远留在条目里。
  const existing = [{ id: 'm', input: ['audio'] }]
  const patches = [{ id: 'm', source: 'noop' }]
  const plan = planModelPatch(existing, patches, undefined, ['text', 'image'])
  assert.deepEqual(plan.models[0].input, [], '非法模态未被裁')
  assert.ok(plan.changes.length > 0, '仅裁切却 no-change：该条裁切永远写不进去')
})

test('既有条目 input 合法时零改动（不误删、不产生空写）', () => {
  const existing = [{ id: 'm', input: ['text', 'image'] }]
  const patches = [{ id: 'm', source: 'noop' }]
  const plan = planModelPatch(existing, patches, undefined, ['text', 'image'])
  assert.deepEqual(plan.models[0].input, ['text', 'image'], '合法 input 被误改')
  assert.deepEqual(plan.droppedModalities, [], '合法 input 被误报为丢弃')
  assert.equal(plan.changes.length, 0, '无改动却产生 changes => 会触发一次空 mutate')
})

test('既有条目 input 非法但 schema 结构不认识：保守放行（不凭空裁）', () => {
  const existing = [{ id: 'm', input: ['text', 'audio'] }]
  const patches = [{ id: 'm', reasoningEfforts: { low: 'low' }, source: 'x' }]
  const plan = planModelPatch(existing, patches, undefined, undefined)
  assert.deepEqual(plan.models[0].input, ['text', 'audio'],
    'allowed 缺席时不该裁（结构不认识就保守放行，交给写回按原方式失败并留诊断）')
  assert.deepEqual(plan.droppedModalities, [])
  assert.deepEqual(plan.models[0].reasoningEfforts, { low: 'low' }, '其它字段应照常写入')
})
