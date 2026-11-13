package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Managed component repair replaces the retired fingerprint invalidation and whole-tree heal. */
class RuntimeTreeSelfHealTest {
  @Test fun missingNodeRepairsOnlyNode() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs/user-file").writeText("keep"); File(f.files, "linux/node").deleteRecursively()
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("keep", File(f.files, "linux/rootfs/user-file").readText())
  }
  @Test fun missingEngineRepairsOnlyEngine() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs/user-file").writeText("keep"); File(f.files, "linux/engine").deleteRecursively()
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("keep", File(f.files, "linux/rootfs/user-file").readText())
  }
  @Test fun sameManifestWithChangedBytesStillTriggersRepair() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/node/bin/node").writeText("poisoned")
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Ready)
    assertEquals("node-one", File(f.files, "linux/node/bin/node").readText())
  }
  @Test fun failedCandidateLeavesThePreviousNodeAndEngine() = LinuxInstallerFixture().use { f ->
    f.install(); f.trial = { _, _ -> error("candidate refused") }
    assertTrue(LinuxInstanceInstaller.ensure(f.source("two"), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertEquals("node-one", File(f.files, "linux/node/bin/node").readText())
  }
  @Test fun corruptManifestPreservesTheEntireRootfs() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs/user-file").writeText("keep"); File(f.files, "linux/instance.json").writeText("broken")
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertEquals("keep", File(f.files, "linux/rootfs/user-file").readText())
  }
  @Test fun missingRootfsCannotBeRecreatedByRetry() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs").deleteRecursively()
    assertTrue(LinuxInstanceInstaller.ensure(f.source(), f.files) is LinuxInstanceInstaller.Result.Failed)
    assertFalse(File(f.files, "linux/rootfs").exists())
  }
}
