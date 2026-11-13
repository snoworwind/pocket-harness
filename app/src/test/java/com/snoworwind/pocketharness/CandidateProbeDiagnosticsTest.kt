package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A failed install trial must report why, not just "glibc does not satisfy". */
class CandidateProbeDiagnosticsTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test fun reportsExitCodeAndLastOutputLine() {
    val message = LinuxCandidateProbe.candidateFailure("glibc", 182, "noise\n[proot-loader] site=46 status=2\n", "2.41")
    assertEquals("guest glibc preflight failed: exit=182 expected=2.41 output=[proot-loader] site=46 status=2", message)
  }

  @Test fun emptyOutputAndControlCharactersStaySingleLine() {
    val message = LinuxCandidateProbe.candidateFailure("node", 7, "   ", "0")
    assertTrue(message.endsWith("output=<empty>"))
    assertEquals(1, LinuxCandidateProbe.candidateFailure("node", 1, "a\u0000b\nc", "0").lines().size)
  }

  @Test fun detailIsBounded() {
    val message = LinuxCandidateProbe.candidateFailure("glibc", 1, "x".repeat(5000), "2.41")
    assertTrue(message.length < 400)
  }

  @Test fun diagnosticBundleIncludesTheTrialFailureLog() {
    val files = LogShare.candidateFiles(temporary.newFolder("files")).map { it.name }
    assertTrue(files.contains("linux-trial-failed.log"))
    assertTrue(files.contains("engine.log"))
  }
}
