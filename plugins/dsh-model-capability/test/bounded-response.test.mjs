import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedResponseText } from '../lib/bounded-response.js'
import { spawnSync } from 'node:child_process'

test('decoded chunked response is stopped at byte budget and reader is cancelled', async () => {
  let cancelled = false
  let produced = 0
  const stream = new ReadableStream({
    pull(c) { produced++; c.enqueue(new Uint8Array(1024)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(boundedResponseText(new Response(stream), 2048), /byte limit/)
  assert.equal(cancelled, true)
  assert.ok(produced <= 5, 'must not drain an unlimited peer')
})

test('UTF-8 bytes, rather than string length, consume the budget', async () => {
  await assert.rejects(boundedResponseText(new Response('中文'), 5), /byte limit/)
  assert.equal(await boundedResponseText(new Response('中文'), 6), '中文')
})

test('declared oversize body is cancelled before reading', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-length': '10000' } })
  await assert.rejects(boundedResponseText(response, 100), /byte limit/)
  assert.equal(cancelled, true)
})

test('deadline aborts a stalled response body', async () => {
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ start(c) {
    controller.signal.addEventListener('abort', () => c.error(new Error('deadline')), { once: true })
  } }))
  const result = boundedResponseText(response)
  controller.abort()
  await assert.rejects(result, /deadline/)
})

test('tiny chunks cannot amplify a small response into an unbounded retained heap', () => {
  const count = 400_000
  const run = code => spawnSync(process.execPath, ['--max-old-space-size=32', '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  })
  // Controlled negative: this heap budget really rejects retaining one allocation per byte.
  const negative = run(`const held=[];for(let i=0;i<${count};i++)held.push(new Uint8Array([97]));console.log(held.length)`)
  assert.notEqual(negative.status, 0)
  assert.match(negative.stderr, /heap|allocation|memory/i)
  const module = new URL('../lib/bounded-response.js', import.meta.url).href
  const positive = run(`
    import { boundedResponseText } from ${JSON.stringify(module)};
    let sent=0;
    const body=new ReadableStream({pull(c){if(sent++<${count})c.enqueue(new Uint8Array([97]));else c.close()}});
    const text=await boundedResponseText({body,text:async()=>{throw Error('must stream')}},${count});
    if(text.length!==${count}||text[0]!=='a')process.exit(2);
  `)
  assert.equal(positive.status, 0, positive.error?.message ?? positive.stderr.slice(-500))
})
