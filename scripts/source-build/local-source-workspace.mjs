import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MARKER = '.dsh-local-source-workspace.json'
const gitEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' }
for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name]
const git = (root, ...args) => execFileSync('git', ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-C', root, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function canonicalPath(path, links = new Set()) {
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(canonicalPath(dirname(path), links), basename(path))
  }
  if (info.isSymbolicLink()) {
    if (links.has(path)) throw new Error(`来源构建路径包含循环链接：${path}`)
    links.add(path)
    return canonicalPath(resolve(dirname(path), readlinkSync(path)), links)
  }
  return realpathSync(path)
}

function contains(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

// These are host write/cleanup roots in build-apk-source.yml. Check each root,
// not just .deploy-tmp: a resumed checkout can contain a nested directory link.
// Do not reject all runtime links: bootstrap extraction intentionally retains
// Android /data/data/com.termux links until the snapshot sanitizer runs.
function rejectEscapedWriteRoots(workspace) {
  const writeRoots = [
    '.deploy-tmp', 'scripts', 'vendor', 'plugins', 'dsh-shell-termux',
    'dsh-client-ui-responsive', 'dsh-host-web-compat', 'out', 'base', 'app',
  ]
  for (const path of writeRoots) {
    if (!contains(workspace, canonicalPath(join(workspace, path)))) throw new Error(`来源构建写入路径逃出隔离目录：${path}`)
  }
  // Resolve internal aliases, but visit every physical directory only once:
  // an internal reports alias must not hide an escaping leaf, while pnpm's
  // dependency graph must not cause exponential traversal. Raw Android links
  // are permitted only in the concrete staging trees that produce them.
  const androidStagingRoots = [
    '.deploy-tmp/source-build/bootstrap-extracted/usr',
    '.deploy-tmp/source-build/node-deb-extracted/data/data/com.termux/files/usr',
    '.deploy-tmp/arm64-base/.bootstrap-stage/termux',
    '.deploy-tmp/arm64-base/.bootstrap-stage/base/usr',
    '.deploy-tmp/snapshot-013/arm64/stage/root',
  ].map(path => join(workspace, path))
  const visited = new Set()
  const scan = directory => {
    directory = realpathSync(directory)
    if (visited.has(directory)) return
    visited.add(directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = canonicalPath(path)
        // Snapshot relocation changes Termux's prefix to the shell app's
        // /data/user/0 prefix. Resolve relative aliases such as rvim -> vim
        // before applying the same narrow runtime exemption.
        const androidRuntimeLink = ['/data/data/com.termux/files/usr/', '/data/user/0/com.dsharnessmobile.shell/files/usr/']
          .some(prefix => target.startsWith(prefix)) && !existsSync(target)
          && androidStagingRoots.some(root => contains(root, path))
        if (!androidRuntimeLink && !contains(workspace, target)) {
          throw new Error(`来源构建写入路径逃出隔离目录：${relative(workspace, path)}`)
        }
        if (!androidRuntimeLink && existsSync(path) && statSync(path).isDirectory()) scan(path)
      } else if (entry.isDirectory()) scan(path)
    }
  }
  for (const root of writeRoots) {
    const path = join(workspace, root)
    if (existsSync(path)) scan(path)
  }
}

function rejectSourceLinks(workspace, sourceRoot, directory = workspace) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        const worktree = canonicalPath(git(directory, 'rev-parse', '--show-toplevel'))
        if (contains(sourceRoot, worktree) || contains(worktree, sourceRoot)) throw new Error(`来源构建 Git 工作树可触及原仓：${relative(workspace, path)}`)
      }
      rejectSourceLinks(workspace, sourceRoot, path)
    }
    else if (entry.isSymbolicLink()) {
      const target = canonicalPath(resolve(directory, readlinkSync(path)))
      if (contains(sourceRoot, target) || contains(target, sourceRoot)) throw new Error(`来源构建链接可触及原工作树：${relative(workspace, path)}`)
    } else if (entry.name === '.git' && entry.isFile()) {
      const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(path, 'utf8'))?.[1]
      if (gitdir) {
        const target = canonicalPath(resolve(directory, gitdir.trim()))
        if (contains(sourceRoot, target) || contains(target, sourceRoot)) throw new Error(`来源构建 Git 链接可触及原工作树：${relative(workspace, path)}`)
      }
    }
  }
}

export function sourceCommit(source) {
  return git(source, 'rev-parse', 'HEAD')
}

export function committedWorkflow(source, commit) {
  return git(source, 'show', `${commit}:.github/workflows/build-apk-source.yml`)
}

/** A private shallow checkout keeps workflow cleanup away from developer files. */
export function prepareSourceWorkspace(source, commit, requested = null) {
  const sourceRoot = realpathSync(source)
  const tempRoot = canonicalPath(tmpdir())
  if (!requested && contains(sourceRoot, tempRoot)) throw new Error('临时目录位于原工作树内；请用 --build-workspace 指定外部目录。')
  const workspace = requested ? canonicalPath(resolve(requested)) : mkdtempSync(join(tempRoot, 'dsh-source-chain-'))
  if (contains(sourceRoot, workspace) || contains(workspace, sourceRoot)) {
    throw new Error('来源构建目录必须在原工作树之外，且不能是它的父目录。')
  }
  const marker = join(workspace, MARKER)
  if (existsSync(workspace) && readdirSync(workspace).length) {
    if (!existsSync(marker)) throw new Error(`拒绝使用非空且未登记的来源构建目录：${workspace}`)
    const saved = JSON.parse(readFileSync(marker, 'utf8'))
    if (saved.source !== sourceRoot || saved.commit !== commit || saved.schema !== 1) {
      throw new Error('来源构建目录的原仓或 HEAD 不匹配；请指定新的空目录。')
    }
    // A worktree or linked .git would let destructive steps reach the source repository.
    if (!statSync(join(workspace, '.git')).isDirectory() || realpathSync(join(workspace, '.git')) !== join(workspace, '.git') || existsSync(join(workspace, '.git/commondir')) || existsSync(join(workspace, '.git/objects/info/alternates')) || git(workspace, 'rev-parse', '--show-toplevel') !== workspace || sourceCommit(workspace) !== commit) {
      throw new Error('来源构建目录不再是登记 HEAD 的独立 Git 检出。')
    }
    rejectEscapedWriteRoots(workspace)
    rejectSourceLinks(workspace, sourceRoot)
    return workspace
  }
  mkdirSync(workspace, { recursive: true })
  // Fetch only this commit, without copying LFS objects or historical runtime archives.
  // LFS stays as pointers, matching the source workflow checkout (lfs: false).
  git(workspace, 'init', '-q')
  git(workspace, 'fetch', '--depth=1', '--no-tags', sourceRoot, commit)
  git(workspace, 'checkout', '--detach', commit)
  rejectEscapedWriteRoots(workspace)
  rejectSourceLinks(workspace, sourceRoot)
  writeFileSync(marker, JSON.stringify({ schema: 1, source: sourceRoot, commit }, null, 2) + '\n', { flag: 'wx' })
  return workspace
}
