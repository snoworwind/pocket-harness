import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateVerification, buildVerifyArgs } from '../check-apk-signatures.mjs'

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export function finalApks(root) {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), info = lstatSync(file)
      if (info.isSymbolicLink()) throw new Error('linked APK input is forbidden')
      if (info.isDirectory()) walk(file)
      else if (!info.isFile()) throw new Error('APK inputs must be regular files')
      else if (name.endsWith('.apk')) files.push(file)
    }
  }
  walk(join(root, 'out'))
  if (files.length !== 1 || !/pocket-harness-v[\w.+-]+-source-arm64\.apk$/.test(files[0])) throw new Error('expected exactly one ARM64 source APK')
  return files
}

export function verifyRebuildProof(root, apk, commit) {
  const proof = JSON.parse(readFileSync(join(root, '.deploy-tmp/source-build/independent-rebuild-verification.json'), 'utf8'))
  if (proof.independentRebuildMatched !== true || proof.normalizationVersion !== 3 || !/^[0-9a-f]{40}$/.test(commit ?? '') || proof.sourceCommit !== commit
    || proof.primaryUnsignedApkSha256 !== digest(apk)) {
    throw new Error('final signing requires independent proof for these exact APK bytes and source commit')
  }
  return proof
}

/** Only the isolated final job receives production credentials; builders use ephemeral keys. */
export function signSourceArtifacts(root = process.cwd()) {
  const apk = finalApks(root)[0]
  const proof = verifyRebuildProof(root, apk, process.env.GITHUB_SHA)
  const encoded = process.env.POCKET_SIGNING_KEYSTORE_BASE64
  if (!encoded || !process.env.POCKET_SIGNING_KEYSTORE_PASSWORD) throw new Error('private signing secrets are required')
  const expected = readFileSync(join(root, 'keystore/pocket-harness-cert-sha256.txt'), 'utf8').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid pinned production signing identity')
  const signer = process.env.APKSIGNER
  if (!signer) throw new Error('APKSIGNER is required')
  const temporary = mkdtempSync(join(tmpdir(), 'pocket-final-sign-'))
  const key = join(temporary, 'release.p12'), signed = join(temporary, 'verified.apk')
  try {
    writeFileSync(key, Buffer.from(encoded, 'base64'), { mode: 0o600, flag: 'wx' })
    execFileSync(signer, ['sign', '--ks', key, '--ks-type', 'PKCS12', '--ks-pass', 'env:POCKET_SIGNING_KEYSTORE_PASSWORD', '--key-pass', 'env:POCKET_SIGNING_KEYSTORE_PASSWORD', '--ks-key-alias', 'pocketharness',
      '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false', '--out', signed, apk], { stdio: 'pipe' })
    const output = execFileSync(signer, buildVerifyArgs(signed), { encoding: 'utf8' })
    if (!evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expected }).ok) throw new Error('independent APK signature verification failed')
    // The signing temporary file may be on another filesystem; copy only verified bytes.
    copyFileSync(signed, apk + '.signed', constants.COPYFILE_EXCL)
    renameSync(apk + '.signed', apk)
    const reports = join(root, '.deploy-tmp/source-build')
    proof.signedApkSha256 = digest(apk)
    writeFileSync(join(reports, 'independent-rebuild-verification.json'), JSON.stringify(proof, null, 2) + '\n')
    writeFileSync(join(reports, 'signing-certificate-sha256.txt'), expected + '\n')
    writeFileSync(join(reports, 'apk-sha256.txt'), `${proof.signedApkSha256}  ${relative(root, apk).replaceAll('\\', '/')}\n`)
    console.log('Production ARM64 APK signed after independent rebuild verification')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--self-test')) execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./sign-source-artifacts.test.mjs', import.meta.url))], { stdio: 'inherit' })
  else signSourceArtifacts()
}
