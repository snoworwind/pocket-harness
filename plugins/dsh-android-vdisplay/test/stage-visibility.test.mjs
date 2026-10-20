import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasBlockingStageOverlay, watchStageVisibility } from '../src/client/stage-visibility.ts'

const JSDOM_CANDIDATES = [
  '../../../dsh-client-ui-responsive/node_modules/jsdom/lib/api.js',
  '../../../dsh-mobile-apk/node_modules/jsdom/lib/api.js',
  '../../../node_modules/jsdom/lib/api.js',
]
let JSDOM
for (const candidate of JSDOM_CANDIDATES) {
  const path = fileURLToPath(new URL(candidate, import.meta.url))
  if (existsSync(path)) { ({ JSDOM } = await import(pathToFileURL(path).href)); break }
}
const SKIP = JSDOM === undefined

function setup() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const { document: doc } = dom.window
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 400 })
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 })
  return { dom, doc, view: dom.window }
}

function setBounds(element, { left = 10, top = 10, width = 120, height = 80 } = {}) {
  element.getBoundingClientRect = () => ({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    toJSON: () => ({}),
  })
}

function installFrameQueue(view) {
  let nextId = 1
  const frames = new Map()
  const cancelled = []
  view.requestAnimationFrame = (callback) => {
    const id = nextId++
    frames.set(id, callback)
    return id
  }
  view.cancelAnimationFrame = (id) => { cancelled.push(id); frames.delete(id) }
  return { frames, cancelled, flush() {
    const entry = frames.entries().next().value
    assert.ok(entry, '预期有待执行的动画帧')
    const [id, callback] = entry
    frames.delete(id)
    callback(0)
  } }
}

const nextMutationTurn = () => new Promise((resolve) => setImmediate(resolve))

test('侧栏气泡 open/closing 期间隐藏原生虚拟屏，closed 后恢复', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { dom, doc, view } = setup()
  const bubble = doc.createElement('div')
  for (const state of ['open', 'closing']) {
    bubble.setAttribute('data-dsh-sidebar-bubbles', state)
    doc.body.append(bubble)
    assert.equal(hasBlockingStageOverlay(doc, view), true, state + ' 必须阻挡原生面')
    bubble.remove()
  }
  bubble.setAttribute('data-dsh-sidebar-bubbles', 'closed')
  doc.body.append(bubble)
  assert.equal(hasBlockingStageOverlay(doc, view), false)
  dom.window.close()
})

test('只阻挡视口内实际可见的菜单/对话框/listbox，隐藏或离屏节点不阻挡', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { dom, doc, view } = setup()
  const hiddenParent = doc.createElement('div')
  hiddenParent.style.display = 'none'
  const hiddenMenu = doc.createElement('div')
  hiddenMenu.setAttribute('role', 'menu')
  setBounds(hiddenMenu)
  hiddenParent.append(hiddenMenu)
  doc.body.append(hiddenParent)
  assert.equal(hasBlockingStageOverlay(doc, view), false)

  hiddenParent.style.display = ''
  setBounds(hiddenMenu, { left: 450 })
  assert.equal(hasBlockingStageOverlay(doc, view), false)

  setBounds(hiddenMenu)
  assert.equal(hasBlockingStageOverlay(doc, view), true)
  dom.window.close()
})

test('原生面还会让出给现有 dockkit 指针浮层', { skip: SKIP && 'jsdom 不可用' }, () => {
  const { dom, doc, view } = setup()
  const pointer = doc.createElement('div')
  pointer.setAttribute('data-dockkit-pointer', '')
  doc.body.append(pointer)
  assert.equal(hasBlockingStageOverlay(doc, view), true)
  dom.window.close()
})

test('DOM 属性变更在下一帧合并发布，卸载会断开观察并取消待处理帧', { skip: SKIP && 'jsdom 不可用' }, async () => {
  const { dom, doc, view } = setup()
  const queue = installFrameQueue(view)
  const published = []
  const unwatch = watchStageVisibility(doc, view, () => published.push('publish'))

  const bubble = doc.createElement('div')
  doc.body.append(bubble)
  bubble.setAttribute('data-dsh-sidebar-bubbles', 'open')
  await nextMutationTurn()
  assert.equal(queue.frames.size, 1, '新增节点和属性变化应合并到同一帧')
  queue.flush()
  assert.deepEqual(published, ['publish'])

  const menu = doc.createElement('div')
  setBounds(menu)
  doc.body.append(menu)
  menu.setAttribute('role', 'menu')
  await nextMutationTurn()
  assert.equal(queue.frames.size, 1, 'role 变化应触发观察')
  queue.flush()
  assert.equal(published.length, 2)

  menu.classList.add('closing')
  await nextMutationTurn()
  assert.equal(queue.frames.size, 1)
  unwatch()
  assert.equal(queue.frames.size, 0)
  assert.equal(queue.cancelled.length, 1)

  menu.classList.remove('closing')
  doc.dispatchEvent(new view.Event('visibilitychange'))
  await nextMutationTurn()
  assert.equal(queue.frames.size, 0, '卸载后不应残留观察或事件监听')
  assert.equal(published.length, 2)
  dom.window.close()
})

test('没有 MutationObserver 时仍保留页面可见性事件通道', { skip: SKIP && 'jsdom 不可用' }, async () => {
  const { dom, doc, view } = setup()
  view.MutationObserver = undefined
  const queue = installFrameQueue(view)
  let count = 0
  const unwatch = watchStageVisibility(doc, view, () => { count++ })
  doc.dispatchEvent(new view.Event('visibilitychange'))
  await nextMutationTurn()
  assert.equal(queue.frames.size, 1)
  queue.flush()
  assert.equal(count, 1)
  unwatch()
  dom.window.close()
})
