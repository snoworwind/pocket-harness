package com.snoworwind.pocketharness

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Journaled swaps of app-owned components. rootfs is deliberately excluded from upgrades. */
internal object LinuxUpgradeTransaction {
  const val JOURNAL = ".linux-upgrade.json"
  const val STAGE = ".linux-upgrade-stage"
  const val PREVIOUS = ".linux-upgrade-previous"
  private val allowed = setOf("node", "engine", "instance.json")

  data class Marker(val phase: String, val startedAt: Long = 0)

  fun readMarker(files: File): Marker? {
    for (name in listOf(JOURNAL, ".linux-reset.json")) {
      val file = File(files, name)
      if (file.isFile) {
        val record = JSONObject(file.readText())
        return Marker(record.getString("phase"), record.optLong("startedAt", 0))
      }
    }
    return if (LinuxInstanceInstaller.preparing) Marker("install", LinuxInstanceInstaller.preparationStartedAt) else null
  }

  internal fun atomicWrite(file: File, value: String) {
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, file.name + ".tmp")
    FileOutputStream(temp).use { stream -> stream.write(value.toByteArray()); stream.fd.sync() }
    if (!temp.renameTo(file)) throw IOException("cannot commit ${file.name}")
  }

  private fun remove(file: File) = SnapshotFs.deletePath(file)
  private fun move(from: File, to: File) {
    if (!from.renameTo(to)) throw IOException("cannot move ${from.name} to ${to.name}")
  }

  private const val RESET_JOURNAL = ".linux-reset.json"
  private const val RESET_PREVIOUS = ".linux-reset-previous"

  fun recoverReset(files: File) {
    val journal = File(files, RESET_JOURNAL)
    if (!journal.isFile) return
    val phase = JSONObject(journal.readText()).getString("phase")
    require(phase in listOf("prepare", "done")) { "unknown reset journal" }
    val previous = File(files, RESET_PREVIOUS)
    val root = File(files, LinuxInstanceInstaller.DIR_NAME)
    if (phase == "prepare" && SnapshotFs.exists(previous)) {
      remove(root)
      move(previous, root)
    }
    if (phase == "done") remove(previous)
    check(journal.delete()) { "cannot clear reset journal" }
  }

  fun reset(files: File, install: () -> LinuxInstanceInstaller.Result): LinuxInstanceInstaller.Result {
    recoverReset(files)
    recover(files)
    val root = File(files, LinuxInstanceInstaller.DIR_NAME)
    if (!SnapshotFs.exists(root)) return install()
    val previous = File(files, RESET_PREVIOUS)
    require(!SnapshotFs.exists(previous)) { "unowned Linux reset residue" }
    val journal = File(files, RESET_JOURNAL)
    atomicWrite(journal, JSONObject().put("phase", "prepare").toString())
    return try {
      move(root, previous)
      val result = install()
      if (result is LinuxInstanceInstaller.Result.Ready) atomicWrite(journal, JSONObject().put("phase", "done").toString())
      recoverReset(files)
      result
    } catch (error: Exception) {
      try { recoverReset(files) } catch (failure: Exception) { error.addSuppressed(failure) }
      throw error
    }
  }

  /** Recovery is repeatable. An unfinished upgrade rolls back; a committed one only reclaims backups. */
  fun recover(files: File) {
    val journal = File(files, JOURNAL)
    if (!journal.exists()) return
    val record = JSONObject(journal.readText())
    require(record.getInt("schemaVersion") == 1) { "unknown Linux upgrade journal" }
    val names = record.getJSONArray("components")
    val had = record.getJSONObject("had")
    val phase = record.getString("phase")
    require(phase in setOf("prepare", "upgrade", "done")) { "unknown Linux upgrade phase" }
    val root = File(files, LinuxInstanceInstaller.DIR_NAME)
    val stage = File(files, STAGE)
    val previous = File(files, PREVIOUS)
    val components = (0 until names.length()).map { names.getString(it) }
    require(components.isNotEmpty() && components.distinct().size == components.size && components.all { it in allowed })
    if (phase == "upgrade") {
      for (name in components.asReversed()) {
        val backup = File(previous, name)
        val target = File(root, name)
        if (SnapshotFs.exists(backup)) {
          remove(target)
          move(backup, target)
        } else if (!had.getBoolean(name) && !SnapshotFs.exists(File(stage, name))) {
          remove(target)
        } else if (had.getBoolean(name) && !SnapshotFs.exists(target)) {
          throw IOException("Linux rollback source missing: $name")
        }
      }
    }
    remove(stage)
    remove(previous)
    if (!journal.delete()) throw IOException("cannot clear Linux upgrade journal")
  }

  /** prepare/probe run without changing live components. Fault callback exercises actual interruption points. */
  fun apply(
    files: File,
    components: List<String>,
    prepare: (File) -> Unit,
    probe: (File) -> Unit,
    checkpoint: (String) -> Unit = {},
  ) {
    require(components.isNotEmpty() && components.distinct().size == components.size && components.all { it in allowed })
    recover(files)
    val root = File(files, LinuxInstanceInstaller.DIR_NAME)
    val stage = File(files, STAGE)
    val previous = File(files, PREVIOUS)
    require(!SnapshotFs.exists(stage) && !SnapshotFs.exists(previous)) { "unowned Linux upgrade residue" }
    val had = JSONObject()
    components.forEach { had.put(it, SnapshotFs.exists(File(root, it))) }
    val record = JSONObject().put("schemaVersion", 1).put("phase", "prepare")
      .put("components", JSONArray(components)).put("had", had).put("startedAt", System.currentTimeMillis())
    val journal = File(files, JOURNAL)
    atomicWrite(journal, record.toString())
    checkpoint("journal-prepared")
    try {
      stage.mkdirs()
      prepare(stage)
      components.forEach { require(SnapshotFs.exists(File(stage, it))) { "missing staged component: $it" } }
      checkpoint("prepared")
      probe(stage)
      checkpoint("probed")
      previous.mkdirs()
      atomicWrite(journal, record.put("phase", "upgrade").toString())
      checkpoint("journal-upgrade")
      for (name in components) {
        val target = File(root, name)
        if (had.getBoolean(name)) move(target, File(previous, name))
        checkpoint("backed-up:$name")
        move(File(stage, name), target)
        checkpoint("activated:$name")
      }
      atomicWrite(journal, record.put("phase", "done").toString())
      checkpoint("committed")
      checkpoint("cleanup")
      recover(files)
      checkpoint("recovered")
    } catch (error: Exception) {
      try { recover(files) } catch (recovery: Exception) { error.addSuppressed(recovery) }
      throw error
    }
  }
}
