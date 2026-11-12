package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * 客体启动的形状判据：缺件必须给出稳定拒绝码，齐全时 argv/env 必须固定到
 * PRoot、客体 Node、引擎入口和 addon 绑定，避免“起了一半”。
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
    val root = File(files, "linux-environment/runtime")
    val instance = File(root, "instances/debian-minimal-abc")
    val nodeKey = "sha256-deadbeef"
    val engineUsr = File(files, "engine")
    val addon = File(engineUsr, "@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64")
    root.mkdirs()
    File(root, "active.json").writeText(
      """{"schemaVersion":1,"instanceId":"debian-minimal-abc","runtimeId":"debian-minimal","version":"0.6.2","architecture":"arm64","nodeKey":"$nodeKey","activatedAt":"2026-11-12T00:00:00Z"}""",
    )
    touch(File(instance, "rootfs/etc/os-release"))
    touch(File(native, "libpocketharness_proot.so"))
    touch(File(native, "libpocketharness_proot_loader.so"))
    touch(File(root, "shared/node/$nodeKey/arm64/bin/node"))
    touch(File(engineUsr, "@deepseek-ai/dsh/lib/bin.js"))
    touch(File(addon, "bin/glibc/system.node"))
    return LinuxGuestBoot.Paths(
      runtimeRoot = root,
      nativeLibraryDir = native,
      engineDir = engineUsr,
      homeDir = File(files, "home"),
      port = 3080,
    )
  }

  @Test
  fun refusesWhenNoRuntimeIsInstalled() {
    val paths = fixture()
    File(paths.runtimeRoot, "active.json").delete()
    val result = LinuxGuestBoot.resolve(paths)
    assertTrue(result is LinuxGuestBoot.Result.Refused)
    assertEquals("linux-guest-not-installed", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun refusesWhenTheGuestAddonIsMissing() {
    val paths = fixture()
    File(paths.engineDir, "@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node").delete()
    val result = LinuxGuestBoot.resolve(paths)
    assertEquals("linux-guest-addon-missing", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun refusesACorruptActiveRecord() {
    val paths = fixture()
    File(paths.runtimeRoot, "active.json").writeText("{not json")
    val result = LinuxGuestBoot.resolve(paths)
    assertEquals("linux-guest-install-corrupt", (result as LinuxGuestBoot.Result.Refused).code)
  }

  @Test
  fun buildsProotCommandForTheGuestNodeAndEngine() {
    val paths = fixture()
    val ready = LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready
    val argv = ready.launch.argv
    assertEquals(paths.nativeLibraryDir.resolve("libpocketharness_proot.so").absolutePath, argv.first())
    assertTrue(argv.containsAll(listOf("-r", File(paths.runtimeRoot, "instances/debian-minimal-abc/rootfs").absolutePath, "-0")))
    assertTrue(argv.contains("--kill-on-exit"))
    assertTrue(argv.windowed(2).any { (a, b) -> a == "--port" && b == "3080" })
    assertTrue(argv.any { it == "/opt/dsh/@deepseek-ai/dsh/lib/bin.js" })
    assertTrue(argv.contains("${paths.engineDir.absolutePath}:/opt/dsh"))
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
    File(directory, LinuxGuestBoot.PREFERENCE_FILE).writeText("""{"mode":"guest"}""")
    assertEquals(LinuxGuestBoot.MODE_TERMUX, LinuxGuestBoot.mode(directory, runtimeInstalled = false))
    File(directory, LinuxGuestBoot.PREFERENCE_FILE).writeText("broken")
    assertEquals(LinuxGuestBoot.MODE_TERMUX, LinuxGuestBoot.mode(directory, runtimeInstalled = true))
  }
}

private fun <T> List<T>.windowed(size: Int): List<List<T>> =
  if (size <= 0 || this.size < size) emptyList() else (0..this.size - size).map { subList(it, it + size) }
