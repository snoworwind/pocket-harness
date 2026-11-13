import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { checkLinuxCi } from './check-linux-ci.mjs'
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
