import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetLocalTermuxStage } from './reset-local-termux-stage.mjs'

test('local Termux stage reset removes only fixed generated roots and is repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'termux-stage-reset-'))
  const stage = join(root, '.deploy-tmp/source-build')
  const keep = join(stage, 'unrelated-report.json')
  mkdirSync(join(stage, 'termux-package-input-source/termux-webroot/pool'), { recursive: true })
  mkdirSync(join(stage, 'termux-package-artifact'), { recursive: true })
  mkdirSync(join(stage, 'termux-webroot/pool'), { recursive: true })
  writeFileSync(join(stage, 'termux-packages-provenance.json'), '{}')
  writeFileSync(join(stage, 'termux-package-input-source/termux-webroot/pool/input.deb'), 'stale')
  writeFileSync(join(stage, 'termux-package-artifact/termux-package-inputs.tar'), 'stale')
  writeFileSync(join(stage, 'termux-webroot/pool/old.deb'), 'stale')
  writeFileSync(keep, 'preserve')
  try {
    resetLocalTermuxStage(root)
    resetLocalTermuxStage(root)
    assert.equal(readFileSync(keep, 'utf8'), 'preserve')
    assert.throws(() => lstatSync(join(stage, 'termux-package-input-source')), { code: 'ENOENT' })
    assert.throws(() => lstatSync(join(stage, 'termux-package-artifact')), { code: 'ENOENT' })
    assert.throws(() => lstatSync(join(stage, 'termux-webroot')), { code: 'ENOENT' })
    assert.throws(() => lstatSync(join(stage, 'termux-packages-provenance.json')), { code: 'ENOENT' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('local Termux stage reset rejects linked targets and leaves external data untouched', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'termux-stage-link-'))
  const stage = join(root, '.deploy-tmp/source-build')
  const outside = join(root, 'outside')
  mkdirSync(stage, { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'untouched')
  symlinkSync(outside, join(stage, 'termux-webroot'), 'dir')
  try {
    assert.throws(() => resetLocalTermuxStage(root), /unexpected type/)
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'untouched')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
