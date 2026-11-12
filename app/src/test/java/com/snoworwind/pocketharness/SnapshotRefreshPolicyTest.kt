package com.snoworwind.pocketharness

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Former refresh policy baseline now covers frozen-rootfs upgrade and resumable-install behavior. */
class SnapshotRefreshPolicyTest {
  @Test fun identicalAssetsNeverRepeatTheTrialOrUnpack() = LinuxInstallerFixture().use { f ->
    f.install(); f.reads.clear(); var trials = 0; f.trial = { _, _ -> trials++ }
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals(0, trials); assertEquals(0, f.reads["linux/rootfs.tar.xz"] ?: 0)
  }
  @Test fun candidateTrialRunsBeforeLiveNodeIsReplaced() = LinuxInstallerFixture().use { f ->
    f.install(); f.trial = { candidate, _ ->
      assertEquals("node-one", File(f.files, "linux/node/bin/node").readText())
      assertEquals("node-two", candidate.node.readText())
    }
    assertTrue(LinuxInstanceInstaller.ensure(f.source("two"), f.files) is LinuxInstanceInstaller.Result.Ready)
  }
  @Test fun compatibleNewBaseArchiveDoesNotReplaceInstalledAptData() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs/user-apt").writeText("keep")
    val source = f.source("two")
    val changed = source.copy(open = { path -> if (path == "linux/manifest.json") source.open(path).use { JSONObject(it.bufferedReader().readText()).put("rootfsSha256", "a".repeat(64)).toString().byteInputStream() } else source.open(path) })
    assertTrue(LinuxInstanceInstaller.ensure(changed, f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("keep", File(f.files, "linux/rootfs/user-apt").readText())
  }
  @Test fun authenticatedAbsoluteGuestSymlinksSurviveActualExtraction() = LinuxInstallerFixture().use { f ->
    f.install(); assertEquals("/proc/mounts", java.nio.file.Files.readSymbolicLink(File(f.files, "linux/rootfs/etc/mtab").toPath()).toString())
  }
  @Test fun firstInstallCanResumeAfterProcessDeathWithoutReextractingRootfs() = LinuxInstallerFixture().use { f ->
    f.trial = { _, _ -> throw AssertionError("process death") }
    try { LinuxInstanceInstaller.ensure(f.source(), f.files); fail() } catch (_: AssertionError) {}
    assertTrue(File(f.files, ".linux-stage/.rootfs.ready").isFile)
    f.trial = { _, _ -> }; f.reads.clear()
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals(0, f.reads["linux/rootfs.tar.xz"] ?: 0)
  }
  @Test fun aCorruptCompletedStageIsReextractedRatherThanTrusted() = LinuxInstallerFixture().use { f ->
    f.trial = { _, _ -> throw AssertionError("process death") }
    try { LinuxInstanceInstaller.ensure(f.source(), f.files) } catch (_: AssertionError) {}
    File(f.files, ".linux-stage/rootfs/usr/bin/bash").writeText("poison")
    f.trial = { _, _ -> }; f.reads.clear()
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertTrue((f.reads["linux/rootfs.tar.xz"] ?: 0) > 0)
  }
  @Test fun longPreparationDoesNotConsumeTheHttpReadinessBudget() = LinuxInstallerFixture().use { f ->
    var clock = 0L; val progress = mutableListOf<String>()
    f.trial = { _, _ -> clock += 12 * 60_000L }
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) { progress += it } is LinuxInstanceInstaller.Result.Ready)
    val start = clock
    assertTrue(awaitEngineHttpReady(processAlive = { true }, probe = { clock - start >= 2_000 }, current = { true }, now = { clock }, sleep = { clock += it }))
    assertTrue(progress.isNotEmpty()); assertTrue(clock - start < ENGINE_BOOT_BUDGET_MS)
  }
  @Test fun newHomeSchemaFilesAreAddedWithoutReplacingExistingProfiles() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "home/.dsh/profiles/web/package.json").writeText("user-profile")
    assertTrue(LinuxInstanceInstaller.ensure(f.source("two", mapOf("home/.dsh/new-schema-file" to "added")), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("user-profile", File(f.files, "home/.dsh/profiles/web/package.json").readText())
    assertEquals("added", File(f.files, "home/.dsh/new-schema-file").readText())
  }
}
