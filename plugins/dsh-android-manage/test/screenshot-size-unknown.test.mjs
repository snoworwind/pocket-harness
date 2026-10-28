// android_screenshot 的设备物理分辨率是归一化坐标换算锚点；未知时不得用 0 伪造。
// 附件自身的像素尺寸另存于 image.width/height，不得覆盖设备物理分辨率。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

function faceFor(data) {
  return {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'test-a11y' }),
    controlExec: async (op) => op === 'screenshot' ? { ok: true, data } : { ok: true, data: {} },
    screenAccess: () => ({ ok: true, screenId: 'real', displayId: 0, scope: 'all' }),
    screenAccessResolved: async () => ({ ok: true, screenId: 'real', displayId: 0, scope: 'all' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
  }
}

async function shoot(data, services = {}) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (tool) => tools.push(tool) },
    get: (name) => services[name],
    androidPrivilege: faceFor(data),
  })
  const tool = tools.find((item) => item.name === 'android_screenshot')
  assert.ok(tool, 'android_screenshot must be registered')
  return tool.execute({}, {
    agent: { session: { requestHeader: () => ({ config: { provider: 'test', model: 'vision-test' } }) } },
  })
}

test('壳侧未回尺寸时，返回体和文案都保留未知语义', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png' })
  assert.equal(Object.hasOwn(r, 'width'), false)
  assert.equal(Object.hasOwn(r, 'height'), false)
  assert.match(String(r.text), /设备物理分辨率 \?x\?/, '未知尺寸必须显示 ?x?')
})

test('壳侧回完整尺寸时，返回体和文案都带出真值', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png', width: 1080, height: 2400 })
  assert.equal(r.width, 1080)
  assert.equal(r.height, 2400)
  assert.match(String(r.text), /设备物理分辨率 1080x2400/)
})

test('只回一半、零值或非有限值时，整对尺寸字段缺席', async () => {
  for (const data of [
    { path: '/tmp/scan/shot.png', width: 1080 },
    { path: '/tmp/scan/shot.png', width: 0, height: 2400 },
    { path: '/tmp/scan/shot.png', width: Number.NaN, height: Number.POSITIVE_INFINITY },
  ]) {
    const r = await shoot(data)
    assert.equal(Object.hasOwn(r, 'width'), false)
    assert.equal(Object.hasOwn(r, 'height'), false)
    assert.match(String(r.text), /设备物理分辨率 \?x\?/)
  }
})

test('附件像素大小与设备物理分辨率分开返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-shot-size-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from('test-image-bytes'))
  try {
    const attachments = {
      imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 1024 },
      saveImage: async () => ({ attachmentId: 'image-1', mediaType: 'image/png', bytes: 16, width: 320, height: 240 }),
    }
    const llm = { resolveModelInfo: async () => ({ inputModalities: ['image'] }) }
    const r = await shoot({ path, width: 1080, height: 2400 }, { attachments, llm })
    assert.equal(r.width, 1080, '顶层 width 是设备物理宽度')
    assert.equal(r.height, 2400, '顶层 height 是设备物理高度')
    assert.equal(r.image.width, 320, 'image.width 是附件像素宽度')
    assert.equal(r.image.height, 240, 'image.height 是附件像素高度')

    const unknownPath = join(dir, 'unknown-size.png')
    writeFileSync(unknownPath, Buffer.from('test-image-bytes'))
    const unknown = await shoot({ path: unknownPath }, { attachments, llm })
    assert.equal(Object.hasOwn(unknown, 'width'), false, '附件像素不能冒充未知的设备物理宽度')
    assert.equal(Object.hasOwn(unknown, 'height'), false, '附件像素不能冒充未知的设备物理高度')
    assert.match(String(unknown.text), /设备物理分辨率 \?x\?/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
