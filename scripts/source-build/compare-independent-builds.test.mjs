import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareApks, inspectApk } from './compare-independent-builds.mjs'

const linux = { skip: process.platform !== 'linux' }
const make = String.raw`
import io,sys,json,tarfile,zipfile,hashlib
options=json.loads(sys.argv[2]); data=io.BytesIO()
with tarfile.open(fileobj=data,mode='w:xz') as archive:
  for name,body in options.get('files',{'usr/bin/tool':'safe'}).items():
    value=body.encode(); member=tarfile.TarInfo(name); member.size=len(value)
    member.mode=options.get('mode',0o644); member.mtime=options.get('time',1)
    archive.addfile(member,io.BytesIO(value))
payload=data.getvalue(); digest=hashlib.sha256(payload).hexdigest()
with zipfile.ZipFile(sys.argv[1],'w') as apk:
  apk.writestr('assets/snapshot.tar.xz',payload)
  apk.writestr('assets/snapshot.sha256',options.get('fingerprint',digest))
  apk.writestr('assets/plugin-hard-manifest.json',json.dumps({'schema':2,'complete':True,'fingerprint':digest,'entries':[]}))
  apk.writestr('classes.dex',options.get('dex','same dex'))
  apk.writestr('AndroidManifest.xml','same manifest')
  apk.writestr('META-INF/CERT.SF',str(options.get('time',1)))
  apk.writestr('META-INF/services/worker',options.get('service','same service'))
`

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-compare-'))
  const apk = (name, options = {}) => {
    const file = join(root, name + '.apk')
    execFileSync('python3', ['-c', make, file, JSON.stringify(options)])
    return file
  }
  try { fn({ apk, root }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('independent reader compares APK payload and snapshot semantics, ignoring only signatures and tar times', linux, () => fixture(({ apk }) => {
  assert.equal(compareApks(apk('first'), apk('second', { time: 99 })).independentRebuildMatched, true)
}))

test('changed runtime JS, mode, dex and META-INF services all block signing', linux, () => fixture(({ apk }) => {
  const original = apk('original')
  for (const [name, options] of Object.entries({ js: { files: { 'usr/bin/tool': 'evil' } }, mode: { mode: 0o755 }, dex: { dex: 'evil' }, service: { service: 'evil' } })) {
    assert.throws(() => compareApks(original, apk(name, options)), /independent .* differs/)
  }
}))

test('package metadata key order may normalize but conditional export order cannot', linux, () => fixture(({ apk }) => {
  const first = apk('first', { files: { 'usr/pkg/package.json': '{"name":"pkg","version":"1","exports":{"import":"./a.js","default":"./b.js"}}' } })
  const reordered = apk('reordered', { files: { 'usr/pkg/package.json': '{"version":"1","name":"pkg","exports":{"import":"./a.js","default":"./b.js"}}' } })
  assert.equal(compareApks(first, reordered).independentRebuildMatched, true)
  const different = apk('different', { files: { 'usr/pkg/package.json': '{"name":"pkg","version":"1","exports":{"default":"./b.js","import":"./a.js"}}' } })
  assert.throws(() => compareApks(first, different), /runtime payload differs/)
}))

test('malformed fingerprints and traversal archives fail without extracting files', linux, () => fixture(({ apk, root }) => {
  assert.throws(() => inspectApk(apk('bad-fingerprint', { fingerprint: '0'.repeat(64) })), /Command failed/)
  assert.throws(() => inspectApk(apk('traversal', { files: { '../escape': 'evil' } })), /Command failed/)
  assert.equal(existsSync(join(root, 'escape')), false)
}))
