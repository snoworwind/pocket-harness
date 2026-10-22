#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..', '..')
const EXPECTED = new Set([
  'proot-backend-aarch64.tar.xz',
  'debian-minimal-aarch64.tar.xz',
  'linux-bootstrap-plugin.tar.xz',
  'linux-release.json',
  'linux-runtime-manifest.sha256',
  'linux-runtime-plugin.tar.xz',
  'node-glibc-v24.22.0-linux-arm64.tar.xz',
])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (message) => { throw new Error(message) }

async function regularFile(dir, name) {
  const path = join(dir, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) fail(`Linux bundle input must be a regular file: ${name}`)
  return { path, info }
}

async function prepare(assetsDir, provenanceDir, snapshotRoot, projectCommit, writeEvidence = true) {
  const assets = resolve(assetsDir)
  const provenance = resolve(provenanceDir)
  const root = resolve(snapshotRoot)
  if (!root.startsWith(ROOT + sep)) fail('Snapshot root must be inside this source workspace')
  const sourceCommit = (await readFile(join(provenance, 'project-source-commit.txt'), 'utf8')).trim()
  if (!/^[a-f0-9]{40}$/.test(projectCommit) || sourceCommit !== projectCommit) fail('Linux assets were not built from the exact APK source commit')
  const present = new Set(await readdir(assets))
  if (present.size !== EXPECTED.size || [...present].some((name) => !EXPECTED.has(name))) fail('Linux asset directory contains missing or unexpected files')

  const manifestInput = await regularFile(assets, 'linux-release.json')
  const manifestBytes = await readFile(manifestInput.path)
  const manifestDigest = sha256(manifestBytes)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const linuxInputs = JSON.parse(await readFile(join(ROOT, 'scripts/source-build/linux-inputs.json'), 'utf8'))
  if (manifest.version !== linuxInputs.runtimeVersion || manifest.runtimes?.length !== 1 || manifest.runtimes[0]?.architecture !== 'arm64') {
    fail('Offline Linux manifest must contain exactly one ARM64 runtime at the reviewed version')
  }
  const sidecar = (await readFile(join(assets, 'linux-runtime-manifest.sha256'), 'utf8')).trim()
  if (sidecar !== manifestDigest) fail('Linux runtime manifest sidecar digest mismatch')

  const expectedAssets = new Map()
  for (const asset of [
    manifest.plugins?.bootstrap, manifest.plugins?.runtime,
    manifest.runtimes[0]?.backendAsset, manifest.runtimes[0]?.rootfsAsset, manifest.runtimes[0]?.nodeAsset,
  ]) {
    if (!asset || typeof asset.url !== 'string') fail('Linux manifest omits a required plugin/runtime asset')
    const url = new URL(asset.url)
    const name = basename(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port
      || url.pathname !== `/snoworwind/pocket-harness/releases/download/v${manifest.version}/${name}` || url.search || url.hash) {
      fail(`Linux manifest asset URL is outside the fixed repository release namespace: ${name}`)
    }
    if (!EXPECTED.has(name) || name === 'linux-release.json' || name === 'linux-runtime-manifest.sha256' || expectedAssets.has(name)) fail(`Unexpected or duplicate Linux manifest asset: ${name}`)
    expectedAssets.set(name, asset)
  }
  for (const name of EXPECTED) {
    if (name === 'linux-release.json' || name === 'linux-runtime-manifest.sha256') continue
    const asset = expectedAssets.get(name)
    if (!asset) fail(`Linux manifest does not authenticate bundled file: ${name}`)
    const { path, info } = await regularFile(assets, name)
    const bytes = await readFile(path)
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256 || info.size !== asset.size) fail(`Linux asset digest or size mismatch: ${name}`)
  }

  const bundle = join(root, 'usr/share/pocket-harness/linux-assets')
  try { await lstat(bundle); fail('Linux snapshot bundle destination already exists') } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(bundle, { recursive: true })
  for (const name of EXPECTED) await cp(join(assets, name), join(bundle, name), { errorOnExist: true, force: false })
  const report = {
    schemaVersion: 1,
    projectSourceCommit: projectCommit,
    manifestSha256: manifestDigest,
    architecture: 'arm64',
    embeddedAssets: [...EXPECTED].sort(),
    bundleRelativePath: 'usr/share/pocket-harness/linux-assets',
  }
  if (writeEvidence) await writeFile(join(ROOT, '.deploy-tmp/source-build/linux-bundle-injection.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Embedded ${expectedAssets.size} authenticated ARM64 assets plus pinned manifest at ${bundle}`)
  return report
}

async function selfTest(assets, provenance) {
  const scratch = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'linux-bundle-selftest-')))
  try {
    const source = join(scratch, 'source')
    const proof = join(scratch, 'proof')
    await cp(assets, source, { recursive: true })
    await cp(provenance, proof, { recursive: true })
    const root = join(ROOT, '.deploy-tmp', 'source-build', `linux-bundle-selftest-${process.pid}`)
    await rm(root, { recursive: true, force: true })
    const commit = (await readFile(join(proof, 'project-source-commit.txt'), 'utf8')).trim()
    await prepare(source, proof, root, commit, false)
    await rm(root, { recursive: true, force: true })
    await writeFile(join(source, 'debian-minimal-aarch64.tar.xz'), 'tampered')
    let rejected = false
    try { await prepare(source, proof, root, commit) } catch (error) { rejected = /digest or size mismatch/.test(String(error)) }
    if (!rejected) fail('Self-test failed: tampered Linux asset was not rejected')
    await rm(root, { recursive: true, force: true })
    console.log('PASS Linux snapshot bundle self-test: valid bundle accepted; tampered asset rejected')
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') {
  if (args.length !== 3) fail('usage: prepare-linux-snapshot-bundle.mjs --self-test <assets-dir> <provenance-dir>')
  await selfTest(resolve(args[1]), resolve(args[2]))
} else {
  if (args.length !== 3) fail('usage: prepare-linux-snapshot-bundle.mjs <assets-dir> <provenance-dir> <snapshot-root>')
  await prepare(resolve(args[0]), resolve(args[1]), resolve(args[2]), process.env.GITHUB_SHA ?? '')
}
