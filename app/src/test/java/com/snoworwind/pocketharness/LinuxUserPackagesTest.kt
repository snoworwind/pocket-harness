package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Debian user packages survive managed component updates. */
@RunWith(Parameterized::class)
class LinuxUserPackagesTest(private val pythonMinor: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters(name = "Python {0}") fun versions() = listOf("3.11", "3.12", "3.13", "3.14", "3.15").map { arrayOf(it) }
  }
  private fun userExtension(files: File) = File(files, "home/.local/lib/python$pythonMinor/site-packages/user-extension.so")
    .apply { parentFile!!.mkdirs(); writeText("user-native-package-$pythonMinor") }
  @Test fun nodeAndEngineUpdatesPreserveEveryPythonUserDirectory() = LinuxInstallerFixture().use { f ->
    f.install(); val extension = userExtension(f.files)
    val result = LinuxInstanceInstaller.ensure(f.source("two"), f.files)
    assertTrue(result.toString(), result is LinuxInstanceInstaller.Result.Ready)
    assertEquals("user-native-package-$pythonMinor", extension.readText())
  }
  @Test fun newHomeSeedNeverReplacesExistingPythonPackages() = LinuxInstallerFixture().use { f ->
    f.install(); val extension = userExtension(f.files)
    val relative = "home/.local/lib/python$pythonMinor/site-packages/user-extension.so"
    val result = LinuxInstanceInstaller.ensure(f.source("two", mapOf(relative to "factory-must-not-win")), f.files)
    assertTrue(result.toString(), result is LinuxInstanceInstaller.Result.Ready)
    assertEquals("user-native-package-$pythonMinor", extension.readText())
  }
  @Test fun backupExportsTheOriginalNativeBytesWithoutExecutingThem() = LinuxInstallerFixture().use { f ->
    f.install(); userExtension(f.files)
    val bytes = java.io.ByteArrayOutputStream().also { LinuxDataBackup.write(f.files, it) }.toByteArray()
    var found = false
    org.apache.commons.compress.archivers.tar.TarArchiveInputStream(bytes.inputStream()).use { tar ->
      var entry = tar.nextEntry
      while (entry != null) {
        if (entry.name == "files/home/.local/lib/python$pythonMinor/site-packages/user-extension.so") {
          assertEquals("user-native-package-$pythonMinor", tar.readBytes().toString(Charsets.UTF_8)); found = true
        }
        entry = tar.nextEntry
      }
    }
    assertTrue(found)
  }
}
