package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalColorsTest {
  @Test
  fun rgbBecomesOpaqueArgb() {
    assertEquals(0xFFFF8800.toInt(), terminalArgb(0x00FF8800))
    assertEquals(0xFF000000.toInt(), terminalArgb(0x00000000))
    assertEquals(0xFFFFFFFF.toInt(), terminalArgb(0x00FFFFFF))
  }

  @Test
  fun defaultStaysSentinel() {
    assertEquals(TERMINAL_DEFAULT_COLOR, terminalArgb(TERMINAL_DEFAULT_COLOR))
  }
}
