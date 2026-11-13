import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tar from 'tar-stream'
import { Context } from '@deepseek-ai/cordis'
import { createLinuxBootstrapConfig, createHostAssetIO } from '../lib/linux-host-asset-io.js'
import { createLinuxPluginHost, cordisScope } from '../lib/linux-environment.js'
import { apply as applyBootstrap, createBootstrap, inject as bootstrapInject, name as bootstrapName } from '../../dsh-linux-bootstrap/src/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const posix = { skip: process.platform === 'win32' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(fn) {
  const parent = join(ROOT, '.deploy-tmp')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'offline-linux-integration-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
async function archive(file, entries) {
  const pack = tar.pack()
  for (const [header, body] of entries) pack.entry(header, body)
  pack.finalize()
  const chunks = []
  for await (const chunk of pack) chunks.push(chunk)
  const bytes = execFileSync('xz', ['-c'], { input: Buffer.concat(chunks) })
  await writeFile(file, bytes)
  return file
}
const dirEntry = name => [{ name, type: 'directory', size: 0 }, '']
const fileEntry = (name, body = 'payload', mode = 0o644) => [{ name, type: 'file', mode }, body]
const symlinkEntry = (name, linkname) => [{ name, type: 'symlink', linkname, size: 0 }, '']
const hardlinkEntry = (name, linkname) => [{ name, type: 'link', linkname, size: 0 }, '']
async function archiveDirectory(file, root) {
  const entries = [dirEntry('./')]
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const relativeName = prefix ? `${prefix}/${name}` : name
      const info = await lstat(path)
      if (info.isDirectory()) {
        entries.push([{ name: relativeName + '/', type: 'directory', mode: info.mode & 0o777, size: 0 }, ''])
        await visit(path, relativeName)
      } else if (info.isSymbolicLink()) {
        entries.push(symlinkEntry(relativeName, await readlink(path)))
      } else if (info.isFile()) {
        entries.push(fileEntry(relativeName, await readFile(path), info.mode & 0o777))
      } else {
        throw new Error(`unsupported fixture entry: ${path}`)
      }
    }
  }
  await visit(root)
  return archive(file, entries)
}

test('bootstrap apply activates in real Cordis with the host-provided dataDir', () => fixture(async filesDir => {
  const previousFilesDir = process.env.DSH_FILES_DIR
  delete process.env.DSH_FILES_DIR
  try {
    const ctx = new Context()
    const config = createLinuxBootstrapConfig({
      filesDir,
      appVersion: '0.14.8',
      bundleDirectory: join(filesDir, 'linux-assets'),
    })
    const host = { install: async () => { throw new Error('install is not expected in this activation test') }, uninstall: async () => {} }
    ctx.provide('linuxPluginHost', host)
    ctx.provide('linuxBootstrapConfig', config)
    const fiber = ctx.plugin({ name: bootstrapName, inject: bootstrapInject, apply: applyBootstrap })
    try {
      await fiber
      const service = ctx.get('linuxBootstrap')
      assert.equal(typeof service?.status, 'function', 'real Cordis apply must provide linuxBootstrap')
      const status = await service.status()
      assert.equal(status.enabled, false, 'activation alone must not enable or install Linux')
      assert.equal(status.installed, false)
    } finally {
      await fiber.dispose()
    }
  } finally {
    if (previousFilesDir === undefined) delete process.env.DSH_FILES_DIR
    else process.env.DSH_FILES_DIR = previousFilesDir
  }
}))

test('GNU tar root and guest-scoped links are accepted without permitting plugin links', posix, () => fixture(async dir => {
  const io = createHostAssetIO({ filesDir: dir })
  const file = await archive(join(dir, 'root.tar.xz'), [dirEntry('./'), hardlinkEntry('copy', './file'), fileEntry('./file'), symlinkEntry('bin/link', '../file'), symlinkEntry('absolute', '/file')])
  const destination = join(dir, 'rootfs')
  await io.extractArchive(file, destination, { kind: 'rootfs' })
  assert.equal(await readFile(join(destination, 'bin/link'), 'utf8'), 'payload')
  assert.equal(await readFile(join(destination, 'absolute'), 'utf8'), 'payload')
  assert.equal(await readlink(join(destination, 'absolute')), 'file')
  assert.equal((await stat(join(destination, 'copy'))).ino, (await stat(join(destination, 'file'))).ino)
  await assert.rejects(io.extractArchive(file, join(dir, 'plugin'), { kind: 'plugin' }), /links/)
}))

test('rootfs hard links are accepted through an aliased filesDir without weakening containment', posix, () => fixture(async dir => {
  const realFilesDir = join(dir, 'real-files')
  const aliasFilesDir = join(dir, 'aliased-files')
  await mkdir(realFilesDir)
  await symlink(realFilesDir, aliasFilesDir, 'dir')

  const io = createHostAssetIO({ filesDir: aliasFilesDir })
  const good = await archive(join(dir, 'alias-rootfs.tar.xz'), [
    dirEntry('./'),
    hardlinkEntry('copy', './file'),
    fileEntry('./file', 'payload'),
  ])
  const destination = join(aliasFilesDir, 'rootfs')
  await io.extractArchive(good, destination, { kind: 'rootfs' })
  assert.equal(await readFile(join(destination, 'copy'), 'utf8'), 'payload')
  assert.equal((await stat(join(destination, 'copy'))).ino, (await stat(join(destination, 'file'))).ino)

  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'untouched')
  const escape = await archive(join(dir, 'alias-escape.tar.xz'), [
    dirEntry('./'),
    hardlinkEntry('escape', '../outside/sentinel'),
  ])
  await assert.rejects(io.extractArchive(escape, join(aliasFilesDir, 'escape'), { kind: 'rootfs' }), /escapes extraction root/)

  const destinationLink = join(aliasFilesDir, 'destination-link')
  await symlink(outside, destinationLink, 'dir')
  await assert.rejects(io.extractArchive(good, destinationLink, { kind: 'rootfs' }), /fresh empty directory/)
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
}))

test('archive root, duplicate, traversal, link-parent and hard-link escape negative controls', posix, () => fixture(async dir => {
  const io = createHostAssetIO({ filesDir: dir })
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'untouched')
  const cases = [
    [fileEntry('.', 'root payload')],
    [dirEntry('./'), dirEntry('.')],
    [fileEntry('../outside/sentinel', 'poison')],
    [fileEntry('same'), fileEntry('./same', 'poison')],
    [symlinkEntry('escape', '../../outside')],
    [hardlinkEntry('escape', '../outside/sentinel')],
    [symlinkEntry('parent', 'file'), fileEntry('parent/child'), fileEntry('file')],
    [symlinkEntry('target', 'file'), hardlinkEntry('copy', 'target'), fileEntry('file')],
  ]
  for (const [index, entries] of cases.entries()) {
    const file = await archive(join(dir, `bad-${index}.tar.xz`), entries)
    await assert.rejects(io.extractArchive(file, join(dir, `bad-${index}`), { kind: 'rootfs' }))
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  }
  const good = await archive(join(dir, 'good.tar.xz'), [dirEntry('./'), fileEntry('file')])
  await assert.rejects(io.extractArchive(good, outside), /fresh empty/)
  await assert.rejects(io.extractArchive(await archive(join(dir, 'node-absolute.tar.xz'), [symlinkEntry('abs', '/file')]), join(dir, 'node-absolute'), { kind: 'node' }), /Absolute/)
}))

async function put(dir, name, body, mode = 0o644) {
  const target = join(dir, name)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body)
  await chmod(target, mode)
}
async function unpackedSize(dir) {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(dir)) {
    const file = join(dir, entry), info = await lstat(file)
    if (info.isDirectory()) total += await unpackedSize(file)
    else if (info.isFile()) total += info.size
  }
  return total
}

test('offline production host + bootstrap + runtime install, execute, reinstall and uninstall', { ...posix, timeout: 30_000 }, () => fixture(async filesDir => {
  const bundle = join(filesDir, 'signed-bundle')
  await mkdir(bundle)
  const base = 'https://github.com/snoworwind/pocket-harness/releases/download/v0.6.0/'
  async function pack(name, build) {
    const source = join(filesDir, name + '-source')
    await mkdir(source)
    await build(source)
    await archiveDirectory(join(bundle, name), source)
    const bytes = await readFile(join(bundle, name))
    return { url: base + name, size: bytes.length, sha256: sha(bytes), unpackedSize: await unpackedSize(source) }
  }
  const runtime = await pack('linux-runtime-plugin.tar.xz', async source => {
    for (const name of ['lib', 'modules', 'package.json']) await cp(join(ROOT, 'vendor/dsh-linux-runtime', name), join(source, name), { recursive: true })
  })
  const node = await pack('node-glibc-v24.22.0-linux-arm64.tar.xz', async source => {
    await put(source, 'bin/node', '#!/bin/sh\n', 0o755)
    await put(source, 'lib/node_modules/npm/bin/npm-cli.js', '// npm\n')
    const { symlink } = await import('node:fs/promises')
    await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(source, 'bin/npm'))
  })
  const backend = await pack('proot-backend-aarch64.tar.xz', async source => {
    await put(source, 'bin/proot', '#!/bin/sh\n', 0o755)
    await put(source, 'lib/libtalloc.so', 'fixture talloc payload\n')
    await put(source, 'lib/libandroid-shmem.so', 'fixture shmem payload\n')
    await put(source, 'libexec/proot/loader', '#!/bin/sh\n', 0o755)
    await put(source, 'LICENSE-GPL-2.0.txt', 'fixture GPL text\n')
  })
  const rootfs = await pack('debian-minimal-aarch64.tar.xz', async source => {
    for (const name of ['sh', 'bash', 'apt-get', 'dpkg']) await put(source, 'usr/bin/' + name, '#!/bin/sh\n', 0o755)
    await put(source, 'etc/os-release', 'ID=debian\n')
    await put(source, 'etc/resolv.conf', '# generated at runtime\n')
    await put(source, 'etc/ld.so.preload', '/opt/pocket-harness/libpocket-linux-compat.so\n')
    await put(source, 'opt/pocket-harness/libpocket-linux-compat.so', 'fixture compatibility preload\n', 0o755)
    for (const name of ['dev', 'dev/shm', 'proc', 'sys', 'tmp', 'var/tmp']) await mkdir(join(source, name), { recursive: true })
    const { symlink } = await import('node:fs/promises')
    await symlink('usr/bin', join(source, 'bin'))
  })
  const bootstrapAsset = { ...runtime, url: base + 'linux-bootstrap-plugin.tar.xz' }
  const manifest = { schemaVersion: 1, version: '0.6.0', minMobileVersion: '0.14.0', plugins: { bootstrap: bootstrapAsset, runtime }, runtimes: [{ id: 'debian-minimal', label: 'Debian', architecture: 'arm64', backend: 'proot', prootVersion: '5.1.107.98', backendAsset: backend, rootfsAsset: rootfs, nodeAsset: node }] }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  await writeFile(join(bundle, 'linux-release.json'), manifestBytes)
  await writeFile(join(bundle, 'linux-runtime-manifest.sha256'), sha(manifestBytes))
  const tools = new Map()
  const ctx = new Context()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const config = createLinuxBootstrapConfig({ filesDir, appVersion: '0.14.8', bundleDirectory: bundle })
  const calls = []
  const nativeRunner = async spec => {
    calls.push(spec)
    const versionProbe = spec.args?.length === 1 && spec.args[0] === '--version'
    const guestProbe = spec.args?.at(-1) === 'node --version'
    return { exitCode: 0, stdout: versionProbe ? 'PRoot v5.1.107.98\n' : guestProbe ? 'v24.22.0\n' : 'native-fixture-ok\n', stderr: '' }
  }
  const host = createLinuxPluginHost({ root: join(filesDir, 'linux-environment', 'plugins'), activate: (plugin, options) => cordisScope(ctx.plugin(plugin, options)) })
  const originalFetch = globalThis.fetch
  let network = 0
  globalThis.fetch = async () => { network++; throw new Error('network forbidden') }
  try {
    const service = createBootstrap({ ...config, pluginHost: host, runtimePluginConfig: { ...config.runtimePluginConfig, runCommand: nativeRunner } })
    await assert.rejects(service.install({ confirmed: false, activate: true }), /confirmed/)
    await service.install({ confirmed: true, activate: true })
    assert.equal((await service.status()).installed, true)
    assert.equal((await host.isInjected({ runtimeId: 'linux-runtime' })).active, true)
    assert.equal(ctx.get('linuxRuntimeManager').status().healthy, true)
    assert.equal((await tools.get('linux_bash').execute({ command: 'echo usable' })).stdout, 'native-fixture-ok\n')
    await service.reinstall({ confirmed: true, activate: true })
    assert.equal(ctx.get('linuxRuntimeManager').status().healthy, true)
    const ownedManager = ctx.get('linuxRuntimeManager')
    await service.uninstall({ confirmed: true })
    assert.equal(ownedManager.disposed, true, 'real Cordis teardown awaits the owned runtime manager')
    assert.equal(tools.has('linux_bash'), false)
    assert.equal(network, 0)
    assert.ok(calls.some(spec => spec.args.at(-1) === 'node --version'))
  } finally {
    globalThis.fetch = originalFetch
    await host.uninstall()
  }
}))
