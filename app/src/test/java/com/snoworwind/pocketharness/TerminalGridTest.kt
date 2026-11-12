package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 原生终端网格推导：PTY 尺寸必须由视图真实像素决定，而不是沿用引擎
 * 默认的 80×24。这里的判据直接锁住「长输入尾部飞出屏幕」缺陷的根因。
 */
class TerminalGridTest {

  @Test
  fun derivesColumnsAndRowsFromViewPixels() {
    val grid = requireNotNull(terminalGridFor(widthPx = 1320, heightPx = 2400, cellWidth = 33f, cellHeight = 55f))
    assertEquals(40, grid.cols)
    assertEquals(43, grid.rows)
  }

  @Test
  fun fallsBackWhenViewIsNotLaidOut() {
    assertNull(terminalGridFor(widthPx = 0, heightPx = 2400, cellWidth = 33f, cellHeight = 55f))
    assertNull(terminalGridFor(widthPx = 1320, heightPx = 0, cellWidth = 33f, cellHeight = 55f))
    assertNull(terminalGridFor(widthPx = -1, heightPx = -1, cellWidth = 33f, cellHeight = 55f))
  }

  @Test
  fun rejectsInvalidCellMetrics() {
    assertNull(terminalGridFor(1320, 2400, Float.NaN, 55f))
    assertNull(terminalGridFor(1320, 2400, 33f, Float.POSITIVE_INFINITY))
    assertNull(terminalGridFor(1320, 2400, 0f, 55f))
    assertNull(terminalGridFor(1320, 2400, 33f, -1f))
  }

  @Test
  fun tooSmallToFitMinimumGridIsNotLaidOutYet() {
    // 初始布局是 1×1：不能推导成 2×1 再把 PTY 缩成两列。
    assertNull(terminalGridFor(widthPx = 1, heightPx = 1, cellWidth = 10f, cellHeight = 10f))
    assertNull(terminalGridFor(widthPx = 3, heightPx = 2, cellWidth = 10f, cellHeight = 10f))
  }

  @Test
  fun clampsToMinimumGridAtTheBoundary() {
    val grid = requireNotNull(terminalGridFor(widthPx = 20, heightPx = 10, cellWidth = 10f, cellHeight = 10f))
    assertEquals(MIN_TERMINAL_COLS, grid.cols)
    assertEquals(MIN_TERMINAL_ROWS, grid.rows)
  }

  @Test
  fun floorsPartialCells() {
    // 只放得下 2.9 列时按 2 列算：多报一列会让右边缘的字符被裁掉。
    val grid = requireNotNull(terminalGridFor(widthPx = 29, heightPx = 29, cellWidth = 10f, cellHeight = 10f))
    assertEquals(2, grid.cols)
    assertEquals(2, grid.rows)
  }
}
