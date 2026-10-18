import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync as read, writeFileSync as write } from 'node:fs'
import { verifyPinnedNpm } from '../lib/pinned-npm.mjs'
import { verifyPackagePayload } from './verify-package-payload.mjs'
import { patchInstallApproval } from '../patches/data/market-install-approval.mjs'

test('pinned npm rejects same-size poisoned cache and missing source pin', () => {
  const bytes = Buffer.from('trusted')
  const pins = { 'pkg@1': 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
  verifyPinnedNpm(bytes, 'pkg', '1', pins)
  assert.throws(() => verifyPinnedNpm(Buffer.from('poison!'), 'pkg', '1', pins), /integrity mismatch/)
  assert.throws(() => verifyPinnedNpm(bytes, 'pkg', '2', pins), /Missing/)
})

test('the production deb cache condition rejects equal-size poisoned bytes', () => {
  const src = read(new URL('../build-snapshot-013.mjs', import.meta.url), 'utf8')
  const start = src.indexOf('  if (existsSync(file) && statSync(file).size === p.size')
  const end = src.indexOf(') { ok++; continue }', start)
  assert.ok(start > 0 && end > start)
  const accept = new Function('existsSync', 'statSync', 'createHash', 'readFileSync', 'p', 'file',
    'return ' + src.slice(start + '  if ('.length, end))
  const root = mkdtempSync(join(tmpdir(), 'dsh-r2-deb-'))
  try {
    const file = join(root, 'pkg.deb'), bytes = Buffer.from('trusted')
    const pkg = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    write(file, bytes)
    assert.equal(accept(existsSync, statSync, createHash, read, pkg, file), true)
    write(file, 'poison!')
    assert.equal(statSync(file).size === pkg.size, true, 'old size-only condition admits this negative control')
    assert.equal(accept(existsSync, statSync, createHash, read, pkg, file), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('payload comparison rejects changed JS, extra JS and changed exports despite same name/version', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-r2-payload-'))
  const a = join(root, 'a'), b = join(root, 'b')
  try {
    for (const dir of [a, b]) {
      mkdirSync(dir)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1', main: 'index.js' }))
      writeFileSync(join(dir, 'index.js'), 'export const safe = true')
    }
    assert.equal(verifyPackagePayload(a, b, 'pkg'), 2)
    writeFileSync(join(b, 'index.js'), 'export const safe = false')
    assert.throws(() => verifyPackagePayload(a, b, 'pkg'), /payload bytes/)
    writeFileSync(join(b, 'index.js'), readFileSync(join(a, 'index.js')))
    writeFileSync(join(b, 'injected.js'), 'run()')
    assert.throws(() => verifyPackagePayload(a, b, 'pkg'), /file set/)
    rmSync(join(b, 'injected.js'))
    writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'pkg', version: '1', main: 'other.js' }))
    assert.throws(() => verifyPackagePayload(a, b, 'pkg'), /payload bytes/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installation asks even without risk flags; catalogue failures never delegate to allow', async () => {
  const original = readFileSync(new URL('../../vendor/dshmarketplace-plugin/lib/index.js', import.meta.url), 'utf8')
  assert.equal(patchInstallApproval(original), original, 'registered repair must be idempotent')
  const start = original.indexOf('async function M('), end = original.indexOf('var H=', start)
  const factory = new Function('g', 'c', original.slice(start, end) + ';return b')(() => '', () => {})
  const request = { name: 'dshmarketplace_install', arguments: { fullName: 'owner/pkg' } }
  const next = () => ({ kind: 'allow' })
  const entry = { name: 'pkg', fullName: 'owner/pkg', riskFlags: [] }
  assert.equal((await factory(async () => ({ results: [entry] }))(request, next)).kind, 'ask')
  assert.equal((await factory(async () => { throw new Error('offline') })(request, next)).kind, 'deny')
  assert.equal((await factory(async () => ({ results: [] }))(request, next)).kind, 'deny')
  assert.equal((await factory(async () => ({}))({ name: 'other' }, next)).kind, 'allow')
})

test('public status handler completes without scheduling privileged probes', async () => {
  const src = read(new URL('../../plugins/dsh-android-bridge/src/index.ts', import.meta.url), 'utf8')
  const start = src.indexOf("path: '/api/android/privilege/status'")
  const bodyStart = src.indexOf('=> {', start) + 4
  const end = src.indexOf('\n      },', bodyStart)
  assert.ok(start > 0 && bodyStart > start && end > bodyStart)
  let probed = 0, sent = 0
  const svc = { shizukuChannelProbed: async () => { probed++ } }
  const handler = new Function('authorizePublicReadOnlyRoute', 'sendMobileRouteRejection', 'sendJson',
    'buildPrivilegeStatusPayload', 'svc', 'controlToken', 'publicRouteConnection',
    'return async(req,res)=>{' + src.slice(bodyStart, end) + '}')(
      () => undefined, () => { throw Error('unexpected rejection') }, () => { sent++ }, () => ({}), svc, () => undefined, undefined,
    )
  await Promise.all(Array.from({ length: 64 }, () => handler({}, {})))
  assert.equal(sent, 64)
  assert.equal(probed, 0)
})

test('keyboard nonce cannot introduce privileged shell syntax', () => {
  const src = read(new URL('../../plugins/dsh-android-manage/src/index.ts', import.meta.url), 'utf8')
  const start = src.indexOf('function adbKeyboardAuthArg(): string {')
  const end = src.indexOf('\n}', start) + 2
  const fn = src.slice(start, end).replace('(): string', '()')
  const root = mkdtempSync(join(tmpdir(), 'dsh-r2-nonce-'))
  try {
    const env = { env: { DSH_FILES_DIR: root } }
    const nonce = new Function('process', 'readFileSync', 'join', fn + ';return adbKeyboardAuthArg')(env, read, join)
    for (const unsafe of ["a'; id; #", '$(id)', 'aa\n--es msg bad', 'f'.repeat(65)]) {
      write(join(root, 'adb-keyboard-nonce'), unsafe)
      assert.equal(nonce(), '')
    }
    write(join(root, 'adb-keyboard-nonce'), 'a'.repeat(63))
    assert.equal(nonce(), " --es auth '" + 'a'.repeat(63) + "'")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
