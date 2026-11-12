package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * 客体启动的形状判据：缺件必须给出稳定拒绝码，齐全时 argv/env 必须固定到
 * PRoot、客体 Node、内置实例与 /opt/dsh 引擎挂载点。
 */
class LinuxGuestBootTest {
  @get:Rule
  val temporary = TemporaryFolder()

  private fun touch(file: File): File {
    file.parentFile?.mkdirs()
    file.writeText("x")
    return file
  }

  private fun fixture(): LinuxGuestBoot.Paths {
    val files = temporary.newFolder("files")
    val native = temporary.newFolder("lib")
    val linux = File(files, "linux")
    File(linux, "instance.json").apply { parentFile.mkdirs() }.writeText("""{"schemaVersion":1}""")
    touch(File(linux, "rootfs/etc/os-release"))
    touch(File(linux, "node/bin/node"))
    touch(File(linux, "engine/@deepseek-ai/dsh/lib/bin.js"))
    touch(File(linux, "engine/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node"))
    touch(File(native, "libpocketharness_proot.so"))
    touch(File(native, "libpocketharness_proot_loader.so"))
    return LinuxGuestBoot.Paths(
      filesDir = files,
      nativeLibraryDir = native,
      homeDir = File(files, "home"),
      port = 3080,
    )
  }

  @Test
  fun refusesWhenNoInstanceIsInstalled() {
    val paths = fixture()
    File(paths.filesDir, "linux/instance.json").delete()
    val result = LinuxGuestBoot.resolve(paths)
    assertEquals("linux-instance-missing", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun refusesWhenTheGuestAddonIsMissing() {
    val paths = fixture()
    File(paths.filesDir, "linux/engine/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node").delete()
    val result = LinuxGuestBoot.resolve(paths)
    assertEquals("linux-guest-addon-missing", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun refusesACorruptInstanceManifest() {
    val paths = fixture()
    File(paths.filesDir, "linux/instance.json").writeText("{not json")
    val result = LinuxGuestBoot.resolve(paths)
    assertEquals("linux-instance-corrupt", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun buildsProotCommandForTheGuestNodeAndEngine() {
    val paths = fixture()
    val ready = LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready
    val argv = ready.launch.argv
    assertEquals(paths.nativeLibraryDir.resolve("libpocketharness_proot.so").absolutePath, argv.first())
    assertTrue(argv.containsAll(listOf("-r", File(paths.filesDir, "linux/rootfs").absolutePath, "-0")))
    assertTrue(argv.contains("--kill-on-exit"))
    assertTrue(argv.windowed(2).any { (a, b) -> a == "--port" && b == "3080" })
    assertTrue(argv.any { it == "/opt/dsh/@deepseek-ai/dsh/lib/bin.js" })
    assertTrue(argv.contains("${File(paths.filesDir, "linux/engine").absolutePath}:/opt/dsh"))
    assertEquals("1", ready.launch.env["PROOT_NO_SECCOMP"])
    assertEquals(paths.nativeLibraryDir.absolutePath, ready.launch.env["LD_LIBRARY_PATH"])
  }

  @Test
  fun bootModeFollowsInstallationUnlessExplicitlyPinned() {
    val directory = temporary.newFolder("linux-environment")
    assertEquals(LinuxGuestBoot.MODE_TERMUX, LinuxGuestBoot.mode(directory, runtimeInstalled = false))
    assertEquals(LinuxGuestBoot.MODE_LINUX, LinuxGuestBoot.mode(directory, runtimeInstalled = true))
    File(directory, LinuxGuestBoot.PREFERENCE_FILE).writeText("""{"mode":"termux"}""")
    assertEquals(LinuxGuestBoot.MODE_TERMUX, LinuxGuestBoot.mode(directory, runtimeInstalled = true))
    File(directory, LinuxGuestBoot.PREFERENCE_FILE).writeText("""{"mode":"linux"}""")
    assertEquals(LinuxGuestBoot.MODE_LINUX, LinuxGuestBoot.mode(directory, runtimeInstalled = false))
    File(directory, LinuxGuestBoot.PREFERENCE_FILE).writeText("broken")
    assertEquals(LinuxGuestBoot.MODE_TERMUX, LinuxGuestBoot.mode(directory, runtimeInstalled = true))
  }
}

private fun <T> List<T>.windowed(size: Int): List<List<T>> =
  if (size <= 0 || this.size < size) emptyList() else (0..this.size - size).map { subList(it, it + size) }
