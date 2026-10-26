package com.snoworwind.pocketharness

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleOutputBatcherTest {

  @Test
  fun `output is split on UTF8 byte limit without breaking code points`() {
    val batches = mutableListOf<String>()
    val batcher = ConsoleOutputBatcher(maxBytes = 4, flushIntervalMs = 1_000) { batches += it }
    try {
      batcher.append("a中bc")
      assertEquals(listOf("a中"), batches)
      batcher.close()
      assertEquals(listOf("a中", "bc"), batches)
      assertTrue(batches.all { it.toByteArray(Charsets.UTF_8).size <= 4 })
    } finally {
      batcher.close()
    }
  }

  @Test
  fun `short output flushes on idle deadline without waiting for newline`() {
    val batches = Collections.synchronizedList(mutableListOf<String>())
    val flushed = CountDownLatch(1)
    val batcher = ConsoleOutputBatcher(maxBytes = 64, flushIntervalMs = 25) {
      batches += it
      flushed.countDown()
    }
    try {
      batcher.append("prompt>")
      assertTrue("闲置到期必须主动投递", flushed.await(2, TimeUnit.SECONDS))
      assertEquals(listOf("prompt>"), batches.toList())
    } finally {
      batcher.close()
    }
  }

  @Test
  fun `close flushes the final tail once`() {
    val batches = mutableListOf<String>()
    val batcher = ConsoleOutputBatcher(maxBytes = 64, flushIntervalMs = 1_000) { batches += it }
    batcher.append("tail")
    batcher.close()
    batcher.close()
    assertEquals(listOf("tail"), batches)
  }
}
