package com.snoworwind.pocketharness

import java.util.IdentityHashMap

/** Owns temporary accessibility handles and snapshot handles without relying on equals(). */
internal class AccessibilityNodeRecycler<T : Any>(
  private val recycleEnabled: Boolean,
  private val recycle: (T) -> Unit,
  private val onRecycleFailure: (Throwable) -> Unit = {},
) {
  companion object {
    /** AccessibilityNodeInfo.recycle() is deprecated and is a no-op on API 33+. */
    fun shouldRecycleAtApi(sdkInt: Int): Boolean = sdkInt < 33
  }

  private val lock = Any()
  private var generation = 0L
  private var closed = false
  private var activeLeases = 0
  private val persistent = IdentityHashMap<T, Long>()
  private val retired = IdentityHashMap<T, Boolean>()
  private val temporaryOwners = IdentityHashMap<T, Int>()
  private val owned = IdentityHashMap<T, Boolean>()

  inner class Lease internal constructor() {
    internal val temporary = IdentityHashMap<T, Boolean>()
    internal var released = false

    fun own(node: T?): T? {
      if (node == null) return null
      synchronized(lock) {
        check(!released) { "accessibility node lease is closed" }
        if (temporary.put(node, true) == null) {
          temporaryOwners[node] = (temporaryOwners[node] ?: 0) + 1
          owned[node] = true
        }
      }
      return node
    }

    /** Keep a node with the current snapshot generation instead of the request lease. */
    fun retain(node: T?) {
      if (node == null) return
      synchronized(lock) {
        check(!released) { "accessibility node lease is closed" }
        if (temporary.remove(node) != null) removeTemporaryOwnerLocked(node)
        retired.remove(node)
        owned[node] = true
        persistent[node] = generation
      }
    }

    fun close() = release(this)
  }

  fun openLease(): Lease? = synchronized(lock) {
    if (closed) return@synchronized null
    activeLeases++
    Lease()
  }

  /** A replaced snapshot remains alive through one subsequent generation. */
  fun advanceGeneration() {
    val ready = synchronized(lock) {
      if (closed) emptyList() else {
        generation++
        moveExpiredToRetiredLocked()
        collectRetiredLocked()
      }
    }
    recycleNodes(ready)
  }

  /** Invalidation makes every snapshot node stale, so it does not receive the grace generation. */
  fun retirePersistent() {
    val ready = synchronized(lock) {
      persistent.keys.toList().forEach { node ->
        persistent.remove(node)
        retired[node] = true
      }
      collectRetiredLocked()
    }
    recycleNodes(ready)
  }

  /** Stop accepting requests; an in-flight request keeps all of its handles until it returns. */
  fun close() {
    val ready = synchronized(lock) {
      closed = true
      if (activeLeases == 0) drainAllLocked() else emptyList()
    }
    recycleNodes(ready)
  }

  private fun release(lease: Lease) {
    val ready = synchronized(lock) {
      if (lease.released) return@synchronized emptyList()
      lease.released = true
      val temporaryReady = ArrayList<T>()
      lease.temporary.keys.toList().forEach { node ->
        removeTemporaryOwnerLocked(node)
        if ((temporaryOwners[node] ?: 0) == 0 && !persistent.containsKey(node) && !retired.containsKey(node)) {
          if (owned.remove(node) == true) temporaryReady += node
        }
      }
      lease.temporary.clear()
      activeLeases--
      val deferred = if (closed && activeLeases == 0) {
        drainAllLocked()
      } else if (activeLeases == 0) {
        moveExpiredToRetiredLocked()
        collectRetiredLocked()
      } else {
        emptyList()
      }
      temporaryReady + deferred
    }
    recycleNodes(ready)
  }

  private fun removeTemporaryOwnerLocked(node: T) {
    val count = temporaryOwners[node] ?: return
    if (count <= 1) temporaryOwners.remove(node) else temporaryOwners[node] = count - 1
  }

  private fun moveExpiredToRetiredLocked() {
    val expired = persistent.entries
      .filter { generation - it.value >= 2 }
      .map { it.key }
    expired.forEach { node ->
      persistent.remove(node)
      retired[node] = true
    }
  }

  private fun collectRetiredLocked(): List<T> {
    if (activeLeases > 0 || retired.isEmpty()) return emptyList()
    val ready = retired.keys.filter { (temporaryOwners[it] ?: 0) == 0 }
    ready.forEach { node ->
      retired.remove(node)
      owned.remove(node)
    }
    return ready
  }

  private fun drainAllLocked(): List<T> {
    val ready = owned.keys.toList()
    owned.clear()
    persistent.clear()
    retired.clear()
    temporaryOwners.clear()
    return ready
  }

  private fun recycleNodes(nodes: List<T>) {
    if (!recycleEnabled) return
    nodes.forEach { node ->
      try {
        recycle(node)
      } catch (failure: Throwable) {
        try {
          onRecycleFailure(failure)
        } catch (_: Throwable) {
          // A diagnostic failure must not prevent recycling the remaining nodes.
        }
      }
    }
  }
}
