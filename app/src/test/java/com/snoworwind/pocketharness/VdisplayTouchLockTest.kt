package com.snoworwind.pocketharness

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VdisplayTouchLockTest {
  private fun source(): String = listOf(
    File("src/main/java/com/snoworwind/pocketharness/VdisplayController.kt"),
    File("app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt"),
  ).firstOrNull(File::isFile)?.readText() ?: error("VdisplayController.kt source was not found")

  private fun body(source: String, signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) error("method source missing: $signature")
    val next = Regex("(?m)^  (?:private |internal )?fun ").find(source, start + signature.length)?.range?.first
      ?: source.length
    return source.substring(start, next)
  }

  @Test
  fun touchWaitsForTheRecordMonitor() {
    val controllerClass = VdisplayController::class.java
    val lockField = controllerClass.getDeclaredField("lock").apply { isAccessible = true }
    val touch = controllerClass.getDeclaredMethod("touch", String::class.java).apply { isAccessible = true }
    val monitor = lockField.get(VdisplayController) ?: error("controller lock was missing")
    val started = CountDownLatch(1)
    val finished = CountDownLatch(1)
    val worker = Thread {
      started.countDown()
      try {
        touch.invoke(VdisplayController, "missing")
      } catch (_: Throwable) {
        // Android's elapsedRealtime stub is unavailable in a local JVM test.
      } finally {
        finished.countDown()
      }
    }

    synchronized(monitor) {
      worker.start()
      assertTrue("touch worker did not start", started.await(2, TimeUnit.SECONDS))
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (worker.state != Thread.State.BLOCKED && worker.isAlive && System.nanoTime() < deadline) {
        Thread.yield()
      }
      assertEquals("touch must wait on the records monitor", Thread.State.BLOCKED, worker.state)
    }

    assertTrue("touch should continue after the monitor is released", finished.await(2, TimeUnit.SECONDS))
  }

  @Test
  fun activeOperationsRefreshTheIdleTimestamp() {
    val source = source()
    assertTrue(body(source, "private fun touch(").contains("= synchronized(lock)"))
    for (method in listOf("select", "attachViewerSurface", "sendBackProbe", "launchSettingsProbe", "input", "launchApp")) {
      assertTrue("$method must refresh the target display's idle timestamp", body(source, "fun $method(").contains("touch(record.alias)"))
    }
    val create = body(source, "fun create(")
    assertTrue("idempotent create must keep the existing display alive", create.contains("touch(selectedAlias ?: records.keys.firstOrNull())"))
  }
}
