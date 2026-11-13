package com.snoworwind.pocketharness

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Authenticated Linux archive and extracted-byte identities. */
class LinuxPayloadIdentityTest {
  private fun changed(source: LinuxInstanceInstaller.Source, update: (JSONObject) -> Unit) = source.copy(open = { path ->
    if (path == "linux/manifest.json") source.open(path).use { JSONObject(it.bufferedReader().readText()).also(update).toString().byteInputStream() } else source.open(path)
  })
  @Test fun missingArchiveDigestIsRejectedBeforeInstallation() = LinuxInstallerFixture().use { f ->
    val source = changed(f.source()) { it.remove("rootfsSha256") }
    assertTrue(LinuxInstanceInstaller.ensure(source, f.files) is LinuxInstanceInstaller.Result.Failed)
    assertFalse(File(f.files, "linux").exists())
  }
  @Test fun invalidDigestSyntaxIsRejectedBeforeInstallation() = LinuxInstallerFixture().use { f ->
    assertTrue(LinuxInstanceInstaller.ensure(changed(f.source()) { it.put("nodeSha256", "invalid") }, f.files) is LinuxInstanceInstaller.Result.Failed)
    assertFalse(File(f.files, "linux").exists())
  }
  @Test fun aPoisonedArchiveIsRejectedBeforeItsBytesAreDecoded() = LinuxInstallerFixture().use { f ->
    f.install(); val original = f.source("two")
    val poisoned = original.copy(open = { if (it == "linux/node.tar.xz") "not-xz".byteInputStream() else original.open(it) })
    val result = LinuxInstanceInstaller.ensure(poisoned, f.files)
    assertTrue((result as LinuxInstanceInstaller.Result.Failed).detail.contains("archive digest mismatch"))
    assertEquals("node-one", File(f.files, "linux/node/bin/node").readText())
  }
  @Test fun validArchiveWithWrongExtractedIdentityCannotCommit() = LinuxInstallerFixture().use { f ->
    f.install(); val source = changed(f.source("two")) { it.put("engineTreeSha256", "0".repeat(64)) }
    val result = LinuxInstanceInstaller.ensure(source, f.files)
    assertTrue((result as LinuxInstanceInstaller.Result.Failed).detail.contains("extracted tree digest mismatch"))
    assertEquals("engine-one", File(f.files, "linux/engine/@deepseek-ai/dsh/lib/bin.js").readText())
  }
  @Test fun editingBothDiskAndLocalManifestCannotOverrideTheApkIdentity() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/node/bin/node").writeText("user-poison")
    val record = File(f.files, "linux/instance.json")
    record.writeText(JSONObject(record.readText()).put("nodeTreeSha256", LinuxFileTree.digest(File(f.files, "linux/node"))).toString())
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("node-one", File(f.files, "linux/node/bin/node").readText())
  }
  @Test fun badHomeSeedCannotOverwriteExistingUserFiles() = LinuxInstallerFixture().use { f ->
    f.install(); val git = File(f.files, "home/.gitconfig").apply { writeText("user-git") }
    val source = changed(f.source("two")) { it.put("homeSha256", "0".repeat(64)) }
    assertTrue(LinuxInstanceInstaller.ensure(source, f.files) is LinuxInstanceInstaller.Result.Failed)
    assertEquals("user-git", git.readText())
  }
}
