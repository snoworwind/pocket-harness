package com.snoworwind.pocketharness

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.widget.TextView

/** Native export remains available when the engine cannot enter the Web UI. */
class LinuxBackupActivity : Activity() {
  private lateinit var status: TextView
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    status = TextView(this).apply { text = "Linux 数据备份包含凭据，请保存在可信位置。导出期间请保持应用前台。"; setPadding(32, 64, 32, 32) }
    setContentView(status)
    if (state == null) AlertDialog.Builder(this).setTitle("导出 Linux 数据备份")
      .setMessage("将导出 Linux 软件、配置、用户 home 和凭据。请先停止引擎并关闭终端；备份为未加密的 tar 文件。")
      .setNegativeButton("取消") { _, _ -> finish() }
      .setPositiveButton("选择保存位置") { _, _ ->
        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE); type = "application/x-tar"
          putExtra(Intent.EXTRA_TITLE, "pocket-harness-linux-${System.currentTimeMillis()}.tar")
        }, 1)
      }.show()
  }
  @Deprecated("Legacy result API is sufficient for this isolated document activity")
  override fun onActivityResult(request: Int, result: Int, data: Intent?) {
    super.onActivityResult(request, result, data)
    if (request != 1 || result != RESULT_OK || data?.data == null) { finish(); return }
    val uri = data.data!!
    Thread {
      val message = try {
        check(EngineService.userShutdown && LinuxInstanceInstaller.guestProcessesStopped()) { "请先停止引擎并关闭全部终端与控制台后重试。" }
        synchronized(LinuxInstanceInstaller) {
          contentResolver.openOutputStream(uri, "wt")?.use { LinuxDataBackup.write(filesDir, it) } ?: error("无法打开备份文档")
        }
        "数据备份已导出。文件包含凭据，请妥善保管。"
      } catch (error: Exception) {
        runCatching { android.provider.DocumentsContract.deleteDocument(contentResolver, uri) }
        "备份失败，未完成文件已尝试删除：${error.message}"
      }
      runOnUiThread { if (!isFinishing && !isDestroyed) status.text = message }
    }.start()
  }
}
