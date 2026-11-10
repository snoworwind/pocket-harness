package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Test

/** 原生终端视口纯函数：回看行 + 当前屏的顶部行号。 */
class TerminalViewportTest {
  @Test
  fun topAtBottomIsScrollback() {
    assertEquals(120, terminalViewportTop(120, 0))
    assertEquals(0, terminalViewportTop(0, 0))
  }

  @Test
  fun topClampsOffsetToScrollback() {
    assertEquals(0, terminalViewportTop(120, 999))
    assertEquals(120, terminalViewportTop(120, -5))
    assertEquals(70, terminalViewportTop(120, 50))
  }

  @Test
  fun negativeScrollbackIsTreatedAsZero() {
    assertEquals(0, terminalViewportTop(-1, 0))
    assertEquals(0, terminalViewportTop(-1, 5))
  }
}
