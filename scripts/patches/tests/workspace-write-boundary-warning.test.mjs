import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Script } from 'node:vm'
import { versionedFixture } from './lib/fixture.mjs'
import {
  PERMISSION_AUTO_DEFAULT_MARKER,
  patchPermissionPresetsAutoDefault,
  patchAutoReviewDefaultBehavior,
  patchPermissionPresetsClientAutoDefault,
} from '../data/permission-auto-review-default.mjs'
import {
  WORKSPACE_WRITE_WARNING_MARKER,
  patchWorkspaceWriteBoundaryWarning,
} from '../data/workspace-write-boundary-warning.mjs'

const PATCH_ID = 'workspace-write-boundary-warning-WW1'
const permissionSource = readFileSync(versionedFixture('dsh-permission-presets', 'lib', 'index.js'), 'utf8')
const autoReviewSource = readFileSync(versionedFixture('dsh-experimental-auto-review', 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(versionedFixture('dsh-client-ui-permission-presets', 'lib', 'client.js'), 'utf8')
const patchedPermission = patchPermissionPresetsAutoDefault(permissionSource)
const patchedAutoReview = patchAutoReviewDefaultBehavior(autoReviewSource)
const autoClient = patchPermissionPresetsClientAutoDefault(clientSource)
const patchedClient = patchWorkspaceWriteBoundaryWarning(autoClient)

test('WW1 warns before Workspace Write selection in session, settings, and command pickers', () => {
  assert.ok(patchedClient.includes(WORKSPACE_WRITE_WARNING_MARKER))
  assert.ok(patchedClient.includes('if (id === "danger-full-access" || id === "auto" || id === "workspace-write")'))
  assert.ok(patchedClient.includes('confirmation === "workspace-write" ? t("workspaceWrite.confirm.title")'))
  assert.ok(patchedClient.includes('confirmation === "workspace-write" ? t("workspaceWrite.confirm.description")'))
  assert.ok(patchedClient.includes('state.currentValue === "workspace-write" ? t("workspaceWrite.defaultDescription")'))
  assert.ok(patchedClient.includes('setConfirmingWorkspaceWrite(true);'))
  assert.ok(patchedClient.includes('select("workspace-write");'))
  assert.ok(patchedClient.includes('option.value === "workspace-write" ? { detail: t("workspaceWrite.description") }'))
  assert.ok(patchedClient.includes('option.value === "workspace-write" ? { confirmation: {'))
  assert.ok(patchedClient.includes('Android 没有覆盖所有工具的路径级文件系统沙箱'))
  assert.ok(patchedClient.includes('Termux Shell 会在启动 bash 前拒绝此档位'))
  assert.ok(patchedClient.includes('They remain subject to the Android app UID boundary.'))
  assert.equal(patchWorkspaceWriteBoundaryWarning(patchedClient), patchedClient)
  new Script(patchedClient)
})

test('WW1 retains Auto Review policy and its separate confirmation copy', () => {
  assert.ok(patchedPermission.includes(PERMISSION_AUTO_DEFAULT_MARKER))
  assert.ok(patchedAutoReview.includes('high-risk action'))
  assert.ok(patchedClient.includes('Android provides no path-level filesystem sandbox; tools run with app UID access.'))
  assert.ok(!patchedClient.includes('This workspace session has no path-level filesystem sandbox'))
  assert.ok(!patchedClient.includes('此工作区会话没有路径级文件系统沙箱'))
})

test('WW1 runs after AR1 through the registered runner and rejects changed anchors without writing', () => {
  const stage = mkdtempSync(join(tmpdir(), 'workspace-write-warning-'))
  const targets = {
    permission: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js',
    autoReview: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js',
    client: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js',
  }
  const sources = { permission: permissionSource, autoReview: autoReviewSource, client: clientSource }
  const runner = fileURLToPath(new URL('../apply-patches.mjs', import.meta.url))
  const run = (mode, ids = `permission-auto-review-default-AR1,${PATCH_ID}`) => spawnSync(process.execPath,
    [runner, stage, mode, '--scope', 'engine', '--only', ids], { encoding: 'utf8' })

  try {
    for (const [key, relative] of Object.entries(targets)) {
      const path = join(stage, relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, sources[key])
    }

    let result = run('--apply')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const clientPath = join(stage, targets.client)
    assert.equal(readFileSync(clientPath, 'utf8'), patchedClient)
    result = run('--check')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    result = run('--apply')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(clientPath, 'utf8'), patchedClient)

    const damaged = autoClient.replace(
      'return option.value === "auto" ? t("auto.description") : option.description;',
      'return option.value === "auto" ? t("auto.description") : option.label;',
    )
    assert.notEqual(damaged, autoClient)
    writeFileSync(clientPath, damaged)
    result = run('--apply', PATCH_ID)
    assert.notEqual(result.status, 0, 'unknown bytes must fail the actual patch runner')
    assert.equal(readFileSync(clientPath, 'utf8'), damaged, 'a rejected patch cannot write partial output')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
