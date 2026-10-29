import assert from 'node:assert/strict'
import test from 'node:test'
import { prunePublishedTmpFiles } from '../lib/tmp-cache.js'

const dir = '/tmp/pocket-shot-cache-test'
const published = `${dir}/dsh-shot-new.png`

test('发布截图后清理旧缓存并始终保留本次新截图', () => {
  const removed = []
  const times = new Map([
    [`${dir}/dsh-shot-old.png`, 1],
    [`${dir}/dsh-shot-mid.png`, 2],
    [published, 2],
  ])
  prunePublishedTmpFiles(dir, 'dsh-shot-', 2, published, {
    listFiles: () => ['notes.txt', 'dsh-shot-old.png', 'dsh-shot-mid.png', 'dsh-shot-new.png'],
    mtimeMs: (path) => times.get(path),
    remove: (path) => removed.push(path),
  })
  assert.deepEqual(removed, [`${dir}/dsh-shot-old.png`])
})

test('目录枚举返回 null 时删除本次截图并拒绝发布', () => {
  const removed = []
  assert.throws(() => prunePublishedTmpFiles(dir, 'dsh-shot-', 20, published, {
    listFiles: () => null,
    mtimeMs: () => 1,
    remove: (path) => removed.push(path),
  }), /无法确认临时缓存上限（目录枚举未返回文件清单）；本次产物已删除/)
  assert.deepEqual(removed, [published])
})

test('目录枚举抛错时删除本次截图并拒绝发布', () => {
  const removed = []
  assert.throws(() => prunePublishedTmpFiles(dir, 'dsh-shot-', 20, published, {
    listFiles: () => { throw new Error('EACCES') },
    mtimeMs: () => 1,
    remove: (path) => removed.push(path),
  }), /无法确认临时缓存上限（EACCES）；本次产物已删除/)
  assert.deepEqual(removed, [published])
})

test('旧文件清理失败也移除本次截图，避免越过缓存上限发布', () => {
  const removed = []
  assert.throws(() => prunePublishedTmpFiles(dir, 'dsh-shot-', 1, published, {
    listFiles: () => ['dsh-shot-old.png', 'dsh-shot-new.png'],
    mtimeMs: (path) => path === published ? 2 : 1,
    remove: (path) => {
      removed.push(path)
      if (path.endsWith('old.png')) throw new Error('EPERM')
    },
  }), /无法确认临时缓存上限（EPERM）；本次产物已删除/)
  assert.deepEqual(removed, [`${dir}/dsh-shot-old.png`, published])
})

test('stat 失败时 fail-closed 并尽力删除本次截图', () => {
  const removed = []
  assert.throws(() => prunePublishedTmpFiles(dir, 'dsh-shot-', 20, published, {
    listFiles: () => ['dsh-shot-old.png', 'dsh-shot-new.png'],
    mtimeMs: () => { throw new Error('stat failed') },
    remove: (path) => removed.push(path),
  }), /无法确认临时缓存上限（stat failed）；本次产物已删除/)
  assert.deepEqual(removed, [published])
})
