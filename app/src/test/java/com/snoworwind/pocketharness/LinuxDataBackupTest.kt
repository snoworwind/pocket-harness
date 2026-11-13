package com.snoworwind.pocketharness

import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** R-03/R-04：暂存 tar 的流式摘要、fsync 后回读校验与「翻转一个字节必失败」的反证。 */
class LinuxDataBackupTest {

  @Test fun directReaderRequiresExactBlocksAndPropagatesUnsupportedStorage() {
    val bytes = ByteArray(1024 * 1024 + 512) { (it % 127).toByte() }
    val offsets = mutableListOf<Long>()
    val actual = LinuxDataBackup.directDigest(bytes.size.toLong()) { offset, buffer ->
      offsets += offset
      val count = minOf(buffer.size, bytes.size - offset.toInt())
      bytes.copyInto(buffer, 0, offset.toInt(), offset.toInt() + count)
      count
    }
    assertEquals(sha256(bytes), actual)
    assertEquals(listOf(0L, 1024L * 1024), offsets)
    assertThrows(IllegalStateException::class.java) { LinuxDataBackup.directDigest(512) { _, _ -> 0 } }
    assertThrows(IllegalStateException::class.java) { LinuxDataBackup.directDigest(512) { _, _ -> 511 } }
    assertThrows(java.io.IOException::class.java) {
      LinuxDataBackup.directDigest(512) { _, _ -> throw java.io.IOException("O_DIRECT unsupported") }
    }
    assertNotEquals(sha256(bytes), LinuxDataBackup.directDigest(bytes.size.toLong()) { offset, buffer ->
      val count = minOf(buffer.size, bytes.size - offset.toInt())
      buffer.fill(0)
      count
    })
  }

  private fun <T> withTemp(block: (File) -> T): T {
    val root = Files.createTempDirectory("linux-data-backup").toFile()
    try {
      return block(root)
    } finally {
      root.deleteRecursively()
    }
  }

  /** 造一棵最小可备份的 filesDir（只用到 home 一项，避免依赖安装器夹具）。 */
  private fun filesWithHome(root: File, note: String = "user-note"): File {
    val files = File(root, "files").apply { mkdirs() }
    File(files, "home").mkdirs()
    File(files, "home/note.txt").writeText(note)
    return files
  }

  private fun sha256(bytes: ByteArray): String {
    val hex = "0123456789abcdef"
    return buildString {
      for (byte in MessageDigest.getInstance("SHA-256").digest(bytes)) {
        val value = byte.toInt() and 0xff
        append(hex[value ushr 4]); append(hex[value and 0x0f])
      }
    }
  }

  @Test fun stageWritesWholeTarToStagingAndReturnsItsDigest() = withTemp { root ->
    val files = filesWithHome(root)
    val staging = File(root, "cache/linux-data-backup.tar")

    val staged = LinuxDataBackup.stage(files, staging)

    assertEquals(staging.absoluteFile, staged.file.absoluteFile)
    assertTrue(staged.file.isFile)
    assertEquals(staged.file.length(), staged.size)
    // 摘要来自「边写边算」，必须与对暂存文件整包重算的 SHA-256 完全一致。
    assertEquals(sha256(staged.file.readBytes()), staged.sha256)
    assertEquals(staged.sha256, LinuxDataBackup.digestFile(staged.file))
    assertTrue(LinuxDataBackup.verifyFileDigest(staged.file, staged.sha256))
    // 暂存文件是完整 tar：manifest 与用户文件都在。
    val names = mutableListOf<String>()
    TarArchiveInputStream(FileInputStream(staged.file)).use { tar ->
      var entry = tar.nextEntry
      while (entry != null) { names += entry.name; entry = tar.nextEntry }
    }
    assertTrue(names.toString(), names.contains("backup.json"))
    assertTrue(names.toString(), names.contains("files/home/note.txt"))
  }

  @Test fun stageCreatesMissingStagingParentDirectory() = withTemp { root ->
    val files = filesWithHome(root)
    val staging = File(root, "cache/nested/backup.tar")
    assertFalse(staging.parentFile!!.exists())

    LinuxDataBackup.stage(files, staging)

    assertTrue(staging.isFile)
  }

  @Test fun stageRefusesToOverwriteAnExistingStagingFile() = withTemp { root ->
    val files = filesWithHome(root)
    val staging = File(root, "cache/existing.tar").apply { parentFile!!.mkdirs(); writeText("previous") }

    assertThrows(IllegalStateException::class.java) { LinuxDataBackup.stage(files, staging) }

    assertEquals("previous", staging.readText())
  }

  @Test fun stageRemovesThePartialStagingFileWhenTheArchiveCannotBeWritten() = withTemp { root ->
    val files = filesWithHome(root)
    // 升级事务进行中时 write() 在生成 tar 之前就失败：暂存半成品不得残留。
    File(files, LinuxUpgradeTransaction.JOURNAL).writeText("update-in-progress")
    val staging = File(root, "cache/linux-data-backup.tar")

    assertThrows(IllegalStateException::class.java) { LinuxDataBackup.stage(files, staging) }

    assertFalse(staging.exists())
  }

  @Test fun flippedByteFailsDigestVerification() = withTemp { root ->
    val files = filesWithHome(root)
    val staging = File(root, "cache/linux-data-backup.tar")
    val staged = LinuxDataBackup.stage(files, staging)
    assertTrue(LinuxDataBackup.verifyFileDigest(staging, staged.sha256))

    // 反证：翻转暂存文件里的一个字节，摘要校验必须失败（不得静默放过）。
    val bytes = staging.readBytes()
    val index = bytes.indexOfFirst { it != 0.toByte() }
    assertTrue(index >= 0)
    bytes[index] = (bytes[index].toInt() xor 0x01).toByte()
    staging.writeBytes(bytes)

    assertFalse(LinuxDataBackup.verifyFileDigest(staging, staged.sha256))
    val mismatch = assertThrows(IllegalStateException::class.java) {
      LinuxDataBackup.requireFileDigest(staging, staged.sha256, "staging")
    }
    assertTrue(mismatch.message!!, mismatch.message!!.contains("SHA-256 mismatch"))
    assertNotEquals(staged.sha256, LinuxDataBackup.digestFile(staging))
  }

  @Test fun digestFileMatchesContentAndDetectsChanges() = withTemp { root ->
    val same = File(root, "same.txt").apply { writeText("same-content") }
    val copy = File(root, "copy.txt").apply { writeText("same-content") }
    val changed = File(root, "changed.txt").apply { writeText("changed-content") }

    assertEquals(sha256("same-content".toByteArray()), LinuxDataBackup.digestFile(same))
    assertEquals(LinuxDataBackup.digestFile(same), LinuxDataBackup.digestFile(copy))
    assertNotEquals(LinuxDataBackup.digestFile(same), LinuxDataBackup.digestFile(changed))
    assertEquals(sha256(ByteArray(0)), LinuxDataBackup.digest(ByteArray(0).inputStream()))
  }
}
