import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMobileBootstrap } from '../src/index.js'

const roots = []
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

const manager = {
  install: async () => {},
  uninstall: async () => {},
  status: () => ({ healthy: true }),
}

const manifest = () => ({ schemaVersion: 1, version: '0.6.2', minMobileVersion: '0.14.0', plugins: {}, runtimes: [] })

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-linux-reactivate-'))
  roots.push(root)
  const directory = path.join(root, 'plugins', 'linux-runtime', 'bundle')
  await mkdir(directory, { recursive: true })
  const state = {
    schemaVersion: 1,
    autoUpdateEnabled: false,
    installedLinuxVersion: '0.6.2',
    installedSystemMobileVersion: '0.15.2',
    enabled: true,
    injectionActivated: true,
    runtimeId: 'debian-minimal',
    pluginDirectory: directory,
    pinnedManifest: manifest(),
    ...overrides,
  }
  await writeFile(path.join(root, 'linux-bootstrap-state.json'), `${JSON.stringify(state, null, 2)}\n`)
  return { root, directory }
}

const service = (root, pluginHost) => createMobileBootstrap({
  dataDir: root,
  pluginHost,
  manifestProvider: async () => manifest(),
  appVersionProvider: async () => '0.15.2',
  downloadAsset: async () => {},
  extractArchive: async () => {},
})

test('engine restart reactivates an installed runtime plugin instead of disabling it', async () => {
  const { root, directory } = await fixture()
  let active = false
  const calls = []
  const pluginHost = {
    install: async options => {
      calls.push(options)
      active = true
      return { directory: options.directory, active: true, manager, rollback: async () => {} }
    },
    isInjected: async () => ({ injected: true, active }),
    uninstall: async () => {},
  }
  const status = await service(root, pluginHost).status()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].enable, true)
  assert.equal(calls[0].entry, 'lib/index.js')
  assert.equal(calls[0].directory, directory)
  assert.equal(status.enabled, true)
  assert.equal(status.injectionActivated, true)
})

test('a failed reactivation records the reason and lets reconciliation disable the plugin', async () => {
  const { root } = await fixture()
  const pluginHost = {
    install: async () => { throw new Error('plugin bundle is corrupt') },
    isInjected: async () => ({ injected: true, active: false }),
    uninstall: async () => {},
  }
  const status = await service(root, pluginHost).status()
  assert.equal(status.enabled, false)
  const stored = JSON.parse(await readFile(path.join(root, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(stored.lastErrorCode, 'linux-runtime-reactivate-failed')
  assert.match(stored.lastError, /plugin bundle is corrupt/)
})

test('reactivation is skipped when the user never enabled the runtime', async () => {
  const { root } = await fixture({ enabled: false, injectionActivated: false })
  let installs = 0
  const pluginHost = {
    install: async () => { installs += 1; throw new Error('must not activate') },
    isInjected: async () => ({ injected: false, active: false }),
    uninstall: async () => {},
  }
  const status = await service(root, pluginHost).status()
  assert.equal(installs, 0)
  assert.equal(status.enabled, false)
})
