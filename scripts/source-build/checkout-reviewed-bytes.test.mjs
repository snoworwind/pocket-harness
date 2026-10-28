import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const attributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8')
const paths = [
  'dsh-client-ui-responsive/src/client/mobile/upstream-browser/view/Browser.module.css',
  'plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json',
  'vendor/dsh-undo-savepoint/lib/core.mjs',
]
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name]

test('reviewed inputs survive autocrlf checkout; omitted attributes are detected', () => {
  for (const path of paths) {
    const bytes = readFileSync(new URL('../../' + path, import.meta.url))
    for (const negative of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'reviewed-checkout-'))
      const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'pipe' })
      try {
        git('init', '-q')
        git('config', 'core.autocrlf', 'true')
        const target = join(root, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(join(root, '.gitattributes'), negative ? attributes.replace(path + ' -text\n', '') : attributes)
        writeFileSync(target, bytes)
        git('add', '.')
        rmSync(target)
        git('checkout-index', '--force', '--all')
        assert.equal(readFileSync(target).equals(bytes), !negative, path + ' negative=' + negative)
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  }
})

test('vendored browser stylesheet matches its registered upstream digest', () => {
  const metadata = JSON.parse(readFileSync(new URL('../../dsh-client-ui-responsive/src/client/mobile/upstream-browser/SOURCE.json', import.meta.url), 'utf8'))
  const expected = metadata.files.find(entry => entry.source.endsWith('/view/Browser.module.css'))?.sha256
  const css = readFileSync(new URL('../../' + paths[0], import.meta.url))
  assert.ok(expected)
  assert.equal(createHash('sha256').update(css).digest('hex'), expected)
})
