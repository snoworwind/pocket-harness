package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Historical baseline identity retained; all 65 cases now test Linux component transactions. */
@RunWith(Parameterized::class)
class SnapshotTransactionTest(private val checkpoint: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters(name = "{0}") fun points() = listOf(
      "journal-prepared", "prepared", "probed", "journal-upgrade", "backed-up:node", "activated:node",
      "backed-up:engine", "activated:engine", "backed-up:instance.json", "activated:instance.json",
      "committed", "cleanup", "recovered",
    ).map { arrayOf(it) }
  }
  private fun interrupted(check: (File, String) -> Unit) = LinuxInstallerFixture().use { fixture ->
    fixture.install()
    val files = fixture.files
    File(files, "linux/rootfs/usr/bin/user-apt").writeText("apt-user-package")
    File(files, "home/.local/bin").mkdirs()
    File(files, "home/.local/bin/user-global").writeText("user-command")
    try {
      LinuxUpgradeTransaction.apply(files, listOf("node", "engine", "instance.json"), prepare = { stage ->
        File(stage, "node/bin").mkdirs(); File(stage, "node/bin/node").writeText("replacement-node")
        File(stage, "engine").mkdirs(); File(stage, "engine/entry").writeText("replacement-engine")
        File(stage, "instance.json").writeText("replacement-manifest")
      }, probe = {}, checkpoint = { if (it == checkpoint) throw AssertionError("process death") })
    } catch (_: AssertionError) { }
    LinuxUpgradeTransaction.recover(files)
    val state = if (checkpoint in listOf("committed", "cleanup", "recovered")) "new" else "old"
    check(files, state)
  }
  @Test fun nodeAndEngineNeverRemainHalfSwitched() = interrupted { files, state ->
    assertEquals(if (state == "new") "replacement-node" else "node-one", File(files, "linux/node/bin/node").readText())
    assertEquals(state == "new", File(files, "linux/engine/entry").exists())
  }
  @Test fun aptRootfsIsNeverPartOfTheSwap() = interrupted { files, _ -> assertEquals("apt-user-package", File(files, "linux/rootfs/usr/bin/user-apt").readText()) }
  @Test fun homeGlobalCommandsSurviveEveryInterruption() = interrupted { files, _ -> assertEquals("user-command", File(files, "home/.local/bin/user-global").readText()) }
  @Test fun secondRecoveryIsAnIdempotentNoOp() = interrupted { files, _ ->
    val before = LinuxFileTree.digest(File(files, "linux"))
    LinuxUpgradeTransaction.recover(files)
    assertEquals(before, LinuxFileTree.digest(File(files, "linux")))
    assertFalse(File(files, LinuxUpgradeTransaction.JOURNAL).exists())
  }
  @Test fun subsequentUpgradeCanCommitAfterRecovery() = interrupted { files, _ ->
    LinuxUpgradeTransaction.apply(files, listOf("instance.json"), { File(it, "instance.json").writeText("next") }, {})
    assertEquals("next", File(files, "linux/instance.json").readText())
    assertFalse(File(files, LinuxUpgradeTransaction.PREVIOUS).exists())
  }
}
