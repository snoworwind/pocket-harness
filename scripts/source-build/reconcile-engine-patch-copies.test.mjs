#!/usr/bin/env node
// reconcile-engine-patch-copies 的判别力用例。
//
// 成因回顾（设备实锤）：pnpm 布局下同一包有顶层物化副本与 `.pnpm/**` store 副本，
// 引擎补丁只按登记表的顶层 target 写入 ⇒ store 副本保持原样；运行时若从 store 解析
// （`node-addon-require-builtin` 就是这样），加载到的是**未打补丁**的代码 ⇒ 引擎 boot 硬崩。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ARKWEB_RESOURCE_UI_SNAPSHOT_ANCHOR,
  collectPhysicalFiles,
  enginePatchTargets,
  EXTERNAL_DRAFT_UI_SNAPSHOT_ANCHOR,
  matchesPatchTarget,
  PERMISSION_AUTO_UI_SNAPSHOT_ANCHOR,
  REFERENCE_DRILL_UI_SNAPSHOT_ANCHOR,
  reconcileEnginePatchCopies,
  SIDEBAR_REORDER_UI_SNAPSHOT_ANCHOR,
  verifyCanonicalEnginePatch,
  WORKSPACE_WRITE_UI_SNAPSHOT_ANCHOR,
} from './reconcile-engine-patch-copies.mjs'
import { planMimoThinking } from '../patches/mimo-thinking-toggle-056.mjs'
import {
  AUTO_REVIEW_HIGH_DENY_MARKER,
  PERMISSION_AUTO_DEFAULT_MARKER,
  PERMISSION_AUTO_UI_MARKER,
  patchPermissionPresetsClientAutoDefault,
} from '../patches/data/permission-auto-review-default.mjs'
import { patchWorkspaceWriteBoundaryWarning, WORKSPACE_WRITE_WARNING_MARKER } from '../patches/data/workspace-write-boundary-warning.mjs'
import { versionedFixture } from '../patches/tests/lib/fixture.mjs'

const PREFIX = 'usr/lib/node_modules/@deepseek-ai/dsh'
const MARKER = 'dsh-mobile native-binding fallback (N1)'
const registry = {
  patches: [{
    id: 'narb-android-N1',
    scope: 'engine',
    target: `${PREFIX}/node_modules/node-addon-require-builtin/lib/index.js`,
    marker: MARKER,
  }],
}

test('MiMo canonical verifier accepts both patched files and rejects a partial patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimo-source-verifier-'))
  try {
    const engine = join(root, PREFIX)
    const dshRel = 'node_modules/@deepseek-ai/dsh-llm-pi-ai'
    const piRel = 'node_modules/@earendil-works/pi-ai'
    const dshSource = readFileSync(versionedFixture('dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8').replaceAll('\r\n', '\n')
    const inputs = [
      ['package.json', readFileSync(versionedFixture('dsh-root', 'package.json'), 'utf8')],
      [dshRel + '/lib/index.js', dshSource],
      [piRel + '/dist/api/openai-completions.js', readFileSync(versionedFixture('pi-ai', 'dist', 'api', 'openai-completions.js'), 'utf8').replaceAll('\r\n', '\n')],
      [dshRel + '/package.json', readFileSync(versionedFixture('dsh-llm-pi-ai', 'package.json'), 'utf8')],
      [piRel + '/package.json', readFileSync(versionedFixture('pi-ai', 'package.json'), 'utf8')],
    ]
    for (const [rel, text] of inputs) {
      const path = join(engine, rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    const read = file => readFileSync(join(root, file), 'utf8')
    for (const item of planMimoThinking(read)) writeFileSync(join(root, item.file), item.after)
    const patch = { id: 'mimo-thinking-toggle-056', verifier: 'mimo-thinking-toggle-056' }
    assert.doesNotThrow(() => verifyCanonicalEnginePatch(engine, patch))
    writeFileSync(join(engine, dshRel, 'lib/index.js'), dshSource)
    assert.throws(() => verifyCanonicalEnginePatch(engine, patch), /incomplete canonical engine patch/)
    assert.throws(() => verifyCanonicalEnginePatch(engine, { id: 'unknown', verifier: 'unknown' }), /unknown engine patch verifier/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Auto Review multi-file reconciliation checks each target with its own marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-auto-review-targets-'))
  try {
    const engine = join(root, PREFIX)
    const patch = JSON.parse(readFileSync('scripts/patches/registry.json', 'utf8')).patches
      .find((item) => item.id === 'permission-auto-review-default-AR1')
    assert.ok(patch)
    const expanded = enginePatchTargets(patch)
    assert.deepEqual(expanded.map(({ target, marker }) => [target, marker]), [
      [patch.target, PERMISSION_AUTO_DEFAULT_MARKER],
      [patch.additionalTargets[0], AUTO_REVIEW_HIGH_DENY_MARKER],
      [patch.additionalTargets[1], PERMISSION_AUTO_UI_SNAPSHOT_ANCHOR],
    ])

    const clientFixture = versionedFixture('dsh-client-ui-permission-presets', 'lib', 'client.js')
    const patchedClient = patchWorkspaceWriteBoundaryWarning(
      patchPermissionPresetsClientAutoDefault(readFileSync(clientFixture, 'utf8')),
    )
    // The browser syntax-floor transform removes explanatory comments. Model
    // that output shape without requiring esbuild during the early source-test job.
    const transformedClient = patchedClient.split('\n')
      .filter(line => !line.includes(PERMISSION_AUTO_UI_MARKER) && !line.includes(WORKSPACE_WRITE_WARNING_MARKER))
      .join('\n')
    assert.ok(patchedClient.includes(PERMISSION_AUTO_UI_MARKER), 'apply-patches marker is present before browser syntax transform')
    assert.ok(patchedClient.includes(WORKSPACE_WRITE_WARNING_MARKER))
    assert.ok(!transformedClient.includes(PERMISSION_AUTO_UI_MARKER), 'post-transform snapshot omits the Auto UI comment marker')
    assert.ok(!transformedClient.includes(WORKSPACE_WRITE_WARNING_MARKER), 'post-transform snapshot omits the Workspace Write comment marker')
    assert.ok(transformedClient.includes(PERMISSION_AUTO_UI_SNAPSHOT_ANCHOR), 'the reviewed behavior anchor survives the transform')
    assert.ok(transformedClient.includes(WORKSPACE_WRITE_UI_SNAPSHOT_ANCHOR))

    for (const { target, marker } of expanded) {
      const file = join(engine, target.slice(PREFIX.length + 1))
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, target === patch.additionalTargets[1] ? transformedClient : `// ${marker}\n`)
    }
    const workspacePatch = JSON.parse(readFileSync('scripts/patches/registry.json', 'utf8')).patches
      .find((item) => item.id === 'workspace-write-boundary-warning-WW1')
    assert.ok(workspacePatch)
    const browserPatchIds = {
      'sidebar-bubble-reorder-B1': [
        `${PREFIX}/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`,
        SIDEBAR_REORDER_UI_SNAPSHOT_ANCHOR,
      ],
      'external-draft-conversation-seam-J1': [
        `${PREFIX}/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`,
        EXTERNAL_DRAFT_UI_SNAPSHOT_ANCHOR,
      ],
      'arkweb-resource-protocol-H1': [
        `${PREFIX}/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js`,
        ARKWEB_RESOURCE_UI_SNAPSHOT_ANCHOR,
      ],
      'reference-drill-F6': [
        `${PREFIX}/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/client.js`,
        REFERENCE_DRILL_UI_SNAPSHOT_ANCHOR,
      ],
    }
    const allPatches = JSON.parse(readFileSync('scripts/patches/registry.json', 'utf8')).patches
    for (const [id, [target, anchor]] of Object.entries(browserPatchIds)) {
      const browserPatch = allPatches.find((item) => item.id === id)
      assert.ok(browserPatch, `missing registered browser patch ${id}`)
      assert.deepEqual(enginePatchTargets(browserPatch).map(({ target: found, marker }) => [found, marker]), [[target, anchor]])
    }

    const report = reconcileEnginePatchCopies(engine, { patches: [patch, workspacePatch] })
    assert.equal(report.patchCount, 4)
    assert.equal(report.reconciledCopyCount, 0)

    const uiTarget = join(engine, patch.additionalTargets[1].slice(PREFIX.length + 1))
    writeFileSync(uiTarget, transformedClient.replace(PERMISSION_AUTO_UI_SNAPSHOT_ANCHOR, 'select(AUTO_REVIEW_PRESET)'))
    assert.throws(() => reconcileEnginePatchCopies(engine, { patches: [patch] }), /补丁完全没打上/)

    writeFileSync(uiTarget, transformedClient.replace(WORKSPACE_WRITE_UI_SNAPSHOT_ANCHOR, 'if (false)'))
    assert.throws(() => reconcileEnginePatchCopies(engine, { patches: [workspacePatch] }), /补丁完全没打上/)

    assert.throws(() => enginePatchTargets({
      ...patch,
      additionalTargets: [...patch.additionalTargets, `${PREFIX}/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/new.js`],
    }), /target-specific marker/)
    assert.throws(() => enginePatchTargets({
      id: 'unreviewed-browser-client-patch',
      target: `${PREFIX}/node_modules/example/lib/client.js`,
      scope: 'engine',
      marker: 'comment marker removed by syntax transform',
    }), /no reviewed post-transform anchor/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-copies-'))
  const engine = join(root, PREFIX)
  // 顶层物化副本：已打补丁
  mkdirSync(join(engine, 'node_modules/node-addon-require-builtin/lib'), { recursive: true })
  writeFileSync(join(engine, 'node_modules/node-addon-require-builtin/lib/index.js'),
    `const x = 1;\n// ${MARKER}\n`)
  // store 副本：未打补丁（与设备实测同形）
  mkdirSync(join(engine, 'node_modules/.pnpm/node-addon-require-builtin@0.1.6/node_modules/node-addon-require-builtin/lib'), { recursive: true })
  writeFileSync(join(engine, 'node_modules/.pnpm/node-addon-require-builtin@0.1.6/node_modules/node-addon-require-builtin/lib/index.js'), 'const x = 1;\n')
  return { root, engine }
}

test('只按「同包 + 同包内相对路径」识别副本，不误伤同名不同包', () => {
  // 匹配器只吃「相对引擎根的路径」（引擎根 = @deepseek-ai/dsh 目录本身）
  const target = 'node_modules/node-addon-require-builtin/lib/index.js'
  assert.equal(matchesPatchTarget(target, target), true, '顶层副本必须算')
  assert.equal(matchesPatchTarget('node_modules/.pnpm/node-addon-require-builtin@0.1.6/node_modules/node-addon-require-builtin/lib/index.js', target), true, 'store 副本必须算')
  assert.equal(matchesPatchTarget('node_modules/dsh-experimental-webworker-packer/lib/index.js', target), false, '别的包不得算进来')

  // 引擎根包自身的短后缀目标（lib/bin.js）只认那一个文件——这里曾把别的包误报成未打补丁副本
  const selfTarget = 'lib/bin.js'
  assert.equal(matchesPatchTarget('lib/bin.js', selfTarget), true)
  assert.equal(matchesPatchTarget('node_modules/dsh-experimental-webworker-packer/lib/bin.js', selfTarget), false)
})

test('store 副本被补上，且与已打补丁那份逐字节一致', () => {
  const { root, engine } = fixture()
  try {
    const report = reconcileEnginePatchCopies(engine, registry)
    assert.equal(report.reconciledCopyCount, 1, '应恰好收敛 1 份副本')
    const store = join(engine, 'node_modules/.pnpm/node-addon-require-builtin@0.1.6/node_modules/node-addon-require-builtin/lib/index.js')
    const top = join(engine, 'node_modules/node-addon-require-builtin/lib/index.js')
    assert.equal(readFileSync(store, 'utf8'), readFileSync(top, 'utf8'))
    assert.match(readFileSync(store, 'utf8'), new RegExp(MARKER.replace(/[()]/g, '\\$&')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('已经一致时幂等：不改写、报告为零', () => {
  const { root, engine } = fixture()
  try {
    reconcileEnginePatchCopies(engine, registry)
    const second = reconcileEnginePatchCopies(engine, registry)
    assert.equal(second.reconciledCopyCount, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('所有副本都缺 marker 即判红（补丁根本没打上）', () => {
  const { root, engine } = fixture()
  try {
    for (const file of collectPhysicalFiles(engine)) writeFileSync(file, 'const x = 1;\n')
    assert.throws(() => reconcileEnginePatchCopies(engine, registry), /补丁完全没打上/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('补丁目标在引擎树里找不到即判红', () => {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-missing-'))
  try {
    const engine = join(root, PREFIX)
    mkdirSync(engine, { recursive: true })
    assert.throws(() => reconcileEnginePatchCopies(engine, registry), /找不到/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
