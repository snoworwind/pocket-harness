// Compare the previous committed production implementation against the fixed implementation.
// Default to the vulnerable baseline; an explicit commit can be supplied as argv[2].
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fetchLatestManifest } from '../src/github.js'

const baseline = process.argv[2] ?? '185740dcc5a4d3e3c55e3080a80ee0c52f176b8f'
const modulePath = new URL('../src/manifest.js', import.meta.url).href
const source = execFileSync('git', ['show', `${baseline}:plugins/dsh-linux-bootstrap/src/github.js`], { encoding: 'utf8' })
  .replace("'./manifest.js'", JSON.stringify(modulePath))
const old = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const url = 'https://github.com/acme/runtime/releases/latest'
const manifest = { version: '1.0.0' }
const release = JSON.stringify({
  tag_name: 'v1',
  assets: [{ name: 'linux-release.json', browser_download_url: 'https://github.com/acme/runtime/releases/download/v1/linux-release.json' }],
  padding: 'x'.repeat(3 * 1024 * 1024),
})
function fixture() {
  let calls = 0
  return async () => ++calls === 1 ? new Response(release) : new Response(JSON.stringify(manifest))
}
assert.deepEqual(await old.fetchLatestManifest(url, fixture()), { manifest, releaseTag: 'v1' })
console.log(`OLD accepted oversized release: ${Buffer.byteLength(release)} bytes`)
await assert.rejects(fetchLatestManifest(url, fixture()), /byte limit/)
console.log('FIXED rejected the identical release at the decoded byte limit')
