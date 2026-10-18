import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function verifyLinuxSources(root, manifest) {
  const actual = []
  for (const directory of ['vendor/bionilux', 'vendor/dsh-linux-runtime']) {
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name), stat = lstatSync(file)
        if (stat.isSymbolicLink()) throw new Error('Linux source symlink is forbidden')
        if (stat.isDirectory()) walk(file)
        else actual.push(relative(root, file).replaceAll('\\', '/'))
      }
    }
    walk(join(root, directory))
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('Linux source file set differs from reviewed import')
  for (const file of actual) {
    const bytes = readFileSync(join(root, file))
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[file]) throw new Error('Linux source digest mismatch: ' + file)
  }
  return actual.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--self-test')) execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./check-linux-sources.test.mjs', import.meta.url))], { stdio: 'inherit' })
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/source-build/linux-source-manifest.json')))
  console.log(`Reviewed Linux source bytes verified: ${verifyLinuxSources(root, manifest)} files`)
}
