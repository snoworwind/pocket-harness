#!/usr/bin/env node
// Seed only the shipped profile templates from the pinned DSH TypeScript source.
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const selfTest = process.argv[2] === '--self-test'
const [sourceRootArg, dshHomeArg] = selfTest ? [process.argv[3], undefined] : process.argv.slice(2)
if (!sourceRootArg || (!selfTest && !dshHomeArg)) {
  console.error('usage: seed-dsh-profiles.mjs <deepseek-harness-source-root> <dsh-home> | --self-test <deepseek-harness-source-root>')
  process.exit(2)
}
const sourceRoot = resolve(sourceRootArg)
const dshHome = dshHomeArg ? resolve(dshHomeArg) : undefined
const profileSource = pathToFileURL(join(sourceRoot, 'packages/boot/app-boot/src/profile.ts')).href
const bundleSource = pathToFileURL(join(sourceRoot, 'packages/util/official-bundles/src/bundles.ts')).href
const [{ initProfile }, { PROFILE_TEMPLATES }] = await Promise.all([
  import(profileSource),
  import(bundleSource),
])
if (!PROFILE_TEMPLATES || typeof PROFILE_TEMPLATES !== 'object') {
  throw new Error('pinned DSH source does not export PROFILE_TEMPLATES from official-bundles')
}
const names = ['web', 'headless']
const templates = names.map((name) => {
  const template = PROFILE_TEMPLATES[name]
  if (!template) throw new Error(`pinned DSH source does not define the ${name} profile`)
  if (!Array.isArray(template.bundles) || !template.bundles.every((bundle) => typeof bundle === 'string')) {
    throw new Error(`pinned DSH source defines an invalid ${name} profile template`)
  }
  return { name, bundles: template.bundles }
})

if (selfTest) {
  const stage = mkdtempSync(join(tmpdir(), 'pocket-dsh-profile-seed-'))
  try {
    for (const { name, bundles } of templates) {
      const profileDir = join(stage, name)
      initProfile(profileDir, bundles)
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(bundles)) {
        throw new Error(`profile seeder self-test wrote incorrect ${name} bundles`)
      }
      for (const file of ['cordis.patch.yml', 'pnpm-workspace.yaml']) {
        if (!existsSync(join(profileDir, file))) throw new Error(`profile seeder self-test did not create ${name}/${file}`)
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  console.log('profile seeder self-test passed: web, headless')
} else {
  for (const { name, bundles } of templates) {
    initProfile(join(dshHome, 'profiles', name), bundles)
  }
  console.log('profile manifests generated from pinned DeepSeek Harness source: web, headless')
}
