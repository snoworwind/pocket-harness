package com.snoworwind.pocketharness

import org.json.JSONObject

/**
 * 页面给出的终端视图矩形（CSS 像素）。壳侧只认几何，不接受任何命令/路径。
 *
 * 解析失败返回 null（调用方保持上一次有效矩形），避免用 0 宽高把原生视图压成不可见。
 */
internal data class TerminalStageBounds(
  val left: Float,
  val top: Float,
  val width: Float,
  val height: Float,
  val visible: Boolean,
) {
  companion object {
    fun parse(raw: String): TerminalStageBounds? = try {
      val value = JSONObject(raw)
      val width = value.optDouble("width", 0.0).toFloat()
      val height = value.optDouble("height", 0.0).toFloat()
      if (!width.isFinite() || !height.isFinite() || width <= 0f || height <= 0f) {
        null
      } else {
        TerminalStageBounds(
          left = value.optDouble("left", 0.0).toFloat(),
          top = value.optDouble("top", 0.0).toFloat(),
          width = width,
          height = height,
          visible = value.optBoolean("visible", true),
        )
      }
    } catch (_: Throwable) {
      null
    }
  }
}
