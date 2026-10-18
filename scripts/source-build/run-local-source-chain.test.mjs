// run-local-source-chain 的阶段选择回归（审计 A09）。
//
// 反例的定义：`--from apk` / `--only apk` 必须同时选中 Build ARM64 APK 与构建之后的
// 最终复验（快照语义归一化 + APK 文件复验）。旧规则把未映射步骤一律归 misc（阶段索引 -1），
// 于是它们在 `from apk` 过滤时被判为「早于 apk」而漏掉——本文件的负控用生产计划的
// `stageSource` 元数据还原旧规则，确认那条规则会判红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { committedWorkflow, sourceCommit } from './local-source-workspace.mjs'
import { planSteps, selectPlanned } from './run-local-source-chain.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(import.meta.dirname, 'run-local-source-chain.mjs')
// 与生产脚本同源：用已提交的 workflow 字节，而不是测试进程当前工作树的可能改动。
const planned = planSteps(committedWorkflow(ROOT, sourceCommit(ROOT)))
const namesOf = (items) => items.map((item) => item.name)
const BUILD = 'Build ARM64 APK'
const FINAL = [
  'Snapshot semantic normalization digest',
  'Reverify final APK files before artifact upload',
]

test('planSteps：最终复验跟随 apk 阶段，而不是落入 misc', () => {
  const build = planned.find((item) => item.name === BUILD)
  assert.ok(build, '生产 workflow 里必须存在 Build ARM64 APK')
  assert.equal(build.stage, 'apk')
  for (const name of FINAL) {
    const item = planned.find((entry) => entry.name === name)
    assert.ok(item, `生产 workflow 里必须存在最终复验步骤：${name}`)
    assert.equal(item.stage, 'apk', `${name} 必须跟随构建所在阶段`)
    assert.equal(item.stageSource, 'inherited', `${name} 应通过阶段继承归类，而不是被硬塞进任意阶段`)
  }
  // 只有首个具名阶段之前的本地前置允许留在 misc；阶段开始后不得再有漏网步骤。
  assert.deepEqual(namesOf(planned.filter((item) => item.stage === 'misc')), [
    'Require the maintained source branch',
    'Isolate npm cache from checked-in developer settings',
  ])
  // Kotlin 单测门禁是 APK 步的前置输入；--to snapshot 不应顺带跑它，--only apk 必须带上它。
  assert.equal(planned.find((item) => item.name.startsWith('单元测试门禁前置'))?.stage, 'apk')
})

test('--from apk 与 --only apk 的选择都包含 Build ARM64 APK 和最终复验', () => {
  for (const options of [{ from: 'apk' }, { only: 'apk' }]) {
    const selected = namesOf(selectPlanned(planned, options))
    for (const name of [BUILD, ...FINAL]) {
      assert.ok(selected.includes(name), `${JSON.stringify(options)} 漏选：${name}`)
    }
    assert.ok(!selected.includes('Build runtime snapshot from verified inputs'), 'apk 阶段不应重跑快照构建')
  }
  // --to snapshot 停在快照阶段，不能顺带跑 APK 前才会用到的单测门禁。
  const toSnapshot = namesOf(selectPlanned(planned, { to: 'snapshot' }))
  assert.ok(!toSnapshot.includes(FINAL[0]) && !toSnapshot.includes(FINAL[1]))
  assert.ok(!toSnapshot.some((name) => name.startsWith('单元测试门禁前置')))
  // --from snapshot 会继续到 apk，最终复验同样不能漏。
  const fromSnapshot = namesOf(selectPlanned(planned, { from: 'snapshot' }))
  assert.ok(FINAL.every((name) => fromSnapshot.includes(name)))
  // --from-step 仍按 --list 序号选择，不受阶段继承影响。
  const last = planned.findIndex((item) => item.name === FINAL[1])
  assert.deepEqual(namesOf(selectPlanned(planned, { fromStep: last })), [FINAL[1]])
})

test('负控：旧规则（未映射即 misc）会漏掉最终复验并判红', () => {
  // 旧规则的唯一差异就是「继承」不存在：所有 inherited 步骤回退成 misc。
  // 这里不复制阶段映射，只消费生产计划给出的 stageSource。
  const legacy = planned.map((item) => item.stageSource === 'inherited'
    ? { ...item, stage: 'misc', stageSource: 'pre-stage' }
    : item)
  const legacySelected = namesOf(selectPlanned(legacy, { from: 'apk' }))
  assert.throws(() => {
    for (const name of [BUILD, ...FINAL]) {
      assert.ok(legacySelected.includes(name), `旧规会漏选：${name}`)
    }
  }, /旧规会漏选：Snapshot semantic normalization digest/)
})

test('真实 CLI：--dry-run --from apk / --only apk 的输出都含最终复验', () => {
  for (const args of [['--from', 'apk'], ['--only', 'apk']]) {
    const result = spawnSync(process.execPath, [SCRIPT, '--dry-run', ...args], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    for (const name of [BUILD, ...FINAL]) {
      assert.ok(result.stdout.includes(name), `${args.join(' ')} 输出缺少：${name}\n${result.stdout}`)
    }
  }
})
