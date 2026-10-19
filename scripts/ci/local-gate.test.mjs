import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractWorkflowSteps, renderScript, selectSteps, summarize } from './local-gate.mjs'

const workflowPath = new URL('../../.github/workflows/pr-gate.yml', import.meta.url)

// The local gate derives its steps from the workflow rather than a second checklist, so
// these counts are the contract between the two: if a gate is added to or removed from
// pr-gate.yml, the numbers here change and force a deliberate update.
test('step selection follows the workflow job conditions', () => {
  const docsOnly = selectSteps({ docsOnly: true, apk: false, workflowPath })
  const noKotlin = selectSteps({ docsOnly: false, apk: false, workflowPath })
  const withKotlin = selectSteps({ docsOnly: false, apk: true, workflowPath })

  assert.equal(docsOnly.length, 2, 'docs-only runs the hygiene job only')
  assert.deepEqual(docsOnly.map((step) => step.job), ['docs-hygiene', 'docs-hygiene'])

  assert.equal(noKotlin.length, 25, 'code change without apk runs hygiene + static')
  assert.equal(noKotlin.filter((step) => step.job === 'static').length, 23)
  assert.equal(noKotlin.filter((step) => step.job === 'compile').length, 0)

  assert.equal(withKotlin.length, 28, 'apk change adds the three compile gate steps')
  assert.deepEqual(withKotlin.filter((step) => step.job === 'compile').map((step) => step.name), [
    '编译与单元测试门禁（testDebugUnitTest 自动编译主代码和测试）',
    'Kotlin 单测数量反回归（逐类基线 + 无缺席 + 结果新鲜）',
    '快照解码器反证自测（合成归档）',
  ])
})

test('environment preparation and failure-only steps are not re-run locally', () => {
  const steps = selectSteps({ docsOnly: false, apk: true, workflowPath })
  assert.equal(steps.filter((step) => step.run.includes('sdkmanager')).length, 0, 'the image provides the SDK')
  assert.equal(steps.filter((step) => step.run.includes('upload-artifact')).length, 0)
  // Multi-line blocks must survive intact, not collapse to their first line.
  const patches = steps.find((step) => step.name.includes('补丁自洽'))
  assert.match(patches.run, /check-patch-test-manifest\.mjs/)
  assert.ok(patches.run.split('\n').length >= 3)
})

test('the reader understands the workflow shapes and ignores the rest', () => {
  const fixture = [
    'jobs:',
    '  alpha:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: inline',
    '        run: echo one',
    '      - name: block',
    '        run: |',
    '          set -e',
    '          echo two',
    '',
    '          echo three',
    '      - name: report',
    '        if: failure()',
    '        run: echo report',
    '  beta:',
    '    steps:',
    '      - name: other job',
    '        run: echo beta',
  ].join('\n')
  const alpha = extractWorkflowSteps(fixture, ['alpha'])
  assert.deepEqual(alpha.map((step) => step.name), ['inline', 'block', 'report'])
  assert.equal(alpha[0].run, 'echo one')
  assert.equal(alpha[1].run, 'set -e\necho two\n\necho three')
  assert.equal(alpha[2].if, 'failure()')
  assert.deepEqual(extractWorkflowSteps(fixture, ['beta']).map((step) => step.name), ['other job'])
})

test('rendered script isolates every step in a subshell', () => {
  const steps = [{ job: 'static', name: 'a', run: 'true' }, { job: 'static', name: 'b', run: 'false' }]
  const script = renderScript(steps)
  assert.equal((script.match(/^\($/gm) ?? []).length, 2, 'one subshell per step keeps always()-like behaviour')
  assert.equal((script.match(/::DSH_RC::/g) ?? []).length, 2)
  assert.match(script, /^set -u$/m)
})

test('the workflow still carries every job the gate expects', () => {
  const text = readFileSync(workflowPath, 'utf8')
  for (const job of ['docs-hygiene', 'static', 'compile']) {
    assert.ok(text.includes(`\n  ${job}:\n`), `missing job ${job}`)
  }
})

test('step timestamps come from inside the container', () => {
  // The host only sees the finished stream, so durations cannot be measured by parsing
  // after the fact: each marker carries an epoch-ms stamp taken in the container.
  const steps = [{ job: 'static', name: 'a', run: 'true' }, { job: 'static', name: 'b', run: 'false' }]
  const script = renderScript(steps)
  assert.match(script, /::DSH_STEP::0::%s/)
  assert.match(script, /dsh_rc=\$\?/)
  const output = [
    '::DSH_STEP::0::1000', 'true', '::DSH_RC::0::0::1250',
    '::DSH_STEP::1::1300', 'false', '::DSH_RC::1::1::1900',
  ].join('\n')
  const results = summarize(output, steps)
  assert.deepEqual(results.map((r) => [r.rc, r.durationMs]), [[0, 250], [1, 600]])
})

test('a step that never reports a status is not counted as green', () => {
  const steps = [{ job: 'static', name: 'missing', run: 'true' }]
  const results = summarize('no markers at all', steps)
  assert.equal(results[0].rc, null)
  assert.notEqual(results[0].rc, 0)
})
