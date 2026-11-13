#!/usr/bin/env node
// Linux-only runtime composition: no bootstrap, Android Node binding, or Termux archive.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const work = join(ROOT, '.deploy-tmp/linux-payload')
const stage = join(work, 'composition')
const engine = join(stage, 'usr/lib/node_modules/@deepseek-ai/dsh')
const reports = join(ROOT, '.deploy-tmp/source-build')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
const node = (script, ...args) => run(process.execPath, [join(ROOT, 'scripts', script), ...args])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (process.env.DSH_ABI !== 'arm64' || process.env.DSH_LINUX_RUNTIME !== '1') throw new Error('the maintained ARM64 Linux runtime build is required')
rmSync(work, { recursive: true, force: true })
mkdirSync(engine, { recursive: true })
cpSync(join(ROOT, '.deploy-tmp/engine-deploy'), engine, { recursive: true, verbatimSymlinks: true })
mkdirSync(reports, { recursive: true })
node('source-build/seed-linux-home.mjs', join(ROOT, '.deploy-tmp/deepseek-harness'), join(stage, 'home'))
run(process.execPath, ['scripts/source-build/fetch-overlay-tarballs.mjs', join(reports, 'engine-overlay.original.json'), join(ROOT, '.deploy-tmp/engine-overlay')])
node('probe-engine-anchors.mjs', '--fixtures', '--capture-only', '--overlay', join(reports, 'engine-overlay.original.json'), '--source-manifest', '.deploy-tmp/engine-overlay/source-build-manifest.json')
node('patches/apply-patches.mjs', stage, '--apply', '--scope', 'engine')
node('check-browser-syntax-floor.mjs', '--degrade', '--stage', stage)
node('source-build/reconcile-engine-patch-copies.mjs', engine, join(reports, 'engine-patch-copy-reconciliation.json'))
node('source-build/materialize-dsh-pnpm-packages.mjs', engine, '.deploy-tmp/engine-overlay/source-build-manifest.json', join(reports, 'pnpm-package-materialization.json'))
node('gen-model-catalog.mjs', '--engine-root', stage, '--out', 'plugins/dsh-model-capability/lib/catalog-snapshot.json')
run('python3', ['scripts/source-build/inject-linux-home.py', stage])
node('check-inject-completeness.mjs', '--tree', stage)
// Transform only the injected home copy; checked-in vendor files remain immutable.
node('check-browser-syntax-floor.mjs', '--degrade', '--stage', join(stage, 'home'))
node('check-browser-syntax-floor.mjs', '--scan', stage)
run('python3', ['scripts/source-build/check-linux-home.py', join(stage, 'home')])
node('build-hard-manifest.mjs', '--tree', stage, '--out', join(work, 'plugin-hard-manifest.json'))
node('source-build/check-linux-engine.mjs', stage)
run('python3', ['scripts/source-build/package-guest-engine.py', '--tree', join(stage, 'usr/lib/node_modules'), '--addon', '.deploy-tmp/linux-build/guest-addons/system', '--out', join(work, 'engine'), '--epoch', '1704067200'])
node('source-build/check-linux-runtime-packages.mjs', join(work, 'engine/@deepseek-ai/dsh'), join(reports, 'linux-native-runtime-packages.json'))
const preinstall = JSON.parse(readFileSync('scripts/runtime-config/preinstall.json'))
const version = preinstall.canvas.version
const name = '@napi-rs/canvas-linux-arm64-gnu'
const canvas = join(work, 'canvas.tgz')
run('bash', ['scripts/source-build/retry-curl.sh', '--fail', '--location', '--retry', '8', '--retry-max-time', '600', `https://registry.npmjs.org/${name}/-/canvas-linux-arm64-gnu-${version}.tgz`, '-o', canvas])
// Same integrity pin used by the former snapshot builder; downloads never establish their own identity.
const { verifyPinnedNpm } = await import('../lib/pinned-npm.mjs')
verifyPinnedNpm(readFileSync(canvas), name, version, preinstall.npmIntegrity)
run('python3', ['scripts/source-build/prepare-guest-home.py', join(stage, 'home'), join(work, 'home-seed'), canvas])
const canvasJs = join(work, 'canvas-js.tgz')
run('bash', ['scripts/source-build/retry-curl.sh', '--fail', '--location', '--retry', '8', '--retry-max-time', '600', `https://registry.npmjs.org/@napi-rs/canvas/-/canvas-${version}.tgz`, '-o', canvasJs])
verifyPinnedNpm(readFileSync(canvasJs), '@napi-rs/canvas', version, preinstall.npmIntegrity)
run('python3', ['scripts/source-build/install-linux-canvas.py', join(work, 'home-seed/home'), canvasJs, version])
run('python3', ['scripts/source-build/check-linux-home.py', join(work, 'home-seed/home')])
run('python3', ['scripts/source-build/check-linux-guest.py', join(work, 'engine'), join(work, 'home-seed/home')])

run('tar', ['--sort=name', '--mtime=@1704067200', '--owner=0', '--group=0', '--numeric-owner', '-cJf', join(work, 'home.tar.xz'), '-C', join(work, 'home-seed'), 'home'], { env: { ...process.env, XZ_OPT: `-T8 -${process.env.DSH_LINUX_XZ_PRESET || '6'}` } })
const assets = join(work, 'assets')
mkdirSync(assets)
const linux = JSON.parse(readFileSync('scripts/source-build/linux-inputs.json'))
for (const [source, target] of [
  ['.deploy-tmp/linux-build/assets/debian-minimal-aarch64.tar.xz', 'rootfs.tar.xz'],
  [`.deploy-tmp/linux-build/assets/node-glibc-v${linux.node}-linux-arm64.tar.xz`, 'node.tar.xz'],
  [join(work, 'engine-glibc.tar.xz'), 'engine.tar.xz'], [join(work, 'home.tar.xz'), 'home.tar.xz'],
]) {
  if (!existsSync(source)) throw new Error(`Linux payload missing: ${source}`)
  cpSync(source, join(assets, target))
}
run('python3', ['scripts/source-build/linux-instance-manifest.py', assets])
const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json')))
writeFileSync(join(reports, 'linux-payload-build.json'), JSON.stringify({ projectCommit: process.env.GITHUB_SHA, manifest, pluginHardManifestSha256: digest(readFileSync(join(work, 'plugin-hard-manifest.json'))) }, null, 2) + '\n')
