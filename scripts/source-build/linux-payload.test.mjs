import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { checkLinuxCi } from './check-linux-ci.mjs'
import { parseWorkflowSteps } from './run-local-source-chain.mjs'
const ROOT = resolve(import.meta.dirname, '../..')
const read = path => readFileSync(join(ROOT, path), 'utf8')
test('source entry only dispatches explicit ARM64 Linux artifacts and rejects releases', () => {
  checkLinuxCi(read('.github/workflows/build-apk-source.yml'))
  const wrapper = read('.github/workflows/build-apk.yml')
  assert.match(wrapper, /abi: arm64/)
  assert.match(wrapper, /linux_experiment: \$\{\{ inputs.linux_experiment \}\}/)
  assert.doesNotMatch(wrapper, /secrets:|draft_release|contents: write/)
  const release = read('.github/workflows/release-source-draft.yml')
  assert.match(release, /exit 1/)
  assert.doesNotMatch(release, /contents: write|gh release|secrets:|build-apk-source/)
})
test('payload composer has no retired build inputs and checks actual source, plugins and home', () => {
  const build = read('scripts/source-build/build-linux-payload.mjs')
  assert.doesNotMatch(build, /prepare-termux|build-snapshot-013|snapshot\.tar|base-usr|bootstrap-extracted/)
  for (const contract of ['engine-deploy', 'check-linux-engine.mjs', 'check-inject-completeness.mjs', 'check-linux-home.py', 'verifyPinnedNpm', 'linux-instance-manifest.py', 'build-hard-manifest.mjs']) assert.ok(build.includes(contract), contract)
  const apk = read('scripts/source-build/build-linux-apk.mjs')
  assert.ok(build.indexOf('fetch-overlay-tarballs.mjs') < build.indexOf('probe-engine-anchors.mjs'))
  assert.ok(apk.indexOf('check-kotlin-test-count.mjs') < apk.indexOf("run('./gradlew'"))
  assert.ok(apk.indexOf("run('./gradlew'") < apk.indexOf('verify-linux-native-apk.py'))
  assert.match(apk, /verifyApks\(\{ files: \[apk\] \}\)/)
})
test('official bundle templates seed both Linux profiles without source node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-profile-'))
  try {
    const source = join(root, 'source'), home = join(root, 'home')
    mkdirSync(join(source, 'packages/util/official-bundles/src'), { recursive: true })
    writeFileSync(join(source, 'packages/util/official-bundles/src/bundles.ts'), "export const PROFILE_TEMPLATES: Record<string, {bundles: string[]}> = { web: {bundles:['base','web']}, headless: {bundles:['base','headless']} }\n")
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/source-build/seed-linux-home.mjs'), source, home], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.dsh/profiles/web/package.json'))).dsh.profile.bundles, ['base', 'web'])
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.dsh/profiles/headless/package.json'))).dsh.profile.bundles, ['base', 'headless'])
    assert.equal(readFileSync(join(home, '.dsh/AGENTS.md'), 'utf8'), read('scripts/global-AGENTS.md'))
    assert.ok(!existsSync(join(source, 'node_modules')))
    writeFileSync(join(source, 'packages/util/official-bundles/src/bundles.ts'), 'export const PROFILE_TEMPLATES = {}\n')
    const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/source-build/seed-linux-home.mjs'), source, join(root, 'bad-home')])
    assert.notEqual(bad.status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('actual cloud branch guard rejects main, x86 and a missing explicit opt-in', () => {
  const step = parseWorkflowSteps(read('.github/workflows/build-apk-source.yml')).find(item => item.name === 'Require the explicit ARM64 Linux experiment')
  assert.ok(step?.run)
  const good = { DSH_ABI: 'arm64', SOURCE_REF: 'refs/heads/codex/linux-runtime-experiment', LINUX_EXPERIMENT: 'true' }
  const run = env => spawnSync('/bin/bash', ['-e', '-c', step.run], { env: { ...process.env, ...env } }).status
  assert.equal(run(good), 0)
  for (const bad of [{ SOURCE_REF: 'refs/heads/main' }, { SOURCE_REF: 'refs/tags/v1' }, { DSH_ABI: 'x86_64' }, { LINUX_EXPERIMENT: 'false' }, { LINUX_EXPERIMENT: '' }]) assert.notEqual(run({ ...good, ...bad }), 0)
})

test('directory injection gate ignores directory headers and rejects changed source bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-injection-'))
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true })
    for (const name of ['check-inject-completeness.mjs', 'lib/shell.mjs']) cpSync(join(ROOT, 'scripts', name), join(root, 'scripts', name))
    const pkg = join(root, 'plugin')
    mkdirSync(join(pkg, 'lib/nested'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} }))
    writeFileSync(join(pkg, 'lib/index.js'), "export { value } from './nested/value.js'\n")
    writeFileSync(join(pkg, 'lib/nested/value.js'), 'export const value = 1\n')
    writeFileSync(join(root, 'scripts/plugin-dirs.json'), JSON.stringify({ dirs: ['plugin'], externals: [] }))
    const tree = join(root, 'tree')
    for (const profile of ['web', 'headless']) cpSync(pkg, join(tree, 'home/.dsh/profiles', profile, 'node_modules/fixture'), { recursive: true })
    const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-inject-completeness.mjs'), '--tree', tree], { cwd: root, encoding: 'utf8' })
    const good = run()
    assert.equal(good.status, 0, good.stdout + good.stderr)
    writeFileSync(join(tree, 'home/.dsh/profiles/headless/node_modules/fixture/lib/nested/value.js'), 'export const value = 2\n')
    const changed = run()
    assert.notEqual(changed.status, 0)
    assert.match(changed.stdout, /FAIL.*源码字节一致/)
    rmSync(join(tree, 'home/.dsh/profiles/headless/node_modules/fixture/lib/nested/value.js'))
    assert.notEqual(run().status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Linux naming gate rejects old package, class, tool, environment and configuration names', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/source-build/check-linux-names.mjs'), '--self-test'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
