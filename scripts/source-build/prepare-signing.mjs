import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readKeystoreCertificate } from '../check-apk-signatures.mjs'

export const SIGNING_CERTIFICATE = 'ef52b80c63efa4a53cd85b0eaf72d02222b34085a6e2f8317f08d31615f29127'
export function verifySigningIdentity(file) {
  if (readKeystoreCertificate(file) !== SIGNING_CERTIFICATE) throw new Error('signing key is not the Pocket Harness release identity')
}

export function prepareSigning(root, env = process.env) {
  const destination = join(root, '.deploy-tmp/signing/pocket-harness.keystore')
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  if (env.POCKET_SIGNING_KEYSTORE_BASE64) {
    writeFileSync(destination, Buffer.from(env.POCKET_SIGNING_KEYSTORE_BASE64, 'base64'), { mode: 0o600 })
  } else {
    const source = env.POCKET_SIGNING_KEYSTORE_PATH || join(homedir(), '.local/share/pocket-harness/release.keystore')
    if (!existsSync(source)) throw new Error('Pocket Harness private signing key is missing; configure POCKET_SIGNING_KEYSTORE_BASE64 secret or POCKET_SIGNING_KEYSTORE_PATH')
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
  }
  verifySigningIdentity(destination)
  return destination
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Pocket Harness signing identity verified: ${prepareSigning(process.cwd())}`)
}
