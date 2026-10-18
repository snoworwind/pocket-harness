import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tar from 'tar-stream'
import { Context } from '@deepseek-ai/cordis'
import { createLinuxBootstrapConfig, createHostAssetIO } from '../lib/linux-host-asset-io.js'
import { createLinuxPluginHost, cordisScope } from '../lib/linux-environment.js'
import { createBootstrap } from '../../dsh-linux-bootstrap/src/index.js'

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
const fileEntry = (name, body = 'payload') => [{ name, type: 'file' }, body]
const symlinkEntry = (name, linkname) => [{ name, type: 'symlink', linkname, size: 0 }, '']
const hardlinkEntry = (name, linkname) => [{ name, type: 'link', linkname, size: 0 }, '']

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
  const base = 'https://github.com/snoworwind/pocket-harness/releases/download/v0.5.0/'
  async function pack(name, build) {
    const source = join(filesDir, name + '-source')
    await mkdir(source)
    await build(source)
    // Same producer shape as package-linux-assets.py, including the ./ root member.
    execFileSync('tar', ['--sort=name', '-cJf', join(bundle, name), '-C', source, '.'])
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
  const backend = await pack('bionilux-backend-aarch64.tar.xz', async source => {
    await put(source, 'bin/bionilux', '#!/bin/sh\n', 0o755)
    await put(source, 'lib/libbionilux_preload.so', 'fixture native payload\n')
    await put(source, 'scripts/prepare-rootfs.sh', '#!/bin/sh\n', 0o755)
  })
  const rootfs = await pack('debian-minimal-aarch64.tar.xz', async source => {
    for (const name of ['sh', 'bash', 'apt-get', 'dpkg']) await put(source, 'usr/bin/' + name, '#!/bin/sh\n', 0o755)
    await put(source, 'etc/os-release', 'ID=debian\n')
    const { symlink } = await import('node:fs/promises')
    await symlink('usr/bin', join(source, 'bin'))
  })
  const bootstrapAsset = { ...runtime, url: base + 'linux-bootstrap-plugin.tar.xz' }
  const manifest = { schemaVersion: 1, version: '0.5.0', minMobileVersion: '0.14.0', plugins: { bootstrap: bootstrapAsset, runtime }, runtimes: [{ id: 'debian-minimal', label: 'Debian', architecture: 'arm64', backend: 'bionilux', backendAsset: backend, rootfsAsset: rootfs, nodeAsset: node }] }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  await writeFile(join(bundle, 'linux-release.json'), manifestBytes)
  await writeFile(join(bundle, 'linux-runtime-manifest.sha256'), sha(manifestBytes))
  const tools = new Map()
  const ctx = new Context()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const config = createLinuxBootstrapConfig({ filesDir, appVersion: '0.14.7', bundleDirectory: bundle })
  const calls = []
  const nativeRunner = async spec => {
    calls.push(spec)
    return { exitCode: 0, stdout: spec.args[0] === 'node' ? 'v24.22.0\n' : 'native-fixture-ok\n', stderr: '' }
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
    assert.ok(calls.some(spec => spec.args[0] === 'node'))
  } finally {
    globalThis.fetch = originalFetch
    await host.uninstall()
  }
}))
