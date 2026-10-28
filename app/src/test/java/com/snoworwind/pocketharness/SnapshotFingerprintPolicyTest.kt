package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotFingerprintPolicyTest {
  private val sha = "0123456789abcdef".repeat(4)
  private fun source(name: String): String = listOf(
    java.io.File("src/main/java/com/snoworwind/pocketharness", name),
    java.io.File("app/src/main/java/com/snoworwind/pocketharness", name),
  ).first { it.isFile }.readText()

  @Test fun missingShaNeverMakesAnExistingRuntimeFresh() {
    for (raw in listOf(null, "", "  \n")) {
      val bundled = SnapshotFingerprintPolicy.read(raw)
      assertEquals("snapshot-bundled-sha-missing", bundled.failureCode)
      assertNull(bundled.fingerprint)
      assertFalse(SnapshotFingerprintPolicy.fresh(true, bundled, sha))
      assertFalse(SnapshotFingerprintPolicy.fresh(true, bundled, ""))
    }
  }

  @Test fun malformedShaCannotBecomeTheTransactionFingerprint() {
    for (raw in listOf("not-a-hash", "g".repeat(64), sha.dropLast(1), sha + "  snapshot.tar.xz", sha + "\n" + sha)) {
      val bundled = SnapshotFingerprintPolicy.read(raw)
      assertEquals("snapshot-bundled-sha-invalid", bundled.failureCode)
      assertNull(bundled.fingerprint)
      assertFalse(SnapshotFingerprintPolicy.fresh(true, bundled, raw))
    }
  }

  @Test fun validShaNeedsBothNodeAndTheMatchingDurableCommit() {
    val bundled = SnapshotFingerprintPolicy.read("  " + sha.uppercase() + "\n")
    assertNull(bundled.failureCode)
    assertEquals(sha, bundled.fingerprint)
    assertTrue(SnapshotFingerprintPolicy.fresh(true, bundled, sha))
    assertTrue(SnapshotFingerprintPolicy.fresh(true, bundled, sha.uppercase() + "\n"))
    assertFalse(SnapshotFingerprintPolicy.fresh(false, bundled, sha))
    assertFalse(SnapshotFingerprintPolicy.fresh(true, bundled, null))
    assertFalse(SnapshotFingerprintPolicy.fresh(true, bundled, "f".repeat(64)))
  }

  @Test fun failedFingerprintCommitPublicationPreservesThePreviousCommitPoint() {
    val files = java.nio.file.Files.createTempDirectory("snapshot-fingerprint-commit-").toFile()
    try {
      val marker = java.io.File(files, ".snapshot-fingerprint").apply { writeText("old-fingerprint") }
      val failure = try {
        SnapshotTransaction.writeTextAtomic(
          target = marker,
          text = "new-fingerprint",
          label = "snapshot fingerprint",
          publish = { _, _ -> false },
          validate = {},
        )
        null
      } catch (t: SnapshotFsException) {
        t
      }
      assertEquals("snapshot-atomic-write", failure?.code)
      assertEquals("old-fingerprint", marker.readText())
      val evidence = files.listFiles()!!.filter { it.name.startsWith(".pre-.snapshot-fingerprint-") }
      assertEquals(1, evidence.size)
      assertEquals("old-fingerprint", evidence.single().readText())

      val manager = source("EngineManager.kt")
      val commit = manager.substringAfter("private fun writeFingerprint(").substringBefore("private fun writeOnlineSnapshotIdentity(")
      assertTrue("生产快照指纹必须走失败保全写入器", commit.contains("SnapshotTransaction.writeTextAtomic("))
      assertFalse("发布失败不能先删旧指纹", commit.contains("deletePath(target)"))
      assertFalse("发布失败不能直写截断旧指纹", commit.contains("target.writeText("))
    } finally {
      SnapshotFs.deletePath(files)
    }
  }

  @Test fun onlineSnapshotStaysFreshOnlyForTheSameEmbeddedBaseAndCommittedArchive() {
    val archive = "fedcba9876543210".repeat(4)
    assertTrue(SnapshotFingerprintPolicy.onlineFresh(true, sha, archive, sha, archive))
    assertTrue(SnapshotFingerprintPolicy.onlineFresh(true, sha.uppercase(), archive.uppercase(), sha, archive))
    assertFalse(SnapshotFingerprintPolicy.onlineFresh(false, sha, archive, sha, archive))
    assertFalse(SnapshotFingerprintPolicy.onlineFresh(true, "f".repeat(64), archive, sha, archive))
    assertFalse(SnapshotFingerprintPolicy.onlineFresh(true, sha, "0".repeat(64), sha, archive))
    assertFalse(SnapshotFingerprintPolicy.onlineFresh(true, sha, archive, "bad", archive))
  }

  @Test fun invalidBundledMetadataHasNoLegacyFreshnessOrDegradedStartupBypass() {
    val manager = source("EngineManager.kt")
    assertTrue(manager.contains("fun snapshotFresh(): Boolean {"))
    assertTrue(manager.contains("SnapshotFingerprintPolicy.fresh(nodeBin.exists(), bundledSnapshotFingerprint, committed)"))
    assertTrue(manager.contains("SnapshotFingerprintPolicy.onlineFresh("))
    assertTrue(manager.contains("fun shouldDegradeRefresh(): Boolean = bundledSnapshotFingerprint.fingerprint != null"))
    assertFalse(manager.contains("if (fp.isEmpty()) return true"))
    val refresh = manager.substringAfter("fun refreshSnapshot(").substringBefore("private fun refreshSnapshotInternal(")
    assertTrue(refresh.contains("snapshotFingerprintProblem()"))
    assertTrue(refresh.contains("refreshSnapshotInternal(onProgress"))
    assertTrue(refresh.indexOf("snapshotFingerprintProblem()") < refresh.indexOf("refreshSnapshotInternal(onProgress"))
    assertTrue(refresh.contains("lastRefreshFailureCode = problem.failureCode"))
    val spawn = manager.substringAfter("fun startEngine(").substringBefore("private fun ")
    assertTrue(spawn.contains("snapshotFingerprintProblem()"))
    assertTrue(spawn.indexOf("snapshotFingerprintProblem()") < spawn.indexOf("snapshotRefreshing.get()"))
    val presentation = source("MainActivity.kt").substringAfter("internal fun showWeb()").substringBefore("internal fun reloadEnginePage()")
    assertTrue(presentation.contains("engineManager.snapshotFingerprintProblem() != null"))
  }
}
