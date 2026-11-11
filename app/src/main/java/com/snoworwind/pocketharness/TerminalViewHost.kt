package com.snoworwind.pocketharness

import android.content.Context
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
  /** 当前原生视图归属的终端 tab；同一 tab 重挂时复用视图，避免反复 close/create 触发 resize 重绘。 */
  private var owner: String? = null

  fun open(raw: String): String = onUi { openOnUi(raw) }

  private fun openOnUi(raw: String): String {
    // 原生库未编入（旧 APK/降级构建）：如实失败，让页面显示回退入口，而不是留一块空白。
    if (!TerminalNative.available) {
      return JSONObject().put("ok", false).put("reason", "native-terminal-unavailable")
        .put("detail", TerminalNative.loadError ?: "").toString()
    }
    return try {
      val config = JSONObject(raw)
      val token = config.optString("owner", "")
      if (view != null && token.isNotEmpty() && owner == token) {
        return ok(JSONObject().put("reused", true))
      }
      closeOnUi()
      owner = token.ifEmpty { null }
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
  }

  fun setBounds(raw: String): String = onUi { setBoundsOnUi(raw) }

  private fun setBoundsOnUi(raw: String): String {
    val parsed = TerminalStageBounds.parse(raw) ?: return failed("invalid-terminal-bounds", null)
    bounds = parsed
    visible = parsed.visible
    val created = view ?: return failed("terminal-not-open", null)
    val density = root.resources.displayMetrics.density
    val params = FrameLayout.LayoutParams(
      max(1, (parsed.width * density).toInt()),
      max(1, (parsed.height * density).toInt()),
    )
    // 页面矩形是 WebView 视口坐标；overlay 是 root 的子视图。两者原点可能不同
    // （状态栏/刘海 inset、侧栏 padding），必须加上 WebView 相对 root 的偏移，
    // 否则 overlay 会盖住顶部 tab 栏并吞掉侧栏按钮的触摸。
    val rootLocation = IntArray(2)
    root.getLocationInWindow(rootLocation)
    val webLocation = IntArray(2)
    dshWebView.getLocationInWindow(webLocation)
    val offsetX = webLocation[0] - rootLocation[0]
    val offsetY = webLocation[1] - rootLocation[1]
    params.leftMargin = offsetX + (parsed.left * density).toInt()
    params.topMargin = offsetY + (parsed.top * density).toInt()
    created.layoutParams = params
    created.visibility = if (parsed.visible) View.VISIBLE else View.GONE
    if (parsed.visible) created.requestLayout()
    return ok(JSONObject().put("visible", parsed.visible))
  }

  fun setVisible(flag: Boolean): String = onUi { setVisibleOnUi(flag) }

  private fun setVisibleOnUi(flag: Boolean): String {
    visible = flag
    view?.visibility = if (flag) View.VISIBLE else View.GONE
    return ok(JSONObject().put("visible", flag))
  }

  /** PTY 输出（base64）；无视图或解码失败时返回结构化失败，不抛给桥。 */
  fun output(encoded: String): String = onUi { outputOnUi(encoded) }

  private fun outputOnUi(encoded: String): String {
    val created = view ?: return failed("terminal-not-open", null)
    return try {
      val bytes = if (encoded.isEmpty()) ByteArray(0) else Base64.decode(encoded, Base64.DEFAULT)
      created.output(bytes)
      ok(JSONObject())
    } catch (t: Throwable) {
      failed("invalid-terminal-output", t)
    }
  }

  fun focus(): String = onUi { focusOnUi() }

  private fun focusOnUi(): String {
    val created = view ?: return failed("terminal-not-open", null)
    created.requestFocus()
    val imm = root.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.showSoftInput(created, InputMethodManager.SHOW_IMPLICIT)
    return ok(JSONObject())
  }

  fun close(): String = onUi { closeOnUi() }

  private fun closeOnUi(): String {
    val created = view
    view = null
    owner = null
    bounds = null
    visible = false
    if (created != null) {
      created.close()
      root.removeView(created)
      // 原生视图关闭后把焦点还给 WebView，否则 IME 仍挂在已销毁的视图上，页面输入会「打不了字」。
      dshWebView.requestFocus()
    }
    return ok(JSONObject())
  }

  fun destroy() {
    onUi { closeOnUi() }
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

  /**
   * 桥方法在 JavaBridge 线程同步调用，而 View 操作必须在主线程。
   * 短等待把结果同步带回桥线程；超时或 detach 时抛给 invoke 转成 bridge-call-failed。
   */
  private fun <T> onUi(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val latch = CountDownLatch(1)
    var value: T? = null
    var failure: Throwable? = null
    val posted = root.post {
      try {
        value = block()
      } catch (t: Throwable) {
        failure = t
      } finally {
        latch.countDown()
      }
    }
    if (!posted) throw IllegalStateException("terminal view host detached")
    if (!latch.await(3, TimeUnit.SECONDS)) throw IllegalStateException("terminal view host timeout")
    failure?.let { throw it }
    @Suppress("UNCHECKED_CAST")
    return value as T
  }

  private fun ok(payload: JSONObject): String =
    payload.put("ok", true).toString()

  private fun failed(reason: String, error: Throwable?): String =
    JSONObject().put("ok", false).put("reason", reason)
      .put("detail", error?.javaClass?.simpleName ?: "")
      .toString()
}
