import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { fetchLatestManifest } from '../src/github.js'

const url = 'https://github.com/acme/runtime/releases/latest'
const manifestUrl = 'https://github.com/acme/runtime/releases/download/v1/linux-release.json'
const release = metadata => ({ tag_name: 'v1', assets: [{ name: 'linux-release.json', browser_download_url: manifestUrl, ...metadata }] })
const json = value => new Response(JSON.stringify(value))

test('valid release and manifest retain metadata digest checks', async () => {
  const manifest = { version: '1.0.0' }
  const bytes = JSON.stringify(manifest)
  let calls = 0
  const result = await fetchLatestManifest(url, async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    return ++calls === 1 ? json(release({ size: Buffer.byteLength(bytes), digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })) : new Response(bytes)
  })
  assert.deepEqual(result, { manifest, releaseTag: 'v1' })
})

for (const headers of [{}, { 'content-length': '1' }]) {
  test('release stream stops at decoded byte limit, headers=' + JSON.stringify(headers), async () => {
    let pulls = 0, cancelled = false
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)) },
      cancel() { cancelled = true },
    })
    await assert.rejects(fetchLatestManifest(url, async () => new Response(body, { headers })), /byte limit/)
    assert.ok(pulls <= 35, 'must stop reading instead of buffering the complete response')
    assert.equal(cancelled, true)
  })
}

test('oversized manifest metadata rejects before downloading it', async () => {
  let calls = 0
  await assert.rejects(fetchLatestManifest(url, async () => { calls++; return json(release({ size: 256 * 1024 + 1 })) }), /metadata exceeds/)
  assert.equal(calls, 1)
})

test('manifest stream is bounded even without size metadata', async () => {
  let calls = 0, cancelled = false
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)) }, cancel() { cancelled = true } })
  await assert.rejects(fetchLatestManifest(url, async () => ++calls === 1 ? json(release({})) : new Response(body)), /byte limit/)
  assert.equal(cancelled, true)
})

test('declared oversized body is rejected before consumption', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(fetchLatestManifest(url, async () => new Response(body, { headers: { 'content-length': String(3 * 1024 * 1024) } })), /byte limit/)
  assert.equal(cancelled, true)
})

test('rejected HTTP status cancels the body and aborts the request', async () => {
  let cancelled = false, signal
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(fetchLatestManifest(url, async (_url, options) => {
    signal = options.signal
    return new Response(body, { status: 503 })
  }), /GitHub request failed/)
  assert.equal(cancelled, true)
  assert.equal(signal.aborted, true)
})

test('deadline bounds stalled headers and aborts the request', async () => {
  let signal
  await assert.rejects(fetchLatestManifest(url, async (_url, options) => { signal = options.signal; return new Promise(() => {}) }, { timeoutMs: 20 }), /deadline/)
  assert.equal(signal.aborted, true)
})

test('deadline bounds stalled body and cancels the stream', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(fetchLatestManifest(url, async () => new Response(body), { timeoutMs: 20 }), /deadline/)
  assert.equal(cancelled, true)
})

test('real HTTP streaming response is cancelled before unbounded buffering', async () => {
  let closed = false, sent = 0
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const timer = setInterval(() => { sent += 64 * 1024; res.write(Buffer.alloc(64 * 1024)) }, 2)
    res.on('close', () => { closed = true; clearInterval(timer) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const local = `http://127.0.0.1:${server.address().port}`
    // Preserve the production HTTPS request identity while transporting fixture bytes locally.
    await assert.rejects(fetchLatestManifest(url, async (_url, options) => {
      const response = await fetch(local, options)
      return new Response(response.body, { headers: response.headers })
    }), /byte limit/)
    for (let n = 0; n < 30 && !closed; n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(closed, true)
    assert.ok(sent < 4 * 1024 * 1024)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
