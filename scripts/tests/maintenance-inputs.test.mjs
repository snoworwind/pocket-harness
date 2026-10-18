import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maintenanceInputsChanged } from '../maintenance-inputs.mjs'

test('missing push base scans tracked inputs; a valid unchanged base and unrelated edits do not trigger', () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-inputs-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    mkdirSync(join(root, 'app'))
    writeFileSync(join(root, 'app/build.gradle.kts'), '// initial\n')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    const base = git('rev-parse', 'HEAD')
    assert.equal(maintenanceInputsChanged(root, 'a'.repeat(40)), true, 'removed root must still check maintenance inputs')
    assert.equal(maintenanceInputsChanged(root, '0'.repeat(40)), true)
    assert.equal(maintenanceInputsChanged(root, ''), true)
    assert.equal(maintenanceInputsChanged(root, base), false)
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n')
    git('add', '.')
    git('commit', '-qm', 'unrelated')
    assert.equal(maintenanceInputsChanged(root, base), false)
    writeFileSync(join(root, 'app/build.gradle.kts'), '// changed\n')
    git('add', '.')
    git('commit', '-qm', 'maintenance input')
    assert.equal(maintenanceInputsChanged(root, base), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
