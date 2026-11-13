package com.snoworwind.pocketharness

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.widget.TextView
import java.io.File
import java.io.FileInputStream

/** Private staging, fsync, then O_DIRECT destination readback; unsupported providers fail closed. */
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
      // 暂存文件必须在应用私有目录：绝不把 tar 直接写进用户可见的 /storage（R-03/R-04）。
      val staging = File(cacheDir, "$STAGING_PREFIX${System.currentTimeMillis()}.tar")
      val message = try {
        check(EngineService.userShutdown && LinuxInstanceInstaller.guestProcessesStopped()) { "请先停止引擎并关闭全部终端与控制台后重试。" }
        val sha256 = synchronized(LinuxInstanceInstaller) {
          clearStaleStaging()
          val staged = LinuxDataBackup.stage(filesDir, staging)
          try {
            copyAndVerify(uri, staged)
            staged.sha256
          } finally {
            deleteStaging(staging)
          }
        }
        "数据备份已导出并校验（SHA-256: $sha256）。文件包含凭据，请妥善保管。"
      } catch (error: Throwable) {
        // 任何失败（含校验不一致）都必须清掉暂存文件与已创建的目标文档；凭据不得留在半成品里。
        deleteStaging(staging)
        runCatching { DocumentsContract.deleteDocument(contentResolver, uri) }
        if (error is Error) throw error
        "备份失败，未完成文件已尝试删除：${error.message}"
      }
      runOnUiThread { if (!isFinishing && !isDestroyed) status.text = message }
    }.start()
  }

  /** A cache-assisted digest cannot prove shared-storage writeback, so require direct reads. */
  private fun copyAndVerify(uri: Uri, staged: LinuxDataBackup.Staged) {
    check(TerminalNative.available) { "无法加载备份校验组件" }
    ParcelFileDescriptor.AutoCloseOutputStream(openFd(uri, "wt") { "无法打开备份文档" }).use { out ->
      FileInputStream(staged.file).use { it.copyTo(out) }
      out.flush()
      out.fd.sync()
    }
    val actual = openFd(uri, "r") { "无法重新打开备份文档以校验" }.use { fd ->
      check(fd.statSize == staged.size) { "备份文件长度校验失败或存储提供方不支持长度查询" }
      val digest = LinuxDataBackup.directDigest(staged.size) { offset, buffer ->
        TerminalNative.nativeReadDirect(fd.fd, offset, buffer)
      }
      check(fd.statSize == staged.size) { "备份文件在校验期间发生变化" }
      digest
    }
    check(actual == staged.sha256) { "备份文件直接回读摘要不一致，备份未完整落盘" }
  }

  private fun openFd(uri: Uri, mode: String, message: () -> String): ParcelFileDescriptor =
    contentResolver.openFileDescriptor(uri, mode) ?: error(message())

  /** 删除暂存文件（含凭据）；删不掉时留诊断，不掩盖主流程的失败原因。 */
  private fun deleteStaging(file: File) {
    if (!file.exists()) return
    if (!file.delete()) LogCollector.log(TAG, "staging export file could not be deleted")
  }

  /** 清理上次进程被杀等异常中断留下的暂存文件（本次 [staging] 尚未创建，不会被误删）。 */
  private fun clearStaleStaging() {
    cacheDir?.listFiles()?.forEach { if (it.isFile && it.name.startsWith(STAGING_PREFIX)) deleteStaging(it) }
  }

  private companion object {
    const val TAG = "dsh-linux-backup"

    /** 暂存文件名前缀（应用私有 cacheDir 内，绝不出现在 /storage）。 */
    const val STAGING_PREFIX = "linux-data-backup-"
  }
}
