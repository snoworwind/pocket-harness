package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Debian guest paths, shell and native environment isolation. */
class LinuxGuestEnvironmentTest {
  private fun launch(f: LinuxInstallerFixture): LinuxGuestBoot.Launch {
    f.install(); val native = File(f.files, "native").apply { mkdirs() }
    for (name in listOf("libpocketharness_proot.so", "libpocketharness_proot_loader.so")) File(native, name).writeText("fixture")
    return (LinuxGuestBoot.resolve(LinuxGuestBoot.Paths(f.files, native, File(f.files, "home"), 3080)) as LinuxGuestBoot.Result.Ready).launch
  }
  @Test fun managedNodeAndPersistentUserCommandsPrecedeSystemCommands() = LinuxInstallerFixture().use { f ->
    val path = launch(f).argv.single { it.startsWith("PATH=") }
    assertTrue(path.startsWith("PATH=/opt/node/bin:/root/.local/bin:"))
    assertTrue(path.contains("/usr/bin"))
  }
  @Test fun guestTerminfoAndZshDoNotReceiveHostPrefixOverrides() = LinuxInstallerFixture().use { f ->
    val args = launch(f).argv.dropWhile { it != "/usr/bin/env" }
    assertTrue(args.none { it.startsWith("PREFIX=") || it.startsWith("TERMINFO=") || it.startsWith("FPATH=") || it.startsWith("TERMUX") })
    assertTrue(args.contains("SHELL=/bin/bash"))
  }
  @Test fun hostLibrariesStayOutsideTheGuestEnvironment() = LinuxInstallerFixture().use { f ->
    val spec = launch(f)
    assertNotNull(spec.env["LD_LIBRARY_PATH"])
    val args = spec.argv.dropWhile { it != "/usr/bin/env" }
    assertTrue(args.none { it.startsWith("LD_LIBRARY_PATH=") || it.startsWith("LD_PRELOAD=") || it.startsWith("PROOT_") })
  }
}
