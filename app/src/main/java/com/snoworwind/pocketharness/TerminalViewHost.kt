package com.snoworwind.pocketharness

import android.content.Context
import android.util.Base64
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.FrameLayout
import org.json.JSONObject
import kotlin.math.max

/**
 * 原生终端视图的宿主：把 [TerminalView] 作为 WebView 之上的受管 overlay 挂到 root。
 *
 * 几何来自页面（CSS 像素，仅当 DSH WebView 自己的视口），壳侧换算成物理像素；
 * 视图只做渲染/输入，字节经 [output] 进入、经 `window.__dshTermInput` 返回页面。
 * 与 VdisplayHost 同一套「页面给矩形、壳侧持有原生层」的边界，页面拿不到 View 引用。
 */
internal class TerminalViewHost(
  private val root: FrameLayout,
  private val dshWebView: WebView,
) {
  private var view: TerminalView? = null
  private var bounds: TerminalStageBounds? = null
  private var visible = false

  fun open(raw: String): String = try {
    // 原生库未编入（旧 APK/降级构建）：如实失败，让页面显示回退入口，而不是留一块空白。
    if (!TerminalNative.available) return failed("native-terminal-unavailable", null)
    val config = JSONObject(raw)
    close()
    val created = TerminalView(root.context)
    created.onInput = { bytes -> deliverInput(bytes) }
    created.onResized = { cols, rows -> deliverResize(cols, rows) }
    val params = FrameLayout.LayoutParams(1, 1)
    params.leftMargin = 0
    params.topMargin = 0
    created.visibility = View.GONE
    root.addView(created, params)
    view = created
    val cols = max(2, config.optInt("cols", 80))
    val rows = max(1, config.optInt("rows", 24))
    created.open(cols, rows, null, null)
    ok(JSONObject().put("cols", cols).put("rows", rows))
  } catch (t: Throwable) {
    failed("invalid-terminal-config", t)
  }

  fun setBounds(raw: String): String {
    val parsed = TerminalStageBounds.parse(raw) ?: return failed("invalid-terminal-bounds", null)
    bounds = parsed
    visible = parsed.visible
    val created = view ?: return failed("terminal-not-open", null)
    val density = root.resources.displayMetrics.density
    val params = FrameLayout.LayoutParams(
      max(1, (parsed.width * density).toInt()),
      max(1, (parsed.height * density).toInt()),
    )
    params.leftMargin = (parsed.left * density).toInt()
    params.topMargin = (parsed.top * density).toInt()
    created.layoutParams = params
    created.visibility = if (parsed.visible) View.VISIBLE else View.GONE
    if (parsed.visible) created.requestLayout()
    return ok(JSONObject().put("visible", parsed.visible))
  }

  fun setVisible(flag: Boolean): String {
    visible = flag
    view?.visibility = if (flag) View.VISIBLE else View.GONE
    return ok(JSONObject().put("visible", flag))
  }

  /** PTY 输出（base64）；无视图或解码失败时返回结构化失败，不抛给桥。 */
  fun output(encoded: String): String {
    val created = view ?: return failed("terminal-not-open", null)
    return try {
      val bytes = if (encoded.isEmpty()) ByteArray(0) else Base64.decode(encoded, Base64.DEFAULT)
      created.output(bytes)
      ok(JSONObject())
    } catch (t: Throwable) {
      failed("invalid-terminal-output", t)
    }
  }

  fun focus(): String {
    val created = view ?: return failed("terminal-not-open", null)
    created.requestFocus()
    val imm = root.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.showSoftInput(created, InputMethodManager.SHOW_IMPLICIT)
    return ok(JSONObject())
  }

  fun close(): String {
    val created = view
    view = null
    bounds = null
    visible = false
    if (created != null) {
      created.close()
      root.removeView(created)
    }
    return ok(JSONObject())
  }

  fun destroy() {
    close()
  }

  private fun deliverInput(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
    dshWebView.post {
      dshWebView.evaluateJavascript(
        "window.__dshTermInput&&window.__dshTermInput('$encoded')",
        null,
      )
    }
  }

  private fun deliverResize(cols: Int, rows: Int) {
    dshWebView.post {
      dshWebView.evaluateJavascript(
        "window.__dshTermResize&&window.__dshTermResize($cols,$rows)",
        null,
      )
    }
  }

  private fun ok(payload: JSONObject): String =
    payload.put("ok", true).toString()

  private fun failed(reason: String, error: Throwable?): String =
    JSONObject().put("ok", false).put("reason", reason)
      .put("detail", error?.javaClass?.simpleName ?: "")
      .toString()
}
