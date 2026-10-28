package com.snoworwind.pocketharness

import java.io.File

/** Owns retention for browser screenshots stored in the engine-readable private temp directory. */
internal object ShotCachePolicy {
  const val PREFIX = "browser-shot-"
  const val SUFFIX = ".png"
  const val DEFAULT_TTL_MS = 60L * 60L * 1000L
  const val DEFAULT_MAX_FILES = 32
  const val DEFAULT_MAX_BYTES = 128L * 1024L * 1024L

  /** Best-effort cleanup of expired and oldest managed screenshots. Other files are untouched. */
  fun prune(
    dir: File,
    nowMs: Long = System.currentTimeMillis(),
    ttlMs: Long = DEFAULT_TTL_MS,
    maxFiles: Int = DEFAULT_MAX_FILES,
    maxBytes: Long = DEFAULT_MAX_BYTES,
  ): Int = prune(dir, nowMs, ttlMs, maxFiles, maxBytes, preserve = null)

  /**
   * Enforce limits after a new capture is written, while preserving that file for its response.
   * Returns false if the capture is invalid, cannot be retained, or the directory still exceeds limits.
   */
  fun prunePublished(
    dir: File,
    capture: File,
    nowMs: Long = System.currentTimeMillis(),
    ttlMs: Long = DEFAULT_TTL_MS,
    maxFiles: Int = DEFAULT_MAX_FILES,
    maxBytes: Long = DEFAULT_MAX_BYTES,
  ): Boolean {
    if (!isManagedShot(capture) || capture.parentFile?.absoluteFile != dir.absoluteFile || !capture.isFile) return false
    if (maxFiles <= 0 || maxBytes < 0 || sizeOf(capture) > maxBytes) {
      delete(capture)
      prune(dir, nowMs, ttlMs, maxFiles, maxBytes)
      return false
    }
    prune(dir, nowMs, ttlMs, maxFiles, maxBytes, preserve = capture)
    val remaining = listShots(dir) ?: run {
      delete(capture)
      return false
    }
    val totalBytes = remaining.sumOf(::sizeOf)
    val withinLimits = remaining.size <= maxFiles && totalBytes <= maxBytes
    if (!withinLimits) delete(capture)
    return withinLimits && capture.isFile
  }

  private fun prune(
    dir: File,
    nowMs: Long,
    ttlMs: Long,
    maxFiles: Int,
    maxBytes: Long,
    preserve: File?,
  ): Int {
    val shots = listShots(dir) ?: return 0
    val expiredBefore = nowMs - ttlMs
    val remaining = ArrayList<File>(shots.size)
    var removed = 0
    for (file in shots) {
      if (!sameFile(file, preserve) && file.lastModified() < expiredBefore) {
        if (delete(file)) removed++ else remaining.add(file)
      } else {
        remaining.add(file)
      }
    }
    remaining.sortBy { it.lastModified() }
    var totalBytes = remaining.sumOf(::sizeOf)
    var remainingCount = remaining.size
    for (file in remaining) {
      if (remainingCount <= maxFiles && totalBytes <= maxBytes) break
      if (sameFile(file, preserve)) continue
      val bytes = sizeOf(file)
      if (delete(file)) {
        remainingCount--
        totalBytes -= bytes
        removed++
      }
    }
    return removed
  }

  private fun listShots(dir: File): List<File>? = try {
    dir.listFiles()?.filter { it.isFile && isManagedShot(it) }
  } catch (_: Exception) {
    null
  }

  private fun isManagedShot(file: File): Boolean =
    file.name.startsWith(PREFIX) && file.name.endsWith(SUFFIX)

  private fun sameFile(file: File, other: File?): Boolean =
    other != null && file.absoluteFile == other.absoluteFile

  private fun sizeOf(file: File): Long = try {
    file.length()
  } catch (_: Exception) {
    0L
  }

  private fun delete(file: File): Boolean = try {
    file.delete()
  } catch (_: Exception) {
    false
  }
}
