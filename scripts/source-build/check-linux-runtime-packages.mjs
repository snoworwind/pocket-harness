#!/usr/bin/env node
// Audit the guest engine's glibc native loaders and the packaged native inventory.
// Every deployed koffi consumer must resolve the linux-arm64 binding through its
// published loader; sharp must reach its published Linux loader and AArch64 ELF;
// node-pty must use prebuilds/linux-arm64 without source shadows. Every native
// module under node_modules/.pnpm must belong to a reviewed publisher family.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReviewedNativePath } from './native-payload-families.mjs'
import { linuxAbi } from './linux-abi.mjs'
const within = (root, path) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

export function guestElf(bytes, abi, label = 'guest native module') {
  const config = linuxAbi(abi)
  assert.ok(
    bytes.length >= 20
      && bytes.subarray(0, 6).toString('hex') === '7f454c460201'
      && bytes.readUInt16LE(18) === config.elfMachine,
    `${label}: guest native module must be ${config.elfName} ELF`,
  )
}

function packageAt(root, from, name) {
  for (let directory = realpathSync(from); within(root, directory); directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      const found = realpathSync(candidate)
      assert.ok(within(root, found), `${name} escapes the guest engine`)
      return found
    }
    if (dirname(directory) === directory) break
  }
  throw new Error(`${name} is missing from the guest dependency lookup path`)
}

function identity(directory, name, version) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, version)
  return manifest
}

function files(root, prefix = '') {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const rel = prefix + entry.name
    if (entry.isDirectory()) found.push(...files(path, `${rel}/`))
    else if (entry.isFile() && /\.node(?:\.wasm)?$/.test(entry.name)) found.push({ path: rel, file: path })
  }
  return found
}

function koffiBinding(root, from, consumer, abi) {
  const config = linuxAbi(abi)
  const packageName = `@koromix/koffi-${config.nodePlatform}`
  const source = packageAt(root, from, 'koffi')
  const manifest = identity(source, 'koffi', '3.2.1')
  assert.equal(manifest.optionalDependencies?.[packageName], '3.2.1', `${consumer} must declare the glibc koffi binding`)
  const binding = packageAt(root, source, packageName)
  identity(binding, packageName, '3.2.1')
  const loader = readFileSync(join(binding, 'index.js'), 'utf8')
  assert.ok(
    loader.includes(`glibc: "./linux_${config.abi === 'arm64' ? 'arm64' : 'x64'}/koffi.node"`),
    'koffi loader no longer selects the glibc binding',
  )
  const module = join(binding, `linux_${config.abi === 'arm64' ? 'arm64' : 'x64'}/koffi.node`)
  guestElf(readFileSync(module), abi, consumer)
  return { consumer, path: relative(root, module), sha256: hash(module) }
}

function sharpBinding(root, from, abi) {
  const config = linuxAbi(abi)
  const packageName = `@img/sharp-${config.nodePlatform}`
  const source = packageAt(root, from, 'sharp')
  identity(source, 'sharp', '0.35.5')
  const loader = readFileSync(join(source, 'dist/sharp.mjs'), 'utf8')
  assert.ok(loader.includes(`${config.nodePlatform}/sharp.node`), `sharp loader no longer selects the ${config.nodePlatform} binding`)
  // The exported subpath resolves to the package's index.cjs, which requires the actual ELF.
  const entry = createRequire(join(source, 'dist/sharp.mjs')).resolve(`${packageName}/sharp.node`)
  const binding = realpathSync(dirname(entry))
  identity(binding, packageName, '0.35.5')
  const moduleName = /require\('\.\/lib\/([^']+\.node)'\)/.exec(readFileSync(entry, 'utf8'))?.[1]
  assert.ok(moduleName, 'sharp binding loader no longer requires a lib/*.node module')
  const module = join(binding, 'lib', moduleName)
  assert.ok(existsSync(module), `sharp binding loader points at a missing module: ${moduleName}`)
  guestElf(readFileSync(module), abi, 'sharp')
  return { path: relative(root, module), sha256: hash(module) }
}

function nodePtyBinding(root, from, abi) {
  const config = linuxAbi(abi)
  const binding = packageAt(root, from, 'node-pty')
  identity(binding, 'node-pty', '1.2.0-beta.15')
  const module = join(binding, `prebuilds/${config.nodePlatform}/pty.node`)
  assert.ok(existsSync(module), `node-pty is missing the ${config.nodePlatform} prebuild`)
  guestElf(readFileSync(module), abi, 'node-pty')
  for (const shadow of ['build/Release/pty.node', 'build/Debug/pty.node']) {
    assert.ok(!existsSync(join(binding, shadow)), `node-pty shadow binding: ${shadow}`)
  }
  return { path: relative(root, module), sha256: hash(module) }
}

/** Production engine archives must not carry stripped development payloads. */
export function checkEngineArtifacts(root, abi = process.env.DSH_ABI || 'arm64') {
  for (const name of walkNames(root)) {
    assert.ok(!name.split('/').includes('__tests__') && !name.endsWith('.map') && !name.split('/').pop().includes('.test.'),
      `guest engine contains development metadata: ${name}`)
    const path = join(root, name)
    if (!lstatSync(path).isFile()) continue
    const fd = openSync(path, 'r'), header = Buffer.alloc(20)
    let count
    try { count = readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
    if (count >= 4 && header.subarray(0, 4).toString('hex') === '7f454c46') guestElf(header.subarray(0, count), abi, name)
  }
}

export function checkLinuxRuntimePackages(input, reportPath, abi = process.env.DSH_ABI || 'arm64') {
  const config = linuxAbi(abi)
  const root = realpathSync(input)
  const scope = join(root, 'node_modules/@deepseek-ai')
  assert.ok(existsSync(scope), 'guest engine dependency scope is missing')

  // Enumerate every deployed first-party package that declares koffi; Linux must
  // never fall back to the Android binding through any of them.
  const deployed = new Map()
  for (const entry of readdirSync(scope).sort()) {
    const directory = join(scope, entry)
    if (!existsSync(join(directory, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (typeof manifest.name === 'string') deployed.set(manifest.name, directory)
  }
  const koffi = []
  for (const [name, directory] of [...deployed].sort(([left], [right]) => left.localeCompare(right))) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (!manifest.dependencies?.koffi) continue
    koffi.push(koffiBinding(root, directory, name, abi))
  }
  assert.ok(koffi.length > 0, 'no deployed koffi consumer was audited')

  for (const name of ['@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-attachment-local']) {
    assert.ok(deployed.has(name), `guest engine is missing ${name}`)
  }

  const sharp = sharpBinding(root, deployed.get('@deepseek-ai/dsh-attachment-local'), abi)
  const nodePty = nodePtyBinding(root, deployed.get('@deepseek-ai/dsh-subprocess-local'), abi)

  const inventory = files(join(root, 'node_modules/.pnpm'))
  assert.ok(inventory.length > 0, 'native module inventory is empty: nothing collected under node_modules/.pnpm')
  for (const item of inventory) {
    assert.ok(isReviewedNativePath(item.path), `unreviewed guest native payload: ${item.path}`)
    assert.ok(!item.path.includes('koffi-android'), `Android koffi binding in the Linux guest: ${item.path}`)
  }
  // Negative control for foreign-architecture payloads (audit R-05): the guest tree may only
  // carry the target platform's native packages and prebuilds.
  const foreign = [...walkNames(join(root, 'node_modules/.pnpm'))].filter(name => hasForeignPlatform(name, abi))
  assert.equal(foreign.length, 0, `foreign-architecture guest payload: ${foreign.slice(0, 5).join(', ')}`)

  const report = {
    target: config.runtime,
    koffi,
    sharp,
    nodePty,
    inventory: inventory
      .map((item) => ({ path: item.path, sha256: hash(item.file) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  }
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function walkNames(root) {
  const names = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      names.push(rel)
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`)
    }
  }
  walk(root, '')
  return names
}

const PLATFORM_TOKEN = /(?:linux-(x64|ia32|arm64|armv7l|ppc64|s390x|riscv64)|darwin-(?:x64|arm64)|win32-(?:x64|arm64|ia32)|android-(arm64|x64|arm|ia32))/g

export function hasForeignPlatform(name, abi = 'arm64') {
  const keep = linuxAbi(abi).nodePlatform
  return [...name.matchAll(PLATFORM_TOKEN)].some(match => match[0] !== keep)
}

function selfTest() {
  execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./linux-runtime-packages.test.mjs', import.meta.url))], { stdio: 'inherit' })
}

if (process.argv[1]) {
  // /var and /private/var alias on macOS; compare real paths so the CLI never silently no-ops.
  const invoked = realpathSync(resolve(process.argv[1]))
  if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
    const argv = process.argv.slice(2)
    if (argv.includes('--self-test')) selfTest()
    else if (argv.length < 1) {
      console.error('usage: node check-linux-runtime-packages.mjs <engine-root> [report.json] | --self-test')
      process.exit(2)
    } else {
      checkLinuxRuntimePackages(resolve(argv[0]), argv[1], process.env.DSH_ABI || 'arm64')
      console.log('Linux glibc runtime loaders and native inventory verified')
    }
  }
}
