// 无障碍心跳与独立控制队列分别验证，队列取活不能证明无障碍服务在线。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A11Y_FRESH_MS, AndroidPrivilegeService } from '../lib/index.js'
import { ControlQueue } from '../lib/control-queue.js'

const saved = process.env.DSH_ADB_PREFS_PATH
after(() => {
  if (saved === undefined) delete process.env.DSH_ADB_PREFS_PATH
  else process.env.DSH_ADB_PREFS_PATH = saved
})

/** 队列陈旧（pollAgeMs 远超窗口）的替身：用于把「队列新鲜」这条口径排除掉。 */
const staleQueue = {
  pollAgeMs: () => 10 * 60 * 1000,
  stats: () => ({ waiting: false, served: 0, failed: 0, lastTakeAt: 0, lastResultAt: 0, protocol: { ok: true, shell: 1, engine: 2, reason: 'test' } }),
}

function prefs(inner) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-st23-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, '<map>\n' + inner + '</map>\n')
  process.env.DSH_ADB_PREFS_PATH = file
  return file
}

function service(queue) {
  return new AndroidPrivilegeService({}, () => 'danger-full-access', undefined, undefined, queue)
}

test('ST-23：心跳新鲜而队列陈旧 → 仍判在线，来源=heartbeat', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'heartbeat')
  assert.equal(svc.a11yEnabled(), true)
  const gates = svc.gateFacts()
  assert.equal(gates.a11yEnabled, true)
  assert.equal(gates.a11ySource, 'heartbeat')
})

test('ST-23：两条都陈旧 → 离线（fail-closed）', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() - 5 * 60 * 1000) + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'off')
  assert.equal(svc.a11yEnabled(), false)
  assert.equal(svc.gateFacts().a11ySource, 'off')
})

test('队列新鲜但无障碍心跳陈旧时不得误报在线', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() - 5 * 60 * 1000) + '" />\n')
  const queue = new ControlQueue()
  queue.enqueue('snapshot', {})
  queue.take()
  const svc = service(queue)
  assert.equal(svc.a11ySource(), 'off')
  assert.equal(svc.gateFacts().a11ySource, 'off')
  assert.equal(svc.a11yEnabled(), false)
})

test('ST-23：prefs 未声明 a11yEnabled → 离线，哪怕心跳很新', () => {
  prefs('<boolean name="a11yEnabled" value="false" />\n<long name="controlHeartbeat" value="' + Date.now() + '" />\n')
  const svc = service(staleQueue)
  assert.equal(svc.a11ySource(), 'off')
  assert.equal(svc.a11yEnabled(), false)
})

test('ST-23：无 prefs 文件 → 离线且队列在场也不假装在线', () => {
  process.env.DSH_ADB_PREFS_PATH = join(tmpdir(), 'definitely-missing-dsh-a11y.xml')
  const queue = new ControlQueue()
  queue.enqueue('snapshot', {})
  queue.take()
  const svc = service(queue)
  assert.equal(svc.a11ySource(), 'off')
  assert.equal(svc.a11yEnabled(), false)
})

test('ST-23：窗口常量是 20s', () => {
  assert.equal(A11Y_FRESH_MS, 20_000)
})

test('未来时间戳不能作为服务活跃证据', () => {
  prefs('<boolean name="a11yEnabled" value="true" />\n<long name="controlHeartbeat" value="' + (Date.now() + 60_000) + '" />\n')
  assert.equal(service(staleQueue).a11ySource(), 'off')
})
