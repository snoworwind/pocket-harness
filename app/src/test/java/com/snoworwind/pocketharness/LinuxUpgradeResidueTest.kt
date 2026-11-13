package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Residue and malformed-journal negatives apply to Linux swaps; no legacy snapshot engine is compiled. */
@RunWith(Parameterized::class)
class LinuxUpgradeResidueTest(private val scenario: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters(name = "{0}") fun cases() = listOf(
      "unowned-stage", "unowned-previous", "corrupt-journal", "unknown-phase", "unknown-component", "duplicate-component",
      "rootfs-component", "prepare-missing-file", "probe-rejected", "stage-symlink", "previous-symlink", "rollback-source-missing",
    ).map { arrayOf(it) }
  }
  @Test fun invalidResidueNeverDestroysLiveComponentsOrUserRootfs() = LinuxInstallerFixture().use { f ->
    f.install(); val root = File(f.files, "linux")
    val before = LinuxFileTree.digest(root)
    val external = File(f.files, "external").apply { mkdirs() }; File(external, "user").writeText("keep")
    val journal = File(f.files, LinuxUpgradeTransaction.JOURNAL)
    val record = JSONObject().put("schemaVersion", 1).put("phase", "upgrade").put("components", org.json.JSONArray(listOf("node"))).put("had", JSONObject().put("node", true))
    var components = listOf("node")
    when (scenario) {
      "unowned-stage" -> File(f.files, LinuxUpgradeTransaction.STAGE).mkdirs()
      "unowned-previous" -> File(f.files, LinuxUpgradeTransaction.PREVIOUS).mkdirs()
      "corrupt-journal" -> journal.writeText("broken")
      "unknown-phase" -> journal.writeText(record.put("phase", "unknown").toString())
      "unknown-component" -> components = listOf("../home")
      "duplicate-component" -> components = listOf("node", "node")
      "rootfs-component" -> components = listOf("rootfs")
      "stage-symlink" -> Files.createSymbolicLink(File(f.files, LinuxUpgradeTransaction.STAGE).toPath(), external.toPath())
      "previous-symlink" -> Files.createSymbolicLink(File(f.files, LinuxUpgradeTransaction.PREVIOUS).toPath(), external.toPath())
      "rollback-source-missing" -> { journal.writeText(record.toString()); File(root, "node").deleteRecursively() }
    }
    var rejected = false
    try {
      LinuxUpgradeTransaction.apply(f.files, components, { stage ->
        if (scenario != "prepare-missing-file") { File(stage, "node").mkdirs(); File(stage, "node/new").writeText("new") }
      }, { if (scenario == "probe-rejected") error("bad candidate") })
    } catch (_: Exception) { rejected = true }
    assertTrue(scenario, rejected)
    if (scenario != "rollback-source-missing") assertEquals(scenario, before, LinuxFileTree.digest(root))
    assertEquals("keep", File(external, "user").readText())
  }
}
