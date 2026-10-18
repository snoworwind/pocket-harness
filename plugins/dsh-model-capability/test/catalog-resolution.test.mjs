// A4/A5 查找语义回归（0.14.6 功能 A）：L1 精确 -> L2 大小写折叠 -> L3 分隔符折叠 -> L4 not-found。
//
// 判据（Lead 2026-10-11 定死，命中即停）：
//   L1 精确 id 匹配（原样、区分大小写）-> 命中即用。
//   L2 折叠大小写 -> **当且仅当恰好 1 个候选**时使用；>=2 判歧义，不补齐。
//   L3 在 L2 基础上折叠常见分隔符（- _ . / 空格）-> **当且仅当恰好 1 个候选**时使用；>=2 判歧义，不补齐。
//   L4 都不成立 -> 不补齐，记录原因（not-found / ambiguous(N)）。
//
// 为什么「>=2 就判歧义、绝不任取一条」：实测出货目录 1046 个键里有 **37 组**仅大小写不同的
// 重复键，且 **37 组的两形态 capabilities 全都不同**（例：moonshotai/Kimi-K2.5 的 baseten 形态
// 有 thinkingLevelMap 与 thinkingFormat=baseten，huggingface 形态两者皆无，contextWindow 也不同）。
// 补错能力值（写出与真实网关不符的思考档位）比不补更坏：用户无法察觉。
//
// 本文件用**合成夹具**做语义断言（确定、与出货目录解耦），另在出货目录在场时追加真实目录断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { lookupCatalog } from '../lib/catalog-lookup.js'

// 与 t1-poll-cost.test.mjs 同款：lib/catalog-snapshot.json 是构建期产物，净检出（CI）里缺席。
// 缺席时用最小夹具补上，使 CI 与本地同形真跑。
//
// **写一次、永不删除**（2026-10-11 竞态实锤）：`node --test test/*.test.mjs` 把**每个文件放进
// 独立进程并行跑**，而本仓有 4 个文件共用这同一条快照路径。旧实现「谁写的谁删（after/exit 里
// rmSync）」于是出现：进程 A 跑完删掉文件，进程 B 正要读 -> ENOENT，**同一份代码时绿时红**
// （实测净检出下 8 次里失败 1 次；4 个写入者时 8 次里失败 5 次）。
// 不删是安全的，四条依据：① 各写入者内容**完全相同**（同一 FIXTURE），谁先落盘都一样；
// ② 真快照由 build-snapshot-013.mjs 在构建时**无条件重新生成**，留着的夹具必被覆盖；
// ③ check-patch-mirror.mjs 第 392 行**显式跳过**该路径，不影响双仓镜像比对；
// ④ .gitignore:19 `plugins/*/lib/` 已忽略 lib/，它永远不会被提交。
// 写入用「临时文件 + rename」而非直接 copyFileSync：rename 在同文件系统上是原子的，
// 读者要么看到完整文件、要么看不到，绝不会读到半截内容。
const SNAPSHOT = new URL('../lib/catalog-snapshot.json', import.meta.url)
const FIXTURE = new URL('./fixtures/catalog-snapshot.min.json', import.meta.url)
if (!existsSync(SNAPSHOT)) {
  const tmp = new URL(`${SNAPSHOT.pathname}.${process.pid}.tmp`, 'file:')
  copyFileSync(FIXTURE, tmp)
  try { renameSync(tmp, SNAPSHOT) } catch { /* 另一进程已抢先落盘（内容相同） */ }
  finally { try { rmSync(tmp, { force: true }) } catch { /* 已被 rename 移走 */ } }
}

const catalog = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
const CATALOG_KEYS = Object.keys(catalog.models ?? {})
/** 出货目录（1046 键）在场时为真：最小夹具只有 1 个键，真实目录断言据此前置。 */
const HAS_FULL_CATALOG = CATALOG_KEYS.length > 1000

// ── L1：精确命中优先，且**绝不**被折叠层抢走 ─────────────────────────────────
test('L1 精确命中原样采用（区分大小写，不折叠）', () => {
  const snapshot = { models: {
    'Only/Upper': [{ provider: 'upper', api: 'openai-completions', contextWindow: 111 }],
    'only/upper': [{ provider: 'lower', api: 'openai-completions', contextWindow: 222 }],
  } }
  const a = lookupCatalog(snapshot, 'Only/Upper')
  assert.equal(a.resolution, 'exact')
  assert.deepEqual(a.providers, ['upper'])
  assert.equal(a.capabilities.contextWindow, 111)
  const b = lookupCatalog(snapshot, 'only/upper')
  assert.equal(b.resolution, 'exact')
  assert.deepEqual(b.providers, ['lower'])
  assert.equal(b.capabilities.contextWindow, 222)
})

test('L1 反例：L2/L3 折叠层不得抢在 L1 之前（本来精确可判的输入不得退化成歧义）', () => {
  // 两个键在分隔符折叠下同键，但查询恰好精确等于其一 -> 必须走 L1、给唯一确定结果。
  const snapshot = { models: {
    'anthropic.claude-opus-4-7': [{ provider: 'dotted', api: 'openai-completions', contextWindow: 200000 }],
    'anthropic/claude-opus-4.7': [{ provider: 'slashed', api: 'openai-completions', contextWindow: 1000000 }],
  } }
  const m = lookupCatalog(snapshot, 'anthropic.claude-opus-4-7')
  assert.equal(m.resolution, 'exact', '精确键被折叠层抢走了')
  assert.deepEqual(m.providers, ['dotted'])
  assert.equal(m.capabilities.contextWindow, 200000)
})

// ── L2：大小写折叠 ───────────────────────────────────────────────────────────
test('L2 折叠大小写后恰好 1 个候选：采用该唯一候选', () => {
  const snapshot = { models: {
    'Only/One-Model': [{ provider: 'p', api: 'openai-completions', thinkingLevelMap: { high: 'high' }, contextWindow: 42 }],
  } }
  const m = lookupCatalog(snapshot, 'only/one-model')
  assert.equal(m.resolution, 'case-folded')
  assert.deepEqual(m.providers, ['p'])
  assert.deepEqual(m.capabilities.reasoningEfforts, { high: 'high' })
  assert.equal(m.capabilities.contextWindow, 42)
})

test('L2 反例 折叠大小写后 >=2 个候选：判歧义、不补齐任何字段', () => {
  const snapshot = { models: {
    'qwen/qwen3.6-27b': [{ provider: 'low', api: 'openai-completions', thinkingLevelMap: { high: 'high' }, contextWindow: 262144 }],
    'Qwen/Qwen3.6-27B': [{ provider: 'up', api: 'openai-completions', contextWindow: 131072 }],
  } }
  const m = lookupCatalog(snapshot, 'QWEN/QWEN3.6-27B')
  assert.equal(m.resolution, 'ambiguous')
  assert.deepEqual(m.capabilities, {}, '歧义时必须一个字段都不写')
  assert.deepEqual(m.providers, [])
  assert.deepEqual(m.ambiguousIds, ['Qwen/Qwen3.6-27B', 'qwen/qwen3.6-27b'])
  assert.ok(m.conflicts.some((c) => c.includes('身份不确定')), '必须如实记录歧义原因')
})

// ── L3：分隔符折叠 ───────────────────────────────────────────────────────────
test('L3 再折叠分隔符后恰好 1 个候选：采用该唯一候选', () => {
  const snapshot = { models: {
    'anthropic/claude-opus-4.7': [{ provider: 'slashed', api: 'openai-completions', contextWindow: 1000000 }],
  } }
  const m = lookupCatalog(snapshot, 'anthropic claude opus 4-7')
  assert.equal(m.resolution, 'separator-folded')
  assert.deepEqual(m.providers, ['slashed'])
  assert.equal(m.capabilities.contextWindow, 1000000)
})

test('L3 反例 分隔符折叠后 >=2 个候选：判歧义、不补齐', () => {
  const snapshot = { models: {
    'anthropic.claude-opus-4-7': [{ provider: 'dotted', api: 'openai-completions', contextWindow: 200000 }],
    'anthropic/claude-opus-4.7': [{ provider: 'slashed', api: 'openai-completions', contextWindow: 1000000 }],
  } }
  const m = lookupCatalog(snapshot, 'anthropic claude opus 4-7')
  assert.equal(m.resolution, 'ambiguous')
  assert.deepEqual(m.capabilities, {}, '分隔符折叠歧义时必须一个字段都不写')
  assert.deepEqual(m.ambiguousIds, ['anthropic.claude-opus-4-7', 'anthropic/claude-opus-4.7'])
})

// ── L4：都不成立 ─────────────────────────────────────────────────────────────
test('L4 目录无此模型：not-found，不得凭空补齐', () => {
  const snapshot = { models: { 'known-a': [{ provider: 'p', api: 'openai-completions', contextWindow: 1 }] } }
  const m = lookupCatalog(snapshot, 'totally-unknown-model')
  assert.equal(m.resolution, 'not-found')
  assert.deepEqual(m.capabilities, {})
  assert.deepEqual(m.providers, [])
})

test('L4 全是分隔符的 id 不得匹配「也折叠成空」的键（空名不是模型名）', () => {
  const snapshot = { models: { '---': [{ provider: 'weird', api: 'openai-completions', contextWindow: 7 }] } }
  const m = lookupCatalog(snapshot, '...')
  assert.equal(m.resolution, 'not-found')
  assert.deepEqual(m.capabilities, {})
})

// ── 原型链硬化：用户可控 id 不得取到 Object.prototype 成员 ────────────────────
test('原型链硬化：constructor/toString/__proto__/hasOwnProperty/valueOf 均判 not-found 且不抛', () => {
  const snapshot = { models: { 'real-model': [{ provider: 'p', api: 'openai-completions', contextWindow: 1 }] } }
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    let m
    assert.doesNotThrow(() => { m = lookupCatalog(snapshot, id) }, 'id=' + id + ' 抛异常')
    assert.equal(m.resolution, 'not-found', 'id=' + id + ' 未判 not-found（取到了原型链成员）')
    assert.deepEqual(m.capabilities, {}, 'id=' + id + ' 写出了能力')
    assert.deepEqual(m.providers, [])
  }
})

// ── 版本区分不回归 ───────────────────────────────────────────────────────────
test('版本区分：同名不同版本不得互相匹配（L1 精确，版本号是 id 的一部分）', () => {
  const snapshot = { models: {
    'MiniMax-M2.7': [{ provider: 'v2-7', api: 'openai-completions', contextWindow: 270 }],
    'MiniMax-M3': [{ provider: 'v3', api: 'openai-completions', contextWindow: 300 }],
    'MiniMax-M2.5': [{ provider: 'v2-5', api: 'openai-completions', contextWindow: 250 }],
  } }
  assert.deepEqual(lookupCatalog(snapshot, 'MiniMax-M2.7').providers, ['v2-7'])
  assert.deepEqual(lookupCatalog(snapshot, 'MiniMax-M3').providers, ['v3'])
  assert.deepEqual(lookupCatalog(snapshot, 'MiniMax-M2.5').providers, ['v2-5'])
  // 版本不在目录里 -> not-found（不得退化成「取最近的版本」）
  const miss = lookupCatalog(snapshot, 'MiniMax-M4')
  assert.equal(miss.resolution, 'not-found')
  assert.deepEqual(miss.capabilities, {})
})

// ── 确定性：与 JSON 键序无关 ─────────────────────────────────────────────────
test('确定性：打乱目录键序后同 id 的结果逐字相同（含两形态冲突键）', () => {
  const base = { models: {
    'qwen/qwen3.6-27b': [{ provider: 'low', api: 'openai-completions', contextWindow: 262144 }],
    'Qwen/Qwen3.6-27B': [{ provider: 'up', api: 'openai-completions', contextWindow: 131072 }],
    'plain-model': [{ provider: 'p', api: 'openai-completions', contextWindow: 8 }],
  } }
  const ids = ['qwen/qwen3.6-27b', 'Qwen/Qwen3.6-27B', 'QWEN/QWEN3.6-27B', 'plain-model', 'nope']
  const forward = ids.map((id) => JSON.stringify(lookupCatalog(base, id)))
  const reversed = { models: Object.fromEntries(Object.entries(base.models).reverse()) }
  const backward = ids.map((id) => JSON.stringify(lookupCatalog(reversed, id)))
  assert.deepEqual(backward, forward, '键序改变影响了查找结果（非确定性）')
})

// ── 真实出货目录断言（仅完整目录在场时）──────────────────────────────────────
test('真实目录：仅大小写不同的冲突组各两形态能力不同 => 折叠层必须一律判歧义', (t) => {
  if (!HAS_FULL_CATALOG) {
    t.diagnostic('最小夹具在场（键数=' + CATALOG_KEYS.length + '），跳过出货目录规模断言')
    return
  }
  const groups = new Map()
  for (const key of CATALOG_KEYS) {
    const folded = key.toLowerCase()
    if (!groups.has(folded)) groups.set(folded, [])
    groups.get(folded).push(key)
  }
  const collisions = [...groups.values()].filter((g) => g.length > 1)
  let differing = 0
  for (const group of collisions) {
    if (new Set(group.map((k) => JSON.stringify(catalog.models[k]))).size > 1) differing += 1
  }
  t.diagnostic('keys=' + CATALOG_KEYS.length + ' caseCollisions=' + collisions.length + ' differing=' + differing)
  assert.equal(collisions.length, 37, '出货目录大小写冲突组数变了（证据基线为 37）')
  assert.equal(differing, 37, '存在两形态能力相同的大小写冲突组（折叠层可安全取其一？需重新裁决）')
  // 逐组扫一遍：任何**不精确等于**组内键的写法都必须判歧义，且一个字段都不写。
  // 候选写法取「逐字符换大小写」；排除恰好精确命中的那些（那是 L1 的正当结果）。
  const swapCase = (text) => [...text].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('')
  let ambiguousChecked = 0
  for (const group of collisions) {
    const keys = new Set(group)
    const candidates = [...new Set([swapCase(group[0]), group[0].toUpperCase(), group[0].toLowerCase()])]
      .filter((candidate) => !keys.has(candidate))
    assert.ok(candidates.length > 0, '组 ' + JSON.stringify(group) + ' 构造不出「非精确」写法（判据无判别力）')
    for (const candidate of candidates) {
      const m = lookupCatalog(catalog, candidate)
      assert.equal(m.resolution, 'ambiguous',
        '组 ' + JSON.stringify(group) + ' 的写法 ' + candidate + ' 未判歧义（实得 ' + m.resolution + '）')
      assert.deepEqual(m.capabilities, {}, '组 ' + JSON.stringify(group) + ' 写法 ' + candidate + ' 歧义却写出了字段')
      ambiguousChecked += 1
    }
  }
  t.diagnostic('ambiguousThirdSpellingsChecked=' + ambiguousChecked)
})

test('真实目录：全量键在键序打乱后结果逐字不变', (t) => {
  if (!HAS_FULL_CATALOG) {
    t.diagnostic('最小夹具在场，跳过全量键序断言')
    return
  }
  const reversed = { models: Object.fromEntries(Object.entries(catalog.models).reverse()) }
  const rotatedEntries = [...Object.entries(catalog.models).slice(500), ...Object.entries(catalog.models).slice(0, 500)]
  const rotated = { models: Object.fromEntries(rotatedEntries) }
  let mismatches = 0
  for (const key of CATALOG_KEYS) {
    const a = JSON.stringify(lookupCatalog(catalog, key))
    if (a !== JSON.stringify(lookupCatalog(reversed, key))) mismatches += 1
    if (a !== JSON.stringify(lookupCatalog(rotated, key))) mismatches += 1
  }
  t.diagnostic('checked=' + CATALOG_KEYS.length + ' mismatches=' + mismatches)
  assert.equal(mismatches, 0, '键序影响了 ' + mismatches + ' 个键的查找结果')
})

test('真实目录：原型链 id 不得取到任何条目', (t) => {
  if (!HAS_FULL_CATALOG) {
    t.diagnostic('最小夹具在场，跳过真实目录原型链断言')
    return
  }
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    let m
    assert.doesNotThrow(() => { m = lookupCatalog(catalog, id) }, 'id=' + id + ' 在真实目录上抛异常')
    assert.equal(m.resolution, 'not-found')
    assert.deepEqual(m.capabilities, {})
  }
})
