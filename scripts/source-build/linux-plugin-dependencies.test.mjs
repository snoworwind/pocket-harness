import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const overlay = read('../snapshot-config/engine-overlay.json')
const lock = read('../../plugins/dsh-android-linux-env/package-lock.json')
function closure(pins, name, seen = new Set()) {
  if (seen.has(name)) return
  seen.add(name)
  const pkg = lock.packages[`node_modules/${name}`]
  assert.equal(pins[name], pkg.version, `snapshot missing pinned dependency: ${name}`)
  for (const child of Object.keys(pkg.dependencies ?? {})) closure(pins, child, seen)
}
test('Linux archive imports have their complete pinned snapshot dependency closure', () => {
  for (const name of ['xz-decompress', 'tar-stream']) closure(overlay.vendorTop, name)
  const missing = { ...overlay.vendorTop }
  delete missing['streamx']
  assert.throws(() => closure(missing, 'tar-stream'), /snapshot missing pinned dependency: streamx/)
})
