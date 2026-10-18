import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyLinuxSources } from './check-linux-sources.mjs'

test('reviewed source import rejects equal-size poison and unregistered compiler input', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-source-pins-'))
  const files = { 'vendor/bionilux/main.rs': 'trusted', 'vendor/dsh-linux-runtime/index.js': 'trusted' }
  const manifest = { files: {} }
  try {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), body)
      manifest.files[file] = createHash('sha256').update(body).digest('hex')
    }
    assert.equal(verifyLinuxSources(root, manifest), 2)
    writeFileSync(join(root, 'vendor/bionilux/main.rs'), 'poison!')
    assert.throws(() => verifyLinuxSources(root, manifest), /digest mismatch/)
    writeFileSync(join(root, 'vendor/bionilux/main.rs'), 'trusted')
    writeFileSync(join(root, 'vendor/bionilux/extra.rs'), 'unreviewed input')
    assert.throws(() => verifyLinuxSources(root, manifest), /file set differs/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
