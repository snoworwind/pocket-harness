package com.snoworwind.pocketharness

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max

/**
 * 原生终端视图（libvterm 屏幕 + Canvas 渲染 + Android IME）。
 *
 * 这一层的职责只有「渲染 + 输入」：会话/PTY 在引擎侧，字节由 [output] 进来、按键经 [onInput] 出去。
 * 触摸滚动/选区/缩放是后续里程碑；当前先保证 IME、光标、基础 SGR 与 resize 正确。
 */
/** JNI 的 `0x00RRGGBB` 与 Android `Paint` 的 `0xAARRGGBB` 之间的边界；DEFAULT 保持哨兵值。 */
internal const val TERMINAL_DEFAULT_COLOR = 0xFFFFFFFF.toInt()

internal fun terminalArgb(rgb: Int): Int =
  if (rgb == TERMINAL_DEFAULT_COLOR) rgb else rgb or 0xFF000000.toInt()

/** 终端网格（列 × 行）。 */
internal data class TerminalGrid(val cols: Int, val rows: Int)

internal const val MIN_TERMINAL_COLS = 2
internal const val MIN_TERMINAL_ROWS = 1

/**
 * 由视图像素尺寸与单元格尺寸推导终端网格。
 *
 * 这是「PTY 尺寸以视图为准」的唯一判据：只要视图已经完成布局，页面传来的
 * cols/rows 就不可信——那是 PTY 自己的旧值，常见是引擎默认的 80×24。
 * 之前 open() 直接用这个旧值建网格，随后 onSizeChanged 又只在「尺寸相对上一次
 * 发生变化」时才回报，于是 PTY 永远停在 80×24，而屏幕上只显示得下约 40 列：
 * zle 按 80 列算光标，长输入尾部写到屏幕外、退格把提示符擦掉。
 *
 * 尺寸尚未布局（宽或高为 0）、连最小网格都放不下（初始 1×1 布局）或单元格
 * 尺寸非法时返回 null，调用方回退到传入值。
 */
internal fun terminalGridFor(
  widthPx: Int,
  heightPx: Int,
  cellWidth: Float,
  cellHeight: Float,
): TerminalGrid? {
  if (widthPx <= 0 || heightPx <= 0) return null
  if (!cellWidth.isFinite() || !cellHeight.isFinite()) return null
  if (cellWidth <= 0f || cellHeight <= 0f) return null
  val cols = (widthPx / cellWidth).toInt()
  val rows = (heightPx / cellHeight).toInt()
  if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return null
  return TerminalGrid(cols = cols, rows = rows)
}

internal class TerminalView(context: Context) : View(context) {

  /** 用户输入（已编码为终端字节）。 */
  var onInput: ((ByteArray) -> Unit)? = null
  /** 网格尺寸变化（列/行），调用方负责同步 PTY。 */
  var onResized: ((cols: Int, rows: Int) -> Unit)? = null

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
    typeface = Typeface.MONOSPACE
    textSize = 13f * resources.displayMetrics.scaledDensity
  }
  private val backgroundPaint = Paint()
  private val cursorPaint = Paint()

  private var handle = 0L
  private var cells: ByteBuffer? = null
  private var rows = 24
  private var cols = 80
  private var cellWidth = 0f
  private var cellHeight = 0f
  private var defaultFg = 0xFFE8E8E8.toInt()
  private var defaultBg = 0xFF101014.toInt()
  /** 回看偏移（行，0 = 贴底）；触摸拖动更新，输入时归零。 */
  private var scrollOffset = 0
  private var scrollLine: ByteBuffer? = null
  private var touchStartY = 0f
  private var touchStartOffset = 0
  private var touchDragging = false
  private val flingScroller = android.widget.OverScroller(context)
  private var velocityTracker: android.view.VelocityTracker? = null
  private val flingStep = object : Runnable {
    override fun run() {
      if (!flingScroller.computeScrollOffset()) return
      val available = if (handle == 0L) 0 else TerminalNative.nativeScrollbackCount(handle)
      scrollOffset = (flingScroller.currY / cellHeight).toInt().coerceIn(0, available)
      invalidate()
      postOnAnimation(this)
    }
  }

  /** xterm 16 色基础调色板；与主题的后续映射在里程碑 M2 接。 */
  private val palette = intArrayOf(
    0xFF1E1E1E.toInt(), 0xFFCD3131.toInt(), 0xFF0DBC79.toInt(), 0xFFE5E510.toInt(),
    0xFF2472C8.toInt(), 0xFFBC3FBC.toInt(), 0xFF11A8CD.toInt(), 0xFFE5E5E5.toInt(),
    0xFF666666.toInt(), 0xFFF14C4C.toInt(), 0xFF23D18B.toInt(), 0xFFF5F543.toInt(),
    0xFF3B8EEA.toInt(), 0xFFD670D6.toInt(), 0xFF29B8DB.toInt(), 0xFFFFFFFF.toInt(),
  )

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    setBackgroundColor(defaultBg)
    measureCell()
  }

  private fun measureCell() {
    cellWidth = max(1f, paint.measureText("M"))
    cellHeight = max(1f, paint.fontSpacing)
  }

  fun open(initialCols: Int, initialRows: Int, fg: Int?, bg: Int?) {
    if (!TerminalNative.available) return
    if (fg != null) defaultFg = fg
    if (bg != null) defaultBg = bg
    setBackgroundColor(defaultBg)
    measureCell()
    // 视图若已有真实布局尺寸，就以视图为准；页面传来的 cols/rows 只是
    // 「还没布局」时的兜底（它们是 PTY 的旧值，可能是 80×24）。
    val measured = terminalGridFor(width, height, cellWidth, cellHeight)
    cols = measured?.cols ?: max(MIN_TERMINAL_COLS, initialCols)
    rows = measured?.rows ?: max(MIN_TERMINAL_ROWS, initialRows)
    handle = TerminalNative.nativeCreate(cols, rows)
    cells = null
    scrollLine = null
    scrollOffset = 0
    // 打开后无条件回报一次：重挂/复用时视图可能早已布局完毕，
    // 没有后续 onSizeChanged，只靠它会让 PTY 永远收不到真实尺寸。
    onResized?.invoke(cols, rows)
    invalidate()
  }

  /**
   * 以当前布局尺寸重算网格并同步 PTY。
   * @param force 即使网格没变也回报一次（重挂、页面刚连上、可见性恢复时补推）。
   */
  fun syncGrid(force: Boolean) {
    if (handle == 0L) return
    measureCell()
    val measured = terminalGridFor(width, height, cellWidth, cellHeight) ?: return
    if (!force && measured.cols == cols && measured.rows == rows) return
    cols = measured.cols
    rows = measured.rows
    cells = null
    TerminalNative.nativeResize(handle, cols, rows)
    onResized?.invoke(cols, rows)
    invalidate()
  }

  /** PTY 输出字节。 */
  fun output(bytes: ByteArray) {
    if (handle == 0L || bytes.isEmpty()) return
    TerminalNative.nativeInput(handle, bytes, bytes.size)
    invalidate()
  }

  fun close() {
    if (handle != 0L) {
      TerminalNative.nativeDestroy(handle)
      handle = 0L
    }
    cells = null
    scrollLine = null
    scrollOffset = 0
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0) return
    measureCell()
    val measured = terminalGridFor(w, h, cellWidth, cellHeight) ?: return
    if (measured.cols == cols && measured.rows == rows) return
    cols = measured.cols
    rows = measured.rows
    cells = null
    if (handle != 0L) {
      TerminalNative.nativeResize(handle, cols, rows)
      onResized?.invoke(cols, rows)
    }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(defaultBg)
    if (handle == 0L || !TerminalNative.available) {
      paint.color = defaultFg
      canvas.drawText("native terminal unavailable", 8f, 8f - paint.ascent(), paint)
      return
    }
    val live = ensureCells()
    val count = TerminalNative.nativeCopyScreen(handle, live)
    if (count <= 0) return
    live.order(ByteOrder.LITTLE_ENDIAN)

    // 视口 = 回看行 + 当前屏；scrollOffset 为距底部的行数（0 = 贴底）。
    val scrollback = TerminalNative.nativeScrollbackCount(handle)
    scrollOffset = scrollOffset.coerceIn(0, scrollback)
    val top = terminalViewportTop(scrollback, scrollOffset)
    val cursor = TerminalNative.nativeCursor(handle)
    val cursorVisible = scrollOffset == 0 && (cursor and 1) != 0
    val cursorCol = (cursor ushr 1) and 0x7FFF
    val cursorRow = (cursor ushr 16) and 0xFFFF
    val line = ensureScrollLine()

    for (viewRow in 0 until rows) {
      val virtual = top + viewRow
      if (virtual < scrollback) {
        val copied = TerminalNative.nativeCopyScrollback(handle, virtual, line)
        if (copied > 0) {
          line.order(ByteOrder.LITTLE_ENDIAN)
          drawRow(canvas, line, 0, viewRow, -1, -1, -1)
        }
      } else {
        val liveRow = (virtual - scrollback).coerceIn(0, rows - 1)
        drawRow(
          canvas, live, liveRow * cols * CELL_BYTES, viewRow, liveRow,
          if (cursorVisible) cursorRow else -1,
          if (cursorVisible) cursorCol else -1,
        )
      }
    }
    cursorPaint.alpha = 255
  }

  /** 绘制一行 cell；liveRow < 0 表示回看行（不画光标）。 */
  private fun drawRow(
    canvas: Canvas,
    buffer: ByteBuffer,
    base: Int,
    viewRow: Int,
    liveRow: Int,
    cursorRow: Int,
    cursorCol: Int,
  ) {
    var col = 0
    while (col < cols) {
      val offset = base + col * CELL_BYTES
      val charCode = buffer.getInt(offset)
      val fg = buffer.getInt(offset + 4)
      val bg = buffer.getInt(offset + 8)
      val attrs = buffer.get(offset + 12).toInt()
      val width = buffer.get(offset + 13).toInt()
      if (width <= 0) {
        col += 1
        continue
      }
      val bgColor = if (bg == DEFAULT_COLOR) defaultBg else terminalArgb(bg)
      if (bgColor != defaultBg) {
        backgroundPaint.color = bgColor
        canvas.drawRect(
          col * cellWidth,
          viewRow * cellHeight,
          (col + width) * cellWidth,
          (viewRow + 1) * cellHeight,
          backgroundPaint,
        )
      }
      if (charCode != 0 && charCode != ' '.code) {
        paint.color = if (fg == DEFAULT_COLOR) defaultFg else terminalArgb(fg)
        paint.isFakeBoldText = attrs and ATTR_BOLD != 0
        paint.isUnderlineText = attrs and ATTR_UNDERLINE != 0
        canvas.drawText(
          String(Character.toChars(charCode)),
          col * cellWidth,
          viewRow * cellHeight - paint.ascent(),
          paint,
        )
      }
      if (liveRow >= 0 && liveRow == cursorRow && col == cursorCol) {
        cursorPaint.color = if (fg == DEFAULT_COLOR) defaultFg else terminalArgb(fg)
        cursorPaint.alpha = 140
        canvas.drawRect(
          col * cellWidth,
          viewRow * cellHeight,
          (col + width) * cellWidth,
          (viewRow + 1) * cellHeight,
          cursorPaint,
        )
      }
      col += width
    }
  }

  private fun ensureScrollLine(): ByteBuffer {
    val existing = scrollLine
    if (existing != null && existing.capacity() >= cols * CELL_BYTES) return existing
    val created = ByteBuffer.allocateDirect(cols * CELL_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    scrollLine = created
    return created
  }

  private fun ensureCells(): ByteBuffer {
    val existing = cells
    if (existing != null && existing.capacity() >= rows * cols * CELL_BYTES) return existing
    val created = ByteBuffer.allocateDirect(rows * cols * CELL_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    cells = created
    return created
  }

  // ---- IME ----

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE
    outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    return object : BaseInputConnection(this, false) {
      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (!text.isNullOrEmpty()) emit(text.toString().toByteArray(Charsets.UTF_8))
        return true
      }

      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        repeat(beforeLength.coerceAtLeast(0)) { emit(byteArrayOf(0x7f)) }
        return true
      }

      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        repeat(beforeLength.coerceAtLeast(0)) { emit(byteArrayOf(0x7f)) }
        return true
      }

      override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && handleKey(event)) return true
        return super.sendKeyEvent(event)
      }
    }
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (handleKey(event)) return true
    return super.onKeyDown(keyCode, event)
  }

  private fun handleKey(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN) return false
    if (event.isCtrlPressed) {
      val code = event.unicodeChar
      if (code in 'a'.code..'z'.code) {
        emit(byteArrayOf((code - 'a'.code + 1).toByte()))
        return true
      }
      if (code in 'A'.code..'Z'.code) {
        emit(byteArrayOf((code - 'A'.code + 1).toByte()))
        return true
      }
    }
    when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> emit(byteArrayOf('\r'.code.toByte()))
      KeyEvent.KEYCODE_DEL -> emit(byteArrayOf(0x7f))
      KeyEvent.KEYCODE_TAB -> emit(byteArrayOf('\t'.code.toByte()))
      KeyEvent.KEYCODE_ESCAPE -> emit(byteArrayOf(0x1b))
      KeyEvent.KEYCODE_DPAD_UP -> emit("\u001b[A".toByteArray())
      KeyEvent.KEYCODE_DPAD_DOWN -> emit("\u001b[B".toByteArray())
      KeyEvent.KEYCODE_DPAD_RIGHT -> emit("\u001b[C".toByteArray())
      KeyEvent.KEYCODE_DPAD_LEFT -> emit("\u001b[D".toByteArray())
      else -> return false
    }
    return true
  }

  override fun onTouchEvent(event: android.view.MotionEvent): Boolean {
    when (event.actionMasked) {
      android.view.MotionEvent.ACTION_DOWN -> {
        flingScroller.forceFinished(true)
        removeCallbacks(flingStep)
        velocityTracker?.recycle()
        velocityTracker = android.view.VelocityTracker.obtain().also { it.addMovement(event) }
        touchStartY = event.y
        touchStartOffset = scrollOffset
        touchDragging = false
        return true
      }
      android.view.MotionEvent.ACTION_MOVE -> {
        velocityTracker?.addMovement(event)
        // 手指向下拖 = 看更旧的内容（scrollOffset 增大），与自然滚动方向一致。
        val delta = event.y - touchStartY
        if (!touchDragging && kotlin.math.abs(delta) > cellHeight) touchDragging = true
        if (touchDragging && handle != 0L) {
          val available = TerminalNative.nativeScrollbackCount(handle)
          val lines = (delta / cellHeight).toInt()
          scrollOffset = (touchStartOffset + lines).coerceIn(0, available)
          invalidate()
        }
        return true
      }
      android.view.MotionEvent.ACTION_UP -> {
        if (touchDragging && handle != 0L) {
          velocityTracker?.computeCurrentVelocity(1000)
          val velocity = velocityTracker?.yVelocity ?: 0f
          if (kotlin.math.abs(velocity) > 300f) {
            val available = TerminalNative.nativeScrollbackCount(handle)
            flingScroller.fling(
              0, (scrollOffset * cellHeight).toInt(), 0, velocity.toInt(),
              0, 0, 0, (available * cellHeight).toInt(),
            )
            postOnAnimation(flingStep)
          }
        }
        if (!touchDragging) {
          requestFocus()
          val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
          imm.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
        }
        return true
      }
      android.view.MotionEvent.ACTION_CANCEL -> {
        flingScroller.forceFinished(true)
        removeCallbacks(flingStep)
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  override fun onDetachedFromWindow() {
    flingScroller.forceFinished(true)
    removeCallbacks(flingStep)
    velocityTracker?.recycle()
    velocityTracker = null
    super.onDetachedFromWindow()
  }

  private fun emit(bytes: ByteArray) {
    // 输入即回到底部：用户在回看时继续打字，视口应跟随提示符。
    scrollOffset = 0
    onInput?.invoke(bytes)
  }

  private companion object {
    const val CELL_BYTES = 16
    const val DEFAULT_COLOR = TERMINAL_DEFAULT_COLOR
    const val ATTR_BOLD = 1
    const val ATTR_UNDERLINE = 2
  }
}

/**
 * 视口顶部对应的虚拟行号：回看行 0..scrollback-1，当前屏行 scrollback..。
 * offsetFromBottom 从底部起算并夹在 [0, scrollback]，纯函数便于 JVM 单测。
 */
internal fun terminalViewportTop(scrollback: Int, offsetFromBottom: Int): Int {
  val safeScrollback = scrollback.coerceAtLeast(0)
  return safeScrollback - offsetFromBottom.coerceIn(0, safeScrollback)
}
