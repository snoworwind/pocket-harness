// The entry deliberately has no configurable build paths or runtime dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const read = name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const engine = () => readFileSync(new URL('./build-engine.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n').split('\n').map(line => '          ' + line).join('\n')
function checkEngineBuild(source) {
  assert.match(source, /packageManager!=="pnpm@11\.28\.5"/)
  assert.match(source, /npm_retry_flags=\(--fetch-retries=8 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000\)/)
  assert.match(source, /pnpm_retry_env=\([\s\S]*?pnpm_config_fetch_retries=8[\s\S]*?pnpm_config_fetch_retry_factor=2[\s\S]*?pnpm_config_fetch_retry_mintimeout=1000[\s\S]*?pnpm_config_fetch_retry_maxtimeout=30000[\s\S]*?pnpm_config_fetch_timeout=300000[\s\S]*?\)/)
  assert.equal((source.match(/env "\$\{pnpm_retry_env\[@\]\}" corepack pnpm(?:@12\.2\.0)? /g) ?? []).length, 4,
    'all frozen/lockfile pnpm installs and pnpm deploy must share pnpm-specific bounded retry settings')
  assert.match(source, /verify_pnpm_retry_settings pnpm\n/)
  assert.match(source, /verify_pnpm_retry_settings pnpm@12\.2\.0\n/)
  assert.match(source, /manager_args=\(\)[\s\S]*?manager_args=\(--pm-on-fail=ignore\)/)
  assert.match(source, /corepack "\$manager" "\$\{manager_args\[@\]\}" config get/)
  assert.doesNotMatch(source, /corepack pnpm(?:@12\.2\.0)?[^\n]*--fetch-/,
    'npm-only fetch flags must not be passed as pnpm CLI options')
  assert.match(source, /npm install -g corepack@0\.36\.0 --ignore-scripts/)
  checkOfficialClientBuildEnvironment(source)
  const start = source.indexOf('          corepack pnpm run build:native-system')
  const end = source.indexOf('          # Audit all overlay-pinned vendor', start)
  assert.ok(start > 0 && end > start)
  const rootReceipt = source.indexOf('          cp package.json "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-root-package.json.original"')
  assert.ok(rootReceipt > source.indexOf('          cd .deploy-tmp/deepseek-harness') && rootReceipt < start, 'freeze the required raw root manifest before compilation')
  const build = source.slice(start, end)
  const steps = ['run build:native-system', 'exec tsx scripts/compile-referenced-projects.ts host-libraries',
    'exec tsx scripts/compile-referenced-projects.ts client', 'exec tsdown --config-loader native --env.DSH_BUILD_FACE client', 'run build:web',
    "readFileSync('packages/client/ui-layout/lib/client.js'", "readFileSync('packages/client/ui-brand-official/lib/client.js'",
    "readFileSync('apps/web/dist/index.html'", 'git diff --exit-code']
  let previous = -1
  for (const step of steps) {
    const position = build.indexOf(step)
    assert.ok(position > previous, 'required official artifact step/order: ' + step)
    previous = position
  }
  assert.doesNotMatch(source.slice(source.indexOf('          cd .deploy-tmp/deepseek-harness'), end), /fs\.writeFileSync\(path, temporary\)|corepack pnpm --recursive --if-present run bundle|corepack pnpm run build\n/)
  assert.match(build, /Client bundle did not embed the official Harness title/)
  assert.match(build, /Client bundle did not register the official sidebar brand slots/)
  assert.match(build, /Web document did not embed the official Harness title/)
  assert.match(build, /if \(!brand\.includes\('sidebar\.brand\.mark'\) \|\| !brand\.includes\('sidebar\.brand\.name'\)\)/)
}

function checkOfficialClientBuildEnvironment(source) {
  const profile = source.indexOf('          export DSH_CLIENT_BUILD_PROFILE=official')
  const title = source.indexOf("          export DSH_CLIENT_TITLE='DeepSeek Harness'")
  const commit = source.indexOf('          export DSH_CLIENT_COMMIT_HASH="${source_commit:0:7}"')
  const version = source.indexOf('          export DSH_CLIENT_VERSION="$(node -p \'require(\"./package.json\").version\')"')
  const firstBuild = source.indexOf('          corepack pnpm run build:native-system')
  const clearSelector = source.indexOf('          unset DSH_BUILD_CLIENT_PROFILE')
  const clearClientValues = source.indexOf('          for name in ${!DSH_CLIENT_@}; do')
  assert.ok(profile >= 0 && title > profile && commit >= 0 && version >= 0, 'Android must select the full upstream official client profile')
  assert.match(source, /unset DSH_BUILD_CLIENT_PROFILE/)
  assert.match(source, /for name in \$\{!DSH_CLIENT_@\}; do\n\s+unset "\$name"/)
  assert.ok(clearSelector >= 0 && clearSelector < profile && clearClientValues >= 0 && clearClientValues < profile,
    'inherited client profile values must be cleared before selecting the official build environment')
  assert.ok(profile < firstBuild && title < firstBuild && commit < firstBuild && version < firstBuild,
    'official client values must be set before any compiled artifact stage')
  assert.match(source, /source_commit="\$\(git rev-parse HEAD\)"/)
  assert.match(source, /node -p 'require\("\.\/package\.json"\)\.version'/)
}

test('0.2.2-rc.1 source build follows official artifact stages without rewriting upstream manifests', () => checkEngineBuild(engine()))
test('negative controls reject missing source compiler, stale package manager, bad official client metadata and obsolete recursive builder', () => {
  const source = engine()
  for (const [index, bad] of [source.replace('exec tsx scripts/compile-referenced-projects.ts client', 'exec true'),
    source.replace('          cp package.json "$GITHUB_WORKSPACE/.deploy-tmp/source-build/harness-root-package.json.original"', '          # root receipt omitted'),
    source.replace('pnpm@11.28.5', 'pnpm@11.7.0'),
    source.replace('export DSH_CLIENT_BUILD_PROFILE=official', 'export DSH_CLIENT_BUILD_PROFILE=local'),
    source.replace("export DSH_CLIENT_TITLE='DeepSeek Harness'", "export DSH_CLIENT_TITLE='DSH Local Build'"),
    source.replace('export DSH_CLIENT_COMMIT_HASH="${source_commit:0:7}"', '# source commit omitted'),
    source.replace('export DSH_CLIENT_VERSION="$(node -p \'require("./package.json").version\')"', '# source version omitted'),
    source.replace("if (!client.includes('DeepSeek Harness')) throw new Error('Client bundle did not embed the official Harness title')", '// title artifact assertion omitted'),
    source.replace("if (!brand.includes('sidebar.brand.mark') || !brand.includes('sidebar.brand.name')) {", 'if (false) {'),
    source.replace("if (!page.includes('<title>DeepSeek Harness</title>')) throw new Error('Web document did not embed the official Harness title')", '// document title assertion omitted'),
    source.replace('          corepack pnpm run build:web', '          corepack pnpm --recursive --if-present run bundle\n          corepack pnpm run build:web'),
    source.replace('--fetch-retries=8 --fetch-retry-factor=2', '--fetch-retries=2 --fetch-retry-factor=2'),
    source.replace('pnpm_config_fetch_retries=8', 'npm_config_fetch_retries=8'),
    source.replace('manager_args=(--pm-on-fail=ignore)', 'manager_args=()'),
    source.replace('env "${pnpm_retry_env[@]}" corepack pnpm@12.2.0 --pm-on-fail=ignore --filter', 'corepack pnpm@12.2.0 --pm-on-fail=ignore "${npm_retry_flags[@]}" --filter')].entries()) {
    assert.throws(() => checkEngineBuild(bad), assert.AssertionError, `negative control ${index} was not rejected`)
  }
})

const profileSeeder = readFileSync(new URL('./seed-dsh-profiles.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
function checkProfileSeeder(source) {
  assert.match(source, /const profileSource = pathToFileURL\(join\(sourceRoot, 'packages\/boot\/app-boot\/src\/profile\.ts'\)\)\.href/)
  assert.match(source, /const bundleSource = pathToFileURL\(join\(sourceRoot, 'packages\/util\/official-bundles\/src\/bundles\.ts'\)\)\.href/)
  assert.match(source, /const \[\{ initProfile \}, \{ PROFILE_TEMPLATES \}\]/)
  assert.match(source, /process\.argv\[2\] === '--self-test'/)
  assert.match(source, /profile seeder self-test passed/)
  assert.match(source, /return \{ name, bundles: template\.bundles \}/)
  assert.match(source, /initProfile\(join\(dshHome, 'profiles', name\), bundles\)/)
  assert.doesNotMatch(source, /const \{ initProfile, PROFILE_TEMPLATES \} = await import\(profileSource\)/)
}
test('profile seeding uses rc.1 official-bundles templates and app-boot initializer', () => checkProfileSeeder(profileSeeder))
test('negative control: profile seeding rejects reading the no-longer-exported template from app-boot', () => {
  const stale = profileSeeder.replace('packages/util/official-bundles/src/bundles.ts', 'packages/boot/app-boot/src/profile.ts')
  assert.throws(() => checkProfileSeeder(stale), assert.AssertionError)
})

function checkSetupJavaRetries(block, prefix) {
  assert.equal((block.match(/uses: actions\/setup-java@cf277c60eb25467037889841efdb72551f06f6c3/g) ?? []).length, 3,
    `${prefix} must retry the pinned setup-java action three times`)
  assert.equal((block.match(/java-version: '17\.0\.20\+8'/g) ?? []).length, 3,
    `${prefix} retries must keep the exact pinned Temurin build`)
  assert.equal((block.match(/distribution: temurin/g) ?? []).length, 3)
  assert.equal((block.match(/continue-on-error: true/g) ?? []).length, 2,
    `${prefix} must only continue after the first two attempts`)
  assert.match(block, new RegExp(`id: ${prefix}_attempt_1[\\s\\S]*?continue-on-error: true`))
  assert.match(block, new RegExp(`id: ${prefix}_attempt_2[\\s\\S]*?if: steps\\.${prefix}_attempt_1\\.outcome == 'failure'[\\s\\S]*?continue-on-error: true`))
  assert.match(block, new RegExp(`id: ${prefix}_attempt_3[\\s\\S]*?if: steps\\.${prefix}_attempt_2\\.outcome == 'failure'`))
}

function checkTransientBuildStartup(source) {
  const build = source.split('  build-abi:')[1]?.split('\n  verify-abi:')[0]
  assert.ok(build, 'Linux builder setup must be present')
  checkSetupJavaRetries(build, 'setup_java')

  const warmupStart = build.indexOf('      - name: Warm pinned Gradle distribution with bounded transient retries')
  const warmupEnd = build.indexOf('\n      - name:', warmupStart + 1)
  const expensiveChecks = build.indexOf('      - name: Verify pinned source replacement before the expensive build')
  assert.ok(warmupStart >= 0 && warmupEnd > warmupStart && expensiveChecks > warmupEnd,
    'Gradle must be downloaded and checked before expensive source tests and build steps')
  const warmup = build.slice(warmupStart, warmupEnd)
  assert.match(warmup, /chmod \+x gradlew/)
  assert.match(warmup, /\.\/gradlew --version/)
  assert.match(warmup, /for attempt in \$\(seq 1 5\)/)
  assert.match(warmup, /Gradle distribution remained unavailable after 5 attempts/)
  const retryRegex = warmup.match(/grep -Eiq '([^']+)'/)
  assert.ok(retryRegex, 'Gradle retry logic must classify transient errors explicitly')
  const retryPattern = new RegExp(retryRegex[1], 'i')
  assert.match('Exception in thread "main" java.io.IOException: Server returned HTTP response code: 504 for URL: https://github.com/gradle/gradle-distributions/releases/download/v8.11.1/gradle-8.11.1-bin.zip', retryPattern)
  assert.match('java.net.SocketTimeoutException: Read timed out', retryPattern)
  assert.doesNotMatch('Server returned HTTP response code: 404 for URL: https://example.invalid/gradle.zip', retryPattern,
    'permanent HTTP failures must not be retried as transient network errors')

  assert.equal((source.match(/--retry 8 --retry-max-time 600/g) ?? []).length, 3,
    'all three fixed downloads in the APK source workflow must use the longer bounded retry window')
  assert.equal((source.match(/bash scripts\/source-build\/retry-curl\.sh/g) ?? []).length, 3,
    'all fixed APK source downloads must retry known curl transport errors')
  assert.match(source, /npm install -g corepack@0\.36\.0[\s\S]*?--fetch-retries=8 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000[\s\S]*?--fetch-retry-maxtimeout=30000 --fetch-timeout=300000/)
  assert.match(source, /printf '%s  %s\\n' "\$ndk_sha1" "\$ndk_archive" \| sha1sum --check -/)
  assert.match(source, /sha256sum --check --strict/)

  const engine = readFileSync(new URL('./build-engine.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.match(engine, /retry-curl\.sh" --fail --location --retry 8 --retry-max-time 600 --max-time 300/)
  assert.match(engine, /881c21ec33a4a91ad65c61676540faab4122440e3f9685f69939533a6dbbc0c1.*sha256sum --check/)
  const preflight = readFileSync(new URL('./preflight-source-chain.mjs', import.meta.url), 'utf8')
  assert.match(preflight, /retry-curl\.sh'[\s\S]*?'--retry', '8', '--retry-max-time', '600', '--max-time', '300'/)
  assert.match(preflight, /actualSha256 !== facts\.expectedSha256/)
  const dependencyInstaller = readFileSync(new URL('./install-project-dependencies.mjs', import.meta.url), 'utf8')
  checkProjectNpmRetryPolicy(dependencyInstaller)
}

test('pinned Java, Gradle and source downloads recover from transient 504s before expensive work', () => {
  checkTransientBuildStartup(read('build-apk-source.yml'))
})

function checkMarketplaceRetryAndHash(source) {
  assert.match(source, /retry-curl\.sh" --fail --location --retry 8 --retry-max-time 600 --max-time 300/)
  assert.match(source, /881c21ec33a4a91ad65c61676540faab4122440e3f9685f69939533a6dbbc0c1.*sha256sum --check/)
}

function checkProjectNpmRetryPolicy(source) {
  assert.match(source, /const npmRetryArgs = \['--fetch-retries=8'.*'--fetch-timeout=300000'\]/)
  assert.equal((source.match(/\.\.\.npmRetryArgs/g) ?? []).length, 2,
    'lock resolution and npm ci must both use the same finite retry policy')
}

test('negative controls reject missing startup retries, unpinned Java, and missing fixed-download hashes', () => {
  const source = read('build-apk-source.yml')
  const engine = readFileSync(new URL('./build-engine.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  for (const bad of [
    source.replace('java-version: \'17.0.20+8\'', 'java-version: \'17\''),
    source.replace('id: setup_java_attempt_3', '# third setup-java id omitted'),
    source.replace('for attempt in $(seq 1 5)', 'for attempt in $(seq 1 1)'),
    source.replace("grep -Eiq 'HTTP response code: (408|425|429|5[0-9]{2})|SocketTimeoutException|timed out|UnknownHostException|Temporary failure in name resolution|Connection reset|No route to host'", "grep -Eiq 'HTTP response code: (408|425|429|5[0-9]{2})'"),
    source.replace('--retry 8 --retry-max-time 600', '--retry 3'),
    source.replace('--fetch-retry-maxtimeout=30000 --fetch-timeout=300000', '--fetch-retry-maxtimeout=60000 --fetch-timeout=300000'),
  ]) assert.throws(() => checkTransientBuildStartup(bad), assert.AssertionError)
  const projectInstaller = readFileSync(new URL('./install-project-dependencies.mjs', import.meta.url), 'utf8')
  checkProjectNpmRetryPolicy(projectInstaller)
  assert.throws(() => checkProjectNpmRetryPolicy(projectInstaller.replace("'--fetch-retries=8'", "'--fetch-retries=2'")), assert.AssertionError)
  checkMarketplaceRetryAndHash(engine)
  assert.throws(() => checkMarketplaceRetryAndHash(engine.replace('retry-curl.sh', 'curl')), assert.AssertionError)
  assert.throws(() => checkMarketplaceRetryAndHash(engine.replace("printf '%s  %s\\n' '881c21ec33a4a91ad65c61676540faab4122440e3f9685f69939533a6dbbc0c1' \"$marketplace_tarball\" | sha256sum --check -", '# digest omitted')), assert.AssertionError)
})

function runGradleWarmupFixture(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-gradle-warmup-'))
  try {
    const bin = join(root, 'bin')
    const countFile = join(root, 'attempt-count')
    const script = read('build-apk-source.yml')
    const start = script.indexOf('      - name: Warm pinned Gradle distribution with bounded transient retries')
    const end = script.indexOf('\n      - name:', start + 1)
    const block = script.slice(start, end)
    const body = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
    const fakeGradle = `#!/usr/bin/env bash\nset -eu\ncount=0\nif [[ -f "$WARMUP_COUNT" ]]; then count=$(cat "$WARMUP_COUNT"); fi\ncount=$((count + 1))\nprintf '%s' "$count" > "$WARMUP_COUNT"\nif [[ "$WARMUP_SCENARIO" == permanent ]]; then echo 'Server returned HTTP response code: 404'; exit 1; fi\nif [[ "$WARMUP_SCENARIO" == transient && "$count" == 1 ]]; then echo 'java.io.IOException: Server returned HTTP response code: 504 for URL: https://github.com/gradle/gradle-distributions/releases/download/v8.11.1/gradle-8.11.1-bin.zip'; exit 1; fi\nif [[ "$WARMUP_SCENARIO" == exhausted ]]; then echo 'java.io.IOException: Server returned HTTP response code: 504'; exit 1; fi\necho 'Gradle 8.11.1'\n`
    mkdirSync(bin)
    writeFileSync(join(root, 'gradlew'), fakeGradle)
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(root, 'gradlew'), 0o755)
    chmodSync(join(bin, 'sleep'), 0o755)
    const result = spawnSync('/bin/bash', ['-e', '-c', body], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, WARMUP_COUNT: countFile, WARMUP_SCENARIO: scenario },
      encoding: 'utf8',
    })
    return { status: result.status, output: result.stdout + result.stderr, attempts: Number(readFileSync(countFile, 'utf8')) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Gradle warmup retries the observed 504, stops on permanent errors, and has a hard attempt limit', { skip: process.platform !== 'linux' }, () => {
  const transient = runGradleWarmupFixture('transient')
  assert.equal(transient.status, 0, transient.output)
  assert.equal(transient.attempts, 2)
  const permanent = runGradleWarmupFixture('permanent')
  assert.equal(permanent.status, 1)
  assert.equal(permanent.attempts, 1, 'permanent HTTP errors must fail immediately')
  assert.match(permanent.output, /non-transient error/)
  const exhausted = runGradleWarmupFixture('exhausted')
  assert.equal(exhausted.status, 1)
  assert.equal(exhausted.attempts, 5)
  assert.match(exhausted.output, /remained unavailable after 5 attempts/)
})

function checkCachedProjectComponentInputs(source, base) {
  const materialize = source.indexOf('      - name: Materialize trusted engine base')
  const freeze = source.indexOf('      - name: Freeze current project component inputs for trusted cache hit')
  const buildFromSource = source.indexOf('      - name: Build and pack DeepSeek Harness from source')
  assert.ok(materialize > 0 && freeze > materialize && buildFromSource > freeze,
    'a trusted cache hit must recreate project provenance after materialization and before source/cache paths diverge')
  const end = source.indexOf('\n      - name:', freeze + 1)
  const block = source.slice(freeze, end)
  assert.match(block, /if: steps\.engine-cache\.outputs\.cache-hit == 'true'/)
  assert.match(block, /record-project-components\.mjs inputs/)
  assert.match(block, /\.deploy-tmp\/source-build\/project-component-provenance\.json/)
  assert.doesNotMatch(base, /['"]project-component-provenance\.json['"]/,
    'project commit provenance must be recomputed per run, not restored from engine-only cache')
}
test('trusted engine cache hit freezes project component inputs from the current checkout', () => {
  checkCachedProjectComponentInputs(read('build-apk-source.yml'),
    readFileSync(new URL('./engine-base.mjs', import.meta.url), 'utf8'))
})
test('negative controls reject missing or unconditional cached project provenance refresh', () => {
  const source = read('build-apk-source.yml')
  const base = readFileSync(new URL('./engine-base.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('      - name: Freeze current project component inputs for trusted cache hit')
  const end = source.indexOf('\n      - name:', start + 1)
  const block = source.slice(start, end + 1)
  const unconditional = block.replace("        if: steps.engine-cache.outputs.cache-hit == 'true'\n", '')
  for (const bad of [source.replace(block, ''),
    source.replace(block, unconditional)]) {
    assert.throws(() => checkCachedProjectComponentInputs(bad, base), assert.AssertionError)
  }
})
test('source build overrides the checked-in Windows npm cache before any npm install', () => {
  const source = read('build-apk-source.yml')
  const setup = source.indexOf('      - name: Isolate npm cache from checked-in developer settings')
  const firstInstall = source.indexOf('npm ci')
  assert.notEqual(setup, -1)
  assert.ok(firstInstall === -1 || setup < firstInstall)
  assert.match(source.slice(setup, source.indexOf('\n      - name:', setup + 1)), /npm_config_cache=\$RUNNER_TEMP\/dsh-npm-cache/)
})

test('missing CI engine base still fails closed while local chain builds pinned source', () => {
  const source = read('build-apk-source.yml')
  const block = source.split('      - name: Fail closed when the auto-built engine base is unavailable')[1].split('      - name: Build and pack DeepSeek Harness from source')[0]
  const run = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
  for (const [actions, expected] of [['', 0], ['true', 1]]) {
    const result = spawnSync('/bin/bash', ['-e', '-c', run], { env: { ...process.env, GITHUB_ACTIONS: actions } })
    assert.equal(result.status, expected, result.stderr)
  }
})
