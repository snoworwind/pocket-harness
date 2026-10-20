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

const engine = () => readFileSync(new URL('./build-engine.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n').split('\n').map(line => '          ' + line).join('\n')
function checkEngine021Build(source) {
  assert.match(source, /packageManager!=="pnpm@11\.28\.5"/)
  assert.match(source, /npm install -g corepack@0\.36\.0 --ignore-scripts/)
  const start = source.indexOf('          corepack pnpm run build:native-system')
  const end = source.indexOf('          # Audit all overlay-pinned vendor', start)
  assert.ok(start > 0 && end > start)
  const rootReceipt = source.indexOf('          cp package.json "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-root-package.json.original"')
  assert.ok(rootReceipt > source.indexOf('          cd .deploy-tmp/deepseek-harness') && rootReceipt < start, 'freeze the required raw root manifest before compilation')
  const build = source.slice(start, end)
  const steps = ['run build:native-system', 'exec tsx scripts/compile-referenced-projects.ts host-libraries',
    'exec tsx scripts/compile-referenced-projects.ts client', 'exec tsdown --config-loader native --env.DSH_BUILD_FACE client', 'run build:web', 'git diff --exit-code']
  let previous = -1
  for (const step of steps) {
    const position = build.indexOf(step)
    assert.ok(position > previous, 'required official artifact step/order: ' + step)
    previous = position
  }
  assert.doesNotMatch(source.slice(source.indexOf('          cd .deploy-tmp/deepseek-harness'), end), /fs\.writeFileSync\(path, temporary\)|corepack pnpm --recursive --if-present run bundle|corepack pnpm run build\n/)
}

test('0.2.1 source build follows official artifact stages without rewriting upstream manifests', () => checkEngine021Build(engine()))
test('negative controls reject a missing source compiler, stale package manager and obsolete recursive builder', () => {
  const source = engine()
  for (const bad of [source.replace('exec tsx scripts/compile-referenced-projects.ts client', 'exec true'),
    source.replace('          cp package.json "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-root-package.json.original"', '          # root receipt omitted'),
    source.replace('pnpm@11.28.5', 'pnpm@11.7.0'),
    source.replace('          corepack pnpm run build:web', '          corepack pnpm --recursive --if-present run bundle\n          corepack pnpm run build:web')]) {
    assert.throws(() => checkEngine021Build(bad), assert.AssertionError)
  }
})

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
  assert.match(upload, /^            \.deploy-tmp\/source-build\/effective-engine-overlay-restoration\.json$/m)
  assert.doesNotMatch(upload, /^            \.deploy-tmp\/\*\*$/m)
})

function checkCachedEffectiveOverlay(source) {
  const positive = source.indexOf('node scripts/source-build/restore-effective-engine-overlay.mjs --self-test')
  const negative = source.indexOf('node scripts/source-build/restore-effective-engine-overlay.mjs --self-test-negative')
  const install = source.indexOf('node scripts/source-build/restore-effective-engine-overlay.mjs', negative + 1)
  const addNodeStep = source.indexOf('      - name: Add Node.js to the clean Termux base')
  const runtimeStep = source.indexOf('      - name: Build runtime snapshot from verified inputs')
  const endAddNodeStep = source.indexOf('      - name: Verify signed Termux repository', addNodeStep)
  assert.ok(positive > 0 && negative > positive, 'source-only overlay restore requires a positive self-test and controlled negative')
  assert.ok(addNodeStep > 0 && install > addNodeStep && install < endAddNodeStep && endAddNodeStep < runtimeStep,
    'authenticated effective overlay must be installed before the snapshot builder reads it')
  const block = source.slice(install, endAddNodeStep)
  for (const path of [
    '.deploy-tmp/source-build/engine-overlay.original.json',
    '.deploy-tmp/source-build/effective-engine-overlay.restore-input.json',
    '.deploy-tmp/source-build/effective-engine-overlay-policy.restore-input.json',
    '.deploy-tmp/source-build/source-build-policy.json',
    'scripts/snapshot-config/engine-overlay.json',
    '.deploy-tmp/source-build/effective-engine-overlay-restoration.json',
  ]) assert.ok(block.includes(path), 'effective-overlay restore is missing input/output: ' + path)
  assert.equal((source.match(/^            \.deploy-tmp\/source-build\/effective-engine-overlay-restoration\.json$/gm) ?? []).length, 4,
    'the restore command and all three APK artifact stages must name the restoration receipt')
  for (const path of [
    '.deploy-tmp/source-build/effective-engine-overlay.restore-input.json',
    '.deploy-tmp/source-build/effective-engine-overlay-policy.restore-input.json',
  ]) {
    const escaped = path.replaceAll('.', '\\.')
    assert.equal((source.match(new RegExp('^            ' + escaped + '$', 'gm')) ?? []).length, 4,
      'the immutable restore input must be copied, validated, and uploaded in all three APK artifact stages: ' + path)
  }
}
test('trusted cache restores its source-built runtime overlay before snapshot construction', () => {
  checkCachedEffectiveOverlay(read('build-apk-source.yml'))
})
function checkCachedProjectComponentInputs(source, base) {
  const materialize = source.indexOf('      - name: Materialize trusted engine base')
  const freeze = source.indexOf('      - name: Freeze current project component inputs for trusted cache hit')
  const buildFromSource = source.indexOf('      - name: Build and pack DeepSeek Harness from source')
  assert.ok(materialize > 0 && freeze > materialize && buildFromSource > freeze,
    'a trusted cache hit must recreate project provenance after materialization and before source/cache paths diverge')
  const end = source.indexOf('\n      - name:', freeze + 1)
  const block = source.slice(freeze, end)
  assert.match(block, /if: steps\.engine-cache\.outputs\.cache-hit == 'true'/)
  assert.match(block, /record-project-components\.mjs inputs/)
  assert.match(block, /\.deploy-tmp\/source-build\/project-component-provenance\.json/)
  assert.doesNotMatch(base, /['"]project-component-provenance\.json['"]/,
    'project commit provenance must be recomputed per run, not restored from engine-only cache')
}
test('trusted engine cache hit freezes project component inputs from the current checkout', () => {
  checkCachedProjectComponentInputs(read('build-apk-source.yml'),
    readFileSync(new URL('./engine-base.mjs', import.meta.url), 'utf8'))
})
test('negative controls reject missing or unconditional cached project provenance refresh', () => {
  const source = read('build-apk-source.yml')
  const base = readFileSync(new URL('./engine-base.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('      - name: Freeze current project component inputs for trusted cache hit')
  const end = source.indexOf('\n      - name:', start + 1)
  const block = source.slice(start, end + 1)
  const unconditional = block.replace("        if: steps.engine-cache.outputs.cache-hit == 'true'\n", '')
  for (const bad of [source.replace(block, ''),
    source.replace(block, unconditional)]) {
    assert.throws(() => checkCachedProjectComponentInputs(bad, base), assert.AssertionError)
  }
})
test('negative controls reject missing overlay self-test, negative control, installer, or receipt upload', () => {
  const source = read('build-apk-source.yml')
  const installPattern = /          node scripts\/source-build\/restore-effective-engine-overlay\.mjs \\\n[\s\S]*?            \.deploy-tmp\/source-build\/effective-engine-overlay-restoration\.json\n/
  for (const bad of [
    source.replace('          node scripts/source-build/restore-effective-engine-overlay.mjs --self-test\n', ''),
    source.replace('          node scripts/source-build/restore-effective-engine-overlay.mjs --self-test-negative\n', ''),
    source.replace(installPattern, ''),
    source.replace(/^            \.deploy-tmp\/source-build\/effective-engine-overlay-restoration\.json\n/gm, ''),
  ]) assert.throws(() => checkCachedEffectiveOverlay(bad), assert.AssertionError)
})

function checkCachedHarnessProvenance(source) {
  const start = source.indexOf("          const harness = JSON.parse(fs.readFileSync('.deploy-tmp/source-build/harness-vendor-lock-reconciliation.json'")
  const end = source.indexOf('          NODE', start)
  assert.ok(start > 0 && end > start, 'source workflow must read the immutable Harness source receipt')
  const block = source.slice(start, end)
  assert.match(block, /scripts\/contract\.json/)
  assert.match(block, /harness\.harnessSourceCommit !== expectedHarnessCommit/)
  assert.match(block, /deepseekHarnessCommit: harness\.harnessSourceCommit/)
  assert.doesNotMatch(block, /git.*rev-parse/)
}
test('cached Harness provenance uses the pinned receipt instead of the parent repository Git HEAD', () => {
  checkCachedHarnessProvenance(read('build-apk-source.yml'))
})
test('negative control: parent repository Git HEAD cannot replace the pinned Harness receipt', () => {
  const source = read('build-apk-source.yml')
  assert.throws(() => checkCachedHarnessProvenance(source.replace(
    "          const harness = JSON.parse(fs.readFileSync('.deploy-tmp/source-build/harness-vendor-lock-reconciliation.json', 'utf8'))",
    "          const harness = { harnessSourceCommit: require('child_process').execFileSync('git', ['-C', '.deploy-tmp/deepseek-harness', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }",
  )), assert.AssertionError)
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

const reclaimInvocation = 'node scripts/source-build/reclaim-build-disk.mjs --root "$GITHUB_WORKSPACE"'
function assertReclaimPlacement(source) {
  const selfTest = source.indexOf('node scripts/source-build/reclaim-build-disk.mjs --self-test')
  const snapshotStep = source.indexOf('      - name: Build runtime snapshot from verified inputs')
  const reclaim = source.indexOf(reclaimInvocation)
  const checker = source.indexOf('node scripts/source-build/check-dsh-source-snapshot.mjs "$snapshot_archive"')
  const kotlinStep = source.indexOf('      - name: 单元测试门禁前置')
  assert.ok(selfTest > 0)
  assert.ok(snapshotStep > 0)
  assert.ok(reclaim > snapshotStep)
  assert.ok(checker > reclaim)
  assert.ok(kotlinStep > checker)
  assert.match(source.slice(snapshotStep, checker), /reclaim-build-disk\.mjs --root "\$GITHUB_WORKSPACE"/)
}
test('source workflow reclaims source-only trees before the APK gate and keeps the self-test', () => {
  const source = read('build-apk-source.yml')
  assertReclaimPlacement(source)
})
test('negative control: missing disk reclamation is rejected', () => {
  const source = read('build-apk-source.yml')
  assert.throws(() => assertReclaimPlacement(source.replace(reclaimInvocation, '')), assert.AssertionError)
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
