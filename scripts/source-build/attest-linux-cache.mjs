#!/usr/bin/env node
// 复用 arm64 Linux assets 缓存时的来源再证明。
//
// Linux assets 的实际输入是 pinned 的 linux-inputs/linux-source-manifest + 构建脚本，与 APK 的
// project commit 无关；但构建脚本会把当时的 HEAD 写进 provenance/project-source-commit.txt，
// 下游 prepare-linux-snapshot-bundle.mjs / prepare-source-release.py 要求它等于当前 commit。
//
// 缓存 key 已由这些输入的哈希构成，命中即代表输入未变。这里在命中后再次核对：
//   - assets/linux-release.json 的 sha256 == linux-runtime-manifest.sha256
//   - runtimeVersion 与当前 linux-inputs.json 一致
//   - provenance 里保存的 linux-inputs.json / linux-source-manifest.json 与仓库当前文件逐字节一致
// 全部通过才把 project-source-commit.txt 改写为当前 commit，并记录 reused-from-commit 与输入哈希。
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (message) => { throw new Error(message) }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const read = (path) => readFileSync(path)

export function attest(buildDir, commit) {
  if (!/^[a-f0-9]{40}$/i.test(commit)) fail(`invalid commit: ${commit}`)
  const provenance = join(buildDir, 'provenance')
  const assets = join(buildDir, 'assets')
  const marker = join(provenance, 'project-source-commit.txt')
  if (!existsSync(marker)) fail('missing provenance/project-source-commit.txt')
  const previous = read(marker).toString('utf8').trim()
  if (previous === commit) return { commit, reusedFrom: previous, changed: false }

  const releasePath = join(assets, 'linux-release.json')
  const digestPath = join(assets, 'linux-runtime-manifest.sha256')
  if (!existsSync(releasePath) || !existsSync(digestPath)) fail('Linux release manifest or digest missing')
  const release = read(releasePath)
  const expectedDigest = read(digestPath).toString('utf8').trim()
  if (sha(release) !== expectedDigest) fail('Linux release manifest digest mismatch')
  const manifest = JSON.parse(release.toString('utf8'))
  const inputs = JSON.parse(read(join(ROOT, 'scripts/source-build/linux-inputs.json')).toString('utf8'))
  if (manifest.version !== inputs.runtimeVersion) fail(`runtimeVersion mismatch: ${manifest.version} != ${inputs.runtimeVersion}`)
  if (manifest.runtimes?.length !== 1 || manifest.runtimes[0]?.architecture !== 'arm64') fail('Linux manifest must contain exactly one ARM64 runtime')

  for (const name of ['linux-inputs.json', 'linux-source-manifest.json']) {
    const cached = join(provenance, name)
    if (!existsSync(cached)) fail(`cached provenance missing: ${name}`)
    if (sha(read(cached)) !== sha(read(join(ROOT, 'scripts/source-build', name)))) {
      fail(`cached provenance ${name} differs from the current pinned input`)
    }
  }

  writeFileSync(marker, commit + '\n')
  writeFileSync(join(provenance, 'reused-from-commit.txt'), previous + '\n')
  writeFileSync(join(provenance, 'reuse-attestation.json'), JSON.stringify({
    commit,
    reusedFromCommit: previous,
    linuxInputsSha256: sha(read(join(ROOT, 'scripts/source-build/linux-inputs.json'))),
    linuxSourceManifestSha256: sha(read(join(ROOT, 'scripts/source-build/linux-source-manifest.json'))),
    releaseManifestSha256: expectedDigest,
    reason: 'pinned Linux inputs unchanged; assets reused for this commit',
  }, null, 2) + '\n')
  return { commit, reusedFrom: previous, changed: true }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'linux-attest-'))
  try {
    const inputs = read(join(ROOT, 'scripts/source-build/linux-inputs.json'))
    const manifest = JSON.stringify({ version: JSON.parse(inputs.toString('utf8')).runtimeVersion, runtimes: [{ architecture: 'arm64' }] })
    mkdirSync(join(dir, 'provenance'), { recursive: true })
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets/linux-release.json'), manifest)
    writeFileSync(join(dir, 'assets/linux-runtime-manifest.sha256'), sha(manifest) + '\n')
    writeFileSync(join(dir, 'provenance/linux-inputs.json'), inputs)
    writeFileSync(join(dir, 'provenance/linux-source-manifest.json'), read(join(ROOT, 'scripts/source-build/linux-source-manifest.json')))
    writeFileSync(join(dir, 'provenance/project-source-commit.txt'), 'a'.repeat(40) + '\n')
    const result = attest(dir, 'b'.repeat(40))
    if (!result.changed) fail('self-test expected a rewrite')
    if (read(join(dir, 'provenance/project-source-commit.txt')).toString('utf8').trim() !== 'b'.repeat(40)) fail('self-test marker not rewritten')
    if (!existsSync(join(dir, 'provenance/reused-from-commit.txt'))) fail('self-test missing reused-from-commit')
    // 负控：输入被改过必须拒绝
    writeFileSync(join(dir, 'provenance/linux-inputs.json'), '{}')
    let refused = false
    try { attest(dir, 'c'.repeat(40)) } catch { refused = true }
    if (!refused) fail('self-test must reject mismatched inputs')
    console.log('SELF-TEST PASSED（Linux assets 复用自证）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--self-test')) selfTest()
    else if (args.length === 2) {
      const result = attest(resolve(args[0]), args[1].trim())
      console.log(`Linux assets attestation: ${result.reusedFrom} -> ${result.commit}${result.changed ? '' : ' (unchanged)'}`)
    } else {
      console.error('usage: attest-linux-cache.mjs <linux-build-dir> <commit> | --self-test')
      process.exit(2)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
