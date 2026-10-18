import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureProjectInputs, captureProjectOutputs, resolveSourceRepository } from './record-project-components.mjs'

const dirs = ['dsh-shell-termux', 'dsh-client-ui-responsive', 'dsh-host-web-compat']
const FIXTURE_REPOSITORY = 'https://github.com/fixture/fork'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'project-components-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('remote', 'add', 'origin', FIXTURE_REPOSITORY + '.git')
  writeFileSync(join(root, '.gitignore'), '.deploy-tmp/\ndsh-shell-termux/lib/\ndsh-client-ui-responsive/lib/\ntoken*\n')
  for (const directory of dirs) {
    mkdirSync(join(root, directory, 'src'), { recursive: true })
    mkdirSync(join(root, directory, 'lib'))
    writeFileSync(join(root, directory, 'src/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, directory, 'lib/index.js'), 'export const value = 1\n')
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name: `@dsh-android/${directory}`, version: '1.0.0', dependencies: { '@deepseek-ai/cordis': '4.0.4' } }) + '\n')
    writeFileSync(join(root, directory, 'package-lock.json'), '{"lockfileVersion":3}\n')
  }
  mkdirSync(join(root, 'scripts/snapshot-config'), { recursive: true })
  mkdirSync(join(root, 'scripts/source-build'))
  copyFileSync(join(import.meta.dirname, 'record-project-components.mjs'), join(root, 'scripts/source-build/record-project-components.mjs'))
  writeFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), '{"packages":{"@deepseek-ai/cordis":"4.0.4"}}\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  // Fixtures own their provenance identity, including child CLI processes.
  // GitHub Actions supplies GITHUB_REPOSITORY, which otherwise overrides origin.
  const previousRepository = process.env.DSH_SOURCE_REPOSITORY
  process.env.DSH_SOURCE_REPOSITORY = FIXTURE_REPOSITORY
  try { return fn({ root, commit }) } finally {
    if (previousRepository === undefined) delete process.env.DSH_SOURCE_REPOSITORY
    else process.env.DSH_SOURCE_REPOSITORY = previousRepository
    rmSync(root, { recursive: true, force: true })
  }
}

test('project component source files and actual built outputs bind to the same commit', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  assert.equal(inputs.projectCommit, commit)
  assert.equal(inputs.sourceRepository, FIXTURE_REPOSITORY)
  for (const directory of dirs) {
    const record = inputs.components[directory]
    assert.equal(record.sourceCommit, commit)
    assert.equal(record.packageName, `@dsh-android/${directory}`)
    assert.equal(record.inputFiles['src/index.ts'], sha256(readFileSync(join(root, directory, 'src/index.ts'))))
  }
  assert.ok(inputs.components['dsh-host-web-compat'].inputFiles['lib/index.js'])
  assert.equal(inputs.components['dsh-shell-termux'].inputFiles['lib/index.js'], undefined)
  writeFileSync(join(root, 'dsh-shell-termux/lib/index.js'), 'new build output\n')
  const outputs = captureProjectOutputs(root, commit, inputs)
  assert.equal(outputs.components['dsh-shell-termux'].outputFiles['lib/index.js'], sha256(Buffer.from('new build output\n')))
  assert.equal(inputs.components['dsh-shell-termux'].outputFiles, undefined)
}))

test('source repository resolves from env, CI variables or git origin — never hardcoded', () => fixture(({ root }) => {
  assert.equal(resolveSourceRepository(root, {}), FIXTURE_REPOSITORY)
  assert.equal(resolveSourceRepository(root, { GITHUB_REPOSITORY: 'acme/fork' }), 'https://github.com/acme/fork')
  assert.equal(resolveSourceRepository(root, { GITHUB_SERVER_URL: 'https://ghe.example/', GITHUB_REPOSITORY: 'acme/fork' }), 'https://ghe.example/acme/fork')
  assert.equal(resolveSourceRepository(root, { DSH_SOURCE_REPOSITORY: 'https://git.example/acme/fork/' }), 'https://git.example/acme/fork')
  // 负控：没有 origin 也没有环境变量时必须判红，不得回落到任何写死的仓库。
  execFileSync('git', ['-C', root, 'remote', 'remove', 'origin'])
  assert.throws(() => resolveSourceRepository(root, {}), /无法确定来源仓库/)
}))

test('dirty tracked and untracked component inputs cannot claim committed provenance', () => fixture(({ root, commit }) => {
  const tracked = join(root, 'dsh-shell-termux/src/index.ts')
  writeFileSync(tracked, 'dirty source')
  assert.throws(() => captureProjectInputs(root, commit), /differs from project commit/)
  writeFileSync(tracked, 'export const value = 1\n')
  writeFileSync(join(root, 'dsh-shell-termux/src/untracked.ts'), 'extra source')
  assert.throws(() => captureProjectInputs(root, commit), /untracked component inputs/)
}))

test('outputs reject a stale input report and a changed checked-in host payload', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  assert.throws(() => captureProjectOutputs(root, commit, { ...inputs, projectCommit: '0'.repeat(40) }), /different commit/)
  writeFileSync(join(root, 'dsh-host-web-compat/lib/index.js'), 'unexpected replacement')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /committed JavaScript source/)
}))

test('missing output and changed manifest fail rather than producing incomplete provenance', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  rmSync(join(root, 'dsh-shell-termux/lib/index.js'))
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /did not produce lib\/index.js/)
  writeFileSync(join(root, 'dsh-shell-termux/lib/index.js'), 'output')
  writeFileSync(join(root, 'dsh-shell-termux/package.json'), '{}')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /manifest changed/)
}))

test('component input provenance preserves the engine-overlay Cordis pin check', () => fixture(({ root, commit }) => {
  writeFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), '{"packages":{"@deepseek-ai/cordis":"wrong"}}')
  assert.throws(() => captureProjectInputs(root, commit), /Cordis dependency differs/)
}))

test('a source rewrite during build cannot be attributed to the original input commit', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  writeFileSync(join(root, 'dsh-client-ui-responsive/src/index.ts'), 'unexpected source rewrite')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /source changed during build/)
}))

test('rewriting source and its mutable input hash report cannot forge committed provenance', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  const payload = 'export const value = "injected"\n'
  writeFileSync(join(root, 'dsh-shell-termux/src/index.ts'), payload)
  writeFileSync(join(root, 'dsh-shell-termux/lib/index.js'), payload)
  inputs.components['dsh-shell-termux'].inputFiles['src/index.ts'] = sha256(Buffer.from(payload))
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /input provenance differs from project commit/)
}))

test('removing a modified source from the input report cannot hide it', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  writeFileSync(join(root, 'dsh-shell-termux/src/index.ts'), 'injected source')
  delete inputs.components['dsh-shell-termux'].inputFiles['src/index.ts']
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /input provenance differs from project commit/)
}))

test('source additions during build are rejected, including Git-ignored source names', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  for (const name of ['added.ts', 'token-added.ts']) {
    const path = join(root, 'dsh-client-ui-responsive/src', name)
    writeFileSync(path, 'export const injected = true\n')
    assert.throws(() => captureProjectOutputs(root, commit, inputs), /untracked component inputs/)
    rmSync(path)
  }
}))

test('staging an extra compiler input cannot hide it from the pinned commit check', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  writeFileSync(join(root, 'dsh-shell-termux/src/staged.ts'), 'export const injected = true\n')
  execFileSync('git', ['-C', root, 'add', 'dsh-shell-termux/src/staged.ts'])
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /untracked component inputs/)
}))

test('ignored compiler inputs are rejected before build and lock realization remains recorded', () => fixture(({ root, commit }) => {
  const path = join(root, 'dsh-shell-termux/src/token-injected.ts')
  writeFileSync(path, 'export const injected = true\n')
  assert.throws(() => captureProjectInputs(root, commit), /untracked component inputs/)
  rmSync(path)
  const inputs = captureProjectInputs(root, commit)
  const lock = '{"lockfileVersion":3,"packages":{"resolved":{}}}\n'
  writeFileSync(join(root, 'dsh-shell-termux/package-lock.json'), lock)
  const outputs = captureProjectOutputs(root, commit, inputs)
  assert.equal(outputs.components['dsh-shell-termux'].resolvedLockSha256, sha256(Buffer.from(lock)))
  assert.equal(outputs.components['dsh-shell-termux'].inputFiles['package-lock.json'], sha256(Buffer.from('{"lockfileVersion":3}\n')))
}))

test('forged component and repository identities are rejected at output capture', () => fixture(({ root, commit }) => {
  for (const mutate of [
    inputs => { inputs.sourceRepository = 'https://github.com/other/repository' },
    inputs => { inputs.components['dsh-shell-termux'].packageVersion = '9.9.9' },
  ]) {
    const inputs = captureProjectInputs(root, commit)
    mutate(inputs)
    assert.throws(() => captureProjectOutputs(root, commit, inputs), /input provenance differs from project commit/)
  }
}))

test('actual output CLI rejects forged source hashes without overwriting the input report', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  const payload = 'export const value = "injected"\n'
  writeFileSync(join(root, 'dsh-shell-termux/src/index.ts'), payload)
  inputs.components['dsh-shell-termux'].inputFiles['src/index.ts'] = sha256(Buffer.from(payload))
  const reportPath = join(root, 'inputs.json')
  const before = JSON.stringify(inputs) + '\n'
  writeFileSync(reportPath, before)
  const result = spawnSync(process.execPath, [join(root, 'scripts/source-build/record-project-components.mjs'), 'outputs', reportPath], {
    cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, GITHUB_SHA: commit, DSH_SOURCE_REPOSITORY: FIXTURE_REPOSITORY },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /input provenance differs from project commit/)
  assert.equal(readFileSync(reportPath, 'utf8'), before)
}))

test('actual source workflow verifies project components without an independent host checkout', { skip: process.platform !== 'linux' }, () => fixture(({ root, commit }) => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/build-apk-source.yml'), 'utf8').replaceAll('\r\n', '\n')
  const start = workflow.indexOf('      - name: Checkout pinned component sources\n')
  const end = workflow.indexOf('          marketplace_tarball=', start)
  assert.ok(start > 0 && end > start)
  const block = workflow.slice(start, end)
  assert.equal(block.includes('git clone'), false)
  assert.equal(workflow.includes('component-sources/host-web-compat'), false)
  assert.equal(workflow.includes('2de902729e01eb3619aa50bdfa164c5231948848'), false)
  const script = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const result = spawnSync('/bin/bash', ['-e', '-c', script], { cwd: root, env: { ...process.env, GITHUB_SHA: commit }, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = JSON.parse(readFileSync(join(root, '.deploy-tmp/source-build/project-component-provenance.json'), 'utf8'))
  assert.deepEqual(Object.keys(report.components), dirs)
  assert.equal(report.projectCommit, commit)
}))

test('fixture identity overrides CI environment and restores the caller override', () => {
  const previous = process.env.DSH_SOURCE_REPOSITORY
  process.env.DSH_SOURCE_REPOSITORY = 'https://github.com/outer/build'
  try {
    fixture(({ root, commit }) => {
      assert.equal(captureProjectInputs(root, commit).sourceRepository, FIXTURE_REPOSITORY)
    })
    assert.equal(process.env.DSH_SOURCE_REPOSITORY, 'https://github.com/outer/build')
  } finally {
    if (previous === undefined) delete process.env.DSH_SOURCE_REPOSITORY
    else process.env.DSH_SOURCE_REPOSITORY = previous
  }
})
