#!/usr/bin/env node
// Read the official profile bundle data directly with Node's TypeScript loader.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [source, destination] = process.argv.slice(2).map(value => resolve(value))
if (!source || !destination) throw new Error('usage: seed-linux-home.mjs <harness-source> <home>')
const { PROFILE_TEMPLATES } = await import(pathToFileURL(join(source, 'packages/util/official-bundles/src/bundles.ts')))
for (const name of ['web', 'headless']) {
  const bundles = PROFILE_TEMPLATES[name]?.bundles
  if (!Array.isArray(bundles) || !bundles.length || bundles.some(item => typeof item !== 'string')) throw new Error(`invalid upstream ${name} template`)
  const profile = join(destination, '.dsh/profiles', name)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages: []\n')
}
const settings = readFileSync('scripts/runtime-config/seed-settings.yaml', 'utf8')
writeFileSync(join(destination, '.dsh/settings.yaml'), settings)
copyFileSync('scripts/global-AGENTS.md', join(destination, '.dsh/AGENTS.md'))
