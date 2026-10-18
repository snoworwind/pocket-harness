import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGithubUrl } from './manifest.js'

const bytesValue = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array

async function digestFile(filePath) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), size }
}

const INTEGRITY_MARKER = '.dsh-asset-integrity.json'

async function unpackedBytes(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw new Error('Extracted plugin bundles may not contain symlinks')
    if (info.isDirectory()) total += await unpackedBytes(child)
    // Our own bookkeeping is not payload: the manifest's unpackedSize is measured
    // over the archive's contents, before this marker is written.
    else if (info.isFile() && entry.name !== INTEGRITY_MARKER) total += info.size
    else if (!info.isFile()) throw new Error('Unsupported filesystem entry in extracted plugin bundle')
  }
  return total
}

function assertAsset(asset) {
  if (!asset || typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(asset.unpackedSize) || asset.unpackedSize < 0 || asset.unpackedSize > 512 * 1024 * 1024) {
    throw new TypeError('Asset requires url, SHA-256, size, and unpackedSize')
  }
  const url = parseGithubUrl(asset.url)
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match || url.search || url.hash) throw new TypeError('Asset must use a versioned HTTPS GitHub release URL')
  return url.href
}

export async function installVerifiedPluginBundle({
  asset,
  destinationRoot,
  hostStagingRoot,
  requireStagedBundle = false,
  downloadAsset,
  extractArchive,
  fetchImpl = globalThis.fetch,
  kind = 'plugin',
  packageName,
  entry = 'lib/index.js',
}) {
  const url = assertAsset(asset)
  if (typeof destinationRoot !== 'string' || !destinationRoot) throw new TypeError('destinationRoot is required')
  if (typeof downloadAsset !== 'function' || typeof extractArchive !== 'function') throw new TypeError('downloadAsset and safe extractArchive adapters are required')
  const root = path.resolve(destinationRoot)
  await mkdir(root, { recursive: true })
  const finalDirectory = path.join(root, asset.sha256)
  // Mutable unpacked trees and size-only markers are not content evidence.
  // Always copy and hash the archive, then independently decode it into a fresh slot.
  const token = randomUUID()
  const archivePath = path.join(root, `.asset-${token}`)
  const staging = path.join(root, `.stage-${token}`)
  const resultDirectory = path.join(staging, 'package')
  await mkdir(staging, { recursive: true })
  try {
    let downloaded
    if (hostStagingRoot) {
      const retained = path.join(path.resolve(hostStagingRoot), asset.sha256, 'asset.tar.xz')
      const info = await lstat(retained).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Host-staged archive must be a regular file')
      if (info) downloaded = retained
      else if (requireStagedBundle) throw new Error('No host-staged bundle is available')
    }
    downloaded ??= await downloadAsset({ ...asset, url }, { destination: archivePath, fetchImpl })
    if (bytesValue(downloaded)) await writeFile(archivePath, downloaded)
    else if (typeof downloaded === 'string' && path.resolve(downloaded) !== archivePath) await copyFile(downloaded, archivePath)
    else if (bytesValue(downloaded?.data)) await writeFile(archivePath, downloaded.data)
    else if (downloaded?.path && path.resolve(downloaded.path) !== archivePath) await copyFile(downloaded.path, archivePath)
    const archiveInfo = await lstat(archivePath)
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('Asset downloader must produce a regular file')
    const digest = await digestFile(archivePath)
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) throw new Error('Plugin asset SHA-256 or size verification failed')
    await mkdir(resultDirectory, { recursive: true })
    await extractArchive(archivePath, resultDirectory, { kind, safe: true, stripComponents: 0 })
    const packageDirectory = await pickPackageDirectory(resultDirectory)
    const unpackedSize = await unpackedBytes(packageDirectory)
    if (unpackedSize !== asset.unpackedSize) throw new Error(`Unpacked size mismatch: expected ${asset.unpackedSize}, got ${unpackedSize}`)
    if (packageName) await validatePackage(packageDirectory, packageName, entry)
    await publishBundle({ root, finalDirectory, packageDirectory, asset, unpackedSize, token })
    return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize, reused: false }
  } catch (error) {
    throw error
  } finally {
    await rm(archivePath, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Locate the package directory inside an unpacked bundle: some archives root the
 * package at `package/`, others are already rooted at it.
 */
async function pickPackageDirectory(rootDirectory) {
  const nested = path.join(rootDirectory, 'package')
  try {
    if ((await stat(path.join(nested, 'package.json'))).isFile()) return nested
  } catch { /* Archive is already rooted at the package directory. */ }
  return rootDirectory
}

/**
 * Publish a verified package directory as `<root>/<sha256>`, replacing any
 * previous copy atomically and rolling back if the swap fails.
 */
async function publishBundle({ root, finalDirectory, packageDirectory, asset, unpackedSize, token }) {
  await writeFile(path.join(packageDirectory, '.dsh-asset-integrity.json'), `${JSON.stringify({ sha256: asset.sha256, size: asset.size, unpackedSize })}\n`)
  const backupDirectory = path.join(root, `.backup-${token}`)
  let hadPrevious = false
  try {
    await rename(finalDirectory, backupDirectory)
    hadPrevious = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await rename(packageDirectory, finalDirectory)
    if (hadPrevious) await rm(backupDirectory, { recursive: true, force: true })
  } catch (error) {
    if (hadPrevious) await rename(backupDirectory, finalDirectory).catch(() => {})
    throw error
  }
}

async function validatePackage(directory, packageName, entry) {
  const metadataPath = path.join(directory, 'package.json')
  const metadataStat = await lstat(metadataPath)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('Verified plugin archive is missing a regular package.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (metadata.name !== packageName) throw new Error(`Expected plugin package ${packageName}`)
  const entryPath = path.resolve(directory, entry)
  const relative = path.relative(directory, entryPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin entry escapes package directory')
  const entryStat = await lstat(entryPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Plugin entry ${entry} is missing or unsafe`)
}
