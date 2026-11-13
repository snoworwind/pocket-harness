#!/usr/bin/env node
// ARM64 Linux product assembly; no legacy snapshot builder or gate adapters.
import { spawnSync } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { verifyApks } from '../build-apk-engine.mjs'
const ROOT = resolve(import.meta.dirname, '../..')
const reports = join(ROOT, '.deploy-tmp/source-build')
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
if (process.env.DSH_ABI !== 'arm64' || process.env.DSH_LINUX_EXPERIMENT !== '1') throw new Error('explicit ARM64 Linux experiment required')
const assets = join(ROOT, 'app/src/main/assets')
const native = join(ROOT, '.deploy-tmp/linux-build/native-libs')
const licenses = join(ROOT, '.deploy-tmp/linux-build/provenance/linux-native-licenses')
for (const path of [join(native, 'arm64-v8a/libpocketharness_proot.so'), join(ROOT, '.deploy-tmp/source-build/terminal-native-libs/arm64-v8a/libpocketharness_terminal.so')]) {
  if (!existsSync(path)) throw new Error(`required native product missing: ${path}`)
}
run(process.execPath, ['scripts/source-build/check-linux-ci.mjs'])
run(process.execPath, ['scripts/source-build/check-linux-native-libraries.mjs', native])
for (const script of [
  'check-manifest-hardening.mjs', 'check-bounded-io.mjs', 'check-api-route-auth.mjs',
  'check-kotlin-comments.mjs', 'check-state-registry.mjs', 'check-bridge-symmetry.mjs',
  'check-op-registry-parity.mjs', 'check-control-ops.mjs', 'check-protocol-v2.mjs',
  'check-tool-output-schema.mjs', 'check-tool-name-promises.mjs', 'check-tool-surface-budget.mjs',
  'check-plugin-tests.mjs', 'check-kotlin-test-count.mjs', 'check-code-map.mjs', 'check-global-agents.mjs', 'check-patch-mirror.mjs',
]) run(process.execPath, ['scripts/' + script])
mkdirSync(assets, { recursive: true })
for (const leaf of ['snapshot.tar.xz', 'snapshot.sha256', 'linux', 'licenses']) rmSync(join(assets, leaf), { force: true, recursive: true })
cpSync('.deploy-tmp/linux-payload/assets', join(assets, 'linux'), { recursive: true })
copyFileSync('.deploy-tmp/linux-payload/plugin-hard-manifest.json', join(assets, 'plugin-hard-manifest.json'))
mkdirSync(join(assets, 'licenses'))
for (const file of readdirSync('LICENSES')) if (file.endsWith('.txt')) copyFileSync(join('LICENSES', file), join(assets, 'licenses', file))
run('python3', ['scripts/source-build/write-linux-notices.py', ROOT, join(assets, 'licenses/THIRD_PARTY_NOTICES.md')])
copyFileSync('.deploy-tmp/linux-build/provenance/debian-packages.tsv', join(assets, 'licenses/DEBIAN-PACKAGES.tsv'))
cpSync(licenses, join(assets, 'licenses/linux-native'), { recursive: true })
const version = /versionName\s*=\s*"([^"]+)"/.exec(readFileSync('app/build.gradle.kts', 'utf8'))?.[1]
if (!version) throw new Error('versionName missing')
const out = join(ROOT, 'out', 'v' + version)
const release = join(ROOT, 'app/build/outputs/apk/release')
rmSync(release, { force: true, recursive: true })
run('./gradlew', [':app:assembleRelease', '--no-daemon', '--console=plain', '-PversionNameSuffix=-source', `-PlinuxNativeLibraryDir=${native}`, `-PterminalNativeLibraryDir=${ROOT}/.deploy-tmp/source-build/terminal-native-libs`])
mkdirSync(out, { recursive: true })
const apk = join(out, `pocket-harness-v${version}-source-arm64.apk`)
copyFileSync(join(release, 'app-release.apk'), apk)
run('python3', ['scripts/source-build/verify-linux-native-apk.py', apk, native, join(assets, 'licenses/linux-native'), '.deploy-tmp/linux-build/provenance/proot-backend-inputs.json'])
run('python3', ['scripts/source-build/verify-linux-payload.py', '--apk', apk, '--out', join(reports, 'linux-payload-identity.json')])
verifyApks({ files: [apk] })
run(process.execPath, ['scripts/source-build/record-project-components.mjs', 'outputs', join(reports, 'project-component-provenance.json')])
writeFileSync(join(reports, 'project-source-commit.txt'), process.env.GITHUB_SHA + '\n')
run('bash', ['-c', 'find out -type f -name "*.apk" -print -exec sha256sum {} \\; > .deploy-tmp/source-build/apk-sha256.txt'])

const project = JSON.parse(readFileSync(join(reports, 'project-component-provenance.json')))
const harness = JSON.parse(readFileSync(join(reports, 'harness-vendor-lock-reconciliation.json')))
const expected = JSON.parse(readFileSync('scripts/contract.json')).upstream.commit
if (harness.harnessSourceCommit !== expected) throw new Error('Harness source commit does not match contract')
writeFileSync(join(reports, 'component-source-provenance.json'), JSON.stringify({ projectCommit: project.projectCommit, deepseekHarnessCommit: expected, components: project.components }, null, 2) + '\n')
run('bash', ['-c', 'find .deploy-tmp/engine-overlay -maxdepth 1 -type f -name "*.tgz" -print0 | sort -z | xargs -0 -r sha256sum > .deploy-tmp/source-build/engine-overlay-sha256.txt'])
run('bash', ['-c', 'sha256sum app/build.gradle.kts build.gradle.kts settings.gradle.kts > .deploy-tmp/source-build/android-build-inputs-sha256.txt'])
