package com.snoworwind.pocketharness

import java.nio.ByteBuffer

/**
 * 原生终端内核（libvterm）的 JNI 入口。
 *
 * 约定（与 `app/src/main/cpp/terminal_jni.c` 一致）：
 *  - 屏幕以**定长 cell 缓冲**交付：每 cell 16 字节（chars u32 / fg u32 / bg u32 / attrs u8 / width u8 / pad）；
 *  - 颜色是 0xRRGGBB，`0xFFFFFFFF` 表示「默认色」，由视图映射主题；
 *  - 句柄 0 表示创建失败；所有调用必须与 [nativeCreate] 同线程（当前即主线程）。
 *
 * 未编入原生库时 [available] 为 false；视图据此降级为只读提示，绝不崩溃。
 */
internal object TerminalNative {
  val available: Boolean = runCatching { System.loadLibrary("pocketharness_terminal") }.isSuccess

  external fun nativeCreate(cols: Int, rows: Int): Long

  external fun nativeDestroy(handle: Long)

  external fun nativeInput(handle: Long, data: ByteArray, length: Int)

  external fun nativeResize(handle: Long, cols: Int, rows: Int)

  /** 把整屏写入 [buffer]，返回 cell 数；句柄无效或容量不足返回 -1。 */
  external fun nativeCopyScreen(handle: Long, buffer: ByteBuffer): Int

  /** bit0 可见；bit1..15 列；bit16..31 行。 */
  external fun nativeCursor(handle: Long): Int

  /** 每 cell 字节数（当前 16）；供 Kotlin 侧分配缓冲。 */
  external fun nativeCellBytes(): Int
}
