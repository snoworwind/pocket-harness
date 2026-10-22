import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const workspacePrefix = '${{ github.workspace }}'
const readWorkflow = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')

function linuxTermuxPaths(workflowName) {
  const source = readWorkflow(workflowName)
  const value = key => {
    const match = source.match(new RegExp(`^\\s+${key}: (.+)$`, 'm'))
    assert.ok(match, `${workflowName} must declare ${key}`)
    assert.ok(match[1].startsWith(workspacePrefix), `${workflowName} ${key} must stay in the workspace`)
    return resolve(match[1].replace(workspacePrefix, '/workspace'))
  }
  return { webroot: value('TERMUX_WEBROOT'), provenance: value('TERMUX_PROVENANCE') }
}

function expectedProvenance(webroot) {
  return resolve(dirname(webroot), 'termux-packages-provenance.json')
}

test('both Linux asset workflows consume provenance beside the generated Termux webroot', () => {
  const producer = readFileSync(new URL('./prepare-termux-signed-repo.py', import.meta.url), 'utf8')
  assert.match(producer, /webroot\.parent \/ "termux-packages-provenance\.json"/)
  for (const workflow of ['build-linux-assets.yml', 'build-apk-source.yml']) {
    const paths = linuxTermuxPaths(workflow)
    assert.equal(paths.provenance, expectedProvenance(paths.webroot), `${workflow} provenance path must match the producer`)
  }
})

test('negative control: provenance nested inside the webroot is rejected', () => {
  const { webroot, provenance } = linuxTermuxPaths('build-linux-assets.yml')
  const stalePath = resolve(webroot, 'termux-packages-provenance.json')
  assert.notEqual(stalePath, expectedProvenance(webroot))
  assert.notEqual(provenance, stalePath)
})
