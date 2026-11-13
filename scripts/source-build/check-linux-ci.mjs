#!/usr/bin/env node
// Fail closed if the maintained source workflow reconnects the retired runtime chain,
// loses its main-branch guard, or drops production signing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export function checkLinuxCi(source) {
  assert.match(source, /needs: base/)
  assert.match(source, /test "\$DSH_ABI" = arm64/)
  assert.match(source, /test "\$SOURCE_REF" = refs\/heads\/main/)
  assert.match(source, /run: node scripts\/source-build\/build-linux-payload\.mjs/)
  assert.match(source, /run: node scripts\/source-build\/build-linux-apk\.mjs/)
  assert.equal((source.match(/run: python3 scripts\/source-build\/verify-linux-payload\.py --apk-dir out/g) || []).length, 2)
  assert.doesNotMatch(source, /prepare-termux|termux-package|build-node-pty-android|build-snapshot-013|scripts\/build-apk\.mjs|injected-cache|DSH_INJECTED_SNAPSHOT|linux_experiment|DSH_LINUX_EXPERIMENT/)
  // Production signing must remain an isolated main-only job over independently verified bytes.
  assert.ok(source.includes('name: pocket-harness-${{ inputs.abi || \'arm64\' }}-source-${{ github.sha }}'))
  assert.ok(source.includes('POCKET_SIGNING_KEYSTORE_BASE64: ${{ secrets.POCKET_SIGNING_KEYSTORE_BASE64 }}'))
  assert.ok(source.includes('node scripts/source-build/sign-source-artifacts.mjs'))
  assert.ok(source.includes("if: github.ref == 'refs/heads/main' && inputs.reference != false"))
  // Intermediate, verifier and production-signed artifacts each retain the identity receipt.
  assert.equal((source.match(/^            \.deploy-tmp\/source-build\/linux-payload-identity\.json$/gm) || []).length, 3)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(resolve(ROOT, '.github/workflows/build-apk-source.yml'), 'utf8')
  checkLinuxCi(source)
  if (process.argv.includes('--self-test')) {
    for (const [from, to] of [
      ['test "$DSH_ABI" = arm64', 'true'],
      ['test "$SOURCE_REF" = refs/heads/main', 'test "$SOURCE_REF" = refs/heads/codex/linux-runtime-experiment'],
      ['build-linux-payload.mjs', 'build-snapshot-013.mjs'],
      ['verify-linux-payload.py --apk-dir out', 'missing-check.py'],
      ['node scripts/source-build/sign-source-artifacts.mjs', 'true'],
      ["if: github.ref == 'refs/heads/main' && inputs.reference != false", 'if: false'],
      ['POCKET_SIGNING_KEYSTORE_BASE64: ${{ secrets.POCKET_SIGNING_KEYSTORE_BASE64 }}', 'POCKET_SIGNING_KEYSTORE_BASE64: ${{ env.NOPE }}'],
    ]) assert.throws(() => checkLinuxCi(source.replace(from, to)))
    assert.throws(() => checkLinuxCi(source + '\n# prepare-termux-bootstrap.py\n'))
    assert.throws(() => checkLinuxCi(source + '\n# linux_experiment\n'))
  }
  console.log('Linux CI contract verified')
}
