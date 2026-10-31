import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'
import {
  AUTO_REVIEW_FALLBACK_MARKER,
  AUTO_REVIEW_HIGH_DENY_MARKER,
  AUTO_REVIEW_HIGH_GUARD_MARKER,
  AUTO_REVIEW_RUN_CODE_MARKER,
  PERMISSION_AUTO_DEFAULT_MARKER,
  PERMISSION_AUTO_UI_MARKER,
  patchAutoReviewDefaultBehavior,
  patchPermissionPresetsAutoDefault,
  patchPermissionPresetsClientAutoDefault,
} from '../data/permission-auto-review-default.mjs'

const PATCH_ID = 'permission-auto-review-default-AR1'
const permissionSource = readFileSync(versionedFixture('dsh-permission-presets', 'lib', 'index.js'), 'utf8')
const autoReviewSource = readFileSync(versionedFixture('dsh-experimental-auto-review', 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(versionedFixture('dsh-client-ui-permission-presets', 'lib', 'client.js'), 'utf8')
const profileSource = readFileSync('scripts/profile-web.cordis.patch.yml', 'utf8').replace(/\r\n/g, '\n')
const patchedPermission = patchPermissionPresetsAutoDefault(permissionSource)
const patchedAutoReview = patchAutoReviewDefaultBehavior(autoReviewSource)
const patchedClient = patchPermissionPresetsClientAutoDefault(clientSource)

test('profile makes Auto the new-session default and mounts the matching reviewer', () => {
  const permissionRow = profileSource.indexOf('- id: permission\n')
  const defaultRow = profileSource.indexOf('defaultPreset: auto', permissionRow)
  const reviewerRow = profileSource.indexOf("name: '@deepseek-ai/dsh-experimental-auto-review'")
  assert.ok(permissionRow >= 0 && defaultRow > permissionRow && reviewerRow > defaultRow)
  for (const preset of ['read-only:', 'workspace-write:', 'danger-full-access:']) {
    assert.ok(profileSource.includes(preset), `whole-object config retains ${preset}`)
  }
})

test('AR1 patches current artifacts, parses, and remains idempotent', () => {
  assert.ok(patchedPermission.includes(PERMISSION_AUTO_DEFAULT_MARKER))
  assert.ok(patchedPermission.includes('[...Object.keys(this.presets), AUTO_PRESET].map((name) => this.optionOf(name))'))
  assert.ok(patchedPermission.includes('return this.presets[name] ?? (name === AUTO_PRESET ? AUTO_PRESET_SPEC : void 0);'))
  assert.ok(patchedPermission.includes('Auto review integration is unavailable; tool execution was blocked.'))
  assert.equal(patchPermissionPresetsAutoDefault(patchedPermission), patchedPermission)

  for (const marker of [AUTO_REVIEW_RUN_CODE_MARKER, AUTO_REVIEW_FALLBACK_MARKER, AUTO_REVIEW_HIGH_DENY_MARKER, AUTO_REVIEW_HIGH_GUARD_MARKER]) {
    assert.ok(patchedAutoReview.includes(marker), marker)
  }
  assert.ok(!patchedAutoReview.includes('exec.parent === void 0 && exec.name === RUN_CODE_NAME'))
  assert.ok(patchedAutoReview.indexOf('if (decision.risk === "high")') < patchedAutoReview.indexOf('const downstream = await next();'))
  assert.ok(patchedAutoReview.includes('hardDenied.set(exec, decision.reason ?? "high-risk action");'))
  assert.ok(patchedAutoReview.includes('yield ctx.tools.guard((exec) => {'))
  assert.equal(patchAutoReviewDefaultBehavior(patchedAutoReview), patchedAutoReview)
  assert.throws(
    () => patchAutoReviewDefaultBehavior(patchedAutoReview.replace('yield ctx.tools.guard((exec) => {', 'yield Promise.resolve();')),
    /partial Auto review behavior patch detected/,
    'a surviving marker cannot conceal removal of the monotonic guard',
  )

  assert.ok(patchedClient.includes(PERMISSION_AUTO_UI_MARKER))
  assert.ok(patchedClient.includes('select(AUTO_REVIEW_PRESET);'))
  assert.ok(patchedClient.includes('High-risk denials and review failures are hard-denied and cannot be approved'))
  assert.ok(patchedClient.includes("Changing the current session's permission preset disables Auto review."))
  assert.ok(patchedClient.includes('PTC 外层程序'))
  assert.equal(patchPermissionPresetsClientAutoDefault(patchedClient), patchedClient)

  const check = (filename, source) => {
    const dir = mkdtempSync(join(tmpdir(), 'permission-auto-review-syntax-'))
    try {
      const path = join(dir, filename)
      writeFileSync(path, source)
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr || result.stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  check('permission.mjs', patchedPermission)
  check('auto-review.mjs', patchedAutoReview)
  check('permission-client.mjs', patchedClient)
})

test('high-risk denial is terminal and the monotonic guard prevents a later allow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'permission-auto-review-runtime-'))
  try {
    let source = patchedAutoReview
      .replace('import { BlockAssembler } from "@deepseek-ai/dsh-llm";\n', '')
      .replace('import { deepFreeze } from "@deepseek-ai/dsh-util-values";\n', '')
      .replace('import { AUTO_PRESET } from "@deepseek-ai/dsh-permission-presets";\n', '')
      .replace('import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";\n', '')
    const prelude = `
const AUTO_PRESET = "auto";
const RUN_CODE_NAME = "run_code";
const deepFreeze = value => value;
if (!Promise.withResolvers) Promise.withResolvers = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve }; };
class BlockAssembler {
  constructor() { this.values = []; }
  push(chunk) { if (chunk.type === "block-end") this.values[chunk.index] = chunk.block; }
  blocks() { return this.values.filter(Boolean); }
}
`
    const modulePath = join(dir, 'auto-review-runtime.mjs')
    writeFileSync(modulePath, prelude + source)
    const plugin = await import(pathToFileURL(modulePath).href)

    const createHarness = (decision, toolName = 'probe', approvalPolicy = 'ask') => {
      let handler
      let monotonicGuard
      const requests = []
      const eventData = JSON.stringify({ payload: 'pending operation' })
      const callId = 'root-call'
      const events = [
        { type: 'turn/start', seq: 0, data: { turn: 1 } },
        { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: callId, name: toolName, arguments: eventData }] } } },
        { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId, name: toolName, arguments: eventData } },
      ]
      const args = JSON.parse(eventData)
      const session = {
        header: { origin: 'human' },
        surface: { nodes: [2] },
        snapshotEvents: () => events,
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' }, tools: [{ name: toolName, description: 'Run the pending operation.', parameters: { type: 'object' } }] }),
        isOwnSeq: () => true,
      }
      const exec = { agent: { session }, name: toolName, arguments: args, signal: new AbortController().signal, callId, rootCallId: callId }
      const ctx = {
        permissionPresets: { current: () => 'auto', registerAuto: () => () => {} },
        approval: { overrideOf: () => { requests.push('overrideOf'); return approvalPolicy } },
        sessions: { list: () => [] },
        workingDirectory: { ensure: async () => '/workspace' },
        llm: { stream: options => {
          requests.push(options)
          return (async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(decision) } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        } },
        tools: { guard: guard => { monotonicGuard = guard; return () => {} } },
        on: (event, listener) => { if (event === 'tools/pre-execute') handler = listener; return () => {} },
        effect: factory => {
          const iterator = factory()
          let step = iterator.next()
          while (!step.done) step = iterator.next()
        },
      }
      plugin.apply(ctx)
      assert.equal(typeof handler, 'function')
      assert.equal(typeof monotonicGuard, 'function')
      return { exec, handler, monotonicGuard, requests }
    }

    const high = createHarness({ risk: 'high', decision: 'deny', reason: 'secret exfiltration' })
    let downstreamCalls = 0
    const denied = await high.handler(high.exec, async () => { downstreamCalls++; return { kind: 'allow' } })
    assert.equal(denied.kind, 'deny')
    assert.equal(downstreamCalls, 0, 'a hard-denied call never enters later pre-execute approval')
    assert.ok(!high.requests.includes('overrideOf'), 'high-risk denial does not consult an overridable approval policy')
    assert.match(high.monotonicGuard(high.exec), /hard-denied this high-risk call/)

    const medium = createHarness({ risk: 'medium', decision: 'deny', reason: 'needs explicit authorization' })
    const asked = await medium.handler(medium.exec, async () => ({ kind: 'allow' }))
    assert.equal(asked.kind, 'ask', 'a medium-risk denial remains reviewable by the user')

    const low = createHarness({ risk: 'low', decision: 'allow' })
    const allowed = await low.handler(low.exec, async () => ({ kind: 'allow' }))
    assert.equal(allowed.kind, 'allow')

    const outerPtc = createHarness({ risk: 'low', decision: 'allow' }, 'run_code')
    await outerPtc.handler(outerPtc.exec, async () => ({ kind: 'allow' }))
    assert.equal(outerPtc.requests.filter(value => typeof value === 'object').length, 1, 'the outer run_code source is reviewed')
    assert.match(outerPtc.requests.find(value => typeof value === 'object').messages[0].content[0].text, /"name": "run_code"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AR1 runs through the engine patch runner and rejects damaged input', () => {
  const stage = mkdtempSync(join(tmpdir(), 'permission-auto-review-runner-'))
  const targets = [
    ['usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js', permissionSource],
    ['usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js', autoReviewSource],
    ['usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js', clientSource],
  ]
  const runner = new URL('../apply-patches.mjs', import.meta.url)
  const run = mode => spawnSync(process.execPath, [fileURLToPath(runner), stage, mode, '--scope', 'engine', '--only', PATCH_ID], { encoding: 'utf8' })
  try {
    for (const [relative, source] of targets) {
      const target = join(stage, relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    let result = run('--apply')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(run('--check').status, 0)
    result = run('--apply')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(join(stage, targets[0][0]), 'utf8'), patchedPermission)
    assert.equal(readFileSync(join(stage, targets[1][0]), 'utf8'), patchedAutoReview)
    assert.equal(readFileSync(join(stage, targets[2][0]), 'utf8'), patchedClient)

    const damaged = autoReviewSource.replace('if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();', 'if (agent === void 0) return next();')
    writeFileSync(join(stage, targets[1][0]), damaged)
    result = run('--apply')
    assert.notEqual(result.status, 0, 'an unknown or partly applied auto-review artifact must fail')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
