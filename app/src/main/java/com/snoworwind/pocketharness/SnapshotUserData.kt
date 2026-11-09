package com.snoworwind.pocketharness

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes

/**
 * Preserves and transfers the user configuration in DSH_HOME, and recovers legacy backups.
 * The legacy backup was left by a pre-transaction refresh (versions up to 0.13.2 copied `.dsh` aside, extracted over the live tree and
 * copied it back; a kill in the middle left `.dsh-backup` behind).
 *
 * The current refresh no longer creates that backup — [SnapshotTransaction] never
 * touches user-owned paths — so this restore is a one-time migration (only reachable
 * via a leftover `.dsh-backup` from ≤0.13.2).
 *
 * Boundary (review C14, comment corrected to match behavior): for the user-owned trees
 * the restore is deliberately additive — only missing entries and truncated regular
 * files are copied, so a stale backup can never roll back data the user created after
 * the interrupted refresh. The small singletons in [replacedSingletons] are the
 * exception: they are replaced wholesale, because the interrupted refresh could have
 * overwritten them with factory content during extraction, which makes the
 * pre-extraction backup the authoritative content for exactly those files.
 * Broken symbolic links are logged and skipped, and the live source tree is never
 * mutated to make a copy work.
 */
internal object SnapshotUserData {

  /** DSH_HOME paths that survive a factory snapshot replacement. */
  internal val preservedNames = listOf(
    "sessions", "storages", "attachments", "workspaces", "undo-snapshots", "llm-deepseek",
    ".credentials.yaml", "settings.yaml", "settings.yaml.imported", ".anonymous-user-id", ".private-layout",
    "models-store.json", ".node-compile-cache",
  )

  /** 出厂全局指令文件名（`home/.dsh/AGENTS.md`）。 */
  private const val FACTORY_GLOBAL_INSTRUCTION = "AGENTS.md"

  /**
   * 出厂标记（正文首行）：区分「用户手写的历史文件」与「旧版本工厂件」。
   *
   * 判据为什么不能是「内容与新版不同」：每次基线更新后，旧版工厂件的内容**当然**和新版不同，
   * 按内容判就会把上一版说明当成用户笔记迁进 `~/.agents/`，于是陈旧指令被重复注入。
   * 标记由 [scripts/global-AGENTS.md] 提供并被构建期内容门禁强制，见 docs/AGENTS/PERSISTENT-DATA.md。
   */
  private const val FACTORY_BASELINE_SENTINEL = "<!-- dsh-mobile-factory-baseline -->"

  /** 用户级指令的共享根（`home/.agents`）：与 `.dsh` 同级、不在工厂档案里，升级不动。 */
  private const val USER_GLOBAL_AGENTS_DIR = ".agents"

  /**
   * Direct children of the current factory `home/.dsh` archive. Existing paths outside
   * this inventory are user or third-party data and must be preserved on collision.
   * Add a name only after verifying its ownership in the snapshot builder and documenting
   * why replacing an existing user path is required. The verified current archive
   * inventory is profiles/, settings.yaml, .private-layout and AGENTS.md; recheck it when
   * assets change.
   *
   * 出厂全局指令基线（`home/.dsh/AGENTS.md`，0.15.x）刻意放在这个清单里：**升级整份替换**。
   * 这份正文讲的是「对每一个安装都成立」的运行时事实，要随版本演进（新装与升级必须拿到同一份）。
   * 用户自己的全局约定有独立落点——`home/.agents/AGENTS.md`：引擎把 `~/.dsh/AGENTS.md` 与
   * `~/.agents/AGENTS.md` 都作为用户级指令注入，升级只动前者。
   *
   * 迁移目标为什么必须是 `~/.agents`：引擎对用户级指令只认 `<root>/AGENTS.md`（两个根），
   * **不读** `~/.dsh/AGENTS.local.md`（`.local` 覆盖只作用于项目目录那条链）。把用户内容搬到
   * `.local` 等于让它从此不再被注入。
   */
  internal val factorySnapshotNames = setOf("profiles", "settings.yaml", ".private-layout", FACTORY_GLOBAL_INSTRUCTION)

  /**
   * Small singletons that are restored wholesale. A leftover backup means the refresh
   * that could have overwritten them did not finish, and the backup copy predates that
   * extraction, so it is the authoritative content.
   */
  private val replacedSingletons = setOf(
    "settings.yaml", ".credentials.yaml", ".anonymous-user-id", ".private-layout", "models-store.json",
  )

  /**
   * The engine renames legacy settings before writing into the active profile. Absence of
   * settings.yaml with an .imported marker is deliberate, not a request for a factory seed.
   * Only the extracted stage is changed; live settings and profile patches stay transactional.
   */
  fun prepareStagedSnapshot(stagedDsh: File, liveDsh: File): List<String> {
    val notes = mutableListOf<String>()
    fun discard(staged: File, label: String) {
      if (!SnapshotFs.exists(staged)) return
      SnapshotFs.deletePathStrict(staged)
      notes += "省略出厂用户数据 " + label
    }
    val liveLegacy = File(liveDsh, "settings.yaml")
    val livePatch = File(liveDsh, "profiles/web/cordis.patch.yml")
    if (SnapshotFs.exists(File(liveDsh, "settings.yaml.imported")) ||
        (!SnapshotFs.exists(liveLegacy) && SnapshotFs.exists(livePatch))) {
      discard(File(stagedDsh, "settings.yaml"), "settings.yaml（已迁移到活动 profile）")
    }
    // An importer marker belongs to this installation, never to the factory archive.
    discard(File(stagedDsh, "settings.yaml.imported"), "settings.yaml.imported")
    val stagedProfiles = File(stagedDsh, "profiles")
    for (profile in stagedProfiles.listFiles() ?: emptyArray()) {
      if (Files.isSymbolicLink(profile.toPath()) || !profile.isDirectory) continue
      val liveProfile = File(File(liveDsh, "profiles"), profile.name)
      if (SnapshotFs.exists(File(liveProfile, "settings.yaml.imported"))) {
        discard(File(profile, "settings.yaml"), "profiles/" + profile.name + "/settings.yaml（已迁移）")
      }
      discard(File(profile, "settings.yaml.imported"), "profiles/" + profile.name + "/settings.yaml.imported")
      for (name in preservedNames) {
        if (SnapshotFs.exists(File(liveProfile, name))) discard(File(profile, name), "profiles/" + profile.name + "/" + name)
      }
    }
    notes += preserveEditedFactoryInstruction(stagedDsh, liveDsh)
    return notes
  }

  /**
   * 0.15.x：把**用户改过的**全局指令迁到用户面，再让换树把工厂版写回 `home/.dsh/AGENTS.md`。
   *
   * 为什么必须有这一步：0.15.x 之前 `AGENTS.md` 在 `.dsh` 里是「未分类条目」，升级规则是保留 live
   * （见 [SnapshotTransaction.swap] 的 `factorySnapshotNames` 分支），于是先行用户——包括本项目的
   * 开发设备——把它当成了自己的全局纪律存放处。现在它变成工厂件（升级整份替换），直接覆盖等于
   * 静默删掉用户的笔记。迁移 = 改名不动内容，写在用户面 [USER_GLOBAL_AGENTS_DIR]/AGENTS.md。
   *
   * 为什么放在换树之前：这是「只改文件名、不改内容」的搬运。即使随后刷新失败并回滚，用户内容依然
   * 被引擎注入（两个用户级根的内容都会加载），不存在信息丢失窗口；反过来先覆盖再恢复才有窗口。
   *
   * 只有「既与工厂版不同、又没有出厂标记」才迁移：内容相同 = 没动过；带标记 = 旧版工厂件
   * （每次基线更新都会不同，把它当用户笔记迁走会让陈旧指令继续被注入）。
   *
   * @return 供 swapNotes 留档的说明；空 = 无需迁移。
   * @throws IOException 读不到/搬不动时**中止刷新**（保留 live 原样），而不是在无法比对的情况下覆盖。
   */
  private fun preserveEditedFactoryInstruction(stagedDsh: File, liveDsh: File): List<String> {
    val staged = File(stagedDsh, FACTORY_GLOBAL_INSTRUCTION)
    val live = File(liveDsh, FACTORY_GLOBAL_INSTRUCTION)
    if (!SnapshotFs.exists(staged) || !SnapshotFs.exists(live)) return emptyList()
    val liveBytes = try {
      Files.readAllBytes(live.toPath())
    } catch (t: Throwable) {
      throw IOException(
        "无法读取现有全局指令（" + live.absolutePath + "），拒绝在无法比对的情况下覆盖：" + t.message, t,
      )
    }
    val stagedBytes = Files.readAllBytes(staged.toPath())
    if (liveBytes.contentEquals(stagedBytes)) return emptyList()
    // 旧版工厂件（含出厂标记）不是用户笔记：整份替换即可，不迁移、也不另存——每个版本都留一份
    // 旧工厂件只会把 .dsh 变成垃圾场；文件开头已明确写着「不要在这里写，升级会替换」。
    if (looksLikeFactoryBaseline(liveBytes)) return emptyList()
    val target = File(File(liveDsh.parentFile, USER_GLOBAL_AGENTS_DIR), FACTORY_GLOBAL_INSTRUCTION)
    val destination = if (SnapshotFs.exists(target)) {
      File(liveDsh, FACTORY_GLOBAL_INSTRUCTION + ".superseded-" + System.currentTimeMillis())
    } else target
    SnapshotFs.createDirectories(destination.parentFile)
    try {
      Files.move(live.toPath(), destination.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
    } catch (t: Throwable) {
      throw IOException(
        "无法迁移用户改过的全局指令（" + live.absolutePath + " -> " + destination.absolutePath + "）：" + t.message, t,
      )
    }
    return listOf(
      if (destination == target) {
        "迁移用户改过的全局指令到 ~/.agents/AGENTS.md（工厂版将整份替换 ~/.dsh/AGENTS.md）"
      } else {
        "用户已有 ~/.agents/AGENTS.md；旧全局指令另存为 " + destination.name
      },
    )
  }

  /**
   * 该文件是不是我们自己发出去的出厂基线（看头部有没有出厂标记）。
   *
   * 只看头部 256 字节：标记约定在首行，读全文件没有额外判别力，却让 4KB 的文件被整份解码一次。
   */
  private fun looksLikeFactoryBaseline(bytes: ByteArray): Boolean {
    val head = String(bytes, 0, minOf(bytes.size, 256), Charsets.UTF_8)
    return head.contains(FACTORY_BASELINE_SENTINEL)
  }

  /** Quarantines a known blank factory seed resurrected by an older upgrade; custom YAML is untouched. */
  fun retireReseededFactorySettings(dshRoot: File): File? {
    val legacy = File(dshRoot, "settings.yaml")
    if (!SnapshotFs.exists(File(dshRoot, "settings.yaml.imported")) ||
        !legacy.isFile || Files.isSymbolicLink(legacy.toPath())) return null
    val body = legacy.readText().lineSequence().map { it.substringBefore('#').trimEnd() }
      .filter { it.isNotBlank() }.joinToString("\n")
    if (body != "llm-deepseek: {}\nllm-pi-ai:\n  providers: {}") return null
    val backup = File.createTempFile(".settings-factory-reseed-", ".bak", dshRoot)
    try {
      Files.move(legacy.toPath(), backup.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    } catch (t: Throwable) {
      Files.deleteIfExists(backup.toPath())
      throw t
    }
    return backup
  }

  /** The web engine persists settings in its profile patch; imported YAML is historical only. */
  fun configurationDocument(dshRoot: File, profileName: String = "web"): File {
    val profile = File(File(dshRoot, "profiles"), profileName)
    val patch = File(profile, "cordis.patch.yml")
    val migrated = SnapshotFs.exists(File(dshRoot, "settings.yaml.imported")) ||
      SnapshotFs.exists(File(profile, "settings.yaml.imported"))
    return if (migrated || SnapshotFs.exists(patch)) patch else File(dshRoot, "settings.yaml")
  }

  /** User-initiated export of the actual configuration, never the .imported historical document. */
  @Synchronized
  fun exportConfiguration(dshRoot: File, sharedRoot: File): File {
    val source = configurationDocument(dshRoot)
    require(source.isFile && !Files.isSymbolicLink(source.toPath())) { "活动配置尚未生成，请等待引擎初始化后再导出" }
    val directory = File(File(sharedRoot, "exports"), "config")
    SnapshotFs.createDirectories(directory)
    val target = File(directory, source.name)
    replaceConfiguration(source, target)
    return target
  }

  /** Imports the matching exported format; a legacy YAML cannot overwrite a migrated profile patch. */
  @Synchronized
  fun importConfiguration(dshRoot: File, sharedRoot: File): File {
    val target = configurationDocument(dshRoot)
    val source = File(File(File(sharedRoot, "exports"), "config"), target.name)
    require(source.isFile && !Files.isSymbolicLink(source.toPath())) {
      "未找到 exports/config/" + target.name + "；请先导出当前活动配置，再编辑并导入（旧 settings.yaml 不会覆盖已迁移的 profile）"
    }
    require(target.isFile && !Files.isSymbolicLink(target.toPath())) { "活动配置尚未生成，请等待引擎初始化后再导入" }
    replaceConfiguration(target, File(target.parentFile, target.name + ".import-backup"))
    replaceConfiguration(source, target)
    return target
  }

  private fun replaceConfiguration(source: File, target: File) {
    val temporary = File.createTempFile(".config-", ".tmp", target.parentFile)
    try {
      Files.copy(source.toPath(), temporary.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
      Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    } finally {
      Files.deleteIfExists(temporary.toPath())
    }
  }

  internal data class CopyResult(
    val copiedEntries: Int,
    val skippedExisting: Int,
    val skippedBrokenLinks: Int,
  )

  fun restoreLegacyBackup(
    backupRoot: File,
    destinationRoot: File,
    onBrokenLink: (File) -> Unit,
  ): CopyResult {
    if (!SnapshotFs.exists(backupRoot)) return CopyResult(0, 0, 0)
    SnapshotFs.createDirectories(destinationRoot)
    var copied = 0
    var skipped = 0
    var broken = 0
    val migratedSettings = SnapshotFs.exists(File(destinationRoot, "settings.yaml.imported")) ||
      SnapshotFs.exists(File(backupRoot, "settings.yaml.imported"))
    for (name in preservedNames + "profiles") {
      // A pre-migration backup must not resurrect a legacy document after a completed import.
      if (name == "settings.yaml" && migratedSettings) { skipped++; continue }
      val source = File(backupRoot, name)
      if (!SnapshotFs.exists(source)) continue
      val destination = File(destinationRoot, name)
      val result = if (name in replacedSingletons) {
        replaceEntry(source, destination, onBrokenLink)
      } else {
        mergeMissing(source, destination, onBrokenLink, restoreTruncated = name != "profiles" && name != "settings.yaml.imported")
      }
      copied += result.copiedEntries
      skipped += result.skippedExisting
      broken += result.skippedBrokenLinks
    }
    return CopyResult(copied, skipped, broken)
  }

  private fun replaceEntry(source: File, destination: File, onBrokenLink: (File) -> Unit): CopyResult {
    SnapshotFs.deletePath(destination)
    return mergeMissing(source, destination, onBrokenLink)
  }

  /** Copies only what the destination lacks: missing entries and truncated regular files. */
  private fun mergeMissing(
    source: File,
    destination: File,
    onBrokenLink: (File) -> Unit,
    restoreTruncated: Boolean = true,
  ): CopyResult {
    val sourcePath = source.toPath()
    val attributes = Files.readAttributes(sourcePath, BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS)
    return try {
      when {
        attributes.isSymbolicLink -> {
          if (!Files.exists(sourcePath)) {
            // Dangling link: disposable runtime residue, never recreated.
            onBrokenLink(source)
            CopyResult(0, 0, 1)
          } else if (SnapshotFs.exists(destination)) {
            CopyResult(0, 1, 0)
          } else {
            SnapshotFs.createDirectories(destination.parentFile ?: source.parentFile)
            Files.createSymbolicLink(destination.toPath(), Files.readSymbolicLink(sourcePath))
            CopyResult(1, 0, 0)
          }
        }
        attributes.isDirectory -> {
          SnapshotFs.createDirectories(destination)
          var copied = 0
          var skipped = 0
          var broken = 0
          Files.list(sourcePath).use { children ->
            children.forEach { child ->
              val name = child.fileName.toString()
              if (name == "settings.yaml" && (SnapshotFs.exists(File(source, "settings.yaml.imported")) ||
                  SnapshotFs.exists(File(destination, "settings.yaml.imported")))) {
                skipped++
                return@forEach
              }
              val result = mergeMissing(child.toFile(), File(destination, name), onBrokenLink,
                restoreTruncated && name != "settings.yaml.imported")
              copied += result.copiedEntries
              skipped += result.skippedExisting
              broken += result.skippedBrokenLinks
            }
          }
          CopyResult(copied, skipped, broken)
        }
        attributes.isRegularFile -> {
          val existing = if (SnapshotFs.exists(destination)) destination.length() else -1L
          if ((!restoreTruncated && existing >= 0) || existing >= attributes.size()) {
            CopyResult(0, 1, 0)
          } else {
            SnapshotFs.createDirectories(destination.parentFile ?: source.parentFile)
            SnapshotFs.deletePath(destination)
            Files.copy(sourcePath, destination.toPath())
            CopyResult(1, 0, 0)
          }
        }
        else -> throw IllegalStateException("unsupported user-data entry: " + source.absolutePath)
      }
    } catch (e: NoSuchFileException) {
      if (!attributes.isSymbolicLink) throw e
      onBrokenLink(source)
      CopyResult(0, 0, 1)
    }
  }
}
