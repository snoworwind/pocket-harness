import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../gen-model-catalog.mjs', import.meta.url))
function generate(catalog) {
  const root = mkdtempSync(join(tmpdir(), 'model-identity-'))
  try {
    const pi = join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai')
    mkdirSync(join(pi, 'dist/providers/data'), { recursive: true })
    writeFileSync(join(pi, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    writeFileSync(join(pi, 'dist/providers/data/provider.json'), JSON.stringify(catalog))
    const out = join(root, 'catalog.json')
    const result = spawnSync(process.execPath, [script, '--engine-root', root, '--out', out], { encoding: 'utf8' })
    return { ...result, catalog: result.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('typed catalog indexes preserve the declared wire ID and capabilities', () => {
  const entry = { id: 'vendor/model', api: 'openai-completions', reasoning: true, thinkingLevelMap: { high: 'high' } }
  const result = generate({ 'openai-completions': { 'chat:vendor/model': entry } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.catalog.models['chat:vendor/model'], undefined)
  assert.equal(result.catalog.models['vendor/model'][0].thinkingLevelMap.high, 'high')
})

test('legacy untyped catalogs retain their exact IDs without prefix guessing', () => {
  const result = generate({ 'openai-completions': { 'vendor:model': { reasoning: true } } })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.catalog.models['vendor:model'])
})

test('missing or malformed declared IDs cannot silently publish typed lookup keys', () => {
  for (const entry of [{}, { id: '' }, { id: ' ' }, { id: null }, { id: 7 }]) {
    const result = generate({ 'openai-completions': { 'chat:vendor/model': entry } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid model identity/)
  }
})
