import test from 'node:test'
import assert from 'node:assert/strict'
import { guestSelfCheck, resolveGuestCommand } from '../lib/guest-self-check.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('PATH resolution prefers managed Node and keeps user commands reachable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'linux-path-')))
  try {
    for (const dir of ['managed', 'user', 'apt']) mkdirSync(join(root, dir))
    for (const dir of ['managed', 'apt']) writeFileSync(join(root, dir, 'node'), 'fixture')
    writeFileSync(join(root, 'user', 'black'), 'fixture')
    const environment = { PATH: ['managed', 'user', 'apt'].map(name => join(root, name)).join(':') }
    assert.equal(resolveGuestCommand('node', environment), join(root, 'managed/node'))
    assert.equal(resolveGuestCommand('black', environment), join(root, 'user/black'))
    assert.equal(resolveGuestCommand('missing', environment), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('self-check distinguishes engine and PATH executables, two ripgreps, and loader isolation', async () => {
  const environment = { PATH: '/opt/node/bin:/root/.local/bin:/usr/bin', npm_config_prefix: '/root/.local', PYTHON: '/usr/bin/python3', CC: '/usr/bin/gcc', CXX: '/usr/bin/g++' }
  const resolve = name => `/fixture/${name}`
  const run = async file => file.endsWith('/node') ? 'v24.22.0' : file.endsWith('/pnpm') ? '11.28.5' : `version for ${file}`
  const options = { environment, resolve, run, engineNode: { version: 'v24.22.0', path: '/opt/node/bin/node', openssl: 'fixture' }, engineRg: '/opt/dsh/rg' }
  const check = await guestSelfCheck(options)
  assert.equal(check.ok, true)
  assert.equal(check.npmGlobalPrefix, '/root/.local')
  assert.equal(check.engineRipgrep.path, '/opt/dsh/rg')
  assert.equal(check.pathRipgrep.path, '/fixture/rg')
  assert.equal(check.buildTools.python, '/usr/bin/python3')
  assert.equal((await guestSelfCheck({ ...options, environment: { ...environment, LD_LIBRARY_PATH: '/apk/bionic-libs' } })).ok, false)
  assert.equal((await guestSelfCheck({ ...options, run: async () => 'different-node-version' })).ok, false)
})
