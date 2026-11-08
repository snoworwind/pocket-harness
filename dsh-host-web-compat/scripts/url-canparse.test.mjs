import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Regression for the 0.14.12 blank conversation body: Chromium 114 WebView lacks URL.canParse
// (Chrome 120+), the upstream markdown link/image resolver calls it unguarded, and the thrown
// TypeError kills the conversation.chat.node slot entry (assistant text disappears while the
// trajectory view still shows it).
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const snippets = [...source.matchAll(/`(if\(typeof URL!==[\s\S]*?)`,/g)].map((match) => match[1])
assert.equal(snippets.length, 2, 'URL.canParse and URL.parse shims must both be present in POLYFILLS')
const [canParseShim, parseShim] = snippets

/**
 * A sandbox whose URL is a subclass so installing/removing statics never touches the native
 * URL class shared with the test runner. A bare vm context has no URL at all (Node global,
 * not a JS intrinsic), so the shim needs the constructor injected.
 */
function context(present = {}) {
  class SandboxURL extends URL {}
  SandboxURL.canParse = present.canParse
  SandboxURL.parse = present.parse
  const ctx = { URL: SandboxURL }
  runInNewContext(`${canParseShim};${parseShim}`, ctx)
  return ctx
}

test('URL.canParse reports parseability with and without a base URL', () => {
  const ctx = context()
  const evalIn = (code) => runInNewContext(code, ctx)
  assert.equal(evalIn(`URL.canParse('https://example.com/a')`), true)
  assert.equal(evalIn(`URL.canParse('/relative')`), false)
  assert.equal(evalIn(`URL.canParse('/relative', 'https://example.com/a/')`), true)
  assert.equal(evalIn(`URL.canParse('not a url')`), false)
  assert.equal(evalIn(`URL.canParse('')`), false)
})

test('URL.parse returns a URL or null instead of throwing', () => {
  const ctx = context()
  const evalIn = (code) => runInNewContext(code, ctx)
  assert.equal(evalIn(`URL.parse('/a/b', 'https://example.com/root/').pathname`), '/a/b')
  assert.equal(evalIn(`URL.parse('nope')`), null)
})

test('existing native statics are preserved', () => {
  const ctx = context({ canParse: () => 'native-canParse', parse: () => 'native-parse' })
  assert.equal(runInNewContext(`URL.canParse('x')`, ctx), 'native-canParse')
  assert.equal(runInNewContext(`URL.parse('x')`, ctx), 'native-parse')
})
