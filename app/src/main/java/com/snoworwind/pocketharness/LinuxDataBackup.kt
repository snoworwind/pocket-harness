package com.snoworwind.pocketharness

import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarConstants
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.nio.file.Files

/** Portable tar data backup, streamed to a user-selected document. Symlinks are archived, never followed. */
internal object LinuxDataBackup {
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
}
