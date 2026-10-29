import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-patch-mirror.mjs')

function makeTree({ registryIds = ['patch-a', 'patch-b'], implementationIds = ['patch-a', 'patch-b'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patch-registry-'))
  const patches = join(root, 'scripts/patches')
  mkdirSync(patches, { recursive: true })
  writeFileSync(join(patches, 'registry.json'), JSON.stringify({
    patches: registryIds.map((id) => ({ id })),
  }))
  writeFileSync(join(patches, 'apply-patches.mjs'), [
    'const IMPLS = {',
    ...implementationIds.map((id) => `  '${id}': { apply() {} },`),
    '}',
  ].join('\n'))
  return root
}

function withTree(options, callback) {
  const root = makeTree(options)
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

test('本仓树内 registry 与 IMPLS id 集合相同则通过', () => withTree({}, (root) => {
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /registry id 集合 == IMPLS id 集合/)
  assert.match(result.stdout, /CHECK-PATCH-MIRROR PASSED/)
}))

test('registry 声明了缺失实现的 id 时判红', () => withTree({ implementationIds: ['patch-a'] }, (root) => {
  const result = run(root)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /registry id 集合 == IMPLS id 集合/)
  assert.match(result.stdout, /patch-b/)
}))

test('IMPLS 含未登记 id 时判红', () => withTree({ registryIds: ['patch-a'] }, (root) => {
  const result = run(root)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /registry id 集合 == IMPLS id 集合/)
  assert.match(result.stdout, /patch-b/)
}))

test('跨树镜像参数仍被显式拒绝', () => withTree({}, (root) => {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--require-peer'], { encoding: 'utf8' })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /跨树镜像比对已按用户决定移除/)
}))
