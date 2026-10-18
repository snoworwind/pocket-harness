/**
 * Host archive adapter. Downloading remains a shell responsibility. Bootstrap copies and
 * hashes the retained archive; this adapter independently decodes that copy in process.
 * Mutable host unpacked trees and cache markers are never used as executable payload.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import xz from 'xz-decompress'
import tar from 'tar-stream'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { LINUX_MANIFEST_PINS } from './linux-release-pins.js'

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

/** 宿主侧资产 IO 的失败都要带稳定码：界面与日志按码判读，不靠文本匹配。 */
export class LinuxHostAssetError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LinuxHostAssetError'
    this.code = code
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
async function extractVerifiedArchive(archivePath: string, destination: string): Promise<void> {
  const root = resolve(destination)
  const seen = new Set<string>()
  let entries = 0, declared = 0, decoded = 0
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (++entries > 20_000 || !Number.isSafeInteger(header.size) || (header.size ?? 0) < 0) throw new Error('Archive entry limit exceeded')
      if (header.type !== 'file' && header.type !== 'directory') throw new Error('Archive links and special entries are forbidden')
      const name = header.name.replace(/^\.\//, '').replace(/\/$/, '')
      const target = resolveInside(root, name)
      if (target === null || target === root || seen.has(target)) throw new Error('Unsafe or duplicate archive path')
      seen.add(target)
      const size = header.size ?? 0
      declared += size
      if (size > 128 * 1024 * 1024 || declared > 512 * 1024 * 1024) throw new Error('Archive payload limit exceeded')
      // Destination is a new bootstrap staging directory; no caller-owned tree is merged.
      if (header.type === 'directory') {
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
}

/** Bootstrap 的两个 IO 适配器：宿主归档读取与独立解码。 */
export interface HostAssetIO {
  /** 交回宿主已暂存的归档路径；宿主没准备好就抛错（**不下载**）。 */
  downloadAsset(asset: { sha256?: unknown }, options?: { destination?: string }): Promise<string>
  /** 从 bootstrap 已验证的归档副本解码到新 staging；不使用宿主解包树。 */
  extractArchive(archivePath: string, destination: string): Promise<void>
}

/**
 * 造出 bootstrap 的 `linuxAssetIO`。
 *
 * @param filesDir 壳侧 `DSH_FILES_DIR`；暂存根 = `<filesDir>/linux-environment`。
 */
export function createHostAssetIO(options: { filesDir: string }): HostAssetIO {
  const { filesDir } = options
  if (typeof filesDir !== 'string' || filesDir === '') throw new TypeError('filesDir is required')

  return {
    async downloadAsset(asset: { sha256?: unknown }): Promise<string> {
      const archive = retainedArchiveFor(filesDir, asset?.sha256)
      if (archive === null) {
        throw new LinuxHostAssetError(CODE_ASSET_SPEC_INVALID, `清单摘要不合规，拒绝推导落点：${String(asset?.sha256)}`)
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

    async extractArchive(archivePath: string, destination: string): Promise<void> {
      await mkdir(destination, { recursive: true })
      await extractVerifiedArchive(archivePath, destination)
    },
  }
}

/** 用户的 Release 发现入口（本仓插件系统的版本独立于 App 版本）。 */
export const LINUX_RELEASE_URL = 'https://github.com/kelai141/dsh-bionilux/releases/latest'

/**
 * 组装 bootstrap 的 `apply(ctx, config)` 配置。
 *
 * `stagingDirectory` **故意不等于**宿主暂存目录：bootstrap 把
 * `<stagingDirectory>/<sha256>/` 当成**它自己的包槽位**（先 `rename` 到 `.backup-*`，成功后再
 * 递归删除），若指向宿主暂存的 `<root>/staging/<sha256>/`，它会**删掉宿主保留的归档与解包树**，
 * 而那两样正是引擎侧复验的依据。所以两者必须分开：宿主暂存 `<root>/staging/<sha256>/`，
 * bootstrap 包槽 `<root>/staging/runtime-plugin/<sha256>/`。
 *
 * 注意这里**不含**启用决策：本函数只造配置，启用与否仍由用户显式动作决定（默认不启用）。
 */
export function createLinuxBootstrapConfig(options: {
  filesDir: string
  appVersion: string
  releaseUrl?: string
}): Record<string, unknown> {
  const { filesDir, appVersion, releaseUrl = LINUX_RELEASE_URL } = options
  const dataDir = linuxEnvironmentRoot(filesDir)
  return {
    dataDir,
    releaseUrl,
    verifyManifest: (manifest: unknown) => LINUX_MANIFEST_PINS.includes(
      createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    ),
    linuxAssetIO: createHostAssetIO({ filesDir }),
    appVersionProvider: () => appVersion,
    stagingDirectory: join(dataDir, STAGING_DIR, 'runtime-plugin'),
  }
}
