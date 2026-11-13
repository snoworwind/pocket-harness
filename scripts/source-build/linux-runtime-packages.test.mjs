// Real, disposable pnpm-style guest engine fixtures for the Linux native audit.
// The audit must reject host/Android bindings, source shadows and unreviewed families.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkLinuxRuntimePackages } from './check-linux-runtime-packages.mjs'

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

function scaffold(root) {
  put(root, `${pnpm}/koffi@3.2.1/node_modules/koffi/package.json`, JSON.stringify({
    name: 'koffi',
    version: '3.2.1',
    optionalDependencies: { '@koromix/koffi-linux-arm64': '3.2.1' },
  }))
  const binding = `${pnpm}/@koromix+koffi-linux-arm64@3.2.1/node_modules/@koromix/koffi-linux-arm64`
  put(root, `${binding}/package.json`, JSON.stringify({ name: '@koromix/koffi-linux-arm64', version: '3.2.1' }))
  put(root, `${binding}/index.js`, 'var BINARIES = { musl: "./musl_arm64/koffi.node", glibc: "./linux_arm64/koffi.node" };')
  put(root, `${binding}/linux_arm64/koffi.node`, arm64())
  put(root, `${binding}/musl_arm64/koffi.node`, arm64())
  link(root, `${pnpm}/koffi@3.2.1/node_modules/@koromix/koffi-linux-arm64`, '../../../@koromix+koffi-linux-arm64@3.2.1/node_modules/@koromix/koffi-linux-arm64')

  for (const name of ['dsh-subprocess-local', 'dsh-win32-process']) {
    const directory = `${pnpm}/@deepseek-ai+${name}@1/node_modules/@deepseek-ai/${name}`
    put(root, `${directory}/package.json`, JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '1.0.0',
      dependencies: { koffi: '3.2.1' },
    }))
    link(root, `${pnpm}/@deepseek-ai+${name}@1/node_modules/koffi`, '../../koffi@3.2.1/node_modules/koffi')
  }

  const pty = `${pnpm}/node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty`
  put(root, `${pty}/package.json`, JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }))
  put(root, `${pty}/prebuilds/linux-arm64/pty.node`, arm64())
  link(
    root,
    `${pnpm}/@deepseek-ai+dsh-subprocess-local@1/node_modules/node-pty`,
    '../../node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty',
  )

  const sharp = `${pnpm}/sharp@0.35.5/node_modules/sharp`
  put(root, `${sharp}/package.json`, JSON.stringify({ name: 'sharp', version: '0.35.5' }))
  put(root, `${sharp}/dist/sharp.mjs`, 'sharp = require("@img/sharp-linux-arm64/sharp.node");')
  const sharpBinding = `${pnpm}/@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64`
  put(root, `${sharpBinding}/package.json`, JSON.stringify({ name: '@img/sharp-linux-arm64', version: '0.35.5', exports: { './sharp.node': './index.cjs' } }))
  put(root, `${sharpBinding}/index.cjs`, "module.exports = require('./lib/sharp-linux-arm64-0.35.5.node');")
  put(root, `${sharpBinding}/lib/sharp-linux-arm64-0.35.5.node`, arm64())
  link(
    root,
    `${pnpm}/sharp@0.35.5/node_modules/@img/sharp-linux-arm64`,
    '../../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
  )
  const attachment = `${pnpm}/@deepseek-ai+dsh-attachment-local@1/node_modules/@deepseek-ai/dsh-attachment-local`
  put(root, `${attachment}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-attachment-local', version: '1.0.0' }))
  link(root, `${pnpm}/@deepseek-ai+dsh-attachment-local@1/node_modules/sharp`, '../../sharp@0.35.5/node_modules/sharp')

  for (const name of ['dsh-subprocess-local', 'dsh-win32-process', 'dsh-attachment-local']) {
    link(root, `node_modules/@deepseek-ai/${name}`, `../.pnpm/@deepseek-ai+${name}@1/node_modules/@deepseek-ai/${name}`)
  }
}

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'linux-runtime-packages-'))
  try {
    scaffold(root)
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('audit resolves both koffi consumers, the sharp loader and node-pty to AArch64 ELF', () => withFixture((root) => {
  const report = checkLinuxRuntimePackages(root)
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
  assert.throws(() => checkLinuxRuntimePackages(root), /AArch64 ELF/)
}))

test('audit rejects an Android koffi binding and any unreviewed native family', () => withFixture((root) => {
  const android = `${pnpm}/@koromix+koffi-android-arm64@3.2.1/node_modules/@koromix/koffi-android-arm64`
  put(root, `${android}/package.json`, JSON.stringify({ name: '@koromix/koffi-android-arm64', version: '3.2.1' }))
  put(root, `${android}/android_arm64/koffi.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root), /Android koffi binding/)
  rmSync(join(root, pnpm, '@koromix+koffi-android-arm64@3.2.1'), { recursive: true, force: true })
  put(root, `${pnpm}/evil@1/node_modules/evil/evil.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root), /unreviewed guest native payload/)
}))

test('audit rejects a node-pty source shadow and a hijacked sharp loader', () => withFixture((root) => {
  put(root, `${pnpm}/node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty/build/Release/pty.node`, arm64())
  assert.throws(() => checkLinuxRuntimePackages(root), /shadow binding/)
  rmSync(join(root, pnpm, 'node-pty@1.2.0-beta.15_patch_hash=fixture/node_modules/node-pty/build'), { recursive: true, force: true })
  put(
    root,
    `${pnpm}/@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/index.cjs`,
    "module.exports = require('./lib/not-the-binding.node');",
  )
  assert.throws(() => checkLinuxRuntimePackages(root), /missing module|sharp binding loader/)
}))

test('audit fails closed when a koffi consumer loses its binding', () => withFixture((root) => {
  rmSync(join(root, pnpm, '@deepseek-ai+dsh-win32-process@1/node_modules/koffi'))
  assert.throws(() => checkLinuxRuntimePackages(root), /koffi is missing/)
}))
