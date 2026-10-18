// FX-205.1-.7 / ST-07 回归（可离线跑：无设备、无引擎、无网络）：
//  - five exact routes are plugin-authenticated before queue reads, ticket lookup, stream, or mutation;
//  - external delivery creates a blank durable session and an opaque browser draft ticket, never an @path message;
//  - GET /clean → 405 and POST /clean only removes tool-owned temporary files;
//  - route registrations are effects: unload removes every handler and reload has no duplicates.
//
// 令牌来源走 ST-07 的显式测试开关（DSH_CONTROL_TOKEN_TEST=1 + DSH_CONTROL_TOKEN），
// 因此本文件同时验证「测试开关下 env 生效」这条路径。
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { once } from 'node:events'

const TOKEN = 'test-token-0123456789'
process.env.DSH_CONTROL_TOKEN_TEST = '1'
process.env.DSH_CONTROL_TOKEN = TOKEN
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-boot-'))

const { apply } = await import('../lib/index.js')
const { TRUSTED_HOSTS, CONTROL_TOKEN_HEADER, authorizeIncomingRoute } = await import('../lib/route-auth.js')

const ROUTES = {
  list: '/api/android/file-incoming',
  claim: '/api/android/file-incoming/claim',
  content: '/api/android/file-incoming/content',
  complete: '/api/android/file-incoming/complete',
  clean: '/api/android/file-incoming/clean',
}
const HOST = TRUSTED_HOSTS[0]

/** 每个用例一个独立 HOME：tmpWorkspace() 每次调用实时读 DSH_HOME。 */
function freshWorkspace() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  return ws
}

/** 工作区快照（相对路径 + 大小）：用于「零变化」断言。 */
function snapshot(dir) {
  const out = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix + name.name
      if (name.isDirectory()) {
        out.push(rel + '/')
        walk(join(d, name.name), rel + '/')
      } else {
        out.push(rel + ':' + String(readFileSync(join(d, name.name)).length))
      }
    }
  }
  walk(dir, '')
  return out.sort()
}

function makeCtx(connection, extras = {}) {
  const routes = new Map()
  const disposers = []
  const registerCalls = []
  const calls = { sessionCreate: [], workspaceCreate: [], workspaceDelete: [] }
  const workspaces = extras.workspaces ?? []
  let seq = 0
  const sessions = extras.sessions ?? {
    create() { seq += 1; return { id: 'session-' + '0'.repeat(8) + '-stub' + seq } },
  }
  const workspaceRegistry = extras.workspaceRegistry ?? {
    async create(path, title) {
      calls.workspaceCreate.push(path)
      const ws = { id: 'ws-' + (workspaces.length + 1), path, title, sessionIds: [] }
      workspaces.push(ws)
      return ws
    },
    list: () => workspaces,
    async delete(id) {
      calls.workspaceDelete.push(id)
      const i = workspaces.findIndex((w) => w.id === id)
      if (i >= 0) workspaces.splice(i, 1)
      return i >= 0
    },
  }
  const sessionController = extras.sessionController === undefined
    ? undefined
    : {
      async create(request) { calls.sessionCreate.push(request); return extras.sessionController.create(request) },
    }
  // cordis 服务面：属性（inject 声明）与 ctx.get 读的是同一批服务。
  const services = { connection, sessionController, sessions, workspaceRegistry }
  const target = {
    logger: () => ({ warn() {}, info() {} }),
    tools: { register() {} },
    sessions,
    workspaceRegistry,
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return d },
    on() {},
    /** cordis ctx.get：无 inject 要求，服务缺失返回 undefined。 */
    get(name) { return services[name] },
    webServer: {
      register(route) {
        registerCalls.push(route.path)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  }
  target.routes = routes
  // cordis ReflectService.handler.get 的保真替身：**未声明 inject 的属性访问直接抛**
  // 「cannot get property "<name>" without inject」。0.14.0-preview-SN-1-13 设备实测：
  // Reflect.get(ctx, 'connection') 抛出的异常被上游 webserver 的兜底 catch 成 400
  // （dsh/packages/host/webserver/src/index.ts:244-251），受保护队列路由会整组 400。
  // 该替身让这一缺陷类在离线单测里必红（服务只能经 ctx.get 读取）。
  const ctx = new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, recv)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  return { ctx, routes, disposers, registerCalls, calls, workspaces }
}

/** 装载插件并等一拍：启动期的工作区解析/补建是异步的——取基线前先让它落定。 */
async function boot(ctx) {
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function fakeReq({ method = 'POST', headers = {}, body, url = '', chunks } = {}) {
  const handlers = {}
  const req = {
    method,
    headers,
    url,
    on(event, cb) { (handlers[event] ??= []).push(cb) },
    /** A06：按调用方给定边界逐块投递 data 事件（真实 TCP 分块的最小替身）。 */
    push(chunk) {
      const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      for (const cb of handlers.data ?? []) cb(payload)
    },
    finish() {
      for (const cb of handlers.end ?? []) cb()
    },
    emit() {
      const payloads = chunks ?? [Buffer.from(JSON.stringify(body ?? {}))]
      for (const payload of payloads) req.push(payload)
      req.finish()
    },
    destroy() {},
  }
  return req
}

/** 通用假响应：保留既有的 code/body/headers 断言面，并实现 handler 需要的 close/error/drain 事件。 */
function makeRes(onHeaders) {
  const chunks = []
  const listeners = new Map()
  const add = (event, cb) => {
    const list = listeners.get(event) ?? []
    list.push(cb)
    listeners.set(event, list)
  }
  const remove = (event, cb) => {
    const list = listeners.get(event)
    if (list === undefined) return
    const i = list.indexOf(cb)
    if (i >= 0) list.splice(i, 1)
  }
  const emit = (event, ...args) => {
    for (const cb of [...(listeners.get(event) ?? [])]) cb(...args)
  }
  const res = {
    code: 0, body: undefined, headers: {}, destroyed: false,
    writeHead(code, h) { this.code = code; this.headers = h ?? {}; onHeaders?.(code) },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true },
    end(b) { this.body = b ?? (chunks.length === 0 ? '' : Buffer.concat(chunks)); emit('finish') },
    on(event, cb) { add(event, cb); return this },
    once(event, cb) {
      const wrapper = (...args) => { remove(event, wrapper); cb(...args) }
      add(event, wrapper)
      return this
    },
    off(event, cb) { remove(event, cb); return this },
    emit(event, ...args) { emit(event, ...args); return true },
  }
  return res
}

async function call(ctx, path, { method = 'POST', headers = {}, body, url = path, onHeaders, chunks, response } = {}) {
  const route = ctx.routes.get(path)
  assert.ok(route, 'route must be registered: ' + path)
  const req = fakeReq({ method, headers, body, url, chunks })
  const res = response ?? makeRes(onHeaders)
  const done = route.handler(req, res)
  if (body !== undefined || chunks !== undefined) req.emit()
  await done
  return res
}

/** 找到多字节字符在 JSON Buffer 内的起点，返回其 UTF-8 序列内部的切点（切在 1 字节之后）。 */
function splitInside(buffer, char) {
  const at = buffer.indexOf(Buffer.from(char))
  assert.notEqual(at, -1, '夹具必须包含多字节字符：' + char)
  return at + 1
}

/**
 * A07 慢消费者替身：16 KiB 高水位 + 延迟回调，write 返回 false 后只有真正排空才会 drain。
 * peakBuffered 记录插件交给响应层的最大在途字节数；旧实现忽略 false 时会逼近整个文件。
 */
function slowResponse({ highWaterMark = 16 * 1024, delayMs = 2 } = {}) {
  const res = new Writable({
    highWaterMark,
    write(_chunk, _encoding, callback) { setTimeout(callback, delayMs) },
  })
  res.code = 0
  res.headers = {}
  res.received = 0
  res.peakBuffered = 0
  res.writeHead = function (code, headers) { this.code = code; this.headers = headers ?? {} }
  const write = Writable.prototype.write
  res.write = function (chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    res.received += buffer.length
    const accepted = write.call(this, buffer, encoding, callback)
    res.peakBuffered = Math.max(res.peakBuffered, this.writableLength)
    return accepted
  }
  return res
}

/** 走真实队列：投递 → 列出 → claim，返回 content 路由的短时 ticket。 */
async function deliverAndClaim(ctx, probe, name) {
  const delivered = await call(ctx, ROUTES.list, { headers: legit(), body: { path: probe } })
  assert.equal(delivered.code, 200)
  const listed = JSON.parse((await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  const item = name === undefined ? listed.items[0] : listed.items.find((candidate) => candidate.name === name)
  assert.ok(item, '队列中必须有待认领项')
  const claim = await call(ctx, ROUTES.claim, {
    headers: legit(), body: { entryId: item.entryId, sessionId: 'session-abcdef12-3456' },
  })
  assert.equal(claim.code, 200)
  return JSON.parse(claim.body).ticket
}

/** 进程 fd 目录：Linux/Android 用 /proc/self/fd，macOS 用 /dev/fd；都不可用时返回 undefined。 */
function fdDirectory() {
  if (existsSync('/proc/self/fd')) return '/proc/self/fd'
  if (existsSync('/dev/fd')) return '/dev/fd'
  return undefined
}

function fdCount() {
  const dir = fdDirectory()
  return dir === undefined ? undefined : readdirSync(dir).length
}

/** 等待 fd 数回到基线（容忍同文件其它异步操作造成的短暂抖动），超时即断言失败。 */
async function expectFdBaseline(baseline, message) {
  if (baseline === undefined) return
  const deadline = Date.now() + 1000
  while (fdCount() !== baseline && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(fdCount(), baseline, message)
}

/** 用真实 OS 状态断言某个已记录 fd 已关闭：fstat 应返回 EBADF。 */
function assertFdClosed(fd, message) {
  assert.throws(() => fs.fstatSync(fd), (error) => error.code === 'EBADF', message)
}

/** 给可能挂起的 handler 一个失败窗口，避免回归时整个测试进程一直等下去。 */
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const legit = () => ({ host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN })

for (const replacement of ['directory', 'symlink']) {
  test('clean preserves user data when an admitted temporary file becomes a ' + replacement, { skip: replacement === 'symlink' && process.platform === 'win32' }, async () => {
    const ws = freshWorkspace()
    const owned = join(ws, 'owned.tmp')
    const ordinary = join(ws, 'ordinary.tmp')
    const userFile = join(ws, 'user-note.txt')
    writeFileSync(owned, 'temporary')
    writeFileSync(ordinary, 'temporary')
    writeFileSync(userFile, 'USER DATA')
    const { ctx } = makeCtx()
    await boot(ctx)
    for (const path of [owned, ordinary]) {
      const delivered = await call(ctx, ROUTES.list, { headers: legit(), body: { path } })
      assert.equal(delivered.code, 200)
    }
    rmSync(owned)
    if (replacement === 'directory') {
      mkdirSync(owned)
      writeFileSync(join(owned, 'note.txt'), 'DIRECTORY DATA')
    } else symlinkSync(userFile, owned)
    const cleaned = await call(ctx, ROUTES.clean, { headers: legit() })
    assert.equal(cleaned.code, 200)
    assert.equal(readFileSync(userFile, 'utf8'), 'USER DATA')
    if (replacement === 'directory') assert.equal(readFileSync(join(owned, 'note.txt'), 'utf8'), 'DIRECTORY DATA')
    assert.equal(JSON.parse(cleaned.body).removed, 1)
    assert.equal(existsSync(ordinary), false)
    assert.ok(readFileSync(join(ws, '.tool-temp.ndjson'), 'utf8').includes(owned))
  })
}

test('clean rejects metadata and nested ownership records while deleting real temporary files', async () => {
  const ws = freshWorkspace()
  const { ctx } = makeCtx()
  await boot(ctx)
  const paths = ['.meta.ndjson', '.pending-notify.ndjson', '.sessions/protected.json', 'user-directory/note.txt']
  for (const path of paths) {
    mkdirSync(join(ws, path, '..'), { recursive: true })
    writeFileSync(join(ws, path), 'PRESERVE ' + path)
  }
  const owned = join(ws, 'owned.tmp')
  writeFileSync(owned, 'temporary')
  writeFileSync(join(ws, '.tool-temp.ndjson'), [...paths.map(path => join(ws, path)), owned].join('\n') + '\n')
  const cleaned = await call(ctx, ROUTES.clean, { headers: legit() })
  assert.equal(cleaned.code, 200)
  assert.equal(JSON.parse(cleaned.body).removed, 1)
  for (const path of paths) assert.equal(readFileSync(join(ws, path), 'utf8'), 'PRESERVE ' + path)
  assert.equal(existsSync(owned), false)
})

for (const replaceParent of [false, true]) {
  test('content pins the admitted file when ' + (replaceParent ? 'parent' : 'leaf') + ' is replaced before streaming', { skip: process.platform !== 'linux' }, async () => {
    const ws = freshWorkspace()
    const parent = join(ws, 'payload')
    mkdirSync(parent)
    const probe = join(parent, 'document.txt')
    writeFileSync(probe, 'ADMITTED')
    const foreign = mkdtempSync(join(tmpdir(), 'dsh-foreign-'))
    writeFileSync(join(foreign, 'document.txt'), 'SECRET!!')
    const { ctx } = makeCtx()
    await boot(ctx)
    const delivered = await call(ctx, ROUTES.list, { headers: legit(), body: { path: probe } })
    assert.equal(delivered.code, 200)
    const listed = JSON.parse((await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
    const claim = await call(ctx, ROUTES.claim, { headers: legit(), body: { entryId: listed.items[0].entryId, sessionId: 'session-abcdef12-3456' } })
    assert.equal(claim.code, 200)
    const { ticket } = JSON.parse(claim.body)
    const descriptors = readdirSync('/proc/self/fd').length
    try {
      const content = await call(ctx, ROUTES.content, {
        method: 'GET', headers: legit(), url: ROUTES.content + '?ticket=' + ticket,
        onHeaders(code) {
          if (code !== 200) return
          const victim = replaceParent ? parent : probe
          renameSync(victim, victim + '.saved')
          symlinkSync(replaceParent ? foreign : join(foreign, 'document.txt'), victim)
        },
      })
      assert.equal(content.code, 200)
      assert.equal(Buffer.from(content.body).toString(), 'ADMITTED')
      assert.equal(readFileSync(join(foreign, 'document.txt'), 'utf8'), 'SECRET!!')
      assert.equal(readdirSync('/proc/self/fd').length, descriptors, 'stream must release its descriptor')
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })
}

test('content rejects an outside descriptor after parent replacement at open', { skip: process.platform !== 'linux' }, async () => {
  const ws = freshWorkspace()
  const parent = join(ws, 'payload')
  mkdirSync(parent)
  const probe = join(parent, 'document.txt')
  writeFileSync(probe, 'ADMITTED')
  const foreign = mkdtempSync(join(tmpdir(), 'dsh-foreign-open-'))
  writeFileSync(join(foreign, 'document.txt'), 'SECRET!!')
  const { ctx } = makeCtx()
  await boot(ctx)
  await call(ctx, ROUTES.list, { headers: legit(), body: { path: probe } })
  const listed = JSON.parse((await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  const claim = await call(ctx, ROUTES.claim, { headers: legit(), body: { entryId: listed.items[0].entryId, sessionId: 'session-abcdef12-3456' } })
  const { ticket } = JSON.parse(claim.body)
  const originalOpen = fs.openSync
  const descriptors = readdirSync('/proc/self/fd').length
  let replaced = false
  try {
    fs.openSync = function (path, ...args) {
      if (path === realpathSync(ws) + '/payload/document.txt' && !replaced) {
        replaced = true
        renameSync(parent, parent + '.saved')
        symlinkSync(foreign, parent)
      }
      return originalOpen(path, ...args)
    }
    syncBuiltinESMExports()
    const content = await call(ctx, ROUTES.content, { method: 'GET', headers: legit(), url: ROUTES.content + '?ticket=' + ticket })
    assert.equal(replaced, true)
    assert.equal(content.code, 410)
    assert.equal(String(content.body).includes('SECRET!!'), false)
    assert.equal(readdirSync('/proc/self/fd').length, descriptors, 'rejection must release its descriptor')
  } finally {
    fs.openSync = originalOpen
    syncBuiltinESMExports()
    rmSync(foreign, { recursive: true, force: true })
  }
})

// A06：TCP chunk 不保证 UTF-8 字符完整。以下用例把「中」的三字节拆到两个 data 事件，
// 逐块 toString 的旧实现会把路径解成替换符，入队/认领/完成都会偏离原始中文输入。
test('A06：file-incoming 分块投递时「中」跨 data 事件不损坏入队路径', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, '中文.txt')
  writeFileSync(probe, 'CJK')
  const { ctx } = makeCtx()
  await boot(ctx)
  const body = Buffer.from(JSON.stringify({ path: probe }))
  const split = splitInside(body, '中')
  const delivered = await call(ctx, ROUTES.list, {
    method: 'POST',
    headers: legit(),
    chunks: [body.subarray(0, split), body.subarray(split)],
  })
  assert.equal(delivered.code, 200)
  assert.equal(JSON.parse(delivered.body).ok, true, '合法中文路径不得因跨块解码被判为不存在')
  const queueFiles = readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json'))
  assert.equal(queueFiles.length, 1)
  const record = JSON.parse(readFileSync(join(ws, '.sessions', queueFiles[0]), 'utf8'))
  assert.equal(record.path, realpathSync(probe), '入队路径必须与原始中文路径完全一致')
  assert.equal(record.name, '中文.txt')
  assert.equal(record.path.includes('\uFFFD'), false, '解码结果不得含替换符')
  const listed = JSON.parse((await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  assert.equal(listed.items[0].name, '中文.txt')
})

test('A06：claim 分块解码不损坏中文 entryId，认领仍能命中队列记录', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'claim.txt')
  writeFileSync(probe, 'claim')
  const sessionsDir = join(ws, '.sessions')
  mkdirSync(sessionsDir, { recursive: true })
  // 队列 id 由持久层写入，不保证只含 ASCII；中文 id 能让旧实现必然 404。
  writeFileSync(join(sessionsDir, 'cjk.json'), JSON.stringify({
    id: '中文条目', ts: new Date().toISOString(), path: probe, forcedNewSession: true,
    state: 'received', name: 'claim.txt', bytes: 5,
  }))
  const { ctx } = makeCtx()
  await boot(ctx)
  const body = Buffer.from(JSON.stringify({ entryId: '中文条目', sessionId: 'session-abcdef12-3456' }))
  const split = splitInside(body, '中')
  const claimed = await call(ctx, ROUTES.claim, {
    method: 'POST',
    headers: legit(),
    chunks: [body.subarray(0, split), body.subarray(split)],
  })
  assert.equal(claimed.code, 200, '分块解码损坏 id 会退化为 404')
  const payload = JSON.parse(claimed.body)
  assert.equal(payload.entryId, '中文条目')
  assert.equal(typeof payload.ticket, 'string')
  assert.equal(existsSync(join(sessionsDir, 'cjk.json')), false, '认领成功必须消费队列记录')
})

test('A06：complete 分块解码后仍能完成草稿（多字节字符跨块）', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'complete.txt')
  writeFileSync(probe, 'x')
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  const body = Buffer.from(JSON.stringify({ ticket, outcome: 'draft-ready', note: '中文备注' }))
  const split = splitInside(body, '中')
  const completed = await call(ctx, ROUTES.complete, {
    headers: legit(),
    chunks: [body.subarray(0, split), body.subarray(split)],
  })
  assert.equal(completed.code, 200)
  assert.equal(JSON.parse(completed.body).state, 'draft-ready')
})

test('A06：三个 POST handler 的 body 上限按 UTF-8 字节计（字符数未超也会 413）', async () => {
  const ws = freshWorkspace()
  const { ctx } = makeCtx()
  await boot(ctx)
  // 每例构造「字节数超限、字符数远低于上限」的 body：只按字符累计的旧实现不会 413。
  // 4096 字节上限即审计给出的 4096→4097 反例；16 KiB 与 2048 保持各自现有语义。
  const cases = [
    { route: ROUTES.list, limit: 16 * 1024, error: 'body too large' },
    { route: ROUTES.claim, limit: 4096, error: 'claim body too large' },
    { route: ROUTES.complete, limit: 2048, error: 'completion body too large' },
  ]
  for (const item of cases) {
    const bytes = item.limit + 1
    const multibyte = Math.floor(bytes / 3)
    const padding = bytes - multibyte * 3
    const body = Buffer.concat([Buffer.from('中'.repeat(multibyte)), Buffer.from('a'.repeat(padding))])
    assert.equal(body.length, bytes)
    assert.ok(multibyte + padding <= item.limit, '夹具的字符数不得超过上限（否则负例不能区分字符/字节计数）')
    const res = await call(ctx, item.route, {
      method: 'POST',
      headers: legit(),
      chunks: [body.subarray(0, 1000), body.subarray(1000)],
    })
    assert.equal(res.code, 413, item.route + ' 必须在 ' + bytes + ' 字节时拒绝')
    assert.equal(JSON.parse(res.body).error, item.error)
  }
})

test('A07：慢消费者下 content 正确处理背压，峰值缓冲远小于文件', async () => {
  const ws = freshWorkspace()
  const FILE_BYTES = 4 * 1024 * 1024
  const probe = join(ws, 'slow.bin')
  writeFileSync(probe, Buffer.alloc(FILE_BYTES, 0x61))
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  const res = slowResponse({ highWaterMark: 16 * 1024, delayMs: 2 })
  const finished = once(res, 'finish')
  const done = call(ctx, ROUTES.content, {
    method: 'GET',
    headers: legit(),
    response: res,
    url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
  })
  await done
  await finished
  assert.equal(res.received, FILE_BYTES, '慢消费者最终必须收到完整文件')
  assert.ok(res.peakBuffered < FILE_BYTES / 4, '峰值在途字节必须远小于文件（旧实现会整文件入缓冲）')
  assert.ok(
    res.peakBuffered <= 256 * 1024,
    '峰值应被 64 KiB 读块与 drain 限制在数百 KiB 内，实际=' + res.peakBuffered,
  )
})

test('A07：客户端断连会销毁源读流、停止读取并关闭 fd', async () => {
  const ws = freshWorkspace()
  const FILE_BYTES = 4 * 1024 * 1024
  const probe = join(ws, 'disconnect.bin')
  writeFileSync(probe, Buffer.alloc(FILE_BYTES, 0x62))
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  // content handler 在模块加载时导入 createReadStream/openSync；syncBuiltinESMExports 让替身生效。
  const originalCreateReadStream = fs.createReadStream
  const originalOpenSync = fs.openSync
  const streams = []
  const opened = []
  fs.createReadStream = function (...args) {
    const stream = originalCreateReadStream.apply(this, args)
    streams.push(stream)
    return stream
  }
  fs.openSync = function (...args) {
    const fd = originalOpenSync.apply(this, args)
    opened.push(fd)
    return fd
  }
  syncBuiltinESMExports()
  try {
    const baseline = fdCount()
    const res = slowResponse({ delayMs: 25 })
    const done = call(ctx, ROUTES.content, {
      method: 'GET',
      headers: legit(),
      response: res,
      url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
    })
    const started = Date.now()
    while (res.received === 0) {
      if (Date.now() - started > 2000) throw new Error('未在限定时间内收到首个数据块')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    res.destroy()
    await withTimeout(done, 5000, '断连后 content handler 必须收尾')
    assert.equal(opened.length, 1, 'content 必须只打开一个源 fd')
    // close 事件后由流按 autoClose 关闭描述符；fstat 与 fd 计数都直接看 OS 状态，不做推断。
    assertFdClosed(opened[0], '断连后源 fd 必须已关闭')
    await expectFdBaseline(baseline, '断连后 fd 数必须回到基线')
    assert.equal(streams.length, 1, 'content 必须从工作区打开一个源读流')
    const stream = streams[0]
    assert.equal(stream.destroyed, true, '客户端断连后必须销毁源读流')
    const readAtClose = stream.bytesRead
    assert.ok(readAtClose < FILE_BYTES, '断连时不应已读完整文件')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(stream.bytesRead, readAtClose, '销毁后不得继续读取源文件')
  } finally {
    fs.createReadStream = originalCreateReadStream
    fs.openSync = originalOpenSync
    syncBuiltinESMExports()
  }
})

test('A07：自然结束时源 fd 关闭且 fd 数回到基线', async () => {
  const ws = freshWorkspace()
  const FILE_BYTES = 512 * 1024
  const probe = join(ws, 'natural-end.bin')
  writeFileSync(probe, Buffer.alloc(FILE_BYTES, 0x63))
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  const originalOpenSync = fs.openSync
  const opened = []
  fs.openSync = function (...args) {
    const fd = originalOpenSync.apply(this, args)
    opened.push(fd)
    return fd
  }
  syncBuiltinESMExports()
  try {
    const baseline = fdCount()
    const content = await withTimeout(call(ctx, ROUTES.content, {
      method: 'GET',
      headers: legit(),
      url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
    }), 5000, '自然结束时 content handler 必须收尾')
    assert.equal(content.code, 200)
    assert.equal(Buffer.from(content.body).length, FILE_BYTES, '自然结束必须完整发送文件')
    assert.equal(opened.length, 1, 'content 必须只打开一个源 fd')
    assertFdClosed(opened[0], '自然结束后源 fd 必须已关闭')
    await expectFdBaseline(baseline, '自然结束后 fd 数必须回到基线')
  } finally {
    fs.openSync = originalOpenSync
    syncBuiltinESMExports()
  }
})

test('A07：源流读错误后仍关闭 fd 并结束响应', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'read-error.bin')
  writeFileSync(probe, Buffer.alloc(1024 * 1024, 0x64))
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  const originalCreateReadStream = fs.createReadStream
  const originalOpenSync = fs.openSync
  const streams = []
  const opened = []
  fs.createReadStream = function (...args) {
    const stream = originalCreateReadStream.apply(this, args)
    streams.push(stream)
    // 下一 tick 注入读错误：此时 handler 已挂好 error/close 监听。
    process.nextTick(() => {
      if (!stream.destroyed) stream.destroy(new Error('injected read error'))
    })
    return stream
  }
  fs.openSync = function (...args) {
    const fd = originalOpenSync.apply(this, args)
    opened.push(fd)
    return fd
  }
  syncBuiltinESMExports()
  try {
    const baseline = fdCount()
    const content = await withTimeout(call(ctx, ROUTES.content, {
      method: 'GET',
      headers: legit(),
      url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
    }), 5000, '读错误后 content handler 必须收尾')
    assert.equal(content.code, 200, '已发出的 200 头不因后续读错误改写')
    assert.equal(streams.length, 1)
    assert.equal(streams[0].destroyed, true, '读错误必须销毁源流')
    assert.equal(opened.length, 1)
    assertFdClosed(opened[0], '读错误后源 fd 必须已关闭')
    await expectFdBaseline(baseline, '读错误后 fd 数必须回到基线')
  } finally {
    fs.createReadStream = originalCreateReadStream
    fs.openSync = originalOpenSync
    syncBuiltinESMExports()
  }
})

test('A07：createReadStream 抛错（fd 未移交）时 finally 仍关闭 fd', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'create-failure.bin')
  writeFileSync(probe, Buffer.alloc(64 * 1024, 0x65))
  const { ctx } = makeCtx()
  await boot(ctx)
  const ticket = await deliverAndClaim(ctx, probe)
  const originalCreateReadStream = fs.createReadStream
  const originalOpenSync = fs.openSync
  const opened = []
  fs.createReadStream = function () { throw new Error('injected create failure') }
  fs.openSync = function (...args) {
    const fd = originalOpenSync.apply(this, args)
    opened.push(fd)
    return fd
  }
  syncBuiltinESMExports()
  try {
    const baseline = fdCount()
    await assert.rejects(
      withTimeout(call(ctx, ROUTES.content, {
        method: 'GET',
        headers: legit(),
        url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
      }), 5000, 'createReadStream 抛错后 handler 必须立即拒绝'),
      /injected create failure/,
    )
    assert.equal(opened.length, 1, 'admission 已打开源 fd')
    assertFdClosed(opened[0], 'fd 未移交时失败必须由 finally 关闭')
    await expectFdBaseline(baseline, 'fd 未移交时失败后 fd 数必须回到基线')
  } finally {
    fs.createReadStream = originalCreateReadStream
    fs.openSync = originalOpenSync
    syncBuiltinESMExports()
  }
})

test('FX-205.1 无 cookie 且无令牌 → 401，工作区零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(res.code, 401)
  assert.deepEqual(snapshot(ws), before, '被拒请求不得改动工作区')
})

test('FX-205.3 伪造 Origin → 403 且响应体为空', async () => {
  const ws = freshWorkspace()
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.list, {
    method: 'GET',
    headers: { host: HOST, origin: 'http://evil.example', [CONTROL_TOKEN_HEADER]: TOKEN },
  })
  assert.equal(res.code, 403)
  assert.equal(res.body, '', '403 不得回任何正文（防 rebound 页面读到清单）')
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.4 篡改 Host（DNS rebinding 形态）→ 403 / 空体 / 零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'tool-owned.bin'), 'x')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  for (const host of ['evil.example', 'evil.example:3080', '127.0.0.1:3081']) {
    const res = await call(ctx, ROUTES.clean, {
      method: 'POST',
      headers: { host, [CONTROL_TOKEN_HEADER]: TOKEN },
    })
    assert.equal(res.code, 403, 'host=' + host + ' 必须被拒')
    assert.equal(res.body, '')
  }
  assert.deepEqual(snapshot(ws), before, 'Host 被拒时拒绝发生在 handler 副作用之前')
})

test('FX-205.1 合法令牌 → 受保护队列路由放行（GET 清单 + POST 投递）', async () => {
  const ws = freshWorkspace()
  const incoming = join(ws, 'photo.jpg')
  writeFileSync(incoming, 'img')
  const { ctx } = makeCtx()
  await boot(ctx)
  const listed = await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })
  assert.equal(listed.code, 200)
  assert.equal(JSON.parse(listed.body).ok, true)
  const delivered = await call(ctx, ROUTES.list, {
    method: 'POST', headers: legit(), body: { path: incoming },
  })
  assert.equal(delivered.code, 200)
  assert.equal(JSON.parse(delivered.body).ok, true, '壳侧投递不得被 403 静默拒收')
  assert.equal(readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json')).length, 1)
})

test('FX-205.1 浏览器会话（上游 connection 栅栏放行）→ 200；被拒 → 401', async () => {
  const ws = freshWorkspace()
  const allowed = makeCtx({ requestRejection: () => undefined })
  await boot(allowed.ctx)
  const ok = await call(allowed.ctx, ROUTES.list, { method: 'GET', headers: { host: HOST, cookie: 'dsh-auth=abc' } })
  assert.equal(ok.code, 200)
  const before = snapshot(ws)

  const denied = makeCtx({ requestRejection: () => 401 })
  await boot(denied.ctx)
  const no = await call(denied.ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(no.code, 401)
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.2 GET /clean → 405 且工作区零变化', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'owned.tmp'), 'owned')
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.clean, { method: 'GET', headers: legit() })
  assert.equal(res.code, 405)
  assert.equal(res.headers.allow, 'POST')
  assert.deepEqual(snapshot(ws), before, 'GET 不得触发任何删除')
  assert.ok(existsSync(join(ws, 'owned.tmp')))
})

test('FX-205.5 POST /clean 只删自有临时项：.sessions 豁免项 + 用户文件零变化', async () => {
  const ws = freshWorkspace()
  const sessions = join(ws, '.sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'keep.json'), '{"ts":"x"}')
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const toolTmp = join(ws, 'tool-temp.bin')
  writeFileSync(toolTmp, 'tool')
  writeFileSync(join(ws, '.tool-temp.ndjson'), toolTmp + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(existsSync(toolTmp), false, '自有临时项必须被删')
  assert.equal(existsSync(join(ws, 'user-file.txt')), true, '用户文件零变化')
  assert.equal(existsSync(join(sessions, 'keep.json')), true, '.sessions 豁免项零变化')
})

test('FX-205.5 设备回归：清单记 canonical 形态、DSH_HOME 词法为另一形态时仍必须删除', async () => {
  // 用 Windows junction 复刻 Android 的 /data/user/0 <-> /data/data 双形态：
  // DSH_HOME 走 link 形态，而 enqueueSession 记账走 realpath 形态（设备实测组合）。
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const ws = join(linkHome, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const toolCanonical = join(realpathSync(linkHome), 'workspaces', 'incoming', 'tool-canonical.bin')
  writeFileSync(toolCanonical, 'tool')
  writeFileSync(join(ws, '.tool-temp.ndjson'), toolCanonical + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 1, 'canonical 形态的自有项必须被删（旧实现恒 removed:0 且清单被清空）')
  assert.equal(existsSync(toolCanonical), false)
  assert.equal(existsSync(join(ws, 'user-file.txt')), true)
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('FX-205.5 越界项不得从清单静默消失（保留可重试，且绝不删工作区外文件）', async () => {
  const ws = freshWorkspace()
  const owned = join(ws, 'owned-good.bin')
  writeFileSync(owned, 'x')
  const outside = join(tmpdir(), 'dsh-outside-' + Date.now() + '.bin')
  writeFileSync(outside, 'y')
  writeFileSync(join(ws, '.tool-temp.ndjson'), owned + '\n' + outside + '\n')
  const { ctx } = makeCtx()
  await boot(ctx)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 1)
  assert.equal(existsSync(owned), false)
  assert.equal(existsSync(outside), true, '工作区外文件绝不能被删')
  const kept = readFileSync(join(ws, '.tool-temp.ndjson'), 'utf8')
  assert.ok(kept.includes(outside), '越界项必须留在清单里（不得静默丢所有权）')
  assert.ok(!kept.includes(owned), '已删除项必须从清单移除')
  rmSync(outside, { force: true })
})

test('FX-205.5 无记账清单时 /clean 不删任何东西（fail-safe）', async () => {
  const ws = freshWorkspace()
  writeFileSync(join(ws, 'user-file.txt'), 'user')
  const { ctx } = makeCtx()
  await boot(ctx)
  const before = snapshot(ws)
  const res = await call(ctx, ROUTES.clean, { method: 'POST', headers: legit() })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).removed, 0)
  assert.deepEqual(snapshot(ws), before)
})

test('FX-205.7 卸载回收五条路由；重新装载只有一份注册（无重复 handler）', async () => {
  const first = makeCtx()
  await boot(first.ctx)
  assert.deepEqual([...first.routes.keys()].sort(), Object.values(ROUTES).sort())
  assert.equal(first.disposers.length, 6, '五条路由和一条 ticket 清理 effect 都必须可回收')
  for (const dispose of first.disposers) dispose()
  assert.equal(first.routes.size, 0, '卸载后路由必须不再应答')

  const second = makeCtx()
  await boot(second.ctx)
  const perPath = second.registerCalls.filter((p) => p === ROUTES.list).length
  assert.equal(perPath, 1, '同一 path 每次装载只注册一份')
  assert.equal(second.routes.size, 5)
})

test('设备回归：cordis 风格 Context 只能经 ctx.get 读服务（属性访问未 inject 会抛 → 上游兜底 400）', async () => {
  const ws = freshWorkspace()
  // 保真的浏览器会话替身：只有带 cookie 的请求才被判为已认证（等价上游 BrowserAuth）。
  const harness = makeCtx({ requestRejection: (req) => (req.headers?.cookie ? undefined : 401) })
  const { ctx } = harness
  // 替身自洽性：属性访问确实会抛（与 cordis ReflectService.handler.get 同形）。
  assert.throws(() => { void ctx.connection }, /without inject/)
  // 设备实测的失效形态：该异常在 handler 内抛出且响应未发送 → 上游 webserver 回 400。
  // 修复后 handler 全程不触发该陷阱：浏览器会话请求照常 200。
  await boot(ctx)
  const ok = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST, cookie: 'dsh-auth=abc' } })
  assert.equal(ok.code, 200)
  const withToken = await call(ctx, ROUTES.list, { method: 'GET', headers: legit() })
  assert.equal(withToken.code, 200)
  const before = snapshot(ws)
  const denied = await call(ctx, ROUTES.list, { method: 'GET', headers: { host: HOST } })
  assert.equal(denied.code, 401)
  assert.deepEqual(snapshot(ws), before)
})

test('external file stays opaque received until trusted browser creates its blank session and claims a ticket', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'r1-in.png')
  writeFileSync(probe, 'PNG')
  const createdRequests = []
  const harness = makeCtx(undefined, {
    workspaces: [],
    sessionController: {
      async create(request) { createdRequests.push(request); return { sessionId: 'session-abcdef12-3456' } },
    },
  })
  await boot(harness.ctx)
  const delivered = await call(harness.ctx, ROUTES.list, { method: 'POST', headers: legit(), body: { path: probe } })
  assert.equal(delivered.code, 200)
  assert.equal(createdRequests.length, 0, 'cold receipt does not create before a browser session exists')
  const listed = await call(harness.ctx, ROUTES.list, { method: 'GET', headers: legit() })
  const payload = JSON.parse(listed.body)
  const item = payload.items[0]
  assert.equal(createdRequests.length, 0, 'queue read does not create before the trusted client creates its session')
  assert.equal(item.sessionId, undefined)
  assert.equal(item.state, 'received')
  assert.equal(item.name, 'r1-in.png')
  assert.equal(JSON.stringify(item).includes(probe), false, '状态面不得公开绝对路径')
  const queueFiles = readdirSync(join(ws, '.sessions')).filter((f) => f.endsWith('.json'))
  const record = JSON.parse(readFileSync(join(ws, '.sessions', queueFiles[0]), 'utf8'))
  assert.equal(record.context, undefined, '不得保留旧 @path 首轮上下文')

  const clientSessionId = 'session-abcdef12-3456'
  const claim = await call(harness.ctx, ROUTES.claim, {
    headers: legit(), body: { entryId: item.entryId, sessionId: clientSessionId },
  })
  assert.equal(claim.code, 200)
  const ticket = JSON.parse(claim.body).ticket
  assert.equal(typeof ticket, 'string')
  assert.equal(existsSync(join(ws, '.sessions', queueFiles[0])), false, 'claim 后不得在重启时复建草稿')
  const content = await call(harness.ctx, ROUTES.content, {
    method: 'GET', headers: legit(), url: ROUTES.content + '?ticket=' + encodeURIComponent(ticket),
  })
  assert.equal(content.code, 200)
  assert.equal(Buffer.from(content.body).toString(), 'PNG')
  assert.equal(String(content.headers['content-type']), 'application/octet-stream')
  const complete = await call(harness.ctx, ROUTES.complete, {
    headers: legit(), body: { ticket, outcome: 'draft-ready' },
  })
  assert.equal(complete.code, 200)
  assert.equal(JSON.parse(complete.body).state, 'draft-ready')
})

test('claim rejects a non-durable browser session before deleting queue state', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'mismatch.txt')
  writeFileSync(probe, 'x')
  const harness = makeCtx(undefined, { workspaces: [] })
  await boot(harness.ctx)
  await call(harness.ctx, ROUTES.list, { method: 'POST', headers: legit(), body: { path: probe } })
  const listed = JSON.parse((await call(harness.ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  const before = snapshot(ws)
  const claim = await call(harness.ctx, ROUTES.claim, {
    headers: legit(), body: { entryId: listed.items[0].entryId, sessionId: 'session-not-durable' },
  })
  assert.equal(claim.code, 409)
  assert.deepEqual(snapshot(ws), before, '无效 session 不得消费队列或临时文件')
})

test('claim accepts Android-equivalent /data/user/0 and /data/data workspace prefixes', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-home-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-home-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const ws = join(realHome, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  const probe = join(ws, 'alias.txt')
  writeFileSync(probe, 'alias')
  const harness = makeCtx(undefined, { workspaces: [] })
  await boot(harness.ctx)
  await call(harness.ctx, ROUTES.list, { method: 'POST', headers: legit(), body: { path: probe } })
  const listed = JSON.parse((await call(harness.ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  const claimed = await call(harness.ctx, ROUTES.claim, {
    headers: legit(), body: { entryId: listed.items[0].entryId, sessionId: 'session-abcdef12-alias' },
  })
  assert.equal(claimed.code, 200, 'canonical aliases must not turn a live source into 410')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('R2：同目录非 canonical 毒条目自愈删除并重建为 canonical 条目（IX-TW-01）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const ws = join(linkHome, 'workspaces', 'incoming')
  mkdirSync(ws, { recursive: true })
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  const workspaces = [
    { id: 'ws-poison', path: ws, title: '临时工作区', sessionIds: [] },
    { id: 'ws-other', path: join(realHome, 'other'), title: '别的工作区', sessionIds: [] },
  ]
  const harness = makeCtx(undefined, {
    workspaces,
    sessionController: {
      async create() { return { sessionId: 'session-abcdef12-9999' } },
    },
  })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const incoming = harness.workspaces.filter((w) => w.title === '临时工作区')
  assert.equal(incoming.length, 1, 'IX-TW-01：该标题下只剩 1 条登记')
  assert.equal(incoming[0].path, canonical, 'path 必须落在 canonical 形态')
  assert.equal(incoming[0].path, realpathSync(incoming[0].path), 'IX-TW-01：path == realpath(path)')
  assert.deepEqual(harness.calls.workspaceDelete, ['ws-poison'], '只删非 canonical 的残留')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('R2：已有 canonical 可用条目时直接复用（零 create / 零 delete）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  mkdirSync(canonical, { recursive: true })
  const workspaces = [{ id: 'ws-good', path: canonical, title: '临时工作区', sessionIds: ['session-1'] }]
  const createdRequests = []
  const harness = makeCtx(undefined, {
    workspaces,
    sessionController: {
      async create(request) { createdRequests.push(request); return { sessionId: 'session-abcdef12-2222' } },
    },
  })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(harness.calls.workspaceCreate, [], '可复用条目存在时不得重复 create')
  assert.deepEqual(harness.calls.workspaceDelete, [], '可复用条目不得被删')
  assert.equal(createdRequests.length, 0, '未触发补建时不建会话（无待建条目）')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('R2 设备形态：可用(canonical)条目与毒条目并存时，毒条目仍被自愈删除（IX-TW-01 唯一性）', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const linkHome = join(mkdtempSync(join(tmpdir(), 'dsh-link-')), 'home')
  symlinkSync(realHome, linkHome, 'junction')
  process.env.DSH_HOME = linkHome
  const canonical = join(realpathSync(linkHome), 'workspaces', 'incoming')
  mkdirSync(canonical, { recursive: true })
  // 设备实测形态：canonical 条目（有 5 个 durable sessionIds）+ 非 canonical 毒条目（sessionIds 空）
  const workspaces = [
    { id: 'ws-good', path: canonical, title: '临时工作区', sessionIds: ['session-aaaaaaaa-1'] },
    { id: 'ws-poison', path: join(linkHome, 'workspaces', 'incoming'), title: '临时工作区', sessionIds: [] },
    { id: 'ws-other', path: join(realHome, 'other'), title: '别的工作区', sessionIds: [] },
  ]
  const harness = makeCtx(undefined, { workspaces })
  await boot(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const incoming = harness.workspaces.filter((w) => w.title === '临时工作区')
  assert.equal(incoming.length, 1, 'IX-TW-01：该标题下只剩 1 条')
  assert.equal(incoming[0].id, 'ws-good', '可用条目必须保留（有会话的条目不得丢）')
  assert.equal(incoming[0].path, realpathSync(incoming[0].path), 'IX-TW-01：path == realpath(path)')
  assert.deepEqual(harness.calls.workspaceDelete, ['ws-poison'])
  assert.deepEqual(harness.calls.workspaceCreate, [], '已有可用条目 → 不重复 create')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-open-'))
})

test('queue read leaves legacy records for the client-side blank-session handoff', async () => {
  const ws = freshWorkspace()
  const probe = join(ws, 'legacy.txt')
  writeFileSync(probe, 'x')
  const sessionsDir = join(ws, '.sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, 'legacy.json'), JSON.stringify({ ts: 't', path: probe, forcedNewSession: true, sessionId: 'session-1' }))
  writeFileSync(join(sessionsDir, 'fresh.json'), JSON.stringify({ ts: 't', path: probe, forcedNewSession: true }))
  let creates = 0
  const harness = makeCtx(undefined, {
    workspaces: [],
    sessionController: { async create() { creates += 1; return { sessionId: 'session-' + String(creates).padStart(8, '0') + '-abc' } } },
  })
  await boot(harness.ctx)
  assert.equal(creates, 0, 'cold boot does not create before a browser reads the queue')
  const listed = JSON.parse((await call(harness.ctx, ROUTES.list, { method: 'GET', headers: legit() })).body)
  assert.equal(creates, 0, 'server never reissues invisible sessions during a queue read')
  assert.equal(listed.items.length, 2)
  assert.equal(listed.items.some((item) => item.state === 'received'), true)
})

test('鉴权纯函数：trusted host 列表与令牌头常量与壳侧契约一致', () => {
  assert.deepEqual([...TRUSTED_HOSTS].sort(), ['127.0.0.1:3080', 'localhost:3080'].sort())
  assert.equal(CONTROL_TOKEN_HEADER, 'x-dsh-control-token')
  assert.equal(authorizeIncomingRoute({ headers: {} }, { token: () => TOKEN }).code, 403, '缺 Host 一律拒')
  assert.equal(
    authorizeIncomingRoute({ headers: { host: HOST, [CONTROL_TOKEN_HEADER]: TOKEN } }, { token: () => TOKEN }),
    undefined,
    '白名单 Host + 合法令牌必须放行',
  )
  assert.equal(authorizeIncomingRoute({ headers: { host: HOST } }, { token: () => undefined }).code, 401)
  assert.equal(authorizeIncomingRoute({ headers: { host: 'evil.example' } }, { token: () => TOKEN }).code, 403)
})
