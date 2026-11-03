package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MotionGateContractTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/snoworwind/pocketharness", name),
    File("app/src/main/java/com/snoworwind/pocketharness", name),
  ).first { it.isFile }.readText()

  private fun codeOnly(text: String): String = text.lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  @Test fun enabledWhenAllScalesAndPlatformAnimatorsAreActive() {
    assertTrue(DsUi.animationsEnabledFrom(1f, 1f, 1f, animatorsRunning = true))
  }

  @Test fun anyDisabledScaleDisablesMotion() {
    assertFalse(DsUi.animationsEnabledFrom(0f, 1f, 1f, true))
    assertFalse(DsUi.animationsEnabledFrom(1f, 0f, 1f, true))
    assertFalse(DsUi.animationsEnabledFrom(1f, 1f, 0f, true))
  }

  @Test fun inactivePlatformAnimatorsDisableMotion() {
    assertFalse(DsUi.animationsEnabledFrom(1f, 1f, 1f, animatorsRunning = false))
  }

  @Test fun listenerNotificationAndUnsubscribeAreIdempotent() {
    DsUi.resetMotionListenersForTest()
    var calls = 0
    val unsubscribe = DsUi.registerMotionListenerForTest { calls++ }
    assertEquals(1, DsUi.motionListenerCountForTest())
    DsUi.notifyMotionChanged()
    assertEquals(1, calls)
    unsubscribe()
    unsubscribe()
    assertEquals(0, DsUi.motionListenerCountForTest())
    DsUi.notifyMotionChanged()
    assertEquals(1, calls)
  }

  @Test fun infiniteMotionSurfacesSubscribeAndReleaseWithTheirOwners() {
    val guide = codeOnly(source("GuidePageRenderer.kt"))
    val halo = codeOnly(source("OverlayHalo.kt"))
    val panel = codeOnly(source("OverlayPanel.kt"))
    val shimmer = codeOnly(source("ShimmerTextView.kt"))
    val service = codeOnly(source("OverlayService.kt"))
    assertTrue(guide.contains("DsUi.animationsEnabled(activity)"))
    assertTrue(guide.contains("fun startMotionWatch()"))
    assertTrue(guide.substringAfter("fun cancelPulse()").contains("stopMotionWatch()"))
    assertTrue(halo.contains("DsUi.registerMotionListener(svc)"))
    assertTrue(halo.contains("fun stopMotionWatch()"))
    assertTrue(panel.contains("DsUi.registerMotionListener(svc)"))
    assertTrue(panel.contains("fun stopMotionWatch()"))
    assertTrue(shimmer.contains("DsUi.registerMotionListener(context)"))
    assertTrue(shimmer.substringAfter("override fun onDetachedFromWindow()").contains("motionUnsubscribe = null"))
    assertTrue(service.contains("halo.startMotionWatch()"))
    assertTrue(service.contains("panel.startMotionWatch()"))
    assertTrue(service.contains("halo.stopMotionWatch()"))
    assertTrue(service.contains("panel.stopMotionWatch()"))
  }
}
