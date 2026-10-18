// The entry deliberately has no configurable build paths or runtime dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const read = name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const entry = read('build-apk.yml')
const expected = "name: build-apk\non:\n  workflow_dispatch:\n    inputs:\n      draft_release:\n        description: '源码构建成功后创建 ARM64 预发布草稿（不会公开）'\n        type: boolean\n        default: false\npermissions:\n  contents: read\njobs:\n  source-build:\n    if: ${{ !inputs.draft_release }}\n    uses: ./.github/workflows/build-apk-source.yml\n  source-draft:\n    if: ${{ inputs.draft_release }}\n    permissions:\n      contents: write\n    uses: ./.github/workflows/release-source-draft.yml"
const check = text => assert.equal(text.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n').trim(), expected.replace(/(    uses: [^\n]+)/g, '$1\n    secrets: inherit'))
test('cloud entry routes both modes exclusively through same-commit source workflows', () => check(entry))

test('source workflow rejects tags, PR refs and feature branches before checkout or secrets', { skip: process.platform !== 'linux' }, () => {
  const source = read('build-apk-source.yml')
  const start = source.indexOf('      - name: Require the maintained source branch')
  const end = source.indexOf('      - name: Checkout project source', start)
  assert.ok(start > 0 && end > start)
  const block = source.slice(start, end)
  assert.match(block, /SOURCE_REF: \$\{\{ github.ref \}\}/)
  const run = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
  for (const ref of ['refs/heads/main', 'refs/heads/codex/candidate', 'refs/tags/main', 'refs/pull/1/merge', '']) {
    const result = spawnSync('/bin/bash', ['-e', '-c', run], { env: { ...process.env, SOURCE_REF: ref } })
    assert.equal(result.status, ref === 'refs/heads/main' ? 0 : 1)
  }
})

test('both wrapper modes fail the contract if signing secrets are not passed', () => {
  for (const name of ['build-apk-source.yml', 'release-source-draft.yml']) {
    assert.throws(() => check(entry.replace(`uses: ./.github/workflows/${name}\n    secrets: inherit`, `uses: ./.github/workflows/${name}`)), assert.AssertionError)
  }
  const draft = read('release-source-draft.yml').split('  build:')[1].split('  prepare:')[0]
  assert.match(draft, /secrets: inherit/)
})
test('negative control: additional legacy job is rejected', () => {
  assert.throws(() => check(entry + '\n  legacy:\n    runs-on: ubuntu-latest\n'), assert.AssertionError)
})
test('negative control: opt-in source path is rejected', () => {
  assert.throws(() => check(entry.replace('  source-build:', '  source-build:\n    if: ${{ inputs.source_audit }}')), assert.AssertionError)
})
test('source workflow uploads explicitly listed hidden provenance with APK', () => {
  const source = read('build-apk-source.yml')
  assert.match(source, /^  workflow_call:/m)
  const upload = source.slice(source.indexOf('      - name: Upload APK and provenance'))
  assert.match(upload, /^          include-hidden-files: true$/m)
  assert.match(upload, /^          if-no-files-found: error$/m)
  assert.match(upload, /^            \.deploy-tmp\/source-build\/project-component-provenance.json$/m)
  assert.match(upload, /^            \.deploy-tmp\/source-build\/apk-sha256.txt$/m)
  assert.match(upload, /^            \.deploy-tmp\/source-build\/linux-bundle-injection.json$/m)
  assert.match(upload, /^            \.deploy-tmp\/source-build\/independent-rebuild-verification.json$/m)
  assert.match(upload, /^            \.deploy-tmp\/linux-build\/provenance\/\*\*$/m)
  assert.doesNotMatch(upload, /^            \.deploy-tmp\/\*\*$/m)
})

test('independent builders and verifier never receive production secrets; only the final signer does', () => {
  const source = read('build-apk-source.yml')
  const build = source.split('  build-arm64:')[1].split('  verify-arm64:')[0]
  const verify = source.split('  verify-arm64:')[1].split('  sign-arm64:')[0]
  const sign = source.split('  sign-arm64:')[1]
  assert.match(build, /replica: \[primary, reference\]/)
  assert.match(build, /keytool -genkeypair/)
  assert.doesNotMatch(build + verify, /secrets\./)
  assert.match(verify, /needs: build-arm64/)
  assert.match(verify, /compare-independent-builds\.mjs/)
  assert.match(sign, /needs: verify-arm64/)
  assert.match(sign, /secrets\.POCKET_SIGNING_KEYSTORE_PASSWORD/)
  assert.match(sign, /sign-source-artifacts\.mjs/)
  assert.doesNotMatch(sign, /npm |gradlew|build-apk\.mjs/)
})

test('source build overrides the checked-in Windows npm cache before any npm install', () => {
  const source = read('build-apk-source.yml')
  const setup = source.indexOf('      - name: Isolate npm cache from checked-in developer settings')
  const firstInstall = source.indexOf('npm ci')
  assert.notEqual(setup, -1)
  assert.ok(firstInstall === -1 || setup < firstInstall)
  assert.match(source.slice(setup, source.indexOf('\n      - name:', setup + 1)), /npm_config_cache=\$RUNNER_TEMP\/dsh-npm-cache/)
})

test('draft workflow builds read-only and publishes only this run artifacts as a draft', () => {
  const workflow = read('release-source-draft.yml')
  assert.match(workflow, /SOURCE_REF: \$\{\{ github.ref \}\}/)
  assert.match(workflow, /test "\$SOURCE_REF" = refs\/heads\/main/)
  const build = workflow.split('  build:')[1].split('  prepare:')[0]
  assert.match(build, /contents: read/)
  assert.match(build, /uses: \.\/\.github\/workflows\/build-apk-source.yml/)
  const draft = workflow.split('  draft:')[1]
  assert.match(draft, /needs: prepare/)
  assert.match(draft, /contents: write/)
  assert.match(draft, /--target "\$SOURCE_SHA" --draft --prerelease/)
  assert.doesNotMatch(draft, /actions\/checkout|build-apk\.mjs|npm |gradle /)
  assert.doesNotMatch(workflow, /run-id:|repository:|workflow_run:|\n  push:/)
})
