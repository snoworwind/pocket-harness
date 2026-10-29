import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-control-ops.mjs')
const DEFAULT_OPS = ['click', 'snapshot']

function quoted(items) {
  return items.map((item) => `'${item}'`).join(', ')
}

function makeFixture({
  handleOps = DEFAULT_OPS,
  supportedOps = DEFAULT_OPS,
  controlOps = DEFAULT_OPS,
  a11yOps = DEFAULT_OPS,
  routeOps = ['click'],
  manageOps = DEFAULT_OPS,
  ledgerText = JSON.stringify({ families: [], pending: [] }),
  gaps = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'control-ops-gate-'))
  const shellRoot = join(root, 'shell')
  const pluginRoot = join(root, 'plugins')
  const shellDir = join(shellRoot, 'app/src/main/java/com/snoworwind/pocketharness')
  const bridgeDir = join(pluginRoot, 'plugins/dsh-android-bridge/src')
  const manageDir = join(pluginRoot, 'plugins/dsh-android-manage/src')
  for (const dir of [shellDir, bridgeDir, manageDir, join(root, 'scripts')]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(join(shellDir, 'DeviceControlService.kt'), [
    'internal fun handle(op: String, args: JSONObject) {',
    '  when (op) {',
    ...handleOps.map((op) => `    "${op}" -> Unit`),
    '    else -> error("unsupported")',
    '  }',
    '}',
  ].join('\n'))
  writeFileSync(join(shellDir, 'ControlProtocolV2.kt'),
    `val SUPPORTED_OPS = listOf(${quoted(supportedOps)})\n`)
  writeFileSync(join(shellDir, 'ControlCarrier.kt'), [
    "val BROWSER_OPS = setOf('browserFixture')",
    "val VD_OPS = setOf('vdFixture')",
    "val SHELL_OPS = setOf('shellFixture')",
  ].join('\n'))
  writeFileSync(join(bridgeDir, 'control-policy.ts'), [
    `export type ControlOp = ${controlOps.map((op) => `'${op}'`).join(' | ')}`,
    'export const A11Y_OPS = [',
    `  ${quoted(a11yOps)}`,
    '] as const',
  ].join('\n'))
  writeFileSync(join(bridgeDir, 'index.ts'), `const ROUTE_OPS = [${quoted(routeOps)}]\n`)
  writeFileSync(join(manageDir, 'index.ts'), [
    ...manageOps.map((op) => `a11yExec('${op}', {})`),
  ].join('\n'))
  const ledgerPath = join(root, 'scripts/control-ops-pending.json')
  writeFileSync(ledgerPath, ledgerText)
  const gapsPath = join(root, 'scripts/control-ops-known-gaps.json')
  writeFileSync(gapsPath, JSON.stringify({ gaps }, null, 2))

  return { root, shellRoot, pluginRoot, ledgerPath, gapsPath }
}

function run(fixture) {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--shell-root', fixture.shellRoot,
    '--plugin-root', fixture.pluginRoot,
    '--ledger', fixture.ledgerPath,
    '--gaps', fixture.gapsPath,
  ], { encoding: 'utf8' })
}

function withFixture(options, callback) {
  const fixture = makeFixture(options)
  try {
    callback(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

test('六面一致的临时树通过', () => withFixture({}, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /CHECK-CONTROL-OPS PASSED/)
}))

test('handle 与 SUPPORTED_OPS 漂移时判红', () => withFixture({ handleOps: ['click'] }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /handle 分支 == SUPPORTED_OPS/)
  assert.match(result.stdout, /snapshot/)
}))

test('ControlOp 漏登记时判红', () => withFixture({ controlOps: ['click'] }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /ControlOp == SUPPORTED_OPS/)
}))

test('A11Y_OPS 漏登记时判红', () => withFixture({ a11yOps: ['click'] }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /A11Y_OPS == ControlOp/)
}))

test('manage 工具面漏 op 时判红', () => withFixture({ manageOps: ['click'] }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /manage 工具面 == SUPPORTED_OPS/)
}))

test('ROUTE_OPS 不得包含 ControlOp 之外的 op', () => withFixture({ routeOps: ['click', 'unknown'] }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /ROUTE_OPS ⊂ ControlOp/)
}))

test('明确登记的 known-gap 只豁免指定面', () => withFixture({
  a11yOps: ['click'],
  gaps: [{ op: 'snapshot', faces: ['A11Y_OPS'], reason: '受控测试豁免' }],
}, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /WARN  A11Y_OPS 豁免 snapshot/)
}))

test('损坏的控制 op 台账 fail-closed', () => withFixture({ ledgerText: '{not-json' }, (fixture) => {
  const result = run(fixture)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /控制 op 台账可解析且含 families\/pending 段/)
}))

test('测试只改临时台账，不接触仓库中的真实台账', () => {
  const before = readFileSync(join(HERE, 'control-ops-pending.json'), 'utf8')
  withFixture({ ledgerText: '{broken' }, (fixture) => {
    run(fixture)
    assert.notEqual(fixture.ledgerPath, join(HERE, 'control-ops-pending.json'))
  })
  assert.equal(readFileSync(join(HERE, 'control-ops-pending.json'), 'utf8'), before)
})
