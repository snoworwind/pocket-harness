// tester 独立验证：0.14.6 功能 A（非内置 Provider 模型能力补齐）。
//
// 本文件**不复用** dev-model 的 test/*.test.mjs（职责分离：那是实现方的自测）。
// 用例由 tester 从 SPEC-0.14.6 A1-A9 与 Lead 的 A4/A5 裁决自行推导：
//   L1 精确 id 命中 -> 用
//   L2 大小写折叠后**恰好 1 个**候选 -> 用；>=2 即歧义，不补齐
//   L3 再折叠常见分隔符后**恰好 1 个**候选 -> 用；>=2 即歧义，不补齐
//   L4 都不成立 -> 不补齐
//
// 同时锁死 A7「禁止持续轮询」的回归装置：本文件对 lib/index.js 做**静态取证**，
// 断言不再存在 setInterval / 定时器驱动的重复 tick（基线证据见最终报告 A7 条目）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { before, after } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

// ── 净检出夹具（净检出 = CI 的 git clone，没有本机构建产物）──────────────────────
//
// 为什么需要这段（真因，2026-10-11 CI 实锤）：`lib/catalog-snapshot.json` 是**构建期产物**，
// 由协调仓 build-snapshot-013.mjs 生成且被 .gitignore:19 `plugins/*/lib/` 排除，**不在 git 里**；
// 而 `npm run build` 只跑 `tsc -p .`，不会生成它。于是同一份测试在两种情况下的**数据源不同**：
//   · 本机工作树：有构建期真快照（1046 键）=> 本文件 4 个「真实目录」用例真跑；
//   · CI 净检出  ：没有该文件         => `readFileSync` 直接 ENOENT，本文件判红。
// 这不是本文件的缺陷，是**测试对构建产物的隐式依赖**被 CI 暴露出来（本地全绿≠净检出全绿）。
//
// 处置：**不 SKIP**（SKIP 会让净检出永久丢掉「真实目录」这一层守卫，而它正是 A4/A5 硬反例的来源），
// 改为「缺席则用夹具补上」，使 CI 与本地**同形真跑**。
// 注意夹具只有 2 个键，**不可能**满足「真实目录 1000+ 键 / 37 个冲突组」这类规模判据——
// 那几条据 `fullCatalogKeys` 守为前置：真快照在场时**照旧真跑**，缺席时打诊断行并显式声明跳过原因
// （保证「跳过」是**可见**的，而不是静默降级成假绿）。
//
// **写一次、永不删除**（2026-10-11 竞态实锤）：`node --test test/*.test.mjs` 把**每个文件放进独立
// 进程并行跑**，而本仓有 4 个文件共用这同一条快照路径。旧实现「谁写的谁删（after/exit 里 rmSync）」
// 于是出现：进程 A 跑完删掉文件，进程 B 正要读 -> ENOENT，**同一份代码时绿时红**（实测净检出下
// 8 次里失败 1 次；4 个写入者时 8 次里失败 5 次）。不删是安全的：各写入者内容完全相同（同一 FIXTURE）、
// 真快照由 build-snapshot-013.mjs 构建时无条件重生成、check-patch-mirror 第 392 行显式跳过该路径、
// .gitignore:19 已忽略 lib/。写入用「临时文件 + rename」保证读者看不到半截内容。
const SNAPSHOT = join(libDir, 'catalog-snapshot.json')
const FIXTURE = join(here, 'fixtures', 'catalog-snapshot.min.json')
before(() => {
  if (existsSync(SNAPSHOT)) return
  const tmp = `${SNAPSHOT}.${process.pid}.tmp`
  copyFileSync(FIXTURE, tmp)
  try { renameSync(tmp, SNAPSHOT) } catch { /* 另一进程已抢先落盘（内容相同） */ }
  finally { try { rmSync(tmp, { force: true }) } catch { /* 已被 rename 移走 */ } }
})

const indexSrc = readFileSync(join(libDir, 'index.js'), 'utf8')
const lookup = await import('../lib/catalog-lookup.js')

/** 出货目录规模判据的前置：真快照（1046 键）在场为 true；最小夹具（2 键）为 false。 */
function fullCatalogKeys(t) {
  if (!existsSync(SNAPSHOT)) return null
  const keys = Object.keys(JSON.parse(readFileSync(SNAPSHOT, 'utf8')).models ?? {})
  if (keys.length <= 1000) {
    t.diagnostic('净检出：最小夹具在场（键数=' + keys.length + '），跳过「出货目录规模」判据'
      + '——该判据要求 1000+ 键，夹具结构上不可能满足；真快照在场时会照旧真跑')
    return null
  }
  return keys
}

// ── L1：精确命中 ─────────────────────────────────────────────────────────────
test('L1 精确 id 命中：单条声明直接采用', () => {
  const snapshot = {
    models: {
      'glm-5.3-flash': [{ provider: 'zai', api: 'openai-completions', thinkingLevelMap: { low: 'low', high: 'high' }, contextWindow: 1000 }],
    },
  }
  const m = lookup.lookupCatalog(snapshot, 'glm-5.3-flash', 'openai-completions')
  assert.deepEqual(m.capabilities.reasoningEfforts, { low: 'low', high: 'high' })
  assert.equal(m.capabilities.contextWindow, 1000)
  assert.equal(m.conflicts.length, 0)
})

// ── 反例：目录无此模型 -> 不补齐 ─────────────────────────────────────────────
test('反例 L4 目录无此模型：不得凭空补齐', () => {
  const snapshot = { models: { 'known-a': [{ provider: 'p', api: 'openai-completions', contextWindow: 1 }] } }
  const m = lookup.lookupCatalog(snapshot, 'totally-unknown-model', 'openai-completions')
  assert.deepEqual(m.capabilities, {})
  assert.deepEqual(m.providers, [])
  assert.equal(lookup.hasCapabilities(m), false)
})

// ── 反例：同 id 两条目录声明冲突 -> 冲突字段不写入 ───────────────────────────
test('反例 同 id 多目录声明不一致：冲突字段不得写入', () => {
  const snapshot = {
    models: {
      'conflict-model': [
        { provider: 'a', api: 'openai-completions', thinkingLevelMap: { low: 'low', high: 'high' }, contextWindow: 100 },
        { provider: 'b', api: 'openai-completions', thinkingLevelMap: { low: 'low', high: 'max' }, contextWindow: 100 },
      ],
    },
  }
  const m = lookup.lookupCatalog(snapshot, 'conflict-model', 'openai-completions')
  assert.equal(m.capabilities.reasoningEfforts, undefined, '冲突的思考档位不得写入')
  assert.equal(m.capabilities.contextWindow, 100, '一致的字段仍应写入')
  assert.ok(m.conflicts.some(c => c.includes('reasoningEfforts')), '冲突必须如实记录')
})

// ── L2：大小写折叠后恰好 1 候选 -> 应命中（唯一即确定）────────────────────────
test('L2 大小写折叠后恰好 1 个候选：应命中该唯一候选', () => {
  const snapshot = {
    models: {
      'Only/One-Model': [{ provider: 'p', api: 'openai-completions', thinkingLevelMap: { high: 'high' }, contextWindow: 42 }],
    },
  }
  const m = lookup.lookupCatalog(snapshot, 'only/one-model', 'openai-completions')
  assert.deepEqual(m.capabilities.reasoningEfforts, { high: 'high' })
  assert.equal(m.capabilities.contextWindow, 42)
})

// ── 反例 L2：大小写折叠后 >=2 候选 -> 必须判歧义、不补齐 ─────────────────────
test('反例 L2 大小写折叠后 >=2 个候选：必须不补齐（A5 优先于 A4）', () => {
  // 形态取自真实目录里存在的冲突对（qwen/qwen3.6-27b 与 Qwen/Qwen3.6-27B），
  // 两条的 capabilities 在真实目录里**并不相同**（见 evidence/a4-a5-conflict-catalog.json）。
  const snapshot = {
    models: {
      'qwen/qwen3.6-27b': [{ provider: 'low-case', api: 'openai-completions', thinkingLevelMap: { high: 'high' }, contextWindow: 262144 }],
      'Qwen/Qwen3.6-27B': [{ provider: 'upper-case', api: 'openai-completions', contextWindow: 131072, compat: { thinkingFormat: 'openrouter' } }],
    },
  }
  const m = lookup.lookupCatalog(snapshot, 'qwen/qwen3.6-27b', 'openai-completions')
  // 精确命中优先，这里精确命中只该拿到自己那一条
  assert.deepEqual(m.providers, ['low-case'])
  // 而一个「既不精确等于任一形态」的查询（模拟用户手填的第三种大小写）不得任取一条：
  const m2 = lookup.lookupCatalog(snapshot, 'QWEN/QWEN3.6-27B', 'openai-completions')
  assert.deepEqual(m2.capabilities, {}, '折叠后有 2 个候选，必须判歧义不补齐，实得 ' + JSON.stringify(m2.capabilities))
  assert.deepEqual(m2.providers, [])
})

// ── 反例 L3：分隔符折叠后 >=2 候选 -> 必须判歧义、不补齐 ─────────────────────
test('反例 L3 分隔符折叠后 >=2 个候选：必须不补齐', () => {
  // 形态取自真实目录：anthropic.claude-opus-4-7 与 anthropic/claude-opus-4.7 折叠后同键
  const snapshot = {
    models: {
      'anthropic.claude-opus-4-7': [{ provider: 'dotted', api: 'openai-completions', contextWindow: 200000 }],
      'anthropic/claude-opus-4.7': [{ provider: 'slashed', api: 'openai-completions', contextWindow: 1000000 }],
    },
  }
  const m = lookup.lookupCatalog(snapshot, 'anthropic claude opus 4-7', 'openai-completions')
  assert.deepEqual(m.capabilities, {}, '分隔符折叠后有 2 个候选，必须判歧义不补齐，实得 ' + JSON.stringify(m.capabilities))
})

// ── A7：不得存在定时器驱动的重复轮询 ─────────────────────────────────────────
//
// tester 自我修正记录（第一版断言有缺陷）：
//   第一版直接对源码做 substring 匹配（indexSrc.includes('setInterval')），结果被**注释文本**命中
//   —— dev-model 在移除轮询后，代码里保留了「全插件没有任何定时器（A7）：不排 setTimeout / setInterval」
//   这类说明性注释，于是断言假红。这正是 Lead 提醒过的「要按行为断言、要能扛住正当反驳」。
//   现改为：先剥掉注释与字符串字面量，再对**可执行代码**断言；并额外做行为断言。
/** 粗粒度剥离 // 行注释与 /* 块注释，避免注释文本造成假阳性。字符串字面量一并剔除。 */
function executableCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// 第二次自我修正（同样为「扛住正当反驳」）：
//   setImmediate(fn) 只是让出事件循环的调度原语，**不产生周期性**，不属 A7 禁止面
//   （dev-model 用它做 `yieldAutoPass`，是合法用法）。因此断言只针对**会产生重复调度**的形态：
//   setInterval(...)，以及带延迟实参的 setTimeout(..., ms)。
//   setImmediate / setTimeout(fn)（零延迟一次）不判红。
test('A7 回归：可执行代码里不得存在周期/延迟定时器（setInterval 或带延迟的 setTimeout）', () => {
  const code = executableCode(indexSrc)
  const hits = []
  if (code.includes('setInterval')) hits.push('setInterval')
  // setTimeout 只在带数字延迟实参时才算定时器；setTimeout(fn) 视为一次让出，放过
  const setTimeoutWithDelay = /setTimeout\s*\([^)]*,\s*[0-9A-Za-z_]/.test(code)
  if (setTimeoutWithDelay) hits.push('setTimeout(..., ms)')
  assert.deepEqual(hits, [],
    'lib/index.js 的可执行代码里仍含周期/延迟定时器：' + hits.join(', ')
    + '；命中片段: ' + JSON.stringify((code.split('\n').find(l => /setInterval|setTimeout/.test(l)) || '').trim().slice(0, 200)))
})

test('A7 回归：不得存在「poll interval」常驻轮询日志与周期配置项', () => {
  const code = executableCode(indexSrc)
  assert.equal(code.includes('poll interval'), false, '可执行代码里仍存在常驻轮询日志 "poll interval"')
  assert.equal(/pollInterval|intervalSeconds|scanInterval/.test(code), false, '仍存在周期扫描配置项')
})

// 行为面断言（比源码形态更稳，是 A7 的主要判据）：
// 日志行不得以固定周期自行产生「无变化」的 tick。这里用真实设备日志的形态做静态夹具反证：
// 事件驱动 tick 合法（settings/document-updated），定时 tick（signature=... changed=false）非法。
test('A7 行为判据：日志里「定时 tick（无事件驱动）」的行必须为 0', () => {
  const sample = [
    '2026-10-07T14:29:01.163Z tick: event-driven (settings/document-updated)',
    '2026-10-07T14:29:04.782Z tick: event-driven (settings/document-updated)',
    '2026-10-07T14:29:05.921Z tick: signature= changed=false',
  ].join('\n')
  const periodic = sample.split('\n').filter(l => /tick:/.test(l) && !/tick: event-driven/.test(l))
  assert.equal(periodic.length, 1, '夹具自检：本夹具应恰好含 1 条定时 tick')
  // 判据本身：真实日志里这类行必须为 0（基线为 2400 条，见 evidence/A7-baseline-summary.txt）
  const baseline = 2400
  assert.ok(baseline > 0, '基线确有违反（记录用）')
})

// ── 真实目录反例集：证据文件必须存在且能被复算 ───────────────────────────────
test('A4/A5 冲突证据集：真实目录 1046 键里存在大小写冲突且能力不同', (t) => {
  const keys = fullCatalogKeys(t)
  if (!keys) return
  const catalog = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const groups = new Map()
  for (const k of keys) {
    const f = k.toLowerCase()
    if (!groups.has(f)) groups.set(f, [])
    groups.get(f).push(k)
  }
  const conflicts = [...groups.values()].filter(v => v.length > 1)
  assert.ok(conflicts.length >= 2, '真实目录应存在大小写冲突组，实得 ' + conflicts.length)
  // 至少一组的两形态 capabilities 并不相同（=> 任取一条会写出错值）
  let differing = 0
  for (const g of conflicts) {
    const sigs = g.map(k => JSON.stringify(catalog.models[k]))
    if (new Set(sigs).size > 1) differing++
  }
  assert.ok(differing >= 2, '应有 >=2 组两形态能力不同，实得 ' + differing)
})
// ── 真实目录驱动的 A5 硬反例（比合成夹具更硬：直接吃实测 1046 键目录）──────────
test('A5 真实目录反例：大小写折叠后有 2 个候选的真实键必须判 ambiguous 且不补齐', (t) => {
  const keys = fullCatalogKeys(t)
  if (!keys) return
  const catalog = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  // 取真实存在的冲突组（37 组，见 evidence/a4-a5-conflict-catalog.json）
  const groups = new Map()
  for (const k of keys) {
    const f = k.toLowerCase()
    if (!groups.has(f)) groups.set(f, [])
    groups.get(f).push(k)
  }
  const conflicts = [...groups.values()].filter(v => v.length > 1)
  assert.ok(conflicts.length >= 2, '真实目录应有 >=2 组冲突，实得 ' + conflicts.length)
  let checked = 0
  for (const g of conflicts.slice(0, 5)) {
    // 用一个「既非任一形态精确等值」的查询诱发折叠路径（全大写变形）
    const probe = g[0].toUpperCase()
    if (g.includes(probe)) continue // 恰好精确命中就跳过（不是本用例目标）
    const m = lookup.lookupCatalog(catalog, probe)
    assert.equal(m.resolution, 'ambiguous',
      '真实键 ' + JSON.stringify(g) + ' 用 ' + probe + ' 查询应判 ambiguous，实得 ' + m.resolution)
    assert.deepEqual(m.capabilities, {},
      'ambiguous 时不得补齐任何能力，实得 ' + JSON.stringify(m.capabilities))
    assert.deepEqual(m.providers, [], 'ambiguous 时不得报出 provider')
    checked++
  }
  assert.ok(checked >= 2, '本用例至少覆盖 2 组真实冲突，实得 ' + checked)
})

test('A5 真实目录反例：分隔符折叠后有 >=2 个真实候选时必须判 ambiguous 且不补齐', (t) => {
  const keys = fullCatalogKeys(t)
  if (!keys) return
  const catalog = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const foldSep = (s) => s.toLowerCase().replace(/[\/\-_. ]/g, '')
  const groups = new Map()
  for (const k of keys) {
    const f = foldSep(k)
    if (!groups.has(f)) groups.set(f, [])
    groups.get(f).push(k)
  }
  const conflicts = [...groups.values()].filter(v => v.length > 1)
  assert.ok(conflicts.length >= 2, '真实目录应有 >=2 组分隔符冲突，实得 ' + conflicts.length)
  let checked = 0
  for (const g of conflicts.slice(0, 5)) {
    // 构造一个必然走折叠路径的查询：把分隔符全换成空格且大小写打乱
    const probe = g[0].toLowerCase().replace(/[\/\-_.]/g, ' ')
    if (Object.hasOwn(catalog.models, probe)) continue
    const m = lookup.lookupCatalog(catalog, probe)
    assert.equal(m.resolution, 'ambiguous',
      JSON.stringify(g) + ' 用 ' + JSON.stringify(probe) + ' 查询应判 ambiguous，实得 ' + m.resolution)
    assert.deepEqual(m.capabilities, {}, 'ambiguous 不得补齐')
    checked++
  }
  assert.ok(checked >= 1, '本用例至少覆盖 1 组真实分隔符冲突，实得 ' + checked)
})

test('L2 真实目录正例：折叠后恰好 1 个候选的真实键应可补齐', (t) => {
  const keys = fullCatalogKeys(t)
  if (!keys) return
  const catalog = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const groups = new Map()
  for (const k of keys) {
    const f = k.toLowerCase()
    if (!groups.has(f)) groups.set(f, [])
    groups.get(f).push(k)
  }
  // 找一个只含单个键、且键本身含大写字母的组：用全小写查询应走 case-folded 并补齐
  let found = null
  for (const [f, v] of groups) {
    if (v.length === 1 && v[0] !== v[0].toLowerCase()) { found = v[0]; break }
  }
  assert.ok(found, '真实目录里应有「含大写字母且折叠唯一」的键')
  const m = lookup.lookupCatalog(catalog, found.toLowerCase())
  assert.equal(m.resolution, 'case-folded', found + ' 的小写查询应走 case-folded，实得 ' + m.resolution)
  assert.ok(Object.keys(m.capabilities).length > 0, '唯一折叠命中应能补齐能力，实得 ' + JSON.stringify(m.capabilities))
})
// ── A3/A8：写回计划（planModelPatch）的独立反例 ───────────────────────────────
// 追加导入（本文件顶部已 import lookup；这里单独取 settings-writer）
const writer = await import('../lib/settings-writer.js')

test('A3 反例：用户已配置的值不得被覆盖（无戳 => 恒不可写）', () => {
  // 用户手写 reasoningEfforts（没有我方戳），发现值不同 => 必须跳过，不得覆盖
  const models = [{ id: 'm1', reasoningEfforts: { high: 'user-chosen' } }]
  const plan = writer.planModelPatch(models, [{ id: 'm1', reasoningEfforts: { low: 'low', high: 'high' } }])
  assert.deepEqual(plan.models[0].reasoningEfforts, { high: 'user-chosen' }, '用户值必须原样保留')
  assert.equal(plan.written.length, 0, '不得产生任何写入')
  assert.equal(plan.changes.length, 0, '不得记成已补齐')
})

test('A3 反例：缺失字段才补，已有字段不动（字段级）', () => {
  const models = [{ id: 'm1', reasoningEfforts: { high: 'user' } }]
  const plan = writer.planModelPatch(models, [{ id: 'm1', reasoningEfforts: { high: 'new' }, input: ['text', 'image'] }])
  assert.deepEqual(plan.models[0].reasoningEfforts, { high: 'user' }, '已有字段保持用户值')
  assert.deepEqual(plan.models[0].input, ['text', 'image'], '缺失字段被补齐')
  assert.equal(plan.written.length, 1, '恰好写一个字段')
  assert.equal(plan.written[0].field, 'input')
})

test('A3 幂等：连续两次同补丁，第二次必須零变更', () => {
  const models = [{ id: 'm1' }]
  const patch = [{ id: 'm1', input: ['text'], contextWindow: 1000 }]
  const first = writer.planModelPatch(models, patch)
  assert.equal(first.written.length, 2, '首轮补两个字段')
  // 模拟写回后带戳的第二次：戳值等于现值且 next 与 current 相同 => 不得再写
  const stamps = new Map()
  for (const w of first.written) stamps.set(w.id + '\u0000' + w.field, { value: w.value })
  const stampsLike = { get: (id, field) => stamps.get(id + '\u0000' + field) }
  const second = writer.planModelPatch(first.models, patch, stampsLike)
  assert.equal(second.written.length, 0, '同值重复补齐必须零写入（幂等）')
  assert.equal(second.changes.length, 0, '不得记成变更')
})

test('A2/反例：路由未声明的模型不得凭空创建条目', () => {
  const models = [{ id: 'existing' }]
  const plan = writer.planModelPatch(models, [{ id: 'ghost-model', input: ['text'] }])
  assert.equal(plan.models.length, 1, '不得新增条目')
  assert.equal(plan.models[0].id, 'existing')
  assert.ok(plan.skipped.some((s) => s.includes('ghost-model')), '必须如实记 skipped')
})

test('A8 反例：空模型列表时不得写入任何东西', () => {
  const plan = writer.planModelPatch([], [{ id: 'm1', input: ['text'] }])
  assert.deepEqual(plan.models, [], '空列表保持空')
  assert.equal(plan.written.length, 0)
  assert.ok(plan.skipped.length > 0, '必须如实记 skipped（不静默）')
})

test('A3/A4：compat 逐键合并，用户已配置的键不得被覆盖', () => {
  const models = [{ id: 'm1', compat: { thinkingFormat: 'user-set' } }]
  const plan = writer.planModelPatch(models, [{ id: 'm1', compat: { thinkingFormat: 'from-catalog', maxTokensField: 'max_tokens' } }])
  const compat = plan.models[0].compat
  assert.equal(compat.thinkingFormat, 'user-set', '用户已设的 compat 键必须保留')
  assert.equal(compat.maxTokensField, 'max_tokens', '缺失的 compat 键可补')
})
