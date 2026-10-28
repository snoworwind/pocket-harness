import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { COMPONENTS } from './base-lock.mjs'
import { capture, checkPayload, makePlan, materialize, publishCandidate, rebase, requireMain, verifyTrusted } from './engine-base.mjs'
import { checkDshRuntimeDependencies } from './check-dsh-runtime-dependencies.mjs'

const runtime = { node: '24.21.0', pnpm: '11.28.5', deploymentPnpm: '12.2.0', localDevelopment: true }
const env = { GITHUB_RUN_ID: 'local-test-1' }
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { env: gitEnv, stdio: 'pipe' }).toString().trim()
function write(root, path, body = 'fixture\n') { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body) }
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'engine-base-test-'))
  try {
    for (const path of COMPONENTS.engine) {
      if (/\.(mjs|sh|py|json)$/.test(path)) write(root, path, path + '\n')
      else write(root, path + '/fixture.txt')
    }
    // build-engine.sh extracts the pinned marketplace tarball, which deletes this receipt.
    write(root, 'vendor/dshmarketplace-plugin/PATCHES.md')
    write(root, '.gitignore', '.deploy-tmp/\n')
    git(root, 'init', '-q', '--initial-branch=main')
    git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid')
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture')
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function built(root, order = 'canonical') {
  write(root, '.deploy-tmp/engine-deploy/lib/bin.js', 'export const built = true\n')
  const packageJson = order === 'reversed'
    ? '{"dependencies":{"z-dep":"1","a-dep":"2"},"name":"engine-deploy"}\n'
    : '{"name":"engine-deploy","dependencies":{"a-dep":"2","z-dep":"1"}}\n'
  const workspaceYaml = order === 'reversed'
    ? 'patchedDependencies:\n  "z@1": "patches/z.patch"\n  "a@1": "patches/a.patch"\nallowBuilds:\n  "z": true\n  "a": false\n'
    : 'allowBuilds:\n  "a": false\n  "z": true\npatchedDependencies:\n  "a@1": "patches/a.patch"\n  "z@1": "patches/z.patch"\n'
  write(root, '.deploy-tmp/engine-deploy/package.json', packageJson)
  write(root, '.deploy-tmp/engine-deploy/pnpm-workspace.yaml', workspaceYaml)
  write(root, '.deploy-tmp/engine-deploy/node_modules/.modules.yaml', root)
  write(root, '.deploy-tmp/engine-overlay/source-build-manifest.json', '{}')
  write(root, '.deploy-tmp/deepseek-harness/lib/built.js', 'export const built = true\n')
  write(root, '.deploy-tmp/deepseek-harness/node_modules/ignored.js', root)
  write(root, '.deploy-tmp/deepseek-harness/.git/config', root)
  write(root, 'vendor/dshmarketplace-plugin/lib/index.js')
  write(root, '.deploy-tmp/component-sources/dshmarketplace-plugin-0.1.7.tgz')
  const reports = ['engine-overlay.original.json', 'effective-engine-overlay.json', 'source-build-policy.json',
    'harness-vendor-overrides.json', 'harness-vendor-lock-reconciliation.json', 'harness-build-script-exclusion.json',
    'pnpm-deploy-build-policy.json', 'pnpm-deploy-runtime-closure.json', 'first-party-deploy-injection.json',
    'marketplace-metadata-delta.json', 'harness-web-preview-exclusion.json']
  for (const name of reports) write(root, '.deploy-tmp/source-build/' + name, JSON.stringify({ workspace: root + '/source' }))
  for (const name of ['engine-overlay.original.json', 'effective-engine-overlay.json']) write(root, '.deploy-tmp/source-build/' + name, '{"engineVersion":"fixture"}\n')
  for (const name of ['harness-pnpm-lock.original.yaml', 'harness-root-package.json.original', 'pnpm-deploy-runtime-closure.lock.yaml']) write(root, '.deploy-tmp/source-build/' + name)
  write(root, '.deploy-tmp/source-build/package-manager-versions.txt', '11.28.5\ndeployment pnpm: 12.2.0\n')
}

test('main/commit guards reject feature branches and PR contexts', () => fixture(root => {
  assert.equal(requireMain(root, env), git(root, 'rev-parse', 'HEAD'))
  assert.throws(() => requireMain(root, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/1/merge' }), /main workflow/)
  git(root, 'switch', '-qc', 'feature')
  assert.throws(() => makePlan(root, runtime, env), /attached main/)
}))

test('content key ignores unrelated commits but rejects modified build inputs', () => fixture(root => {
  const first = makePlan(root, runtime, env)
  write(root, 'notes.md'); git(root, 'add', 'notes.md'); git(root, 'commit', '-qm', 'docs')
  const second = makePlan(root, runtime, env)
  assert.equal(second.key, first.key)
  assert.notEqual(second.sourceCommit, first.sourceCommit)
  write(root, 'scripts/source-build/build-engine.sh', 'changed\n')
  assert.throws(() => makePlan(root, runtime, env))
}))

test('receipt rebasing only changes exact workspace paths', () => {
  assert.deepEqual(rebase({ x: ['/old/a', '/older/a', 'file:///old/a'] }, '/old', '${WORKSPACE}'),
    { x: ['${WORKSPACE}/a', '/older/a', 'file://${WORKSPACE}/a'] })
})

test('actual archive comparison binds trees and refuses changed output bytes', { skip: process.platform !== 'linux' }, () => fixture(a => fixture(b => {
  const plan = makePlan(a, runtime, env)
  built(a); built(b, 'reversed')
  const primary = join(a, '.deploy-tmp/artifact'), reference = join(b, '.deploy-tmp/artifact')
  const first = capture(a, plan, primary, plan.buildRun, 'primary', env)
  const second = capture(b, plan, reference, plan.buildRun, 'reference', env)
  assert.equal(first.treeSha256, second.treeSha256)
  assert.equal(checkPayload(primary, first), true)
  const out = join(a, '.deploy-tmp/candidate')
  const entry = publishCandidate(a, plan, primary, reference, out, env)
  assert.equal(entry.key, plan.key)
  assert.ok(existsSync(join(out, 'base-lock.candidate.json')))
  const lock = JSON.parse(readFileSync(join(out, 'base-lock.candidate.json'), 'utf8'))
  assert.equal(verifyTrusted(a, lock, out).key, plan.key)
  assert.throws(() => verifyTrusted(a, { ...lock, components: { engine: { ...entry, key: 'engine-v1-wrong' } } }, out), /key drifted/)
  const file = join(reference, second.outputs[0].path)
  const bytes = readFileSync(file); bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes)
  assert.throws(() => publishCandidate(a, plan, primary, reference, join(a, '.deploy-tmp/poisoned'), env), /sha256 mismatch/)
})))

test('runtime dependency report order is stable while missing links remain a hard failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-deps-order-'))
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const writePackage = (path, manifest) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(manifest) + '\n')
  }
  try {
    writePackage(join(root, 'package.json'), { name: 'engine', version: '1.0.0' })
    for (let i = 0; i < 264; i++) {
      const name = `filler-${String(i).padStart(3, '0')}`
      writePackage(join(scope, name, 'package.json'), { name: `@deepseek-ai/${name}`, version: '1.0.0' })
    }
    for (const leaf of ['a-dep', 'z-dep']) {
      writePackage(join(root, 'node_modules', leaf, 'package.json'), { name: leaf, version: '1.0.0' })
    }
    for (const importer of ['z-importer', 'a-importer']) {
      writePackage(join(scope, importer, 'package.json'), {
        name: `@deepseek-ai/${importer}`,
        version: '1.0.0',
        dependencies: { 'z-dep': '1.0.0', 'a-dep': '1.0.0' },
      })
    }
    // These services are enabled by the current profile. Keep empty roots in the base fixture,
    // then add a consumer-local transitive exact dependency below.
    for (const name of ['dsh-otel', 'dsh-session-telemetry-otel']) {
      writePackage(join(scope, name, 'package.json'), { name: `@deepseek-ai/${name}`, version: '1.0.0' })
    }
    const report = checkDshRuntimeDependencies(root)
    assert.deepEqual(report.resolvedDependencies.map(({ importer, dependency }) => [importer, dependency]), [
      ['@deepseek-ai/a-importer', 'a-dep'],
      ['@deepseek-ai/a-importer', 'z-dep'],
      ['@deepseek-ai/z-importer', 'a-dep'],
      ['@deepseek-ai/z-importer', 'z-dep'],
    ])

    // A package at the correct path with the wrong exact version must not satisfy the pin.
    writePackage(join(root, 'node_modules', 'a-dep', 'package.json'), { name: 'a-dep', version: '0.9.0' })
    const savedError = console.error
    console.error = () => {}
    try {
      assert.throws(() => checkDshRuntimeDependencies(root), /dependency closure failed/)
    } finally { console.error = savedError }
    writePackage(join(root, 'node_modules', 'a-dep', 'package.json'), { name: 'a-dep', version: '1.0.0' })
    assert.equal(checkDshRuntimeDependencies(root).dependencyPresence, 'passed')
    writePackage(join(scope, 'dsh-fs-local', 'package.json'), {
      name: '@deepseek-ai/dsh-fs-local', version: '1.0.0', dependencies: { koffi: '3.1.1' },
    })
    writePackage(join(root, 'node_modules', 'koffi', 'package.json'), { name: 'koffi', version: '3.2.1' })
    assert.equal(checkDshRuntimeDependencies(root).deliberatelyOverridden.length, 1)
    writePackage(join(root, 'node_modules', 'koffi', 'package.json'), { name: 'koffi', version: '3.3.0' })
    console.error = () => {}
    try { assert.throws(() => checkDshRuntimeDependencies(root), /dependency closure failed/) }
    finally { console.error = savedError }
    writePackage(join(root, 'node_modules', 'koffi', 'package.json'), { name: 'koffi', version: '3.2.1' })

    writePackage(join(scope, 'a-importer', 'package.json'), {
      name: '@deepseek-ai/a-importer', version: '1.0.0', dependencies: { missing: '1.0.0' },
    })
    const originalError = console.error
    console.error = () => {}
    try {
      assert.throws(() => checkDshRuntimeDependencies(root), /dependency closure failed/)
    } finally {
      console.error = originalError
    }

    // Upstream #656: first-party direct pins were already checked, but the old gate never
    // followed exact requirements declared by a third-party package in the consumer closure.
    writePackage(join(scope, 'a-importer', 'package.json'), { name: '@deepseek-ai/a-importer', version: '1.0.0' })
    const otelRoot = join(scope, 'dsh-otel')
    const sessionOtelRoot = join(scope, 'dsh-session-telemetry-otel')
    writePackage(join(otelRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-otel', version: '1.0.0',
      dependencies: { '@opentelemetry/sdk-logs': '0.222.0' },
    })
    writePackage(join(sessionOtelRoot, 'package.json'), {
      name: '@deepseek-ai/dsh-session-telemetry-otel', version: '1.0.0',
      dependencies: { '@opentelemetry/api-logs': '0.222.0' },
    })
    writePackage(join(otelRoot, 'node_modules/@opentelemetry/sdk-logs/package.json'), {
      name: '@opentelemetry/sdk-logs', version: '0.222.0', dependencies: { '@opentelemetry/core': '2.11.0' },
    })
    writePackage(join(sessionOtelRoot, 'node_modules/@opentelemetry/api-logs/package.json'), {
      name: '@opentelemetry/api-logs', version: '0.222.0',
    })
    writePackage(join(root, 'node_modules/@opentelemetry/core/package.json'), {
      name: '@opentelemetry/core', version: '2.11.0',
    })
    writePackage(join(otelRoot, 'node_modules/@opentelemetry/core/package.json'), {
      name: '@opentelemetry/core', version: '2.9.0',
    })
    const suppressErrors = (run) => {
      const saved = console.error
      const captured = []
      console.error = (...args) => captured.push(args.join(' '))
      try { run(); return captured.join('\n') } finally { console.error = saved }
    }
    // A stale consumer-local copy wins over a matching root copy and must fail.
    const staleClosure = suppressErrors(() => assert.throws(
      () => checkDshRuntimeDependencies(root),
      /dependency closure failed/,
    ))
    assert.match(staleClosure, /@deepseek-ai\/dsh-otel -> @opentelemetry\/sdk-logs -> @opentelemetry\/core@2\.11\.0: resolved @opentelemetry\/core@2\.9\.0/)
    writePackage(join(otelRoot, 'node_modules/@opentelemetry/core/package.json'), {
      name: '@opentelemetry/core', version: '2.11.0',
    })
    const telemetryReport = checkDshRuntimeDependencies(root)
    assert.equal(telemetryReport.dependencyPresence, 'passed')
    assert.deepEqual(telemetryReport.telemetryClosure.roots, [
      '@deepseek-ai/dsh-otel', '@deepseek-ai/dsh-session-telemetry-otel',
    ])
    assert.ok(telemetryReport.telemetryClosure.packageCount >= 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('telemetry consumers carry their exact isolated OpenTelemetry closure', () => {
  const overlay = JSON.parse(readFileSync(new URL('../snapshot-config/engine-overlay.json', import.meta.url), 'utf8'))
  const licenses = JSON.parse(readFileSync(new URL('../snapshot-config/engine-overlay-licenses.json', import.meta.url), 'utf8')).licenses
  assert.deepEqual(overlay.nested['@deepseek-ai/dsh-otel'], {
    '@opentelemetry/api-logs': '0.222.0',
    '@opentelemetry/core': '2.11.0',
    '@opentelemetry/otlp-exporter-base': '0.222.0',
    '@opentelemetry/otlp-transformer': '0.222.0',
    '@opentelemetry/resources': '2.11.0',
    '@opentelemetry/sdk-logs': '0.222.0',
    '@opentelemetry/sdk-metrics': '2.11.0',
    '@opentelemetry/sdk-trace': '2.11.0',
  })
  assert.deepEqual(overlay.nested['@deepseek-ai/dsh-session-telemetry-otel'], { '@opentelemetry/api-logs': '0.222.0' })
  for (const name of [
    '@opentelemetry/api-logs', '@opentelemetry/core', '@opentelemetry/otlp-exporter-base',
    '@opentelemetry/otlp-transformer', '@opentelemetry/resources', '@opentelemetry/sdk-logs',
    '@opentelemetry/sdk-metrics', '@opentelemetry/sdk-trace',
  ]) assert.equal(licenses[name], 'Apache-2.0', `${name} license must be recorded`)
})

test('independent output drift fails instead of publishing a candidate', { skip: process.platform !== 'linux' }, () => fixture(a => fixture(b => {
  const plan = makePlan(a, runtime, env)
  built(a); built(b)
  write(b, '.deploy-tmp/engine-deploy/lib/bin.js', 'changed output\n')
  const primary = join(a, '.deploy-tmp/artifact'), reference = join(b, '.deploy-tmp/artifact')
  capture(a, plan, primary, plan.buildRun, 'primary', env)
  capture(b, plan, reference, plan.buildRun, 'reference', env)
  assert.throws(() => publishCandidate(a, plan, primary, reference, join(a, '.deploy-tmp/candidate'), env), /output trees differ/)
})))

test('materialize restores only a trusted payload', { skip: process.platform !== 'linux' }, () => fixture(a => fixture(b => {
  const plan = makePlan(a, runtime, env)
  built(a); built(b)
  const primary = join(a, '.deploy-tmp/artifact'), reference = join(b, '.deploy-tmp/artifact')
  capture(a, plan, primary, plan.buildRun, 'primary', env)
  capture(b, plan, reference, plan.buildRun, 'reference', env)
  const out = join(a, '.deploy-tmp/candidate')
  const entry = publishCandidate(a, plan, primary, reference, out, env)
  writeFileSync(join(a, 'base-lock.json'), JSON.stringify({ schema: 1, components: { engine: entry } }))
  materialize(a, out, env)
  assert.ok(existsSync(join(a, '.deploy-tmp/engine-deploy/lib/bin.js')))
  assert.ok(existsSync(join(a, '.deploy-tmp/source-build/source-build-policy.json')))
  assert.ok(existsSync(join(a, 'vendor/dshmarketplace-plugin/lib/index.js')))
  writeFileSync(join(a, 'base-lock.json'), JSON.stringify({ schema: 1, components: { engine: { ...entry, key: 'engine-v1-wrong' } } }))
  assert.throws(() => materialize(a, out, env), /key drifted/)
})))

test('capture permits the reviewed marketplace receipt deletion but rejects other engine drift', { skip: process.platform !== 'linux' }, () => fixture(a => fixture(b => {
  const plan = makePlan(a, runtime, env)
  built(a); built(b)
  rmSync(join(a, 'vendor/dshmarketplace-plugin/PATCHES.md'))
  rmSync(join(b, 'vendor/dshmarketplace-plugin/PATCHES.md'))
  capture(a, plan, join(a, '.deploy-tmp/artifact'), plan.buildRun, 'primary', env)
  capture(b, plan, join(b, '.deploy-tmp/artifact'), plan.buildRun, 'reference', env)
  write(a, 'scripts/patches/fixture.txt', 'unreviewed change\n')
  assert.throws(() => capture(a, plan, join(a, '.deploy-tmp/poisoned'), plan.buildRun, 'primary', env), /engine inputs changed during build/)
})))
