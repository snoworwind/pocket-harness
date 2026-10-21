import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readSnapshotRouteFiles, snapshotRouteVerdicts } from './lib/snapshot-route-auth.mjs'

const markers = [['active-a/lib/index.js', 'AUTH_A'], ['active-b/lib/index.js', 'AUTH_B']]
const prefix = 'home/.dsh/profiles/web/node_modules/'
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const accepted = (files) => snapshotRouteVerdicts(files, markers, ['web']).every((verdict) => verdict.ok)

test('each shipped member must contain its own authorization marker', () => {
  assert.equal(accepted({
    [prefix + markers[0][0]]: 'AUTH_A',
    [prefix + markers[1][0]]: 'AUTH_B',
  }), true)

  // Controlled negative: the other archive member contains the missing marker.
  assert.equal(accepted({
    [prefix + markers[0][0]]: 'AUTH_A AUTH_B',
    [prefix + markers[1][0]]: 'unguarded',
  }), false)
})

test('archive reader keeps member contents separate and returns missing members as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-auth-artifact-'))
  const archive = join(dir, 'fixture.tar.xz')
  const makeArchive = (entries) => {
    const code = `import io,json,sys,tarfile
with tarfile.open(sys.argv[1], 'w:xz') as out:
 for name,text,kind in json.loads(sys.argv[2]):
  item=tarfile.TarInfo(name); payload=text.encode(); item.size=len(payload)
  if kind=='link': item.type=tarfile.SYMTYPE; item.linkname='other'; item.size=0
  out.addfile(item, io.BytesIO(payload) if kind!='link' else None)`
    const result = spawnSync(python, ['-c', code, archive, JSON.stringify(entries)], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    makeArchive([['wanted', 'OWN', 'file'], ['other', 'OTHER', 'file']])
    assert.deepEqual(readSnapshotRouteFiles(archive, ['wanted', 'absent']), { wanted: 'OWN', absent: null })

    makeArchive([['wanted', 'A', 'file'], ['wanted', 'B', 'file']])
    assert.throws(() => readSnapshotRouteFiles(archive, ['wanted']), /duplicate route member/)

    makeArchive([['wanted', '', 'link']])
    assert.throws(() => readSnapshotRouteFiles(archive, ['wanted']), /invalid route member/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
