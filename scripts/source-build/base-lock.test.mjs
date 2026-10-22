import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  COMPONENTS, SCHEMA, computeComponentKeys, hashInputs, keyName, verifyLock, verifyManifest,
} from './base-lock.mjs'

const TOOLCHAIN = { node: 'v24.0.0', pnpm: '11.28.5', python: '3.12' }

function write(root, rel, content = rel + '\n') {
  const target = join(root, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'base-lock-'))
  for (const paths of Object.values(COMPONENTS)) {
    for (const path of paths) {
      if (path.endsWith('.json') || path.endsWith('.mjs') || path.endsWith('.py') || path.endsWith('.sh')) write(root, path)
      else mkdirSync(join(root, path), { recursive: true })
    }
  }
  return root
}

function lockFor(root) {
  const keys = computeComponentKeys(root, TOOLCHAIN)
  return {
    schema: SCHEMA,
    components: Object.fromEntries(Object.entries(keys).map(([component, hex]) => [
      component, { key: keyName(component, hex), manifestSha256: 'a'.repeat(64) },
    ])),
  }
}

test('component keys are deterministic and only change for their own inputs', () => {
  const root = fixture()
  try {
    const first = computeComponentKeys(root, TOOLCHAIN)
    const second = computeComponentKeys(root, TOOLCHAIN)
    assert.deepEqual(first, second)
    write(root, 'scripts/patches/apply-patches.mjs', 'changed\n')
    const changed = computeComponentKeys(root, TOOLCHAIN)
    assert.notEqual(changed.engine, first.engine)
    assert.equal(changed.termux, first.termux)
    assert.equal(changed.linux, first.linux)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hashInputs includes names and rejects missing inputs', () => {
  const root = fixture()
  try {
    const a = hashInputs(root, ['scripts/patches']).sha256
    write(root, 'scripts/patches/another.mjs')
    assert.notEqual(hashInputs(root, ['scripts/patches']).sha256, a)
    assert.throws(() => hashInputs(root, ['scripts/patches/missing.mjs']), /missing input/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyLock accepts the exact lock and rejects key drift', () => {
  const root = fixture()
  try {
    const lock = lockFor(root)
    assert.deepEqual(verifyLock(root, lock, TOOLCHAIN), computeComponentKeys(root, TOOLCHAIN))
    write(root, 'scripts/contract.json', '{"changed":true}\n')
    assert.throws(() => verifyLock(root, lock, TOOLCHAIN), /engine key drifted/)
    assert.throws(() => verifyLock(root, { ...lock, schema: 99 }, TOOLCHAIN), /unsupported lock schema/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('engine-only locks do not require unrelated component inputs', () => {
  const root = fixture()
  try {
    const full = lockFor(root)
    const lock = { schema: SCHEMA, components: { engine: { ...full.components.engine, toolchain: TOOLCHAIN } } }
    rmSync(join(root, 'vendor/linux-proot'), { recursive: true })
    assert.deepEqual(verifyLock(root, lock), { engine: computeComponentKeys(root, TOOLCHAIN, ['engine']).engine })
    assert.throws(() => verifyLock(root, { schema: 1, components: {} }), /components missing/)
    assert.throws(() => verifyLock(root, { schema: 1, components: { unknown: {} } }), /unknown component/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verifyManifest binds lock, manifest, and every output byte', () => {
  const root = fixture()
  try {
    const lock = lockFor(root)
    const artifact = join(root, 'artifact')
    mkdirSync(artifact, { recursive: true })
    const out = Buffer.from('engine-output\n')
    writeFileSync(join(artifact, 'engine.tar.zst'), out)
    const manifest = {
      schema: SCHEMA,
      component: 'engine',
      key: lock.components.engine.key,
      outputs: [{ path: 'engine.tar.zst', sha256: createHash('sha256').update(out).digest('hex'), size: out.length }],
    }
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    lock.components.engine.manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    assert.equal(verifyManifest(root, lock, 'engine', manifestPath, artifact).key, lock.components.engine.key)
    // output tamper
    writeFileSync(join(artifact, 'engine.tar.zst'), 'tampered')
    assert.throws(() => verifyManifest(root, lock, 'engine', manifestPath, artifact), /output size mismatch|output sha256 mismatch/)
    // manifest tamper
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: 'engine-v1-evil' }))
    assert.throws(() => verifyManifest(root, lock, 'engine', manifestPath, artifact), /manifest sha256 mismatch/)
    // traversal
    const unsafe = { ...manifest, outputs: [{ ...manifest.outputs[0], path: '../escape' }] }
    writeFileSync(manifestPath, JSON.stringify(unsafe))
    lock.components.engine.manifestSha256 = createHash('sha256').update(JSON.stringify(unsafe)).digest('hex')
    assert.throws(() => verifyManifest(root, lock, 'engine', manifestPath, artifact), /unsafe manifest output path/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
