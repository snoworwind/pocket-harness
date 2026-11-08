/**
 * Termux Packages index parsing for the snapshot builder.
 *
 * The signed Termux repository is rolling and may keep several stanzas for one
 * package name while a version is retired (measured 2026-11-09: 3122 stanzas for
 * 3026 names, `libicu` published as 79.1 then 78.3). The signed-repo preparation
 * (prepare-termux-signed-repo.py::select_package_records) downloads only the
 * newest record, so a last-stanza-wins parse here asked the offline mirror for a
 * file it never had and failed with `libicu: 全部镜像失败: HTTP 404`.
 */
import { compareDebVersion } from './deb-version.mjs'

/**
 * Parse a `Packages` index into the record map the builder consumes.
 * Duplicate names keep the newest Debian version, matching the Python selection.
 */
export function parseTermuxIndex(indexText) {
  /** @type {Map<string, object>} */
  const pkgs = new Map()
  // 包名 → 索引里的**原始块**（逐字保留，供 dpkg/available 使用）；与 pkgs 同步只留最新。
  const rawBlocks = new Map()
  for (const block of indexText.split('\n\n')) {
    const name = block.match(/^Package: (.+)$/m)?.[1]
    if (!name) continue
    const get = (key) => block.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1]?.trim() ?? ''
    const candidate = {
      version: get('Version'),
      depends: get('Depends').split(',').map((s) => s.trim().split(' ')[0]).filter((s) => s && !s.includes('|')),
      filename: get('Filename'),
      sha256: get('SHA256').toLowerCase(),
      size: Number(get('Size') || 0),
      arch: get('Architecture'),
      maintainer: get('Maintainer'),
      description: get('Description'),
    }
    const previous = pkgs.get(name)
    if (previous !== undefined && compareDebVersion(candidate.version, previous.version) <= 0) continue
    rawBlocks.set(name, block)
    pkgs.set(name, candidate)
  }
  return { pkgs, rawBlocks }
}
