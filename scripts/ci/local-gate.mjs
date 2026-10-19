#!/usr/bin/env node
/**
 * Local PR gate — the merge gate while GitHub Actions runner allocation is unavailable.
 *
 * It does NOT keep its own list of checks. It reads `.github/workflows/pr-gate.yml` and
 * runs the same `run:` blocks the workflow would run, in the same container image, for the
 * same job selection the workflow's classifier produces. One source of truth: if a gate is
 * added to or removed from the workflow, this script follows automatically.
 *
 * Job selection mirrors the workflow conditions:
 *   docs-hygiene  always
 *   static        unless the change is documentation-only
 *   compile       only when `apk` is true (the Kotlin compile/test job)
 *
 * Steps that only prepare the environment (`sdkmanager`) are skipped: the image already
 * provides them. `uploads`/`uses:` steps have no `run:` block and are ignored.
 *
 * Usage:
 *   node scripts/ci/local-gate.mjs                  # run against origin/main
 *   node scripts/ci/local-gate.mjs --base main --dry-run
 *   node scripts/ci/local-gate.mjs --no-kotlin      # skip the compile job deliberately
 *   node scripts/ci/local-gate.mjs --build-image    # rebuild the gate image first
 *
 * Exit codes: 0 pass, 1 a gate failed, 2 usage/environment/dirty-tree error.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyPaths } from './classify-changes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const WORKFLOW = join(ROOT, '.github', 'workflows', 'pr-gate.yml')
const DEFAULT_IMAGE = 'pocket-harness-gate:24.04'
const EVIDENCE_DIR = join(ROOT, '.deploy-tmp', 'local-gate')

function fail(message, code = 2) {
  console.error('local-gate: ' + message)
  process.exit(code)
}

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * Extract the `run:` steps of the requested jobs from the workflow text.
 *
 * Deliberately a small, purpose-built reader instead of a YAML library: the tool must work
 * on any machine with Node alone, and the workflow is a file this repository owns. It only
 * understands the shapes used there — 2-space job keys, a `steps:` list at 4 spaces,
 * `      - name:`/`- uses:` entries, and `run:` either inline or as a `|` block. Anything
 * else is ignored, and the counts are pinned by `local-gate.test.mjs` so a format change
 * fails loudly instead of silently selecting the wrong steps.
 */
export function extractWorkflowSteps(text, jobs) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const jobBodies = new Map()
  let currentJob = null
  for (const line of lines) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (job) { currentJob = job[1]; jobBodies.set(currentJob, []); continue }
    if (/^ {2}[A-Za-z0-9_'"-]/.test(line)) { currentJob = null; continue }
    if (currentJob) jobBodies.get(currentJob).push(line)
  }

  const steps = []
  for (const job of jobs) {
    const body = jobBodies.get(job)
    if (!body) continue
    let step = null
    for (let i = 0; i < body.length; i += 1) {
      const line = body[i]
      const entry = /^ {6}- (.+)$/.exec(line)
      if (entry) {
        if (step) steps.push(step)
        step = { job, name: null, run: null, if: null }
        const inline = /^name:\s*(.*)$/.exec(entry[1])
        if (inline) step.name = inline[1].trim()
        continue
      }
      if (!step) continue
      const field = /^ {8}([A-Za-z_-]+):(?:\s+(.*))?$/.exec(line)
      if (field) {
        const [, key, value] = field
        if (key === 'name') step.name = (value ?? '').trim()
        else if (key === 'if') step.if = (value ?? '').trim()
        else if (key === 'run') {
          const header = (value ?? '').trim()
          if (header === '|' || header === '|-' || header === '>' || header === '>-') {
            const block = []
            let indent = null
            for (let j = i + 1; j < body.length; j += 1) {
              const next = body[j]
              if (!next.trim()) { block.push(''); continue }
              const leading = next.length - next.trimStart().length
              if (indent === null) {
                if (leading < 10) break
                indent = leading
              }
              if (leading < indent) break
              block.push(next.slice(indent))
              i = j
            }
            while (block.length && !block[block.length - 1].trim()) block.pop()
            step.run = block.join('\n')
          } else {
            step.run = header
          }
        }
      }
    }
    if (step) steps.push(step)
  }
  // Steps that only reference an action (`uses:`) have no command to reproduce locally.
  return steps.filter((step) => step.run !== null)
}

/** Read the workflow and return the steps the selected jobs would run. */
export function selectSteps({ docsOnly = false, apk = true, workflowPath = WORKFLOW } = {}) {
  const jobs = ['docs-hygiene']
  if (!docsOnly) jobs.push('static')
  if (apk) jobs.push('compile')
  const all = extractWorkflowSteps(readFileSync(workflowPath, 'utf8'), jobs)
  return all
    .filter((step) => step.run && step.if !== 'failure()')
    // Environment preparation is provided by the image, not re-run per gate call.
    .filter((step) => !step.run.includes('sdkmanager'))
    .map((step) => ({ job: step.job, name: step.name || '(unnamed)', run: step.run }))
}

/** Render one bash script that runs every selected step in order, `always()`-style. */
export function renderScript(steps) {
  const lines = [
    'set -u',
    'cd /workspace',
    'echo "local-gate: steps=' + steps.length + '"',
    // The evidence must describe the environment it was produced in, even when the
    // repository has no pinned toolchain policy checked in.
    `printf '::DSH_ENV::node=%s\\n' "$(node --version)"`,
    `printf '::DSH_ENV::python=%s\\n' "$(python3 -c 'import platform;print(platform.python_version())')"`,
    `printf '::DSH_ENV::java=%s\\n' "$(java -XshowSettings:properties -version 2>&1 | sed -n 's/.*java.runtime.version = //p' | head -1)"`,
    `printf '::DSH_ENV::corepack=%s\\n' "$(corepack --version)"`,
    `printf '::DSH_ENV::os=%s\\n' "$(grep '^VERSION_ID' /etc/os-release | cut -d= -f2 | tr -d '\"')"`,
  ]
  steps.forEach((step, index) => {
    // Timestamps are taken inside the container: the host only sees the finished stream,
    // so parsing it afterwards cannot recover per-step durations.
    lines.push(`printf '\\n::DSH_STEP::${index}::%s\\n' "$(date +%s%3N)"`)
    // A subshell gives each step its own exit status and keeps `set -e`/`cd` local, which
    // is how `if: always()` behaves in the workflow: a failing step never hides the next.
    lines.push('(')
    lines.push(step.run)
    lines.push(')')
    lines.push(`dsh_rc=$?`)
    lines.push(`printf '::DSH_RC::${index}::%s::%s\\n' "$dsh_rc" "$(date +%s%3N)"`)
  })
  return lines.join('\n') + '\n'
}

function parseArgs(argv) {
  const args = { base: 'origin/main', image: DEFAULT_IMAGE, dryRun: false, noKotlin: false, buildImage: false, allowDirty: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base') args.base = argv[++i]
    else if (arg === '--image') args.image = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-kotlin') args.noKotlin = true
    else if (arg === '--build-image') args.buildImage = true
    else if (arg === '--allow-dirty') args.allowDirty = true
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/ci/local-gate.mjs [--base <ref>] [--image <tag>] [--dry-run] [--no-kotlin] [--build-image] [--allow-dirty] [--json]')
      process.exit(0)
    } else fail('unknown argument: ' + arg)
  }
  return args
}

function changedFiles(base) {
  try {
    return git('diff', '--name-only', base + '...HEAD').split('\n').filter(Boolean)
  } catch {
    return git('diff', '--name-only', base).split('\n').filter(Boolean)
  }
}

function spawnSyncDocker(args, { input } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
  if (result.error) fail('docker unavailable: ' + result.error.message)
  return result
}

async function ensureImage(image, rebuild) {
  const inspect = spawnSyncDocker(['image', 'inspect', image])
  if (inspect.status === 0 && !rebuild) return
  if (inspect.error) fail('docker is not available; the local gate needs a container runtime')
  if (rebuild || inspect.status !== 0) {
    console.log('local-gate: building ' + image + ' (first run downloads ~2.5GB)')
    const dockerfile = join(HERE, 'gate-image', 'Dockerfile')
    if (!existsSync(dockerfile)) fail('missing ' + dockerfile)
    const build = spawnSyncDocker(['build', '--platform', 'linux/amd64', '-t', image, '-f', dockerfile, join(HERE, 'gate-image')])
    if (build.status !== 0) fail('image build failed:\n' + (build.stdout || '') + (build.stderr || ''))
  }
}

async function runInContainer({ image, script, commit }) {
  // A read-only mount pins the SDK path the image provides, so the host's macOS
  // local.properties never leaks into the container and no checked-in file is touched.
  const sdkFile = join(mkdtempSync(join(tmpdir(), 'local-gate-sdk-')), 'local.properties')
  writeFileSync(sdkFile, 'sdk.dir=/opt/android-sdk\n')
  const chunks = []
  const child = spawn('docker', [
    'run', '--rm', '-i', '--platform', 'linux/amd64',
    '-v', ROOT + ':/workspace',
    '-v', sdkFile + ':/workspace/local.properties:ro',
    '-v', 'pocket-harness-gate-gradle:/root/.gradle',
    '-v', 'pocket-harness-gate-pnpm:/root/.local/share/pnpm',
    '-e', 'GITHUB_WORKSPACE=/workspace',
    '-e', 'GITHUB_SHA=' + commit,
    '-w', '/workspace',
    image, 'bash', '-s',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { chunks.push(chunk) })
  child.stderr.on('data', (chunk) => { chunks.push(chunk) })
  child.stdin.end(script)
  const status = await new Promise((done) => child.on('close', done))
  rmSync(dirname(sdkFile), { recursive: true, force: true })
  return { status, output: Buffer.concat(chunks).toString('utf8') }
}

export function summarizeEnvironment(output) {
  const env = {}
  for (const line of output.split('\n')) {
    const mark = /^::DSH_ENV::([a-z]+)=(.*)$/.exec(line.trim())
    if (mark) env[mark[1]] = mark[2]
  }
  return env
}

export function summarize(output, steps) {
  const results = steps.map((step, index) => ({ index, job: step.job, name: step.name, rc: null, durationMs: null }))
  const startedAt = new Map()
  for (const line of output.split('\n')) {
    const stepMark = /^::DSH_STEP::(\d+)::(\d+)$/.exec(line.trim())
    if (stepMark) {
      startedAt.set(Number(stepMark[1]), Number(stepMark[2]))
      continue
    }
    const rcMark = /^::DSH_RC::(\d+)::(\d+)::(\d+)$/.exec(line.trim())
    if (rcMark && results[Number(rcMark[1])]) {
      const index = Number(rcMark[1])
      results[index].rc = Number(rcMark[2])
      const start = startedAt.get(index)
      results[index].durationMs = start === undefined ? null : Number(rcMark[3]) - start
    }
  }
  return results
}

function tailFor(output, index, lines = 30) {
  const start = output.indexOf(`::DSH_STEP::${index}`)
  if (start < 0) return ''
  const end = output.indexOf(`::DSH_RC::${index}::`, start)
  const body = output.slice(start, end < 0 ? undefined : end).split('\n').slice(1)
  return body.slice(-lines).join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const commit = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  const dirty = git('status', '--porcelain')
  if (dirty && !args.allowDirty) {
    fail('working tree is dirty; evidence must describe a commit. Commit first or pass --allow-dirty.\n' + dirty, 2)
  }
  const files = changedFiles(args.base)
  const classification = classifyPaths(files)
  const apk = args.noKotlin ? false : classification.apk
  const steps = selectSteps({ docsOnly: classification.docs_only, apk })

  if (args.dryRun) {
    console.log(JSON.stringify({ commit, tree, base: args.base, changedFiles: files.length, classification, steps: steps.map((s) => ({ job: s.job, name: s.name })) }, null, 2))
    return
  }

  await ensureImage(args.image, args.buildImage)
  const script = renderScript(steps)
  console.log(`local-gate: commit ${commit.slice(0, 12)} tree ${tree.slice(0, 12)} base ${args.base}`)
  console.log(`local-gate: classification docs_only=${classification.docs_only} apk=${apk} build=${classification.build} gates=${classification.gates}`)
  console.log(`local-gate: running ${steps.length} steps in ${args.image} (linux/amd64)\n`)

  const startedAt = Date.now()
  const { output } = await runInContainer({ image: args.image, script, commit })
  const results = summarize(output, steps)

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const logPath = join(EVIDENCE_DIR, tree.slice(0, 12) + '.log')
  writeFileSync(logPath, output)

  results.forEach((result) => {
    const mark = result.rc === 0 ? 'PASS' : result.rc === null ? 'MISS' : 'FAIL'
    const seconds = result.durationMs === null ? '-' : (result.durationMs / 1000).toFixed(1) + 's'
    console.log(`${mark}  ${String(result.index + 1).padStart(2, '0')}  ${seconds.padStart(6)}  ${result.name}`)
    if (result.rc !== 0 && result.rc !== null) {
      const tail = tailFor(output, result.index)
      if (tail) console.log(tail.split('\n').map((line) => '      ' + line).join('\n'))
    }
  })

  const failed = results.filter((result) => result.rc !== 0)
  const evidence = {
    schema: 1,
    commit,
    tree,
    base: args.base,
    dirty: Boolean(dirty),
    changedFiles: files.length,
    classification,
    image: args.image,
    platform: 'linux/amd64',
    environment: summarizeEnvironment(output),
    toolchainPolicy: (() => {
      try { return JSON.parse(readFileSync(join(ROOT, 'scripts/source-build/engine-toolchain.json'), 'utf8')) } catch { return null }
    })(),
    steps: results,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  }
  const evidencePath = join(EVIDENCE_DIR, tree.slice(0, 12) + '.json')
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  writeFileSync(join(EVIDENCE_DIR, 'latest.json'), JSON.stringify(evidence, null, 2) + '\n')

  console.log(`\nlocal-gate: ${evidence.verdict} (${results.length - failed.length}/${results.length} steps) in ${(evidence.durationMs / 1000).toFixed(1)}s`)
  console.log('local-gate: evidence ' + evidencePath)
  console.log('local-gate: log ' + logPath)
  if (args.json) console.log(JSON.stringify(evidence))
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
