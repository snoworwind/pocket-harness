/** Regressions against the published 0.2.0-rc.2 runtime library. No child processes, devices, network, or runtime probes. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  ANDROID_ENV_NAMES, LAUNCH_HELPER_JS, assertChildClearing, assertPolicyGate,
  patchEnvironment, patchRuntimeIndex, planPatch,
} from '../ptc-android-native-A1.mjs'

const fixture = new URL('./fixtures/dsh-ptc-runtime-node-0.2.0-rc.2/', import.meta.url)
const read = name => readFileSync(new URL(name, fixture), 'utf8')
const rawIndex = read('lib/index.js')
const rawChild = read('lib/process.js')
const environment = patchEnvironment(rawIndex)
const index = patchRuntimeIndex(environment)
const child = patchEnvironment(rawChild)
const prefix = '/data/data/com.dsharnessmobile.shell/files/usr'
const node = prefix + '/bin/node'
const native = {
  TERMUX__PREFIX: prefix, TERMUX__ROOTFS: prefix.slice(0, -4),
  LD_PRELOAD: prefix + '/lib/libtermux-exec-ld-preload.so', LD_LIBRARY_PATH: prefix + '/lib',
  TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: 'force', TERMUX_EXEC__EXECVE_CALL__INTERCEPT: '1',
  TERMUX_APP__DATA_DIR: '/data/user/0/com.dsharnessmobile.shell',
  TERMUX_APP__LEGACY_DATA_DIR: '/data/data/com.dsharnessmobile.shell',
  TMPDIR: '/data/data/com.dsharnessmobile.shell/files/home/tmp',
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
/** Execute exactly the patched host launch segment with fake subprocess/sandbox services. */
async function launch(mode, options = {}) {
  const launchStart = index.search(/^[\t ]*const executable = await/m)
  const launchEnd = index.indexOf('const launched = handle;', launchStart)
  const segment = index.slice(launchStart, launchEnd)
  assert.ok(segment.includes('this.ctx.subprocess.spawn'))
  const calls = { spawn: [], confine: [], resolved: [] }
  const policy = { mode, workspaceRoot: '/workspace' }
  const context = {
    ctx: {
      fs: {},
      subprocess: {
        async resolveExecutable(executable) { calls.resolved.push(executable); return executable },
        spawn(spec) { calls.spawn.push(spec); return { fake: true } },
      },
      sandbox: {
        async confine(argv, suppliedPolicy) {
          calls.confine.push({ argv: Array.from(argv), policy: suppliedPolicy })
          if (options.unavailable) throw options.unavailable
          return { argv: ['enforcing-runner', '--', ...argv], enforcement: 'full' }
        },
      },
    },
    config: { nodeExecutable: options.executable ?? node, maxOldGenerationSizeMb: 512, maxMessageBytes: 1234, graceMs: 3000 },
  }
  const js = '(async function () {\n' + segment + '\nreturn { handle, sandbox };\n})'
  const fn = runInNewContext(LAUNCH_HELPER_JS + '\n' + js, {
    isAbsolute: posix.isAbsolute,
    process: { platform: 'android', execPath: '/system/bin/linker64', env: { PATH: prefix + '/bin:/system/bin', ...native, DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--inspect=0' } },
    STARTUP_ENVIRONMENT_NAMES: environmentSet('android'),
    bootstrapArgs: () => ['/runtime/process.js', '1234'],
    policy, signal: undefined, settled: false, result: {}, confined: undefined, handle: undefined,
    spec: { cwd: '/workspace' }, sandbox: { mode, denied: false },
  })
  try { return { calls, result: await fn.call(context) } }
  catch (error) { return { calls, error } }
}

test('published 0.2.0-rc.2 library patch is idempotent and preflights the unchanged child', () => {
  assert.equal(patchRuntimeIndex(index), index)
  assert.equal(patchEnvironment(environment), environment)
  assertChildClearing(child)
  const plan = planPatch(fileURLToPath(fixture))
  assert.deepEqual(plan.filter(file => file.before !== file.after).map(file => file.name), ['lib/index.js', 'lib/process.js'])
  assert.equal(read('lib/index.js'), rawIndex)
})
test('Android retains exactly the native settings; other platforms retain the original six names', () => {
  const android = environmentSet('android')
  for (const key of ANDROID_ENV_NAMES) assert.equal(android.has(key), true, key)
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(Array.from(environmentSet(platform)), ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])
  }
  for (const key of ['HOME', 'DEEPSEEK_API_KEY', 'DSH_PICK_TOKEN', 'NODE_OPTIONS', 'TERMUX_UNKNOWN_SECRET']) assert.equal(android.has(key), false, key)
})
test('both real linker64 locations, direct node, and shipped C1 wrapper preserve linker-before-node ordering', () => {
  for (const linker of ['/system/bin/linker64', '/apex/com.android.runtime/bin/linker64']) {
    assert.deepEqual(choose(linker), [linker, node])
    assert.deepEqual(choose(node, { execPath: linker }), [linker, node])
    assert.deepEqual(choose(prefix + '/libexec/dsh-node', { execPath: linker }), [linker, node])
  }
  assert.deepEqual(choose('/custom/node-wrapper'), ['/custom/node-wrapper'])
  assert.deepEqual(choose(node, { execPath: node }), ['/system/bin/linker64', node])
})
test('unknown linkers and invalid/missing prefixes fail loudly without guessing a target', () => {
  for (const executable of ['/tmp/linker64', '/system/bin/linker', '/tmp/ld.so.1', 'node']) assert.throws(() => choose(executable))
  for (const env of [{}, { TERMUX__PREFIX: 'relative' }, { TERMUX__PREFIX: '/snapshot/../usr' }, { TERMUX__PREFIX: '/snapshot\0/usr' }]) assert.throws(() => choose(node, { env }))
  assert.throws(() => choose('/system/bin/linker64', { platform: 'linux' }))
  assert.deepEqual(choose('/usr/bin/node', { platform: 'linux' }), ['/usr/bin/node'])
})
test('resolved full-access policy alone permits native spawn and does not inherit loader/inspector secrets', async () => {
  const run = await launch('danger-full-access')
  assert.equal(run.error, undefined)
  assert.equal(run.calls.confine.length, 0)
  assert.equal(run.calls.spawn.length, 1)
  const spec = run.calls.spawn[0]
  assert.deepEqual(Array.from(spec.argv), ['/system/bin/linker64', node, '/runtime/process.js', '1234'])
  assert.equal(spec.env.NODE_OPTIONS, '--max-old-space-size=512')
  for (const key of ANDROID_ENV_NAMES) assert.equal(Object.hasOwn(spec.env, key), false, key + ' must not be tombstoned')
  assert.equal(spec.env.DEEPSEEK_API_KEY, undefined)
  assert.equal(spec.env.DSH_PICK_TOKEN, undefined)
  assert.equal(spec.stdio.control, 'pipe')
  assert.equal(spec.cwd, '/workspace')
})
test('restricted policies never spawn when the sandbox is unavailable; no unconfined retry', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const unavailable = new Error('SANDBOX_UNAVAILABLE fixture')
    const run = await launch(mode, { unavailable })
    assert.equal(run.error, unavailable)
    assert.equal(run.calls.confine.length, 1)
    assert.equal(run.calls.confine[0].policy.mode, mode)
    assert.equal(run.calls.spawn.length, 0)
  }
  assertPolicyGate(index)
})
test('an enforcing provider keeps its complete argv and honest enforcement metadata', async () => {
  const run = await launch('workspace-write')
  assert.equal(run.error, undefined)
  assert.deepEqual(Array.from(run.calls.spawn[0].argv), ['enforcing-runner', '--', '/system/bin/linker64', node, '/runtime/process.js', '1234'])
  assert.equal(run.result.sandbox.enforcement, 'full')
  assert.equal(run.result.sandbox.mode, 'workspace-write')
})
test('published child retains only native OS values while the model-facing process.env stays empty', () => {
  const osEnv = { ...native, PATH: prefix + '/bin', DEEPSEEK_API_KEY: 'fixture-secret', DSH_PICK_TOKEN: 'fixture-token', NODE_OPTIONS: '--max-old-space-size=512' }
  const processState = { env: osEnv }
  const clearing = /^[\t ]*for \(const key of Object\.keys\(processState\.env\)\)[\s\S]*?^[\t ]*processState\.env = Object\.create\(null\);/m.exec(child)?.[0]
  assert.ok(clearing, 'published child contains its startup environment clearing boundary')
  runInNewContext(clearing, { processState, STARTUP_ENVIRONMENT_NAMES: environmentSet('android') })
  assert.deepEqual(Object.keys(processState.env), [])
  assert.equal(Object.getPrototypeOf(processState.env), null)
  for (const key of ANDROID_ENV_NAMES) assert.equal(osEnv[key], native[key])
  for (const key of ['DEEPSEEK_API_KEY', 'DSH_PICK_TOKEN', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(osEnv, key), false)
})
test('anchor, marker, heap placement, and sandbox-policy drift are rejected', () => {
  assert.throws(() => patchEnvironment(rawIndex.replace('"TMP"', '"TMPDIR"')))
  assert.throws(() => patchEnvironment(environment.replace('"LD_PRELOAD"', '"EVIL_PRELOAD"')))
  assert.throws(() => patchRuntimeIndex(rawIndex.replace('policy.mode === "danger-full-access"', 'policy.mode === "workspace-write"')))
  assert.throws(() => patchRuntimeIndex(index.replace('...launchPrefix,', '...launchPrefix, heapFlag,')))
  assert.throws(() => assertChildClearing(child.replace('processState.env = Object.create(null)', 'processState.env = {}')))
})
test('compiled formatting is covered separately, without claiming the old fixture is a newest build', () => {
  const oldBuilt = readFileSync(new URL('./fixtures/dsh-ptc-runtime-node-0.1.7-rc.2/lib/index.js', import.meta.url), 'utf8')
  const built = patchRuntimeIndex(patchEnvironment(oldBuilt))
  assert.equal(patchRuntimeIndex(patchEnvironment(built)), built)
  assertPolicyGate(built)
})
