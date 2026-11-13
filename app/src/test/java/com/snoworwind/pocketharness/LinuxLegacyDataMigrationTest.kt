package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Legacy Bionic-to-Debian user data boundary. */
class LinuxLegacyDataMigrationTest {
  private fun oldUser(f: LinuxInstallerFixture): File {
    File(f.files, "usr/bin").mkdirs(); File(f.files, "usr/bin/node").writeText("old-bionic-node")
    return File(f.files, "home/.dsh").apply { mkdirs() }
  }
  @Test fun legacyDshIsBackedUpBeforeAnyProfileWrites() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "settings.yaml").writeText("user-setting")
    f.trial = { _, _ -> assertEquals("user-setting", File(f.files, "linux-legacy-backup/home/.dsh/settings.yaml").readText()) }
    f.install(); assertEquals("user-setting", File(dsh, "settings.yaml").readText())
  }
  @Test fun credentialsAreNeverTakenFromTheFactorySeed() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, ".credentials.yaml").writeText("user-credential")
    f.install(); assertEquals("user-credential", File(dsh, ".credentials.yaml").readText())
  }
  @Test fun installedUserPluginSelectionsSurviveTheSeed() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); val profile = File(dsh, "profiles/web").apply { mkdirs() }
    File(profile, "package.json").writeText("""{"dependencies":{"user-plugin":"1.2.3"}}""")
    f.install(); assertTrue(File(profile, "package.json").readText().contains("user-plugin"))
  }
  @Test fun userGitConfigurationIsNeverOverwritten() = LinuxInstallerFixture().use { f ->
    oldUser(f); File(f.files, "home/.gitconfig").writeText("user-git")
    f.install(); assertEquals("user-git", File(f.files, "home/.gitconfig").readText())
  }
  @Test fun oldUsrIsReclaimedOnlyAfterTheCandidateTrial() = LinuxInstallerFixture().use { f ->
    oldUser(f); f.trial = { _, _ -> assertTrue(File(f.files, "usr/bin/node").isFile) }
    f.install(); assertFalse(File(f.files, "usr").exists())
  }
  @Test fun failedTrialKeepsOldUsrAndTheOriginalBackup() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "settings.yaml").writeText("keep")
    f.trial = { _, _ -> error("candidate failed") }
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertTrue(File(f.files, "usr/bin/node").isFile)
    assertEquals("keep", File(f.files, "linux-legacy-backup/home/.dsh/settings.yaml").readText())
  }
  @Test fun oldTransactionMarkersAreCleanedWithoutRunningOldRecovery() = LinuxInstallerFixture().use { f ->
    oldUser(f); File(f.files, ".snapshot-transaction").writeText("unparseable-old-journal")
    File(f.files, ".snapshot-fingerprint").writeText("old")
    f.install(); assertFalse(File(f.files, ".snapshot-transaction").exists()); assertFalse(File(f.files, ".snapshot-fingerprint").exists())
  }
  @Test fun repeatedStartupDoesNotReplaceTheLegacyBackup() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "settings.yaml").writeText("before")
    f.install(); File(dsh, "settings.yaml").writeText("after")
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("before", File(f.files, "linux-legacy-backup/home/.dsh/settings.yaml").readText())
    assertEquals("after", File(dsh, "settings.yaml").readText())
  }
  @Test fun legacyNodeAndBashPathsMoveIntoTheGuestNamespace() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); val profile = File(dsh, "profiles/web").apply { mkdirs() }
    File(profile, "cordis.patch.yml").writeText("bashPath: ${f.files}/usr/bin/bash\nnodeExecutable: ${f.files}/usr/libexec/dsh-node\nuser: unchanged\n")
    f.install(); val text = File(profile, "cordis.patch.yml").readText()
    assertTrue(text.contains("bashPath: /bin/bash")); assertTrue(text.contains("nodeExecutable: /opt/node/bin/node")); assertTrue(text.contains("user: unchanged"))
  }
  @Test fun bootstrapRetirementDoesNotRemoveItsSiblingUserPlugin() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); val profile = File(dsh, "profiles/web").apply { mkdirs() }
    File(profile, "cordis.patch.yml").writeText("- insert:\n    - id: linux-bootstrap\n      name: '@dsh-android/linux-bootstrap'\n    - id: user-plugin\n      name: 'user-plugin'\n")
    f.install(); val text = File(profile, "cordis.patch.yml").readText()
    assertFalse(text.contains("linux-bootstrap")); assertTrue(text.contains("user-plugin"))
  }
  @Test fun oldFactoryInstructionsChangeButPersonalInstructionsRemain() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "AGENTS.md").writeText("<!-- dsh-mobile-factory-baseline -->\nold-factory")
    val personal = File(f.files, "home/.agents/AGENTS.md").apply { parentFile!!.mkdirs(); writeText("personal") }
    f.install(); assertTrue(File(dsh, "AGENTS.md").readText().contains("factory-one")); assertEquals("personal", personal.readText())
  }
  @Test fun userEditedLegacyInstructionsAreMigratedBeforeFactoryReplacement() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "AGENTS.md").writeText("user-instructions")
    f.install(); assertEquals("user-instructions", File(f.files, "home/.agents/AGENTS.md").readText())
    assertTrue(File(dsh, "AGENTS.md").readText().contains("factory-one"))
  }

  @Test fun legacyBackupIsScopedToThePathsMigrationRewrites() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "settings.yaml").writeText("keep")
    File(f.files, "home/attachments/large.bin").apply { parentFile!!.mkdirs(); writeText("not rewritten") }
    f.install()
    assertTrue(File(f.files, "linux-legacy-backup/home/.dsh/settings.yaml").isFile)
    assertFalse(File(f.files, "linux-legacy-backup/home/attachments/large.bin").exists())
    assertFalse(File(f.files, "linux-legacy-backup/home/.dsh/sessions").exists())
  }

  @Test fun tamperedLegacyBackupBlocksCleanupOfOldUsr() = LinuxInstallerFixture().use { f ->
    val dsh = oldUser(f); File(dsh, "settings.yaml").writeText("keep")
    f.trial = { _, _ -> error("stop before commit") }
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertTrue(File(f.files, "usr/bin/node").isFile)
    File(f.files, "linux-legacy-backup/home/.dsh/settings.yaml").writeText("tampered")
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertTrue("校验失败后必须保留旧运行时候删", File(f.files, "usr/bin/node").isFile)
    assertEquals("keep", File(dsh, "settings.yaml").readText())
  }

}
