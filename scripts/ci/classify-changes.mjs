#!/usr/bin/env node
/**
 * Classify changed paths into build components. Fail-safe: any unknown path or empty
 * diff maps to `full`, so CI over-builds rather than silently skipping a dependency.
 *
 * `apk` gates the Kotlin compile/test job, so it must mean "this change can alter what
 * the Kotlin tests observe" — not "this change touches the build system". Workflow and
 * generic `scripts/source-build/**` changes build artifacts but are never read by
 * `app/src/test` (enforced by `classify-changes.test.mjs`), so they stay `build` only.
 * Engine/termux/linux/plugin/app changes still set `apk`.
 *
 * Usage:
 *   node scripts/ci/classify-changes.mjs --base <sha> --head <sha>
 *   node scripts/ci/classify-changes.mjs --files a.ts,b.md
 *   node scripts/ci/classify-changes.mjs --base origin/main --head HEAD --github-output
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { posix } from 'node:path'

const DOC_RE = /^(?:docs\/|README(?:\.[^/]*)?$|AGENTS\.md$|LICENSE(?:\..*)?$|THIRD_PARTY_NOTICES\.md$|\.github\/ISSUE_TEMPLATE\/)/
const ENGINE_RE = /^(?:scripts\/contract\.json|scripts\/snapshot-config\/engine-overlay(?:-licenses)?\.json|scripts\/patches\/|scripts\/source-build\/(?:export-dsh-engine|inject-dsh-engine-packages|prepare-harness-vendor-overrides|reconcile-harness-vendor-lock|prune-harness-preview|materialize-dsh-pnpm-packages|build-engine)\.)/
const TERMUX_RE = /^(?:scripts\/snapshot-config\/preinstall\.json|scripts\/source-build\/(?:prepare-termux-bootstrap|prepare-termux-signed-repo|build-node-pty-android)\.|scripts\/contract\.json$)/
const LINUX_RE = /^(?:scripts\/source-build\/(?:linux-|build-linux-assets|package-linux-assets|collect-linux-licenses|prepare-linux-snapshot-bundle|check-linux-sources)|scripts\/source-build\/linux-inputs\.json|scripts\/source-build\/linux-source-manifest\.json|vendor\/bionilux\/|vendor\/dsh-linux-runtime\/|plugins\/dsh-android-linux-env\/|plugins\/dsh-linux-bootstrap\/|app\/src\/main\/java\/com\/snoworwind\/pocketharness\/LinuxAsset)/
const PLUGIN_RE = /^(?:plugins\/|dsh-shell-termux\/|dsh-client-ui-responsive\/|dsh-host-web-compat\/|vendor\/dshmarketplace-plugin\/|vendor\/dsh-undo-savepoint\/)/
const APP_RE = /^(?:app\/|gradle\/|build\.gradle(?:\.kts)?$|settings\.gradle(?:\.kts)?$|gradle\.properties$|gradlew(?:\.bat)?$|scripts\/build-apk|scripts\/build-snapshot|scripts\/inject-all\.py|scripts\/profile-web\.cordis\.patch\.yml|scripts\/snapshot-config\/)/
const GATE_RE = /^scripts\/check-/
const BUILD_RE = /^(?:\.github\/|scripts\/ci\/|scripts\/source-build\/)/

const FLAGS = ['engine', 'termux', 'linux', 'plugins', 'app', 'build', 'gates']

/** Normalize a path to POSIX form without a leading `./`. */
export function normalizePath(file) {
  return posix.normalize(String(file).replaceAll('\\', '/')).replace(/^\.\//, '')
}

/** Classify one path. Returns a partial flag object, or null when unknown. */
export function classifyPath(file) {
  const path = normalizePath(file)
  if (!path || path === '.') return null
  if (DOC_RE.test(path)) return { docs: true }
  const flags = {}
  // engine first; preinstall/contract also affect termux/app downstream.
  if (ENGINE_RE.test(path)) flags.engine = true
  if (TERMUX_RE.test(path)) flags.termux = true
  if (LINUX_RE.test(path)) flags.linux = true
  if (PLUGIN_RE.test(path)) flags.plugins = true
  if (APP_RE.test(path)) flags.app = true
  if (GATE_RE.test(path)) flags.gates = true
  if (BUILD_RE.test(path) && !flags.engine && !flags.termux && !flags.linux) flags.build = true
  return Object.keys(flags).length > 0 ? flags : null
}

function full() {
  const out = Object.fromEntries(FLAGS.map(flag => [flag, true]))
  return { ...out, apk: true, docs_only: false, full: true, files: [] }
}

/** Classify a list of changed paths. Empty/unknown input is fail-safe `full`. */
export function classifyPaths(files) {
  const list = (files ?? []).map(normalizePath).filter(Boolean)
  if (list.length === 0) return full()
  const out = Object.fromEntries(FLAGS.map(flag => [flag, false]))
  out.apk = false
  out.docs_only = false
  out.full = false
  out.files = list
  let docs = 0
  for (const file of list) {
    const flags = classifyPath(file)
    if (flags === null) return { ...full(), files: list }
    if (flags.docs) { docs += 1; continue }
    for (const flag of FLAGS) if (flags[flag]) out[flag] = true
  }
  if (docs === list.length) {
    return { ...Object.fromEntries(FLAGS.map(flag => [flag, false])), apk: false, docs_only: true, full: false, files: list }
  }
  // Build-system changes alter how components are produced, but the Kotlin compile gate
  // only observes app sources, gradle wiring and the few scripts that Kotlin tests read
  // directly (all covered by engine/app above). Keeping `build` out of `apk` stops a
  // workflow-only tweak from paying for a full Kotlin compile; every gate in the static
  // job still runs, so build-system changes remain covered.
  out.apk = out.engine || out.termux || out.linux || out.plugins || out.app
  return out
}

/** Read changed files from git; missing/zero base means full (fail-safe). */
export function changedFiles(base, head) {
  if (!base || !head || /^0+$/.test(base)) return null
  try {
    const text = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, head], { encoding: 'utf8' })
    return text.split(/\r?\n/).filter(Boolean)
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const args = { base: null, head: null, files: null, githubOutput: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base') args.base = argv[++i]
    else if (arg === '--head') args.head = argv[++i]
    else if (arg === '--files') args.files = argv[++i]
    else if (arg === '--github-output') args.githubOutput = true
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') { console.log('Usage: classify-changes.mjs [--base <sha> --head <sha> | --files a,b] [--github-output] [--json]'); process.exit(0) }
    else throw new Error('unknown argument: ' + arg)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let files
  if (args.files !== null) files = args.files.split(',').map(file => file.trim()).filter(Boolean)
  else files = changedFiles(args.base, args.head)
  const result = classifyPaths(files ?? [])
  if (args.githubOutput) {
    const out = process.env.GITHUB_OUTPUT
    if (!out) throw new Error('GITHUB_OUTPUT is not set')
    const lines = Object.entries(result).filter(([, value]) => typeof value === 'boolean')
      .map(([key, value]) => `${key}=${value ? 'true' : 'false'}`).join('\n')
    appendFileSync(out, lines + '\n')
  }
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && process.argv[1].endsWith('classify-changes.mjs')) main()
