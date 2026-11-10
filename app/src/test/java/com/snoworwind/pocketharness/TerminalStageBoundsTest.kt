package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生终端 overlay 的几何解析：页面只能给矩形，壳侧必须拒绝 0/负/非法值，
 * 否则原生视图会被压成不可见却仍占据焦点。
 */
class TerminalStageBoundsTest {

  @Test
  fun parsesAValidRectangle() {
    val bounds = requireNotNull(
      TerminalStageBounds.parse("""{"left":12,"top":34.5,"width":300,"height":480,"visible":true}"""),
    )
    assertEquals(12f, bounds.left, 0.001f)
    assertEquals(34.5f, bounds.top, 0.001f)
    assertEquals(300f, bounds.width, 0.001f)
    assertEquals(480f, bounds.height, 0.001f)
    assertTrue(bounds.visible)
  }

  @Test
  fun visibleDefaultsToTrueWhenOmitted() {
    val bounds = requireNotNull(TerminalStageBounds.parse("""{"width":100,"height":200}"""))
    assertTrue(bounds.visible)
  }

  @Test
  fun rejectsMissingOrNonPositiveSize() {
    assertNull(TerminalStageBounds.parse("""{"left":0,"top":0}"""))
    assertNull(TerminalStageBounds.parse("""{"width":0,"height":200}"""))
    assertNull(TerminalStageBounds.parse("""{"width":-1,"height":200}"""))
    assertNull(TerminalStageBounds.parse("""{"width":100,"height":0}"""))
  }

  @Test
  fun rejectsMalformedJson() {
    assertNull(TerminalStageBounds.parse("not-json"))
    assertNull(TerminalStageBounds.parse("""{"width":"wide","height":200}"""))
  }

  @Test
  fun explicitInvisibleIsPreserved() {
    val bounds = requireNotNull(TerminalStageBounds.parse("""{"width":100,"height":200,"visible":false}"""))
    assertFalse(bounds.visible)
  }
}
