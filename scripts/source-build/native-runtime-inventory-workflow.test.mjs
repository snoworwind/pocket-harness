import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
