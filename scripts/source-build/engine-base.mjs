#!/usr/bin/env node
// Engine base producer. Archives carry no APK, signing key, or project plugin build.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, COMPONENTS, computeComponentKeys, hashInputs, keyName, verifyLock, verifyManifest } from './base-lock.mjs'
import { canonicalPackageJson, canonicalYamlMapping } from './normalize-snapshot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORTS = [
  'engine-overlay.original.json', 'effective-engine-overlay.json', 'source-build-policy.json',
  'harness-vendor-overrides.json', 'harness-vendor-lock-reconciliation.json',
  'harness-pnpm-lock.original.yaml', 'harness-root-package.json.original',
  'harness-build-script-exclusion.json', 'package-manager-versions.txt',
  'pnpm-deploy-build-policy.json', 'pnpm-deploy-runtime-closure.json',
  'pnpm-deploy-runtime-closure.lock.yaml', 'first-party-deploy-injection.json',
  'marketplace-metadata-delta.json', 'harness-web-preview-exclusion.json',
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, canonicalJson(value) + '\n') }
const gitEnvironment = { ...process.env }
for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnvironment[name]
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { env: gitEnvironment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const fail = message => { throw new Error('engine-base: ' + message) }

export function requireMain(root, env = process.env) {
  const commit = git(root, 'rev-parse', 'HEAD')
  if (env.GITHUB_ACTIONS === 'true') {
    if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_SHA !== commit || env.GITHUB_EVENT_NAME === 'pull_request') fail('base publication requires the main workflow commit')
  } else if (git(root, 'symbolic-ref', '--quiet', 'HEAD') !== 'refs/heads/main') fail('local base production requires attached main')
  return commit
}

export function committedInputs(root, toolchain) {
  const scratch = mkdtempSync(join(tmpdir(), 'engine-inputs-'))
  try {
    const archive = execFileSync('git', ['-C', root, 'archive', 'HEAD', '--', ...COMPONENTS.engine], { env: gitEnvironment, maxBuffer: 128 * 1024 * 1024 })
    execFileSync('tar', ['-xf', '-', '-C', scratch], { input: archive })
    const inputs = hashInputs(scratch, COMPONENTS.engine)
    return { key: keyName('engine', computeComponentKeys(scratch, toolchain, ['engine']).engine), inputs }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export function toolchain(root, local = false) {
  const policy = json(join(root, 'scripts/source-build/engine-toolchain.json'))
  const version = (bin, args) => execFileSync(bin, args, { encoding: 'utf8' }).trim()
  // Java writes these properties to stderr; a tiny child keeps that channel separate.
  const javaProperties = JSON.parse(version(process.execPath, ['--input-type=module', '-e',
    'import{spawnSync}from"node:child_process";let r=spawnSync("java",["-XshowSettings:properties","-version"],{encoding:"utf8"});if(r.status!==0)process.exit(1);console.log(JSON.stringify(r.stderr))']))
  const actual = {
    node: process.versions.node,
    python: version('python3', ['-c', 'import platform; print(platform.python_version())']),
    java: /java.runtime.version\s*=\s*(\S+)/.exec(javaProperties)?.[1],
    javaVendor: /java.vendor\s*=\s*(.+)/.exec(javaProperties)?.[1]?.trim(),
    osRelease: readFileSync('/etc/os-release', 'utf8'),
    compiler: version('c++', ['--version']).split('\n')[0],
    zstd: version('zstd', ['--version']),
    corepack: version('corepack', ['--version']), pnpm: policy.pnpm, deploymentPnpm: policy.deploymentPnpm,
    localDevelopment: local,
  }
  if (!actual.java) fail('cannot identify Java runtime')
  if (actual.corepack !== policy.corepack) fail('Corepack does not match fixed policy')
  if (!local && (actual.node !== policy.node || actual.python !== policy.python || actual.java !== policy.java || !actual.osRelease.includes('VERSION_ID="24.04"'))) fail('runtime does not match fixed engine toolchain policy')
  return actual
}

export function makePlan(root, runtime, env = process.env) {
  const sourceCommit = requireMain(root, env)
  git(root, 'diff', '--exit-code', 'HEAD', '--', ...COMPONENTS.engine)
  if (git(root, 'ls-files', '--others', '--exclude-standard', '--', ...COMPONENTS.engine)) fail('uncommitted engine inputs')
  return { schema: 1, component: 'engine', sourceCommit, sourceRef: 'refs/heads/main', buildRun: env.GITHUB_RUN_ID || `local-${new Date().toISOString()}`, toolchain: runtime, ...committedInputs(root, runtime) }
}

export function verifyTrusted(root, lock, artifact) {
  if (!lock?.components?.engine) fail('engine lock is required')
  const scoped = { schema: lock.schema, components: { engine: lock.components.engine } }
  verifyLock(root, scoped)
  const manifest = verifyManifest(root, scoped, 'engine', join(artifact, 'manifest.json'), artifact)
  if (manifest.independentRebuildMatched !== true || canonicalJson(manifest.replicas) !== '["primary","reference"]') fail('base has no independent rebuild proof')
  checkPayload(artifact, manifest)
  return manifest
}

export function rebase(value, from, to) {
  if (typeof value === 'string') {
    if (value === from || value.startsWith(from + '/')) return to + value.slice(from.length)
    if (value.startsWith('file://' + from + '/')) return 'file://' + to + value.slice(7 + from.length)
    return value
  }
  if (Array.isArray(value)) return value.map(item => rebase(item, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, from, to)]))
  return value
}

export function refreshPolicyHashes(reports) {
  const path = join(reports, 'source-build-policy.json')
  const policy = json(path)
  for (const [field, name] of [
    ['harnessVendorSourceOverridesSha256', 'harness-vendor-overrides.json'],
    ['harnessVendorLockReconciliationSha256', 'harness-vendor-lock-reconciliation.json'],
  ]) policy[field] = sha(readFileSync(join(reports, name)))
  save(path, policy)
}

export function indexTree(root) {
  const rows = []
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), info = lstatSync(path), rel = relative(root, path).split(sep).join('/')
      if (info.isSymbolicLink()) {
        const target = readlinkSync(path), physical = realpathSync(path)
        const top = resolve(root, rel.split('/')[0])
        if (target.startsWith('/') || (physical !== top && !physical.startsWith(top + sep))) fail('escaped or broken payload link: ' + rel)
        rows.push({ path: rel, type: 'link', target })
      } else if (info.isDirectory()) {
        rows.push({ path: rel, type: 'directory', mode: info.mode & 0o777 }); walk(path)
      } else if (info.isFile()) rows.push({ path: rel, type: 'file', mode: info.mode & 0o777, size: info.size, sha256: sha(readFileSync(path)) })
      else fail('special payload file: ' + rel)
    }
  }
  walk(root)
  return rows
}

function copyTree(from, to, support = false) {
  if (!existsSync(from) || lstatSync(from).isSymbolicLink()) fail('missing or linked build output: ' + from)
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter: path => {
    const parts = relative(from, path).split(sep)
    if (support && parts.some(part => ['.git', 'node_modules', '.cache', '.turbo'].includes(part))) return false
    if (support && /(?:\.map|\.tsbuildinfo)$/.test(path)) return false
    if (!support && ['.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(parts.at(-1))) return false
    return !parts.includes('.pack')
  } })
  const normalize = directory => {
    const info = lstatSync(directory)
    if (info.isSymbolicLink()) return
    chmodSync(directory, info.isDirectory() ? 0o755 : (info.mode & 0o111 ? 0o755 : 0o644))
    if (info.isDirectory()) for (const name of readdirSync(directory)) normalize(join(directory, name))
  }
  normalize(to)
}

/** Canonicalize only the two order-independent root metadata files emitted by pnpm deploy. */
export function canonicalizeEngineDeploy(engineDeploy) {
  for (const [name, canonicalize] of [
    ['package.json', (text) => canonicalPackageJson(text)],
    ['pnpm-workspace.yaml', (text) => canonicalYamlMapping(text, 'engine-deploy/pnpm-workspace.yaml')],
  ]) {
    const path = join(engineDeploy, name)
    if (!existsSync(path) || !lstatSync(path).isFile()) fail(`engine-deploy is missing a regular ${name}`)
    writeFileSync(path, canonicalize(readFileSync(path, 'utf8')))
  }
}

export function capture(root, plan, artifact, buildRun, replica, env = process.env) {
  if (requireMain(root, env) !== plan.sourceCommit) fail('source commit changed during engine build')
  if (buildRun !== plan.buildRun || !['primary', 'reference'].includes(replica)) fail('invalid replica/run identity')
  const expected = committedInputs(root, plan.toolchain)
  if (expected.key !== plan.key || expected.inputs.sha256 !== plan.inputs.sha256) fail('producer plan drifted')
  const modified = git(root, 'diff', '--name-only', 'HEAD', '--', ...COMPONENTS.engine).split('\n').filter(Boolean)
  const allowed = new Set([
    'scripts/snapshot-config/engine-overlay.json',
    'vendor/dshmarketplace-plugin/package.json',
    'vendor/dshmarketplace-plugin/PATCHES.md',
  ])
  if (modified.some(path => !allowed.has(path))) fail('engine inputs changed during build: ' + modified.join(', '))
  const versions = readFileSync(join(root, '.deploy-tmp/source-build/package-manager-versions.txt'), 'utf8').trim()
  if (versions !== `${plan.toolchain.pnpm}\ndeployment pnpm: ${plan.toolchain.deploymentPnpm}`) fail('package-manager receipt differs from plan')
  if (existsSync(artifact) && readdirSync(artifact).length) fail('artifact directory must be empty')
  mkdirSync(artifact, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'engine-payload-'))
  const payload = join(scratch, 'payload')
  mkdirSync(payload)
  try {
    copyTree(join(root, '.deploy-tmp/engine-deploy'), join(payload, 'engine-deploy'))
    canonicalizeEngineDeploy(join(payload, 'engine-deploy'))
    copyTree(join(root, '.deploy-tmp/engine-overlay'), join(payload, 'engine-overlay'))
    copyTree(join(root, '.deploy-tmp/deepseek-harness'), join(payload, 'harness-source'), true)
    copyTree(join(root, 'vendor/dshmarketplace-plugin'), join(payload, 'marketplace'))
    mkdirSync(join(payload, 'component-sources'))
    cpSync(join(root, '.deploy-tmp/component-sources/dshmarketplace-plugin-0.1.7.tgz'), join(payload, 'component-sources/dshmarketplace-plugin-0.1.7.tgz'))
    const reports = join(payload, 'reports')
    mkdirSync(reports)
    for (const name of REPORTS) {
      const from = join(root, '.deploy-tmp/source-build', name), to = join(reports, name)
      if (!existsSync(from)) fail('missing engine receipt: ' + name)
      if (name.endsWith('.json') && !['engine-overlay.original.json', 'effective-engine-overlay.json'].includes(name)) save(to, rebase(json(from), root, '${WORKSPACE}'))
      else writeFileSync(to, readFileSync(from))
    }
    refreshPolicyHashes(reports)
    const tree = indexTree(payload)
    save(join(artifact, 'tree.json'), tree)
    const tar = join(scratch, 'payload.tar'), file = `base-engine-${plan.key}.tar.zst`
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', tar, '-C', payload, '.'])
    execFileSync('zstd', ['-T4', '-q', tar, '-o', join(artifact, file)])
    const outputs = [file, 'tree.json'].map(path => ({ path, size: statSync(join(artifact, path)).size, sha256: sha(readFileSync(join(artifact, path))) }))
    const manifest = { ...plan, buildRun, replica, treeSha256: sha(readFileSync(join(artifact, 'tree.json'))), outputs }
    save(join(artifact, 'manifest.json'), manifest)
    return manifest
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export function checkPayload(artifact, manifest) {
  const manifestPath = join(artifact, 'manifest.json')
  verifyManifest('.', { components: { engine: { ...manifest, manifestSha256: sha(readFileSync(manifestPath)) } } }, 'engine', manifestPath, artifact)
  const file = manifest.outputs.find(output => output.path === `base-engine-${manifest.key}.tar.zst`)
  if (!file || manifest.treeSha256 !== sha(readFileSync(join(artifact, 'tree.json')))) fail('archive or tree receipt missing')
  const scratch = mkdtempSync(join(tmpdir(), 'engine-check-'))
  try {
    const tar = join(scratch, 'payload.tar'), payload = join(scratch, 'payload')
    execFileSync('zstd', ['-d', '-q', join(artifact, file.path), '-o', tar])
    execFileSync('python3', [join(HERE, 'base-archive.py'), tar, payload])
    if (canonicalJson(indexTree(payload)) + '\n' !== readFileSync(join(artifact, 'tree.json'), 'utf8')) fail('payload tree differs from receipt')
    return true
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Verify a trusted base, then materialize its payload into the build workspace. */
export function materialize(root, artifact, env = process.env) {
  requireMain(root, env)
  const lock = json(join(root, 'base-lock.json'))
  const manifest = verifyTrusted(root, lock, artifact)
  checkPayload(artifact, manifest)
  const file = manifest.outputs.find(output => output.path === `base-engine-${manifest.key}.tar.zst`)
  const scratch = mkdtempSync(join(tmpdir(), 'engine-materialize-'))
  try {
    const tar = join(scratch, 'payload.tar'), payload = join(scratch, 'payload')
    execFileSync('zstd', ['-d', '-q', join(artifact, file.path), '-o', tar])
    execFileSync('python3', [join(HERE, 'base-archive.py'), tar, payload])
    if (canonicalJson(indexTree(payload)) + '\n' !== readFileSync(join(artifact, 'tree.json'), 'utf8')) fail('payload tree differs from receipt')
    for (const [from, to, support] of [
      ['engine-deploy', '.deploy-tmp/engine-deploy', false],
      ['engine-overlay', '.deploy-tmp/engine-overlay', false],
      ['harness-source', '.deploy-tmp/deepseek-harness', true],
      ['marketplace', 'vendor/dshmarketplace-plugin', false],
    ]) {
      const destination = join(root, to)
      rmSync(destination, { recursive: true, force: true })
      copyTree(join(payload, from), destination, support)
    }
    const reports = join(root, '.deploy-tmp/source-build')
    mkdirSync(reports, { recursive: true })
    for (const name of readdirSync(join(payload, 'reports'))) {
      cpSync(join(payload, 'reports', name), join(reports, name), { force: true })
    }
    const components = join(root, '.deploy-tmp/component-sources')
    mkdirSync(components, { recursive: true })
    cpSync(join(payload, 'component-sources/dshmarketplace-plugin-0.1.7.tgz'),
      join(components, 'dshmarketplace-plugin-0.1.7.tgz'), { force: true })
    return manifest
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export function publishCandidate(root, plan, primary, reference, destination, env = process.env) {
  const sourceCommit = requireMain(root, env)
  if (plan.sourceCommit !== sourceCommit || committedInputs(root, plan.toolchain).key !== plan.key) fail('comparison plan drifted')
  const a = json(join(primary, 'manifest.json')), b = json(join(reference, 'manifest.json'))
  for (const manifest of [a, b]) {
    if (manifest.sourceCommit !== sourceCommit || manifest.sourceRef !== 'refs/heads/main' || manifest.buildRun !== plan.buildRun) fail('replica source identity mismatch')
    if (manifest.key !== plan.key || canonicalJson(manifest.toolchain) !== canonicalJson(plan.toolchain)) fail('replica plan mismatch')
    if (committedInputs(root, manifest.toolchain).key !== manifest.key) fail('replica inputs mismatch')
  }
  if (a.replica === b.replica || a.buildRun !== b.buildRun || a.key !== b.key || canonicalJson(a.toolchain) !== canonicalJson(b.toolchain)) fail('replicas are not from the same independent build plan')
  checkPayload(primary, a); checkPayload(reference, b)
  if (a.treeSha256 !== b.treeSha256) fail('independent engine output trees differ')
  if (existsSync(destination) && readdirSync(destination).length) fail('candidate destination must be empty')
  cpSync(primary, destination, { recursive: true })
  const manifest = { ...a, independentRebuildMatched: true, replicas: [a.replica, b.replica], referenceTreeSha256: b.treeSha256 }
  save(join(destination, 'manifest.json'), manifest)
  const entry = { key: a.key, manifestSha256: sha(readFileSync(join(destination, 'manifest.json'))), artifact: a.outputs[0].path,
    buildRun: a.buildRun, sourceCommit, toolchain: a.toolchain }
  save(join(destination, 'base-lock.candidate.json'), { schema: 1, components: { engine: entry } })
  return entry
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const root = resolve('.')
  if (command === 'plan') {
    const plan = makePlan(root, toolchain(root, args.includes('--local')))
    save(resolve(args[0]), plan)
    if (process.env.GITHUB_OUTPUT) {
      const lockPath = join(root, 'base-lock.json')
      const lock = existsSync(lockPath) ? json(lockPath) : null
      const entry = lock?.components?.engine
      const trusted = entry?.key === plan.key
      if (trusted) verifyLock(root, { schema: lock.schema, components: { engine: entry } })
      const outputs = `key=${plan.key}\ntrusted=${trusted}\ncache_key=base-engine-${plan.key}-${trusted ? entry.manifestSha256 : 'unlocked'}\n`
      writeFileSync(process.env.GITHUB_OUTPUT, outputs, { flag: 'a' })
    }
    console.log(plan.key)
  } else if (command === 'capture') capture(root, json(resolve(args[0])), resolve(args[1]), process.env.GITHUB_RUN_ID || args[2], process.env.BASE_REPLICA || args[3])
  else if (command === 'compare') console.log(JSON.stringify(publishCandidate(root, json(resolve(args[0])), ...args.slice(1).map(path => resolve(path)))))
  else if (command === 'check-plan') {
    const expected = json(resolve(args[0]))
    const actual = makePlan(root, toolchain(root, expected.toolchain.localDevelopment))
    if (canonicalJson(expected) !== canonicalJson(actual)) fail('builder differs from resolved plan')
  } else if (command === 'materialize') {
    materialize(root, resolve(args[0]))
  } else if (command === 'reuse') {
    requireMain(root)
    const artifact = resolve(args[0]), destination = resolve(args[1]), lock = json(join(root, 'base-lock.json'))
    verifyTrusted(root, lock, artifact)
    if (existsSync(destination) && readdirSync(destination).length) fail('reuse destination must be empty')
    cpSync(artifact, destination, { recursive: true })
    save(join(destination, 'base-lock.candidate.json'), { schema: lock.schema, components: { engine: lock.components.engine } })
  }
  else if (command === '--self-test') execFileSync(process.execPath, ['--test', join(HERE, 'engine-base.test.mjs')], { stdio: 'inherit' })
  else fail('usage: engine-base.mjs plan plan.json [--local] | capture plan.json artifact run replica | compare plan.json primary reference candidate | materialize artifact | reuse artifact destination | --self-test')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
