package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Test

/** Issue #322: a pre-exec PRoot loader exit (182) may be retried exactly once. */
class GuestLoaderSpawnTest {
  @Test fun liveEngineIsNeverRetriedOrRefused() {
    assertEquals(GuestSpawnVerdict.RUNNING, guestSpawnVerdict(alive = true, exitCode = null, attempt = 0))
    assertEquals(GuestSpawnVerdict.RUNNING, guestSpawnVerdict(alive = true, exitCode = 0, attempt = 0))
    assertEquals(GuestSpawnVerdict.RUNNING, guestSpawnVerdict(alive = true, exitCode = 182, attempt = 1))
  }

  @Test fun loaderExitIsRetriedOnceThenRefused() {
    assertEquals(GuestSpawnVerdict.RETRY_LOADER,
      guestSpawnVerdict(alive = false, exitCode = EngineManager.GUEST_LOADER_FAILURE_EXIT, attempt = 0))
    assertEquals(GuestSpawnVerdict.LOADER_FAILED,
      guestSpawnVerdict(alive = false, exitCode = EngineManager.GUEST_LOADER_FAILURE_EXIT, attempt = 1))
  }

  @Test fun otherEarlyExitsAreNotRetried() {
    listOf(0, 1, 127, 137, 255, null).forEach { code ->
      assertEquals("exit=$code must not be retried", GuestSpawnVerdict.EXITED,
        guestSpawnVerdict(alive = false, exitCode = code, attempt = 0))
    }
  }

  @Test fun loaderFailureHasItsOwnRefusalCodeAndHint() {
    assertEquals("linux-guest-loader-failed", EngineManager.REFUSAL_GUEST_LOADER_FAILED)
    assertEquals(182, EngineManager.GUEST_LOADER_FAILURE_EXIT)
    assertEquals(R.string.ds_start_runtime_unavailable,
      startupFailureHintResource(EngineManager.REFUSAL_GUEST_LOADER_FAILED))
  }
}
