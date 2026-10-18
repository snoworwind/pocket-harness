/** Executes the production bootstrap JavaScript in VM contexts. This is not Android frame/CDP evidence. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../app/src/main/java/com/dsharnessmobile/shell/MainFrameBridge.kt', import.meta.url), 'utf8')
const match = source.match(/internal\s+val\s+BOOTSTRAP_TEMPLATE\s*=\s*"""([\s\S]*?)"""\.trimIndent\(\)/)
assert.ok(match, 'extract the production Kotlin bootstrap, not a test-only copy')
const origin = 'http://127.0.0.1:3080'
const token = 'test-private-nonce-721c836b718e4c0b9e3276a9'
const methods = { androidBridge: ['setScreenScope', 'getScreenScope', 'browserHostShow'], dshBackBridge: ['setAvailable', 'getBackAvailable'] }
const script = match[1].replaceAll('__ORIGIN_JSON__', JSON.stringify(origin))
  .replaceAll('__TOKEN_JSON__', JSON.stringify(token)).replaceAll('__METHODS_JSON__', JSON.stringify(methods))

function fixture({ frame = 'top', currentOrigin = origin } = {}) {
  const calls = []
  const authorized = []
  let scope = 'virtual-only'
  let back = false
  const transport = {
    invoke(supplied, interfaceName, methodName, argsJson) {
      calls.push({ supplied, interfaceName, methodName, argsJson })
      if (supplied !== token || !Object.hasOwn(methods, interfaceName) || !methods[interfaceName].includes(methodName)) {
        return JSON.stringify({ ok: false, error: 'bridge-denied' })
      }
      const args = JSON.parse(argsJson)
      authorized.push({ interfaceName, methodName, args })
      if (methodName === 'setScreenScope') { scope = args[0]; return JSON.stringify({ ok: true, value: scope }) }
      if (methodName === 'getScreenScope') return JSON.stringify({ ok: true, value: scope })
      if (methodName === 'browserHostShow') return JSON.stringify({ ok: true, value: args.length === 0 ? 'zero' : args[0] })
      if (methodName === 'setAvailable') { back = args[0]; return JSON.stringify({ ok: true, void: true }) }
      return JSON.stringify({ ok: true, value: back })
    },
  }
  const sandbox = { location: new URL(currentOrigin), __dshNativeBridge: transport, dispatchEvent() {},
    Event: class Event { constructor(type) { this.type = type } } }
  sandbox.window = sandbox
  sandbox.self = sandbox
  if (frame === 'top') sandbox.top = sandbox
  else if (frame === 'opaque') sandbox.top = new Proxy({}, { get() { throw new Error('cross-origin access denied') } })
  else sandbox.top = { location: { origin }, androidBridge: { forbidden: true } }
  const context = vm.createContext(sandbox)
  return { sandbox, context, calls, authorized, install() { return vm.runInContext(script, context) },
    run(code) { return vm.runInContext(code, context) } }
}

test('trusted top frame preserves synchronous values, null, void, overload arity and both interfaces', () => {
  const f = fixture()
  f.install()
  assert.equal(f.run('androidBridge.getScreenScope()'), 'virtual-only')
  assert.equal(f.run('androidBridge.setScreenScope("all")'), 'all')
  assert.equal(f.run('androidBridge.getScreenScope()'), 'all')
  assert.equal(f.run('androidBridge.browserHostShow()'), 'zero')
  assert.equal(f.run('androidBridge.browserHostShow(null)'), null)
  assert.equal(f.run('androidBridge.browserHostShow("https://example.invalid")'), 'https://example.invalid')
  assert.equal(f.run('dshBackBridge.setAvailable(true)'), undefined)
  assert.equal(f.run('dshBackBridge.getBackAvailable()'), true)
  assert.deepEqual(f.authorized.map(call => call.args.length), [0, 1, 0, 0, 1, 1, 1, 0])
})

for (const frame of ['opaque', 'same-origin']) {
  // This verifies installation, not browser SOP: an actual same-origin child can still call a
  // parent's public facade. Untrusted HTML previews must retain their opaque sandbox origin.
  test(`${frame} child with raw transport cannot install either facade or recover nonce`, () => {
    const f = fixture({ frame })
    f.install()
    assert.equal(f.run('typeof androidBridge'), 'undefined')
    assert.equal(f.run('typeof dshBackBridge'), 'undefined')
    assert.equal(f.calls.length, 0)
    assert.equal(f.run('JSON.stringify(Object.keys(window))').includes(token), false)
    const denial = f.run('__dshNativeBridge.invoke("guessed", "androidBridge", "setScreenScope", "[\\"all\\"]")')
    assert.equal(JSON.parse(denial).ok, false)
    assert.equal(f.authorized.length, 0)
  })
}

test('untrusted top-level origin cannot install a facade despite receiving the raw transport', () => {
  const f = fixture({ currentOrigin: 'https://attacker.invalid' })
  f.install()
  assert.equal(f.run('typeof androidBridge'), 'undefined')
  assert.equal(f.run('typeof dshBackBridge'), 'undefined')
  assert.equal(f.calls.length, 0)
})

test('public function source does not reveal the nonce and methods are an explicit allowlist', () => {
  const f = fixture()
  f.install()
  for (const [name, names] of Object.entries(methods)) {
    for (const method of names) assert.equal(f.run(`${name}.${method}.toString()`).includes(token), false)
    assert.equal(f.run(`Object.prototype.hasOwnProperty.call(${name}, "invoke")`), false)
    assert.equal(f.run(`Object.prototype.hasOwnProperty.call(${name}, "getClass")`), false)
  }
  assert.equal(f.run('JSON.stringify(Object.keys(window))').includes(token), false)
  assert.equal(JSON.parse(f.sandbox.__dshNativeBridge.invoke(token, 'androidBridge', 'getClass', '[]')).ok, false)
  assert.equal(f.authorized.length, 0)
})

test('repeated bootstrap execution keeps already captured facade functions usable', () => {
  const f = fixture()
  f.install()
  f.run('globalThis.capturedGetter = androidBridge.getScreenScope; globalThis.capturedFacade = androidBridge; globalThis.capturedBack = dshBackBridge')
  f.install()
  assert.equal(f.run('capturedFacade === androidBridge && capturedBack === dshBackBridge'), true)
  assert.equal(f.run('androidBridge.setScreenScope("real-only")'), 'real-only')
  assert.equal(f.run('capturedGetter()'), 'real-only')
  assert.equal(f.run('dshBackBridge.getBackAvailable()'), false)
})

test('fallback checks actual origin when queued code runs after a cross-origin navigation', () => {
  const f = fixture()
  // Simulate Kotlin scheduling while trusted, followed by a different document before execution.
  assert.equal(f.sandbox.location.origin, origin)
  f.sandbox.location = new URL('https://attacker.invalid')
  f.install()
  assert.equal(f.run('typeof androidBridge'), 'undefined')
  assert.equal(f.run('typeof dshBackBridge'), 'undefined')
  assert.equal(f.calls.length, 0)
})
