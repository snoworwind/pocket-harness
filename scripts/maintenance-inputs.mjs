import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const INPUT = /^(app\/build\.gradle\.kts|build\.gradle\.kts|gradle\/wrapper\/gradle-wrapper\.properties|scripts\/patches\/registry\.json|scripts\/(check-maintenance-docs|maintenance-inputs)\.mjs|scripts\/tests\/maintenance-(docs|inputs)\.test\.mjs|docs\/AGENTS\/(DEPENDENCIES|RUNTIME-PATCHES)\.md)$/

export function maintenanceInputsChanged(root, base, head = 'HEAD') {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // Push.before can refer to a removed root after an independent import/force push.
  // Missing history means scan the current tree, never silently skip verification.
  let available = /^[a-f0-9]{40}$/.test(base ?? '') && !/^0+$/.test(base)
  if (available) {
    try { git('cat-file', '-e', `${base}^{commit}`) } catch { available = false }
  }
  const paths = available ? git('diff', '--name-only', '-z', base, head) : git('ls-files', '-z')
  return paths.split('\0').some(path => INPUT.test(path))
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`changed=${maintenanceInputsChanged(process.cwd(), process.argv[2], process.argv[3] || 'HEAD')}`)
}
