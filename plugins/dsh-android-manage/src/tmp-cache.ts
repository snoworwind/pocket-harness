import { basename, join } from 'node:path'

export interface TmpCacheOps {
  listFiles(dir: string): string[] | null | undefined
  mtimeMs(filePath: string): number
  remove(filePath: string): void
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Enforce the published-file cache bound, removing the new capture if the bound cannot be proven. */
export function prunePublishedTmpFiles(
  dir: string,
  prefix: string,
  keep: number,
  publishedPath: string,
  ops: TmpCacheOps,
): void {
  const failClosed = (reason: unknown): never => {
    try {
      ops.remove(publishedPath)
    } catch (cleanupError) {
      throw new Error(`无法确认临时缓存上限（${errorText(reason)}），且本次产物清理失败（${errorText(cleanupError)}）`)
    }
    throw new Error(`无法确认临时缓存上限（${errorText(reason)}）；本次产物已删除`)
  }

  if (!Number.isSafeInteger(keep) || keep < 1) return failClosed('保留数量无效')

  try {
    const names = ops.listFiles(dir)
    if (!Array.isArray(names)) throw new Error('目录枚举未返回文件清单')
    const matching = names.filter((name) => name.startsWith(prefix)).map((name) => {
      const filePath = join(dir, name)
      const mtimeMs = ops.mtimeMs(filePath)
      if (!Number.isFinite(mtimeMs)) throw new Error(`文件时间无效：${name}`)
      return { name, filePath, mtimeMs }
    })
    const publishedName = basename(publishedPath)
    if (!matching.some((entry) => entry.name === publishedName)) {
      throw new Error('目录清单中缺少本次产物')
    }
    matching.sort((a, b) => {
      if (a.filePath === publishedPath) return -1
      if (b.filePath === publishedPath) return 1
      return b.mtimeMs - a.mtimeMs
    })
    for (const entry of matching.slice(keep)) ops.remove(entry.filePath)
  } catch (error) {
    return failClosed(error)
  }
}
