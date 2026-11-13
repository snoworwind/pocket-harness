import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const workflow = readFileSync(new URL('../../.github/workflows/build-base.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const sourceWorkflow = readFileSync(new URL('../../.github/workflows/build-apk-source.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
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
  assert.match(resolve, /key: base-engine-\$\{\{ steps\.plan\.outputs\.key \}\}/)
  assert.match(resolve, /engine-base\.mjs reuse-self/)
  assert.equal((text.match(/uses: actions\/setup-java@cf277c60eb25467037889841efdb72551f06f6c3/g) ?? []).length, 6,
    'both trusted-base jobs must retry the pinned Java action up to three attempts')
  assert.equal((text.match(/java-version: '17\.0\.20\+8'/g) ?? []).length, 6,
    'all trusted-base Java attempts must use the same exact Temurin build')
  assert.equal((text.match(/continue-on-error: true/g) ?? []).length, 4,
    'only the first two Java attempts in each job may continue')
  assert.match(resolve, /id: resolve_java_attempt_1[\s\S]*?id: resolve_java_attempt_2[\s\S]*?id: resolve_java_attempt_3/)
  assert.match(build, /id: build_java_attempt_1[\s\S]*?id: build_java_attempt_2[\s\S]*?id: build_java_attempt_3/)
  assert.match(resolve, /if: steps\.resolve_java_attempt_1\.outcome == 'failure'[\s\S]*?if: steps\.resolve_java_attempt_2\.outcome == 'failure'/)
  assert.match(build, /if: steps\.build_java_attempt_1\.outcome == 'failure'[\s\S]*?if: steps\.build_java_attempt_2\.outcome == 'failure'/)
  assert.equal((text.match(/npm install -g corepack@0\.36\.0 --ignore-scripts --no-audit --no-fund --fetch-retries=8 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000/g) ?? []).length, 2,
    'trusted-base cache-miss and resolve jobs must both retry the pinned Corepack package fetch')
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
  assert.equal((text.match(/path: \.deploy-tmp\/base-cache\n/g) ?? []).length, 3, 'cache restore/save paths must share the same cache version')
  assert.equal((text.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 3)
}
function checkSourceCachePath(text) {
  const restore = text.split('      - name: Restore engine base by content key\n')[1]?.split('      - name: Materialize trusted engine base\n')[0]
  const materialize = text.split('      - name: Materialize trusted engine base\n')[1]?.split('      - name: Fail closed when the auto-built engine base is unavailable\n')[0]
  assert.ok(restore, 'source workflow must restore the trusted engine base')
  assert.ok(materialize, 'source workflow must materialize the trusted engine base')
  const restorePath = restore.match(/^\s+path: (.+)$/m)?.[1]
  assert.equal(restorePath, '.deploy-tmp/base-cache', 'restore path must use the cache path saved by build-base.yml')
  assert.match(materialize, /engine-base\.mjs materialize-self \.deploy-tmp\/base-cache \.deploy-tmp\/engine-base-plan\.json/)
}
test('base workflow restricts source refs and publishes only after actual dual comparison', () => check(workflow))
test('source workflow restores and materializes the exact build-base cache path', () => checkSourceCachePath(sourceWorkflow))
test('controlled workflow regressions reject bypassed comparison and cache writes', () => {
  for (const bad of [workflow.replace('engine-base.mjs compare', 'true # omitted comparison'),
    workflow.replace('replica: [primary, reference]', 'replica: [primary]'),
    workflow.replace('--fetch-retries=8', '--fetch-retries=2'),
    workflow.replace("java-version: '17.0.20+8'", "java-version: '17'"),
    workflow.replace('id: resolve_java_attempt_3', '# third resolve setup-java id omitted'),
    workflow.replace('id: build_java_attempt_3', '# third build setup-java id omitted'),
    workflow.replace('path: .deploy-tmp/base-cache', 'path: .deploy-tmp/other'),
    workflow + '\n# restore-keys: broad-prefix\n']) assert.throws(() => check(bad), assert.AssertionError)
  assert.throws(() => checkSourceCachePath(sourceWorkflow.replace('path: .deploy-tmp/base-cache', 'path: .deploy-tmp/engine-base-cache')), assert.AssertionError)
})
