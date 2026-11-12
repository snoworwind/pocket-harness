package com.snoworwind.pocketharness

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.IOException

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

  data class Instance(val root: File, val rootfs: File, val node: File, val engine: File)

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
  fun open(filesDir: File): Result {
    val root = instanceRoot(filesDir)
    val manifest = File(root, MANIFEST_NAME)
    if (!root.isDirectory || !manifest.isFile) {
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
  fun ensure(context: Context, filesDir: File, onProgress: (String) -> Unit = {}): Result {
    val asset = runCatching {
      context.assets.open("$ASSET_ROOT/manifest.json").use { JSONObject(it.readBytes().decodeToString()) }
    }.getOrNull() ?: return open(filesDir)
    if (open(filesDir) is Result.Failed) return install(context, filesDir, onProgress)

    val root = instanceRoot(filesDir)
    val manifestFile = File(root, MANIFEST_NAME)
    val current = runCatching { JSONObject(manifestFile.readText()) }.getOrNull()
      ?: return Result.Failed("linux-instance-corrupt", "实例清单无法解析")

    val plan = planUpdate(
      currentNode = current.optString("nodeSha256"),
      currentEngine = current.optString("engineSha256"),
      assetNode = asset.optString("nodeSha256"),
      assetEngine = asset.optString("engineSha256"),
    )
    if (plan.replaceNode) {
      onProgress("更新 Linux Node…")
      replaceSubtree(context, "node.tar.xz", File(root, "node"), guestLinks = false)
      current.put("nodeSha256", asset.optString("nodeSha256"))
    }
    if (plan.replaceEngine) {
      onProgress("更新引擎树…")
      replaceSubtree(context, "engine.tar.xz", File(root, "engine"), guestLinks = false)
      current.put("engineSha256", asset.optString("engineSha256"))
    }
    seedHome(context, filesDir, asset, onProgress)
    migrate(filesDir, current.optInt("schemaVersion", SCHEMA), asset.optInt("schemaVersion", SCHEMA))
    current.put("schemaVersion", SCHEMA)
    manifestFile.writeText(current.toString(2) + "\n")
    return open(filesDir)
  }

  /** 子树的原子替换：先解到同级暂存目录，成功后再删旧换新；失败不动旧树。 */
  private fun replaceSubtree(context: Context, assetName: String, target: File, guestLinks: Boolean) {
    val staging = File(target.parentFile, ".staging-" + target.name)
    SnapshotFs.deletePath(staging)
    staging.mkdirs()
    try {
      context.assets.open("$ASSET_ROOT/$assetName").use { stream ->
        SnapshotExtractor.extract(
          input = stream,
          totalBytes = 0,
          dest = staging,
          onProgress = { _, _ -> },
          runtimeRoot = staging,
          guestLinks = guestLinks,
        )
      }
      SnapshotFs.deletePath(target)
      if (!staging.renameTo(target)) throw IOException("无法替换 " + target.absolutePath)
    } catch (error: Throwable) {
      runCatching { SnapshotFs.deletePath(staging) }
      throw error
    }
  }

  /** home 种子只在首次安装时落地；覆盖更新不覆盖用户数据。 */
  private fun seedHome(context: Context, filesDir: File, asset: JSONObject, onProgress: (String) -> Unit) {
    val marker = File(filesDir, ".linux-home-seeded")
    if (marker.exists()) return
    onProgress("解包初始用户数据…")
    context.assets.open("$ASSET_ROOT/home.tar.xz").use { stream ->
      SnapshotExtractor.extract(
        input = stream,
        totalBytes = 0,
        dest = filesDir,
        onProgress = { _, _ -> },
        runtimeRoot = filesDir,
      )
    }
    marker.writeText(asset.optString("homeSha256"))
  }

  /**
   * 迁移只做「补齐必要文件」，不重铺基础镜像。当前没有历史 schema，仅保留入口与判据：
   * 升级到更高 schema 时在这里按版本顺序追加步骤。
   */
  private fun migrate(filesDir: File, from: Int, to: Int) {
    if (to <= from) return
    val root = instanceRoot(filesDir)
    for (name in listOf("rootfs", "node", "engine")) File(root, name).mkdirs()
  }

  /**
   * 从 APK 资产解出实例。失败时保留旧实例（若有）：先解到暂存目录，成功后再整体替换。
   */
  fun install(context: Context, filesDir: File, onProgress: (String) -> Unit = {}): Result {
    val root = instanceRoot(filesDir)
    if (open(filesDir) is Result.Ready) return open(filesDir)
    val stage = File(filesDir, STAGE_NAME)
    SnapshotFs.deletePath(stage)
    try {
      stage.mkdirs()
      val assets = context.assets
      val manifest = assets.open("$ASSET_ROOT/manifest.json").use { it.readBytes().decodeToString() }
      val record = JSONObject(manifest)
      if (record.optInt("schemaVersion", -1) != SCHEMA) {
        return Result.Failed("linux-asset-invalid", "内置资产清单 schemaVersion 不是 $SCHEMA")
      }
      for (entry in listOf(
        Triple("rootfs", "rootfs.tar.xz", true),
        Triple("node", "node.tar.xz", false),
        Triple("engine", "engine.tar.xz", false),
      )) {
        val (name, assetName, guestLinks) = entry
        val destination = File(stage, name).apply { mkdirs() }
        onProgress("解包 Linux $name…")
        assets.open("$ASSET_ROOT/$assetName").use { stream ->
          SnapshotExtractor.extract(
            input = stream,
            totalBytes = 0,
            dest = destination,
            onProgress = { done, _ -> if (done % (64L * 1024 * 1024) < 4096) onProgress("$name ${done / (1024 * 1024)} MB") },
            runtimeRoot = destination,
            guestLinks = guestLinks,
          )
        }
      }
      // 用户态种子：home/.dsh 初始 profile 等原本随 Termux 快照解压；首启一次性落地，
      // 之后用户数据只增不改，重复安装不再覆盖。
      val homeMarker = File(filesDir, ".linux-home-seeded")
      if (!homeMarker.exists()) {
        onProgress("解包初始用户数据…")
        assets.open("$ASSET_ROOT/home.tar.xz").use { stream ->
          SnapshotExtractor.extract(
            input = stream,
            totalBytes = 0,
            dest = filesDir,
            onProgress = { _, _ -> },
            runtimeRoot = filesDir,
          )
        }
        homeMarker.writeText(record.optString("homeSha256"))
      }
      File(stage, MANIFEST_NAME).writeText(record.toString(2) + "\n")
      SnapshotFs.deletePath(root)
      if (!stage.renameTo(root)) throw IOException("无法把 Linux 实例暂存目录替换到位")
      return open(filesDir)
    } catch (error: Throwable) {
      runCatching { SnapshotFs.deletePath(stage) }
      return Result.Failed("linux-install-failed", error.message ?: error.javaClass.simpleName)
    }
  }
}
