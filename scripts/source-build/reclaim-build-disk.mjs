#!/usr/bin/env node
/**
 * Reclaim source-build-only trees after the snapshot archive is sealed and
 * before the APK gate/extraction runs.
 *
 * The standard GitHub-hosted Ubuntu runner has a 14 GB disk. The source chain
 * keeps several independent copies of the same inputs alive at once: the pnpm
 * deploy tree, the Harness dependency tree, the Linux rootfs/cargo output, the
 * unpacked snapshot stage, and the archive itself. On 2026-10-18 both replicas
 * reached "free space left: 83 MB" and the snapshot checker failed with ENOSPC
 * while copying the extracted engine into its reference tree.
 *
 * This helper removes only trees that are no longer inputs after the snapshot
 * is sealed. It deliberately keeps:
 *   - .deploy-tmp/snapshot-013/arm64/stage (check-contract reads semantic
 *     version data from it during the APK gate),
 *   - .deploy-tmp/linux-build/native-libs (the APK build packages and verifies
 *     the source-authenticated PRoot launcher, loader and dependencies),
 *   - .deploy-tmp/linux-build/provenance (uploaded as evidence),
 *   - .deploy-tmp/engine-overlay (the checker's hash-bound source tarballs),
 *   - .deploy-tmp/source-build (reports/manifests consumed by later gates).
 *
 * Every target must resolve inside the workspace's real .deploy-tmp directory;
 * a symlinked target is refused rather than followed. The Harness source tree
 * is no longer needed after the snapshot is sealed, so remove that complete
 * temporary tree. This also handles trusted cache materializations, which
 * intentionally omit .git; invoking git there could discover the parent app
 * repository instead of a nested Harness checkout.
 *
 * Usage:
 *   node scripts/source-build/reclaim-build-disk.mjs [--root <workspace>] [--check-only]
 *   node scripts/source-build/reclaim-build-disk.mjs --self-test
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_MIN_FREE_MB = 4096

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function assertWithin(parent, child, label, { allowEqual = false } = {}) {
  const rel = relative(parent, child)
  if ((!allowEqual && rel === '') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes ${parent}: ${child}`)
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Resolve a target without following it. If any existing ancestor is a symlink,
 * its real path must still be inside the deploy root; this rejects a symlinked
 * `engine-deploy` or a symlinked parent before rmSync can touch anything.
 */
function safeTarget(deployReal, target) {
  const lexical = resolve(target)
  assertWithin(deployReal, lexical, 'reclaim target')
  const targetInfo = lstatIfPresent(lexical)
  if (targetInfo?.isSymbolicLink()) {
    throw new Error(`refuses symlinked reclaim target: ${lexical}`)
  }
  let ancestor = lexical
  while (!lstatIfPresent(ancestor)) ancestor = dirname(ancestor)
  const ancestorReal = realpathSync(ancestor)
  assertWithin(deployReal, ancestorReal, 'reclaim target ancestor', { allowEqual: true })
  if (ancestorReal !== ancestor) {
    throw new Error(`refuses symlinked reclaim path: ${lexical}`)
  }
  if (targetInfo && realpathSync(lexical) !== lexical) {
    throw new Error(`refuses symlinked reclaim target: ${lexical}`)
  }
  return lexical
}

function removePath(deployReal, target, { checkOnly = false, rootOwned = false } = {}) {
  const path = safeTarget(deployReal, target)
  const info = lstatIfPresent(path)
  if (!info) return false
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error(`refuses non-directory/non-file reclaim target: ${path}`)
  }
  if (rootOwned && process.platform === 'linux') {
    for (const mount of ['dev', 'proc']) {
      const candidate = join(path, mount)
      if (existsSync(candidate) && spawnSync('mountpoint', ['-q', candidate]).status === 0) {
        throw new Error(`refuses to delete a mounted rootfs: ${candidate}`)
      }
    }
  }
  if (checkOnly) {
    console.log(`WOULD REMOVE ${path}`)
    return true
  }
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    if (!rootOwned || process.platform !== 'linux' || !['EACCES', 'EPERM'].includes(error.code)) throw error
    console.log(`sudo rm -rf ${path} (runner-owned tree created by debootstrap)`)
    const result = spawnSync('sudo', ['rm', '-rf', '--', path], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`sudo rm failed for ${path}: ${result.status}`)
  }
  console.log(`REMOVED ${path}`)
  return true
}

function removeHarnessSourceTree(deployReal, checkOnly) {
  const harness = join(deployReal, 'deepseek-harness')
  return removePath(deployReal, harness, { checkOnly })
}

function availableBytes(path) {
  const stats = statfsSync(path)
  return Number(stats.bavail) * Number(stats.bsize)
}

function runProduction() {
  const root = resolve(option('root', process.cwd()))
  const checkOnly = process.argv.includes('--check-only')
  const minFreeMb = Number(option('min-free-mb', String(DEFAULT_MIN_FREE_MB)))
  if (!Number.isFinite(minFreeMb) || minFreeMb < 0) throw new Error(`invalid --min-free-mb: ${minFreeMb}`)
  if (!existsSync(root)) throw new Error(`workspace does not exist: ${root}`)
  const rootReal = realpathSync(root)
  const deploy = join(rootReal, '.deploy-tmp')
  if (!existsSync(deploy)) throw new Error(`workspace has no .deploy-tmp: ${deploy}`)
  const deployReal = realpathSync(deploy)
  if (deployReal !== deploy) throw new Error(`refuses symlinked .deploy-tmp: ${deploy}`)

  const before = availableBytes(rootReal)
  console.log(`available before: ${before} bytes (${(before / 1024 / 1024).toFixed(0)} MiB)`)

  const removals = [
    ['engine-deploy', false],
    ['source-build/ndk', false],
    ['source-build/termux-webroot', false],
    ['source-build/bootstrap-extracted', false],
    ['source-build/node-deb-extracted', false],
  ]
  for (const [rel, rootOwned] of removals) removePath(deployReal, join(deployReal, rel), { checkOnly, rootOwned })

  // The Linux provenance is uploaded. Native libraries are consumed later by
  // APK assembly; other linux-build products are only consumed while assembling
  // the snapshot.
  const linuxBuild = join(deployReal, 'linux-build')
  if (existsSync(linuxBuild)) {
    const safeLinuxBuild = safeTarget(deployReal, linuxBuild)
    for (const entry of readdirSync(safeLinuxBuild)) {
      if (entry === 'provenance' || entry === 'native-libs') continue
      removePath(deployReal, join(safeLinuxBuild, entry), { checkOnly, rootOwned: entry === 'rootfs' })
    }
  }

  removeHarnessSourceTree(deployReal, checkOnly)

  const after = availableBytes(rootReal)
  console.log(`available after: ${after} bytes (${(after / 1024 / 1024).toFixed(0)} MiB)`)
  if (!checkOnly) {
    const floor = minFreeMb * 1024 * 1024
    if (after < floor) {
      throw new Error(`insufficient free space after reclamation: ${after} bytes < ${floor} bytes`
        + ` (${minFreeMb} MiB); free space or raise the runner disk before continuing`)
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result
}

function runChild(args, cwd) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function makeHarnessCheckout(root) {
  const harness = join(root, '.deploy-tmp', 'deepseek-harness')
  mkdirSync(harness, { recursive: true })
  write(join(harness, '.gitignore'), 'node_modules/\n')
  write(join(harness, 'package.json'), '{"name":"fixture","private":true}\n')
  run('git', ['init', '-q'], { cwd: harness })
  run('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: harness })
  run('git', ['config', 'user.name', 'reclaim self-test'], { cwd: harness })
  run('git', ['add', '.gitignore', 'package.json'], { cwd: harness })
  run('git', ['commit', '-qm', 'fixture'], { cwd: harness })
  write(join(harness, 'node_modules', 'heavy.bin'), 'ignored build output\n')
}

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-'))
  try {
    const deploy = join(root, '.deploy-tmp')
    for (const rel of ['engine-deploy', 'source-build/ndk', 'source-build/termux-webroot',
      'source-build/bootstrap-extracted', 'source-build/node-deb-extracted', 'linux-build/assets',
      'linux-build/rootfs', 'linux-build/cargo']) {
      write(join(deploy, rel, 'marker'), `${rel}\n`)
    }
    write(join(deploy, 'linux-build', 'native-libs', 'arm64-v8a', 'libpocketharness_proot.so'), 'launcher\n')
    write(join(deploy, 'linux-build', 'provenance', 'keep.txt'), 'keep provenance\n')
    makeHarnessCheckout(root)

    const positive = runChild(['--root', root, '--min-free-mb', '0'], root)
    if (positive.status !== 0) throw new Error(`positive cleanup failed:\n${positive.stdout}\n${positive.stderr}`)
    for (const rel of ['engine-deploy', 'source-build/ndk', 'source-build/termux-webroot',
      'source-build/bootstrap-extracted', 'source-build/node-deb-extracted', 'linux-build/assets',
      'linux-build/rootfs', 'linux-build/cargo']) {
      if (existsSync(join(deploy, rel))) throw new Error(`positive cleanup left ${rel}`)
    }
    if (!existsSync(join(deploy, 'linux-build', 'provenance', 'keep.txt'))) {
      throw new Error('positive cleanup removed linux-build/provenance')
    }
    if (readFileSync(join(deploy, 'linux-build', 'native-libs', 'arm64-v8a', 'libpocketharness_proot.so'), 'utf8') !== 'launcher\n') {
      throw new Error('positive cleanup removed APK native Linux libraries')
    }
    if (existsSync(join(deploy, 'deepseek-harness'))) {
      throw new Error('positive cleanup left the no-longer-needed Harness source tree')
    }

    // Trusted base materializations intentionally omit nested .git. The old
    // `git -C ... clean` therefore found this fixture's parent repository and
    // tried to clean from inside an ignored path. The cleanup must stay inside
    // .deploy-tmp and must unlink, not follow, links embedded in that tree.
    const cacheRoot = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-cache-'))
    try {
      const cacheDeploy = join(cacheRoot, '.deploy-tmp')
      write(join(cacheRoot, '.gitignore'), '.deploy-tmp/\n')
      write(join(cacheRoot, 'tracked-sentinel.txt'), 'parent repository stays intact\n')
      run('git', ['init', '-q'], { cwd: cacheRoot })
      run('git', ['config', 'user.email', 'self-test@example.invalid'], { cwd: cacheRoot })
      run('git', ['config', 'user.name', 'reclaim self-test'], { cwd: cacheRoot })
      run('git', ['add', '.gitignore', 'tracked-sentinel.txt'], { cwd: cacheRoot })
      run('git', ['commit', '-qm', 'parent fixture'], { cwd: cacheRoot })
      const outside = join(cacheRoot, 'outside')
      write(join(outside, 'keep.txt'), 'outside target remains intact\n')
      write(join(cacheDeploy, 'deepseek-harness', 'package.json'), '{"name":"cached-source"}\n')
      const embeddedLink = join(cacheDeploy, 'deepseek-harness', 'outside-link')
      const inheritedRepository = spawnSync('git',
        ['-C', join(cacheDeploy, 'deepseek-harness'), 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8' })
      if (inheritedRepository.status !== 0
        || realpathSync(inheritedRepository.stdout.trim()) !== realpathSync(cacheRoot)) {
        throw new Error('cached-source fixture did not resolve Git to the parent repository')
      }
      const linkResult = spawnSync(process.platform === 'win32' ? 'cmd' : 'ln',
        process.platform === 'win32' ? ['/c', 'mklink', '/J', embeddedLink, outside] : ['-s', outside, embeddedLink])
      const linkedOutside = linkResult.status === 0 && existsSync(embeddedLink)
      if (!linkedOutside && process.platform !== 'win32') {
        throw new Error(`embedded symlink fixture was not created: ${linkResult.stderr}`)
      }
      const cached = runChild(['--root', cacheRoot, '--min-free-mb', '0'], cacheRoot)
      if (cached.status !== 0) {
        throw new Error(`materialized-cache cleanup failed:\n${cached.stdout}\n${cached.stderr}`)
      }
      if (existsSync(join(cacheDeploy, 'deepseek-harness'))) {
        throw new Error('materialized Harness tree was not removed')
      }
      if (readFileSync(join(cacheRoot, 'tracked-sentinel.txt'), 'utf8') !== 'parent repository stays intact\n') {
        throw new Error('cached-source cleanup changed the parent repository')
      }
      if (linkedOutside && readFileSync(join(outside, 'keep.txt'), 'utf8') !== 'outside target remains intact\n') {
        throw new Error('cached-source cleanup followed an embedded symlink')
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }

    // Controlled negative: a symlinked reclaim target must be refused and the
    // outside directory must be untouched.
    const escapeRoot = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-escape-'))
    try {
      const escapeDeploy = join(escapeRoot, '.deploy-tmp')
      mkdirSync(join(escapeDeploy, 'source-build'), { recursive: true })
      const outside = join(escapeRoot, 'outside')
      write(join(outside, 'keep.txt'), 'outside\n')
      const link = join(escapeDeploy, 'engine-deploy')
      const created = spawnSync(process.platform === 'win32' ? 'cmd' : 'ln',
        process.platform === 'win32' ? ['/c', 'mklink', '/J', link, outside] : ['-s', outside, link])
      const linked = created.status === 0 && existsSync(link)
      if (!linked && process.platform === 'win32') {
        console.log(`SKIP symlink negative control on Windows: ${created.stderr ?? 'junction creation failed'}`)
      } else {
        if (!linked) throw new Error(`symlink fixture was not created: ${created.stderr}`)
        const escaped = runChild(['--root', escapeRoot, '--min-free-mb', '0'], escapeRoot)
        if (escaped.status === 0) throw new Error('symlinked reclaim target was accepted')
        if (!existsSync(join(outside, 'keep.txt'))) throw new Error('symlink escape removed the outside target')
      }
    } finally {
      rmSync(escapeRoot, { recursive: true, force: true })
    }

    // A dangling symlink is still a symlink target and must fail closed; the
    // ordinary existsSync API follows links and would incorrectly call it absent.
    const danglingRoot = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-dangling-'))
    try {
      const deploy = join(danglingRoot, '.deploy-tmp')
      mkdirSync(deploy, { recursive: true })
      const link = join(deploy, 'deepseek-harness')
      const created = spawnSync(process.platform === 'win32' ? 'cmd' : 'ln',
        process.platform === 'win32'
          ? ['/c', 'mklink', '/J', link, join(danglingRoot, 'missing')]
          : ['-s', join(danglingRoot, 'missing'), link])
      if (created.status === 0 && lstatIfPresent(link)?.isSymbolicLink()) {
        const rejected = runChild(['--root', danglingRoot, '--min-free-mb', '0'], danglingRoot)
        if (rejected.status === 0 || !rejected.stderr.includes('refuses symlinked reclaim target')) {
          throw new Error(`dangling reclaim symlink was not explicitly rejected:\n${rejected.stdout}\n${rejected.stderr}`)
        }
      } else if (process.platform !== 'win32') {
        throw new Error(`dangling symlink fixture was not created: ${created.stderr}`)
      }
    } finally {
      rmSync(danglingRoot, { recursive: true, force: true })
    }

    // Controlled negative: --check-only must not remove anything.
    const checkRoot = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-check-'))
    try {
      const checkDeploy = join(checkRoot, '.deploy-tmp')
      write(join(checkDeploy, 'engine-deploy', 'marker'), 'check\n')
      const checked = runChild(['--root', checkRoot, '--check-only', '--min-free-mb', '0'], checkRoot)
      if (checked.status !== 0) throw new Error(`check-only failed:\n${checked.stdout}\n${checked.stderr}`)
      if (!existsSync(join(checkDeploy, 'engine-deploy', 'marker'))) {
        throw new Error('--check-only removed a target')
      }
    } finally {
      rmSync(checkRoot, { recursive: true, force: true })
    }

    // Controlled negative: the free-space floor must fail closed.
    const floorRoot = mkdtempSync(join(tmpdir(), 'reclaim-build-disk-floor-'))
    try {
      write(join(floorRoot, '.deploy-tmp', 'engine-deploy', 'marker'), 'floor\n')
      const floored = runChild(['--root', floorRoot, '--min-free-mb', '999999999'], floorRoot)
      if (floored.status === 0) throw new Error('free-space floor did not fail')
    } finally {
      rmSync(floorRoot, { recursive: true, force: true })
    }

    console.log('RECLAIM-BUILD-DISK SELF-TEST PASSED (positive cleanup, parent-repository isolation, symlink and dangling-link rejection, check-only, free-space floor)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--self-test')) runSelfTest()
else runProduction()
