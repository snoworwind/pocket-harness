package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Issue #322: the switch file may only carry the two reviewed PRoot diagnostics keys. */
class ProotSwitchFileTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test fun readsOnlyReviewedKeysAndIgnoresNoise() {
    val file = temporary.newFile("proot-env")
    file.writeText(
      """
      # comment
      PROOT_POCKET_TRACE_WAIT=1

      PROOT_POCKET_RESUME_SILENT_CHILD=1
      PROOT_NO_SECCOMP=0
      LD_PRELOAD=/data/local/tmp/evil.so
      PROOT_POCKET_TRACE_WAIT=
      """.trimIndent(),
    )
    assertEquals(
      mapOf("PROOT_POCKET_TRACE_WAIT" to "1", "PROOT_POCKET_RESUME_SILENT_CHILD" to "1"),
      LinuxGuestBoot.prootEnvOverrides(file),
    )
  }

  @Test fun refusesMissingSymlinkAndOversizedFixtures() {
    assertTrue(LinuxGuestBoot.prootEnvOverrides(File(temporary.root, "missing")).isEmpty())
    val target = temporary.newFile("target").apply { writeText("PROOT_POCKET_TRACE_WAIT=1") }
    val link = File(temporary.root, "link")
    java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
    assertTrue(LinuxGuestBoot.prootEnvOverrides(link).isEmpty())
    val huge = temporary.newFile("huge").apply { writeText("PROOT_POCKET_TRACE_WAIT=1\n".repeat(400)) }
    assertTrue(LinuxGuestBoot.prootEnvOverrides(huge).isEmpty())
  }

  @Test fun rejectsWhitespaceValues() {
    val file = temporary.newFile("proot-env")
    file.writeText("PROOT_POCKET_TRACE_WAIT=1 2\n")
    assertTrue(LinuxGuestBoot.prootEnvOverrides(file).isEmpty())
  }
}
