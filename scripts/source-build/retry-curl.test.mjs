import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve(fileURLToPath(new URL('./retry-curl.sh', import.meta.url)))
const linux = { skip: process.platform !== 'linux' }

function runFixture(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'retry-curl-'))
  try {
    const bin = join(root, 'bin')
    const count = join(root, 'curl-count')
    const sleeps = join(root, 'sleep-count')
    mkdirSync(bin)
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -u
count=0
[[ -f "$CURL_COUNT_FILE" ]] && count=$(cat "$CURL_COUNT_FILE")
count=$((count + 1))
printf '%s' "$count" > "$CURL_COUNT_FILE"
case "$CURL_SCENARIO" in
  recover) [[ "$count" -eq 1 ]] && exit 56 || exit 0 ;;
  permanent-http) exit 22 ;;
  permanent-tls) exit 60 ;;
  exhausted) exit 56 ;;
esac
exit 99
`)
    writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash
count=0
[[ -f "$SLEEP_COUNT_FILE" ]] && count=$(cat "$SLEEP_COUNT_FILE")
printf '%s' "$((count + 1))" > "$SLEEP_COUNT_FILE"
`)
    chmodSync(join(bin, 'curl'), 0o755)
    chmodSync(join(bin, 'sleep'), 0o755)
    const result = spawnSync('bash', [SCRIPT, '--fail', '--location', '--retry', '8', '--retry-max-time', '600',
      'https://example.invalid/pinned.zip', '--output', join(root, 'download.zip')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_SCENARIO: scenario, CURL_COUNT_FILE: count, SLEEP_COUNT_FILE: sleeps },
    })
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: Number(readFileSync(count, 'utf8')),
      sleeps: existsSync(sleeps) ? readFileSync(sleeps, 'utf8') : '0',
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('curl receive failures retry and then recover', linux, () => {
  const result = runFixture('recover')
  assert.equal(result.status, 0, result.output)
  assert.equal(result.attempts, 2)
  assert.match(result.output, /transient transport error 56/)
})

test('permanent HTTP and TLS failures stop after the first curl call', linux, () => {
  for (const [scenario, exitCode] of [['permanent-http', 22], ['permanent-tls', 60]]) {
    const result = runFixture(scenario)
    assert.equal(result.status, exitCode, result.output)
    assert.equal(result.attempts, 1)
    assert.doesNotMatch(result.output, /retrying in/)
  }
})

test('curl transport retries have a fixed attempt and backoff bound', linux, () => {
  const result = runFixture('exhausted')
  assert.equal(result.status, 56, result.output)
  assert.equal(result.attempts, 8)
  assert.equal(Number(result.sleeps), 7)
  assert.match(result.output, /persisted after 8 attempts/)
})
