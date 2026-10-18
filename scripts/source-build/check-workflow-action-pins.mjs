import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

// Tags can be retargeted after review, including in jobs holding a write token.
export function checkWorkflowActionPins(text, file = 'workflow') {
  const problems = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = /^\s*(?:-\s*)?uses:\s*(.*?)\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    const ref = match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
    const local = /^\.\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(ref)
      && !ref.split('/').includes('..')
    const remote = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/.test(ref)
    const docker = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(ref)
    if (!local && !remote && !docker) problems.push(`${file}:${index + 1}: action must use a full commit SHA or image digest: ${ref}`)
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--self-test')) {
    for (const ref of ['actions/checkout@v4', 'actions/checkout@main', '${{ inputs.action }}', 'docker://alpine:latest']) {
      assert.equal(checkWorkflowActionPins(`- uses: ${ref}`).length, 1, ref)
    }
    assert.deepEqual(checkWorkflowActionPins(`- uses: actions/checkout@${'a'.repeat(40)}\n- uses: ./.github/workflows/build.yml`), [])
    console.log('PASS workflow action pin self-test and controlled mutable-ref negative controls')
  }
  const directoryArg = process.argv.slice(2).find(value => value !== '--self-test')
  const directory = resolve(directoryArg || fileURLToPath(new URL('../../.github/workflows/', import.meta.url)))
  const problems = readdirSync(directory).filter(name => /\.ya?ml$/.test(name))
    .flatMap(name => checkWorkflowActionPins(readFileSync(resolve(directory, name), 'utf8'), name))
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1 }
  else console.log('PASS workflow external actions use immutable references')
}
