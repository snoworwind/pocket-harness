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
    val record = org.json.JSONObject(File(linux, "instance.json").readText())
    for (name in listOf("node", "engine")) record.put(name + "TreeSha256", LinuxFileTree.digest(File(linux, name)))
    File(linux, "instance.json").writeText(record.toString())
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
    assertEquals("linux-managed-tree-corrupt", (result as LinuxGuestBoot.Result.Refused).code)
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
    assertTrue(argv.containsAll(listOf("-r", File(paths.filesDir, "linux/rootfs").canonicalPath, "-0")))
    assertTrue(argv.contains("--kill-on-exit"))
    assertTrue(argv.windowed(2).any { (a, b) -> a == "--port" && b == "3080" })
    assertTrue(argv.any { it == "/opt/dsh/@deepseek-ai/dsh/lib/bin.js" })
    assertTrue(argv.contains("${File(paths.filesDir, "linux/engine").absolutePath}:/opt/dsh"))
    assertEquals("1", ready.launch.env["PROOT_NO_SECCOMP"])
    assertEquals(paths.nativeLibraryDir.absolutePath, ready.launch.env["LD_LIBRARY_PATH"])
  }

  @Test
  fun buildsAGuestBashCommandForTheConsole() {
    val paths = fixture()
    val ready = LinuxGuestBoot.command(paths, listOf("/bin/bash", "-i")) as LinuxGuestBoot.Result.Ready
    val argv = ready.launch.argv
    assertTrue(argv.contains("/bin/bash"))
    assertTrue(argv.contains("-i"))
    assertTrue(argv.any { it.startsWith("PATH=/opt/node/bin:/root/.local/bin:/root/.local/share/pnpm:/usr/local/sbin:") })
    assertTrue(argv.any { it.startsWith("HOME=/root") })
  }

  @Test
  fun bindsRequiredKernelAndPtyInterfacesWithoutTheEntireAppFilesTree() {
    val paths = fixture()
    val argv = (LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready).launch.argv
    assertTrue(argv.contains("--link2symlink"))
    for (binding in listOf("/proc:/proc", "/sys:/sys", "/dev/pts:/dev/pts", "/dev/ptmx:/dev/ptmx")) {
      assertTrue(argv.windowed(2).any { it == listOf("-b", binding) })
    }
    val root = File(paths.filesDir, "linux/rootfs").canonicalPath
    assertTrue(argv.windowed(2).any { it == listOf("-b", "$root:$root") })
    assertTrue(argv.none { it == "${paths.filesDir.absolutePath}:${paths.filesDir.absolutePath}" })
  }

  @Test
  fun loaderEnvironmentCannotBeCopiedIntoTheGuest() {
    val paths = fixture()
    val launch = (LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready).launch
    for (key in listOf("LD_LIBRARY_PATH", "LD_PRELOAD", "PROOT_LOADER", "TERMUX_VERSION")) {
      try { LinuxGuestBoot.withEnvironment(launch, mapOf(key to paths.nativeLibraryDir.absolutePath)); org.junit.Assert.fail(key) }
      catch (_: IllegalArgumentException) {}
    }
    assertEquals(paths.nativeLibraryDir.absolutePath, launch.env["LD_LIBRARY_PATH"])
    assertTrue(launch.argv.none { it.startsWith("LD_LIBRARY_PATH=") || it.startsWith("LD_PRELOAD=") })
  }

  @Test
  fun packageManagerPrefixAndUserCommandsStayInPersistentHome() {
    val paths = fixture()
    val argv = (LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready).launch.argv
    assertTrue(argv.contains("npm_config_prefix=/root/.local"))
    assertTrue(argv.contains("PNPM_HOME=/root/.local/share/pnpm"))
    assertTrue(argv.contains("NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"))
    assertTrue(argv.contains("PYTHON=/usr/bin/python3"))
    assertTrue(argv.contains("CC=/usr/bin/gcc"))
    assertTrue(argv.contains("CXX=/usr/bin/g++"))
  }

  @Test
  fun guestEnvironmentSurvivesTheIsolationBoundary() {
    val paths = fixture()
    val launch = (LinuxGuestBoot.resolve(paths) as LinuxGuestBoot.Result.Ready).launch
    val updated = LinuxGuestBoot.withEnvironment(launch, mapOf("DSH_HOME" to "/root/.dsh", "DSH_PICK_TOKEN" to "opaque-test", "SHELL" to "/bin/bash"))
    val afterIsolation = updated.argv.drop(updated.argv.indexOf("-i") + 1)
    assertTrue(afterIsolation.contains("DSH_HOME=/root/.dsh"))
    assertTrue(afterIsolation.contains("DSH_PICK_TOKEN=opaque-test"))
    assertTrue(afterIsolation.indexOf("DSH_PICK_TOKEN=opaque-test") < afterIsolation.indexOf("/opt/node/bin/node"))
    assertTrue(updated.env.keys.none { it.startsWith("TERMUX") || it == "LD_PRELOAD" })
  }

}

private fun <T> List<T>.windowed(size: Int): List<List<T>> =
  if (size <= 0 || this.size < size) emptyList() else (0..this.size - size).map { subList(it, it + size) }
