import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const workflow = readFileSync(new URL('../../.github/workflows/build-base.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
function check(text) {
  assert.match(text, /^  workflow_dispatch:/m)
  assert.match(text, /^  workflow_call:/m)
  assert.doesNotMatch(text, /restore-keys:|secrets\.|contents: write|git push|build-apk|sign-source-artifacts/)
  const resolve = text.split('  resolve:')[1].split('\n  build:')[0]
  const build = text.split('\n  build:')[1].split('\n  compare:')[0]
  const compare = text.split('\n  compare:')[1]
  assert.ok(resolve.indexOf('test "$SOURCE_REF" = refs/heads/main') < resolve.indexOf('uses: actions/checkout@'))
  assert.match(resolve, /test "\$COMPONENT" = engine/)
  assert.match(resolve, /main\|refs\/heads\/main\) ;;/)
  assert.match(resolve, /steps\.plan\.outputs\.trusted == 'true' && !inputs\.force/)
  assert.match(resolve, /engine-base\.mjs reuse/)
  assert.match(build, /replica: \[primary, reference\]/)
  assert.match(build, /github\.ref == 'refs\/heads\/main'/)
  assert.match(build, /engine-base\.mjs check-plan/)
  assert.match(build, /bash scripts\/source-build\/build-engine\.sh/)
  assert.match(build, /engine-base\.mjs capture/)
  assert.match(compare, /needs: \[resolve, build\]/)
  assert.match(compare, /github\.ref == 'refs\/heads\/main'/)
  const compareAt = compare.indexOf('engine-base.mjs compare')
  assert.ok(compareAt >= 0 && compareAt < compare.indexOf('uses: actions/cache/save@'))
  assert.match(compare, /cache_key=base-engine-\$\{manifest\.key\}-\$\{createHash/)
  assert.equal((text.match(/path: \.deploy-tmp\/base-cache\n/g) ?? []).length, 2, 'cache restore/save paths must share the same cache version')
  assert.equal((text.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 3)
}
test('base workflow is main-only and publishes only after actual dual comparison', () => check(workflow))
test('controlled workflow regressions reject bypassed comparison and cache writes', () => {
  for (const bad of [workflow.replace('engine-base.mjs compare', 'true # omitted comparison'),
    workflow.replace('replica: [primary, reference]', 'replica: [primary]'),
    workflow.replace('path: .deploy-tmp/base-cache', 'path: .deploy-tmp/other'),
    workflow + '\n# restore-keys: broad-prefix\n']) assert.throws(() => check(bad), assert.AssertionError)
})
