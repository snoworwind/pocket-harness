// Engine patch anchors resolve against published third-party tarballs only;
// first-party packages come from the pinned source export.
import assert from 'node:assert/strict'
import test from 'node:test'
import { collectPublishedTarballs } from './fetch-overlay-tarballs.mjs'

const overlay = {
  rootPackage: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' },
  packages: {
    '@deepseek-ai/dsh-subprocess-local': '0.2.2-rc.1',
    'node-addon-require-builtin': '0.1.9',
    '@deepseek-ai/dsh-app-boot': '0.2.2-rc.1',
    '@deepseek-ai/dsh-fs-local': '0.2.2-rc.1',
  },
  vendorTop: { undici: '8.11.2' },
  pins: { '@earendil-works/pi-ai': '1.3.0' },
  nested: { '@deepseek-ai/dsh-app-boot': { 'vendor-child': '2.0.0' } },
}

const target = (owner, inner = 'lib/index.js') => `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/${owner}/${inner}`

test('only third-party owners of engine patch targets are fetched', () => {
  const registry = {
    patches: [
      { id: 'A', scope: 'engine', target: target('@deepseek-ai/dsh-subprocess-local') },
      { id: 'B', scope: 'engine', target: target('node-addon-require-builtin') },
      { id: 'C', scope: 'engine', target: target('@earendil-works/pi-ai', 'dist/api/openai-completions.js') },
      { id: 'D', scope: 'vendor', target: 'plugins/x/lib/index.js' },
      { id: 'N', scope: 'engine', target: target('@deepseek-ai/dsh-app-boot') },
    ],
    retired: [
      { id: 'E', scope: 'engine', target: target('@deepseek-ai/dsh-fs-local') },
      { id: 'F', scope: 'engine', target: target('@deepseek-ai/dsh-app-boot/node_modules/vendor-child') },
    ],
  }
  const manifest = collectPublishedTarballs(overlay, registry)
  assert.deepEqual(manifest, [
    { name: '@earendil-works/pi-ai', version: '1.3.0' },
    { name: 'node-addon-require-builtin', version: '0.1.9' },
    { name: 'vendor-child', version: '2.0.0' },
  ])
})

test('collection deduplicates versions and skips first-party only inputs', () => {
  const registry = {
    patches: [
      { id: 'A', scope: 'engine', target: target('@earendil-works/pi-ai', 'a.js') },
      { id: 'B', scope: 'engine', target: target('@earendil-works/pi-ai', 'b.js') },
    ],
  }
  assert.deepEqual(collectPublishedTarballs(overlay, registry), [{ name: '@earendil-works/pi-ai', version: '1.3.0' }])
})

test('collection fails closed on an unknown owner or a target outside the engine tree', () => {
  assert.throws(
    () => collectPublishedTarballs(overlay, { patches: [{ id: 'X', scope: 'engine', target: target('unlisted-package') }] }),
    /no package owner/,
  )
  assert.throws(
    () => collectPublishedTarballs(overlay, { patches: [{ id: 'Y', scope: 'engine', target: 'app/src/main/assets/x.js' }] }),
    /escapes the engine tree/,
  )
})
