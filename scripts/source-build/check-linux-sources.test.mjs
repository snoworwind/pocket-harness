import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyLinuxSources } from './check-linux-sources.mjs'

test('reviewed bootstrap lock bytes survive autocrlf checkout; removing the attribute changes its digest', () => {
  const attributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8')
  const bytes = readFileSync(new URL('../../plugins/dsh-linux-bootstrap/package-lock.json', import.meta.url))
  const hash = value => createHash('sha256').update(value).digest('hex')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key]
  for (const negative of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'linux-lock-eol-'))
    const lock = join(root, 'plugins/dsh-linux-bootstrap/package-lock.json')
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'pipe' })
    try {
      git('init', '-q')
      git('config', 'core.autocrlf', 'true')
      mkdirSync(join(root, 'plugins/dsh-linux-bootstrap'), { recursive: true })
      writeFileSync(join(root, '.gitattributes'), negative ? attributes.replace(/^plugins\/dsh-linux-bootstrap\/package-lock\.json -text\r?\n/m, '') : attributes)
      writeFileSync(lock, bytes)
      git('add', '.')
      rmSync(lock)
      git('checkout-index', '--force', '--all')
      assert.equal(hash(readFileSync(lock)) === hash(bytes), !negative)
      assert.equal(readFileSync(lock, 'utf8').replaceAll('\r\n', '\n'), bytes.toString())
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('reviewed source import rejects equal-size poison and unregistered compiler input', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-source-pins-'))
  const files = { 'vendor/linux-proot/compat/termfold_compat.c': 'trusted', 'vendor/dsh-linux-runtime/index.js': 'trusted' }
  const manifest = { files: {}, additionalSources: [{ directory: 'plugins/dsh-linux-bootstrap', files: {} }] }
  try {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), body)
      manifest.files[file] = createHash('sha256').update(body).digest('hex')
    }
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap'), { recursive: true })
    const bootstrapFile = 'plugins/dsh-linux-bootstrap/src/index.js'
    mkdirSync(join(root, bootstrapFile, '..'), { recursive: true })
    writeFileSync(join(root, bootstrapFile), 'trusted bootstrap')
    manifest.additionalSources[0].files[bootstrapFile] = createHash('sha256').update('trusted bootstrap').digest('hex')
    manifest.files[bootstrapFile] = createHash('sha256').update('trusted bootstrap').digest('hex')
    assert.equal(verifyLinuxSources(root, manifest), 3)
    writeFileSync(join(root, bootstrapFile), 'trusted bootstraps')
    assert.throws(() => verifyLinuxSources(root, manifest), /digest mismatch: plugins\/dsh-linux-bootstrap/)
    writeFileSync(join(root, bootstrapFile), 'trusted bootstrap')
    writeFileSync(join(root, 'vendor/linux-proot/compat/termfold_compat.c'), 'poison!')
    assert.throws(() => verifyLinuxSources(root, manifest), /digest mismatch/)
    writeFileSync(join(root, 'vendor/linux-proot/compat/termfold_compat.c'), 'trusted')
    writeFileSync(join(root, 'vendor/linux-proot/compat/extra.c'), 'unreviewed input')
    assert.throws(() => verifyLinuxSources(root, manifest), /file set differs/)
    rmSync(join(root, 'vendor/linux-proot/compat/extra.c'))
    writeFileSync(join(root, 'plugins/dsh-linux-bootstrap/src/extra.js'), 'unregistered build input')
    assert.throws(() => verifyLinuxSources(root, manifest), /additional Linux source file set differs/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('generated bootstrap lib and node_modules are excluded, but symlinks are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-source-generated-'))
  const outside = mkdtempSync(join(tmpdir(), 'linux-source-generated-outside-'))
  const files = { 'vendor/linux-proot/compat/termfold_compat.c': 'trusted', 'vendor/dsh-linux-runtime/index.js': 'trusted' }
  const bootstrapFile = 'plugins/dsh-linux-bootstrap/src/index.js'
  const manifest = { files: {}, additionalSources: [{ directory: 'plugins/dsh-linux-bootstrap', files: {} }] }
  try {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), body)
      manifest.files[file] = createHash('sha256').update(body).digest('hex')
    }
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap'), { recursive: true })
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap/src'), { recursive: true })
    writeFileSync(join(root, bootstrapFile), 'trusted bootstrap')
    manifest.additionalSources[0].files[bootstrapFile] = createHash('sha256').update('trusted bootstrap').digest('hex')
    manifest.files[bootstrapFile] = manifest.additionalSources[0].files[bootstrapFile]
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap/lib'), { recursive: true })
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap/node_modules/package'), { recursive: true })
    writeFileSync(join(root, 'plugins/dsh-linux-bootstrap/lib/generated.js'), 'generated')
    writeFileSync(join(root, 'plugins/dsh-linux-bootstrap/node_modules/package/index.js'), 'installed dependency')
    assert.equal(verifyLinuxSources(root, manifest), 3)
    writeFileSync(join(outside, 'extra.js'), 'external source')
    symlinkSync(join(outside, 'extra.js'), join(root, 'plugins/dsh-linux-bootstrap/src/extra.js'))
    assert.throws(() => verifyLinuxSources(root, manifest), /additional Linux source symlink is forbidden/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('reviewed source import rejects symlinked vendor roots and bootstrap input ancestors', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-source-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'linux-source-outside-'))
  const files = { 'vendor/linux-proot/compat/termfold_compat.c': 'trusted', 'vendor/dsh-linux-runtime/index.js': 'trusted' }
  const bootstrapFile = 'plugins/dsh-linux-bootstrap/src/index.js'
  const manifest = {
    files: {},
    additionalSources: [{ directory: 'plugins/dsh-linux-bootstrap', files: {} }],
  }
  try {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), body)
      manifest.files[file] = createHash('sha256').update(body).digest('hex')
    }
    mkdirSync(join(root, 'plugins/dsh-linux-bootstrap'), { recursive: true })
    mkdirSync(join(outside, 'src'), { recursive: true })
    writeFileSync(join(outside, 'src/index.js'), 'trusted bootstrap')
    manifest.additionalSources[0].files[bootstrapFile] = createHash('sha256').update('trusted bootstrap').digest('hex')
    manifest.files[bootstrapFile] = manifest.additionalSources[0].files[bootstrapFile]
    symlinkSync(outside, join(root, 'plugins/dsh-linux-bootstrap/src'), 'dir')
    assert.throws(() => verifyLinuxSources(root, manifest), /Linux source symlink is forbidden|Linux source directory is unsafe/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
