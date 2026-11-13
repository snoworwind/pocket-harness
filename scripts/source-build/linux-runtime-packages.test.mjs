// Real, disposable pnpm-style guest engine fixtures for the Linux native audit.
// The audit must reject host/Android bindings, source shadows and unreviewed families.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkLinuxRuntimePackages, checkEngineArtifacts } from './check-linux-runtime-packages.mjs'

function elf(machine) {
  const bytes = Buffer.alloc(20)
  bytes.write('\x7fELF', 0, 'latin1')
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(machine, 18)
  return bytes
}

const arm64 = () => elf(183)
const x64 = () => elf(62)

function put(root, path, data) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, data)
}

function link(root, path, target) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  symlinkSync(target, full)
}

const pnpm = 'node_modules/.pnpm'

function scaffold(root, abi = 'arm64') {
  const adapt = value => typeof value === 'string' && abi === 'x86_64' ? value.replaceAll('arm64', 'x64') : value
  const write = (root, path, data) => put(root, adapt(path), Buffer.isBuffer(data) && abi === 'x86_64' ? x64() : adapt(data))
  const symlink = (root, path, target) => link(root, adapt(path), adapt(target))
  write(root, `${pnpm}/koffi@3.2.1/node_modules/koffi/package.json`, JSON.stringify({
    name: 'koffi',
    version: '3.2.1',
    optionalDependencies: { '@koromix/koffi-linux-arm64': '3.2.1' },
  }))
  const binding = `${pnpm}/@koromix+koffi-linux-arm64@3.2.1/node_modules/@koromix/koffi-linux-arm64`
  write(root, `${binding}/package.json`, JSON.stringify({ name: '@koromix/koffi-linux-arm64', version: '3.2.1' }))
  write(root, `${binding}/index.js`, 'var BINARIES = { musl: "./musl_arm64/koffi.node", glibc: "./linux_arm64/koffi.node" };')
  write(root, `${binding}/linux_arm64/koffi.node`, arm64())
  write(root, `${binding}/musl_arm64/koffi.node`, arm64())
  symlink(root, `${pnpm}/koffi@3.2.1/node_modules/@koromix/koffi-linux-arm64`, '../../../@koromix+koffi-linux-arm64@3.2.1/node_modules/@koromix/koffi-linux-arm64')

  for (const name of ['dsh-subprocess-local', 'dsh-win32-process']) {
    const directory = `${pnpm}/@deepseek-ai+${name}@1/node_modules/@deepseek-ai/${name}`
    write(root, `${directory}/package.json`, JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '1.0.0',
      dependencies: { koffi: '3.2.1' },
    }))
    symlink(root, `${pnpm}/@deepseek-ai+${name}@1/node_modules/koffi`, '../../koffi@3.2.1/node_modules/koffi')
  }

  const pty = `${pnpm}/node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty`
  write(root, `${pty}/package.json`, JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }))
  write(root, `${pty}/prebuilds/linux-arm64/pty.node`, arm64())
  symlink(
    root,
    `${pnpm}/@deepseek-ai+dsh-subprocess-local@1/node_modules/node-pty`,
    '../../node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty',
  )

  const sharp = `${pnpm}/sharp@0.35.5/node_modules/sharp`
  write(root, `${sharp}/package.json`, JSON.stringify({ name: 'sharp', version: '0.35.5' }))
  write(root, `${sharp}/dist/sharp.mjs`, 'sharp = require("@img/sharp-linux-arm64/sharp.node");')
  const sharpBinding = `${pnpm}/@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64`
  write(root, `${sharpBinding}/package.json`, JSON.stringify({ name: '@img/sharp-linux-arm64', version: '0.35.5', exports: { './sharp.node': './index.cjs' } }))
  write(root, `${sharpBinding}/index.cjs`, "module.exports = require('./lib/sharp-linux-arm64-0.35.5.node');")
  write(root, `${sharpBinding}/lib/sharp-linux-arm64-0.35.5.node`, arm64())
  symlink(
    root,
    `${pnpm}/sharp@0.35.5/node_modules/@img/sharp-linux-arm64`,
    '../../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
  )
  const attachment = `${pnpm}/@deepseek-ai+dsh-attachment-local@1/node_modules/@deepseek-ai/dsh-attachment-local`
  write(root, `${attachment}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-attachment-local', version: '1.0.0' }))
  symlink(root, `${pnpm}/@deepseek-ai+dsh-attachment-local@1/node_modules/sharp`, '../../sharp@0.35.5/node_modules/sharp')

  for (const name of ['dsh-subprocess-local', 'dsh-win32-process', 'dsh-attachment-local']) {
    symlink(root, `node_modules/@deepseek-ai/${name}`, `../.pnpm/@deepseek-ai+${name}@1/node_modules/@deepseek-ai/${name}`)
  }
  const system = `${pnpm}/@deepseek-ai+node-addon-system@0.1.2/node_modules/@deepseek-ai/node-addon-system`
  write(root, `${system}/package.json`, JSON.stringify({name: '@deepseek-ai/node-addon-system', version: '0.1.2', exports: {'./flock': './lib/flock.js'}}))
  const systemBinding = `${pnpm}/@deepseek-ai+node-addon-system-linux-arm64@0.1.2/node_modules/@deepseek-ai/node-addon-system-linux-arm64`
  write(root, `${systemBinding}/package.json`, JSON.stringify({name: '@deepseek-ai/node-addon-system-linux-arm64', version: '0.1.2'}))
  write(root, `${systemBinding}/bin/glibc/system.node`, arm64())
  symlink(root, `${pnpm}/@deepseek-ai+node-addon-system@0.1.2/node_modules/@deepseek-ai/node-addon-system-linux-arm64`, '../../../@deepseek-ai+node-addon-system-linux-arm64@0.1.2/node_modules/@deepseek-ai/node-addon-system-linux-arm64')
}

function withFixture(fn, abi = 'arm64') {
  const root = mkdtempSync(join(tmpdir(), 'linux-runtime-packages-'))
  try {
    scaffold(root, abi)
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('audit resolves both koffi consumers, the sharp loader and node-pty to AArch64 ELF', () => withFixture((root) => {
  const report = checkLinuxRuntimePackages(root, undefined, 'arm64')
  assert.equal(report.target, 'linux-arm64-glibc')
  assert.deepEqual(report.koffi.map((item) => item.consumer), [
    '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-win32-process',
  ])
  assert.match(report.koffi[0].path, /@koromix\+koffi-linux-arm64@3\.2\.1\/.*linux_arm64\/koffi\.node$/)
  assert.match(report.sharp.path, /@img\+sharp-linux-arm64@0\.35\.5\/.*lib\/sharp-linux-arm64-0\.35\.5\.node$/)
  assert.match(report.nodePty.path, /prebuilds\/linux-arm64\/pty\.node$/)
  assert.ok(report.inventory.length >= 4)
}))

test('audit rejects a host x64 koffi binding', () => withFixture((root) => {
  put(root, `${pnpm}/@koromix+koffi-linux-arm64@3.2.1/node_modules/@koromix/koffi-linux-arm64/linux_arm64/koffi.node`, x64())
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /AArch64 ELF/)
}))

for (const abi of ['arm64', 'x86_64']) {
  test(`audit rejects a missing wrapper sibling even with a valid top-level addon: ${abi}`, () => withFixture(root => {
    const platform = abi === 'arm64' ? 'arm64' : 'x64'
    const name = `@deepseek-ai/node-addon-system-linux-${platform}`
    put(root, `node_modules/${name}/package.json`, JSON.stringify({name, version: '0.1.2'}))
    put(root, `node_modules/${name}/bin/glibc/system.node`, abi === 'arm64' ? arm64() : x64())
    const module = `${pnpm}/@deepseek-ai+node-addon-system-linux-${platform}@0.1.2/node_modules/${name}/bin/glibc/system.node`
    rmSync(join(root, module))
    assert.throws(() => checkLinuxRuntimePackages(root, undefined, abi), /wrapper resolves a missing glibc addon/)
  }, abi))
}

test('audit rejects an Android koffi binding and any unreviewed native family', () => withFixture((root) => {
  const android = `${pnpm}/@koromix+koffi-android-arm64@3.2.1/node_modules/@koromix/koffi-android-arm64`
  put(root, `${android}/package.json`, JSON.stringify({ name: '@koromix/koffi-android-arm64', version: '3.2.1' }))
  put(root, `${android}/android_arm64/koffi.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /Android koffi binding/)
  rmSync(join(root, pnpm, '@koromix+koffi-android-arm64@3.2.1'), { recursive: true, force: true })
  put(root, `${pnpm}/evil@1/node_modules/evil/evil.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /unreviewed guest native payload/)
}))

test('audit rejects a node-pty source shadow and a hijacked sharp loader', () => withFixture((root) => {
  put(root, `${pnpm}/node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty/build/Release/pty.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /shadow binding/)
  rmSync(join(root, pnpm, 'node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty/build'), { recursive: true, force: true })
  put(
    root,
    `${pnpm}/@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/index.cjs`,
    "module.exports = require('./lib/not-the-binding.node');",
  )
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /missing module|sharp binding loader/)
}))

test('audit fails closed when a koffi consumer loses its binding', () => withFixture((root) => {
  rmSync(join(root, pnpm, '@deepseek-ai+dsh-win32-process@1/node_modules/koffi'))
  assert.throws(() => checkLinuxRuntimePackages(root, undefined, 'arm64'), /koffi is missing/)
}))

test('engine metadata gate rejects maps, tests and test directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'guest-metadata-'))
  try {
    put(root, 'lib/runtime.js', 'export {}')
    checkEngineArtifacts(root)
    for (const path of ['lib/runtime.js.map', 'lib/runtime.test.js', '__tests__/fixture.json']) {
      put(root, path, '{}')
      assert.throws(() => checkEngineArtifacts(root), /development metadata/)
      rmSync(join(root, path))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('engine artifact gate reads ELF headers even when filenames have no platform token', () => {
  const root = mkdtempSync(join(tmpdir(), 'guest-elf-'))
  try {
    for (const abi of ['arm64', 'x86_64']) {
      put(root, 'bin/tool', abi === 'arm64' ? arm64() : x64())
      checkEngineArtifacts(root, abi)
      put(root, 'lib/foreign.so', abi === 'arm64' ? x64() : arm64())
      assert.throws(() => checkEngineArtifacts(root, abi), /guest native module must be/)
      rmSync(join(root, 'lib/foreign.so'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('x86 audit resolves both koffi consumers, sharp and node-pty to x64 ELF', () => withFixture(root => {
  const report = checkLinuxRuntimePackages(root, undefined, 'x86_64')
  assert.equal(report.target, 'linux-x64-glibc')
  assert.equal(report.koffi.length, 2)
  assert.match(report.sharp.path, /sharp-linux-x64/)
  assert.match(report.nodePty.path, /prebuilds\/linux-x64/)
  checkEngineArtifacts(root, 'x86_64')
}, 'x86_64'))
