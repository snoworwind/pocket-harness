import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTermuxIndex } from './termux-index.mjs'

const stanza = (name, version, filename, depends = '') => [
  `Package: ${name}`,
  `Version: ${version}`,
  `Architecture: aarch64`,
  ...(depends ? [`Depends: ${depends}`] : []),
  `Filename: ${filename}`,
  `SHA256: ${'0'.repeat(64)}`,
  'Size: 10',
  '',
].join('\n')

test('keeps the newest stanza when a rolling repository republishes an older version last', () => {
  // Measured 2026-11-09: Termux published libicu 79.1 first and 78.3 second. The offline
  // mirror only carried 79.1, so last-stanza-wins asked for a file that did not exist.
  const index = [
    stanza('libicu', '79.1', 'pool/main/libi/libicu/libicu_79.1_aarch64.deb'),
    stanza('libicu', '78.3', 'pool/main/libi/libicu/libicu_78.3_aarch64.deb'),
    stanza('nodejs-lts', '24.22.2', 'pool/main/n/nodejs-lts/nodejs-lts_24.22.2_aarch64.deb', 'libicu, openssl'),
  ].join('\n')
  const { pkgs, rawBlocks } = parseTermuxIndex(index)
  assert.equal(pkgs.size, 2)
  assert.equal(pkgs.get('libicu').version, '79.1')
  assert.equal(pkgs.get('libicu').filename, 'pool/main/libi/libicu/libicu_79.1_aarch64.deb')
  assert.match(rawBlocks.get('libicu'), /Version: 79\.1/)
  assert.deepEqual(pkgs.get('nodejs-lts').depends, ['libicu', 'openssl'])
})

test('keeps a newer republished stanza that arrives last', () => {
  const index = [
    stanza('libicu', '78.3', 'pool/main/libi/libicu/libicu_78.3_aarch64.deb'),
    stanza('libicu', '79.1', 'pool/main/libi/libicu/libicu_79.1_aarch64.deb'),
  ].join('\n')
  const { pkgs } = parseTermuxIndex(index)
  assert.equal(pkgs.get('libicu').version, '79.1')
})

test('strips version constraints and keeps the first branch of an alternative', () => {
  const index = stanza('python', '3.14.10', 'pool/main/p/python/python_3.14.10_aarch64.deb',
    'libc++ (>= 1.0), libffi | libffi7, openssl, zlib')
  const { pkgs } = parseTermuxIndex(index)
  assert.deepEqual(pkgs.get('python').depends, ['libc++', 'libffi', 'openssl', 'zlib'])
})
