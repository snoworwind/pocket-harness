import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildVerifyArgs, buildApksignerCommand, evaluateVerification, readSchemes, readCertificateDigests } from './check-apk-signatures.mjs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const full = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): true',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
  'Number of signers: 1',
].join('\n')

test('accepts successful apksigner output only when v1, v2, and v3 are true', () => {
  assert.deepEqual(readSchemes(full), { v1: true, v2: true, v3: true })
  assert.equal(evaluateVerification({ exitCode: 0, output: full }).ok, true)
})

test('verifies v1 against the lowest SDK supported by the generated SHA-256 JAR signature', () => {
  assert.deepEqual(buildVerifyArgs('final.apk'), [
    'verify', '--verbose', '--print-certs', '--min-sdk-version', '18', 'final.apk',
  ])
})

test('Windows SDK verification keeps APK paths as arguments without passing them through a command shell', () => {
  const apk = 'a directory/package & data (1).apk'
  const tool = path.join('SDK directory', 'build-tools', '37.0.0', 'apksigner.bat')
  const command = buildApksignerCommand(tool, buildVerifyArgs(apk), 'win32')
  assert.match(command.executable, /java(?:\.exe)?$/)
  assert.deepEqual(command.args, ['-jar', path.join(path.dirname(tool), 'lib', 'apksigner.jar'), ...buildVerifyArgs(apk)])
  assert.deepEqual(buildApksignerCommand('/sdk/apksigner', buildVerifyArgs(apk), 'linux'), { executable: '/sdk/apksigner', args: buildVerifyArgs(apk) })
})

for (const scheme of ['v1', 'v2', 'v3']) {
  test(`rejects APK when only ${scheme} is absent`, () => {
    const output = full.replace(new RegExp(`^Verified using ${scheme} scheme.*(?:\\r?\\n|$)`, 'im'), '')
    const result = evaluateVerification({ exitCode: 0, output })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [scheme])
  })

  test(`rejects APK when only ${scheme} is false`, () => {
    const output = full.replace(new RegExp(`(Verified using ${scheme} scheme \\([^\\r\\n]*?\\):\\s*)true`, 'i'), '$1false')
    const result = evaluateVerification({ exitCode: 0, output })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [scheme])
  })
}

test('rejects nonzero apksigner exit even when all scheme lines claim true', () => {
  assert.equal(evaluateVerification({ exitCode: 1, output: full }).ok, false)
})

test('rejects absent scheme lines and noisy output', () => {
  const result = evaluateVerification({ exitCode: 0, output: 'Verification failed\n' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['v1', 'v2', 'v3'])
})

test('requires the repository signing identity independently of valid signature schemes', () => {
  const expected = '12'.repeat(32)
  const cert = `V2 Signer: certificate SHA-256 digest: ${expected}`
  assert.deepEqual(readCertificateDigests(cert), [expected])
  assert.equal(evaluateVerification({ exitCode: 0, output: full + '\n' + cert, expectedCertificateSha256: expected }).ok, true)
  for (const output of [full, full + '\n' + cert.replace(expected, '34'.repeat(32)), full + '\n' + cert + '\nSigner #2 certificate SHA-256 digest: ' + '56'.repeat(32)]) {
    const result = evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expected })
    assert.equal(result.ok, false)
    assert.equal(result.certificateMatches, false)
    assert.deepEqual(result.missing, [])
  }
})

test('normalizes certificate fingerprints across build-tools output formats', () => {
  const expected = 'ab'.repeat(32)
  const output = full + '\nSigner #1 certificate SHA-256 digest: ' + Array(32).fill('AB').join(':') + '\r\n'
  assert.equal(evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expected }).ok, true)
  assert.equal(evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: 'invalid' }).ok, false)
})

test('an explicit certificate pin option cannot silently disable identity verification when its value is missing', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), '--apk', 'final.apk', '--certificate-sha256'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing value for --certificate-sha256/)
})

test('release signing requires private key secrets and all APK schemes; debug uses a local debug key', () => {
  const candidates = [new URL('../app/build.gradle.kts', import.meta.url), new URL('../dsh-mobile-apk/app/build.gradle.kts', import.meta.url)]
  const gradlePath = candidates.find((candidate) => existsSync(candidate))
  assert.ok(gradlePath, 'app/build.gradle.kts must exist in the APK tree')
  const gradle = readFileSync(gradlePath, 'utf8')
  const signing = /create\("pocketRelease"\)\s*\{([\s\S]*?)\n\s*\}/.exec(gradle)?.[1] ?? ''
  for (const scheme of ['V1', 'V2', 'V3']) assert.match(signing, new RegExp(`enable${scheme}Signing\\s*=\\s*true`))
  assert.match(gradle, /POCKET_SIGNING_KEYSTORE_PATH/)
  assert.match(gradle, /POCKET_SIGNING_KEYSTORE_PASSWORD/)
  assert.match(gradle, /keyAlias\s*=\s*"pocketharness"/)
  assert.match(gradle, /release\s*\{\s*isMinifyEnabled\s*=\s*false\s*signingConfig\s*=\s*signingConfigs\.findByName\("pocketRelease"\)/)
  assert.match(gradle, /debug\s*\{[\s\S]*?signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)/)
  assert.doesNotMatch(gradle, /storePassword\s*=\s*"android"|rootProject\.file\("keystore\/debug\.keystore"\)/)
  assert.match(readFileSync(new URL('../keystore/pocket-harness-cert-sha256.txt', import.meta.url), 'utf8').trim(), /^[a-f0-9]{64}$/)
})

test('Pocket Harness application identity is consistent across Android, runtime paths, and notification actions', () => {
  const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8')
  const gradle = read('app/build.gradle.kts')
  const manifest = read('app/src/main/AndroidManifest.xml')
  const receiver = read('app/src/main/java/com/snoworwind/pocketharness/NotifyActionReceiver.kt')
  const strings = read('app/src/main/res/values/strings.xml')
  const engine = read('app/src/main/java/com/snoworwind/pocketharness/EngineManager.kt')
  const ownership = read('app/src/main/java/com/snoworwind/pocketharness/OwnershipRepair.kt')
  assert.match(gradle, /applicationId\s*=\s*"com\.snoworwind\.pocketharness"/)
  assert.match(gradle, /namespace\s*=\s*"com\.snoworwind\.pocketharness"/)
  assert.match(strings, /<string name="app_name">Pocket Harness<\/string>/)
  assert.match(manifest, /com\.snoworwind\.pocketharness\.action\.NOTIFY_ACTION/)
  assert.match(receiver, /ACTION_NOTIFY_ACTION\s*=\s*"com\.snoworwind\.pocketharness\.action\.NOTIFY_ACTION"/)
  assert.match(engine, /TERMUX_APP__LEGACY_DATA_DIR" to "\/data\/data\/\$\{BuildConfig\.APPLICATION_ID\}"/)
  assert.match(ownership, /PACKAGE_NAME: String get\(\) = BuildConfig\.APPLICATION_ID/)
  assert.doesNotMatch(engine, /data\/data\/com\.dsharnessmobile\.shell/)
})
