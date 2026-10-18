import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { finalApks } from './sign-source-artifacts.mjs'
import { normalizeSnapshotEntries } from './normalize-snapshot.mjs'

export function inspectApk(apk) {
  const work = mkdtempSync(join(tmpdir(), 'pocket-independent-'))
  try {
    const report = join(work, 'report.json')
    execFileSync(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./read-apk-snapshot.py', import.meta.url)), apk, report], { stdio: 'pipe' })
    const data = JSON.parse(readFileSync(report, 'utf8'))
    const entries = data.snapshotEntries.map(entry => {
      if (entry.bodyBase64 !== undefined) entry.body = Buffer.from(entry.bodyBase64, 'base64')
      return entry
    })
    return { apkEntries: data.apkEntries, hardManifest: data.hardManifest, snapshot: normalizeSnapshotEntries(entries) }
  } finally { rmSync(work, { recursive: true, force: true }) }
}

export function compareApks(primary, reference) {
  const actual = inspectApk(primary), rebuilt = inspectApk(reference)
  if (!isDeepStrictEqual(actual.apkEntries, rebuilt.apkEntries)) throw new Error('independent APK payload differs outside the snapshot')
  if (!isDeepStrictEqual(actual.hardManifest, rebuilt.hardManifest)) throw new Error('independent hard ownership manifest differs')
  if (actual.snapshot.normalizedManifestSha256 !== rebuilt.snapshot.normalizedManifestSha256) {
    const expected = new Set(rebuilt.snapshot.manifest)
    const differences = actual.snapshot.manifest.filter(row => !expected.has(row)).slice(0, 10).map(row => row.split('\0')[0])
    throw new Error(`independent runtime payload differs: ${differences.join(', ')}`)
  }
  return { schema: 1, independentRebuildMatched: true, normalizationVersion: actual.snapshot.normalizationVersion,
    normalizedManifestSha256: actual.snapshot.normalizedManifestSha256, apkPayloadFiles: Object.keys(actual.apkEntries).length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const primary = finalApks(resolve('.'))[0]
  const reference = finalApks(resolve(process.env.DSH_REFERENCE_ARTIFACT_DIR || '.deploy-tmp/independent-reference'))[0]
  const result = compareApks(primary, reference)
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw new Error('independent verification requires the source commit')
  result.sourceCommit = process.env.GITHUB_SHA
  result.primaryUnsignedApkSha256 = createHash('sha256').update(readFileSync(primary)).digest('hex')
  result.referenceUnsignedApkSha256 = createHash('sha256').update(readFileSync(reference)).digest('hex')
  writeFileSync('.deploy-tmp/source-build/independent-rebuild-verification.json', JSON.stringify(result, null, 2) + '\n')
  console.log(`Independent APK and runtime rebuild verified: ${result.normalizedManifestSha256}`)
}
