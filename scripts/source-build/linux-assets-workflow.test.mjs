import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const workspacePrefix = '${{ github.workspace }}'
const readWorkflow = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')

function checkSourceBackend(source) {
  assert.match(source, /NDK_ROOT:/)
  const build = readFileSync(new URL('./build-linux-assets.sh', import.meta.url), 'utf8')
  assert.ok(build.indexOf('build-proot-source.py "$PROOT_SOURCES"') < build.indexOf('prepare-proot-source-backend.py \\'))
  assert.doesNotMatch(source.slice(source.indexOf('name: Build source-owned offline ARM64 Linux assets')), /TERMUX_WEBROOT:|TERMUX_PROVENANCE:|TERMUX_BOOTSTRAP:/)
}

test('both asset consumers build PRoot from pinned source with NDK', () => {
  for (const name of ['build-linux-assets.yml', 'build-apk-source.yml']) checkSourceBackend(readWorkflow(name))
  assert.doesNotMatch(readWorkflow('build-linux-assets.yml'), /prepare-termux-signed-repo.py --/)
})

test('negative control rejects missing source toolchain', () => {
  assert.throws(() => checkSourceBackend(readWorkflow('build-linux-assets.yml').replaceAll('NDK_ROOT:', 'REMOVED:')), assert.AssertionError)
})

function checkLinuxAssetDownloads(source) {
  assert.match(source, /npm ci --no-audit --no-fund --fetch-retries=8 --fetch-retry-factor=2 \\\n\s+--fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000/,
    'the source-built Node addon dependency install must retry registry 5xx with a finite timeout')
  assert.match(source, /bash scripts\/source-build\/retry-curl\.sh --fail --location --retry 8 --retry-max-time 600 "\$DEBIAN_SNAPSHOT\/dists\/trixie\/InRelease"/,
    'the signed Debian Release metadata download must tolerate transient gateway errors')
  assert.match(source, /bash scripts\/source-build\/retry-curl\.sh --fail --location --retry 8 --retry-max-time 600 "https:\/\/nodejs\.org\/dist\/v\$NODE_VERSION\/node-v\$NODE_VERSION-linux-arm64\.tar\.xz"/,
    'the fixed Node.js asset download must use the bounded retry window')
  assert.match(source, /printf '%s  %s\\n' "\$DEBIAN_SHA" "\$WORK\/input\/debian-InRelease" \| sha256sum --check --strict/,
    'retrying the Release download must not bypass its existing digest check')
  assert.match(source, /printf '%s  %s\\n' "\$NODE_SHA" "\$NODE_ARCHIVE" \| sha256sum --check --strict/,
    'retrying Node.js must not bypass its existing digest check')
}

test('pinned Linux asset downloads retry transient failures and still verify fixed digests', () => {
  checkLinuxAssetDownloads(readFileSync(new URL('./build-linux-assets.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
})

test('negative controls reject short retry windows or missing pinned asset digest checks', () => {
  const source = readFileSync(new URL('./build-linux-assets.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  for (const bad of [
    source.replace('bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "$DEBIAN_SNAPSHOT/dists/trixie/InRelease"',
      'curl --fail --location --retry 3 "$DEBIAN_SNAPSHOT/dists/trixie/InRelease"'),
    source.replace('bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"',
      'curl --fail --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"'),
    source.replace('--fetch-retries=8 --fetch-retry-factor=2', '--fetch-retries=2 --fetch-retry-factor=2'),
    source.replace('printf \'%s  %s\\n\' "$DEBIAN_SHA" "$WORK/input/debian-InRelease" | sha256sum --check --strict', '# missing Debian Release digest check'),
    source.replace('printf \'%s  %s\\n\' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum --check --strict', '# missing Node archive digest check'),
  ]) assert.throws(() => checkLinuxAssetDownloads(bad), assert.AssertionError)
})

function checkLinuxAssetWorkflowDownloads(source) {
  const npmCi = source.match(/^\s+npm ci --prefix .*$/gm) ?? []
  assert.equal(npmCi.length, 4, 'the standalone asset workflow must keep all four reviewed npm install steps')
  assert.ok(npmCi.every(line => line.includes('--fetch-retries=8 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000')),
    'each standalone Linux plugin dependency install must use the bounded registry retry policy')
  assert.equal((source.match(/--retry 8 --retry-max-time 600/g) ?? []).length, 3,
    'NDK ZIP and both Debian signing-key downloads need the extended bounded retry window')
  assert.equal((source.match(/bash scripts\/source-build\/retry-curl\.sh/g) ?? []).length, 3,
    'all fixed Linux asset workflow downloads must retry known curl transport errors')
  assert.match(source, /sha1sum --check --strict/,
    'the official NDK archive must retain its pinned digest check')
  assert.match(source, /printf '%s  %s\\n%s  %s\\n' "\$archive_sha" "\$keydir\/archive-key-13\.asc" "\$release_sha" "\$keydir\/release-13\.asc" \| sha256sum --check --strict/,
    'the Debian key retries must remain protected by both pinned digests')
}

test('standalone Linux asset workflow retries pinned downloads without weakening digest checks', () => {
  checkLinuxAssetWorkflowDownloads(readWorkflow('build-linux-assets.yml').replaceAll('\r\n', '\n'))
})

test('negative controls reject short standalone asset retries and removed digest checks', () => {
  const source = readWorkflow('build-linux-assets.yml').replaceAll('\r\n', '\n')
  for (const bad of [
    source.replace('--fetch-retries=8 --fetch-retry-factor=2', '--fetch-retries=2 --fetch-retry-factor=2'),
    source.replace('--retry 8 --retry-max-time 600', '--retry 3'),
    source.replace('bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 https://ftp-master.debian.org/keys/archive-key-13.asc', 'curl --fail --location --retry 3 https://ftp-master.debian.org/keys/archive-key-13.asc'),
    source.replace('sha1sum --check --strict', '# NDK digest omitted'),
    source.replace('printf \'%s  %s\\n%s  %s\\n\' "$archive_sha" "$keydir/archive-key-13.asc" "$release_sha" "$keydir/release-13.asc" | sha256sum --check --strict', '# signing key digests omitted'),
  ]) assert.throws(() => checkLinuxAssetWorkflowDownloads(bad), assert.AssertionError)
})

function checkSourceArchiveInputs(source) {
  const inputs = source.split('SOURCE_PROOF_INPUTS=(')[1].split('\n)')[0].split(/\s+/)
  for (const required of ['LICENSE', 'LICENSES',
    'scripts/source-build/test_native_runtime_inventory.py',
    'scripts/source-build/proot_source_provenance.py',
    'scripts/source-build/prepare-proot-source-backend.py']) {
    assert.ok(inputs.includes(required), `source archive must retain ${required}`)
  }
}

test('source archive retains adapter license and build/test dependency inputs', () => {
  const source = readFileSync(new URL('./build-linux-assets.sh', import.meta.url), 'utf8')
  checkSourceArchiveInputs(source)
  for (const required of [' LICENSE LICENSES ', 'scripts/source-build/test_native_runtime_inventory.py']) {
    assert.throws(() => checkSourceArchiveInputs(source.replace(required, ' ')), assert.AssertionError)
  }
})
