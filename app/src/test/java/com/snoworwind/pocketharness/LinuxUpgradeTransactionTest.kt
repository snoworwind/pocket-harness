package com.snoworwind.pocketharness

import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File

class LinuxUpgradeTransactionTest {
  @get:Rule val temporary = TemporaryFolder()
  private fun fixture(): File {
    val files = temporary.newFolder()
    for (name in listOf("node", "engine", "rootfs")) {
      File(files, "linux/$name").mkdirs()
      File(files, "linux/$name/value").writeText("old-$name")
    }
    File(files, "linux/instance.json").writeText("old-manifest")
    return files
  }
  private fun prepare(stage: File) {
    for (name in listOf("node", "engine")) {
      File(stage, name).mkdirs(); File(stage, "$name/value").writeText("new-$name")
    }
    File(stage, "instance.json").writeText("new-manifest")
  }
  private val components = listOf("node", "engine", "instance.json")

  @Test fun committedUpgradeKeepsUserRootfsAndSwitchesAllComponents() {
    val files = fixture()
    LinuxUpgradeTransaction.apply(files, components, ::prepare, {})
    assertEquals("new-node", File(files, "linux/node/value").readText())
    assertEquals("new-engine", File(files, "linux/engine/value").readText())
    assertEquals("old-rootfs", File(files, "linux/rootfs/value").readText())
    assertFalse(File(files, LinuxUpgradeTransaction.JOURNAL).exists())
  }
  @Test fun failedProbeNeverChangesLiveFiles() {
    val files = fixture()
    try { LinuxUpgradeTransaction.apply(files, components, ::prepare, { error("probe failed") }); fail() } catch (_: IllegalStateException) {}
    assertEquals("old-node", File(files, "linux/node/value").readText())
    assertEquals("old-manifest", File(files, "linux/instance.json").readText())
  }
  @Test fun processDeathAtEveryRenameRecoversDeterministically() {
    for (point in listOf("prepared", "probed", "backed-up:node", "activated:node", "backed-up:engine", "activated:engine", "backed-up:instance.json", "activated:instance.json", "committed")) {
      val files = fixture()
      try { LinuxUpgradeTransaction.apply(files, components, ::prepare, {}, { if (it == point) throw AssertionError("power loss") }); fail() } catch (_: AssertionError) {}
      LinuxUpgradeTransaction.recover(files)
      LinuxUpgradeTransaction.recover(files)
      val state = if (point == "committed") "new" else "old"
      assertEquals(point, "$state-node", File(files, "linux/node/value").readText())
      assertEquals(point, "$state-engine", File(files, "linux/engine/value").readText())
      assertEquals(point, "$state-manifest", File(files, "linux/instance.json").readText())
      assertEquals("old-rootfs", File(files, "linux/rootfs/value").readText())
    }
  }
  @Test fun interruptedRepairRemovesNewComponentButPreservesRootfs() {
    val files = fixture(); File(files, "linux/node").deleteRecursively()
    try { LinuxUpgradeTransaction.apply(files, components, ::prepare, {}, { if (it == "activated:node") throw AssertionError() }) } catch (_: AssertionError) {}
    LinuxUpgradeTransaction.recover(files)
    assertFalse(File(files, "linux/node").exists())
    assertEquals("old-rootfs", File(files, "linux/rootfs/value").readText())
  }
  @Test fun rootfsCannotEnterTheUpgradeSwap() {
    val files = fixture()
    try { LinuxUpgradeTransaction.apply(files, listOf("rootfs"), ::prepare, {}); fail() } catch (_: IllegalArgumentException) {}
    assertEquals("old-rootfs", File(files, "linux/rootfs/value").readText())
  }
}
