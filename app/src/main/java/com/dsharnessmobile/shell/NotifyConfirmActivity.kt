package com.dsharnessmobile.shell

import android.app.Activity
import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.widget.EditText
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Notification PendingIntents only request this UI; a fresh native click authorizes delivery. */
class NotifyConfirmActivity : Activity() {
  private var pendingDecision: Intent? = null
  companion object {
    private val permits = ConcurrentHashMap<String, Long>()
    private const val PERMIT = "dsh.nativeDecisionPermit"

    fun consume(intent: Intent): Boolean {
      val issued = permits.remove(intent.getStringExtra(PERMIT) ?: return false) ?: return false
      return android.os.SystemClock.elapsedRealtime() - issued in 0..30_000
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (!keyguard.isDeviceSecure) {
      android.widget.Toast.makeText(this, "请先设置系统锁屏凭据，或打开应用作答", android.widget.Toast.LENGTH_LONG).show()
      finish(); return
    }
    val action = intent.getStringExtra(NotifyActionReceiver.EXTRA_ACTION)
    val input = if (action == NotifyActionReceiver.ACTION_REPLY) EditText(this) else null
    val message = when (action) {
      NotifyActionReceiver.ACTION_APPROVE -> "批准本次工具执行？请先确认你已查看会话中的请求。"
      NotifyActionReceiver.ACTION_REJECT -> "拒绝本次工具执行？"
      NotifyActionReceiver.ACTION_OPTION -> "提交选项：" + intent.getStringExtra(NotifyActionReceiver.EXTRA_OPTION)
      NotifyActionReceiver.ACTION_REPLY -> "请输入本次回复"
      else -> { finish(); return }
    }
    val subject = intent.getStringExtra("dsh.confirmSubject").orEmpty().take(4096)
    val dialog = AlertDialog.Builder(this).setTitle("确认通知操作").setMessage(message + "\n" + subject)
      .setNegativeButton("取消") { _, _ -> finish() }
      .setPositiveButton("确认") { _, _ ->
        pendingDecision = Intent(intent).setClass(this, NotifyActionReceiver::class.java)
        input?.let { pendingDecision?.putExtra("dsh.nativeReply", it.text.toString()) }
        val request = keyguard.createConfirmDeviceCredentialIntent("确认通知操作", message)
        if (request == null) { pendingDecision = null; finish() }
        else try { startActivityForResult(request, 701) }
        catch (_: Exception) { pendingDecision = null; finish() }
      }.setOnCancelListener { finish() }
    input?.let { dialog.setView(it) }
    val shown = dialog.create()
    shown.show()
    shown.getButton(AlertDialog.BUTTON_POSITIVE).filterTouchesWhenObscured = true
  }

  @Deprecated("Platform activity result used for system credential confirmation")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    val outgoing = pendingDecision
    pendingDecision = null
    if (requestCode == 701 && resultCode == RESULT_OK && outgoing != null) {
      val permit = UUID.randomUUID().toString()
      val now = android.os.SystemClock.elapsedRealtime()
      permits.entries.removeIf { now - it.value > 30_000 }
      permits[permit] = now
      outgoing.putExtra(PERMIT, permit)
      sendBroadcast(outgoing)
    }
    finish()
  }
}
