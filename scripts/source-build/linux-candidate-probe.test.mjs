import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const kotlin = readFileSync(new URL('../../app/src/main/java/com/snoworwind/pocketharness/LinuxCandidateProbe.kt', import.meta.url), 'utf8')
const script = kotlin.match(/nativeProbeScript = """([\s\S]*?)"""\.trimIndent\(\)/)[1]

for (const mode of ['ok', 'lock-failure', 'pty-exit', 'pty-output', 'pty-no-fork', 'pty-spawn']) {
  test(`actual candidate script checks exported flock and PTY: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-probe-'))
    try {
      writeFileSync(join(root, 'package.json'), '{}')
      const addon = join(root, 'node_modules/@deepseek-ai/node-addon-system')
      mkdirSync(addon, { recursive: true })
      // Match the pinned package's subpath-only exports and lazy binding behavior.
      writeFileSync(join(addon, 'package.json'), JSON.stringify({ type: 'module', exports: { './flock': './flock.js' } }))
      writeFileSync(join(addon, 'flock.js'), `export async function tryLockExclusive(fd) {
        if (!Number.isInteger(fd)) throw Error('bad fd');
        ${mode === 'lock-failure' ? "throw Error('native flock unavailable');" : "globalThis.flockAcquired = true;"}
      }`)
      const consumer = join(root, 'node_modules/@deepseek-ai/dsh-subprocess-local')
      mkdirSync(consumer, { recursive: true })
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ exports: {'./package.json': './package.json'} }))
      const pty = join(consumer, 'node_modules/node-pty')
      mkdirSync(pty, { recursive: true })
      writeFileSync(join(pty, 'index.js'), `exports.spawn=(file,args)=>{
        if (!globalThis.flockAcquired) throw Error('native lock never acquired');
        if (file!=='/bin/bash'||!args[1].includes('/bin/true')||!args[1].includes('| /bin/cat')) throw Error('missing guest fork/pipeline probe');
        ${mode === 'pty-spawn' ? "throw Error('PTY unavailable');" : ''}
        return {onData(fn){fn(${JSON.stringify(mode === 'pty-output' ? 'wrong' : mode === 'pty-no-fork' ? 'PTY_OK' : 'PTY_FORKPTY_OK')})},
          onExit(fn){setImmediate(()=>fn({exitCode:${mode === 'pty-exit' ? 1 : 0}}))}};
      }`)
      const result = spawnSync(process.execPath, ['--expose-internals', '-e',
        script.replace('/opt/dsh/@deepseek-ai/dsh/package.json', join(root, 'package.json'))],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } })
      assert.equal(result.error, undefined)
      assert.equal(result.status, mode === 'ok' ? 0 : 1, result.stderr)
      assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{}')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
