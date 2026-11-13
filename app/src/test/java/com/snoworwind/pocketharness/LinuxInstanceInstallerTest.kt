package com.snoworwind.pocketharness

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Assert.*
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Termux 式“只铺底、不替换”的判据：基础镜像永不替换，用户 apt 装的软件不能因覆盖更新丢失；
 * node/engine 是应用管理的运行时，可以随 APK 更新。
 */
class LinuxInstanceInstallerTest {
  @Test
  fun rootfsIsNeverReplacedByAnAppUpdate() {
    val plan = LinuxInstanceInstaller.planUpdate("a", "b", "c", "d")
    assertTrue(plan.replaceNode)
    assertTrue(plan.replaceEngine)
    assertFalse("基础镜像不得随 APK 覆盖更新替换", plan.replaceRootfs)
  }

  @Test
  fun identicalRuntimeDigestsNeedNoWork() {
    val plan = LinuxInstanceInstaller.planUpdate("same", "same", "same", "same")
    assertFalse(plan.replaceNode)
    assertFalse(plan.replaceEngine)
    assertFalse(plan.replaceRootfs)
  }

  @get:Rule val temporary = TemporaryFolder()

  private fun installedRoot(): File {
    val files = temporary.newFolder()
    File(files, "linux/rootfs/usr/bin").mkdirs()
    File(files, "linux/rootfs/usr/bin/user-package").writeText("keep")
    File(files, "linux/instance.json").writeText("""{"schemaVersion":1}""")
    return files
  }

  @Test fun missingManagedComponentsPermitRepairWithoutDiscardingRootfs() {
    val files = installedRoot()
    assertNull(LinuxInstanceInstaller.inspectExisting(files))
    assertEquals("keep", File(files, "linux/rootfs/usr/bin/user-package").readText())
  }

  @Test fun missingRootfsRequiresExplicitReset() {
    val files = installedRoot()
    File(files, "linux/rootfs").deleteRecursively()
    assertEquals("linux-reset-required", LinuxInstanceInstaller.inspectExisting(files)?.code)
    assertTrue(File(files, "linux/instance.json").exists())
  }

  @Test fun corruptManifestPreservesUserPackages() {
    val files = installedRoot()
    File(files, "linux/instance.json").writeText("broken")
    assertEquals("linux-instance-corrupt", LinuxInstanceInstaller.inspectExisting(files)?.code)
    assertEquals("keep", File(files, "linux/rootfs/usr/bin/user-package").readText())
  }

  @Test fun unknownSchemaDoesNotTriggerFreshInstall() {
    val files = installedRoot()
    File(files, "linux/instance.json").writeText("""{"schemaVersion":99}""")
    assertEquals("linux-schema-unsupported", LinuxInstanceInstaller.inspectExisting(files)?.code)
    assertEquals("keep", File(files, "linux/rootfs/usr/bin/user-package").readText())
  }
}

/** Real xz/tar fixtures exercise the production installer with an injected process trial, never a fake decoder. */
internal class LinuxInstallerFixture : java.io.Closeable {
  private val temporary = java.nio.file.Files.createTempDirectory("linux-installer-").toFile()
  val files = File(temporary, "files").apply { mkdirs() }
  val reads = mutableMapOf<String, Int>()
  var trial: (LinuxInstanceInstaller.Instance, org.json.JSONObject) -> Unit = { _, _ -> }

  fun source(version: String = "one", extraHome: Map<String, String> = emptyMap()): LinuxInstanceInstaller.Source {
    val payloads = linkedMapOf(
      "rootfs" to linkedMapOf("etc/os-release" to "ID=debian\nVERSION_ID=\"13\"\n", "usr/bin/bash" to "#!/bin/bash\n"),
      "node" to linkedMapOf("bin/node" to "node-$version", "lib/node_modules/npm/package.json" to "{}"),
      "engine" to linkedMapOf("@deepseek-ai/dsh/lib/bin.js" to "engine-$version", "@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node" to "addon-$version"),
      "home" to linkedMapOf("home/.dsh/AGENTS.md" to "<!-- dsh-mobile-factory-baseline -->\nfactory-$version", "home/.dsh/profiles/web/package.json" to "{}", "home/.gitconfig" to "factory-git"),
    )
    payloads.getValue("home").putAll(extraHome)
    val record = org.json.JSONObject().put("schemaVersion", 1).put("homeSchemaVersion", 1)
      .put("baseId", "debian-13-arm64-glibc-2").put("guestArchitecture", "arm64").put("minimumGlibc", "2.41")
    val assets = mutableMapOf<String, ByteArray>()
    for ((name, entries) in payloads) {
      val tree = File(temporary, "payload-$name")
      SnapshotFs.deletePath(tree); tree.mkdirs()
      for ((path, text) in entries) File(tree, path).apply { parentFile!!.mkdirs(); writeText(text) }
      if (name == "rootfs") {
        java.nio.file.Files.createSymbolicLink(File(tree, "bin").toPath(), java.nio.file.Paths.get("usr/bin"))
        java.nio.file.Files.createSymbolicLink(File(tree, "etc/mtab").toPath(), java.nio.file.Paths.get("/proc/mounts"))
      }
      val output = java.io.ByteArrayOutputStream()
      org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(org.apache.commons.compress.compressors.xz.XZCompressorOutputStream(output, 0)).use { tar ->
        java.nio.file.Files.walk(tree.toPath()).use { paths -> paths.filter { it != tree.toPath() }.sorted().forEach { path ->
          val relative = tree.toPath().relativize(path).toString().replace(File.separatorChar, '/')
          val link = java.nio.file.Files.isSymbolicLink(path)
          val entry = when {
            link -> org.apache.commons.compress.archivers.tar.TarArchiveEntry(relative, org.apache.commons.compress.archivers.tar.TarConstants.LF_SYMLINK).apply { linkName = java.nio.file.Files.readSymbolicLink(path).toString() }
            path.toFile().isDirectory -> org.apache.commons.compress.archivers.tar.TarArchiveEntry("$relative/")
            else -> org.apache.commons.compress.archivers.tar.TarArchiveEntry(relative).apply { size = path.toFile().length() }
          }
          entry.setModTime(0L)
          tar.putArchiveEntry(entry)
          if (!link && path.toFile().isFile) path.toFile().inputStream().use { it.copyTo(tar) }
          tar.closeArchiveEntry()
        } }
        tar.finish()
      }
      val bytes = output.toByteArray()
      assets["linux/$name.tar.xz"] = bytes
      record.put(name + "Sha256", SnapshotBundledAsset.digest({ bytes.inputStream() }).hex)
      record.put(name + "TreeSha256", LinuxFileTree.digest(tree))
      record.put(name + "UnpackedBytes", entries.values.sumOf { it.toByteArray().size.toLong() })
    }
    assets["linux/manifest.json"] = record.toString().toByteArray()
    return LinuxInstanceInstaller.Source(
      open = { path -> reads[path] = (reads[path] ?: 0) + 1; (assets[path] ?: error("missing fixture asset: $path")).inputStream() },
      trial = { instance, manifest, _ -> trial(instance, manifest) },
    )
  }

  fun install(version: String = "one") {
    val result = LinuxInstanceInstaller.ensure(source(version), files)
    check(result is LinuxInstanceInstaller.Result.Ready) { result.toString() }
  }

  override fun close() { SnapshotFs.deletePath(temporary) }
}
