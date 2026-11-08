import { lstatSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAGE_ROOT = '.deploy-tmp/source-build'
const OUTPUTS = [
  ['termux-package-input-source', 'directory'],
  ['termux-package-artifact', 'directory'],
  ['termux-webroot', 'directory'],
  ['termux-packages-provenance.json', 'file'],
]

function inspectPath(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function resetLocalTermuxStage(root = process.cwd()) {
  const repo = resolve(root)
  const deploy = join(repo, '.deploy-tmp')
  const stage = join(repo, STAGE_ROOT)
  for (const parent of [deploy, stage]) {
    const info = inspectPath(parent)
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new Error(`local Termux stage parent must be a real directory: ${parent}`)
    }
  }
  for (const [name, expected] of OUTPUTS) {
    const target = join(stage, name)
    const info = inspectPath(target)
    if (!info) continue
    if (info.isSymbolicLink() || (expected === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`local Termux stage output has an unexpected type: ${target}`)
    }
    rmSync(target, { recursive: expected === 'directory', force: false })
  }
  return OUTPUTS.map(([name]) => join(stage, name))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = process.argv[2] ? resolve(process.argv[2]) : process.cwd()
  resetLocalTermuxStage(repo)
}
