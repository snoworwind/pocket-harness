#!/usr/bin/env bash
set -euo pipefail

set -euo pipefail
mkdir -p .deploy-tmp
# 已存在则复用：CI 每轮全新目录，本地复跑却会撞 `destination path already exists`。
# 下面几条 fetch/checkout 本身幂等，只有 clone 不是，故只守这一条。
if [ ! -d .deploy-tmp/deepseek-harness/.git ]; then
  git clone --filter=blob:none --no-checkout --depth=1 https://github.com/deepseek-ai/deepseek-harness.git .deploy-tmp/deepseek-harness
fi
git -C .deploy-tmp/deepseek-harness fetch --depth=1 origin b830ec950faba0a46dda564be3e2d854afed94f1
git -C .deploy-tmp/deepseek-harness fetch --depth=1 origin refs/tags/dsh-v0.2.1-rc.5:refs/tags/dsh-v0.2.1-rc.5
# A previous interrupted build may have modified tracked inputs before this checkout.
# Reset only this dedicated source checkout; preserve ignored dependency caches.
test "$(realpath .deploy-tmp/deepseek-harness)" = "$(realpath .)/.deploy-tmp/deepseek-harness"
# A fresh --no-checkout clone has HEAD but an empty index; only reset
# after tracked paths have been populated (for interrupted-build recovery).
if [ -n "$(git -C .deploy-tmp/deepseek-harness ls-files)" ]; then
  git -C .deploy-tmp/deepseek-harness checkout -- .
  git -C .deploy-tmp/deepseek-harness clean -fdq
fi
git -C .deploy-tmp/deepseek-harness checkout --detach b830ec950faba0a46dda564be3e2d854afed94f1
test "$(git -C .deploy-tmp/deepseek-harness rev-parse HEAD)" = "b830ec950faba0a46dda564be3e2d854afed94f1"
test "$(git -C .deploy-tmp/deepseek-harness describe --tags --always)" = "dsh-v0.2.1-rc.5"
node -e 'const c=require("./scripts/contract.json"); if(c.upstreamRepo!==".deploy-tmp/deepseek-harness" || c.baseline!=="0.2.1-rc.5" || c.upstream.commit!=="b830ec950faba0a46dda564be3e2d854afed94f1") throw Error("source workflow identity does not match contract")'
node -e 'const p=require("./.deploy-tmp/deepseek-harness/package.json"); if(p.version!=="0.2.1-rc.5" || p.packageManager!=="pnpm@11.28.5" || p.engines.node!=="^22.19.0 || >=24.0.0") throw Error("official Harness runtime policy changed")'


set -euo pipefail
mkdir -p .deploy-tmp/component-sources
# 三个项目组件来自本次 APK 提交；逐文件核对来源，避免独立仓旧 pin 拒绝已交付修复。
node scripts/source-build/record-project-components.mjs inputs \
  .deploy-tmp/source-build/project-component-provenance.json
# 市场插件用**固定 npm 发布产物**，不用组件源码树：我们的镜像与全部 market-* 补丁都是
# 按发布字节定义的（vendor/dshmarketplace-plugin/PATCHES.md：镜像来自 0.1.7.tgz），
# 而从源码树重建会得到不同字节 —— 0.1.5 时代就踩过（源码构建产物与发布产物闭合形态不同，
# 需要一条源码构建专用的补丁改写兜着）。改用发布产物后该改写随之退役，锚点天然对齐。
marketplace_tarball=.deploy-tmp/component-sources/dshmarketplace-plugin-0.1.7.tgz
curl --fail --location --retry 3 --max-time 300 \
  https://registry.npmjs.org/dshmarketplace-plugin/-/dshmarketplace-plugin-0.1.7.tgz \
  --output "$marketplace_tarball"
printf '%s  %s\n' '881c21ec33a4a91ad65c61676540faab4122440e3f9685f69939533a6dbbc0c1' "$marketplace_tarball" | sha256sum --check -
# Verify the checked-in manifest differs from the hash-pinned publish by only the declared peers.
node scripts/source-build/prepare-marketplace-metadata.mjs "$marketplace_tarball" \
  vendor/dshmarketplace-plugin/package.json .deploy-tmp/source-build/marketplace-metadata-delta.json --check
test "$(realpath vendor/dshmarketplace-plugin)" = "$(realpath .)/vendor/dshmarketplace-plugin"
rm -rf vendor/dshmarketplace-plugin
mkdir -p vendor/dshmarketplace-plugin
tar -xzf "$marketplace_tarball" -C vendor/dshmarketplace-plugin --strip-components=1
# Extraction must not silently restore the published prerelease-incompatible peer declarations.
node scripts/source-build/prepare-marketplace-metadata.mjs "$marketplace_tarball" \
  vendor/dshmarketplace-plugin/package.json .deploy-tmp/source-build/marketplace-metadata-delta.json --apply
test "$(node -p "require('./vendor/dshmarketplace-plugin/package.json').version")" = "0.1.7"


set -euo pipefail
mkdir -p "$GITHUB_WORKSPACE/.deploy-tmp/source-build"
# Previous stage interruption may leave the project overlay in its source-only form.
# Regenerate from the immutable audited project commit, not the previous run artifact.
git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > scripts/snapshot-config/engine-overlay.json
git show "$GITHUB_SHA:scripts/snapshot-config/preinstall.json" > scripts/snapshot-config/preinstall.json
cd .deploy-tmp/deepseek-harness
# Reset only the dedicated build checkout on rerun; retain ignored caches.
# All vendor sources now follow the official target; no older commit is staged.
git checkout -- .
git clean -fdq
npm install -g corepack@0.36.0 --ignore-scripts --no-audit --no-fund
corepack enable
corepack pnpm install --frozen-lockfile
test "$(corepack pnpm --version)" = "11.28.5"
corepack pnpm --version > "$GITHUB_WORKSPACE/.deploy-tmp/source-build/package-manager-versions.txt"
printf 'deployment pnpm: ' >> "$GITHUB_WORKSPACE/.deploy-tmp/source-build/package-manager-versions.txt"
# corepack's fetcher has no download deadline: a stalled connection leaves the
# step silent forever rather than failing (measured 2026-09-26: the pnpm 12.2.0
# fetch logged nothing for 43 minutes until the run was cancelled, while the
# frozen install ahead of it had finished in 18 s). Bound each attempt with
# `timeout` and retry, then warm the cache once here so the deploy call below
# reuses the same binary instead of downloading again.
deployment_pnpm=""
for attempt in 1 2 3 4 5; do
  if deployment_pnpm="$(timeout 240 corepack pnpm@12.2.0 --pm-on-fail=ignore --version)"; then
    break
  fi
  deployment_pnpm=""
  echo "corepack pnpm@12.2.0 attempt ${attempt} did not complete within 240s; retrying" >&2
  sleep $((attempt * 10))
done
test -n "$deployment_pnpm"
printf '%s\n' "$deployment_pnpm" >> "$GITHUB_WORKSPACE/.deploy-tmp/source-build/package-manager-versions.txt"
# The official 0.2.1 builder now has a dedicated Desktop step. Build
# Android's native/Host/Client/Web artifacts through its public helpers;
# no tracked upstream source or package manifest is rewritten.
cp package.json "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-root-package.json.original"
# Android calls the artifact stages directly instead of `scripts/build.ts --profile official`.
# Match the public environment produced by upstream `officialClientBuildEnvironment` so every
# client bundle and the Web document receive the official profile, title, source commit and version.
unset DSH_BUILD_CLIENT_PROFILE
for name in ${!DSH_CLIENT_@}; do
  unset "$name"
done
source_commit="$(git rev-parse HEAD)"
export DSH_CLIENT_COMMIT_HASH="${source_commit:0:7}"
export DSH_CLIENT_VERSION="$(node -p 'require("./package.json").version')"
export DSH_CLIENT_BUILD_PROFILE=official
export DSH_CLIENT_TITLE='DeepSeek Harness'
corepack pnpm run build:native-system
corepack pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries
corepack pnpm exec tsx scripts/compile-referenced-projects.ts client
corepack pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE client
corepack pnpm run build:web
node <<'NODE'
const { readFileSync } = require('node:fs')
const client = readFileSync('packages/client/ui-layout/lib/client.js', 'utf8')
const brand = readFileSync('packages/client/ui-brand-official/lib/client.js', 'utf8')
const page = readFileSync('apps/web/dist/index.html', 'utf8')
if (!client.includes('DeepSeek Harness')) throw new Error('Client bundle did not embed the official Harness title')
if (!brand.includes('sidebar.brand.mark') || !brand.includes('sidebar.brand.name')) {
  throw new Error('Client bundle did not register the official sidebar brand slots')
}
if (!page.includes('<title>DeepSeek Harness</title>')) throw new Error('Web document did not embed the official Harness title')
NODE
git diff --exit-code
node <<'NODE'
const fs = require('node:fs')
const cp = require('node:child_process')
fs.writeFileSync(process.env.GITHUB_WORKSPACE + '/.deploy-tmp/source-build/harness-build-script-exclusion.json', JSON.stringify({
  sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  originalManifestSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync('package.json')).digest('hex'),
  upstreamSourcesModified: false,
  omitted: ['Desktop Electron packaging', 'aggregate upstream test/script typechecks'],
  built: ['native host addon', 'Host package compilation and bundles', 'Client package compilation and bundles', 'package-local bundles', 'Web frontend'],
  reason: 'Android uses the source-built CLI deployment closure; upstream package compilers still check every emitted package. Project tests and artifact gates run separately.'
}, null, 2) + '\n')
NODE
# Audit all overlay-pinned vendor source bytes at the official target.
# No source replacement or second compilation of older packages occurs.
python3 "$GITHUB_WORKSPACE/scripts/source-build/prepare-harness-vendor-overrides.py" \
  "$GITHUB_WORKSPACE/.deploy-tmp/deepseek-harness" \
  "$GITHUB_WORKSPACE/scripts/snapshot-config/engine-overlay.json" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-vendor-overrides.json"
node "$GITHUB_WORKSPACE/scripts/source-build/reconcile-harness-vendor-lock.mjs" \
  "$GITHUB_WORKSPACE/.deploy-tmp/deepseek-harness" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-vendor-overrides.json" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-vendor-lock-reconciliation.json"

workspace_config="$GITHUB_WORKSPACE/.deploy-tmp/deepseek-harness/pnpm-workspace.yaml"
workspace_backup="$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-workspace.original.yaml"
package_backup_dir="$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-deploy-runtime-closure"
package_backup="$package_backup_dir/apps-cli-package.json.original"
lock_backup="$package_backup_dir/pnpm-lock.yaml.original"
cp "$workspace_config" "$workspace_backup"
mkdir -p "$package_backup_dir"
cp apps/cli/package.json "$package_backup"
cp pnpm-lock.yaml "$lock_backup"
restore_deploy_inputs() {
  cp "$workspace_backup" "$workspace_config"
  cp "$package_backup" apps/cli/package.json
  cp "$lock_backup" pnpm-lock.yaml
}
trap restore_deploy_inputs EXIT
python3 "$GITHUB_WORKSPACE/scripts/source-build/prepare-pnpm-deploy-policy.py" \
  "$workspace_config" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-deploy-build-policy.json"
cp "$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-deploy-build-policy.json" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/source-build-policy.json"
node "$GITHUB_WORKSPACE/scripts/source-build/prepare-pnpm-deploy-runtime-closure.mjs" \
  "$GITHUB_WORKSPACE/.deploy-tmp/deepseek-harness" \
  "$GITHUB_WORKSPACE/scripts/snapshot-config/engine-overlay.json" \
  "$package_backup_dir" \
  "$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-deploy-runtime-closure.json"
corepack pnpm install --lockfile-only --no-frozen-lockfile
corepack pnpm install --frozen-lockfile --ignore-scripts
# `pnpm deploy` 要求目标目录为空，否则 ERR_PNPM_DEPLOY_DIR_NOT_EMPTY；CI 每轮全新工作区
# 故从不暴露，本地复跑必撞。语义上这里要的就是「全新的部署树」，故清掉即忠实。
# Refuse an empty/misdirected workspace or symlinked staging parent before cleanup.
test -n "$GITHUB_WORKSPACE"
test "$(realpath "$GITHUB_WORKSPACE/.deploy-tmp")" = "$(realpath "$GITHUB_WORKSPACE")/.deploy-tmp"
rm -rf -- "$GITHUB_WORKSPACE/.deploy-tmp/engine-deploy"
corepack pnpm@12.2.0 --pm-on-fail=ignore --filter @deepseek-ai/dsh deploy --prod "$GITHUB_WORKSPACE/.deploy-tmp/engine-deploy"
cp pnpm-lock.yaml "$GITHUB_WORKSPACE/.deploy-tmp/source-build/pnpm-deploy-runtime-closure.lock.yaml"
restore_deploy_inputs
trap - EXIT
cd "$GITHUB_WORKSPACE"
node <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const yaml = createRequire(path.resolve('.deploy-tmp/deepseek-harness/apps/cli/package.json'))('js-yaml')
const lockPath = '.deploy-tmp/source-build/pnpm-deploy-runtime-closure.lock.yaml'
const lock = yaml.load(fs.readFileSync(lockPath, 'utf8'))
const reportPath = '.deploy-tmp/source-build/pnpm-deploy-runtime-closure.json'
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const exact = (name, version) => {
  const key = Object.keys(lock.packages ?? {}).find((entry) => entry === `${name}@${version}` || entry.startsWith(`${name}@${version}(`))
  if (!key) throw new Error(`temporary runtime lock is missing ${name}@${version}`)
  return { lockKey: key, resolution: lock.packages[key].resolution }
}
report.resolvedLockfileSha256 = digest(fs.readFileSync(lockPath))
report.androidRuntimeDependencies.resolvedPackages = {
  koffi: exact('koffi', '3.2.1'),
  koffiAndroidArm64: exact('@koromix/koffi-android-arm64', '3.2.1'),
  sharpWasm32: exact('@img/sharp-wasm32', '0.35.3'),
}
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
const policyPath = '.deploy-tmp/source-build/source-build-policy.json'
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
policy.androidRuntimePackages = {
  audit: '.deploy-tmp/source-build/android-native-runtime-packages.json',
  trustedPublisherInputs: [
    { name: '@koromix/koffi-android-arm64', version: '3.2.1', upstream: 'https://github.com/Koromix/koffi', role: 'Android ARM64 Node-API binding for Koffi' },
    { name: '@img/sharp-wasm32', version: '0.35.3', upstream: 'https://github.com/lovell/sharp', role: 'WebAssembly fallback for Sharp on Android' },
  ],
  lockfileSha256: report.resolvedLockfileSha256,
  lockfileIntegrityEntries: report.androidRuntimeDependencies.resolvedPackages,
  note: 'These runtime binaries are publisher-provided official packages, not local source builds. Their package identity, resolution integrity, runtime payload hashes, ABI or module path are recorded by the source-build audits.'
}
fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n')
NODE
python3 scripts/source-build/prune-harness-preview.py \
  .deploy-tmp/deepseek-harness \
  .deploy-tmp/engine-deploy \
  .deploy-tmp/source-build/harness-web-preview-exclusion.json
cp scripts/snapshot-config/engine-overlay.json .deploy-tmp/source-build/engine-overlay.original.json
node <<'NODE'
const fs = require('node:fs')
const path = 'scripts/snapshot-config/engine-overlay.json'
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
const baseHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex')
const sourceOnlyVendorTop = { 'partial-json': '0.1.7' }
for (const [name, version] of Object.entries(sourceOnlyVendorTop)) {
  const existing = manifest.vendorTop?.[name]
  if (existing && existing !== version) throw new Error(`source-only runtime pin conflicts for ${name}: ${existing} vs ${version}`)
  manifest.vendorTop = { ...(manifest.vendorTop ?? {}), [name]: version }
}
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
const policyPath = '.deploy-tmp/source-build/source-build-policy.json'
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
policy.sourceOnlyVendorTop = {
  baseOverlaySha256: baseHash,
  packages: sourceOnlyVendorTop,
  reason: 'A clean Termux bootstrap does not inherit the partial-json transitive copy present in the legacy LFS runtime base; keep its exact Harness runtime version in the source-built engine overlay.'
}
policy.harnessVendorSourceOverrides = '.deploy-tmp/source-build/harness-vendor-overrides.json'
policy.harnessVendorSourceOverridesSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync('.deploy-tmp/source-build/harness-vendor-overrides.json')).digest('hex')
policy.harnessVendorLockReconciliation = '.deploy-tmp/source-build/harness-vendor-lock-reconciliation.json'
policy.harnessVendorLockReconciliationSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync('.deploy-tmp/source-build/harness-vendor-lock-reconciliation.json')).digest('hex')
fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n')
NODE
node scripts/source-build/export-dsh-engine.mjs \
  .deploy-tmp/deepseek-harness .deploy-tmp/engine-overlay
node scripts/source-build/inject-dsh-engine-packages.mjs \
  .deploy-tmp/engine-deploy .deploy-tmp/engine-overlay \
  scripts/snapshot-config/engine-overlay.json \
  .deploy-tmp/source-build/first-party-deploy-injection.json
node <<'NODE'
const fs = require('node:fs')
const path = 'scripts/snapshot-config/engine-overlay.json'
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
const injection = JSON.parse(fs.readFileSync('.deploy-tmp/source-build/first-party-deploy-injection.json', 'utf8'))
const runtimeClosure = JSON.parse(fs.readFileSync('.deploy-tmp/source-build/pnpm-deploy-runtime-closure.json', 'utf8'))
const sourcePackages = Object.entries(manifest.packages ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/'))
  .map(([name, version]) => ({ name, version }))
if (sourcePackages.length !== injection.packageCount) throw new Error(`injected ${injection.packageCount} first-party packages, overlay lists ${sourcePackages.length}`)
for (const { name } of sourcePackages) delete manifest.packages[name]
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
const sourceBuildPolicyPath = '.deploy-tmp/source-build/source-build-policy.json'
const sourceBuildPolicy = JSON.parse(fs.readFileSync(sourceBuildPolicyPath, 'utf8'))
fs.writeFileSync('.deploy-tmp/source-build/source-build-policy.json', JSON.stringify({
  ...sourceBuildPolicy,
  omittedFirstPartyPackageOverlays: sourcePackages,
  firstPartySourceInjection: injection,
  pnpmDeployRuntimeClosure: runtimeClosure,
  firstPartyOverlayReason: 'The source-built package tarballs are injected into the physical targets of the pnpm deploy package links before bootstrap packaging. This supplies built lib files while preserving each package symlink and its sibling virtual-store dependency links; the snapshot builder skips re-extracting these packages.',
  exportedFirstPartyTarballs: 'Built from the pinned source, hashed in source-build-manifest.json, and injected into the pnpm deploy tree before that tree is copied into the APK runtime.',
}, null, 2) + '\n')
fs.writeFileSync('.deploy-tmp/source-build/effective-engine-overlay.json', JSON.stringify(manifest, null, 2) + '\n')
NODE



