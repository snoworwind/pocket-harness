import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parseWorkflowSteps } from './run-local-source-chain.mjs'

const source = readFileSync(new URL('../../.github/workflows/build-apk-source.yml', import.meta.url), 'utf8')
const pr = readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8')

function check(workflow) {
  const step = parseWorkflowSteps(workflow).find(item => item.name === 'Snapshot semantic normalization digest')
  assert.ok(step, 'final APK normalization step missing')
  const extraction = step.run.indexOf('tar -xJf "$work/snapshot.tar.xz" -C "$work/tree"')
  const scan = step.run.indexOf('python3 scripts/source-build/inventory-native-runtime.py "$work/tree"')
  assert.ok(extraction >= 0 && scan > extraction, 'scan must use the actual APK snapshot after extraction')
  assert.match(step.run.slice(scan), /native-runtime-inventory\.json --abi "\$DSH_ABI" --apk "\$apk"/)
  assert.ok(step.run.indexOf('rm -rf "$work"', scan) > scan, 'scan must finish before cleanup')
  assert.equal(workflow.split('\n').filter(line => line.trim() === '.deploy-tmp/source-build/native-runtime-inventory.json').length, 3,
    'report must survive builder, verifier and signer artifact boundaries')
}

test('inventory runs against the final injected APK even when injection was cached', () => {
  check(source)
  assert.match(pr, /python3 scripts\/source-build\/inventory-native-runtime\.py --self-test/)
})

test('negative controls catch scan removal, wrong tree and lost artifact propagation', () => {
  for (const bad of [
    source.replace('python3 scripts/source-build/inventory-native-runtime.py "$work/tree"', 'true "$work/tree"'),
    source.replace('inventory-native-runtime.py "$work/tree"', 'inventory-native-runtime.py "$snapshot_stage"'),
    source.replace('            .deploy-tmp/source-build/native-runtime-inventory.json\n', ''),
  ]) assert.throws(() => check(bad), assert.AssertionError)
})

// Execute only evidence generation against a synthetic ZIP; no APK or snapshot build.
test('Linux evidence records the shipped manifest and rejects a missing manifest', () => {
  const step = parseWorkflowSteps(source).find(item => item.name === 'Snapshot semantic normalization digest')
  const script = step.run.match(/<<'PY'\n([\s\S]*?)\nPY/)[1]
  const work = mkdtempSync(join(tmpdir(), 'linux-evidence-'))
  try {
    const manifest = { rootfsTreeSha256: 'tree', homeSchemaVersion: 1, baseId: 'base', guestArchitecture: 'arm64', minimumGlibc: '2.36' }
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest))
    const zip = spawnSync('python3', ['-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('assets/linux/manifest.json', '{}'); z.writestr('lib/arm64-v8a/libproot.so', b'fixture'); z.close()", join(work, 'fixture.apk')], { encoding: 'utf8' })
    assert.equal(zip.status, 0, zip.stderr)
    const args = [join(work, 'manifest.json'), join(work, 'fixture.apk'), join(work, 'normalization.json'), join(work, 'inventory.json')]
    const result = spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const normalization = JSON.parse(readFileSync(args[2], 'utf8'))
    assert.equal(normalization.mode, 'linux-guest')
    assert.equal(normalization.bundledTermuxSnapshot, false)
    assert.equal(normalization.assets.rootfsTreeSha256, 'tree')
    assert.match(normalization.manifestSha256, /^[a-f0-9]{64}$/)
    const inventory = JSON.parse(readFileSync(args[3], 'utf8'))
    assert.deepEqual(inventory.manifest, manifest)
    assert.deepEqual(inventory.nativeLibraries, ['lib/arm64-v8a/libproot.so'])
    assert.deepEqual(inventory.assets, ['assets/linux/manifest.json'])
    rmSync(args[0])
    assert.notEqual(spawnSync('python3', ['-c', script, ...args]).status, 0)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
