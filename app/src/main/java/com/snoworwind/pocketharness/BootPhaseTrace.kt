package com.snoworwind.pocketharness

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** Optional cold-start phase timings. Disabled by default with the developer log preference. */
internal object BootPhaseTrace {
  private const val TAG = "dsh-boot-phase"
  private const val FILE_NAME = "boot-phase-trace.log"
  private const val MAX_BYTES = 64L * 1024
  private const val MAX_LINES_PER_BOOT = 4

  const val ON_CREATE = "onCreate"
  const val WEBVIEW_CONSTRUCT = "webviewConstruct"
  const val SNAPSHOT_EXTRACT = "snapshotExtract"
  const val LOADER_SETTLE = "loaderSettle"

  @Volatile private var baseMs = 0L
  @Volatile private var enabledCache: Boolean? = null
  private val emitted = ConcurrentHashMap<String, Long>()
  private val fileLock = Any()

  internal fun enabled(context: Context): Boolean {
    enabledCache?.let { return it }
    val enabled = runCatching { MainActivity.DevLogPrefs.isEnabled(context) }.getOrDefault(false)
    enabledCache = enabled
    return enabled
  }

  fun markBootBase(context: Context) {
    if (baseMs != 0L || !enabled(context)) return
    baseMs = SystemClockElapsed.elapsedRealtime()
  }

  fun mark(context: Context, name: String, note: String? = null) {
    if (!enabled(context)) return
    if (baseMs == 0L) baseMs = SystemClockElapsed.elapsedRealtime()
    val atMs = SystemClockElapsed.elapsedRealtime() - baseMs
    if (emitted.putIfAbsent(name, atMs) != null || emitted.size > MAX_LINES_PER_BOOT) return
    append(context, name, atMs, note)
  }

  internal fun emittedCount(): Int = emitted.size

  private fun append(context: Context, name: String, atMs: Long, note: String?) {
    val safeNote = note?.replace('\n', ' ')?.replace('\r', ' ')
    val bytes = ("dsh-boot-phase phase=$name at=${atMs}ms" + (safeNote?.let { " $it" } ?: "") + "\n")
      .toByteArray(Charsets.UTF_8)
    try {
      synchronized(fileLock) {
        val file = File(context.filesDir, FILE_NAME)
        if (file.exists() && file.length() + bytes.size > MAX_BYTES) {
          val previous = File(context.filesDir, "$FILE_NAME.1")
          if (previous.exists() && !previous.delete()) error("cannot remove previous trace generation")
          if (!file.renameTo(previous)) error("cannot rotate trace file")
        }
        file.appendBytes(bytes)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "boot phase trace write failed: ${t.message ?: t.javaClass.simpleName}")
    }
  }

  internal fun resetForTest() {
    enabledCache = null
    baseMs = 0L
    emitted.clear()
  }
}

/** Injectable monotonic clock so pure JVM tests do not need an Android runtime. */
internal object SystemClockElapsed {
  @Volatile private var fixed: Long? = null
  fun elapsedRealtime(): Long = fixed ?: android.os.SystemClock.elapsedRealtime()
  internal fun setForTest(value: Long?) { fixed = value }
}
