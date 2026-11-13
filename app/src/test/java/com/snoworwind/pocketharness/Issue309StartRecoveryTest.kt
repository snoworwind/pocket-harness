package com.snoworwind.pocketharness

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Each former automatic-heal case now exercises the actual Linux repair boundary. */
@RunWith(Parameterized::class)
class Issue309StartRecoveryTest(private val scenario: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters(name = "{0}") fun cases() = (
      listOf("node", "engine").flatMap { component -> listOf("missing", "tampered", "extra", "symlink").map { "$component:$it" } } +
      listOf("rootfs-missing", "record-missing", "record-malformed", "schema-unknown", "base-incompatible", "node-archive-corrupt", "engine-archive-corrupt", "node-tree-mismatch", "engine-tree-mismatch", "trial-rejected", "asset-schema-unknown")
    ).map { arrayOf(it) }
  }
  @Test fun repairNeverUsesAWholeRootfsReplacement() = LinuxInstallerFixture().use { f ->
    f.install()
    val sentinel = File(f.files, "home/user-proof").apply { writeText("user-data") }
    val apt = File(f.files, "linux/rootfs/user-apt").apply { writeText("apt-data") }
    var source = f.source()
    val repair = ':' in scenario
    if (repair) {
      val (component, damage) = scenario.split(':')
      val root = File(f.files, "linux/$component")
      when (damage) {
        "missing" -> root.deleteRecursively()
        "tampered" -> File(root, if (component == "node") "bin/node" else "@deepseek-ai/dsh/lib/bin.js").writeText("bad")
        "extra" -> File(root, "unknown.node").writeText("bad")
        "symlink" -> java.nio.file.Files.createSymbolicLink(File(root, "unknown").toPath(), java.nio.file.Paths.get("missing"))
      }
    } else when (scenario) {
      "rootfs-missing" -> File(f.files, "linux/rootfs").deleteRecursively()
      "record-missing" -> File(f.files, "linux/instance.json").delete()
      "record-malformed" -> File(f.files, "linux/instance.json").writeText("broken")
      "schema-unknown" -> { val file = File(f.files, "linux/instance.json"); file.writeText(JSONObject(file.readText()).put("schemaVersion", 99).toString()) }
      "base-incompatible" -> source = mutate(source) { it.put("baseId", "debian-next-arm64") }
      "asset-schema-unknown" -> source = mutate(source) { it.put("schemaVersion", 99) }
      "trial-rejected" -> { source = f.source("two"); f.trial = { _, _ -> error("not healthy") } }
      "node-tree-mismatch", "engine-tree-mismatch" -> { val component = scenario.substringBefore('-'); source = mutate(source) { it.put(component + "TreeSha256", "0".repeat(64)) } }
      "node-archive-corrupt", "engine-archive-corrupt" -> {
        val component = scenario.substringBefore('-'); val original = f.source("two")
        source = original.copy(open = { path -> if (path == "linux/$component.tar.xz") "poisoned".byteInputStream() else original.open(path) })
      }
    }
    val result = LinuxInstanceInstaller.ensure(source, f.files)
    assertEquals(result.toString(), repair, result is LinuxInstanceInstaller.Result.Ready)
    assertEquals("user-data", sentinel.readText())
    if (scenario != "rootfs-missing") assertEquals("apt-data", apt.readText())
    else assertFalse(File(f.files, "linux/rootfs").exists())
  }
  private fun mutate(source: LinuxInstanceInstaller.Source, change: (JSONObject) -> Unit) = source.copy(open = { path ->
    if (path != "linux/manifest.json") source.open(path)
    else source.open(path).use { input -> JSONObject(input.bufferedReader().readText()).also(change).toString().byteInputStream() }
  })
}
