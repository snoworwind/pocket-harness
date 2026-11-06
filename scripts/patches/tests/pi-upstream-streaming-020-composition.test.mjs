import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { versionedFixture } from './lib/fixture.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE = versionedFixture('pi-ai')
const APPLY_PATCHES = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
const PATCHES = 'pi-upstream-streaming-020,pi-toolcall-G2'
const PACKAGE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai'
const CONVERT_SIGNATURE = '                        ...(geminiThoughtSignature && { extra_content: { google: { thought_signature: geminiThoughtSignature } } }),'

function runPatches(stage, mode) {
  return spawnSync(process.execPath, [APPLY_PATCHES, stage, mode, '--scope', 'engine', '--only', PATCHES], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

function prepareStage() {
  const scratch = mkdtempSync(join(tmpdir(), 'pocket-pi-ai-patches-'))
  const stage = join(scratch, 'stage')
  cpSync(FIXTURE, join(stage, PACKAGE), { recursive: true })
  return { scratch, stage }
}

test('the pinned streaming patch stays verifiable after the dependent G2 patch', () => {
  const { scratch, stage } = prepareStage()
  try {
    const applied = runPatches(stage, '--apply')
    assert.equal(applied.status, 0, applied.stdout + applied.stderr)

    const checked = runPatches(stage, '--check')
    assert.equal(checked.status, 0, checked.stdout + checked.stderr)
    assert.match(checked.stdout, /apply-patches: ALL OK/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the composed verifier still rejects a missing official Gemini replay change', () => {
  const { scratch, stage } = prepareStage()
  try {
    const applied = runPatches(stage, '--apply')
    assert.equal(applied.status, 0, applied.stdout + applied.stderr)

    const file = join(stage, PACKAGE, 'dist/api/openai-completions.js')
    const source = readFileSync(file, 'utf8')
    assert.equal(source.split(CONVERT_SIGNATURE).length - 1, 1)
    writeFileSync(file, source.replace(CONVERT_SIGNATURE, ''))

    const checked = runPatches(stage, '--check')
    assert.notEqual(checked.status, 0, checked.stdout + checked.stderr)
    assert.match(checked.stderr, /official pi-ai streaming context drift/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
