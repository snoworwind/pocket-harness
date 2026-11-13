#!/usr/bin/env node
// Fetch the published tarballs that engine patch anchors resolve against.
// First-party packages are exported from the pinned source build, so only the
// non-@deepseek-ai owners of engine patch targets are downloaded here. Each
// version comes from the reviewed overlay manifest; the bytes are verified
// against the registry-published sha512 before they enter the cache.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const NM_PREFIX = 'usr/lib/node_modules/@deepseek-ai/dsh/'
const tgzName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`

export function ownerMap(overlay) {
  const owners = new Map()
  owners.set('', { name: overlay.rootPackage.name, version: overlay.rootPackage.version })
  for (const group of ['packages', 'vendorTop', 'pins']) {
    for (const [name, version] of Object.entries(overlay[group] ?? {})) owners.set(`node_modules/${name}`, { name, version })
  }
  for (const [host, children] of Object.entries(overlay.nested ?? {})) {
    for (const [name, version] of Object.entries(children)) owners.set(`node_modules/${host}/node_modules/${name}`, { name, version })
  }
  return owners
}

function ownerOf(owners, rel) {
  const parts = rel.split('/')
  for (let index = parts.length - 2; index >= 0; index--) {
    const dir = parts.slice(0, index + 1).join('/')
    const owner = owners.get(dir)
    if (owner) return owner
  }
  return rel.startsWith('node_modules/') ? null : owners.get('')
}

/** Published packages that own at least one engine patch or retired target. */
export function collectPublishedTarballs(overlay, registry) {
  const owners = ownerMap(overlay)
  const needed = new Map()
  for (const patch of [...registry.patches, ...(registry.retired ?? [])]) {
    if ((patch.scope ?? 'vendor') !== 'engine') continue
    for (const target of [patch.target, ...(patch.additionalTargets ?? [])]) {
      assert.ok(target.startsWith(NM_PREFIX), `engine patch target escapes the engine tree: ${target}`)
      const owner = ownerOf(owners, target.slice(NM_PREFIX.length))
      assert.ok(owner, `engine patch target has no package owner: ${target}`)
      if (owner.name.startsWith('@deepseek-ai/')) continue
      needed.set(`${owner.name}@${owner.version}`, { name: owner.name, version: owner.version })
    }
  }
  return [...needed.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

async function metadata(mirrors, name) {
  for (const mirror of mirrors) {
    try {
      const response = await fetch(`${mirror}/${name}`, { signal: AbortSignal.timeout(30000) })
      if (response.ok) return response.json()
    } catch { /* next mirror */ }
  }
  return null
}

async function download(url, destination) {
  const result = spawnSync('bash', [join(ROOT, 'scripts/source-build/retry-curl.sh'), '--fail', '--location', '--retry', '8', '--retry-max-time', '600', url, '-o', destination], { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`overlay tarball download failed (${result.status}): ${url}`)
}

export async function fetchOverlayTarballs(overlayPath, cache, mirrors) {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  const registry = JSON.parse(readFileSync(join(ROOT, 'scripts/patches/registry.json'), 'utf8'))
  const needed = collectPublishedTarballs(overlay, registry)
  mkdirSync(cache, { recursive: true })
  const fetched = []
  for (const { name, version } of needed) {
    const destination = join(cache, tgzName(name, version))
    if (existsSync(destination)) continue
    const dist = (await metadata(mirrors, name))?.versions?.[version]?.dist
    assert.ok(dist?.tarball, `overlay metadata unavailable: ${name}@${version}`)
    const temporary = `${destination}.partial`
    rmSync(temporary, { force: true })
    await download(dist.tarball, temporary)
    const bytes = readFileSync(temporary)
    const sha512 = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const expected = dist.integrity ?? (dist.sha512 ? `sha512-${dist.sha512}` : null)
    assert.ok(expected, `overlay metadata has no integrity: ${name}@${version}`)
    assert.equal(sha512, expected, `overlay sha512 mismatch: ${name}@${version}`)
    renameSync(temporary, destination)
    fetched.push(`${name}@${version}`)
  }
  return { cache, needed: needed.map(({ name, version }) => `${name}@${version}`), fetched }
}

if (process.argv[1]) {
  if (realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
    if (process.argv.includes('--self-test')) {
      execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./fetch-overlay-tarballs.test.mjs', import.meta.url))], { stdio: 'inherit' })
    } else {
      const overlayPath = resolve(process.argv[2] ?? '.deploy-tmp/source-build/engine-overlay.original.json')
      const cache = resolve(process.argv[3] ?? '.deploy-tmp/engine-overlay')
      const mirrors = JSON.parse(readFileSync(join(ROOT, 'scripts/runtime-config/preinstall.json'), 'utf8')).npmMirrors
      const result = await fetchOverlayTarballs(overlayPath, cache, mirrors)
      console.log(`Engine patch tarballs ready: ${result.fetched.length} fetched, ${result.needed.length} required`)
    }
  }
}
