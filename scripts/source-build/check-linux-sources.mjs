import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function verifyLinuxSources(root, manifest) {
  root = resolve(root)
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Linux source root is unsafe')
  const realRoot = realpathSync(root)
  const safeFile = relativePath => {
    if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/')) {
      throw new Error('Linux source path is not a safe relative path')
    }
    const parts = relativePath.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Linux source path is not normalized')
    let current = root
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index])
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('Linux source symlink is forbidden: ' + relativePath)
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Linux source parent is not a directory: ' + relativePath)
      if (index === parts.length - 1 && !stat.isFile()) throw new Error('Linux source is not a regular file: ' + relativePath)
    }
    const real = realpathSync(current)
    const escaped = relative(realRoot, real)
    if (escaped === '..' || escaped.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || resolve(realRoot, escaped) !== real) {
      throw new Error('Linux source escapes the source root: ' + relativePath)
    }
    return current
  }
  const actual = []
  for (const directory of ['vendor/linux-proot', 'vendor/dsh-linux-runtime']) {
    const walk = dir => {
      const directoryStat = lstatSync(dir)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Linux source directory is unsafe: ' + dir)
      for (const name of readdirSync(dir)) {
        const file = join(dir, name), stat = lstatSync(file)
        if (stat.isSymbolicLink()) throw new Error('Linux source symlink is forbidden')
        if (stat.isDirectory()) walk(file)
        else if (stat.isFile()) actual.push(relative(root, file).replaceAll('\\', '/'))
        else throw new Error('Linux source is not a regular file: ' + relative(root, file))
      }
    }
    walk(safeDirectory(root, realRoot, directory))
  }
  for (const source of manifest.additionalSources ?? []) {
    if (!source || typeof source.directory !== 'string' || !source.files || Array.isArray(source.files) || typeof source.files !== 'object') {
      throw new Error('additional Linux source record is invalid')
    }
    const sourceDirectory = safeDirectory(root, realRoot, source.directory)
    const sourceFiles = []
    const walkAdditional = (directory, prefix = '') => {
      const directoryStat = lstatSync(directory)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error('additional Linux source directory is unsafe: ' + source.directory)
      }
      for (const name of readdirSync(directory)) {
        const file = join(directory, name)
        const stat = lstatSync(file)
        if (stat.isSymbolicLink()) throw new Error('additional Linux source symlink is forbidden: ' + join(prefix, name))
        const relativeName = prefix ? `${prefix}/${name}` : name
        // npm ci and npm run build materialize only these generated directories.
        // They are not compiler source and must not be part of the reviewed import.
        if (!prefix && stat.isDirectory() && ['node_modules', 'lib', '.git'].includes(name)) continue
        if (stat.isDirectory()) walkAdditional(file, relativeName)
        else if (stat.isFile()) sourceFiles.push(`${source.directory}/${relativeName}`)
        else throw new Error('additional Linux source is not a regular file: ' + relativeName)
      }
    }
    walkAdditional(sourceDirectory)
    const declaredFiles = Object.keys(source.files).sort()
    if (JSON.stringify(sourceFiles.sort()) !== JSON.stringify(declaredFiles)) {
      throw new Error('additional Linux source file set differs from reviewed import: ' + source.directory)
    }
    for (const [relativePath, expected] of Object.entries(source.files ?? {})) {
      if (!relativePath.startsWith(source.directory + '/')) throw new Error('additional Linux source path escapes its declared directory')
      const file = safeFile(relativePath)
      if (!relativePath.startsWith(relative(root, sourceDirectory).replaceAll('\\', '/') + '/')) {
        throw new Error('additional Linux source path escapes its resolved directory')
      }
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (digest !== expected) throw new Error('Linux source digest mismatch: ' + relativePath)
      actual.push(relativePath)
    }
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('Linux source file set differs from reviewed import')
  for (const file of actual) {
    const bytes = readFileSync(join(root, file))
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[file]) throw new Error('Linux source digest mismatch: ' + file)
  }
  for (const [file, patch] of Object.entries(manifest.localPatches ?? {})) {
    if (!manifest.files[file] || !/^[0-9a-f]{64}$/.test(patch.upstreamSha256 ?? '') || !patch.reason?.trim()) {
      throw new Error('Linux local source patch is not fully recorded: ' + file)
    }
  }
  return actual.length
}

function safeDirectory(root, realRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new Error('Linux source directory is not a safe relative path')
  }
  const parts = relativePath.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Linux source directory is not normalized')
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Linux source directory is unsafe: ' + relativePath)
  }
  const real = realpathSync(current)
  const escaped = relative(realRoot, real)
  if (escaped === '..' || escaped.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || resolve(realRoot, escaped) !== real) {
    throw new Error('Linux source directory escapes the source root: ' + relativePath)
  }
  return current
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--self-test')) execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./check-linux-sources.test.mjs', import.meta.url))], { stdio: 'inherit' })
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/source-build/linux-source-manifest.json')))
  console.log(`Reviewed Linux source bytes verified: ${verifyLinuxSources(root, manifest)} files`)
}
