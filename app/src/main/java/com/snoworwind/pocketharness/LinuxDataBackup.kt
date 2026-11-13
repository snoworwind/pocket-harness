package com.snoworwind.pocketharness

import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarConstants
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.DigestOutputStream
import java.security.MessageDigest

/**
 * Portable tar data backup, streamed to a user-selected document. Symlinks are archived, never followed.
 *
 * R-03/R-04：**绝不直接往用户选中的 SAF 文档里写 tar**。用户可见的 `/storage`（FUSE）曾在大写入时
 * 静默丢页，写完立刻回读还可能命中页缓存而「假通过」；因此导出分两步：
 * ① [stage] 把 tar 写进应用私有的暂存文件，边写边算流式 SHA-256，`getFD().sync()` 落盘后再**回读**一次
 *    暂存文件核对摘要（任何不一致都抛错，且不碰目标文档）；
 * ② 调用方把暂存文件拷进目标 URI，以 O_DIRECT 对齐读取重算 SHA-256（不支持则失败）（见 LinuxBackupActivity），
 *    只有回读摘要与 ① 的摘要一致才允许宣称「已导出并校验」。
 */
internal object LinuxDataBackup {
  /** 摘要算法：SHA-256（32 字节 / 64 位十六进制小写）。 */
  const val SHA256 = "SHA-256"

  /**
   * 暂存结果：[file] 是应用私有目录里的完整 tar，[sha256] 是写入时边写边算的十六进制摘要，
   * [size] 是暂存文件字节数（用于目标端长度对照）。
   */
  data class Staged(val file: File, val sha256: String, val size: Long)

  /** 把备份 tar 流式写入 [output]（不负责落盘同步，纯输出面；旧调用方与单测仍在用）。 */
  fun write(files: File, output: OutputStream) {
    check(!File(files, LinuxUpgradeTransaction.JOURNAL).exists()) { "Linux update is in progress" }
    TarArchiveOutputStream(output).use { tar ->
      tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
      tar.setBigNumberMode(TarArchiveOutputStream.BIGNUMBER_POSIX)
      val metadata = JSONObject().put("schemaVersion", 1).put("applicationId", "com.snoworwind.pocketharness")
        .put("createdAt", System.currentTimeMillis()).put("containsCredentials", true).toString().toByteArray()
      val manifest = TarArchiveEntry("backup.json").apply { size = metadata.size.toLong(); mode = 384 }
      tar.putArchiveEntry(manifest); tar.write(metadata); tar.closeArchiveEntry()
      fun add(file: File, name: String) {
        val link = Files.isSymbolicLink(file.toPath())
        val entry = when {
          link -> TarArchiveEntry(name, TarConstants.LF_SYMLINK).apply { linkName = Files.readSymbolicLink(file.toPath()).toString(); mode = 448 }
          file.isDirectory -> TarArchiveEntry("$name/").apply { mode = 448 }
          file.isFile -> TarArchiveEntry(name).apply { size = file.length(); mode = if (file.canExecute()) 448 else 384 }
          else -> error("unsupported backup entry: $name")
        }
        tar.putArchiveEntry(entry)
        if (!link && file.isFile) file.inputStream().use { it.copyTo(tar) }
        tar.closeArchiveEntry()
        if (!link && file.isDirectory) for (child in file.listFiles()?.sortedBy { it.name } ?: error("unreadable backup directory")) add(child, "$name/${child.name}")
      }
      for (name in listOf("home", "linux", "linux-environment", LinuxLegacyMigration.BACKUP, "deepseek-key.txt", "dashscope-key.txt")) {
        val file = File(files, name)
        if (SnapshotFs.exists(file)) add(file, "files/$name")
      }
      tar.finish()
    }
  }

  /**
   * 把 tar 写进应用私有的 [staging] 文件并返回其摘要（R-03/R-04 第一步）。
   *
   * 顺序是**判据的一部分**，不得调换：
   * 1. 流式写 + 同时更新 SHA-256（[DigestOutputStream]，不额外缓冲整包）；
   * 2. `flush()` 后 `FileOutputStream.getFD().sync()` —— 先把暂存文件真正落盘；
   * 3. 以**新的**只读流回读暂存文件重算摘要，与写入摘要比对（[requireFileDigest]）。
   *
   * 任何一步失败都删掉半成品暂存文件并把异常抛给调用方；此时目标 SAF 文档尚未被打开/写入。
   *
   * @throws IllegalStateException 暂存文件已存在、写入/回读失败或摘要不一致。
   */
  fun stage(files: File, staging: File): Staged {
    check(!staging.exists()) { "staging file already exists: ${staging.absolutePath}" }
    staging.parentFile?.let { parent -> check(parent.isDirectory || parent.mkdirs()) { "cannot create staging directory: ${parent.absolutePath}" } }
    try {
      val digest = MessageDigest.getInstance(SHA256)
      FileOutputStream(staging).use { raw ->
        // write() 会关闭它拿到的流；暂存路径要在关闭 raw 之前 fsync，故用不关闭的包装器隔离。
        val out = BufferedOutputStream(DigestOutputStream(raw, digest))
        write(files, NonClosingOutputStream(out))
        out.flush()
        // 暂存文件在应用私有目录（非 /storage），但落盘顺序仍是契约：先 fsync，后回读校验。
        raw.fd.sync()
      }
      val expected = hex(digest.digest())
      requireFileDigest(staging, expected, "staging")
      return Staged(staging, expected, staging.length())
    } catch (error: Throwable) {
      staging.delete()
      throw error
    }
  }

  /** Only aligned full blocks and one exact final block are accepted from the direct reader. */
  fun directDigest(size: Long, read: (Long, ByteArray) -> Int): String {
    require(size >= 0)
    val message = MessageDigest.getInstance(SHA256)
    val buffer = ByteArray(1024 * 1024)
    var offset = 0L
    while (offset < size) {
      val count = read(offset, buffer)
      val expected = minOf(buffer.size.toLong(), size - offset).toInt()
      check(count == expected) { "备份文件直接回读不完整" }
      message.update(buffer, 0, count)
      offset += count
    }
    return hex(message.digest())
  }

  /** 流式计算 [file] 的 SHA-256（十六进制小写）。 */
  fun digestFile(file: File): String = FileInputStream(file).use { digest(it) }

  /** 流式计算 [input] 的 SHA-256（十六进制小写）；不关闭调用方的流。 */
  fun digest(input: InputStream): String {
    val message = MessageDigest.getInstance(SHA256)
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      if (read > 0) message.update(buffer, 0, read)
    }
    return hex(message.digest())
  }

  /** [file] 的摘要是否与 [expectedSha256] 一致（大小写不敏感）。 */
  fun verifyFileDigest(file: File, expectedSha256: String): Boolean =
    digestFile(file).equals(expectedSha256, ignoreCase = true)

  /** [file] 的摘要是否与 [expectedSha256] 一致，不一致时抛带两值的错误（不得静默放过）。 */
  fun requireFileDigest(file: File, expectedSha256: String, label: String) {
    val actual = digestFile(file)
    check(actual.equals(expectedSha256, ignoreCase = true)) {
      "$label SHA-256 mismatch: expected=$expectedSha256 actual=$actual"
    }
  }

  private const val HEX = "0123456789abcdef"

  /** 只转发的包装器：`write()` 内部的 `use` 会 close 传入流，暂存路径必须自己控制 fsync 与关闭。 */
  private class NonClosingOutputStream(private val delegate: OutputStream) : java.io.FilterOutputStream(delegate) {
    override fun write(buffer: ByteArray, offset: Int, length: Int) = delegate.write(buffer, offset, length)
    override fun close() = Unit
  }

  private fun hex(bytes: ByteArray): String = buildString(bytes.size * 2) {
    for (byte in bytes) {
      val value = byte.toInt() and 0xff
      append(HEX[value ushr 4]); append(HEX[value and 0x0f])
    }
  }
}
