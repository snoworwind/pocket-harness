package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BootPhaseTraceTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/snoworwind/pocketharness", name),
    File("app/src/main/java/com/snoworwind/pocketharness", name),
  ).first { it.isFile }.readText()

  private fun codeOnly(text: String): String = text.lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  @Test fun parsesMeasuredLoaderSettlePhase() {
    assertEquals(1532L, LogCollector.loaderSettleMs("[perf] phase name=loader-settle ms=1532\n"))
  }

  @Test fun missingProbeRemainsUnknown() {
    assertNull(LogCollector.loaderSettleMs(""))
    assertNull(LogCollector.loaderSettleMs("starting engine\nlistening on 127.0.0.1\n"))
  }

  @Test fun malformedOrNegativeMeasurementRemainsUnknown() {
    assertNull(LogCollector.loaderSettleMs("[perf] phase name=loader-settle ms=-1"))
    assertNull(LogCollector.loaderSettleMs("[perf] phase name=loader-settle ms=unknown"))
  }

  @Test fun lastMeasurementWins() {
    val text = "[perf] phase name=loader-settle ms=1000\n[perf] phase name=loader-settle ms=2400\n"
    assertEquals(2400L, LogCollector.loaderSettleMs(text))
  }

  @Test fun acceptsHistoricalProbeSpellings() {
    assertEquals(777L, LogCollector.loaderSettleMs("[perf] phase name=loader-settle-ms ms=777"))
    assertEquals(888L, LogCollector.loaderSettleMs("loader settleMs=888"))
  }

  @Test fun ignoresOtherPhases() {
    assertNull(LogCollector.loaderSettleMs("[perf] phase name=compose ms=1900\n[perf] phase name=listen ms=800\n"))
  }

  @Test fun phaseNamesAndLineShapeAreStable() {
    val names = listOf(
      BootPhaseTrace.ON_CREATE,
      BootPhaseTrace.WEBVIEW_CONSTRUCT,
      BootPhaseTrace.LINUX_PREPARE,
      BootPhaseTrace.LOADER_SETTLE,
    )
    assertEquals(names.size, names.toSet().size)
    assertTrue(names.all(String::isNotBlank))
    assertEquals("dsh-boot-phase phase=onCreate at=42ms ms=7", "dsh-boot-phase phase=${names[0]} at=42ms ms=7")
  }

  @Test fun timingsAreGatedAndRecordedAtTheOwningPhases() {
    val trace = codeOnly(source("BootPhaseTrace.kt"))
    val activity = codeOnly(source("MainActivity.kt"))
    val engine = codeOnly(source("EngineManager.kt"))
    val collector = codeOnly(source("LogCollector.kt"))
    assertTrue(trace.contains("MainActivity.DevLogPrefs.isEnabled(context)"))
    assertTrue(activity.contains("BootPhaseTrace.markBootBase(this)"))
    assertTrue(activity.contains("BootPhaseTrace.WEBVIEW_CONSTRUCT"))
    assertTrue(activity.contains("BootPhaseTrace.ON_CREATE"))
    assertTrue(engine.contains("BootPhaseTrace.LINUX_PREPARE"))
    assertTrue(collector.contains("BootPhaseTrace.LOADER_SETTLE"))
    assertTrue(collector.contains("seen.length + text.length - MAX_ENGINE_CHUNK"))
  }
}
