package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.io.File

class AccessibilityNodeRecyclerTest {
  private class Node(val name: String)

  private fun recycler(
    enabled: Boolean = true,
    released: MutableList<Node> = mutableListOf(),
    failures: MutableList<Throwable> = mutableListOf(),
  ): AccessibilityNodeRecycler<Node> = AccessibilityNodeRecycler<Node>(
    enabled,
    { node -> released += node },
    { failure -> failures += failure },
  )

  @Test
  fun temporaryNodesAreReleasedWhenTheRequestEndsAndIdentityIsDeduplicated() {
    val released = mutableListOf<Node>()
    val owner = recycler(released = released)
    val node = Node("temporary")
    val lease = owner.openLease()!!

    lease.own(node)
    lease.own(node)
    lease.close()

    assertEquals(listOf(node), released)
  }

  @Test
  fun sharedTemporaryNodeWaitsForEveryLeaseAndIsReleasedOnce() {
    val released = mutableListOf<Node>()
    val owner = recycler(released = released)
    val node = Node("shared")
    val first = owner.openLease()!!
    val second = owner.openLease()!!

    first.own(node)
    second.own(node)
    first.close()
    assertTrue(released.isEmpty())
    second.close()

    assertEquals(listOf(node), released)
  }

  @Test
  fun retainedSnapshotNodesSurviveOneGenerationAndThenRecycle() {
    val released = mutableListOf<Node>()
    val owner = recycler(released = released)
    val node = Node("snapshot")
    owner.openLease()!!.also { it.own(node); it.retain(node); it.close() }

    owner.advanceGeneration()
    assertTrue(released.isEmpty())
    owner.advanceGeneration()
    assertEquals(listOf(node), released)
  }

  @Test
  fun invalidationRetiresSnapshotNodesAfterOutstandingRequestsFinish() {
    val released = mutableListOf<Node>()
    val owner = recycler(released = released)
    val node = Node("snapshot")
    val lease = owner.openLease()!!
    lease.own(node)
    lease.retain(node)

    owner.retirePersistent()
    assertTrue(released.isEmpty())
    lease.close()
    assertEquals(listOf(node), released)
  }

  @Test
  fun closeRejectsNewRequestsAndWaitsForAnInFlightRequestToReturn() {
    val released = mutableListOf<Node>()
    val owner = recycler(released = released)
    val node = Node("in-flight")
    val entered = CountDownLatch(1)
    val finishAction = CountDownLatch(1)
    val worker = Thread {
      val lease = owner.openLease()!!
      lease.own(node)
      lease.retain(node)
      entered.countDown()
      check(finishAction.await(2, TimeUnit.SECONDS))
      lease.close()
    }

    worker.start()
    assertTrue(entered.await(2, TimeUnit.SECONDS))
    owner.close()
    assertNull(owner.openLease())
    assertTrue("do not recycle a node while the request still uses it", released.isEmpty())

    finishAction.countDown()
    worker.join(2_000)
    assertFalse("request worker should finish", worker.isAlive)
    assertEquals(listOf(node), released)
  }

  @Test
  fun api32RecyclesAndApi33AndLaterDoNot() {
    assertTrue(AccessibilityNodeRecycler.shouldRecycleAtApi(32))
    assertFalse(AccessibilityNodeRecycler.shouldRecycleAtApi(33))
    assertFalse(AccessibilityNodeRecycler.shouldRecycleAtApi(36))

    val released = mutableListOf<Node>()
    val owner = AccessibilityNodeRecycler<Node>(
      AccessibilityNodeRecycler.shouldRecycleAtApi(33),
      { released += it },
    )
    val lease = owner.openLease()!!
    lease.own(Node("api33"))
    lease.close()

    assertTrue(released.isEmpty())
  }

  @Test
  fun recycleFailureIsLoggedAndDoesNotStopTheRestOfTheDrain() {
    val released = mutableListOf<Node>()
    val failures = mutableListOf<Throwable>()
    val owner = AccessibilityNodeRecycler<Node>(
      recycleEnabled = true,
      recycle = { node -> if (node.name == "bad") error("recycle failed") else released += node },
      onRecycleFailure = { failure -> failures += failure },
    )
    val lease = owner.openLease()!!
    lease.own(Node("bad"))
    val good = Node("good")
    lease.own(good)

    lease.close()

    assertEquals(listOf(good), released)
    assertEquals(1, failures.size)
  }

  @Test
  fun serviceRejectsSnapshotTargetsAfterInvalidationBeforeReturningThem() {
    val serviceFile = listOf(
      File("src/main/java/com/snoworwind/pocketharness/DeviceControlService.kt"),
      File("app/src/main/java/com/snoworwind/pocketharness/DeviceControlService.kt"),
    ).firstOrNull(File::isFile) ?: error("DeviceControlService.kt source was not found")
    val service = serviceFile.readText()
    val resolver = service.substringAfter("private fun resolveTarget(args: JSONObject)")
      .substringBefore("private fun nodeAtChildPath")

    assertTrue(resolver.contains("currentSnapshotForTargets()"))
    assertTrue(resolver.contains("snapshotStillCurrent(current)"))
    assertTrue(resolver.indexOf("snapshotStillCurrent(current)") > resolver.indexOf("nodeAtChildPath(row.childPath)"))
  }
}
