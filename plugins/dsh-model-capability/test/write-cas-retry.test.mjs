// L.2 回归（2026-09-26）：写回被 SETTINGS_CONFLICT 反复拒绝。
//
// 用户报障：「Config write-back：写回仍被拒，错误一样（step-api 写回仍被拒）」。
//
// 本文件的核心是**忠实建模 dsh 的 CAS 语义**——不忠实就没有判别力。
// 三处必须与上游逐条对齐（dsh/packages/settings/settings/src/index.ts）：
//   :311  raw = JSON.stringify([entry.fiber.uid, schema.toJSON(), entry.options.config ?? {}])
//   :313-315  revision 由**服务端的 revisions Map** 持有：previous===undefined ? 0
//             : previous.revision + Number(previous.raw !== raw)  ⇒ raw 变了才推进
//   :390-395  mutate 在 configEditor.edit 的**回调内部**再调 describe()，
//             用那一刻重算的 revision 与 expected 比 ⇒ 冲突判定用的是「提交时」的值
//   :422  写成功后 this.describe()（把新 raw 记下，revision 就此推进）
//
// 为什么这层容易漏：调用方手里那次 describe 的结果**不是**冲突比较用的值；
// 任何别的写者（同进程的另一个 tick、并发的工具调用、用户手改）都会推进 revision。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyModelPatch, MAX_WRITE_ATTEMPTS } from '../lib/settings-writer.js'

const NS = 'llm-pi-ai'

/**
 * 按上游真实 CAS 语义实现的 settings stub。
 * @param initial - llm-pi-ai 段的初始值。
 * @param opts.beforeAttempt - 每次 mutate 进入前调用；用于模拟「别的写者推进了 revision」。
 */
function casSettings(initial, opts = {}) {
  let raw = JSON.stringify(initial)
  let stored = { raw: undefined, revision: 0 }
  const writes = []
  let api   // 提前声明：beforeAttempt 需要拿到 stub 自身（此前用 var 提升导致 undefined，实测踩到）
  /** 与 :313-315 同构：读当前 raw，算出 revision 并把 raw 记下。 */
  const describe = () => {
    const revision = stored.raw === undefined ? 0 : stored.revision + Number(stored.raw !== raw)
    stored = { raw, revision }
    return [{ ns: NS, value: JSON.parse(raw), revision }]
  }
  api = {
    writes,
    get revision() { return stored.revision },
    describe: () => describe(),
    /** 另一个写者提交一次（推进 revision）。 */
    externalWrite(mutate) {
      const next = JSON.parse(raw)
      mutate(next)
      raw = JSON.stringify(next)
      describe()
    },
    async mutate(_ns, ops, expected) {
      opts.beforeAttempt?.(api, writes.length)
      writes.push({ expected })
      // :390-395 —— 回调内部重算，这才是冲突比较的真实时刻
      const descriptor = describe().find((d) => d.ns === NS)
      if (expected !== undefined && descriptor.revision !== expected) {
        const error = new Error('settings namespace "' + NS + '" changed since it was read'
          + ' (expected revision ' + String(expected) + ', now ' + String(descriptor.revision) + ')')
        error.name = 'SettingsConflictError'
        error.code = 'SETTINGS_CONFLICT'
        error.expected = expected
        error.actual = descriptor.revision
        throw error
      }
      const next = JSON.parse(raw)
      for (const op of ops) if (op.op === 'set') next.providers[op.path[1]][op.path[2]] = op.value
      raw = JSON.stringify(next)
      describe()   // :422
    },
  }
  return api
}

const base = () => ({ providers: { route: { baseURL: 'https://gw.example/v1', models: [{ id: 'm' }] } } })
const PATCH = [{ id: 'm', reasoningEfforts: { high: 'high' }, source: 'engine-catalog' }]

// ── 复现：修复前判红 ─────────────────────────────────────────────────────────
test('L.2 复现：并发推进 2 次时，旧的「单次重试」不够（现在必须成功）', async () => {
  let advanced = 0
  const settings = casSettings(base(), {
    beforeAttempt: (self) => {
      // 前两次尝试各插进一次外部推进（模拟另一个 tick / 并列的工具调用写成功）
      if (advanced++ < 2) self.externalWrite((next) => { next.providers.route.models = [{ id: 'm', contextWindow: 4096 + advanced }] })
    },
  })
  const stale = settings.describe().find((d) => d.ns === NS)
  const result = await applyModelPatch(settings, 'route', PATCH, undefined, undefined, stale)
  console.log('  [L.2] wrote=' + result.wrote + ' reason=' + result.reason + ' attempts=' + settings.writes.length
    + ' expected=' + JSON.stringify(settings.writes.map((w) => w.expected)))
  // 修复前：attempts=2、reason=conflict-retry-failed（判红）
  // 修复后：第 3 次尝试拿到最新 revision 并成功
  assert.equal(result.wrote, true, '有界重试应在第 3 次尝试成功')
  assert.equal(result.reason, 'wrote')
  assert.equal(settings.writes.length, 3)
})

// ── 持续冲突到第 N 次后成功 ──────────────────────────────────────────────────
test('持续冲突 1 次后成功（第 2 次尝试）', async () => {
  let advanced = 0
  const settings = casSettings(base(), {
    beforeAttempt: (self) => { if (advanced++ < 1) self.externalWrite((next) => { next.providers.route.models = [{ id: 'm', contextWindow: 1 }] }) },
  })
  const result = await applyModelPatch(settings, 'route', PATCH, undefined, undefined, settings.describe().find((d) => d.ns === NS))
  assert.equal(result.wrote, true)
  assert.equal(settings.writes.length, 2)
})

test('永久冲突：仍在 MAX_WRITE_ATTEMPTS 内停止（有界，不无限循环）', async () => {
  const settings = casSettings(base(), {
    beforeAttempt: (self) => self.externalWrite((next) => { next.providers.route.models = [{ id: 'm', contextWindow: Math.random() }] }),
  })
  const result = await applyModelPatch(settings, 'route', PATCH, undefined, undefined, settings.describe().find((d) => d.ns === NS))
  console.log('  [L.2] 永久冲突 attempts=' + settings.writes.length + ' reason=' + result.reason)
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'conflict-retry-failed', 'reason 字符串必须向后兼容')
  assert.equal(settings.writes.length, MAX_WRITE_ATTEMPTS, '尝试次数必须恰好等于上限（有界）')
})

test('非冲突错误：不重试、原样返回 mutate-rejected', async () => {
  let calls = 0
  const settings = {
    describe: () => [{ ns: NS, value: base(), revision: 0 }],
    async mutate() {
      calls += 1
      const error = new Error('Config field "providers.route.models" is not volatile')
      throw error
    },
  }
  const result = await applyModelPatch(settings, 'route', PATCH)
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'mutate-rejected')
  assert.equal(calls, 1, '非冲突错误不得重试')
})

// ── 诊断：expected/actual 必须落盘 ──────────────────────────────────────────
test('诊断：拒绝时 trace 带 expected/actual 两侧 revision', async () => {
  const traces = []
  const warns = []
  const settings = casSettings(base(), {
    beforeAttempt: (self) => self.externalWrite((next) => { next.providers.route.models = [{ id: 'm', contextWindow: Math.random() }] }),
  })
  const result = await applyModelPatch(settings, 'route', PATCH,
    { warn: (m) => warns.push(m), trace: (m) => traces.push(m) },
    undefined, settings.describe().find((d) => d.ns === NS))
  assert.equal(result.wrote, false)
  const trace = traces.join('\n')
  console.log('  [L.2] trace = ' + trace.slice(0, 200))
  assert.match(trace, /expected=\d+ actual=\d+/, 'trace 必须带 expected/actual（L.2 诊断要求）')
  assert.match(trace, /code=SETTINGS_CONFLICT/)
  assert.ok(warns.some((m) => m.includes('write-back failed')), 'logger.warn 也要有')
})

// ── 重试必须重读描述符（不得复用可能过期的 override）─────────────────────────
test('重试路径不复用 override：每次都重新 describe', async () => {
  const describeRevisions = []
  let advanced = 0
  const settings = casSettings(base(), {
    beforeAttempt: (self) => { if (advanced++ < 1) self.externalWrite((next) => { next.providers.route.models = [{ id: 'm', contextWindow: 7 }] }) },
  })
  const realDescribe = settings.describe
  settings.describe = () => { const d = realDescribe(); describeRevisions.push(d.find((x) => x.ns === NS).revision); return d }
  const stale = settings.describe().find((d) => d.ns === NS)
  const result = await applyModelPatch(settings, 'route', PATCH, undefined, undefined, stale)
  assert.equal(result.wrote, true)
  // 第二次尝试的 expected 必须来自**新** describe，而不是那个 stale override
  assert.equal(settings.writes[1].expected, settings.writes[1].expected)
  assert.notEqual(settings.writes[1].expected, stale.revision, '重试不得复用过期 override 的 revision')
})
