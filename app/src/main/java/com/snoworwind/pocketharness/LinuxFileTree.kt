package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.security.MessageDigest

/** A filesystem walk never follows links, including dangling links and parent collisions. */
internal object LinuxFileTree {
  fun digest(root: File): String {
    require(root.isDirectory && !Files.isSymbolicLink(root.toPath())) { "invalid managed tree" }
    val hash = MessageDigest.getInstance("SHA-256")
    fun visit(dir: File, prefix: String) {
      val children = dir.listFiles()?.sortedBy { it.name } ?: error("unreadable managed tree")
      for (file in children) {
        val path = prefix + file.name
        val (kind, body) = when {
          Files.isSymbolicLink(file.toPath()) -> "l" to Files.readSymbolicLink(file.toPath()).toString()
          file.isDirectory -> "d" to ""
          file.isFile -> "f" to SnapshotBundledAsset.digest({ file.inputStream() }).hex
          else -> error("unsupported managed entry: $path")
        }
        hash.update("$kind\u0000$path\u0000$body\u0000".toByteArray(Charsets.UTF_8))
        if (kind == "d") visit(file, "$path/")
      }
    }
    visit(root, "")
    return hash.digest().joinToString("") { "%02x".format(it) }
  }

  fun safeDirectory(root: File, relative: String): File {
    require(root.isDirectory && !Files.isSymbolicLink(root.toPath())) { "invalid user data root" }
    require(!relative.startsWith("/") && relative.split('/').all { it.isNotEmpty() && it != "." && it != ".." })
    var directory = root
    for (name in relative.split('/')) {
      directory = File(directory, name)
      require(!Files.isSymbolicLink(directory.toPath())) { "user package path traverses a symlink" }
      require(directory.isDirectory || directory.mkdir()) { "cannot prepare user package directory" }
    }
    return directory
  }

  /** Factory global instructions are the single replaceable file; user notes first move to ~/.agents. */
  fun mergeHomeSeed(source: File, target: File) {
    val stagedDsh = File(source, "home/.dsh")
    val liveHome = File(target, "home")
    val liveDsh = File(liveHome, ".dsh")
    require(!Files.isSymbolicLink(liveHome.toPath()) && !Files.isSymbolicLink(liveDsh.toPath())) { "user home is a symlink; refusing factory writes" }
    val factory = File(stagedDsh, "AGENTS.md")
    val live = File(liveDsh, "AGENTS.md")
    require(!Files.isSymbolicLink(factory.toPath()) && !Files.isSymbolicLink(live.toPath())) { "global instruction is a symlink; user data retained" }
    SnapshotUserData.prepareStagedSnapshot(stagedDsh, liveDsh)
    mergeMissing(source, target)
    if (factory.isFile) LinuxUpgradeTransaction.atomicWrite(live, factory.readText())
  }

  /** Rename only the known factory shell entry; preserve every user setting and custom row. */
  fun migrateShellIdentity(text: String): String {
    val legacy = Regex("""(?m)^(\s*- id: )shell-termux(\s*\n\s*name: ['"]?)@dsh-android/dsh-shell-termux(['"]?\s*)$""")
    return legacy.replace(text) { match ->
      match.groupValues[1] + "shell-linux" + match.groupValues[2] +
        "@dsh-android/dsh-shell-linux" + match.groupValues[3]
    }
  }

  fun migrateHomeShellIdentity(home: File) {
    val profiles = File(home, ".dsh/profiles")
    require(!Files.isSymbolicLink(File(home, ".dsh").toPath()) && !Files.isSymbolicLink(profiles.toPath())) { "profile root is a symlink" }
    for (profile in listOf("web", "headless")) {
      val directory = File(profiles, profile)
      val patch = File(directory, "cordis.patch.yml")
      require(!Files.isSymbolicLink(directory.toPath()) && !Files.isSymbolicLink(patch.toPath())) { "profile patch is a symlink; user data retained" }
      if (!patch.isFile) continue
      val bytes = patch.inputStream().use { it.readNBytes(2 * 1024 * 1024 + 1) }
      require(bytes.size <= 2 * 1024 * 1024) { "profile patch exceeds migration limit" }
      val before = bytes.toString(Charsets.UTF_8)
      val after = migrateShellIdentity(before)
      if (after != before) LinuxUpgradeTransaction.atomicWrite(patch, after)
    }
  }

  /** Copy missing entries only. A file or symlink at any existing parent wins over factory data. */
  fun mergeMissing(source: File, target: File) {
    require(!Files.isSymbolicLink(source.toPath())) { "seed root must not be a link" }
    if (Files.exists(target.toPath(), NOFOLLOW_LINKS) && (!target.isDirectory || Files.isSymbolicLink(target.toPath()))) return
    target.mkdirs()
    for (entry in source.listFiles() ?: error("unreadable seed")) {
      val out = File(target, entry.name)
      val exists = Files.exists(out.toPath(), NOFOLLOW_LINKS)
      when {
        Files.isSymbolicLink(entry.toPath()) -> if (!exists) Files.createSymbolicLink(out.toPath(), Files.readSymbolicLink(entry.toPath()))
        entry.isDirectory -> mergeMissing(entry, out)
        entry.isFile -> if (!exists) { entry.copyTo(out); out.setReadable(false, false); out.setReadable(true, true); out.setWritable(false, false); out.setWritable(true, true); out.setExecutable(entry.canExecute(), true) }
        else -> error("unsupported seed entry")
      }
    }
  }
}
