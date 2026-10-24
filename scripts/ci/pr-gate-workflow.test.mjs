import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Structural regression for the PR Gate layering decisions (2026-10-20).
//
// These are deliberate relaxations for a repo where every change lands through a PR
// (public + branch protection since 2026-10-20): the merge commit's tree was already
// validated by the PR run of the same HEAD. Each assertion below pins one decision so a
// later edit cannot silently reintroduce the cost or, worse, drop the coverage that
// replaced it.
const workflow = readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

function jobBody(name) {
  const start = workflow.indexOf(`\n  ${name}:`)
  assert.ok(start >= 0, `job ${name} missing`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

test('the hosted pipeline is dormant unless the repository variable enables it', () => {
  // The hosted pipeline has been the merge gate since 2026-10-20 (PR_GATE_MODE=on). Every
  // job must carry the switch so the always-run gate-sentinel stays the single authority:
  // if the variable is ever lost, the sentinel turns red instead of leaving silently
  // skipped jobs that GitHub counts as passed required checks.
  const jobs = ['changes', 'docs-hygiene', 'static', 'compile', 'maintenance']
  for (const job of jobs) {
    assert.match(jobBody(job), /vars\.PR_GATE_MODE == 'on'/, `job ${job} ignores PR_GATE_MODE`)
  }
})

test('PR Gate runs on pull requests only', () => {
  const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'))
  assert.match(trigger, /^ {2}pull_request:/m)
  assert.doesNotMatch(trigger, /^ {2}push:/m, 'a push trigger re-validates a tree the PR run already covered')
})

test('superseded pushes cancel instead of stacking', () => {
  assert.match(workflow, /^concurrency:$/m)
  assert.match(workflow, /cancel-in-progress: true/)
})

test('docs-only changes skip the static gate job but keep hygiene', () => {
  const staticJob = jobBody('static')
  assert.match(staticJob, /needs: changes/)
  assert.match(staticJob, /docs_only != 'true'/)
  // Fail-safe: an empty classification (e.g. the changes job failed) must still run the gate.
  assert.match(staticJob, /if: always\(\)/)
  const hygiene = jobBody('docs-hygiene')
  assert.doesNotMatch(hygiene, /needs:/, 'hygiene must run even when classification is unavailable')
  assert.match(hygiene, /冲突标记检查/)
  assert.match(hygiene, /敏感信息扫描/)
})

test('conflict and secret scanning stay out of the skippable job', () => {
  const staticJob = jobBody('static')
  assert.doesNotMatch(staticJob, /冲突标记检查/)
  assert.doesNotMatch(staticJob, /敏感信息扫描/)
})

test('Kotlin compile is skipped only for an explicit false classification', () => {
  // Fail-safe: a missing classification (the changes job failed) must run the gate, not skip it.
  assert.match(jobBody('compile'), /always\(\) && vars\.PR_GATE_MODE == 'on' && needs\.changes\.outputs\.apk != 'false'/)
})
