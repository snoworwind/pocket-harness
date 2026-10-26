package com.snoworwind.pocketharness

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Coalesces console output by UTF-8 size or an independent idle deadline. */
internal class ConsoleOutputBatcher(
  private val maxBytes: Int = DEFAULT_MAX_BYTES,
  private val flushIntervalMs: Long = DEFAULT_FLUSH_INTERVAL_MS,
  private val onBatch: (String) -> Unit,
) : AutoCloseable {

  private val lock = Any()
  private val pending = StringBuilder()
  private var pendingBytes = 0
  private var closed = false
  private var timerGeneration = 0
  private var timer: ScheduledFuture<*>? = null
  private val scheduler = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "dsh-console-flush").apply { isDaemon = true }
  }

  init {
    require(maxBytes > 0) { "maxBytes must be positive" }
    require(flushIntervalMs > 0) { "flushIntervalMs must be positive" }
  }

  fun append(text: String) {
    if (text.isEmpty()) return
    synchronized(lock) {
      if (closed) return
      var index = 0
      while (index < text.length) {
        val codePoint = Character.codePointAt(text, index)
        val end = index + Character.charCount(codePoint)
        val piece = text.substring(index, end)
        val bytes = piece.toByteArray(Charsets.UTF_8).size
        if (pendingBytes > 0 && pendingBytes + bytes > maxBytes) {
          cancelTimerLocked()
          emitPendingLocked()
        }
        pending.append(piece)
        pendingBytes += bytes
        index = end
        if (pendingBytes >= maxBytes) {
          cancelTimerLocked()
          emitPendingLocked()
        }
      }
      if (pending.isNotEmpty() && timer == null) scheduleFlushLocked()
    }
  }

  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
      cancelTimerLocked()
      emitPendingLocked()
    }
    scheduler.shutdownNow()
  }

  private fun scheduleFlushLocked() {
    val expectedGeneration = ++timerGeneration
    timer = scheduler.schedule({
      synchronized(lock) {
        if (!closed && timerGeneration == expectedGeneration) {
          timer = null
          emitPendingLocked()
        }
      }
    }, flushIntervalMs, TimeUnit.MILLISECONDS)
  }

  private fun cancelTimerLocked() {
    timerGeneration += 1
    timer?.cancel(false)
    timer = null
  }

  /** Callback execution stays serialized with close/append so output cannot follow onExit. */
  private fun emitPendingLocked() {
    if (pending.isEmpty()) return
    val text = pending.toString()
    pending.setLength(0)
    pendingBytes = 0
    onBatch(text)
  }

  companion object {
    const val DEFAULT_MAX_BYTES = 16 * 1024
    const val DEFAULT_FLUSH_INTERVAL_MS = 50L
  }
}
