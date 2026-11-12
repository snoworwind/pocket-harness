package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Baseline identity retained for the primary Linux instance's actual disk integrity. */
class RuntimeTreeTest {
  @Test fun verifiedInstanceCanOpen() = LinuxInstallerFixture().use { f -> f.install(); assertTrue(LinuxInstanceInstaller.open(f.files) is LinuxInstanceInstaller.Result.Ready) }
  @Test fun nodeTamperingCannotExecuteSilently() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/node/bin/node").writeText("tampered")
    assertEquals("linux-managed-tree-corrupt", (LinuxInstanceInstaller.open(f.files) as LinuxInstanceInstaller.Result.Failed).code)
  }
  @Test fun engineTamperingCannotExecuteSilently() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/engine/@deepseek-ai/dsh/lib/bin.js").writeText("tampered")
    assertEquals("linux-managed-tree-corrupt", (LinuxInstanceInstaller.open(f.files) as LinuxInstanceInstaller.Result.Failed).code)
  }
  @Test fun extraManagedFilesInvalidateTheTree() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/engine/extra.node").writeText("extra")
    assertTrue(LinuxInstanceInstaller.open(f.files) is LinuxInstanceInstaller.Result.Failed)
  }
  @Test fun brokenSymlinkStillChangesTheDigest() = LinuxInstallerFixture().use { f ->
    f.install(); java.nio.file.Files.createSymbolicLink(File(f.files, "linux/node/extra").toPath(), java.nio.file.Paths.get("missing"))
    assertTrue(LinuxInstanceInstaller.open(f.files) is LinuxInstanceInstaller.Result.Failed)
  }
  @Test fun aptChangesDoNotInvalidateManagedComponents() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs/usr/bin/jq").writeText("user-apt-jq")
    assertTrue(LinuxInstanceInstaller.open(f.files) is LinuxInstanceInstaller.Result.Ready)
  }
  @Test fun missingRootfsNeverAuthorizesAReplacement() = LinuxInstallerFixture().use { f ->
    f.install(); File(f.files, "linux/rootfs").deleteRecursively()
    assertEquals("linux-reset-required", LinuxInstanceInstaller.inspectExisting(f.files)?.code)
  }
}
