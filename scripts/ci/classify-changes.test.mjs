import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { classifyPath, classifyPaths } from './classify-changes.mjs'

const FLAGS = ['engine', 'termux', 'linux', 'plugins', 'app', 'build', 'gates', 'apk', 'docs_only', 'full']

function expect(result, expected) {
  for (const flag of FLAGS) {
    assert.equal(result[flag], expected[flag] ?? false, `${flag}: ${JSON.stringify(result)}`)
  }
}

test('docs-only changes skip every build component', () => {
  const result = classifyPaths(['docs/AGENTS/known-gaps.md', 'README.md'])
  expect(result, { docs_only: true })
})

test('plugin changes require plugins and APK, not engine', () => {
  expect(classifyPaths(['plugins/dsh-android-bridge/src/index.ts']), { plugins: true, apk: true })
})

test('engine patch changes require engine and APK', () => {
  expect(classifyPaths(['scripts/patches/apply-patches.mjs']), { engine: true, apk: true })
})

test('engine overlay and preinstall fan out to their downstream components', () => {
  expect(classifyPaths(['scripts/snapshot-config/engine-overlay.json']), { engine: true, app: true, apk: true })
  expect(classifyPaths(['scripts/snapshot-config/preinstall.json']), { termux: true, app: true, apk: true })
})

test('linux inputs stay linux + APK, not a generic full build', () => {
  expect(classifyPaths(['scripts/source-build/linux-inputs.json']), { linux: true, apk: true })
})

test('app changes require app and APK only', () => {
  expect(classifyPaths(['app/src/main/java/com/snoworwind/pocketharness/MainActivity.kt']), { app: true, apk: true })
})

test('gate scripts run gates but do not force an APK', () => {
  expect(classifyPaths(['scripts/check-release-gates.mjs']), { gates: true })
})

test('workflow and generic source-build changes fail safe to full', () => {
  expect(classifyPaths(['.github/workflows/build-apk-source.yml']), { full: true, engine: true, termux: true, linux: true, plugins: true, app: true, build: true, gates: true, apk: true })
  expect(classifyPaths(['scripts/source-build/run-local-source-chain.mjs']), { full: true, engine: true, termux: true, linux: true, plugins: true, app: true, build: true, gates: true, apk: true })
})

test('unknown paths and empty diffs fail safe to full', () => {
  const all = { full: true, engine: true, termux: true, linux: true, plugins: true, app: true, build: true, gates: true, apk: true }
  expect(classifyPaths(['mystery/file.bin']), all)
  expect(classifyPaths([]), all)
})

test('mixed docs and code does not collapse to docs-only', () => {
  const result = classifyPaths(['docs/design.md', 'app/src/main/AndroidManifest.xml'])
  assert.equal(result.docs_only, false)
  assert.equal(result.app, true)
  assert.equal(result.apk, true)
})

test('CLI emits JSON and GITHUB_OUTPUT flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'classify-changes-'))
  try {
    const output = join(dir, 'github-output')
    const run = spawnSync(process.execPath, [
      fileURLToPath(new URL('./classify-changes.mjs', import.meta.url)),
      '--files', 'app/src/main/AndroidManifest.xml', '--github-output',
    ], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /"apk": true/)
    const written = readFileSync(output, 'utf8')
    assert.match(written, /^apk=true$/m)
    assert.match(written, /^full=false$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('path normalization and single-path classifier are stable', () => {
  assert.deepEqual(classifyPath('.\\plugins\\dsh-android-bridge\\src\\index.ts'), { plugins: true })
  assert.equal(classifyPath('unknown.bin'), null)
})
