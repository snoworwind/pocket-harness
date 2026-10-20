/**
 * Host archive adapter. Assets are copied from the signed APK's Termux snapshot into
 * host staging; bootstrap independently hashes the retained archive before extraction.
 * Mutable host unpacked trees and cache markers are never used as executable payload.
 */
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import xz from 'xz-decompress'
import tar from 'tar-stream'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { LINUX_MANIFEST_DIGEST_FILE } from './linux-release-pins.js'

/** 与 Kotlin `LinuxAssetIO.ENV_DIR` 同口径（`check-linux-host-staging-invariant` 守）。 */
export const LINUX_ENV_DIR = 'linux-environment'
/** 与 Kotlin `LinuxAssetPrepare.DIR_STAGING` 同口径。 */
export const STAGING_DIR = 'staging'
/** 宿主保留的归档名（`LinuxAssetPrepare.prepareInto` 写下的就是它）。 */
export const RETAINED_ARCHIVE = 'asset.tar.xz'
/** 宿主已解包树的名字。 */
export const UNPACKED_DIR = 'unpacked'

/** 摘要必须是 64 位小写十六进制 —— 它同时是**路径段的来源**（与 Kotlin `specVerdict` 一致）。 */
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const CODE_ASSET_NOT_PREPARED = 'linux-asset-not-prepared'
export const CODE_ASSET_SPEC_INVALID = 'linux-asset-spec-invalid'
export const CODE_HOST_TREE_UNSAFE = 'linux-host-tree-unsafe'
export const LINUX_BUNDLE_DIR = 'share/pocket-harness/linux-assets'
function defaultBundleDirectory(): string {
  const prefix = process.env.TERMUX__PREFIX
  return typeof prefix === 'string' && prefix !== '' ? join(prefix, LINUX_BUNDLE_DIR) : ''
}
const BUNDLED_ASSET_NAMES = new Set([
  'linux-bootstrap-plugin.tar.xz', 'linux-runtime-plugin.tar.xz',
  'bionilux-backend-aarch64.tar.xz', 'debian-minimal-aarch64.tar.xz',
])
const NODE_ASSET_NAME = /^node-glibc-v\d+\.\d+\.\d+-linux-arm64\.tar\.xz$/

/** 宿主侧资产 IO 的失败都要带稳定码：界面与日志按码判读，不靠文本匹配。 */
export class LinuxHostAssetError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LinuxHostAssetError'
    this.code = code
  }
}

async function readBundledManifest(bundleDirectory: string) {
  const manifestPath = join(bundleDirectory, 'linux-release.json')
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Bundled Linux manifest must be a regular file')
  const bytes = await readFile(manifestPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const digestPath = join(bundleDirectory, LINUX_MANIFEST_DIGEST_FILE)
  const digestInfo = await lstat(digestPath)
  if (!digestInfo.isFile() || digestInfo.isSymbolicLink()) throw new Error('Bundled Linux manifest digest must be a regular file')
  const declaredDigest = (await readFile(digestPath, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(declaredDigest) || declaredDigest !== sha256) throw new Error('Bundled Linux manifest digest does not match its sidecar')
  const manifest = JSON.parse(bytes.toString('utf8'))
  return { manifest, releaseTag: `v${manifest.version}`, sha256 }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(path)
  }
}

const HARDLINK_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK'])

export interface HardLinkOps {
  link(source: string, target: string): Promise<void>
  copyFile(source: string, target: string, flags?: number): Promise<void>
  chmod(target: string, mode: number): Promise<void>
}

const DEFAULT_HARDLINK_OPS: HardLinkOps = {
  link: (source, target) => link(source, target),
  copyFile: (source, target, flags) => copyFile(source, target, flags),
  chmod: (target, mode) => chmod(target, mode),
}

/** Publish a verified archive hard-link target, preserving no-replace semantics on Android. */
export async function publishHardLink(
  source: string,
  target: string,
  sourceMode: number,
  ops: HardLinkOps = DEFAULT_HARDLINK_OPS,
): Promise<'link' | 'copy'> {
  try {
    await ops.link(source, target)
    return 'link'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === undefined || !HARDLINK_FALLBACK_CODES.has(code)) throw error
    await ops.copyFile(source, target, fsConstants.COPYFILE_EXCL)
    await ops.chmod(target, sourceMode & 0o777)
    return 'copy'
  }
}

/** `<filesDir>/linux-environment`，与 Kotlin 的 `root` 同源。 */
export function linuxEnvironmentRoot(filesDir: string): string {
  return join(resolve(filesDir), LINUX_ENV_DIR)
}

/**
 * 把相对名解到 `root` 内（纯函数）：拒绝空、NUL、绝对路径与任何 `..` 段，再按词法包含关系复核。
 *
 * 目标可能尚未创建，所以按 `resolve` 的父级词法结果判定；`..` 已在前面被拒，故词法判定即包含判定。
 */
export function resolveInside(root: string, relative: string): string | null {
  if (relative === '' || relative.includes('\u0000')) return null
  if (isAbsolute(relative)) return null
  if (relative.split(/[/\\]/).some(segment => segment === '..')) return null
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, relative)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) return null
  return target
}

/**
 * 宿主暂存目录 = `<filesDir>/linux-environment/staging/<sha256>`。
 *
 * 摘要格式不合规或推导越界一律返回 `null`（调用方 fail closed）——摘要是路径段的来源，
 * 这条判据必须**先于**任何文件系统动作，理由与 #396 修的穿越缺陷同源。
 */
export function stagedDirectoryFor(filesDir: string, sha256: unknown): string | null {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return null
  return resolveInside(linuxEnvironmentRoot(filesDir), `${STAGING_DIR}/${sha256}`)
}

/** 宿主保留的归档：`.../staging/<sha256>/asset.tar.xz`。 */
export function retainedArchiveFor(filesDir: string, sha256: unknown): string | null {
  const staged = stagedDirectoryFor(filesDir, sha256)
  return staged === null ? null : join(staged, RETAINED_ARCHIVE)
}

/** 宿主已解包树：`.../staging/<sha256>/unpacked`。 */
export function unpackedTreeFor(filesDir: string, sha256: unknown): string | null {
  const staged = stagedDirectoryFor(filesDir, sha256)
  return staged === null ? null : join(staged, UNPACKED_DIR)
}

/** Decode verified archive bytes, never the independently mutable host tree. */
async function extractVerifiedArchive(archivePath: string, destination: string, kind = 'plugin'): Promise<void> {
  const lexicalRoot = resolve(destination)
  const initialInfo = await lstat(lexicalRoot)
  if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink() || (await readdir(lexicalRoot)).length !== 0) {
    throw new Error('Archive destination must be a fresh empty directory')
  }
  // Android may expose one directory through both /data/user/0 and /data/data.
  // Normalize the extraction root before comparing it with realpath(entry.source).
  // Recheck the directory identity after realpath; failure stays closed.
  const root = await realpath(lexicalRoot)
  const [currentInfo, canonicalInfo, currentRoot] = await Promise.all([
    lstat(lexicalRoot),
    lstat(root),
    realpath(lexicalRoot),
  ])
  if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink() ||
      !canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
      currentInfo.dev !== initialInfo.dev || currentInfo.ino !== initialInfo.ino ||
      canonicalInfo.dev !== initialInfo.dev || canonicalInfo.ino !== initialInfo.ino ||
      currentRoot !== root || (await readdir(root)).length !== 0) {
    throw new Error('Archive destination must be a fresh empty directory')
  }
  const seen = new Set<string>()
  const links: { target: string; source: string; hard: boolean }[] = []
  const runtime = ['node', 'backend', 'rootfs'].includes(kind)
  let rootSeen = false
  let entries = 0, declared = 0, decoded = 0
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (++entries > 20_000 || !Number.isSafeInteger(header.size) || (header.size ?? 0) < 0) throw new Error('Archive entry limit exceeded')
      const isLink = header.type === 'symlink' || header.type === 'link'
      if (header.type !== 'file' && header.type !== 'directory' && !(runtime && isLink)) throw new Error('Archive links and special entries are forbidden')
      if (header.name.includes('\\') || /^[A-Za-z]:/.test(header.name)) throw new Error('Unsafe archive path')
      if (header.name === '.' || header.name === './') {
        if (rootSeen || header.type !== 'directory' || header.size !== 0) throw new Error('Unsafe or duplicate archive root')
        rootSeen = true
        stream.resume(); next(); return
      }
      const name = header.name.replace(/^\.\//, '').replace(/\/$/, '')
      const target = resolveInside(root, name)
      if (target === null || target === root || seen.has(target)) throw new Error('Unsafe or duplicate archive path')
      seen.add(target)
      const size = header.size ?? 0
      declared += size
      if (size > 128 * 1024 * 1024 || declared > 512 * 1024 * 1024) throw new Error('Archive payload limit exceeded')
      // Destination is a new bootstrap staging directory; no caller-owned tree is merged.
      if (isLink) {
        const value = header.linkname ?? ''
        if (size !== 0 || !value || value.includes('\u0000') || value.includes('\\') || /^[A-Za-z]:/.test(value)) throw new Error('Unsafe archive link')
        const hard = header.type === 'link'
        // Hard links name archive members; absolute symlinks are guest-rooted only for rootfs.
        if (isAbsolute(value) && (hard || kind !== 'rootfs')) throw new Error('Absolute archive link is forbidden')
        const source = hard ? resolveInside(root, value.replace(/^\.\//, ''))
          : isAbsolute(value) ? resolve(root, '.' + value) : resolve(dirname(target), value)
        if (source === null || (source !== root && !source.startsWith(root + sep))) throw new Error('Archive link escapes extraction root')
        links.push({ target, source, hard })
        stream.resume()
      } else if (header.type === 'directory') {
        if (size !== 0) throw new Error('Directory entry has payload')
        await mkdir(target, { recursive: true })
        stream.resume()
      } else {
        await mkdir(resolve(target, '..'), { recursive: true })
        await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: (header.mode ?? 0o600) & 0o777 }))
      }
      next()
    })().catch(error => extract.destroy(error))
  })
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    decoded += chunk.length
    callback(decoded > 544 * 1024 * 1024 ? new Error('Decoded archive limit exceeded') : null, chunk)
  } })
  const decodedStream = new xz.XzReadableStream(Readable.toWeb(createReadStream(archivePath)) as ReadableStream<Uint8Array>)
  await pipeline(Readable.fromWeb(decodedStream as never), limit, extract)
  // No links exist while file payloads are written. Never traverse a link as a parent.
  const safeParents = async (target: string) => {
    const parts = relative(root, dirname(target)).split(sep).filter(Boolean)
    let parent = root
    for (const part of parts) {
      parent = join(parent, part)
      await ensureDirectory(parent)
    }
  }
  for (const entry of links.filter(item => item.hard)) {
    await safeParents(entry.target)
    const sourceInfo = await lstat(entry.source)
    const physical = await realpath(entry.source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !physical.startsWith(root + sep)) throw new Error('Archive hard link must target an extracted regular file')
    await publishHardLink(entry.source, entry.target, sourceInfo.mode)
  }
  for (const entry of links.filter(item => !item.hard)) {
    await safeParents(entry.target)
    await symlink(relative(dirname(entry.target), entry.source) || '.', entry.target)
  }
}

/** Bootstrap 的两个 IO 适配器：宿主归档读取与独立解码。 */
export interface HostAssetIO {
  /** 交回宿主已暂存的归档路径；宿主没准备好就抛错（**不下载**）。 */
  downloadAsset(asset: { sha256?: unknown }, options?: { destination?: string }): Promise<string>
  /** 从 bootstrap 已验证的归档副本解码到新 staging；不使用宿主解包树。 */
  extractArchive(archivePath: string, destination: string, options?: { kind?: string }): Promise<void>
}

/**
 * 造出 bootstrap 的 `linuxAssetIO`。
 *
 * @param filesDir 壳侧 `DSH_FILES_DIR`；暂存根 = `<filesDir>/linux-environment`。
 */
export function createHostAssetIO(options: { filesDir: string; bundleDirectory?: string }): HostAssetIO {
  const { filesDir } = options
  const bundleDirectory = options.bundleDirectory ?? defaultBundleDirectory()
  if (typeof filesDir !== 'string' || filesDir === '') throw new TypeError('filesDir is required')

  return {
    async downloadAsset(asset: { sha256?: unknown; url?: unknown; size?: unknown }): Promise<string> {
      const archive = retainedArchiveFor(filesDir, asset?.sha256)
      if (archive === null) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, `清单摘要不合规，拒绝推导落点：${String(asset?.sha256)}`)
      }
      try {
        const retained = await lstat(archive)
        if (!retained.isFile() || retained.isSymbolicLink()) throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `保留的归档必须是普通文件：${archive}`)
        return archive
      } catch (error) {
        if (error instanceof LinuxHostAssetError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (typeof asset.url !== 'string' || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, '内置 Linux 资产规格无效')
      }
      let assetUrl: URL
      try { assetUrl = new URL(asset.url) } catch { throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, '内置 Linux 资产 URL 无效') }
      const name = basename(assetUrl.pathname)
      if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'github.com' || assetUrl.username || assetUrl.password || assetUrl.port
        || (!BUNDLED_ASSET_NAMES.has(name) && !NODE_ASSET_NAME.test(name))
        || !/^\/snoworwind\/pocket-harness\/releases\/download\/v\d+\.\d+\.\d+\//.test(assetUrl.pathname)
        || assetUrl.pathname.split('/').at(-1) !== name || assetUrl.search || assetUrl.hash) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, 'Linux 资产不在固定的 ARM64 离线包清单内')
      }
      if (!bundleDirectory) throw new LinuxHostAssetError(CODE_ASSET_NOT_PREPARED, 'APK 内置 Linux 资产目录不可用')
      const source = join(resolve(bundleDirectory), name)
      let sourceInfo
      try { sourceInfo = await lstat(source) } catch { throw new LinuxHostAssetError(CODE_ASSET_NOT_PREPARED, `APK 未包含 Linux 资产：${name}`) }
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== asset.size) {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `APK 内 Linux 资产类型或体积不符：${name}`)
      }
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(source)) digest.update(chunk)
      if (digest.digest('hex') !== asset.sha256) throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `APK 内 Linux 资产摘要不符：${name}`)
      const stagingParent = dirname(archive)
      await ensureDirectory(join(filesDir, LINUX_ENV_DIR))
      await ensureDirectory(join(filesDir, LINUX_ENV_DIR, STAGING_DIR))
      await ensureDirectory(stagingParent)
      const temp = `${archive}.tmp-${randomUUID()}`
      try {
        await pipeline(createReadStream(source), createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
        await rename(temp, archive)
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
      let info
      try {
        info = await lstat(archive)
      } catch {
        throw new LinuxHostAssetError(
          CODE_ASSET_NOT_PREPARED,
          `宿主未准备该资产，拒绝安装（不自行下载）：${archive}`,
        )
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new LinuxHostAssetError(CODE_HOST_TREE_UNSAFE, `保留的归档必须是普通文件：${archive}`)
      }
      // 只交路径：bootstrap 会自行复制并**重算摘要与体量**后才解包。
      return archive
    },

    async extractArchive(archivePath: string, destination: string, options?: { kind?: string }): Promise<void> {
      await mkdir(destination, { recursive: true })
      await extractVerifiedArchive(archivePath, destination, options?.kind)
    },
  }
}

/**
 * 组装 bootstrap 的 `apply(ctx, config)` 配置。
 *
 * `stagingDirectory` **故意不等于**宿主暂存目录：bootstrap 把
 * `<stagingDirectory>/<sha256>/` 当成**它自己的包槽位**（先 `rename` 到 `.backup-*`，成功后再
 * 递归删除），若指向宿主暂存的 `<root>/staging/<sha256>/`，它会**删掉宿主保留的归档与解包树**，
 * 而那两样正是引擎侧复验的依据。所以两者必须分开：宿主暂存 `<root>/staging/<sha256>/`，
 * bootstrap 包槽 `<root>/plugins/linux-runtime/<sha256>/`（位于真实宿主激活根内）。
 *
 * 注意这里**不含**启用决策：本函数只造配置，启用与否仍由用户显式动作决定（默认不启用）。
 */
export function createLinuxBootstrapConfig(options: {
  filesDir: string
  appVersion: string
  bundleDirectory?: string
}): Record<string, unknown> {
  const { filesDir, appVersion } = options
  const bundleDirectory = options.bundleDirectory ?? defaultBundleDirectory()
  const dataDir = linuxEnvironmentRoot(filesDir)
  const assetIO = createHostAssetIO({ filesDir, bundleDirectory })
  let approvedDigest = ''
  const manifestProvider = async () => {
    if (!bundleDirectory) throw new Error('Bundled Linux assets are unavailable without TERMUX__PREFIX')
    const supplied = await readBundledManifest(bundleDirectory)
    approvedDigest = supplied.sha256
    return supplied
  }
  return {
    dataDir,
    manifestProvider,
    verifyManifest: (_manifest: unknown, source: { sourceSha256?: unknown }) =>
      typeof source?.sourceSha256 === 'string' && source.sourceSha256 === approvedDigest,
    linuxAssetIO: assetIO,
    runtimePluginConfig: {
      downloadAsset: async (asset: { sha256?: unknown }, destination: string) => {
        const source = await assetIO.downloadAsset(asset)
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      },
      extractArchive: assetIO.extractArchive,
    },
    appVersionProvider: () => appVersion,
    stagingDirectory: join(dataDir, 'plugins', 'linux-runtime'),
  }
}
