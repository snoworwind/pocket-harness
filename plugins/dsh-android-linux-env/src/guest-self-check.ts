import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'

export function resolveGuestCommand(name: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  for (const directory of (environment.PATH ?? '').split(':')) {
    if (!isAbsolute(directory)) continue
    const file = join(directory, name)
    try { if (existsSync(file)) return realpathSync(file) } catch { /* inaccessible candidate */ }
  }
  return null
}

export function runGuestProbe(file: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, [...args], { env: environment, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout.trim())
  }))
}

/** Read-only diagnostics distinguish the engine's fixed environment from a user's interactive shell PATH. */
export async function guestSelfCheck(options: {
  environment?: NodeJS.ProcessEnv
  run?: typeof runGuestProbe
  resolve?: typeof resolveGuestCommand
  engineNode?: { version: string; path: string; openssl: string }
  engineRg?: string | null
} = {}) {
  const environment = options.environment ?? process.env
  const run = options.run ?? runGuestProbe
  const resolve = options.resolve ?? resolveGuestCommand
  const engine = options.engineNode ?? { version: process.version, path: process.execPath, openssl: process.versions.openssl ?? 'unknown' }
  async function probe(name: string, args = ['--version']) {
    const path = resolve(name, environment)
    if (!path) return { path: null, version: null, ok: false }
    try { return { path, version: await run(path, args, environment), ok: true } }
    catch { return { path, version: null, ok: false } }
  }
  let engineRg = options.engineRg
  if (engineRg === undefined) {
    try {
      const root = createRequire('/opt/dsh/@deepseek-ai/dsh/package.json')
      const fsSearch = createRequire(root.resolve('@deepseek-ai/dsh-tool-fs-search'))
      engineRg = (fsSearch('@vscode/ripgrep') as { rgPath?: string }).rgPath ?? null
    } catch { engineRg = null }
  }
  const [node, npm, pnpm, corepack, rg, python, gcc, clang] = await Promise.all([
    probe('node'), probe('npm'), probe('pnpm'), probe('corepack'), probe('rg'),
    probe('python3', ['-c', 'import sys,sysconfig; print(sys.version.split()[0] + " " + sysconfig.get_config_var("SOABI"))']),
    probe('gcc'), probe('clang'),
  ])
  const engineRipgrep = engineRg ? await run(engineRg, ['--version'], environment).then(version => ({ path: engineRg, version, ok: true }), () => ({ path: engineRg, version: null, ok: false })) : { path: null, version: null, ok: false }
  const libraryIsolation = !environment.LD_LIBRARY_PATH && !environment.LD_PRELOAD && !environment.PROOT_LOADER && !environment.TERMUX_VERSION
  return {
    ok: node.ok && node.version === engine.version && pnpm.ok && libraryIsolation,
    checkedAt: new Date().toISOString(), scope: 'engine environment; interactive shell customizations may differ',
    engineNode: engine, pathNode: node, npm, pnpm, corepack,
    npmGlobalPrefix: environment.npm_config_prefix ?? environment.NPM_CONFIG_PREFIX ?? null,
    pnpmHome: environment.PNPM_HOME ?? null,
    engineRipgrep, pathRipgrep: rg, python,
    buildTools: { python: environment.PYTHON ?? null, cc: environment.CC ?? null, cxx: environment.CXX ?? null, make: environment.MAKE ?? null, gcc, clang },
    ca: { nodeExtraCaCerts: environment.NODE_EXTRA_CA_CERTS ?? null, readable: Boolean(environment.NODE_EXTRA_CA_CERTS && existsSync(environment.NODE_EXTRA_CA_CERTS)) },
    libraryIsolation,
    pythonUserPackagePolicy: 'User packages stay in ~/.local; after a Python minor/SOABI change reinstall compiled extensions for that interpreter. Existing files are retained.',
  }
}

let cached: { key: string; until: number; promise: ReturnType<typeof guestSelfCheck> } | undefined
export function cachedGuestSelfCheck() {
  const key = JSON.stringify([process.env.PATH, process.env.NODE_EXTRA_CA_CERTS, process.env.LD_LIBRARY_PATH])
  if (!cached || cached.key !== key || Date.now() >= cached.until) cached = { key, until: Date.now() + 15_000, promise: guestSelfCheck() }
  return cached.promise
}
