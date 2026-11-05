import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { replaceAtMostOnce, replaceAtMostOnceRe, replaceOnce, replaceOnceRe } from '../lib/replace-once.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const runner = join(root, 'scripts', 'patches', 'apply-patches.mjs')

test('literal anchors require exactly one hit; upgrade anchors allow zero only', () => {
  assert.equal(replaceOnce('aXb', 'X', 'Y'), 'aYb')
  assert.throws(() => replaceOnce('abc', 'X', 'Y'), /found 0/)
  assert.throws(() => replaceOnce('aXbXc', 'X', 'Y', 'duplicate probe'), /found 2.*duplicate probe/)
  assert.throws(() => replaceOnce('abc', '', 'Y'), /non-empty/)

  assert.equal(replaceAtMostOnce('abc', 'X', 'Y'), 'abc')
  assert.equal(replaceAtMostOnce('aXb', 'X', 'Y'), 'aYb')
  assert.throws(() => replaceAtMostOnce('aXbXc', 'X', 'Y'), /found 2/)
})

test('regexp anchors count matches, preserve captures, and do not mutate caller state', () => {
  const pattern = /value=(\d+)/g
  pattern.lastIndex = 4
  assert.equal(replaceOnceRe('value=12', pattern, 'count=$1'), 'count=12')
  assert.equal(pattern.lastIndex, 4)
  assert.throws(() => replaceOnceRe('value=1 value=2', pattern, 'x'), /found 2/)
  assert.equal(replaceAtMostOnceRe('none', /value=\d+/, 'x'), 'none')
  assert.equal(replaceAtMostOnceRe('value=1', /value=\d+/, 'x'), 'x')
  assert.throws(() => replaceAtMostOnceRe('value=1 value=2', /value=\d+/, 'x'), /found 2/)
  assert.throws(() => replaceOnceRe('abc', /(?:)/, 'x'), /found 4/)
  assert.throws(() => replaceOnceRe('abc', /a/y, 'x'), /sticky/)
})

test('patch runner has no unguarded source replacement call sites', () => {
  const source = readFileSync(runner, 'utf8')
  const offenders = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/\b(?:s|next|conditionLine)\.replace\(/.test(line)) offenders.push(`line ${index + 1}: ${line.trim()}`)
  }
  const literalAnchor = /\.replace\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/g
  let match
  while ((match = literalAnchor.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length
    offenders.push(`line ${line}: ${match[1].slice(0, 40)}`)
  }
  assert.deepEqual(offenders, [], 'patch source replacements must go through exact-count helpers')
})

test('duplicate real ArkWeb patch anchor fails without writing a partial patch', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pocket-harness-anchor-'))
  const relativeTarget = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js'
  const target = join(tempRoot, relativeTarget)
  const anchor = 'if (parsed.protocol !== `dsh-resource:`) return void 0;\n\treturn parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();'
  const source = `${anchor}\n${anchor}`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
    const result = spawnSync(process.execPath, [runner, tempRoot, '--apply', '--scope', 'engine', '--only', 'arkweb-resource-protocol-H1'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /expected exactly one occurrence, found 2/)
    assert.equal(readFileSync(target, 'utf8'), source, 'the runner must leave the duplicate-anchor fixture unchanged')
  } finally {
    // The generated temp directory is the only recursive-delete target in this test.
    const resolved = resolve(tempRoot)
    const rel = relative(resolve(tmpdir()), resolved)
    assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'temp cleanup must remain under the OS temp root')
    rmSync(resolved, { recursive: true, force: true })
  }
})
