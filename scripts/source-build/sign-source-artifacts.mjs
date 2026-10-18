import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareSigning, SIGNING_CERTIFICATE } from './prepare-signing.mjs'
import { evaluateVerification, buildVerifyArgs } from '../check-apk-signatures.mjs'

export function finalApks(root) {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('linked APK input is forbidden')
      if (stat.isDirectory()) walk(file)
      else if (name.endsWith('.apk')) files.push(file)
    }
  }
  walk(join(root, 'out'))
  if (files.length !== 1 || !/dsh-mobile-apk-v[\w.+-]+-source-arm64\.apk$/.test(files[0])) throw new Error('expected exactly one ARM64 source APK')
  return files
}

export function signSourceArtifacts(root = process.cwd()) {
  const files = finalApks(root)
  const key = prepareSigning(root)
  const tool = process.env.APKSIGNER || readFileSync(join(root, '.deploy-tmp/source-build/apksigner-path.txt'), 'utf8').trim()
  for (const file of files) {
    const signed = file + '.signed'
    execFileSync(tool, ['sign', '--ks', key, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey',
      '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false', '--out', signed, file], { stdio: 'pipe' })
    const output = execFileSync(tool, buildVerifyArgs(signed), { encoding: 'utf8' })
    if (!evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: SIGNING_CERTIFICATE }).ok) throw new Error('independent APK signature verification failed')
    renameSync(signed, file)
  }
  const reports = join(root, '.deploy-tmp/source-build')
  writeFileSync(join(reports, 'signing-certificate-sha256.txt'), SIGNING_CERTIFICATE + '\n')
  writeFileSync(join(reports, 'apk-sha256.txt'), files.map(file => createHash('sha256').update(readFileSync(file)).digest('hex') + '  ' + file.slice(root.length + 1).replaceAll('\\', '/')).join('\n') + '\n')
  console.log('Final ARM64 source APK signed and verified with the private Pocket Harness identity')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) signSourceArtifacts()
