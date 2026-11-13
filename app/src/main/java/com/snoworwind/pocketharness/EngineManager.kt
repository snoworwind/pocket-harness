package com.snoworwind.pocketharness

import android.app.ActivityManager
import android.content.Context
import android.media.MediaScannerConnection
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

/**
 * Owns the APK-managed Debian guest and engine process lifecycle. The host runs
 * only APK-installed PRoot; guest loader variables are isolated from the host.
 */
class EngineManager(private val context: Context, private val pickToken: String? = null) {

  init {
    LinuxDnsServers.initialize(context.applicationContext)
    runCatching { EngineTransport.initialize(context.applicationContext) }
      .onFailure { Log.w(TAG, "engine transport unavailable: ${it.javaClass.simpleName}") }
  }

  val homeDir = File(context.filesDir, "home")

  /**
   * Public export repo: /storage/emulated/0/Documents/dshdata.
   * Holds only user-initiated session zip exports (exports/) plus a .nomedia anti-scan marker;
   * all runtime user data lives back in private app data (files/home/.dsh).
   */
  val dshDataDir: File
    get() {
      val publicDocs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      return File(publicDocs, "dshdata")
    }
  /** The engine Process is process-owned, not Activity-owned: MainActivity and
   * EngineService create separate managers but must observe the same child. */
  private var engineProcess: Process?
    get() = sharedEngineProcess
    set(value) {
      sharedEngineProcess = value
    }

  /** Consecutive healthy probe ticks since the last update swap (update-v2 confirmation state). */
  private var updateHealthTicks = 0

  /**
   * M.1（apk #272）：最近一次 startEngine 判定出的「引擎可用性」四态。
   *
   * 为什么要有它：旧实现只回一个布尔（且端口可连就静默 true），界面与日志都无从表达
   * 「3080 被非本引擎占用」这类状态。把它存下来后，引导页与诊断能如实说清是哪一种。
   * 初值 [EngineProbe.EngineAvailability.DOWN]（还没判过 ≠ 已有引擎）。
   */
  @Volatile
  var lastAvailability: EngineProbe.EngineAvailability = EngineProbe.EngineAvailability.DOWN
    private set

  val engineReady: Boolean get() = linuxInstanceReady()

  /**
   * Deploy the undo emergency CLI (assets/undo-emergency.mjs → filesDir).
   * Idempotent: content equals the asset → skip. Missing node still succeeds
   * (the file itself is versioned with the app); UndoGate checks child exit code.
   */
  fun deployUndoCli() {
    try {
      val asset = "undo-emergency.mjs"
      if (context.assets.open(asset).use { it.readBytes() }.let { b ->
          File(context.filesDir, asset).takeIf { it.exists() }?.readBytes()?.contentEquals(b) != true
        }) {
        context.assets.open(asset).use { input ->
          File(context.filesDir, asset).outputStream().use { input.copyTo(it) }
        }
        Log.i(TAG, "undo emergency CLI deployed")
      }
    } catch (t: Throwable) {
      Log.e(TAG, "undo CLI deploy failed (non-fatal): " + t.message)
    }
  }


  internal fun prepareLinuxInstance(onProgress: (String) -> Unit = {}): LinuxInstanceInstaller.Result {
    val start = SystemClockElapsed.elapsedRealtime()
    return LinuxInstanceInstaller.ensure(context, context.filesDir, onProgress).also { result ->
      BootPhaseTrace.mark(context, BootPhaseTrace.LINUX_PREPARE,
        "ms=" + (SystemClockElapsed.elapsedRealtime() - start) + " ok=" + (result is LinuxInstanceInstaller.Result.Ready))
    }
  }

  internal fun linuxInstanceReady(): Boolean = LinuxInstanceInstaller.open(context.filesDir, verifyManaged = false) is LinuxInstanceInstaller.Result.Ready

  internal fun recoverLinuxUpgrade() = synchronized(LinuxInstanceInstaller) {
    LinuxUpgradeTransaction.recoverReset(context.filesDir)
    LinuxUpgradeTransaction.recover(context.filesDir)
  }

  /**
   * 最近一次**拒绝启动**的可归因原因（issue #271 ④）：非空即表示上一次 `startEngine` 是被
   * 前置条件挡下的（而不是 spawn 失败），boot 侧据此能给出「不用再等 90s」的文案。
   */
  @Volatile
  var lastStartRefusal: String? = null

  /**
   * 上一次拒绝启动的**结构化原因码**（issue #309）。
   *
   * 为什么不能只靠 [lastStartRefusal] 的文案：调用方需要区分「live 运行时树残缺 ⇒ 删指纹重抽取
   * 才有出路」与「端口被外部占用 ⇒ 重抽取无用」。旧实现只有一句人读文案，调用方无法据此选择
   * 恢复动作，于是拒启路径既不 spawn（闸门 A）也读不到 engine.log（闸门 B 的判据）——两道闸门
   * 互锁，自动路径为零。
   */
  @Volatile
  var lastStartRefusalCode: String? = null

  /**
   * 最后一次「live 树残缺」拒启的**逐项取证**（issue #309）。
   *
   * 为什么拒启时就要取证：当时的恢复动作是「删指纹 + 全量重抽取」，而重抽取会**覆盖现场**。
   * 旧实现既没有恢复动作、也没有取证，issue 报障者只能靠人回忆「我删过 usr/lib 里的符号链接」。
   * 现在把「缺了哪几项、路径是什么、mtime/大小」在**删指纹之前**落进 boot-fail.log；
   * 若一个确认项都缺（只有 REQUIRED_LIBS 这类置信度低的判据命中），则按 issue #309 的反向告诫
   * **不触发重抽取**。旧运行时树闸门与重抽取路径已随内置 Linux 实例迁移移除，本字段现在只作诊断输出。
   */
  @Volatile
  var lastStartRefusalEvidence: String? = null

  /**
   * 上一次「live 树残缺」拒启中的**确诊缺失项**（issue #309）。
   *
   * 旧运行时树判据表已随内置 Linux 实例迁移移除；本字段只保留为 boot-fail 诊断输出
   * （`start_refusal_confirmed`），当前启动链路不再写入非空值。与 [lastStartRefusalEvidence]
   * 的分工不变：evidence 是现场全文，本字段是判据值（历史语义见 issue #309）。
   */
  @Volatile
  var lastStartRefusalConfirmed: List<String> = emptyList()

  private fun seedPhoneControlPreset(privateDsh: File) {
    try {
      val dir = File(File(privateDsh, ".agent-presets"), "phone-control")
      // SKILL.md 是我们管理的纪律文案：每次启动都刷新（保证升级后纪律立即生效）；
      // preset.yml / agent.cordis.yml 只在缺失时播种，保留用户可能的改动。
      val skillDir = File(dir, "skills/phone-control").apply { mkdirs() }
      val skillFile = File(skillDir, "SKILL.md")
      // 坑 170：干净安装时 SKILL.md 尚不存在，而 File.readText() 在文件缺席时**抛
      // FileNotFoundException**（不是返回空串）。该异常被本函数外层的 catch(Throwable)
      // 吞掉 ⇒ 函数当场返回，它后面的 customSkillDirs 注入 / agent.cordis.yml 拷贝 /
      // preset.yml 写入一步都跑不到；而函数末尾的幂等早退判据正是 preset.yml，
      // 于是每次启动都从这一行重炸、永不自愈（预设恒显「加载失败」）。
      // 先判在场再读：缺席视同「需要刷新」。
      val existingSkill = if (skillFile.isFile) skillFile.readText() else null
      if (existingSkill?.trim() != PHONE_CONTROL_SKILL.trim()) {
        skillFile.writeText(PHONE_CONTROL_SKILL)
        Log.i(TAG, "phone-control SKILL refreshed")
      }
      // 0.13.8 #130/V2 P1-11：标准组合的 skill-filesystem 行没有 config——预设自带的
      // skills 目录不在任何被扫描的 skill 根里，phone-control 的 SKILL 从未被加载
      // （与缺 frontmatter 并列的两处缺陷之一）。结构化后处理：照抄上游 cordis 预设的
      // 写法注入 customSkillDirs（指向本预设 skills/ 目录，baseUrl 相对解析）；
      // 已注入则跳过（幂等）。置于 preset.yml 早退之前——存量用户的升级路径也覆盖。
      val composition = File(dir, "agent.cordis.yml")
      if (composition.exists()) {
        val text = composition.readText()
        if (text.contains("- id: skill-filesystem") && !text.contains("customSkillDirs")) {
          val anchor = "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'"
          val injected = anchor + "\n" +
            "  config:\n" +
            "    customSkillDirs:\n" +
            "      - !!js \"process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))\""
          val patched = text.replace(anchor, injected)
          if (patched != text) {
            composition.writeText(patched)
            Log.i(TAG, "phone-control preset: customSkillDirs injected into skill-filesystem row")
          } else {
            Log.w(TAG, "phone-control preset: skill-filesystem anchor not found; customSkillDirs not injected")
          }
        }
      }
      if (File(dir, "preset.yml").exists()) return
      val shipped = File(
        context.filesDir,
        "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml",
      )
      if (!shipped.isFile) {
        Log.w(TAG, "phone-control preset skipped: shipped standard composition absent at " + shipped.absolutePath)
        return
      }
      File(dir, "agent.cordis.yml").writeText(shipped.readText())
      File(dir, "preset.yml").writeText(
        "name: 手机操控\n" +
          "description: 以无障碍语义树 / DOM 快照驱动的手机操控预设：dump → 按 ref 点击或输入 → 校验 → 再 dump；禁止盲点坐标。\n" +
          "order: 50\n",
      )
      Log.i(TAG, "phone-control preset seeded -> " + dir.absolutePath)
    } catch (t: Throwable) {
      Log.w(TAG, "phone-control preset seeding failed", t)
    }
  }

  fun ensurePrivateDshData(): File {
    val dshData = dshDataDir
    val privateDsh = File(homeDir, ".dsh")
    privateDsh.mkdirs()
    seedPhoneControlPreset(privateDsh)
    val privateMarker = File(privateDsh, ".private-layout")
    if (privateMarker.exists()) {
      provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
      return privateDsh
    }
    if (isLegacyPublicLayout(dshData, privateDsh)) {
      try {
        reverseMigrate(dshData, privateDsh)
        privateMarker.writeText("private")
        provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
        Log.i(TAG, "dshdata reverse migration done -> " + privateDsh.absolutePath)
      } catch (t: Throwable) {
        // A migration failure must not block startup: DSH_HOME stays private, the engine works, retry later.
        Log.e(TAG, "dshdata reverse migration failed; keeping public data", t)
      }
    } else {
      // Clean install or already-private layout: just mark it, no migration needed.
      try {
        privateMarker.writeText("private")
      } catch (t: Throwable) {
        Log.w(TAG, "private layout marker write failed", t)
      }
      provisionPublicRepo(PublicRepoProvision.TRIGGER_ENGINE_START)
    }
    return privateDsh
  }

  /** Detect the pre-v0.10.4 public migration layout. */
  private fun isLegacyPublicLayout(dshData: File, privateDsh: File): Boolean {
    if (File(dshData, ".migrated-from").exists()) return true
    for (name in listOf("sessions", "storages", "attachments")) {
      if (isSymlink(File(privateDsh, name))) return true
    }
    for (profile in listOf("web", "headless")) {
      for (name in listOf("cordis.yml", "cordis.patch.yml")) {
        if (isSymlink(File(privateDsh, "profiles/$profile/$name"))) return true
      }
    }
    return false
  }

  /** Reverse migration: copy public data back into private storage, clean up the public leftovers. */
  private fun reverseMigrate(dshData: File, privateDsh: File) {
    for (name in listOf("sessions", "storages", "attachments")) {
      reverseMigrateDir(File(privateDsh, name), File(dshData, name))
    }
    for (profile in listOf("web", "headless")) {
      for (name in listOf("cordis.yml", "cordis.patch.yml")) {
        reverseMigrateFile(
          File(privateDsh, "profiles/$profile/$name"),
          File(dshData, "profiles/$profile/$name"),
        )
      }
    }
    reverseMigrateFile(File(privateDsh, "settings.yaml"), File(dshData, "settings.yaml"))

    // Clean up stale public data (conflicts were renamed *.public-backup, so they're untouched).
    val removedPaths = mutableListOf<String>()
    for (name in listOf("sessions", "storages", "attachments", "profiles", "settings.yaml", ".migrated-from")) {
      val f = File(dshData, name)
      if (f.exists()) {
        removedPaths += f.absolutePath
        // 审查 I-9：`deleteRecursively` 的 walkBottomUp 用 File.isDirectory 判目录，**跟随符号链接**
        // ⇒ 用户数据树里若有一条指向别处的链，删除会穿过去。一律走项目既有的 NOFOLLOW 原语。
        SnapshotFs.deletePath(f)
        if (SnapshotFs.exists(f)) {
          throw java.io.IOException("failed to delete public path " + f.absolutePath)
        }
      }
    }
    // Tell MediaScanner the old public subdirs are gone, clearing the fake video entries it indexed.
    if (removedPaths.isNotEmpty()) {
      try {
        MediaScannerConnection.scanFile(context, removedPaths.toTypedArray(), null, null)
      } catch (t: Throwable) {
        Log.w(TAG, "media scan cleanup failed", t)
      }
    }
  }

  /** Dir-level reverse migration: drop the private symlink, copy the public entity back with a verified copy, then delete the public source. */
  private fun reverseMigrateDir(privateDir: File, publicDir: File) {
    if (isSymlink(privateDir)) {
      Files.delete(privateDir.toPath())
    }
    ReverseMigration.migrateDir(privateDir, publicDir)
  }

  /** File-level reverse migration: drop the private symlink, copy the public file back, then delete the public source. */
  private fun reverseMigrateFile(privateFile: File, publicFile: File) {
    if (isSymlink(privateFile)) {
      Files.delete(privateFile.toPath())
    }
    if (!publicFile.isFile) return
    if (privateFile.exists()) {
      if (privateFile.length() > 0) {
        // The public file is the post-migration active copy (settings/profiles); the public one wins,
        // and the stale private entity is kept as a backup rather than silently deleted.
        val backup = uniquePrivateBackup(privateFile)
        if (!privateFile.renameTo(backup)) {
          throw java.io.IOException("failed to backup private file " + privateFile.absolutePath)
        }
        Log.w(TAG, "private file backed up as " + backup.absolutePath)
      } else {
        privateFile.delete()
      }
    }
    privateFile.parentFile?.mkdirs()
    publicFile.copyTo(privateFile, overwrite = true)
    if (privateFile.length() != publicFile.length()) {
      throw java.io.IOException("copy verification failed for " + publicFile.absolutePath)
    }
    if (!publicFile.delete()) {
      throw java.io.IOException("failed to delete public source " + publicFile.absolutePath)
    }
  }

  /** 供给结果落点（**私有目录**：公共目录刚建失败时往它里面写结果必然也失败）。 */
  private fun publicRepoStatusFile(): File = File(context.filesDir, PublicRepoProvision.STATUS_FILE_NAME)

  /**
   * 上一次公共目录供给的结果。落盘畸形或从未尝试一律 [PublicRepoStatus.UNKNOWN]
   * （**不得**当成成功——「尚未探测」与「已就绪」必须是两个可区分的状态，坑 161 同族）。
   */
  internal fun publicRepoStatus(): PublicRepoStatus = try {
    PublicRepoProvision.parseStatus(publicRepoStatusFile().takeIf { it.exists() }?.readText())
  } catch (t: Throwable) {
    Log.w(TAG, "public repo status read failed", t)
    PublicRepoStatus.UNKNOWN
  }

  /** 上一次尝试的细节与触发来源（诊断用；空串 = 无）。 */
  internal fun publicRepoLastAttempt(): String = try {
    val raw = publicRepoStatusFile().takeIf { it.exists() }?.readText()
    PublicRepoProvision.parseTrigger(raw) + " " + PublicRepoProvision.parseDetail(raw)
  } catch (_: Throwable) {
    ""
  }

  /**
   * 本机这条路上「理论上能不能写公共 Documents」——决定失败该记 NOT_AUTHORIZED 还是 FAILED。
   *
   * API>=30 看 All Files Access；API<30 没有这套权限模型，看运行时 WRITE（Android 10 那条路上
   * scoped storage 仍可能拦——**不预设结论**，由实际尝试的结果说话）。
   */
  private fun publicDocsWritable(): Boolean = try {
    if (android.os.Build.VERSION.SDK_INT >= 30) {
      Environment.isExternalStorageManager()
    } else {
      context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    }
  } catch (_: Throwable) {
    false
  }

  /**
   * 供给公共导出目录（根 + `.nomedia` + `exports/` + README）并**如实记账**（0.14.1 用户反馈）。
   *
   * 两条与旧实现的关键差别：
   *  1. **结果可观测**：旧实现失败只 `Log.w`，用户侧完全看不到「目录没建出来」这件事；
   *     现在写一行私有落盘（`status|trigger|epochMs|detail`）并落一条 LogCollector 记录。
   *  2. **可重试**：结果里除 `OK` 外都会让 [PublicRepoProvision.needsRetry] 为真，
   *     于是授权返回后的 `onResume` 会再试一次——旧实现挂在 `startEngine()` 的早退点后面，
   *     引擎活着就永远不再尝试（这正是「授权了但 dshdata 一直没出现」的机制）。
   *
   * 成功判据用**后置条件**（`exports/` 真的在场），不只看 `mkdirs()` 的返回值——
   * 后者对「已存在」返回 false，只看它会把可写目录误判成失败。
   *
   * @param trigger 触发来源（onCreate / onResume / engineStart），写进落盘行供诊断。
   */
  internal fun provisionPublicRepo(trigger: String): PublicRepoStatus {
    val dshData = dshDataDir
    var status: PublicRepoStatus
    var detail: String
    try {
      if (!dshData.isDirectory && !dshData.mkdirs() && !dshData.isDirectory) {
        throw java.io.IOException("mkdirs failed: " + dshData.absolutePath)
      }
      File(dshData, ".nomedia").writeText("")
      val exports = File(dshData, "exports")
      if (!exports.isDirectory && !exports.mkdirs() && !exports.isDirectory) {
        throw java.io.IOException("mkdirs failed: " + exports.absolutePath)
      }
      // 0.13.1 W3/W4：目录布局说明（每次启动刷新，内容随版本演进）。
      File(dshData, "README.txt").writeText(
        "dsh-mobile 共享数据目录（Documents/dshdata）说明\n" +
          "================================================\n" +
          "本目录只存放导出物与日志，应用运行数据（配置/会话/凭据）在应用私有目录，\n" +
          "文件管理器不可见——在本目录改 settings.yaml 不会生效（引擎读不到）。\n\n" +
          "目录布局：\n" +
          "  exports/                 会话与配置的导出物\n" +
          "    config/settings.yaml   配置导出（设置 > 开发者选项 > 导出配置 生成）\n" +
          "                           修改本文件后点「导入配置」即可生效（无需重装）\n" +
          "  log/                     开发者调试日志（默认关，设置 > 开发者选项 开启；含令牌脱敏，"
            + "但仍有命令与模型内容）\n" +
          "  diagnostics/             启动失败/崩溃时自动生成的诊断包（engine.log 脱敏副本 + 环境信息 + logcat），\n" +
          "                           令牌已替换为 ***，反馈 issue 时直接整目录打包上传即可\n\n" +
          "改配置的正确途径：设置界面各项开关；或 导出配置 -> 文件管理器编辑 -> 导入配置；\n" +
          "进阶：设置 > 开发者选项 > 打开控制台（快照内 bash，可直接 vi settings.yaml）。\n",
      )
      status = if (exports.isDirectory) PublicRepoStatus.OK else PublicRepoStatus.FAILED
      detail = if (status == PublicRepoStatus.OK) dshData.absolutePath else "exports/ 后置条件不成立"
    } catch (t: Throwable) {
      status = PublicRepoProvision.classifyFailure(publicDocsWritable())
      detail = t.javaClass.simpleName + ": " + (t.message ?: "")
    }
    try {
      publicRepoStatusFile().writeText(
        PublicRepoProvision.encode(status, trigger, detail, System.currentTimeMillis()),
      )
    } catch (t: Throwable) {
      Log.w(TAG, "public repo status write failed", t)
    }
    if (status == PublicRepoStatus.OK) {
      Log.i(TAG, "public export repo ready -> " + dshData.absolutePath)
    } else {
      // 落一条**用户可见面**的记录（LogCollector 会进 boot-diag/日志面），而不是只进 logcat——
      // 「目录没建出来」是用户能看见的事实，不该只留一行谁也不会去看的 Log.w。
      Log.w(TAG, "public export repo provision " + status.wire + " trigger=" + trigger + " detail=" + detail)
      LogCollector.log(
        TAG,
        "public export repo provision failed (" + status.wire + ") trigger=" + trigger + " detail=" + detail,
      )
    }
    return status
  }

  private fun isSymlink(file: File): Boolean = Files.isSymbolicLink(file.toPath())

  private fun uniquePrivateBackup(privateFile: File): File {
    var candidate = File(privateFile.parentFile, privateFile.name + ".private-backup")
    var i = 1
    while (candidate.exists()) {
      candidate = File(privateFile.parentFile, privateFile.name + ".private-backup-" + i)
      i++
    }
    return candidate
  }

  /**
   * Runtime patches: overlay fix files from assets/patched onto the corresponding snapshot
   * locations (idempotent). Overlayed fixes (all marked by a sentinel string in the target file,
   * so they are re-applied automatically after a snapshot refresh/re-extract):
   *  - attachment-local-index.js: Android link(2) blocked by sepolicy → rename fallback
   *    (rebuilt onto 0.1.2-rc.1 source, 0.13.3 W9; the rc.2-locked asset was erasing the
    *    engine upgrade's own new code, e.g. breaking prompt via stale persistence API)
   *  - (0.13.7fx-1 retirement) web-frontend-index.html: the asset had become the engine's own
   *    dist/index.html verbatim (0.1.5-rc.1 ships index-DuF6ti6g.js / index-DPX2bQLO.css), so the
   *    patch rewrote identical bytes once per snapshot refresh and nothing else. Its hash-adaptive
   *    rewrite also could not follow the npm hash charset (-([A-Za-z0-9]{8}) never matches
   *    index-Df-65__b), so a dist built from the plain package would have been overwritten with
   *    references to bundles that do not exist.
   *  - session-persistence-jsonl-index.js: Android link(2) fallback — rebuilt onto 0.1.2-rc.1
   *    source (0.13.3 W9): link(tmp, finalPath) failure on EACCES/EPERM/ENOTSUP → rename fallback.
   *  - fs-local-index.js: Android link(2) fallback for the createIfAbsent publication (issue #246).
   *    Materialised onto 0.1.5-rc.1 source. The 0.13.3 retirement read upstream as covering
   *    fs-local natively; that holds for the replacement path (plain rename) but not for the
   *    hard-link no-replace path — the only link(2) call site in this package, and it had no
   *    fallback at all, so the write tool could not create a new file on Android.
   *  - 0.13.3 retirements (upstream 0.1.2-rc.1 covers them natively): primitives (execCommand
   *    clipboard fallback is upstream-native). llm-deepseek remains a dormant legacy asset.
   *    fs-local left this list again with the fs-local-index.js asset above.
   *  Patches use a content fingerprint (no fixed marker), so an updated asset re-applies on
   *  upgrade instead of being skipped by a stale marker string (the v1→v2 update bug).
   * (v0.12.4 rc8 removed the onImagePicked/llm-deepseek/textzoom patches — rc8's native image
   * request support and no-cache hardening supersede them.)
   */
  fun startEngine(port: Int = 3080, force: Boolean = false): Boolean {
    // 独立评审 6(a)：每次进入先**清掉上一次的拒启结论**，让「有码」严格等价于「本次就是被
    // 闸门 A 拒的」。旧实现只在**通过**闸门 A 时清码，于是闸门 A 之前的那几条 return false
    // （打包指纹不可用 / termux-exec 预载库缺失）会把**上一次**的 live-runtime 码与确诊项留下
    // 来 ⇒ 调用方（错误页主按钮）会拿陈旧码去花掉那次重抽取，诊断包也会出现
    // 「有 confirmed/evidence 却没有 code」的自相矛盾字段。
    lastStartRefusal = null
    lastStartRefusalCode = null
    lastStartRefusalConfirmed = emptyList()
    // 纯 Linux 路径：装了内置实例就走客体，不再触碰 Termux 快照闸门。
    // 纯 Linux 运行时：引擎一律在 PRoot/Debian 客体里启动，不存在 Termux 回退分支。
    return startGuestEngine(port, force)
  }

  /**
   * 客体启动：确保内置实例就位（缺则解包），再按 PRoot 命令起引擎。
   * 不再有 Termux 快照闸门——那套判据只对已经不存在的 Bionic 树成立。
   */
  private fun startGuestEngine(port: Int, force: Boolean): Boolean {
    if (!STARTING.compareAndSet(false, true)) return true
    try {
      if (engineProcess?.isAlive == true) {
        if (!force) return true
        if (!stopOwnedEngine()) {
          lastStartRefusalCode = REFUSAL_PORT_FOREIGN
          lastStartRefusal = "无法确认并停止本壳引擎，未启动替代进程"
          return false
        }
      }
      when (val installed = prepareLinuxInstance { LogCollector.log(TAG, "linux install: $it") }) {
        is LinuxInstanceInstaller.Result.Ready -> LogCollector.log(TAG, "linux instance ready: " + installed.instance.root.absolutePath)
        is LinuxInstanceInstaller.Result.Failed -> {
          lastStartRefusalCode = installed.code; lastStartRefusal = installed.detail
          Log.e(TAG, "linux instance preparation failed: " + installed.code)
          return false
        }
      }
      ensurePrivateDshData()
      val hard = PluginMounts.ensureHard(context, PluginMounts.currentFingerprint(context))
      if (hard == null) {
        lastStartRefusalCode = REFUSAL_HARD_BUNDLE_SELECTION
        lastStartRefusal = "APK Hard 插件清单与 Linux 引擎身份不可用；现有用户 profile 保留"
        return false
      }
      val selected = PluginMounts.ensureHardBundlesSelected(
        File(homeDir, ".dsh/profiles/web/package.json"),
        File(context.filesDir, "linux/engine/@deepseek-ai/dsh/node_modules"), hard,
      )
      if (selected.failure != null) {
        lastStartRefusalCode = REFUSAL_HARD_BUNDLE_SELECTION
        lastStartRefusal = "Linux Hard 插件选择失败：" + selected.failure
        return false
      }
      val launch = when (val resolved = guestBootLaunch(port)) {
        is LinuxGuestBoot.Result.Ready -> resolved.launch
        is LinuxGuestBoot.Result.Refused -> {
          lastStartRefusalCode = resolved.code; lastStartRefusal = resolved.detail
          return false
        }
      }
      var started = startGuestWithLaunch(launch)
      var spawn = observeGuestSpawn(started, attempt = 0)
      if (spawn == GuestSpawnVerdict.RETRY_LOADER) {
        // Issue #322: PRoot's loader shim can return 182 before the guest program runs.
        // The first attempt did nothing (no output, no side effects), so exactly one retry
        // is safe and keeps a 2-10% early exit from parking the engine behind the 90s cooldown.
        LogCollector.log(TAG, "guest loader exited $GUEST_LOADER_FAILURE_EXIT before start; retrying once")
        lastStartRefusalEvidence = "guest-loader-exit-$GUEST_LOADER_FAILURE_EXIT"
        started = startGuestWithLaunch(launch)
        spawn = observeGuestSpawn(started, attempt = 1)
      }
      engineProcess = started
      if (spawn == GuestSpawnVerdict.LOADER_FAILED) {
        lastStartRefusalCode = REFUSAL_GUEST_LOADER_FAILED
        lastStartRefusal = "客体加载器在启动前退出 $GUEST_LOADER_FAILURE_EXIT（PRoot loader 失败）"
        Log.e(TAG, "guest loader failed twice with exit $GUEST_LOADER_FAILURE_EXIT")
        return false
      }
      if (spawn != GuestSpawnVerdict.RUNNING && EngineProbe.portReachable(250)) {
        engineProcess = null
        lastAvailability = EngineProbe.EngineAvailability.PORT_FOREIGN
        lastStartRefusalCode = REFUSAL_PORT_FOREIGN
        lastStartRefusal = "引擎端口已被其他进程占用；未清理外部进程"
        return false
      }
      lastStartAttemptAt = System.currentTimeMillis()
      LogCollector.log(TAG, "engine started (PRoot guest)")
      return true
    } catch (error: Throwable) {
      lastStartRefusalCode = startupExceptionCode(error)
      lastStartRefusal = error.message ?: error.javaClass.simpleName
      Log.e(TAG, "guest engine start failed", error)
      return false
    } finally { STARTING.set(false) }
  }

  /** Observe a fresh guest spawn long enough to tell a live engine from a pre-exec loader exit. */
  private fun observeGuestSpawn(process: Process, attempt: Int): GuestSpawnVerdict {
    try { Thread.sleep(200) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    val exitCode = if (process.isAlive) null else runCatching { process.exitValue() }.getOrNull()
    return guestSpawnVerdict(process.isAlive, exitCode, attempt)
  }

  /** Only syscall evidence classifies storage failures; arbitrary exception prose stays unknown. */
  internal fun startupExceptionCode(error: Throwable): String? {
    val causes = generateSequence(error) { it.cause }.take(16).toList()
    val errno = causes.filterIsInstance<android.system.ErrnoException>().firstOrNull()?.errno
    if (errno == android.system.OsConstants.ENOSPC) return REFUSAL_STORAGE_FULL
    if (errno == android.system.OsConstants.EACCES || errno == android.system.OsConstants.EPERM) {
      // Exec policy denial and public storage denial are NOT evidence that app-private data is unwritable.
      val privateWriteDenied = listOf(context.filesDir, homeDir).any { dir ->
        dir.isDirectory && try {
          !android.system.Os.access(dir.absolutePath, android.system.OsConstants.W_OK or android.system.OsConstants.X_OK)
        } catch (e: android.system.ErrnoException) {
          e.errno == android.system.OsConstants.EACCES || e.errno == android.system.OsConstants.EPERM
        } catch (_: SecurityException) {
          false
        }
      }
      if (privateWriteDenied) return REFUSAL_PRIVATE_STORAGE_DENIED
    }
    return null
  }

  /** The active web profile owns migrated settings; legacy YAML is used only before a profile exists. */
  fun settingsDocumentPath(): String {
    val file = SnapshotUserData.configurationDocument(File(homeDir, ".dsh"))
    return if (file.isFile) file.absolutePath else ""
  }

  /** Explicit public export. Profile patches can contain provider keys; no private directory is exposed. */
  fun settingsDocumentExport(): String = try {
    SnapshotUserData.exportConfiguration(File(homeDir, ".dsh"), dshDataDir).absolutePath
  } catch (t: Throwable) {
    Log.w(TAG, "active configuration export failed", t)
    ""
  }

  fun exportConfig(): String = configurationTransfer(importing = false)

  fun importConfig(): String = configurationTransfer(importing = true)

  private fun configurationTransfer(importing: Boolean): String = try {
    val dshRoot = File(homeDir, ".dsh")
    val file = if (importing) SnapshotUserData.importConfiguration(dshRoot, dshDataDir)
      else SnapshotUserData.exportConfiguration(dshRoot, dshDataDir)
    LogCollector.log(TAG, "active configuration " + (if (importing) "imported: " else "exported: ") + file.name)
    org.json.JSONObject().put("ok", true).put("path", file.absolutePath)
      .put("hint", if (importing) "已写入活动配置；引擎会热加载，未生效时可手动重启引擎"
        else "导出的是活动配置，可能包含供应商密钥；共享目录中的副本请妥善保管").toString()
  } catch (t: Throwable) {
    Log.w(TAG, "active configuration transfer failed", t)
    org.json.JSONObject().put("ok", false).put("error", t.message ?: "配置传输失败").toString()
  }

  /** The app workspace root (files/home/.dsh/workspaces), created on demand; null when unusable. */
  private fun workspaceRootDir(): File? = try {
    File(context.filesDir, "home/.dsh/workspaces").apply { mkdirs() }.takeIf { it.isDirectory }
  } catch (_: Throwable) {
    null
  }

  /**
   * Spawn the engine, falling back to the system linker when the direct exec
   * is denied: Android 15+ apps targeting SDK 35+ may not exec app-data ELF
   * binaries, but loading them through /system/bin/linker64 is the same
   * mechanism as native libraries (always permitted for app data).
   */
  /** boot-mode.json 未开启时返回 null；开启后由 LinuxGuestBoot 决定可启动或拒绝。 */
  private fun guestBootLaunch(port: Int): LinuxGuestBoot.Result {
    return LinuxGuestBoot.resolve(
      LinuxGuestBoot.Paths(
        filesDir = context.filesDir,
        nativeLibraryDir = File(context.applicationInfo.nativeLibraryDir),
        homeDir = homeDir,
        port = port,
      ),
    )
  }

  /**
   * 启动客体引擎。只预载壳侧私有 HTTP 中继模块，不注入 Termux 执行兼容层，
   * 只把 API key/版本等与平台无关的变量带进 PRoot；平台路径类变量一律用客体值。
   */
  private fun startGuestWithLaunch(launch: LinuxGuestBoot.Launch): Process {
    val log = File(context.filesDir, "engine.log")
    rotateEngineLog(log)
    if (log.exists()) throw java.io.IOException("could not isolate engine.log generation before spawn")
    runCatching { EngineAuth.markGenerationStart(System.currentTimeMillis()) }
    LogCollector.markBootStart(context, engineHeapMb(deviceTotalRamMb()))
    watchEngineListen()
    val guestEnv = mapOf(
      // 引擎的终端工具按 SHELL 拉起用户 shell：这里必须是客体 Debian 的 bash，
      // 否则 subprocess-local 会退回 Android/宿主路径。
      "SHELL" to "/bin/bash",
      "TERM" to "xterm-256color",
      // 与旧 Termux 路径保持同一组资源策略：堆上限、线程池与 pnpm store 都在 shell 侧钉死，
      // 只是路径改成客体可见的 $HOME 下（home 目录已 bind 进 PRoot）。
      "NODE_OPTIONS" to heapOptionFrom(engineHeapMb(deviceTotalRamMb())),
      "UV_THREADPOOL_SIZE" to uvThreadPoolSize(Runtime.getRuntime().availableProcessors()).toString(),
      "npm_config_store_dir" to pnpmStoreDir(homeDir),
      "DSH_APP_VERSION" to BuildConfig.VERSION_NAME,
      "DSH_APP_VERSION_CODE" to BuildConfig.VERSION_CODE.toString(),
      "DSH_FILES_DIR" to context.filesDir.absolutePath,
      "DSH_HOME" to ensurePrivateDshData().absolutePath,
      "DSH_PICK_TOKEN" to (pickToken ?: ""),
      "DEEPSEEK_API_KEY" to (File(context.filesDir, "deepseek-key.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""),
      "DASHSCOPE_API_KEY" to (File(context.filesDir, "dashscope-key.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""),
    )
    val privateLaunch = LinuxGuestBoot.withPrivateTransport(launch, EngineTransport.preparePreload(context))
    val guestLaunch = LinuxGuestBoot.withEnvironment(privateLaunch, guestEnv)
    val process = ProcessBuilder(guestLaunch.argv).also { builder ->
      builder.environment().putAll(guestLaunch.env)
      if (launch.workingDirectory.isDirectory) builder.directory(launch.workingDirectory)
      builder.redirectErrorStream(true)
      builder.redirectOutput(log)
    }.start()
    if (!log.isFile) {
      runCatching { process.destroyForcibly() }
      throw java.io.IOException("guest engine spawn did not create a fresh engine.log")
    }
    return process
  }

  /**
   * 0.13.1 W3：engine.log 世代轮转（保留 3 代）——redirectOutput 语义是每次启动截断，
   * 看门狗 5s 循环重启时崩溃现场每次被清掉，用户永远只剩最后一次的输出。
   */
  /**
   * P-AC-04：监听段（t_listen）观察者。
   *
   * 引擎可被**任何**路径拉起（Activity 启动流 / EngineService 看门狗 / ConsoleActivity），
   * 所以「Web 端口首次应答」的观测挂在 spawn 点而不是某一条启动流里，否则看门狗重启的世代
   * 永远没有 t_listen。单线程、有界 [LISTEN_WATCH_WINDOW_MS]（与冷启动预算同量级）后自然退出。
   *
   * **0.14.8 修尺子（自适应步进）**：旧实现是「固定 sleep(500) + portReachable(500)」，
   * 于是 t_listen 的量化误差恒为 [0,500)（均值 250ms）——而 loopback 上「无人监听」是**立即
   * refused**，固定节拍不为任何真实开销买单，纯粹是采样栅格。现按 [nextListenProbeDelayMs]
   * 步进（20ms 起步、1.5 几何退避、[LISTEN_PROBE_MAX_STEP_MS] 封顶），单次 connect 预算同步
   * 压到 [LISTEN_PROBE_CONNECT_TIMEOUT_MS] 并再对剩余窗口取 min（超时值只影响异常情形：
   * 丢包/防火墙；connect 超时传 0 在 Java Socket 上是**无限等待**，故必须 ≥ 1）。
   *
   * 窗口、线程名、markListen 幂等与 daemon 属性全部保持不变。
   */
  private fun watchEngineListen() {
    Thread {
      val deadline = System.currentTimeMillis() + LISTEN_WATCH_WINDOW_MS
      var attempt = 0
      while (true) {
        val remaining = deadline - System.currentTimeMillis()
        if (remaining <= 0L) return@Thread
        val connectTimeoutMs = minOf(LISTEN_PROBE_CONNECT_TIMEOUT_MS, remaining).toInt()
        if (EngineProbe.portReachable(connectTimeoutMs)) {
          LogCollector.markListen(context)
          return@Thread
        }
        val step = nextListenProbeDelayMs(attempt)
        // 下一次探测会落到窗口之外：不必先睡满再判——否则线程会越过 deadline 才退出。
        if (step >= remaining) return@Thread
        try {
          Thread.sleep(step.toLong())
        } catch (_: InterruptedException) {
          return@Thread
        }
        attempt++
      }
    }.apply { isDaemon = true; name = "dsh-engine-listen-watch" }.start()
  }

  private fun rotateEngineLog(log: File) {
    try {
      // review C5：旧实现只保 3 代（log/.1/.2）——后台崩溃循环（看门狗每 5s 一拍、常态重启不一定
      // 镜像诊断）会把首个崩溃现场滚掉，直接影响 #228 这类须看原始 engine.log 的取证。
      // 现保 5 代；镜像与诊断包同步遍历全部世代（见 mirrorDiagnosticsToShared）。
      val parent = log.parentFile ?: return
      SnapshotFs.deletePath(File(parent, "engine.log.$ENGINE_LOG_GENERATIONS"))
      for (i in (ENGINE_LOG_GENERATIONS - 1) downTo 1) {
        val from = File(parent, "engine.log.$i")
        if (from.exists()) from.renameTo(File(parent, "engine.log." + (i + 1)))
      }
      if (log.exists()) log.renameTo(File(parent, "engine.log.1"))
    } catch (t: Throwable) {
      Log.w(TAG, "engine.log rotation failed", t)
    }
  }

  /** 0.13.1 W3：最近一次死亡的引擎进程退出码（进程活着或句柄丢失时返回 null）。 */
  fun engineExitInfo(): String? {
    val held = engineProcess ?: return null
    if (held.isAlive) return null
    return try {
      "exit=" + held.exitValue()
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * 0.13.1 W3：失败诊断镜像（best-effort，绝不抛出）。把 engine.log 全世代 + 退出码 +
   * 环境/设备信息 + 最近 logcat 写入共享目录 Documents/dshdata/diagnostics/<时间戳>-<原因>/，
   * 用户用文件管理器即可直接复制去反馈（此前全在私有目录，失败时外界拿不到任何现场）。
   * 触发点：spawn 失败 / 进程死亡 / 健康检查超时 / 快照解压失败 / UndoGate 急救。
   */
  fun mirrorDiagnosticsToShared(reason: String): File? {
    try {
      val ts = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
      val name = ts + "-" + reason
      // review C5：共享目录不可写（未授权 All Files Access，issue #228 环境）→ 回退应用私有
      // filesDir/diagnostics/，界面按**实际路径**回填。旧实现 mkdirs 失败静默 return，
      // 界面却写死「诊断包已存至 Documents/dshdata/diagnostics」——用户去 Documents 找不到现场。
      val sharedDir = File(File(dshDataDir, "diagnostics"), name)
      val privateDir = File(File(context.filesDir, "diagnostics"), name)
      val dir = when {
        ensureDirectory(sharedDir) -> sharedDir
        ensureDirectory(privateDir) -> {
          LogCollector.log(TAG, "diagnostics mirror: shared storage not writable, using app-private fallback")
          privateDir
        }
        else -> {
          Log.w(TAG, "diagnostics mirror skipped: no writable diagnostics directory")
          return null
        }
      }
      val log = File(context.filesDir, "engine.log")
      // 0.13.8 #184：诊断包落共享存储（任何持 All Files Access 的应用可读），engine.log
      // 内含引擎 launch token——副本先过 redact，本体不动（壳侧鉴权链 tokenFromLog 依赖）。
      // #211.3：有界读——原先 readText() → redact → writeText() 的峰值约 3× 单份日志
      // （多 GB 的 engine.log 会 OOM/卡死看门狗线程）；现在按上限读尾部并标注截断。
      // review C5：遍历全部轮转世代（现为 5 代），崩溃循环的现场不再在取证前被滚掉。
      val generations = ArrayList<File>(ENGINE_LOG_GENERATIONS + 1)
      generations += log
      for (i in 1..ENGINE_LOG_GENERATIONS) generations += File(log.parentFile, "engine.log.$i")
      for (f in generations) {
        try {
          mirrorLogBounded(f, File(dir, f.name), MIRROR_LOG_LIMIT_BYTES)
        } catch (_: Throwable) {
        }
      }
      try {
        val file = File(dir, "info.txt")
        val safe = LogSanitizer.sanitizeOrNull(buildDiagnosticsText(reason))
        if (safe == null) file.delete() else file.writeText(safe)
      } catch (_: Throwable) {
      }
      try {
        val p = ProcessBuilder("logcat", "-d", "-v", "threadtime", "-t", "400").redirectErrorStream(true).start()
        // 0.13.8 #173：有界读（原 readBytes 无 waitFor，会冻结看门狗调度线程）
        // #211.1：三态结果——超时态写形态标记（不再把已读部分/超时混成同一形态）。
        val out = ProcIo.readBounded(p, 10)
        val body = out.textWithMarkers()
        if (body.isNotEmpty()) {
          val file = File(dir, "logcat-recent.txt")
          val safe = LogSanitizer.sanitizeOrNull(body)
          if (safe == null) file.delete() else file.writeText(safe)
        }
      } catch (_: Throwable) {
      }
      LogCollector.log(TAG, "diagnostics mirrored: " + dir.absolutePath)
      return dir
    } catch (t: Throwable) {
      Log.w(TAG, "diagnostics mirror failed", t)
      return null
    }
  }

  /** mkdirs 语义修正：已存在目录也算成功（mkdirs 对已存在返回 false，会被误判不可写）。 */
  private fun ensureDirectory(dir: File): Boolean = try {
    if (dir.isDirectory) true else dir.mkdirs() || dir.isDirectory
  } catch (_: Throwable) {
    false
  }

  private fun buildDiagnosticsText(reason: String): String {
    val sb = StringBuilder()
    sb.append("reason: ").append(reason).append('\n')
    sb.append("time: ").append(java.util.Date().toString()).append('\n')
    try {
      sb.append("app: ").append(BuildConfig.VERSION_NAME).append(" (versionCode ").append(BuildConfig.VERSION_CODE).append(")\n")
    } catch (_: Throwable) {
    }
    sb.append("device: ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL)
      .append(" / Android ").append(android.os.Build.VERSION.SDK_INT).append('\n')
    sb.append("abi: ").append(android.os.Build.SUPPORTED_ABIS.joinToString(",")).append('\n')
    sb.append("linux_instance_ready: ").append(linuxInstanceReady()).append('\n')
    engineExitInfo()?.let { sb.append("engine_exit: ").append(it).append('\n') }
    // task-79（Bug A）：运行时树损坏标记的**读取方**。
    // 为什么必须有人读它：`engine.log` 每次 spawn 被 redirectOutput 截断，所以「我们曾判定树损坏并触发
    // 重抽取」这件事只能落在壳侧标记里；没有读取方的话它就是死账本——事后既无法证明它被写过，
    // 也进不了诊断包。这里把它带进 info.txt（存在才有该行），于是失败现场自带这一条事实。
    // issue #309：把「闸门 A 为什么拒启、当时缺了什么」也带进诊断包。
    // 为什么必须进包：唯一的恢复动作（删指纹 + 全量重抽取）会覆盖现场；拒启取证如果只留在
    // logcat/boot-fail.log，用户取包反馈时就没有这条已整理好的事实。两个字段同源同上一次拒启。
    lastStartRefusalCode?.let { sb.append("start_refusal_code: ").append(it).append('\n') }
    if (lastStartRefusalConfirmed.isNotEmpty()) {
      sb.append("start_refusal_confirmed: ").append(lastStartRefusalConfirmed.joinToString(", ")).append('\n')
    }
    lastStartRefusalEvidence?.let { sb.append("start_refusal_evidence: ").append(it).append('\n') }
    // 0.14.1 块C §2.4：WebView 版本与语法下限判据进诊断包。
    // 为什么也进诊断包（而不只进 boot-diag.log）：老设备白屏时页面跑不起来，用户必须能**自助**取到
    // 「我的 WebView 版本够不够」这一个结论，而不必先跑到页面上看。
    // 字段名与 MainActivity 在 boot-diag.log 里用的**逐字一致**，便于两处对账。
    // 取值口径同源：统一走 WebViewShim（provider 回读唯一实现）。
    try {
      val providerVersion = WebViewShim.providerVersionName()
      // 这里的「读不到」哨兵保留 -1（显式缺席）；与 MainActivity 判据侧的 0 口径不同是有意的：
      // 判据侧 0 不冒充通过，诊断包侧 -1 强调「连版本名都没拿到」。
      val chromiumVersion = MainActivity.observedChromiumVersion
      val major = if (chromiumVersion.isEmpty()) -1 else WebViewShim.majorOf(chromiumVersion)
      sb.append("webview_package: ").append(WebViewShim.providerPackageName()).append('\n')
      // provider 缺席（无 WebView ROM / 升级窗口）与「版本串解析失败」含义不同，单列一项。
      sb.append("webview_provider_available: ").append(WebViewShim.providerAvailable()).append('\n')
      sb.append("webview_provider_version: ").append(providerVersion).append('\n')
      sb.append("webview_version: ").append(chromiumVersion).append('\n')
      sb.append("webview_major: ").append(major).append('\n')
      // 语法下限 94（Chromium 94 起才有类静态块 static{}；低于它入口 chunk 解析即整体不执行 = 纯白无字）。
      val syntaxFloor = WebViewShim.syntaxFloorStatus(chromiumVersion, MainActivity.WEBVIEW_SYNTAX_FLOOR_MAJOR)
      sb.append("syntax_floor_ok: ").append(syntaxFloor).append('\n')
    } catch (_: Throwable) {
      // 诊断本身不得成为故障源；字段缺席好过抛异常。
    }
    try {
      val probe = EngineProbe.check(500)
      sb.append("probe: ").append(probe.toString()).append('\n')
    } catch (_: Throwable) {
    }
    return sb.toString()
  }

  /**
   * 0.13.1 W5：settings.yaml 坏键迁移。0.13.0 出厂 seed 的 `llm-deepseek:` 裸键（YAML null）
   * 会被首启持久化；fx-1 只修了 APK 内出厂模板，覆盖安装升级的设备上存量坏配置仍在——
   * 引擎 settings section() 抛 TypeError 且被插件加载器吞掉（engine.log 零痕迹），表现为
   * 模型页提供方列表空白 + 「添加提供方」点击无响应（2026-08-28 模拟器双向复现实锤）。
   * 启动前把已知坏裸键修复为空对象；幂等、只触碰已知键、失败不阻塞启动。
   * 判定必须带前瞻：裸键后紧跟缩进子键 = 合法映射（非 null），绝不能改——否则插入重复键
   * DUPLICATE_KEY 直接炸引擎（2026-08-28 首版修复在 fx-1 正常文件上翻车实录）。
   */
  /**
   * 0.14.0 #214 一次性迁移（启动前置）：清除**退役行**残留的 `disabled: true`。
   *
   * 现场：从「曾禁用 ui-layout」的旧版本升上来的设备，live 的
   * `profiles/web/cordis.patch.yml` 里 `- id: ui-layout / disabled: true` 被 0.13.8 的
   * profiles 合并规则永久保留（旧规则「live 内容为基，只追加缺失工厂块」），上游 bundle 的
   * ui-layout 行（布局服务中枢）因此被禁 → 根服务 `layout` 不 activate → 13 条客户端插件全
   * pending（apk #214 截图现场）。这类设备不一定再触发快照刷新（指纹未变则 merge 不跑），
   * 所以自愈必须在引擎读 profile 之前做一次，不能只依赖 [refreshSnapshot]。
   *
   * 边界（与 [FactoryProfilePatch] 一致）：只清退役行 id 的 `disabled: true`；不新增任何
   * disable；用户独有条目与自建 profile 条目不动；改前留同步校验的唯一同目录 `.pre-<版本>-<随机>.bak`（回滚路径）；
   * 改动逐条进开发日志；每版本只跑一次（幂等标记），失败不阻塞启动。
   */
  private fun repairProfilePatch() {
    // 两条**独立**的自愈，各自有自己的幂等标记：
    //  · 退役行 disabled 残留（apk #214）：标记 .profile-patch-repair-<version>；
    //  · 旧「单点」写法归一（0.14.2-fx-2，见 normalizeLegacyAgentDefaultModel）：标记 .profile-patch-normalize-<version>。
    //
    // **为什么必须独立标记**：本函数原先的早退（marker.exists()）语义是「本版本已修退役行」。
    // 若归一复用同一标记，则**已经装过同版本**的设备永远补不上这次新修复 —— 实测踩到：
    // 两台设备在装上含归一的包后，`merge` 因指纹已 fresh 而不跑、本函数因标记已存在而早退，
    // 于是 live patch 冷启动两次 md5 都不变（归一从未执行）。
    //
    // 更一般的教训（既有注释里已写过一次，见本文件下方 #214 段落）：
    // 「这类设备不一定再触发快照刷新（指纹未变则 merge 不跑），所以自愈必须在引擎读 profile
    //   之前做一次，不能只依赖 refreshSnapshot」—— 新增修复同样必须走这条通道。
    normalizeLegacySinglePointPatch()
    val marker = File(context.filesDir, ".profile-patch-repair-" + BuildConfig.VERSION_NAME)
    if (marker.exists()) return
    var failed = false
    try {
      val profilesRoot = File(File(homeDir, ".dsh"), "profiles")
      // review C8：只处置**工厂拥有的 profile**（出厂 seed 的 package.json 形态：name=dsh-profile-* +
      // dsh.profile 块）。旧实现遍历 profilesRoot 下全部目录，连用户自建 profile 也一并改写。
      val targets = (profilesRoot.listFiles() ?: emptyArray())
        .sortedBy { it.name }
        .filter { isFactoryOwnedProfile(it) }
        .map { File(it, "cordis.patch.yml") }
        .filter { it.isFile }
      var repaired = 0
      for (target in targets) {
        val liveBytes = try { target.readBytes() } catch (_: Throwable) { failed = true; continue }
        val live = String(liveBytes, Charsets.UTF_8)
        val result = FactoryProfilePatch.repairRetiredDisabledRows(live)
        if (result.text == live) continue
        // 解析校验（review C8）：只允许移除退役行——其余 id 集合必须原样保留，否则不写。
        val before = FactoryProfilePatch.blockIds(live).toSet()
        val after = FactoryProfilePatch.blockIds(result.text).toSet()
        if (!after.containsAll(before - FactoryProfilePatch.RETIRED_DISABLED_ROW_IDS)) {
          Log.w(TAG, "profile patch repair skipped (parse check failed): " + target.absolutePath)
          failed = true
          continue
        }
        val backupPrefix = target.name + ".pre-" + BuildConfig.VERSION_NAME + "-"
        try {
          // 每次尝试都先同步、验 bytes 并保留一个唯一回滚副本；两次发布均只走同目录 move。
          val backup = SnapshotFs.replaceWithVerifiedBackup(
            target,
            result.text.toByteArray(Charsets.UTF_8),
            backupPrefix,
            liveBytes,
          )
          repaired++
          LogCollector.log(
            TAG,
            "profile patch repaired (" + (target.parentFile?.name ?: "?") + "): " +
              result.changes.joinToString(" | ") + " ; backup=" + backup.name,
          )
        } catch (t: Throwable) {
          failed = true
          Log.w(TAG, "profile patch repair write failed (retried next boot): " + target.absolutePath, t)
          continue
        }
      }
      if (failed) {
        // review C8：部分失败不写 marker → 下次启动重试（旧实现失败后本版内不再重试）。
        LogCollector.log(TAG, "profile patch repair deferred (partial failure; retried next start)")
      } else {
        marker.writeText("repaired=" + repaired + " targets=" + targets.size + " at " + System.currentTimeMillis() + "\n")
        if (repaired > 0) {
          LogCollector.log(TAG, "profile patch repair (apk #214): " + repaired + " profile(s) cleaned; marker=" + marker.name)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "profile patch repair failed (non-fatal)", t)
    }
  }

  /**
   * 旧「单点」写法归一（0.14.2-fx-2）的**启动前置**通道。
   *
   * 为什么不能只挂在 [FactoryProfilePatch.merge]：那条链只在**快照刷新**时跑
   * （`if (snapshotFresh()) return true` 早退）—— 指纹已 fresh 的设备永远拿不到修复。
   * 实测：两台设备装上含归一的包后，冷启动两次 live patch md5 均不变。
   *
   * 安全面：沿用本函数既有的三件套（唯一的 `.pre-<version>-*.bak` 验证备份 / 原子写 / 解析校验），
   * 不新增第二条落盘路径。
   *
   * 幂等：**独立**标记 `.profile-patch-normalize-<version>`（不复用退役行那个标记）。
   * 失败不写标记 ⇒ 下次启动重试；异常一律不阻塞启动。
   */
  private fun normalizeLegacySinglePointPatch() {
    val marker = File(context.filesDir, ".profile-patch-normalize-" + BuildConfig.VERSION_NAME)
    if (marker.exists()) return
    var failed = false
    var normalized = 0
    try {
      val profilesRoot = File(File(homeDir, ".dsh"), "profiles")
      val targets = (profilesRoot.listFiles() ?: emptyArray())
        .sortedBy { it.name }
        .filter { isFactoryOwnedProfile(it) }
        .map { File(it, "cordis.patch.yml") }
        .filter { it.isFile }
      for (target in targets) {
        val liveBytes = try { target.readBytes() } catch (_: Throwable) { failed = true; continue }
        val live = String(liveBytes, Charsets.UTF_8)
        if (FactoryProfilePatch.legacyMobileConfigLines(live).isEmpty()) continue // 不满足形态 ⇒ 不动
        val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(live)
        if (result.text == live) continue // 条件不满足 ⇒ 零改动
        // 结构化校验（Lead 四条）：id 集合、上游无 disabled、用户 config 逐行保留、可解析。
        val why = FactoryProfilePatch.verifyNormalization(live, result.text)
        if (why != null) {
          Log.w(TAG, "profile patch normalize skipped (verify failed): " + target.absolutePath + " -> " + why)
          failed = true
          continue
        }
        val backup = try {
          SnapshotFs.replaceWithVerifiedBackup(
            target,
            result.text.toByteArray(Charsets.UTF_8),
            target.name + ".pre-" + BuildConfig.VERSION_NAME + "-",
            liveBytes,
          )
        } catch (t: Throwable) {
          failed = true
          Log.w(TAG, "profile patch normalize write failed (retried next boot): " + target.absolutePath, t)
          continue
        }
        normalized++
        LogCollector.log(
          TAG,
          "profile patch normalized (" + (target.parentFile?.name ?: "?") + "): " +
            result.changes.joinToString(" | ") + " ; backup=" + backup.name,
        )
      }
      if (failed) {
        LogCollector.log(TAG, "profile patch normalize deferred (partial failure; retried next start)")
      } else {
        marker.writeText("normalized=" + normalized + " targets=" + targets.size + " at " + System.currentTimeMillis() + "\n")
        if (normalized > 0) {
          LogCollector.log(TAG, "profile patch normalize (0.14.2-fx-2): " + normalized + " profile(s) migrated; marker=" + marker.name)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "profile patch normalize failed (non-fatal)", t)
    }
  }

  /** review C8：工厂拥有的 profile = 出厂 seed 形态（name=dsh-profile-* 且带 dsh.profile 块）。 */
  private fun isFactoryOwnedProfile(profileDir: File): Boolean {
    val pkg = File(profileDir, "package.json")
    if (!pkg.isFile) return false
    return try {
      val json = org.json.JSONObject(pkg.readText())
      json.optString("name").startsWith("dsh-profile-") &&
        json.optJSONObject("dsh")?.optJSONObject("profile") != null
    } catch (_: Throwable) {
      false
    }
  }

  private fun repairSettingsSeed() {
    try {
      val f = File(File(homeDir, ".dsh"), "settings.yaml")
      if (!f.exists()) return
      val src = f.readText()
      val lines = src.split("\n")
      val out = StringBuilder(src.length + 32)
      var changed = false
      for (i in lines.indices) {
        val line = lines[i]
        val m = Regex("^(llm-deepseek|llm-pi-ai):([ \t]*(#.*)?)$").find(line)
        if (m == null) {
          out.append(line).append('\n')
          continue
        }
        // 前瞻下一个非空行：缩进子键 = 合法映射（非 null），跳过不改。
        // 注意：缩进的【注释行】不构成子键（YAML 注释不参与结构）——fx-1 升级真机的存量
        // 坏 seed 正是「裸键 + 缩进注释」形态（2026-08-29 真机活体实锤），必须穿透注释继续判定。
        val next = lines.drop(i + 1)
          .firstOrNull { it.isNotBlank() && !it.trimStart().startsWith("#") }
        if (next != null && (next.startsWith(" ") || next.startsWith("\t"))) {
          out.append(line).append('\n')
          continue
        }
        when (m.groupValues[1]) {
          "llm-deepseek" -> out.append("llm-deepseek: {}")
          else -> out.append("llm-pi-ai:\n  providers: {}")
        }
        changed = true
        // 保留原行尾注释（如有）。
        val comment = m.groupValues[2]
        if (comment.isNotBlank()) out.append(' ').append(comment.trimStart())
        out.append('\n')
      }
      val fixed = out.toString().removeSuffix("\n")
      if (changed && fixed != src) {
        f.writeText(fixed)
        LogCollector.log(TAG, "settings.yaml repaired: bare null key -> object (0.13.0 seed migration)")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "settings.yaml repair failed (non-fatal)", t)
    }
  }

  /** Stop the engine process (best-effort). */
  fun stopEngine() {
    engineProcess?.destroy()
    engineProcess = null
    LogCollector.log(TAG, "engine stopped (manual)")
    // Reset the cooldown after a manual stop: returning to the foreground should allow an immediate restart.
    EngineManager.lastStartAttemptAt = 0
  }

  /** Ownership-aware HTTP/log/process probe used by startup, restart and auth recovery. */
  fun probeAvailability(timeoutMs: Int = 1_000): EngineProbe.EngineAvailability {
    val httpCode = runCatching { EngineProbe.check(timeoutMs).optInt("code", -1) }.getOrDefault(-1)
    val managedAlive = engineProcess?.isAlive == true
    val tokenLine = runCatching { EngineAuth.tokenFromLog(context) != null }.getOrDefault(false)
    val reachable = EngineProbe.portReachable(timeoutMs)
    return EngineProbe.classifyEngineAvailability(httpCode, managedAlive, tokenLine, reachable).also {
      lastAvailability = it
    }
  }

  /** Stop only this process-owned child; an inferred HTTP listener is never kill authority. */
  fun stopOwnedEngine(): Boolean {
    val availability = probeAvailability(500)
    val trackedAlive = engineProcess?.isAlive == true
    if (availability == EngineProbe.EngineAvailability.PORT_FOREIGN ||
      (availability == EngineProbe.EngineAvailability.OUR_HTTP && !trackedAlive)) {
      lastStartRefusal = "端口监听进程没有本壳持有的子进程句柄；为保护未归属进程，拒绝停止或重启"
      LogCollector.log(TAG, "stop refused (unowned listener: " + availability + ")")
      return false
    }
    if (!trackedAlive) return !EngineProbe.portReachable(250)
    if (!EngineProbe.canStopTrackedEngine(availability, trackedAlive)) return false
    return killExistingEngine()
  }

  /**
   * EngineProcessAlive retains its historical watchdog semantics: a reachable TCP port is enough
   * to defer cold-start timeout; destructive actions must use [probeAvailability] instead.
   */
  fun engineProcessAlive(): Boolean {
    val held = engineProcess
    if (held != null && held.isAlive) return true
    if (held == null) {
      // 句柄丢失（看门狗曾被 fork 或孤儿）：以端口可达性兜底判定。
      // #118 根因3（2026-09）：HTTP 未就绪 ≠ 引擎死亡（冷启动/慢响应实测 3061ms），
      // 必须用端口级 TCP 判定，否则兜底探活把启动中的引擎误判死亡 → 误生成诊断包。
      return EngineProbe.portReachable(1000)
    }
    return false
  }

  /** Activity boot polling also waits for another manager's accepted pre-spawn request.
   * This is separate from process liveness: watchdog/ownership callers must never
   * treat an in-flight request as evidence that a child exists. */
  internal fun engineBootMayContinue(): Boolean = observeBootContinuation(
    startupInProgress = { STARTING.get() },
    processAlive = { engineProcessAlive() },
  )

  /**
   * Terminate only the tracked child process. We intentionally do not use pkill: a process-name
   * match cannot prove ownership and could kill an unrelated listener. The port must be observed
   * released before a caller is allowed to spawn a replacement.
   */
  private fun killExistingEngine(): Boolean {
    val held = engineProcess
    if (held == null && EngineProbe.portReachable(250)) {
      LogCollector.log(TAG, "killExistingEngine refused: reachable port has no tracked child")
      return false
    }
    if (held != null && held.isAlive) {
      try {
        held.destroy()
        if (!held.waitFor(6, java.util.concurrent.TimeUnit.SECONDS)) {
          held.destroyForcibly()
          held.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
        }
      } catch (_: Throwable) {
      }
    }
    if (held != null && !held.isAlive) engineProcess = null
    repeat(5) {
      if (!EngineProbe.portReachable(250)) return true
      try { Thread.sleep(1_000) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); return false }
    }
    LogCollector.log(TAG, "killExistingEngine: port 3080 remains occupied; refusing spawn")
    return false
  }

  /** Reset the 90s cooldown window: auto-undo (config rollback) or user retry
   *  must be allowed to start the engine immediately. Manual stop already does this. */
  fun resetCooldown() {
    EngineManager.lastStartAttemptAt = 0
  }

  /**
   * Update-manager-v2 probe state machine (PRD F3.2/F1.10): after an online
   * snapshot swap, `usr-old` is kept and `.update-pending` is set. Each engine
   * probe result feeds this: N consecutive healthy ticks finalize (delete the
   * old runtime); a pending window that never turns healthy rolls back to the
   * previous runtime (second-layer fallback; the F3 plugin layer stays in
   * charge of config/plugin-code rollbacks). Never throws.
   */
  /** Component upgrades are committed only after the isolated Linux trial; no snapshot health swaps remain. */
  fun onEngineProbe(healthy: Boolean) {
    if (healthy) LogCollector.log(TAG, "Linux engine health observed")
  }

  private fun deviceTotalRamMb(): Int {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return 0
    return try {
      val info = ActivityManager.MemoryInfo()
      am.getMemoryInfo(info)
      (info.totalMem / (1024L * 1024L)).toInt()
    } catch (_: Throwable) {
      0
    }
  }

  /**
   * Snapshot environment shared by engine/console/log processes (PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/
   * TERMUX_* injected explicitly — the snapshot is self-sufficient, no Termux app needed). Idempotent:
   * safe to call repeatedly (ensurePrivateDshData and the TMPDIR mkdirs are both idempotent).
   */
  /** Move user-installed packages away from usr, which is replaced as a whole on refresh. */
  companion object {
    private const val TAG = "dsh-engine"

    /**
     * #130-2：手机操控预设自带的 skill——把 0.13.5 现场实测的流程与纪律固定下来
     * （无障碍/DOM 优先、先验前台、按 ref 而非盲点坐标、动作后必校验、输入单次注入并回读）。
     */
    private val PHONE_CONTROL_SKILL = """
---
name: phone-control
description: 手机操控纪律：无障碍语义树优先、ref 语义点击/输入、动作后必校验、禁止盲点坐标与绕路。
---
# 手机操控流程（DSH 设备控制）

## 固定顺序
1. 会话档位必须是 danger-full-access，否则设备工具一律拒绝（切换入口：会话底部权限芯片 → 完全权限；**不要试图让工具自己提权**，也不要用 Termux/ADB 绕路）。
2. 长流程开始前跑一次 android_env_prepare（关动画 + 启用内嵌 ADB 键盘），之后 dump/tap 更稳。
3. 感知：android_ui_dump（无障碍语义树，首选）→ 若结果是 WebView 容器或目标是 DSH 自己的 Web UI，改用 android_web_dump（DOM 快照）。
4. 卡住时：**先 android_ui_global back**（返回上一级），或 home 回桌面重新进入——子菜单/弹窗/详情页出不来时这是第一步。
5. 动作：android_ui_click / android_ui_input，引用用 ref（id:nN / text:精确文本#k / desc: / rid: / wN / css: / text: / role:）。
6. 校验：工具自带回执（点击回报「已生效 / 未观察到界面变化」；输入回报「回读一致 / 未落地」）——不要假设动作成功。
7. 需要看画面时用 android_screenshot（图像直接随结果返回，不需要再 read_image）。

## 纪律
- 禁止盲点坐标点击；nx/ny 仅作兜底，且必须说明理由。
- 同名节点必须消歧：用 dump 里的 #k 序号（text:设置#2）。
- 抓到的包名与前台不一致时以 dumpsys 为准（uiautomator/无障碍可能抓到覆盖层）。
- 输入只走单次注入 + 回读断言；不要用 keyevent 打字母（中文 IME 会汉字化），不要拆成多段输入。
- dump 失败（重 UI / 播放页常见）时按提示走：先 back 退出重页面，或截图看画面；**不要转去尝试 Termux 或 ADB**（未配对时那条路不存在，只会浪费轮次）。
- 连续两次动作未产生预期变化时停下来重新 dump，并如实汇报当前界面状态，不要继续猜测。
"""

    /** Healthy ticks (each 5s watchdog poll) required before the update-v2 finalize deletes usr-old. */
    const val UPDATE_CONFIRM_TICKS = 3

    /** Pending window before an unhealthy runtime is rolled back (PRD F3: recovery ≤ 3 min). */
    const val UPDATE_ROLLBACK_MS = 180_000L

    /** Watchdog/retry backoff: no new start within this window of the last
     *  attempt. Cold node boot on the phone takes 20-45s (plugin tree + first
     *  bind); a 5s watchdog poll would otherwise race a healthy boot and
     *  double-start the engine (device-observed EADDRINUSE). 90s covers the
     *  slowest observed boot with margin. */
    const val START_COOLDOWN_MS = 90_000L

  const val REFUSAL_PORT_FOREIGN = "port-foreign"
  const val REFUSAL_PRIVATE_STORAGE_DENIED = "private-storage-denied"
  const val REFUSAL_STORAGE_FULL = "storage-full"
  const val REFUSAL_RUNTIME_UNAVAILABLE = "runtime-unavailable"

  /**
   * 拒绝启动原因码：live 运行时树残缺（issue #309）。
   *
   * 语义 = 「这棵树需要重抽取才能起来」，与端口占用一类**不可**通过重抽取解决的原因区分开。
   * 调用方（EngineStartFlow 的拒启分支）据此触发一次删指纹 + 清账本的恢复动作。
   */
  const val REFUSAL_LIVE_RUNTIME_INCOMPLETE = "live-runtime-incomplete"

  /**
   * PRoot loader shim 的致命加载失败码（issue #322）：程序在任何用户代码之前退出、无输出。
   * 该退出不产生副作用，因此允许在引擎启动时重试一次；连续两次即拒启并给出专属原因码。
   */
  const val GUEST_LOADER_FAILURE_EXIT = 182

  /** Refusal code: the guest loader failed before the engine program started. */
  const val REFUSAL_GUEST_LOADER_FAILED = "linux-guest-loader-failed"

  /** Refusal code: Hard bundle ownership or installed identity could not be proven safely. */
  const val REFUSAL_HARD_BUNDLE_SELECTION = "hard-bundle-selection-unverified"

    /** Process handle shared by every EngineManager in the application process. */
    @Volatile
    private var sharedEngineProcess: Process? = null

    /** Process-level start CAS: visible across EngineManager instances (double-start race guard). */
    val STARTING = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Last real start time (epoch ms); the watchdog cooldown-window baseline. */
    @Volatile
    var lastStartAttemptAt: Long = 0

    /**
     * Process-level shared directory-picker auth token (C1 fix, 2026-08-16):
     * generated once, then reused by every EngineManager instance in the process — MainActivity
     * rebuilds and EngineService watchdog engine restarts never lose/rotate the token, so auth stays
     * consistent even after the engine-side fail-closed (empty token → reject) path.
     */
    @Volatile
    var sharedPickToken: String? = null

    /** Get (or generate on first call) the process-level pick token. */
    fun ensurePickToken(): String {
      sharedPickToken?.let { return it }
      val token = java.util.UUID.randomUUID().toString()
      sharedPickToken = token
      return token
    }
  }
}

/**
 * C1（P-AC-03 / §7.2）：libuv 线程池目标值 = min(8, cores)，下限 1（0/负数按 1 处理）。
 *
 * 提到顶层是为了可断言——shellEnv() 需要 Context，JVM 单测拿不到；这里只锁「值」这一半，
 * 「注入进 shellEnv()」那一半由 W3ShellContractTest 的源码扫描锁定。
 */
internal fun uvThreadPoolSize(cores: Int): Int = minOf(8, cores.coerceAtLeast(1))

/** 引擎 V8 老生代上限的**下限**（MB）。低于此值时引擎连 boot 期的模块图都可能堆爆。 */
internal const val ENGINE_HEAP_FLOOR_MB: Int = 512

/**
 * 引擎 V8 老生代上限的**上限**（MB）。
 *
 * 此值必须显著大于 [ENGINE_HEAP_NATURAL_MAX_FLAG_MB]（1024）。原上限 1024 恰等于重现 V8 自然推导
 * 最大值需要的标志值，导致 `totalRam/2` 在常见真机档位上恒被截断、函数退化为常量 1024。
 * 4096 让一半内存分支在 4GB 及以上设备真正生效（4GB→2048、6GB→3072、≥8GB→4096）。
 * 老生代上限是天花板而非预分配；lmkd 按真实 RSS 压力回收。设备级压力仍须实测。
 */
internal const val ENGINE_HEAP_CAP_MB: Int = 4096

/**
 * 重现 V8 自然推导最大上限所需的 `--max-old-space-size` 标志值（MB）。
 * V8 自然上限实测约 1120MB，标志 N 对应 heap_size_limit N+96MB，因此 N=1024。
 * 门禁以此为唯一真源，确保显式上限不会向下覆盖自然推导值并抵消自适应分支。
 */
internal const val ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 1024

/**
 * 引擎 V8 老生代上限（MB）= clamp(设备总内存的一半, 下限 [ENGINE_HEAP_FLOOR_MB], 上限 [ENGINE_HEAP_CAP_MB])。
 *
 * 为什么是「一半 + 上下限」而不是沿用 V8 的默认推导：V8 只用物理内存推，**没有任何人管这台设备上
 * 引擎的实际工作集**——小内存设备推出来的上限可能小于引擎 boot 所需（社区反馈的启动失败），
 * 大内存设备又可能推出远超需要的值。显式下限保证「任何设备都够启动」，4096MB 上限让常见真机
 * 档位的一半内存分支可达；老生代上限是天花板而非预分配，内存压力仍需在设备上按档位复核。
 *
 * 实测依据（逐档回读 heap_size_limit，详见 docs/AGENTS/gotchas.md 本轮条目）：
 * - 不设标志：6GB 设备 1120MB、4GB 设备 1075MB、3GB 设备 844MB（纯由物理内存推导）；
 * - 设 --max-old-space-size=N：实际上限恒为 N+96MB（512 到 608、256 到 352、2048 到 2144）；
 * - 引擎最小可用堆约 70MB（64MB 起步在约 21s 内 FATAL heap out of memory）。
 * 已实测的 3/4/6GB 档自然推导值分别约 844/1075/1120MB；上限 1024 对应 heap_size_limit 1120MB，
 * 会在所有常见设备上把自适应值钳成自然上限。见 [ENGINE_HEAP_NATURAL_MAX_FLAG_MB]。
 *
 * 提到顶层是为了可断言——shellEnv() 需要 Context，JVM 单测拿不到；这里只锁「值」这一半，
 * 「注入进 shellEnv()」那一半由 W3ShellContractTest 的源码扫描锁定（与 [uvThreadPoolSize] 同款）。
 */
internal fun engineHeapMb(totalRamMb: Int): Int {
  if (totalRamMb <= 0) return ENGINE_HEAP_FLOOR_MB
  return (totalRamMb / 2).coerceIn(ENGINE_HEAP_FLOOR_MB, ENGINE_HEAP_CAP_MB)
}

/** 由上限值装配 NODE_OPTIONS 的值。非法域按下限处理——宁可给足，不编造一个小于下限的标志。 */
internal fun heapOptionFrom(heapMb: Int): String =
  "--max-old-space-size=" + heapMb.coerceAtLeast(ENGINE_HEAP_FLOOR_MB)


/**
 * 0.14.1 块K ③（反馈三）：pnpm store 目录——**唯一真源**，与 HOME 同源派生。
 *
 * 为什么必须显式钉住：从 shell 执行 `dsh plugin add` 恒报 `ERR_PNPM_UNEXPECTED_STORE`
 * （node_modules 链自 `/data/user/0/…`，pnpm 想用 `/data/data/…`；用户实测两路径 inode 相同）。
 * 根因是 pnpm 按 CWD/HOME 自推 store 位置，而 Android 上 `/data/data/<pkg>` 与
 * `/data/user/0/<pkg>` 是同一目录的两种写法，字符串不等即被判「store 变了」而拒绝安装。
 * 显式给 `npm_config_store_dir` 后 pnpm 不再推导，两条路径必然是同一字符串。
 *
 * 口径与 pnpm 默认一致（`$HOME/.local/share/pnpm/store`），因此**不改动既有 store 位置**——
 * 已经安装好的 node_modules 元数据全部继续有效（改位置会引发一次全量重装）。
 * @param homeDir - 应用私有 HOME（= filesDir/home）。
 * @returns store 目录的绝对路径（不创建；pnpm 自己会在需要时建）。
 */
internal fun pnpmStoreDir(homeDir: File): String =
  File(File(File(homeDir, ".local"), "share"), "pnpm/store").absolutePath

/**
 * P-AC-04 修尺子（0.14.8）：监听观察窗口，与冷启动预算同量级；窗口本身**不改**。
 *
 * 观察者（[EngineManager.watchEngineListen]）在窗口内自适应步进，窗口外自然退出；
 * 该常量是窗口的唯一真源，同时被调度函数用于「剩余窗口」的计算。
 */
internal const val LISTEN_WATCH_WINDOW_MS: Long = 90_000L

/**
 * 单次 TCP connect 预算（P-AC-04 修尺子）。
 *
 * loopback 上「端口无人监听」是**立即 refused**，这个值只在异常情形（丢包 / 防火墙 /
 * 半开连接）才成为实际耗时。旧实现取 500ms = 与固定节拍同量级，等于把最坏情形写进预算；
 * 压到 150ms 后异常情形的单次代价有界，且远大于 loopback 的 refused 延迟。
 * **不得为 0**：Java 的 Socket.connect(addr, 0) 是无限等待。
 */
internal const val LISTEN_PROBE_CONNECT_TIMEOUT_MS: Long = 150L

/**
 * 探测步长上限（P-AC-04 修尺子）。
 *
 * 步长早期密、后期疏：上限越小，栅格越细、t_listen 的量化误差越小，代价是 90s 窗口内的
 * connect 次数（100ms 上限 ≈ 904 次 ≈ 10 次/秒；loopback refused 微秒级，可忽略）。
 *
 * 取 100 而非 500 的实测依据：500ms 栅格的采样滞后均值 247ms / 最大 497ms，100ms 栅格降到
 * 均值 49ms / 最大 97ms——旧实现的读数与真实监听时刻之间就隔着这一段，而设备实测
 * t_listen_ms 全程在 5~15s 间波动（没有「只在前段才需要精度」这回事）。
 */
internal const val LISTEN_PROBE_MAX_STEP_MS: Int = 100

/** 首次探测后等待的步长（第 0 次退避）：小步起步，让窗口前段的读数不被 500ms 栅格量化。 */
internal const val LISTEN_PROBE_START_STEP_MS: Int = 20

/** 步长几何增长比（1.5 ⇒ 20/30/45/67… 再封顶到 [LISTEN_PROBE_MAX_STEP_MS]）。 */
internal const val LISTEN_PROBE_GROWTH: Double = 1.5

/**
 * 自适应探测调度（P-AC-04 修尺子）：第 [attempt] 次探测**之后**应等待的毫秒数。
 *
 * 旧实现是固定 500ms 轮询，于是 t_listen 的量化误差恒为 [0,500)（均值 250ms；设备实测
 * t_listen_ms 在 8052~14866ms 间跳变，其中含这段采样栅格）。步长序列 20/20/30/45/67/100…
 * 抽成**顶层纯函数**（而非
 * private 成员）是为了让调度口径能被 JVM 单测直接钉住——[EngineManager] 需要 Context，
 * 单测拿不到。
 *
 * 契约（[EngineListenProbeScheduleTest] 逐条锁死）：
 * - attempt <= 0 一律返回 [LISTEN_PROBE_START_STEP_MS]（负值不得被放大成步长）；
 * - 步长单调不回退，且恒落在 [LISTEN_PROBE_START_STEP_MS, LISTEN_PROBE_MAX_STEP_MS]；
 * - 有限次退避后**精确**封顶到上限（不因浮点误差停在上限下方）；
 * - 序列总和覆盖整个 [LISTEN_WATCH_WINDOW_MS]，且覆盖所用探测次数有界。
 */
internal fun nextListenProbeDelayMs(attempt: Int): Int {
  if (attempt <= 0) return LISTEN_PROBE_START_STEP_MS
  val grown = LISTEN_PROBE_START_STEP_MS * Math.pow(LISTEN_PROBE_GROWTH, (attempt - 1).toDouble())
  return if (grown >= LISTEN_PROBE_MAX_STEP_MS) LISTEN_PROBE_MAX_STEP_MS else grown.toInt()
}

/** 诊断镜像的单份上限（#211.3）：只需现场尾部；内存峰值从 3× 整份压到 3× 上限内。 */
internal const val MIRROR_LOG_LIMIT_BYTES: Long = 2L * 1024 * 1024

/** engine.log 轮转保留世代数（review C5；旧为 2 代 + 本体 = 3 份，崩溃循环会滚掉首个现场）。 */
internal const val ENGINE_LOG_GENERATIONS = 5

/**
 * 诊断镜像的有界单份复制（#211.3，JVM 单测）：只读 [limitBytes] 上限内的**尾部**字节，
 * 出口过完整 [LogSanitizer]（launch token 与其他凭据都不进共享副本），超限在尾部标注截断。
 * 相比原来的 readText() → redact → writeText()（峰值约 3× 单份日志），这里既不再整份读入，
 * 也不把「读到一半」伪装成完整现场。绝不抛出。
 *
 * @return true = 写出了副本（源缺失/空/写入失败为 false）。
 */
internal fun mirrorLogBounded(src: File, dst: File, limitBytes: Long = MIRROR_LOG_LIMIT_BYTES): Boolean {
  return try {
    if (!src.exists() || !src.isFile) return false
    val len = src.length()
    val limit = limitBytes.coerceAtLeast(1L)
    val start = (len - limit).coerceAtLeast(0L)
    val size = (len - start).toInt()
    if (size <= 0) return false
    val buf = ByteArray(size)
    java.io.RandomAccessFile(src, "r").use { raf ->
      raf.seek(start)
      raf.readFully(buf)
    }
    var text = String(buf, Charsets.UTF_8)
    if (start > 0L) {
      text += "\n[diagnostic mirror truncated: first " + start + " bytes omitted; source " + len + " bytes]\n"
    }
    val safe = LogSanitizer.sanitizeOrNull(text) ?: run {
      dst.delete()
      return false
    }
    dst.writeText(safe)
    true
  } catch (_: Throwable) {
    false
  }
}

/**
 * Tracks DNS servers from Android's active default network for the Linux runtime.
 * The private file is read by the JS runtime manager for every new guest process;
 * it is not a stale resolver snapshot baked into the Debian rootfs.
 */
internal fun selectLinuxDnsServers(
  sdkInt: Int,
  privateDnsActive: Boolean,
  servers: List<java.net.InetAddress>,
): List<java.net.InetAddress> =
  if (sdkInt >= Build.VERSION_CODES.P && privateDnsActive) emptyList() else servers

private object LinuxDnsServers {
  private const val TAG = "LinuxDnsServers"
  private const val FILE_NAME = "linux-dns-servers"
  private val lock = Any()
  @Volatile private var callbackRegistered = false

  fun initialize(context: Context) {
    val appContext = context.applicationContext
    val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
    if (connectivity == null) {
      publishAddresses(appContext, emptyList())
      return
    }
    refresh(appContext, connectivity)
    if (callbackRegistered) return
    synchronized(lock) {
      if (callbackRegistered) return
      runCatching {
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) {
            val linkProperties = runCatching { connectivity.getLinkProperties(network) }.getOrNull()
            publishLinkPropertiesIfCurrent(appContext, connectivity, network, linkProperties)
          }

          override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            publishLinkPropertiesIfCurrent(appContext, connectivity, network, linkProperties)
          }

          override fun onLost(network: Network) {
            refresh(appContext, connectivity)
          }
        })
        callbackRegistered = true
      }
    }
  }

  fun refresh(context: Context) {
    // Re-enter initialize so a transient callback-registration failure can be
    // retried on the next engine environment refresh.
    initialize(context.applicationContext)
  }

  private fun refresh(context: Context, connectivity: ConnectivityManager) {
    val linkProperties = runCatching {
      val network = connectivity.activeNetwork
      network?.let(connectivity::getLinkProperties)
    }.getOrNull()
    publishLinkProperties(context, linkProperties)
  }

  private fun publishLinkProperties(context: Context, linkProperties: LinkProperties?) {
    // Android requires apps to keep DNS encrypted whenever Private DNS is in
    // use. PRoot currently passes classic resolver traffic through the guest,
    // so fail closed rather than bypass Android's encrypted DNS policy.
    val addresses = selectLinuxDnsServers(
      Build.VERSION.SDK_INT,
      linkProperties?.isPrivateDnsActive == true,
      linkProperties?.dnsServers.orEmpty(),
    )
    publishAddresses(context, addresses)
  }

  private fun publishLinkPropertiesIfCurrent(
    context: Context,
    connectivity: ConnectivityManager,
    network: Network,
    linkProperties: LinkProperties?,
  ) {
    // A callback already queued for the previous default network must not
    // overwrite DNS published by the newly active network.
    val isCurrent = try {
      connectivity.activeNetwork == network
    } catch (_: SecurityException) {
      false
    }
    if (isCurrent) publishLinkProperties(context, linkProperties)
  }

  private fun publishAddresses(context: Context, addresses: List<java.net.InetAddress>) {
    val servers = addresses.asSequence()
      .filterNot { it.isAnyLocalAddress || it.isLoopbackAddress || it.isMulticastAddress || it.isLinkLocalAddress }
      .mapNotNull { it.hostAddress?.substringBefore('%')?.takeIf { address -> address.isNotBlank() } }
      .distinct()
      .take(4)
      .toList()
    val outputs = mapOf(FILE_NAME to servers.joinToString(","), "linux-resolv.conf" to linuxResolverConfig(servers))
    synchronized(lock) {
      for ((name, value) in outputs) {
        val target = File(context.filesDir, name)
        if (
          target.isFile && !Files.isSymbolicLink(target.toPath()) &&
          runCatching { target.readText() }.getOrNull() == value
        ) continue
        val temporary = try {
          File.createTempFile("linux-dns-", ".tmp", context.filesDir)
        } catch (error: Throwable) {
          outputs.keys.forEach { clearStaleResolver(File(context.filesDir, it), error) }
          return
        }
        try {
          FileOutputStream(temporary).use { stream ->
            stream.write(value.toByteArray(Charsets.UTF_8))
            stream.fd.sync()
          }
          if (!SnapshotFs.atomicReplace(temporary, target)) throw java.io.IOException("DNS state publication failed")
        } catch (error: Throwable) {
          temporary.delete()
          outputs.keys.forEach { clearStaleResolver(File(context.filesDir, it), error) }
          return
        }
      }
    }
  }

  private fun clearStaleResolver(target: File, error: Throwable) {
    val cleared = runCatching { Files.deleteIfExists(target.toPath()) }.getOrDefault(false)
    Log.e(TAG, "Linux DNS state update failed; stale resolver ${if (cleared) "cleared" else "may remain"}", error)
  }
}

/** Lifecycle verdict for a freshly spawned guest engine (issue #322). */
internal enum class GuestSpawnVerdict { RUNNING, RETRY_LOADER, LOADER_FAILED, EXITED }

/**
 * Only a pre-exec loader failure may be retried: exit 182 means the PRoot loader shim gave up
 * before the guest program ran, so the attempt produced no output and no side effects.
 */
internal fun guestSpawnVerdict(alive: Boolean, exitCode: Int?, attempt: Int): GuestSpawnVerdict = when {
  alive -> GuestSpawnVerdict.RUNNING
  exitCode == EngineManager.GUEST_LOADER_FAILURE_EXIT && attempt == 0 -> GuestSpawnVerdict.RETRY_LOADER
  exitCode == EngineManager.GUEST_LOADER_FAILURE_EXIT -> GuestSpawnVerdict.LOADER_FAILED
  else -> GuestSpawnVerdict.EXITED
}

/** Empty/Private DNS state stays offline; never silently substitute a public resolver. */
internal fun linuxResolverConfig(servers: List<String>): String {
  require(servers.size <= 4 && servers.all { it.length <= 64 && it.matches(Regex("[0-9a-fA-F:.]+")) }) {
    "invalid Android DNS address"
  }
  return (servers.ifEmpty { listOf("127.0.0.1") }.joinToString("") { "nameserver $it\n" }) +
    "options timeout:2 attempts:2\n"
}

/** Observe startup before liveness so publishing a child then releasing the start
 * guard cannot create a false DEAD result. A second ordered pass also covers a
 * new winner that acquired and released the guard during the first process read. */
internal fun observeBootContinuation(
  startupInProgress: () -> Boolean,
  processAlive: () -> Boolean,
): Boolean = startupInProgress() || processAlive() || startupInProgress() || processAlive()
