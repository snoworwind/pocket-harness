#!/usr/bin/env node
// Fail closed if this experimental branch reconnects the retired runtime chain.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export function checkLinuxCi(source) {
  assert.match(source, /needs: base/)
  assert.match(source, /test "\$DSH_ABI" = arm64/)
  assert.match(source, /test "\$SOURCE_REF" = refs\/heads\/codex\/linux-runtime-experiment/)
  assert.match(source, /test "\$LINUX_EXPERIMENT" = true/)
  assert.match(source, /run: node scripts\/source-build\/build-linux-payload\.mjs/)
  assert.match(source, /run: node scripts\/source-build\/build-linux-apk\.mjs/)
  assert.equal((source.match(/run: python3 scripts\/source-build\/verify-linux-payload\.py --apk-dir out/g) || []).length, 2)
  assert.doesNotMatch(source, /prepare-termux|termux-package|build-node-pty-android|build-snapshot-013|scripts\/build-apk\.mjs|injected-cache|DSH_INJECTED_SNAPSHOT|sign-source-artifacts|contents: write|secrets\./)
  assert.equal((source.match(/^            \.deploy-tmp\/source-build\/linux-payload-identity.json$/gm) || []).length, 2)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(resolve(ROOT, '.github/workflows/build-apk-source.yml'), 'utf8')
  checkLinuxCi(source)
  if (process.argv.includes('--self-test')) {
    for (const [from, to] of [
      ['test "$DSH_ABI" = arm64', 'true'],
      ['test "$SOURCE_REF" = refs/heads/codex/linux-runtime-experiment', 'true'],
      ['test "$LINUX_EXPERIMENT" = true', 'true'],
      ['build-linux-payload.mjs', 'build-snapshot-013.mjs'],
      ['verify-linux-payload.py --apk-dir out', 'missing-check.py'],
    ]) assert.throws(() => checkLinuxCi(source.replace(from, to)))
    assert.throws(() => checkLinuxCi(source + '\n# prepare-termux-bootstrap.py\n'))
  }
  console.log('Linux CI contract verified')
}
