import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

/** Dependency directories have a separate provenance check; package-owned payload is exact. */
export function packagePayload(root, allowedRoot = root) {
  const physical = realpathSync(allowedRoot)
  const files = new Map()
  const active = new Set()
  function walk(dir, prefix = '') {
    const directory = realpathSync(dir)
    if (active.has(directory)) throw new Error('Cyclic package payload link')
    active.add(directory)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      const name = prefix + entry.name
      const info = lstatSync(path)
      const target = realpathSync(path)
      const rel = relative(physical, target)
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`Payload link escapes package: ${name}`)
      const resolved = info.isSymbolicLink() ? lstatSync(target) : info
      if (resolved.isDirectory()) walk(path, name + '/')
      else if (resolved.isFile()) {
        // Audit runtime code/data and dispatch metadata. Source maps and declarations
        // are deliberately stripped by slim.json; pnpm also adds workspace YAML.
        if (!/\.(?:js|cjs|mjs|json|wasm|node)$/.test(name)) continue
        let bytes = readFileSync(path)
        if (name === 'package.json') {
          const manifest = JSON.parse(bytes)
          // pnpm rewrites dependency metadata. Resolution entrypoints remain source-owned.
          bytes = Buffer.from(JSON.stringify(Object.fromEntries(
            ['name', 'version', 'type', 'main', 'module', 'exports', 'imports', 'bin'].map(key => [key, manifest[key]]),
          )))
        }
        files.set(name, createHash('sha256').update(bytes).digest('hex'))
      } else throw new Error(`Unexpected special payload file: ${name}`)
    }
    active.delete(directory)
  }
  walk(root)
  return files
}

export function verifyPackagePayload(expected, actual, label, allowedRoot = actual) {
  const a = packagePayload(expected)
  const b = packagePayload(actual, allowedRoot)
  if (a.size !== b.size) throw new Error(`${label}: payload file set mismatch`)
  for (const [file, digest] of a) {
    if (b.get(file) !== digest) throw new Error(`${label}: payload bytes differ: ${file}`)
  }
  return a.size
}
