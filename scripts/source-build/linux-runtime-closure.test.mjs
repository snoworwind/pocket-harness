import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const script = new URL('./prepare-pnpm-deploy-runtime-closure.mjs', import.meta.url).pathname
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'linux-closure-'))
  const put = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)) }
  const source = join(root, 'source'), commit = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db'
  put('source/package.json', { version: '0.2.2-rc.1', packageManager: 'pnpm@11.28.5' })
  put('source/apps/cli/package.json', { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', dependencies: {} })
  put('source/pnpm-lock.yaml', { importers: { 'apps/cli': { dependencies: {} } } })
  put('source/pnpm-workspace.yaml', { supportedArchitectures: { os: ['android'], cpu: ['x64'] } })
  put('source/node_modules/js-yaml/package.json', { main: 'index.cjs' })
  put('source/node_modules/js-yaml/index.cjs', 'exports.load=JSON.parse; exports.dump=JSON.stringify\n')
  put('bin/git', '#!/bin/sh\nprintf "%s\\n" "' + commit + '"\n')
  chmodSync(join(root, 'bin/git'), 0o755)
  const packages = {}
  for (let index = 0; index < 200; index++) {
    const name = '@deepseek-ai/fixture-' + index
    packages[name] = '1.0.0'
    put('source/packages/fixture-' + index + '/package.json', { name, version: '1.0.0' })
  }
  put('overlay.json', { engineVersion: '0.2.2-rc.1', rootPackage: { version: '0.2.2-rc.1' }, packages, vendorTop: { undici: '8.11.2' }, pins: { '@earendil-works/pi-ai': '1.3.0' }, nested: { '@deepseek-ai/fixture-0': { dependency: '2.0.0' } } })
  const run = (abi = 'arm64') => spawnSync(process.execPath, [script, source, join(root, 'overlay.json'), join(root, 'backup'), join(root, 'report.json'), abi], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH } })
  try { fn({ root, source, put, run }) } finally { rmSync(root, { recursive: true, force: true }) }
}
test('actual Linux deploy policy resolves glibc packages and reviewed pins without Android fallbacks', () => fixture(({ root, source, run }) => {
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(join(source, 'apps/cli/package.json')))
  assert.equal(manifest.dependencies['@koromix/koffi-linux-arm64'], '3.2.1')
  assert.equal(manifest.dependencies['@img/sharp-linux-arm64'], '0.35.5')
  assert.equal(manifest.dependencies['@koromix/koffi-linux-x64'], '3.2.1')
  assert.equal(manifest.dependencies['@img/sharp-linux-x64'], '0.35.5')
  assert.equal(manifest.dependencies['partial-json'], '0.1.7')
  assert.equal(manifest.dependencies.undici, '8.11.2')
  assert.equal(manifest.dependencies['@deepseek-ai/fixture-0'], 'workspace:*')
  assert.ok(!Object.keys(manifest.dependencies).some(name => /android|wasm32/.test(name)))
  const workspace = JSON.parse(readFileSync(join(source, 'pnpm-workspace.yaml')))
  assert.deepEqual(workspace.supportedArchitectures, { os: ['current', 'linux'], cpu: ['current', 'arm64', 'x64'], libc: ['glibc'] })
  assert.equal(workspace.overrides['@deepseek-ai/fixture-0>dependency'], '2.0.0')
  assert.equal(JSON.parse(readFileSync(join(root, 'backup/apps-cli-package.json.original'))).dependencies['@koromix/koffi-linux-arm64'], undefined)
}))
test('actual deploy policy refuses x86 and wrong source tooling before writes', () => fixture(({ source, put, run }) => {
  assert.notEqual(run('x86_64').status, 0)
  put('source/package.json', { version: '0.2.2-rc.1', packageManager: 'pnpm@11.0.0' })
  const before = readFileSync(join(source, 'apps/cli/package.json'), 'utf8')
  assert.notEqual(run().status, 0)
  assert.equal(readFileSync(join(source, 'apps/cli/package.json'), 'utf8'), before)
}))
