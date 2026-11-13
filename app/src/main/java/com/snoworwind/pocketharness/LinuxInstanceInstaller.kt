package com.snoworwind.pocketharness

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * 把随 APK 内置的 Linux 资产落地成可启动的 PRoot 实例。
 *
 * 为什么由壳侧做：引擎一旦必须跑在客体里，“装 Linux”就不能再依赖引擎自己的插件（鸡生蛋）。
 * 三个资产（rootfs / node / engine）在来源链构建时固定并带摘要，这里只做解包与原子替换，
 * 不联网、不读 Termux、不接受任意路径。
 */
internal object LinuxInstanceInstaller {
  const val DIR_NAME = "linux"
  const val STAGE_NAME = ".linux-stage"
  const val MANIFEST_NAME = "instance.json"
  private const val SCHEMA = 1
  private const val ASSET_ROOT = "linux"

  private val preparationDepth = java.util.concurrent.atomic.AtomicInteger(0)
  val preparing: Boolean get() = preparationDepth.get() > 0
  @Volatile var preparationStartedAt: Long = 0
    private set

  data class Instance(val root: File, val rootfs: File, val node: File, val engine: File)

  internal data class Source(
    val open: (String) -> InputStream,
    val trial: (Instance, JSONObject, (String) -> Unit) -> Unit,
  )

  private fun source(context: Context) = Source(
    open = { context.assets.open(it) },
    trial = { instance, manifest, progress -> LinuxCandidateProbe.verify(context, instance, manifest, progress) },
  )

  /** 覆盖更新只动应用管理的运行时；基础镜像（rootfs）永远不替换。 */
  data class UpdatePlan(val replaceNode: Boolean, val replaceEngine: Boolean) {
    /** 判据字段：任何情况下都不得为 true。 */
    val replaceRootfs: Boolean get() = false
  }

  fun planUpdate(currentNode: String?, currentEngine: String?, assetNode: String?, assetEngine: String?): UpdatePlan =
    UpdatePlan(
      replaceNode = currentNode != assetNode,
      replaceEngine = currentEngine != assetEngine,
    )

  sealed class Result {
    data class Ready(val instance: Instance) : Result()
    data class Failed(val code: String, val detail: String) : Result()
  }

  fun instanceRoot(filesDir: File): File = File(filesDir, DIR_NAME)

  /** APK 是否内置了 Linux 资产（ARM64 产品包为真；x86_64 QA 包为假）。 */
  fun bundled(context: Context): Boolean = try {
    context.assets.open("$ASSET_ROOT/manifest.json").use { true }
  } catch (_: Exception) {
    false
  }

  /** 已安装且清单自洽；只做结构检查，摘要由来源链与安装时的资产摘要共同保证。 */
  fun open(filesDir: File, verifyManaged: Boolean = true): Result {
    val root = instanceRoot(filesDir)
    val manifest = File(root, MANIFEST_NAME)
    if (java.nio.file.Files.isSymbolicLink(root.toPath()) || !root.isDirectory || !manifest.isFile) {
      return Result.Failed("linux-instance-missing", "未安装内置 Linux 实例")
    }
    val record = try {
      JSONObject(manifest.readText())
    } catch (error: Exception) {
      return Result.Failed("linux-instance-corrupt", "实例清单无法解析：${error.message}")
    }
    if (record.optInt("schemaVersion", -1) != SCHEMA) {
      return Result.Failed("linux-instance-corrupt", "实例清单 schemaVersion 不是 $SCHEMA")
    }
    val instance = Instance(
      root = root,
      rootfs = File(root, "rootfs"),
      node = File(root, "node/bin/node"),
      engine = File(root, "engine"),
    )
    for ((file, code) in listOf(
      instance.rootfs to "linux-instance-incomplete",
      instance.node to "linux-instance-incomplete",
      File(instance.engine, LinuxGuestBoot.ENGINE_ENTRY) to "linux-instance-incomplete",
    )) {
      if (!file.exists()) return Result.Failed(code, "实例缺少 ${file.absolutePath}")
    }
    if (verifyManaged) for (name in listOf("node", "engine")) {
      val expected = record.optString(name + "TreeSha256")
      if (!expected.matches(Regex("[0-9a-f]{64}")) ||
        runCatching { LinuxFileTree.digest(File(root, name)) }.getOrNull() != expected) {
        return Result.Failed("linux-managed-tree-corrupt", "Linux $name 与安装包记录不一致，尚未执行；请重试以修复受管组件。")
      }
    }
    return Result.Ready(instance)
  }

  /**
   * Termux 式“只铺底、不替换”：
   *
   * - rootfs 只在**首次安装**时解压；APK 覆盖更新绝不替换它——用户 apt 装的软件、配置、
   *   源码都在里面，替换等于把用户资产清空。新基础镜像只对全新安装生效。
   * - node / engine 是应用管理的运行时（与用户数据无关），随 APK 更新替换。
   * - home 只在缺失时播种；之后只增不改。
   * - schemaVersion 变化时跑迁移脚本补齐必要文件，而不是重铺基础镜像。
   */
  @Synchronized
  fun ensure(context: Context, filesDir: File, onProgress: (String) -> Unit = {}): Result =
    ensure(source(context), filesDir, onProgress)

  @Synchronized
  internal fun ensure(source: Source, filesDir: File, onProgress: (String) -> Unit = {}): Result {
    if (preparationDepth.getAndIncrement() == 0) preparationStartedAt = System.currentTimeMillis()
    return try {
    LinuxUpgradeTransaction.recoverReset(filesDir)
    LinuxUpgradeTransaction.recover(filesDir)
    val asset = source.open("$ASSET_ROOT/manifest.json").use { JSONObject(it.readBytes().decodeToString()) }
    validateAssetRecord(asset)
    LinuxLegacyMigration.prepare(filesDir)
    val existing = inspectExisting(filesDir)
    if (existing != null) return existing
    if (!instanceRoot(filesDir).exists()) return installFresh(source, filesDir, onProgress)
    val root = instanceRoot(filesDir)
    val current = JSONObject(File(root, MANIFEST_NAME).readText())
    val base = current.optString("baseId")
    if (base.isNotEmpty() && base != asset.getString("baseId")) {
      return Result.Failed("linux-base-incompatible", "此版本需要不同的 Linux 基础层；现有 apt 软件已保留，请先导出备份后显式重置。")
    }
    if (base.isEmpty()) {
      val release = File(root, "rootfs/etc/os-release").readText()
      if (!Regex("(?m)^ID=\"?debian\"?$").containsMatchIn(release) ||
        !Regex("(?m)^VERSION_ID=\"?13\"?$").containsMatchIn(release)) {
        return Result.Failed("linux-base-unknown", "无法识别现有 Linux 基础层，保留现场；请导出备份后重置。")
      }
    }
    LinuxLegacyMigration.preserveNodeGlobals(filesDir)
    val repair = listOf("node", "engine").filter { name ->
      val expected = asset.getString(name + "TreeSha256")
      runCatching { LinuxFileTree.digest(File(root, name)) }.getOrNull() != expected ||
        current.optString(name + "Sha256") != asset.getString(name + "Sha256")
    }
    seedHome(source, filesDir, asset, onProgress)
    val seedChanged = current.optString("homeSha256") != asset.getString("homeSha256") || current.optInt("homeSchemaVersion", 1) != asset.getInt("homeSchemaVersion")
    if (repair.isNotEmpty() || base.isEmpty() || seedChanged || LinuxLegacyMigration.pending(filesDir)) {
      val updated = JSONObject(current.toString())
      for (key in listOf("nodeSha256", "engineSha256", "nodeTreeSha256", "engineTreeSha256", "baseId", "minimumGlibc", "guestArchitecture", "homeSha256", "homeSchemaVersion")) updated.put(key, asset.get(key))
      LinuxUpgradeTransaction.apply(filesDir, repair + MANIFEST_NAME,
        prepare = { stage ->
          for (name in repair) { onProgress("准备 Linux $name…"); extractVerified(source, asset, name, File(stage, name), onProgress) }
          File(stage, MANIFEST_NAME).writeText(updated.toString(2))
        },
        probe = { stage ->
          val candidate = Instance(root,
            File(root, "rootfs"),
            File(if ("node" in repair) stage else root, "node/bin/node"),
            File(if ("engine" in repair) stage else root, "engine"))
          source.trial(candidate, asset, onProgress)
        },
      )
    }
    seedHome(source, filesDir, asset, onProgress)
    LinuxLegacyMigration.commit(filesDir)
    open(filesDir)
  } catch (error: Exception) {
    Result.Failed("linux-prepare-failed", error.message ?: error.javaClass.simpleName)
  } finally { preparationDepth.decrementAndGet() }

  }

  private fun validateAssetRecord(asset: JSONObject) {
    require(asset.getInt("schemaVersion") == SCHEMA) { "unsupported Linux asset schema" }
    require(asset.getString("guestArchitecture") == "arm64") { "unsupported Linux architecture" }
    require(asset.getString("baseId").matches(Regex("[a-z0-9][a-z0-9.-]{1,100}"))) { "invalid base identity" }
    for (key in listOf("rootfsSha256", "nodeSha256", "engineSha256", "homeSha256", "rootfsTreeSha256", "nodeTreeSha256", "engineTreeSha256")) {
      require(asset.getString(key).matches(Regex("[0-9a-f]{64}"))) { "invalid asset digest: $key" }
    }
    require(asset.getInt("homeSchemaVersion") in 1..2) { "unsupported home seed schema" }
  }

  /** Authenticate the compressed bytes before enabling guest absolute symlinks. */
  private fun extractVerified(source: Source, asset: JSONObject, name: String, target: File, progress: (String) -> Unit = {}) {
    val path = "$ASSET_ROOT/$name.tar.xz"
    val actual = SnapshotBundledAsset.digest({ source.open(path) }).hex
    require(actual == asset.getString(name + "Sha256")) { "Linux $name archive digest mismatch" }
    target.mkdirs()
    source.open(path).use { stream ->
      var lastBucket = -1L
      val total = asset.optLong(name + "UnpackedBytes", 0)
      SnapshotExtractor.extract(stream, total, target, { done, _ ->
        val bucket = done / (16L * 1024 * 1024)
        if (bucket != lastBucket) {
          lastBucket = bucket
          progress("$name 已解包 ${done / (1024 * 1024)} MB" + if (total > 0) " / ${total / (1024 * 1024)} MB" else "")
        }
      }, runtimeRoot = target, guestLinks = name in listOf("rootfs", "home"))
    }
    if (name in listOf("rootfs", "node", "engine")) {
      require(LinuxFileTree.digest(target) == asset.getString(name + "TreeSha256")) { "Linux $name extracted tree digest mismatch" }
    }
  }

  /** The seed schema controls additive migrations; existing entries always belong to the user. */
  private fun seedHome(source: Source, filesDir: File, asset: JSONObject, onProgress: (String) -> Unit) {
    val marker = File(filesDir, ".linux-home-seeded")
    val prior = if (marker.isFile) runCatching { JSONObject(marker.readText()) }.getOrNull() else null
    val priorSchema = prior?.optInt("schemaVersion", 1) ?: 1
    val nextSchema = asset.getInt("homeSchemaVersion")
    require(priorSchema <= nextSchema) { "home seed schema downgrade is unsupported; user data retained" }
    val priorDigest = prior?.optString("sha256") ?: marker.takeIf { it.isFile }?.readText()
    if (priorDigest == asset.getString("homeSha256") && priorSchema == nextSchema) return
    onProgress("补齐用户目录的缺失文件…")
    val stage = File(filesDir, ".linux-home-stage")
    SnapshotFs.deletePath(stage)
    try {
      extractVerified(source, asset, "home", stage)
      require(stage.listFiles().orEmpty().all { it.name == "home" }) { "home seed contains non-home paths" }
      LinuxFileTree.mergeHomeSeed(stage, filesDir)
      LinuxFileTree.migrateHomeShellIdentity(File(filesDir, "home"))
      // Schema 2 adds persistent package-manager homes; it never replaces user files.
      if (nextSchema >= 2) for (name in listOf(".local/bin", ".local/lib/node_modules", ".local/share/pnpm", ".local/share/corepack")) {
        LinuxFileTree.safeDirectory(File(filesDir, "home"), name)
      }
      LinuxUpgradeTransaction.atomicWrite(marker, JSONObject().put("schemaVersion", nextSchema).put("sha256", asset.getString("homeSha256")).toString())
    } finally { SnapshotFs.deletePath(stage) }
  }

  const val RESET_WARNING = "重置会删除 Linux 中用户 apt 安装的软件与配置；home 用户数据保留。请先导出备份。"
  const val RESET_CONFIRMATION = "DELETE_LINUX_APT_DATA"

  /** 存量树损坏时保留现场；只有受管组件缺件可以自动修复。 */
  internal fun inspectExisting(filesDir: File): Result.Failed? {
    val root = instanceRoot(filesDir)
    if (!SnapshotFs.exists(root)) return null
    if (java.nio.file.Files.isSymbolicLink(root.toPath()) || java.nio.file.Files.isSymbolicLink(File(root, "rootfs").toPath()) || !File(root, "rootfs").isDirectory) return Result.Failed("linux-reset-required", RESET_WARNING)
    val manifest = File(root, MANIFEST_NAME)
    val record = runCatching { JSONObject(manifest.readText()) }.getOrNull()
      ?: return Result.Failed("linux-instance-corrupt", "实例清单损坏，保留现有 Linux 数据；请导出后显式重置。")
    if (record.optInt("schemaVersion", -1) != SCHEMA) return Result.Failed("linux-schema-unsupported", "实例格式不受支持，现有数据未改动。")
    return null
  }

  internal fun guestProcessesStopped(): Boolean = try {
    val uid = android.system.Os.getuid()
    val processes = File("/proc").listFiles() ?: return false
    processes.filter { it.name.toIntOrNull() != null }.none { process ->
      val owned = runCatching { android.system.Os.stat(process.absolutePath).st_uid == uid }.getOrDefault(false)
      owned && runCatching {
        File(process, "cmdline").readText().contains("libpocketharness_proot.so")
      }.getOrDefault(true)
    }
  } catch (_: Exception) { false }

  /** 仅由明确确认的用户操作调用；调用方须先停止客体进程。 */
  @Synchronized
  fun reset(context: Context, filesDir: File, confirmation: String, stopped: Boolean): Result {
    if (confirmation != RESET_CONFIRMATION) return Result.Failed("linux-reset-confirmation-required", RESET_WARNING)
    if (!stopped || !guestProcessesStopped()) return Result.Failed("linux-runtime-busy", "请先停止引擎与终端再重置。")
    return LinuxUpgradeTransaction.reset(filesDir) { installFresh(context, filesDir) }
  }

  /**
   * 从 APK 资产解出实例。失败时保留旧实例（若有）：先解到暂存目录，成功后再整体替换。
   */
  fun installFresh(context: Context, filesDir: File, onProgress: (String) -> Unit = {}): Result =
    installFresh(source(context), filesDir, onProgress)

  @Synchronized
  internal fun installFresh(source: Source, filesDir: File, onProgress: (String) -> Unit = {}): Result {
    val root = instanceRoot(filesDir)
    if (SnapshotFs.exists(root)) return Result.Failed("linux-reset-required", RESET_WARNING)
    val stage = File(filesDir, STAGE_NAME)
    return try {
      val startedAt = System.currentTimeMillis()
      val record = source.open("$ASSET_ROOT/manifest.json").use { JSONObject(it.readBytes().decodeToString()) }
      validateAssetRecord(record)
      val stageIdentity = File(stage, ".asset-manifest.json")
      if (!stageIdentity.isFile || stageIdentity.readText() != record.toString()) SnapshotFs.deletePath(stage)
      stage.mkdirs()
      LinuxUpgradeTransaction.atomicWrite(stageIdentity, record.toString())
      for (name in listOf("rootfs", "node", "engine")) {
        val component = File(stage, name)
        val ready = File(stage, ".$name.ready")
        val expected = record.getString(name + "TreeSha256")
        val reusable = ready.isFile && ready.readText() == expected && runCatching { LinuxFileTree.digest(component) }.getOrNull() == expected
        if (reusable) onProgress("复用已校验的 Linux $name…") else {
          SnapshotFs.deletePath(component)
          onProgress("解包 Linux $name…")
          extractVerified(source, record, name, component, onProgress)
          LinuxUpgradeTransaction.atomicWrite(ready, expected)
        }
      }
      seedHome(source, filesDir, record, onProgress)
      source.trial(Instance(stage, File(stage, "rootfs"), File(stage, "node/bin/node"), File(stage, "engine")), record, onProgress)
      File(stage, MANIFEST_NAME).writeText(record.toString(2) + "\n")
      if (!stage.renameTo(root)) throw IOException("无法把 Linux 实例暂存目录提交到位")
      LinuxUpgradeTransaction.atomicWrite(File(filesDir, "linux-install-metrics.json"), JSONObject()
        .put("elapsedMs", System.currentTimeMillis() - startedAt).put("epochMs", System.currentTimeMillis())
        .put("processMemory", runCatching { File("/proc/self/status").readLines().filter { it.startsWith("VmRSS:") || it.startsWith("VmHWM:") }.joinToString("; ") }.getOrDefault("unavailable"))
        .put("measurement", "wall time and process RSS/HWM at commit; HWM covers the whole process lifetime").toString())
      LinuxLegacyMigration.commit(filesDir)
      open(filesDir)
    } catch (error: Exception) {
      // Completed, hash-verified components remain staged for a later retry.
      Result.Failed("linux-install-failed", error.message ?: error.javaClass.simpleName)
    }
  }
}
