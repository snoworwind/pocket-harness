import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../../.github/workflows/finalize-v01410-release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

test('published release reconciliation is restricted to the main release-note update', () => {
  assert.match(workflow, /^  push:\n    branches:\n      - main\n    paths:\n      - release\/v0\.14\.10\/notes\.md/m)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /publish:\n    needs: prepare[\s\S]*?permissions:\n      contents: write/)
  assert.match(workflow, /gh release upload .*--clobber/)
  assert.match(workflow, /--draft=false --latest/)
  assert.doesNotMatch(workflow, /gh release edit[^\n]*--prerelease/)
  assert.match(workflow, /--self-test-negative/)
  assert.match(workflow, /--verify release-assets\/release-after\.json/)
  assert.match(workflow, /gh api .*\/releases\/latest/)
  assert.match(workflow, /r\["tag_name"\] == os\.environ\["RELEASE_TAG"\]/)
  assert.doesNotMatch(workflow, /isLatest/)
})
