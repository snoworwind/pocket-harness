#!/usr/bin/env node
/**
 * Content-addressed base-lock contract. This is the trust root for reusable base
 * components: the lock (reviewed in git) pins each component key and manifest hash;
 * a cache/artifact alone is never trusted.
 *
 * This file is intentionally workflow-agnostic. Stage 2 wires it into build-base.yml.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const SCHEMA = 1
const SKIP_DIRS = new Set(['.git', 'node_modules', '.deploy-tmp'])

/** Inputs that define each reusable component. Paths may be files or directories. */
export const COMPONENTS = Object.freeze({
  engine: [
    'scripts/contract.json',
    'scripts/snapshot-config/engine-overlay.json',
    'scripts/snapshot-config/engine-overlay-licenses.json',
    'scripts/patches',
    'scripts/source-build/build-engine.sh',
    'scripts/source-build/engine-base.mjs',
    'scripts/source-build/base-archive.py',
    'scripts/source-build/engine-toolchain.json',
    'scripts/source-build/export-dsh-engine.mjs',
    'scripts/source-build/inject-dsh-engine-packages.mjs',
    'scripts/source-build/prepare-harness-vendor-overrides.py',
    'scripts/source-build/reconcile-harness-vendor-lock.mjs',
    'scripts/source-build/prune-harness-preview.py',
    'scripts/source-build/materialize-dsh-pnpm-packages.mjs',
    'scripts/source-build/prepare-pnpm-deploy-policy.py',
    'scripts/source-build/prepare-pnpm-deploy-runtime-closure.mjs',
    'scripts/source-build/normalize-snapshot.mjs',
    'scripts/source-build/check-dsh-runtime-dependencies.mjs',
    'scripts/source-build/prepare-marketplace-metadata.mjs',
    'vendor/dshmarketplace-plugin/package.json',
  ],
  termux: [
    'scripts/contract.json',
    'scripts/snapshot-config/preinstall.json',
    'scripts/source-build/prepare-termux-bootstrap.py',
    'scripts/source-build/prepare-termux-signed-repo.py',
    'scripts/source-build/build-node-pty-android.mjs',
  ],
  linux: [
    'scripts/source-build/linux-inputs.json',
    'scripts/source-build/linux-source-manifest.json',
    'scripts/source-build/build-linux-assets.sh',
    'scripts/source-build/package-linux-assets.py',
    'scripts/source-build/collect-linux-licenses.py',
    'scripts/source-build/prepare-linux-snapshot-bundle.mjs',
    'scripts/source-build/check-linux-sources.mjs',
    'scripts/source-build/check-linux-native-libraries.mjs',
    'scripts/source-build/verify-linux-native-apk.py',
    'vendor/bionilux',
    'vendor/dsh-linux-runtime',
  ],
})

function fail(message) { throw new Error('base-lock: ' + message) }

/** Stable JSON for hashing/meta (object keys sorted). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function collect(root, relPath, out) {
  const full = resolve(root, relPath)
  if (!existsSync(full)) fail('missing input: ' + relPath)
  const info = lstatSync(full)
  if (info.isSymbolicLink()) {
    out.push([relPath.replaceAll(sep, '/'), 'link', readlinkSync(full)])
    return
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(root, join(relPath, entry.name), out)
    }
    return
  }
  if (!info.isFile()) fail('unsupported input type: ' + relPath)
  out.push([relPath.replaceAll(sep, '/'), 'file', hashFile(full)])
}

/** Hash a component's input paths; paths are sorted and include names. */
export function hashInputs(root, paths) {
  const entries = []
  for (const relPath of paths) collect(root, relPath, entries)
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  const hash = createHash('sha256')
  for (const [relPath, kind, value] of entries) hash.update(relPath + '\0' + kind + '\0' + value + '\0')
  return { sha256: hash.digest('hex'), entries }
}

/** Compute all component keys. Toolchain must be supplied by CI for stable keys. */
export function computeComponentKeys(root, toolchain = {}, components = Object.keys(COMPONENTS)) {
  const meta = canonicalJson({ schema: SCHEMA, toolchain })
  const keys = {}
  for (const component of components) {
    if (!Object.hasOwn(COMPONENTS, component)) fail('unknown component: ' + component)
    const paths = COMPONENTS[component]
    const inputs = hashInputs(root, paths)
    keys[component] = hashComponents([component, meta, inputs.sha256])
  }
  return keys
}

function hashComponents(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part) + '\0')
  return hash.digest('hex')
}

export function keyName(component, hex) {
  return `${component}-v${SCHEMA}-${hex}`
}

/** Validate lock shape and recompute keys; any drift fails closed. */
export function verifyLock(root, lock, toolchain = {}) {
  if (!lock || lock.schema !== SCHEMA) fail('unsupported lock schema')
  if (!lock.components || typeof lock.components !== 'object' || Array.isArray(lock.components) || !Object.keys(lock.components).length) fail('lock.components missing')
  const components = Object.keys(lock.components)
  const keys = Object.fromEntries(components.map(component => [component,
    computeComponentKeys(root, lock.components[component]?.toolchain ?? toolchain, [component])[component]]))
  for (const component of components) {
    const entry = lock.components[component]
    if (!entry) fail('lock missing component: ' + component)
    if (entry.key !== keyName(component, keys[component])) fail(component + ' key drifted; update base-lock.json')
    if (!/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? '')) fail(component + ' manifestSha256 invalid')
  }
  return keys
}

function safeOutputPath(root, relPath) {
  if (typeof relPath !== 'string' || !relPath || /[\\:]/.test(relPath) || relPath.startsWith('/') || relPath.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('unsafe manifest output path: ' + String(relPath))
  }
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) fail('manifest output escaped artifact dir: ' + relPath)
  return target
}

/** Verify lock.manifestSha256, manifest identity, and every declared output. */
export function verifyManifest(root, lock, component, manifestPath, artifactDir) {
  const entry = lock?.components?.[component]
  if (!entry) fail('lock missing component: ' + component)
  const manifestBytes = readFileSync(manifestPath)
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  if (manifestSha256 !== entry.manifestSha256) fail(component + ' manifest sha256 mismatch')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.schema !== SCHEMA) fail('unsupported manifest schema')
  if (manifest.component !== component) fail('manifest component mismatch')
  if (manifest.key !== entry.key) fail('manifest key mismatch')
  if (entry.toolchain && canonicalJson(manifest.toolchain) !== canonicalJson(entry.toolchain)) fail('manifest toolchain mismatch')
  if (entry.sourceCommit && manifest.sourceCommit !== entry.sourceCommit) fail('manifest source commit mismatch')
  if (entry.buildRun && manifest.buildRun !== entry.buildRun) fail('manifest build run mismatch')
  if (!Array.isArray(manifest.outputs) || !manifest.outputs.length) fail('manifest outputs missing')
  const artifactRoot = realpathSync(artifactDir)
  const seen = new Set()
  for (const output of manifest.outputs) {
    if (seen.has(output.path)) fail('duplicate manifest output: ' + output.path)
    seen.add(output.path)
    if (!Number.isSafeInteger(output.size) || output.size < 0 || !/^[a-f0-9]{64}$/.test(output.sha256 ?? '')) fail('invalid manifest output metadata')
    const target = safeOutputPath(resolve(artifactDir), output.path)
    if (!existsSync(target)) fail('manifest output missing: ' + output.path)
    const info = lstatSync(target)
    if (!info.isFile()) fail('manifest output is not a file: ' + output.path)
    const physical = realpathSync(target)
    if (!physical.startsWith(artifactRoot + sep)) fail('manifest output escaped artifact dir: ' + output.path)
    if (info.size !== output.size) fail('manifest output size mismatch: ' + output.path)
    if (hashFile(target) !== output.sha256) fail('manifest output sha256 mismatch: ' + output.path)
  }
  return manifest
}

export function readLock(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseArgs(argv) {
  const args = { root: '.', toolchain: '{}', print: false, check: null, verify: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') args.root = argv[++i]
    else if (arg === '--toolchain') args.toolchain = argv[++i]
    else if (arg === '--print') args.print = true
    else if (arg === '--check') args.check = argv[++i]
    else if (arg === '--verify') {
      const [lock, component, manifest, artifact] = argv.slice(i + 1, i + 5)
      args.verify = { lock, component, manifest, artifact }
      i += 4
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: base-lock.mjs [--root .] [--toolchain JSON] [--print | --check lock.json | --verify lock.json component manifest.json artifact-dir]')
      process.exit(0)
    } else throw new Error('unknown argument: ' + arg)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const toolchain = JSON.parse(args.toolchain)
  if (args.print) {
    const keys = computeComponentKeys(args.root, toolchain)
    console.log(JSON.stringify({ schema: SCHEMA, components: Object.fromEntries(Object.entries(keys).map(([component, hex]) => [component, { key: keyName(component, hex) }])) }, null, 2))
    return
  }
  if (args.check) {
    const lock = readLock(args.check)
    const keys = verifyLock(args.root, lock, toolchain)
    console.log('base-lock: ok ' + JSON.stringify(keys))
    return
  }
  if (args.verify) {
    const lock = readLock(args.verify.lock)
    verifyLock(args.root, lock, toolchain)
    const manifest = verifyManifest(args.root, lock, args.verify.component, args.verify.manifest, args.verify.artifact)
    console.log('base-lock: manifest ok (' + manifest.key + ')')
    return
  }
  throw new Error('one of --print/--check/--verify is required')
}

if (process.argv[1] && process.argv[1].endsWith('base-lock.mjs')) main()
