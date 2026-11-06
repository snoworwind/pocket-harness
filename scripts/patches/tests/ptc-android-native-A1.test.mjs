/** Regressions against the current engine runtime library. No child processes, devices, network, or runtime probes. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  ANDROID_ENV_NAMES, ENV_MARKER, LAUNCH_HELPER_JS, assertChildClearing, assertPolicyGate,
  patchEnvironment, patchRuntimeIndex, planPatch,
} from '../ptc-android-native-A1.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const fixture = versionedFixture('dsh-ptc-runtime-node')
const read = name => readFileSync(join(fixture, name), 'utf8')
const rawIndex = read('lib/index.js')
const rawChild = read('lib/process.js')
const environment = patchEnvironment(rawIndex)
const index = patchRuntimeIndex(environment)
const child = patchEnvironment(rawChild)
const prefix = '/data/data/com.snoworwind.pocketharness/files/usr'
const node = prefix + '/bin/node'
const wrapper = prefix + '/libexec/dsh-node'
const native = {
  TERMUX__PREFIX: prefix, TERMUX__ROOTFS: prefix.slice(0, -4),
  LD_PRELOAD: prefix + '/lib/libtermux-exec-ld-preload.so', LD_LIBRARY_PATH: prefix + '/lib',
  TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: 'force', TERMUX_EXEC__EXECVE_CALL__INTERCEPT: '1',
  TERMUX_APP__DATA_DIR: '/data/user/0/com.snoworwind.pocketharness',
  TERMUX_APP__LEGACY_DATA_DIR: '/data/data/com.snoworwind.pocketharness',
  TMPDIR: '/data/data/com.snoworwind.pocketharness/files/home/tmp',
  OPENSSL_CONF: prefix + '/etc/tls/openssl.cnf', SSL_CERT_FILE: prefix + '/etc/tls/cert.pem',
}

function environmentSet(platform) {
  const declaration = environment.match(/const STARTUP_ENVIRONMENT_NAMES = new Set\([\s\S]*?\);/)
  assert.ok(declaration, 'published runtime startup environment declaration exists')
  return runInNewContext(declaration[0] + '\nSTARTUP_ENVIRONMENT_NAMES;', { process: { platform } })
}

function choose(executable, options = {}) {
  return Array.from(runInNewContext(LAUNCH_HELPER_JS + '\ndshMobilePtcLaunchPrefix(executable);', {
    executable, isAbsolute: posix.isAbsolute,
    process: { platform: options.platform ?? 'android', execPath: options.execPath ?? '/system/bin/linker64', env: options.env ?? native },
  }))
}

// rc1 uses one worker launch for per-call and retained-state execution. The bootstrap argument
// selects process.js or persistent-process.js; there is no second independent spawn path.
const WORKER_LAUNCH = /^[\t ]*const executable = await this\.ctx\.subprocess\.resolveExecutable\(this\.config\.launch\.executable, void 0, this\.controller\.signal\);[\s\S]*?^[\t ]*this\.handle = handle;$/m
function workerLaunch() {
  const matches = [...index.matchAll(new RegExp(WORKER_LAUNCH.source, WORKER_LAUNCH.flags + 'g'))]
  assert.equal(matches.length, 1, 'rc1 worker launch: expected exactly one anchor, got ' + matches.length)
  return matches[0][0]
}

/** Execute the published launch statements with observable subprocess and sandbox services. */
async function launch(mode, options = {}) {
  const segment = workerLaunch()
  assert.ok(segment.includes('this.ctx.subprocess.spawn'))
  assert.ok(segment.includes('dshMobilePtcLaunchPrefix(executable)'), 'launch must pass through the Android linker-prefix helper')
  const launchConfig = options.launch ?? { kind: 'node-script', executable: options.executable ?? wrapper }
  const calls = { spawn: [], confine: [], resolved: [], bootstrap: [] }
  const policy = { mode, workspaceRoot: '/workspace' }
  const context = {
    closed: false,
    controller: { signal: {} },
    retainsState: options.retainsState ?? false,
    policy,
    config: { launch: launchConfig, maxOldGenerationSizeMb: 512, maxMessageBytes: 1234, graceMs: 3000 },
    ctx: {
      fs: {},
      subprocess: {
        async resolveExecutable(executable) {
          calls.resolved.push(executable)
          if (options.cancelOnResolve) context.closed = true
          return executable
        },
        spawn(spec) { calls.spawn.push(spec); return { fake: true } },
      },
      sandbox: {
        async confine(argv, suppliedPolicy) {
          calls.confine.push({ argv: Array.from(argv), policy: suppliedPolicy })
          if (options.unavailable) throw options.unavailable
          return { argv: ['enforcing-runner', '--', ...argv], enforcement: 'full', runnerFailureRules: [] }
        },
      },
    },
  }
  const bootstrapArgs = (_fs, launchConfig, bytes, retainsState) => {
    calls.bootstrap.push({ launch: launchConfig, bytes, retainsState })
    return [retainsState ? '/runtime/persistent-process.js' : '/runtime/process.js', String(bytes)]
  }
  const program = '(async function () {\n' + segment + '\nreturn { handle: this.handle, confined: this.confined };\n}).call(context)'
  try {
    return {
      calls,
      result: await runInNewContext(LAUNCH_HELPER_JS + '\n' + program, {
        context, isAbsolute: posix.isAbsolute,
        process: { platform: 'android', execPath: '/system/bin/linker64', env: { PATH: prefix + '/bin:/system/bin', ...native, DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--inspect=0' } },
        STARTUP_ENVIRONMENT_NAMES: environmentSet('android'), bootstrapArgs, cwd: '/workspace',
      }),
    }
  } catch (error) {
    return { calls, error }
  }
}

test('published runtime library patch is idempotent and preflights the unchanged children', () => {
  assert.equal(patchRuntimeIndex(index), index)
  assert.equal(patchEnvironment(environment), environment)
  assertChildClearing(child)
  assertChildClearing(patchEnvironment(read('lib/persistent-process.js')))
  const plan = planPatch(fixture)
  assert.deepEqual(plan.filter(file => file.before !== file.after).map(file => file.name), ['lib/index.js', 'lib/process.js', 'lib/persistent-process.js'])
  assert.equal(read('lib/index.js'), rawIndex)
  assert.throws(() => planPatch(fixture, false, name => name === 'package.json'
    ? JSON.stringify({ name: '@deepseek-ai/unexpected-runtime', version: '0.2.2-rc.1' })
    : read(name)), /requires package @deepseek-ai\/dsh-ptc-runtime-node/)
})

test('Android retains exactly the native settings; other platforms retain the original six names', () => {
  const android = environmentSet('android')
  for (const key of ANDROID_ENV_NAMES) assert.equal(android.has(key), true, key)
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(Array.from(environmentSet(platform)), ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])
  }
  for (const key of ['HOME', 'DEEPSEEK_API_KEY', 'DSH_PICK_TOKEN', 'NODE_OPTIONS', 'TERMUX_UNKNOWN_SECRET']) assert.equal(android.has(key), false, key)
})

test('trusted Android linker and shipped C1 wrapper preserve linker-before-Node ordering', () => {
  for (const linker of ['/system/bin/linker64', '/apex/com.android.runtime/bin/linker64']) {
    assert.deepEqual(choose(linker), [linker, node])
    assert.deepEqual(choose(node, { execPath: linker }), [linker, node])
    assert.deepEqual(choose(wrapper, { execPath: linker }), [linker, node])
  }
  assert.deepEqual(choose('/custom/node-wrapper'), ['/custom/node-wrapper'])
  assert.deepEqual(choose(node, { execPath: node }), ['/system/bin/linker64', node])
})

test('unknown linkers and invalid or missing prefixes fail loudly without guessing a target', () => {
  for (const executable of ['/tmp/linker64', '/system/bin/linker', '/tmp/ld.so.1', 'node']) assert.throws(() => choose(executable))
  for (const env of [{}, { TERMUX__PREFIX: 'relative' }, { TERMUX__PREFIX: '/snapshot/../usr' }, { TERMUX__PREFIX: '/snapshot\0/usr' }]) assert.throws(() => choose(node, { env }))
  assert.throws(() => choose('/system/bin/linker64', { platform: 'linux' }))
  assert.deepEqual(choose('/usr/bin/node', { platform: 'linux' }), ['/usr/bin/node'])
})

test('resolved full-access policy alone permits native worker launch and secrets do not reach it', async () => {
  for (const executable of [node, wrapper]) {
    const run = await launch('danger-full-access', { executable })
    assert.equal(run.error, undefined)
    assert.equal(run.calls.confine.length, 0)
    assert.equal(run.calls.spawn.length, 1)
    assert.deepEqual(run.calls.resolved, [executable, node])
    const spec = run.calls.spawn[0]
    assert.deepEqual(Array.from(spec.argv), ['/system/bin/linker64', node, '/runtime/process.js', '1234'])
    assert.equal(spec.env.NODE_OPTIONS, '--max-old-space-size=512')
    assert.equal(Object.hasOwn(spec.env, 'DSH_PTC_RUNTIME_NODE'), false)
    for (const key of ANDROID_ENV_NAMES) assert.equal(Object.hasOwn(spec.env, key), false, key + ' must not be tombstoned')
    assert.equal(spec.env.DEEPSEEK_API_KEY, undefined)
    assert.equal(spec.env.DSH_PICK_TOKEN, undefined)
    assert.equal(spec.stdio.control, 'pipe')
    assert.equal(spec.cwd, '/workspace')
    assert.equal(run.calls.bootstrap.length, 1)
    assert.deepEqual(run.calls.bootstrap[0].launch, { kind: 'node-script', executable })
    assert.equal(run.calls.bootstrap[0].bytes, 1234)
    assert.equal(run.calls.bootstrap[0].retainsState, false)
  }
})

test('embedded and retained-state PTC modes select their bootstrap companions on the shared launch', async () => {
  const embedded = '/opt/dsh/embedded-node'
  const embeddedRun = await launch('danger-full-access', { launch: { kind: 'embedded', executable: embedded } })
  assert.equal(embeddedRun.error, undefined)
  assert.deepEqual(embeddedRun.calls.resolved, [embedded])
  assert.deepEqual(Array.from(embeddedRun.calls.spawn[0].argv), [embedded, '/runtime/process.js', '1234'])
  assert.equal(embeddedRun.calls.spawn[0].env.NODE_OPTIONS, '--max-old-space-size=512')
  assert.equal(embeddedRun.calls.spawn[0].env.DSH_PTC_RUNTIME_NODE, '1')

  const retained = await launch('danger-full-access', { retainsState: true })
  assert.equal(retained.error, undefined)
  assert.equal(retained.calls.spawn.length, 1, 'rc1 uses one worker launch for both execution modes')
  assert.deepEqual(Array.from(retained.calls.spawn[0].argv), ['/system/bin/linker64', node, '/runtime/persistent-process.js', '1234'])
  assert.equal(retained.calls.bootstrap[0].retainsState, true)
})

test('restricted policies never spawn when sandboxing is unavailable and preserve enforcing argv', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const unavailable = new Error('SANDBOX_UNAVAILABLE fixture')
    const blocked = await launch(mode, { unavailable })
    assert.equal(blocked.error, unavailable)
    assert.equal(blocked.calls.confine.length, 1)
    assert.equal(blocked.calls.confine[0].policy.mode, mode)
    assert.deepEqual(blocked.calls.confine[0].argv, ['/system/bin/linker64', node, '/runtime/process.js', '1234'])
    assert.equal(blocked.calls.spawn.length, 0)

    const allowed = await launch(mode)
    assert.equal(allowed.error, undefined)
    assert.deepEqual(Array.from(allowed.calls.spawn[0].argv), ['enforcing-runner', '--', '/system/bin/linker64', node, '/runtime/process.js', '1234'])
    assert.equal(allowed.result.confined.enforcement, 'full')
  }
  assertPolicyGate(index, 1)
  assert.equal([...index.matchAll(/this\.ctx\.sandbox\.confine\(argv,/g)].length, 1)
})

test('cancellation after executable resolution does not spawn', async () => {
  const run = await launch('danger-full-access', { cancelOnResolve: true })
  assert.equal(run.error, undefined)
  assert.equal(run.calls.spawn.length, 0)
})

test('published child clears secrets and exposes an empty model environment', () => {
  const osEnv = { ...native, PATH: prefix + '/bin', DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--max-old-space-size=512' }
  const processState = { env: osEnv }
  const clearing = /^function clearProgramEnvironment\(state\) \{\n[\s\S]*?\n\}/m.exec(child)?.[0]
  assert.ok(clearing, 'published child contains its startup environment clearing boundary')
  assert.match(child, /clearProgramEnvironment\(processState\);/)
  runInNewContext(clearing + '\nclearProgramEnvironment(processState);', { processState, STARTUP_ENVIRONMENT_NAMES: environmentSet('android') })
  assert.deepEqual(Object.keys(processState.env), [])
  assert.equal(Object.getPrototypeOf(processState.env), null)
  assert.equal(Object.hasOwn(osEnv, 'DEEPSEEK_API_KEY'), false)
  for (const key of ANDROID_ENV_NAMES) assert.equal(osEnv[key], native[key])
})

test('anchor, marker, heap placement, and sandbox-policy drift are rejected', () => {
  assert.throws(() => patchEnvironment(rawIndex.replace('"TMP"', '"TMPDIR"')))
  assert.throws(() => patchEnvironment(environment.replace('"LD_PRELOAD"', '"EVIL_PRELOAD"')))
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('policy.mode === "danger-full-access"', 'policy.mode === "workspace-write"')), /resolved-policy confinement gate/)
  assert.throws(() => assertPolicyGate(index.replace('policy.mode === "danger-full-access"', 'policy.mode === "workspace-write"'), 1), /every sandbox spawn path|expected reviewed anchors/)
  assert.throws(() => assertPolicyGate(index + '\nconst unrevisedSpawn = () => this.ctx.sandbox.confine(argv, {});\n', 1), /every sandbox spawn path/)
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('const packaged = this.config.launch.kind === "embedded";', 'const packaged = "pkg" in process && this.config.launch.bootstrapPath === void 0;')), /launch block differs from reviewed upstream/)
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, this.retainsState)', 'bootstrapArgs(this.ctx.fs, this.config, this.config.maxMessageBytes, this.retainsState)')), /launch block differs from reviewed upstream/)
  assert.throws(() => patchRuntimeIndex(index.replace('...launchPrefix,', '...launchPrefix, heapFlag,')))
  assert.throws(() => assertChildClearing(child.replace('state.env = Object.create(null)', 'state.env = {}')))
})

test('older published artifacts are rejected and void 0 or undefined compile forms normalize equally', () => {
  const oldFixture = new URL('./fixtures/dsh-ptc-runtime-node-0.2.0-rc.2/', import.meta.url)
  const oldIndex = readFileSync(new URL('lib/index.js', oldFixture), 'utf8')
  assert.equal(JSON.parse(readFileSync(new URL('package.json', oldFixture), 'utf8')).version, '0.2.0-rc.2')
  assert.match(oldIndex, /this\.config\.nodeExecutable/)
  assert.throws(() => planPatch(fileURLToPath(oldFixture)))
  const reworded = rawIndex.replace(
    'resolveExecutable(this.config.launch.executable, void 0, this.controller.signal);',
    'resolveExecutable(this.config.launch.executable, undefined, this.controller.signal);')
  assert.notEqual(reworded, rawIndex, 'replacement must change the fixture before normalization is checked')
  const rebuilt = patchRuntimeIndex(patchEnvironment(reworded))
  assert.equal(rebuilt, index)
  assertPolicyGate(rebuilt, 1)
})

test('apply-patches writes all PTC companion files after the prerequisite L1 patch', () => {
  const NODE = process.argv0 && posix.isAbsolute(process.argv0) ? process.argv0 : process.execPath
  const scratch = mkdtempSync(join(tmpdir(), 'ptc-apply-'))
  try {
    const runtime = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node'
    const root = join(scratch, runtime)
    for (const name of ['package.json', 'lib/index.js', 'lib/process.js', 'lib/persistent-process.js']) {
      const target = join(root, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, read(name).replace(/\r\n/g, '\n'))
    }
    const runner = fileURLToPath(new URL('../apply-patches.mjs', import.meta.url))
    const apply = only => spawnSync(NODE, [runner, scratch, '--apply', '--scope', 'engine', '--only', only], { encoding: 'utf8' })
    const prerequisite = apply('ptc-argv-L1')
    assert.equal(prerequisite.status, 0, (prerequisite.stderr || prerequisite.stdout || '').trim())
    const applied = apply('ptc-android-native-A1')
    assert.equal(applied.status, 0, (applied.stderr || applied.stdout || '').trim())
    for (const name of ['lib/index.js', 'lib/process.js', 'lib/persistent-process.js']) {
      assert.ok(readFileSync(join(root, name), 'utf8').includes(ENV_MARKER), name + ' must be patched')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
