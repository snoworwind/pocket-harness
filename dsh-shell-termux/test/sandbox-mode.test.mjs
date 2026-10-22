import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TermuxBashExecutor } from '../lib/index.js'

function executor(defaultMode = 'workspace-write') {
  const instance = Object.create(TermuxBashExecutor.prototype)
  let spawnCount = 0
  Object.assign(instance, {
    bashPath: '/snapshot/usr/bin/bash',
    writeMode: defaultMode,
    prefix: '/snapshot/usr',
    home: '/snapshot/home',
    termuxVersion: 'test',
    extraPath: [],
    sharedDirs: [],
    resolvedModes: new WeakMap(),
    config: {
      cwd: { get: () => '/workspace' },
      timeoutMs: { get: () => 120_000 },
      maxTimeoutMs: { get: () => 600_000 },
      maxOutputBytes: { get: () => 64_000 },
      maxSpillBytes: { get: () => 64 * 1024 * 1024 },
      graceMs: { get: () => 3_000 },
    },
    assertBash() {},
    executeArgv: async () => {
      spawnCount += 1
      return { sandbox: undefined, result: async () => ({ exitCode: 0 }) }
    },
  })
  return { instance, spawnCount: () => spawnCount }
}

test('workspace-write and read-only are rejected before spawning without a path confiner', async () => {
  for (const mode of ['workspace-write', 'read-only']) {
    const harness = executor()
    const spec = harness.instance.resolve({
      command: 'touch /outside/workspace/probe',
      sandboxPolicy: { mode },
    })
    await assert.rejects(harness.instance.execute(spec), error => {
      assert.equal(error.code, 'SANDBOX_UNAVAILABLE')
      assert.match(error.message, new RegExp(`cannot enforce ${mode}`))
      assert.match(error.message, /The command was not started/)
      return true
    })
    assert.equal(harness.spawnCount(), 0, `${mode} must not start bash`)
  }
})

test('per-call restricted mode overrides a danger-full-access provider default and env label', async () => {
  const harness = executor('danger-full-access')
  const spec = harness.instance.resolve({
    command: 'touch /outside/workspace/probe',
    sandboxPolicy: { mode: 'workspace-write' },
    env: { DSH_WRITE_MODE: 'danger-full-access' },
  })
  assert.equal(spec.env.DSH_WRITE_MODE, 'workspace-write')
  await assert.rejects(harness.instance.execute(spec), error => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE')
    assert.match(error.message, /cannot enforce workspace-write/)
    return true
  })
  assert.equal(harness.spawnCount(), 0)
})

test('danger-full-access runs with per-call sandbox facts', async () => {
  const harness = executor()
  const spec = harness.instance.resolve({
    command: 'printf allowed',
    sandboxPolicy: { mode: 'danger-full-access' },
  })
  const execution = await harness.instance.execute(spec)
  assert.equal(harness.spawnCount(), 1)
  assert.deepEqual(execution.sandbox, {
    mode: 'danger-full-access',
    denied: false,
    enforcement: 'partial',
  })
})

test('danger-full-access provider config cannot replace an explicit session selection', async () => {
  const harness = executor('danger-full-access')
  const spec = harness.instance.resolve({ command: 'printf must-not-run' })
  await assert.rejects(harness.instance.execute(spec), error => {
    assert.equal(error.code, 'SANDBOX_SELECTION_REQUIRED')
    assert.match(error.message, /explicitly select danger-full-access/)
    assert.match(error.message, /The command was not started/)
    return true
  })
  assert.equal(harness.spawnCount(), 0)
})
