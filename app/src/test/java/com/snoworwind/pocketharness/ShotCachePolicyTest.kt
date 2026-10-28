package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShotCachePolicyTest {
  private fun tempDir(): File = Files.createTempDirectory("shot-cache-test").toFile()

  private fun shot(dir: File, name: String, bytes: Int, mtimeMs: Long): File {
    val file = File(dir, ShotCachePolicy.PREFIX + name + ShotCachePolicy.SUFFIX)
    file.writeBytes(ByteArray(bytes))
    assertTrue("test mtime should be set", file.setLastModified(mtimeMs))
    return file
  }

  @Test
  fun removesExpiredShotsAndKeepsFreshOnes() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val old = shot(dir, "old", 16, now - ShotCachePolicy.DEFAULT_TTL_MS - 1)
      val fresh = shot(dir, "fresh", 16, now - 1)
      assertEquals(1, ShotCachePolicy.prune(dir, nowMs = now))
      assertFalse(old.exists())
      assertTrue(fresh.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun countAndByteCapsRemoveOldestFirst() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val files = (1..5).map { i -> shot(dir, "count-$i", 100, now - (10L - i) * 1000) }
      assertEquals(2, ShotCachePolicy.prune(dir, nowMs = now, maxFiles = 3))
      assertFalse(files[0].exists())
      assertFalse(files[1].exists())
      assertTrue(files.drop(2).all(File::exists))
    } finally {
      dir.deleteRecursively()
    }

    val bytesDir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val files = (1..4).map { i -> shot(bytesDir, "bytes-$i", 100, now - (10L - i) * 1000) }
      assertEquals(2, ShotCachePolicy.prune(bytesDir, nowMs = now, maxBytes = 250))
      assertFalse(files[0].exists())
      assertFalse(files[1].exists())
      assertTrue(files.drop(2).all(File::exists))
    } finally {
      bytesDir.deleteRecursively()
    }
  }

  @Test
  fun publishKeepsCurrentCaptureButRejectsOversizedCapture() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val old = shot(dir, "old", 100, now - 2)
      val current = shot(dir, "current", 100, now)
      assertTrue(ShotCachePolicy.prunePublished(dir, current, nowMs = now, maxFiles = 1, maxBytes = 100))
      assertFalse(old.exists())
      assertTrue(current.isFile)
      assertEquals(listOf(current), dir.listFiles()!!.toList())

      val tooLarge = shot(dir, "large", 101, now)
      assertFalse(ShotCachePolicy.prunePublished(dir, tooLarge, nowMs = now, maxFiles = 1, maxBytes = 100))
      assertFalse(tooLarge.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun ignoresForeignNamesAndDirectories() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val old = shot(dir, "managed", 16, now - ShotCachePolicy.DEFAULT_TTL_MS - 1)
      val foreign = File(dir, "engine-output.png").apply { writeBytes(ByteArray(16)) }
      val wrongSuffix = File(dir, "browser-shot-other.txt").apply { writeBytes(ByteArray(16)) }
      val directory = File(dir, "browser-shot-dir.png").apply { mkdirs() }

      assertEquals(1, ShotCachePolicy.prune(dir, nowMs = now))
      assertFalse(old.exists())
      assertTrue(foreign.exists())
      assertTrue(wrongSuffix.exists())
      assertTrue(directory.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun browserHostChecksEncodingAndPublishesWithinTheCachePolicy() {
    val sourceFile = listOf(
      File("src/main/java/com/snoworwind/pocketharness/BrowserHost.kt"),
      File("app/src/main/java/com/snoworwind/pocketharness/BrowserHost.kt"),
    ).firstOrNull(File::isFile) ?: error("BrowserHost.kt source was not found")
    val source = sourceFile.readText()
    val shotOp = source.substringAfter("private fun shotOp(").substringBefore("// ── async plumbing")
    assertTrue(shotOp.contains("if (!encoded)"))
    assertTrue(shotOp.contains("ShotCachePolicy.prunePublished(dir, file)"))
    assertTrue(shotOp.contains("capture?.delete()"))
    assertTrue(source.contains("private fun shotDir()"))
    assertFalse(source.contains("工具层读完即删"))
  }
}
