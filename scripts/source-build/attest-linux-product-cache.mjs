#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINUX_ABIS, linuxAbi } from './linux-abi.mjs'
const ROOT = resolve(import.meta.dirname, '../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function digestFile(path) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, 'r')
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)) }
  finally { closeSync(fd) }
  return hash.digest('hex')
}
export function cachedAssetNames(inputs, mapping) {
  return [mapping.rootfsAsset, `node-glibc-v${inputs.node}-${mapping.nodePlatform}.tar.xz`].sort()
}
export function attest(directory, commit, abi = process.env.DSH_ABI || 'arm64') {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid source commit')
  const mapping = linuxAbi(abi)
  const proof = join(directory, 'provenance'), assets = join(directory, 'assets')
  for (const name of ['linux-inputs.json', 'linux-source-manifest.json']) {
    if (sha(readFileSync(join(proof, name))) !== sha(readFileSync(join(ROOT, 'scripts/source-build', name)))) throw new Error('cached inputs differ: ' + name)
  }
  const inputs = JSON.parse(readFileSync(join(ROOT, 'scripts/source-build/linux-inputs.json')))
  const manifest = JSON.parse(readFileSync(join(assets, 'linux-assets.json')))
  const expected = cachedAssetNames(inputs, mapping)
  assert.equal(manifest.runtime, mapping.runtime)
  assert.deepEqual(Object.keys(manifest.assets || {}).sort(), expected)
  for (const name of expected) assert.equal(digestFile(join(assets, name)), manifest.assets[name].sha256, 'cached Linux payload changed: ' + name)
  const previous = readFileSync(join(proof, 'project-source-commit.txt'), 'utf8').trim()
  writeFileSync(join(proof, 'reuse-attestation.json'), JSON.stringify({ projectCommit: commit, reusedFromCommit: previous, assets: manifest.assets }, null, 2) + '\n')
  writeFileSync(join(proof, 'project-source-commit.txt'), commit + '\n')
}
function selfTestAbi(abi) {
  const mapping = linuxAbi(abi)
  const directory = mkdtempSync(join(tmpdir(), `linux-product-cache-${abi}-`))
  try {
    const proof = join(directory, 'provenance'), assets = join(directory, 'assets')
    mkdirSync(proof); mkdirSync(assets)
    for (const name of ['linux-inputs.json', 'linux-source-manifest.json']) writeFileSync(join(proof, name), readFileSync(join(ROOT, 'scripts/source-build', name)))
    const inputs = JSON.parse(readFileSync(join(proof, 'linux-inputs.json')))
    const manifest = { runtime: mapping.runtime, assets: {} }
    const names = cachedAssetNames(inputs, mapping)
    for (const name of names) { writeFileSync(join(assets, name), name); manifest.assets[name] = { sha256: sha(name), size: name.length } }
    writeFileSync(join(assets, 'linux-assets.json'), JSON.stringify(manifest))
    writeFileSync(join(proof, 'project-source-commit.txt'), 'a'.repeat(40))
    attest(directory, 'b'.repeat(40), abi)
    assert.equal(readFileSync(join(proof, 'project-source-commit.txt'), 'utf8').trim(), 'b'.repeat(40))
    writeFileSync(join(assets, names[0]), 'changed')
    assert.throws(() => attest(directory, 'b'.repeat(40), abi), /payload changed/)
    writeFileSync(join(assets, names[0]), names[0])
    writeFileSync(join(proof, 'linux-inputs.json'), '{}')
    assert.throws(() => attest(directory, 'c'.repeat(40), abi), /inputs differ/)
    // A manifest carrying the other ABI's runtime or asset set must be rejected.
    writeFileSync(join(proof, 'linux-inputs.json'), readFileSync(join(ROOT, 'scripts/source-build/linux-inputs.json')))
    const foreign = LINUX_ABIS.find(value => value !== abi)
    writeFileSync(join(assets, 'linux-assets.json'), JSON.stringify({ runtime: linuxAbi(foreign).runtime, assets: manifest.assets }))
    assert.throws(() => attest(directory, 'c'.repeat(40), abi), /Expected values to be strictly equal/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
function selfTest() {
  for (const abi of LINUX_ABIS) selfTestAbi(abi)
  console.log('Linux product cache identity verified for arm64 and x86_64')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let abi
  const abiFlag = args.indexOf('--abi')
  if (abiFlag !== -1) {
    abi = args[abiFlag + 1]
    if (!abi) throw new Error('--abi requires a value')
    args.splice(abiFlag, 2)
  }
  if (args.includes('--self-test')) selfTest()
  else attest(resolve(args[0]), args[1], abi ?? process.env.DSH_ABI ?? 'arm64')
  console.log('Linux product cache identity verified')
}
