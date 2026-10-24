package com.snoworwind.pocketharness

import android.content.Context
import android.content.Intent
import android.inputmethodservice.InputMethodService
import android.view.Gravity
import android.view.View
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 内嵌 ADB 输入通道 IME（ADB 2.0 Phase A，PRD-0.13.2 §3.2 A4）。
 *
 * 经典 ADBKeyboard 协议（senzhk/ADBKeyBoard 同款）：引擎侧 android_ui_input
 * 对非 ASCII 文本发 `am broadcast -a ADB_INPUT_TEXT --es msg <utf8>`（经 adb
 * shell uid），本服务把文本提交到当前输入连接（全 Unicode）。
 *
 * 设计约束：
 * - 不抢用户默认输入法：提交前提是「本 IME 实例存在 + 当前输入连接存在」（handle() 校验）。
 *   实例生命周期即信任锚：系统只在把本 IME 选为当前输入法时实例化该服务（onCreate→onDestroy），
 *   因此「实例在场」蕴含「本 IME 被选中」——广播到达时**不做** currentInputMethodId 二次比对
 *   （旧注释声称有这道校验，实现里从未存在，2026-10-24 R3-29 按现状更正文档）；
 *   `ime enable` 由引擎侧 android_ui_input 自动执行（只加入输入法列表，不设默认）。
 * - 输入视图仅一个「收起键盘」按钮（与经典 ADBKeyboard 观感一致）。
 * - 文本只在「本 IME 活跃 + 当前输入连接存在」时写入——注入面封闭。
 *
 * 协议动作（与引擎侧 android_ui_input 配对）：
 * - ADB_INPUT_TEXT：extra "msg" = UTF-8 文本（replace 语义）
 * - ADB_CLEAR_TEXT：清空当前输入框
 */
class AdbKeyboardService : InputMethodService() {

  override fun onCreateInputView(): View {
    val label = TextView(this).apply {
      text = "DeepSeek ADB 输入通道（点击收起键盘）"
      setPadding(dp(16), dp(8), dp(16), dp(8))
      setTextColor(0xFF666666.toInt())
      textSize = 12f
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = android.graphics.drawable.ColorDrawable(0xFFF2F2F2.toInt())
      addView(label)
    }
    bar.setOnClickListener { hideKeyboardInternal() }
    return bar
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** Submit through the current connection and preserve the connection's dispatch result. */
  private fun commitTextResult(text: String): AdbKeyboardEditStatus {
    val conn = currentInputConnection ?: return AdbKeyboardEditStatus.NO_INPUT_CONNECTION
    return AdbKeyboardEdits.commit(editPort(conn), text)
  }

  /** Clear only when a complete editor snapshot lets us select the whole field safely. */
  private fun clearTextResult(): AdbKeyboardEditStatus {
    val conn = currentInputConnection ?: return AdbKeyboardEditStatus.NO_INPUT_CONNECTION
    return AdbKeyboardEdits.clear(editPort(conn))
  }

  private fun editPort(connection: InputConnection): AdbKeyboardEditPort = object : AdbKeyboardEditPort {
    override fun beginBatchEdit(): Boolean = connection.beginBatchEdit()

    override fun fullTextLength(): Int? {
      val request = ExtractedTextRequest().apply {
        hintMaxChars = MAX_CLEAR_TEXT_CHARS
        hintMaxLines = MAX_CLEAR_TEXT_CHARS
      }
      val extracted = connection.getExtractedText(request, 0) ?: return null
      val text = extracted.text ?: return null
      // Keep the text transient and use only its length; never log or return field contents.
      return completeEditorTextLength(extracted.partialStartOffset, extracted.startOffset, text.length)
    }

    override fun setSelection(start: Int, end: Int): Boolean = connection.setSelection(start, end)

    override fun commitText(text: String): Boolean = connection.commitText(text, 1)

    override fun endBatchEdit(): Boolean = connection.endBatchEdit()
  }

  private fun hideKeyboardInternal() {
    val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
    imm.hideSoftInputFromWindow(window?.window?.decorView?.windowToken, 0)
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  companion object {
    const val ACTION_INPUT_TEXT = "ADB_INPUT_TEXT"
    const val ACTION_CLEAR_TEXT = "ADB_CLEAR_TEXT"
    const val EXTRA_MSG = "msg"
    const val EXTRA_AUTH = "auth"

    /** 当前活跃服务实例（广播转发入口；绑定期间才非空）。 */
    @Volatile
    var instance: AdbKeyboardService? = null
      private set

    /** 静态接收器统一入口：保留未就绪、无连接和编辑调用结果。 */
    internal fun handle(action: String, msg: String?): AdbKeyboardEditStatus {
      return when (action) {
        ACTION_INPUT_TEXT -> {
          if (msg == null) return AdbKeyboardEditStatus.BAD_REQUEST
          (instance ?: return AdbKeyboardEditStatus.IME_NOT_READY).commitTextResult(msg)
        }
        ACTION_CLEAR_TEXT -> (instance ?: return AdbKeyboardEditStatus.IME_NOT_READY).clearTextResult()
        else -> AdbKeyboardEditStatus.BAD_REQUEST
      }
    }

    /** 广播来源 nonce 文件（应用私有 filesDir 根；引擎经 DSH_FILES_DIR 读取后随广播回传）。 */
    fun nonceFile(context: Context): java.io.File =
      java.io.File(context.filesDir, NONCE_FILE_NAME)

    /** 幂等创建 nonce（MainActivity.onCreate 与首次校验时调用；应用私有域，仅本 uid 可读）。 */
    fun ensureNonce(context: Context): String {
      val f = nonceFile(context)
      if (f.exists()) {
        f.readText().trim().takeIf { it.isNotEmpty() }?.let { return it }
      }
      val secret = java.math.BigInteger(256, java.security.SecureRandom()).toString(16)
      f.parentFile?.mkdirs()
      f.writeText(secret)
      return secret
    }

    /**
     * 来源校验（0.13.8 #183；A03 修正 API 归属）：
     * 34+ uid 白名单（root/adb shell）或有效 auth nonce（引擎路径）。
     * `MessageDigest.isEqual` 常量时间比较，防逐字节试探。
     *
     * [senderUid] 必须由 **BroadcastReceiver 实例**在 `onReceive` 调用栈上取得后传入：
     * `getSentFromUid()` 属于 `BroadcastReceiver`，不属于 `Intent`。2026-10-18 审计 A03 的旧实现
     * 在 `Intent` 上反射取该方法，异常被吞成 null，于是 SDK 34+ 的 root/adb 白名单**恒不命中**，
     * IME 活跃时无 nonce 的标准 ADB_INPUT_TEXT/CLEAR 全被误拒。
     * 身份不可验证时仍 fail-closed：只认 nonce，两者都没有即拒绝。
     */
    fun isTrustedSender(context: Context, intent: Intent, senderUid: Int?): Boolean {
      if (android.os.Build.VERSION.SDK_INT >= 34 && senderUid != null && (senderUid == 0 || senderUid == 2000)) {
        return true
      }
      val given = intent.getStringExtra(EXTRA_AUTH) ?: return false
      val secret = try {
        nonceFile(context).takeIf { it.exists() }?.readText()?.trim()
      } catch (_: Throwable) {
        null
      } ?: return false
      return java.security.MessageDigest.isEqual(
        given.toByteArray(Charsets.UTF_8), secret.toByteArray(Charsets.UTF_8),
      )
    }

    private const val NONCE_FILE_NAME = "adb-keyboard-nonce"
    private const val MAX_CLEAR_TEXT_CHARS = ADB_KEYBOARD_MAX_CLEAR_TEXT_CHARS
  }
}
