import test from 'node:test'
import assert from 'node:assert/strict'
import { checkWorkflowActionPins } from './check-workflow-action-pins.mjs'
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('every production workflow pins external action code', () => {
  const directory = new URL('../../.github/workflows/', import.meta.url)
  for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    assert.deepEqual(checkWorkflowActionPins(readFileSync(new URL(name, directory), 'utf8'), name), [])
  }
})

test('negative controls reject mutable, expression and abbreviated references', () => {
  for (const ref of ['actions/checkout@v4', 'actions/checkout@main', 'actions/checkout@11d5960', '${{ inputs.action }}', 'docker://alpine:latest', './../external']) {
    assert.equal(checkWorkflowActionPins(`      - uses: ${ref}`).length, 1, ref)
  }
})

test('accept local reusable workflows and quoted full pins with comments', () => {
  assert.deepEqual(checkWorkflowActionPins(`uses: ./.github/workflows/build-apk-source.yml
 - uses: 'actions/checkout@${'a'.repeat(40)}' # v4
 - uses: docker://alpine@sha256:${'b'.repeat(64)}`), [])
})

test('actual CLI negative control rejects a retargetable action before success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'action-pin-control-'))
  try {
    writeFileSync(join(directory, 'control.yml'), 'steps:\n  - uses: actions/checkout@v4\n')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-workflow-action-pins.mjs', import.meta.url)), directory], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /control.yml:2: action must use a full commit SHA/)
    assert.doesNotMatch(result.stdout, /PASS/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
