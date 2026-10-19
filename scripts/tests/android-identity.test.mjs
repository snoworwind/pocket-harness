import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'
import { isAccessibilityBound } from '../lib/android-identity.mjs'
import { isAppAbsoluteTarget } from '../lib/symlink-sanitize.mjs'

const app = 'com.snoworwind.pocketharness'
const namespace = 'com.snoworwind.pocketharness'
const legacy = 'com.dsharnessmobile.shell'
const service = `${app}/${namespace}.DeviceControlService`
const bound = (component) => `Bound services:{Service[1]\n  ${component}}`
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

function assertNamespaceSources(entries) {
  const directory = namespace.replaceAll('.', '/') + '/'
  for (const { path, source } of entries) {
    assert.ok(path.startsWith(directory), `wrong source directory: ${path}`)
    const declared = /^\s*package\s+([A-Za-z0-9_.]+)\s*;?\s*$/m.exec(source)?.[1]
    assert.equal(declared, namespace, `wrong package: ${path}`)
    assert.equal(source.includes(legacy), false, `legacy class reference: ${path}`)
  }
}

test('all production, unit, instrumentation and AIDL source paths and declarations use the new namespace', () => {
  for (const base of ['app/src/main/java/', 'app/src/test/java/', 'app/src/androidTest/java/', 'app/src/main/aidl/']) {
    const files = readdirSync(new URL('../../' + base, import.meta.url), { recursive: true })
      .map(String).map((s) => s.replaceAll('\\', '/')).filter((s) => /\.(kt|aidl)$/.test(s))
    assert.ok(files.length, base)
    assertNamespaceSources(files.map((path) => ({ path, source: read(base + path) })))
  }
  // Controlled negatives: changing declarations alone, or moving an old AIDL alone, must both fail.
  assert.throws(() => assertNamespaceSources([{ path: legacy.replaceAll('.', '/') + '/Main.kt', source: `package ${namespace}` }]))
  assert.throws(() => assertNamespaceSources([{ path: namespace.replaceAll('.', '/') + '/Service.aidl', source: `package ${legacy};` }]))
})

test('AIDL descriptor migration invalidates cached Shizuku services and moves the root entry point', () => {
  const base = 'app/src/main/java/com/snoworwind/pocketharness/'
  assert.match(read(base + 'ShizukuUserService.kt'), /const val PROTOCOL_VERSION = 5/)
  assert.match(read(base + 'ShizukuTransport.kt'), /ComponentName\(context\.packageName, ShizukuUserServiceBridge::class\.java\.name\)/)
  assert.match(read(base + 'ShizukuTransport.kt'), /\.version\(BuildConfig\.VERSION_CODE \* 10 \+ ShizukuUserServiceBridge\.PROTOCOL_VERSION\)/)
  assert.ok(read(base + 'RootAccess.kt').includes(namespace + '.RootRepairMain '))
  assert.match(read(base + 'RootRepairMain.kt'), /@JvmStatic\s+fun main\(/)
})

test('only the exact installed component in bound services counts as accessibility enabled', () => {
  assert.equal(isAccessibilityBound(bound(service)), true)
  assert.equal(isAccessibilityBound(`Bound services:[${service}]`), true)
  assert.equal(isAccessibilityBound(bound(`${app}/.DeviceControlService`)), true)
  for (const component of [
    `${legacy}/${legacy}.DeviceControlService`, `${app}/${legacy}.DeviceControlService`,
    `other.${service}`, `${service}.old`, service.replace(app, 'comXsnoworwindYpocketharness'),
  ]) assert.equal(isAccessibilityBound(bound(component)), false, component)
  assert.equal(isAccessibilityBound(`Enabled services:{${service}}\nBound services:{other/.Service}`), false)
  assert.equal(isAccessibilityBound(`Bound services:{}\nEnabled services:{${service}}`), false)
  assert.equal(isAccessibilityBound(''), false)
  // Controlled negative: the retired namespace-substring predicate accepts the old app.
  assert.equal(/dsharnessmobile/.test(bound(`${legacy}/${legacy}.DeviceControlService`)), true)
})

test('runtime aliases belong to the new app, never the old application identity', () => {
  for (const user of [0, 10]) {
    assert.equal(isAppAbsoluteTarget(`/data/user/${user}/${app}/files/usr/bin/bash`), true)
    assert.equal(isAppAbsoluteTarget(`/data/user/${user}/${legacy}/files/usr/bin/bash`), false)
  }
  assert.equal(isAppAbsoluteTarget(`/data/data/${app}/files/usr/bin/bash`), true)
})

test('actual launch expressions resolve to the migrated full class', () => {
  for (const file of ['scripts/hot-push.mjs', 'scripts/verify-client-plugin-fail-recovery.mjs',
    'scripts/verify-notify-consumption.mjs', 'scripts/verify-state-sync.mjs']) {
    const source = read(file)
    assert.doesNotMatch(source, /\/\.MainActivity/)
    const expressions = [...source.matchAll(/(?:'am start[^'\n]*' \+ (?:APP_ID|PKG) \+ '[^'\n]*'|`am start[^`\n]*`)/g)]
    if (file.endsWith('verify-state-sync.mjs')) {
      const arrays = [...source.matchAll(/\['am', 'start', [^\]\n]+\]/g)]
      assert.ok(arrays.length >= 2, file)
      for (const [expression] of arrays) {
        assert.ok(vm.runInNewContext(expression, { PKG: app }).includes(`${app}/${namespace}.MainActivity`))
      }
    } else assert.ok(expressions.length, file)
    for (const [expression] of expressions) {
      const command = vm.runInNewContext(expression, { APP_ID: app, PKG: app })
      assert.ok(command.includes(`${app}/${namespace}.MainActivity`), `${file}: ${command}`)
    }
  }
  assert.match(read('scripts/perf/measure-steady.ps1'), /\$act = "\$pkg\/com\.snoworwind\.pocketharness\.MainActivity"/)
  assert.match(read('app/build.gradle.kts'), /namespace = "com\.snoworwind\.pocketharness"/)
  assert.match(read('app/src/main/java/com/snoworwind/pocketharness/MainActivity.kt'), /package com\.snoworwind\.pocketharness/)
})

test('both device suites consume the exact binding predicate', () => {
  assert.match(read('scripts/verify-screen-scope-matrix.mjs'), /const boundOurs = isAccessibilityBound\(a11yBound\)/)
  assert.match(read('scripts/verify-adb-only-tree.mjs'), /return isAccessibilityBound\(accessibilityDump, pkg\)/)
})

test('hot push fails instead of claiming a restart when am reports a missing component', () => {
  const source = read('scripts/hot-push.mjs')
  const restart = source.slice(source.lastIndexOf('if (RESTART)'))
  for (const failed of [{ status: 1, stderr: 'offline' }, { status: 0, stdout: 'Error type 3\nError: Activity class does not exist.' }]) {
    const output = []
    assert.throws(() => vm.runInNewContext(restart, {
      RESTART: true, APP_ID: app,
      adb: () => failed,
      console: { log: (s) => output.push(s), error: () => {} },
      process: { exit: (code) => { throw new Error(`exit ${code}`) } },
    }), /exit 1/)
    assert.equal(output.some((s) => s.startsWith('已重启')), false)
  }
})
