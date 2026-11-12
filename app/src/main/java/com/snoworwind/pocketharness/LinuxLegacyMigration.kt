package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import org.json.JSONObject

/** One-time legacy backup precedes every write to old home. Cleanup follows a successful guest trial. */
internal object LinuxLegacyMigration {
  const val BACKUP = "linux-legacy-backup"
  private const val MARKER = ".linux-legacy-migration.json"

  fun pending(files: File): Boolean = File(files, MARKER).takeIf { it.isFile }?.let {
    JSONObject(it.readText()).getString("phase") != "done"
  } ?: false

  fun prepare(files: File) {
    val marker = File(files, MARKER)
    if (marker.exists()) {
      require(JSONObject(marker.readText()).getInt("schemaVersion") == 1)
      if (JSONObject(marker.readText()).getString("phase") != "done") rewriteProfiles(files)
      return
    }
    if (!SnapshotFs.exists(File(files, "usr")) && files.listFiles().orEmpty().none { it.name.startsWith(".snapshot-") }) return
    val backup = File(files, BACKUP)
    val stage = File(files, ".$BACKUP-stage")
    if (!backup.exists()) {
      SnapshotFs.deletePath(stage)
      stage.mkdirs()
      val home = File(files, "home")
      if (home.isDirectory && !Files.isSymbolicLink(home.toPath())) LinuxFileTree.mergeMissing(home, File(stage, "home"))
      LinuxUpgradeTransaction.atomicWrite(File(stage, "backup.json"), JSONObject().put("schemaVersion", 1).put("createdAt", System.currentTimeMillis()).toString())
      check(stage.renameTo(backup)) { "cannot commit legacy home backup" }
    }
    require(File(backup, "backup.json").isFile) { "legacy backup incomplete" }
    LinuxUpgradeTransaction.atomicWrite(marker, JSONObject().put("schemaVersion", 1).put("phase", "prepared").toString())
    rewriteProfiles(files)
  }

  /** Only legacy executable paths and the Android-only Canvas dependency change; other settings stay intact. */
  internal fun rewriteProfiles(files: File) {
    val profiles = File(files, "home/.dsh/profiles")
    if (!profiles.isDirectory || Files.isSymbolicLink(profiles.toPath())) return
    fun translate(value: String): String {
      var text = value
      for (prefix in listOf("/data/data/com.snoworwind.pocketharness/files/usr", "/data/user/0/com.snoworwind.pocketharness/files/usr", File(files, "usr").absolutePath)) {
        text = text.replace("$prefix/lib/node_modules", "/opt/dsh")
          .replace("$prefix/libexec/dsh-node", "/opt/node/bin/node")
          .replace("$prefix/bin/node", "/opt/node/bin/node")
          .replace("$prefix/bin/bash", "/bin/bash")
          .replace("$prefix/bin/python3", "/usr/bin/python3")
          .replace(prefix, "/usr")
      }
      return text.replace("@napi-rs/canvas-android-arm64", "@napi-rs/canvas-linux-arm64-gnu")
    }
    fun visit(dir: File) {
      for (file in dir.listFiles() ?: error("cannot read legacy profile")) {
        if (Files.isSymbolicLink(file.toPath())) {
          val before = Files.readSymbolicLink(file.toPath()).toString()
          val after = translate(before)
          if (before != after) { Files.delete(file.toPath()); Files.createSymbolicLink(file.toPath(), java.nio.file.Paths.get(after)) }
        } else if (file.isDirectory) {
          // The Android binding stays in the immutable legacy home backup; the seed supplies glibc.
          if (file.name == "canvas-android-arm64" && file.parentFile?.name == "@napi-rs") SnapshotFs.deletePath(file)
          else visit(file)
        } else if (file.extension in listOf("yml", "yaml", "json", "sh") && file.length() <= 4 * 1024 * 1024) {
          val before = file.readText()
          val after = translate(before)
          if (after != before) LinuxUpgradeTransaction.atomicWrite(file, after)
        }
      }
    }
    visit(profiles)
    // Retire only the exact old factory bootstrap stanza; user plugins stay untouched.
    for (profile in profiles.listFiles().orEmpty().filter { it.isDirectory && !Files.isSymbolicLink(it.toPath()) }) {
      val patch = File(profile, "cordis.patch.yml")
      if (patch.isFile) {
        val before = patch.readText()
        val after = PluginMounts.removeEntry(before, "@dsh-android/linux-bootstrap", "linux-bootstrap") ?: before
        require(!after.contains("@dsh-android/linux-bootstrap")) { "legacy bootstrap selection is ambiguous; backup retained" }
        if (before != after) LinuxUpgradeTransaction.atomicWrite(patch, after)
      }
    }
  }

  /** Salvage global npm packages from the formerly writable Node distribution before repairing it. */
  fun preserveNodeGlobals(files: File) {
    val modules = File(files, "linux/node/lib/node_modules")
    if (!modules.isDirectory || Files.isSymbolicLink(modules.toPath())) return
    val packages = modules.listFiles().orEmpty().flatMap { entry ->
      if (entry.name.startsWith("@") && entry.isDirectory && !Files.isSymbolicLink(entry.toPath())) entry.listFiles().orEmpty().toList()
      else listOf(entry)
    }.filter { entry -> (entry.isDirectory || Files.isSymbolicLink(entry.toPath())) && (entry.parentFile != modules || entry.name !in setOf("npm", "corepack", "pnpm")) }
    if (packages.isEmpty()) return
    val home = File(files, "home")
    require(home.isDirectory && !Files.isSymbolicLink(home.toPath()))
    val destination = LinuxFileTree.safeDirectory(home, ".local/lib/node_modules")
    val bin = LinuxFileTree.safeDirectory(home, ".local/bin")
    for (entry in packages) {
      val name = modules.toPath().relativize(entry.toPath()).toString().replace(File.separatorChar, '/')
      val parent = if ('/' in name) LinuxFileTree.safeDirectory(destination, name.substringBeforeLast('/')) else destination
      val target = File(parent, entry.name)
      if (!SnapshotFs.exists(target)) {
        if (Files.isSymbolicLink(entry.toPath())) Files.createSymbolicLink(target.toPath(), Files.readSymbolicLink(entry.toPath()))
        else LinuxFileTree.mergeMissing(entry, target)
      } else if (!Files.isSymbolicLink(entry.toPath())) {
        val identity = LinuxFileTree.digest(entry)
        val backup = LinuxFileTree.safeDirectory(home, ".local/share/pocket-harness/global-backups/$name/$identity")
        LinuxFileTree.mergeMissing(entry, backup)
      }
    }
    val originalBin = File(files, "linux/node/bin")
    for (entry in originalBin.listFiles().orEmpty()) {
      if (!Files.isSymbolicLink(entry.toPath()) || SnapshotFs.exists(File(bin, entry.name))) continue
      val link = Files.readSymbolicLink(entry.toPath()).toString()
      if (packages.any { pkg -> link.startsWith("../lib/node_modules/" + modules.toPath().relativize(pkg.toPath()).toString().replace(File.separatorChar, '/') + "/") }) {
        Files.createSymbolicLink(File(bin, entry.name).toPath(), java.nio.file.Paths.get(link))
      }
    }
  }

  fun commit(files: File) {
    val marker = File(files, MARKER)
    if (!marker.isFile) return
    val record = JSONObject(marker.readText())
    if (record.getString("phase") == "done") return
    require(File(files, "$BACKUP/backup.json").isFile) { "legacy backup missing; refusing cleanup" }
    // Only known legacy runtime paths are reclaimed; home and backups are never in this set.
    for (name in listOf("usr", "usr-old", ".snapshot-fingerprint", ".snapshot-transaction", ".snapshot-stage", ".snapshot-previous", ".snapshot-backup", ".online-snapshot", ".update-pending")) {
      SnapshotFs.deletePath(File(files, name))
    }
    LinuxUpgradeTransaction.atomicWrite(marker, record.put("phase", "done").toString())
  }
}
