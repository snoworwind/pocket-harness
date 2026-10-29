import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-tool-surface-budget.mjs')
const PLUGINS = [
  'dsh-android-bridge',
  'dsh-android-manage',
  'dsh-android-browser',
  'dsh-android-vdisplay',
  'dsh-android-file-open',
  'dsh-android-linux-env',
  'dsh-model-capability',
]
const BRIDGE_LIB = ['plugins', 'dsh-android-bridge', 'lib', 'index.js']

function tool(plugin, name, description = 'fixture') {
  return `  ctx.tools.register({ name: '${name}', description: '${description}', parameters: {} })`
}

function pluginSource(plugin, { extraNames = [], description = 'fixture', duplicateName = null } = {}) {
  const names = plugin === 'dsh-android-bridge'
    ? ['android_capabilities', 'android_screen_list', ...extraNames]
    : [duplicateName ?? `android_${plugin.replace(/^dsh-android-/, '').replaceAll('-', '_')}_tool`, ...extraNames]
  return [
    ...(plugin === 'dsh-android-bridge' ? [
      "export const DEVICE_TOOL_GROUPS = { screen: ['android_screen_list'] }",
      "export const CAPABILITY_TOOL_NAME = 'android_capabilities'",
    ] : []),
    'export function apply(ctx) {',
    ...names.map((name) => tool(plugin, name, description)),
    '}',
  ].join('\n')
}

function bridgeSource({ groups, facade = 'android_capabilities', names = ['android_capabilities', 'android_screen_list'] }) {
  return [
    'export const DEVICE_TOOL_GROUPS = ' + JSON.stringify(groups),
    `export const CAPABILITY_TOOL_NAME = '${facade}'`,
    'export function apply(ctx) {',
    ...names.map((name) => tool('bridge', name)),
    '}',
  ].join('\n')
}

function makeTree(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tool-surface-budget-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const plugin of PLUGINS) {
    const lib = join(root, 'plugins', plugin, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(root, 'plugins', plugin, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(lib, 'index.js'), overrides[plugin] ?? pluginSource(plugin))
  }
  return root
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

function withTree(callback) {
  const root = makeTree()
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function seedBaseline(root) {
  const result = run(root, ['--update'])
  assert.equal(result.status, 0, result.out)
  return result
}

function inflateBaseline(root, factor = 1.5) {
  const file = join(root, 'scripts', 'tool-surface-budget.json')
  const baseline = JSON.parse(readFileSync(file, 'utf8'))
  baseline.baseline = Math.ceil(baseline.baseline * factor)
  baseline.initialVisible = Math.ceil(baseline.initialVisible * factor)
  writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n')
}

test('基线一致的临时插件树通过并打印两个预算口径', () => withTree((root) => {
  seedBaseline(root)
  const result = run(root)
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /CHECK-TOOL-SURFACE-BUDGET PASSED/)
  assert.match(result.out, /注册集 \d+ B \/ 基线 \d+ B/)
  assert.match(result.out, /可见集名单 == 登记/)
}))

test('工具描述超过 +2% 阈值时注册集判红', () => withTree((root) => {
  seedBaseline(root)
  writeFileSync(join(root, 'plugins/dsh-android-manage/lib/index.js'),
    pluginSource('dsh-android-manage', { description: 'x'.repeat(500) }))
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /超预算（注册集）/)
}))

test('字节有余量时新增可见工具仍被名字级判据拦住', () => withTree((root) => {
  seedBaseline(root)
  inflateBaseline(root)
  writeFileSync(join(root, 'plugins/dsh-android-browser/lib/index.js'),
    pluginSource('dsh-android-browser', { extraNames: ['android_new'] }))
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.doesNotMatch(result.out, /超预算/, '必须留有字节余量，证明触发的是名字级判据')
  assert.match(result.out, /模型第一眼新增工具（未经判定）：android_new/)
}))

test('掩蔽组引用未注册工具时判红', () => withTree((root) => {
  seedBaseline(root)
  writeFileSync(join(root, ...BRIDGE_LIB), bridgeSource({
    groups: { screen: ['android_screen_list', 'android_ghost'] },
  }))
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /掩蔽清单里有未注册的工具名/)
  assert.match(result.out, /android_ghost/)
}))

test('常驻能力 facade 被掩蔽时判红', () => withTree((root) => {
  seedBaseline(root)
  writeFileSync(join(root, ...BRIDGE_LIB), bridgeSource({
    groups: { screen: ['android_screen_list', 'android_capabilities'] },
  }))
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /常驻 facade 不在初始可见集/)
}))

test('跨插件重复工具名判红', () => withTree((root) => {
  seedBaseline(root)
  writeFileSync(join(root, 'plugins/dsh-android-vdisplay/lib/index.js'),
    pluginSource('dsh-android-vdisplay', { duplicateName: 'android_capabilities' }))
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /模型面工具名重复/)
}))

test('缺基线时拒绝并提供 --update 修法', () => withTree((root) => {
  const result = run(root)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /缺少基线文件 .*tool-surface-budget\.json/)
}))

test('--update 只写临时根目录的基线，重跑后通过', () => withTree((root) => {
  const seeded = run(root, ['--update'])
  assert.equal(seeded.status, 0, seeded.out)
  const baseline = JSON.parse(readFileSync(join(root, 'scripts/tool-surface-budget.json'), 'utf8'))
  assert.equal(typeof baseline.baseline, 'number')
  assert.ok(Array.isArray(baseline.visibleTools))
  const result = run(root)
  assert.equal(result.status, 0, result.out)
}))
