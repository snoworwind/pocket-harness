package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * sh* op：Shizuku 特权 shell 通道（0.14.0 §6 —— 替换退役的内置 adb）。
 *
 * 两条通道独立可用：本组 op 由 [ControlCarrier] 承载（随前台引擎服务起停），**不依赖无障碍服务**；
 * 引擎侧 `execAdbShell` / `execAdbLine` 经控制队列投递到这里，由 [ShizukuTransport] 在 shell
 * uid=2000 的 UserService 内执行。执行面复查屏幕范围（§6 末条：两条通道的执行点都要复查）。
 *
 * 两处调用方：
 * - `DeviceControlService.handle`：六面登记链按行首引号解析分支名，分支必须留在 handle 里，
 *   实现委托到本对象（scripts/check-control-ops.mjs 的 A 项）；
 * - `ControlCarrier`：无障碍关闭时的承载者（队列由前台引擎服务持有）。
 */
internal object ShellOps {

  /**
   * 目标屏参数（三种拼写；值保留**原样十进制串**）。
   *
   * 与引擎侧 `screen-scope.ts` 的 `displayOptionsIn` **逐字同源**（含空白类：两侧都用显式 ASCII
   * `[ \t]`——JS 的 `\s` 含 Unicode 空白、Java 的 `\s` 只含 ASCII，用 `\s` 会让「逐字相同」的两份
   * 正则**不等价**，见审查 N-5）。
   *
   * 取值不数值化：`screencap -d` 吃的是 SurfaceFlinger display token，设备实测虚拟屏形如
   * `11529215046816944610`——超出 `Long` 上界，数值化即失真（见坑 147）。
   */
  private val DISPLAY_OPTION = Regex("""(?:^|[ \t])(-d|--display|--display-id)[ \t=]+(\d+)""")

  /** 命令词家族：每个家族自带「哪种拼写才算它的目标屏」（与引擎侧 `SCREEN_COMMAND_FAMILIES` 同表）。 */
  private data class ScreenFamily(val name: String, val pattern: Regex, val targetFlags: List<String>)


  private val SCREEN_FAMILIES = listOf(
    ScreenFamily("screencap", Regex("""\bscreencap\b""", RegexOption.IGNORE_CASE), listOf("-d")),
    ScreenFamily("screenrecord", Regex("""\bscreenrecord\b""", RegexOption.IGNORE_CASE), listOf("--display-id")),
    ScreenFamily(
      "input",
      Regex("""\binput\b""",
        RegexOption.IGNORE_CASE),
      listOf("-d"),
    ),
    ScreenFamily("wm", Regex("""\bwm[ \t]+(?:size|density)(?=[ \t]|$)""", RegexOption.IGNORE_CASE), listOf("-d")),
    ScreenFamily("wm-unscoped", Regex("""\bwm[ \t]+(?!(?:size|density)(?=[ \t]|$))[^ \t]+""", RegexOption.IGNORE_CASE), emptyList()),
    // `uiautomator dump` 没有目标屏参数：dump 的是**默认屏**的语义树 ⇒ 无法自证，恒拒。
    ScreenFamily("uiautomator", Regex("""\buiautomator\b""", RegexOption.IGNORE_CASE), emptyList()),
    ScreenFamily("dumpsys", Regex("""\bdumpsys[ \t]+(?:window|display|input)\b""", RegexOption.IGNORE_CASE), emptyList()),
    // `am` / `cmd activity` 的启动显示参数是 `--display`；`-d` 是 Intent data，**不得**作为目标屏凭据。
    ScreenFamily("am", Regex("""\bam[ \t]+(?:start(?=[ \t]|$)|start-activity(?=[ \t]|$)|start-in-vsync(?=[ \t]|$))""", RegexOption.IGNORE_CASE),
      listOf("--display")),
    ScreenFamily("am-unscoped", Regex("""\bam[ \t]+(?:force-stop|kill|instrument|startservice|start-service|startforegroundservice|startfgservice|start-foreground-service|start-fg-service|broadcast)\b""", RegexOption.IGNORE_CASE),
      emptyList()),
    ScreenFamily("cmd-activity", Regex("""\bcmd[ \t]+activity[ \t]+(?:start(?=[ \t]|$)|start-activity(?=[ \t]|$)|start-in-vsync(?=[ \t]|$))""", RegexOption.IGNORE_CASE),
      listOf("--display")),
    ScreenFamily("cmd-activity-unscoped", Regex("""\bcmd[ \t]+activity[ \t]+(?:force-stop|kill|startservice|start-service|startforegroundservice|startfgservice|start-foreground-service|start-fg-service|broadcast|instrument)\b""", RegexOption.IGNORE_CASE),
      emptyList()),
    ScreenFamily("monkey", Regex("""\bmonkey\b""", RegexOption.IGNORE_CASE), emptyList()),
  )

  /** SurfaceFlinger 的虚拟屏 token 行 / 其后的 name= 行（设备实测形态，见坑 147）。 */
  private val SF_DISPLAY_LINE = Regex("""Virtual Display[ \t]+(\d+)""")
  private val SF_NAME_LINE = Regex("""[ \t]*name="([^"]*)"""")
  private const val SF_NAME_PREFIX = "DSH "

  /** 嵌套执行体再切一层的深度上限（与引擎侧 `MAX_NESTING` 相同）。 */
  private const val MAX_NESTING = 4

  /** 只有实际命令头的固定 `sh -c` 启动形式可以提供可检查载荷。 */
  private val SHELL_C_PAYLOAD = Regex(
    """^[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:(?:env|command)[ \t]+)?(?:/system/bin/)?sh[ \t]+-c[ \t]+([\s\S]*)$""",
  )
  /** Opaque script executors cannot be safely classified by command-word matching in restricted screen scopes. */
  private val OPAQUE_EXECUTION = Regex(
    """^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:eval|source|xargs|trap|awk|gawk|mawk|perl|python(?:[0-9.]*)?|node(?:js)?|ruby|php|lua|tclsh|js|alias|hash|read|run-as|runcon|chroot|app_process|dalvikvm|\.)(?:[ \t]|$)|(?:^|[ \t])find[ \t]+[^\n]*[ \t]-(?:exec|ok)(?:dir)?(?:[ \t]|$)|(?:^|[ \t])tar[ \t]+[^\n]*[ \t]--to-command(?:[ =]|$)""",
    RegexOption.IGNORE_CASE,
  )
  private val SHELL_INTERPRETER = Regex(
    """^(?:[^\s]*/)?(?:sh|bash|mksh|ash|dash|zsh|busybox|toybox|su)(?=[ \t]|$)""",
    RegexOption.IGNORE_CASE,
  )
  private val SCREEN_COMMAND_HEAD = Regex(
    """^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:(?:[^\s]*/)?(?:screencap|screenrecord|input|uiautomator|wm|dumpsys|am|monkey|cmd[ \t]+(?:activity|window)))(?=[ \t]|$)""",
    RegexOption.IGNORE_CASE,
  )
  private val SCREEN_COMMAND_WORD = Regex(
    """\b(?:screencap|screenrecord|input|uiautomator|wm|dumpsys|am|monkey|cmd[ \t]+(?:activity|window))\b""",
    RegexOption.IGNORE_CASE,
  )
  private val COMMAND_LAUNCHER_HEAD = Regex(
    """^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:command|builtin|exec|env|nohup|nice|timeout|setsid|time|!)(?=[ \t]|$)""",
    RegexOption.IGNORE_CASE,
  )
  private val SAFE_SHELL_LAUNCHER_HEAD = Regex("""^(?:env|command)[ \t]+(?:/system/bin/)?sh[ \t]+-c[ \t]""")
  private val TRUSTED_SHELL_PATH_HEAD = Regex("""^/system/bin/sh[ \t]+-c[ \t]""")
  private val SHELL_CONTROL_HEAD = Regex("""^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:if|then|elif|else|fi|while|until|for|select|case|esac|do|done|function|coproc)(?=[ \t]|$)""")
  private val OPAQUE_DISPLAY_API = Regex("""\b(?:cmd[ \t]+window|wm[ \t]+dump-visible-window-views|(?:am|cmd[ \t]+activity)[ \t]+instrument)\b""", RegexOption.IGNORE_CASE)
  /** A command found by path may be a user-written script that hides screen access from this text scan. */
  private val EXECUTABLE_PATH_HEAD = Regex(
    """^[^ \t]*/[^ \t]*(?=[ \t]|$)""",
  )
  private val COMMAND_GLOB_HEAD = Regex("""^[^ \t]*[*?\[]""")
  /** Search paths, shell startup files and loader hooks can execute code absent from this command. */
  private val EXECUTION_ENV_OVERRIDE = Regex(
    """(?:^|[ \t])(?:(?:export|declare|typeset|local|readonly)[ \t]+(?:-[A-Za-z]+[ \t]+)*)?(?:PATH|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|ZDOTDIR|LD_[A-Z0-9_]+)[ \t]*=""",
  )

  /**
   * 屏幕范围判定的结果码——与引擎侧 `ScreenCommandVerdict` 的字符串**逐字相同**，
   * 由跨语言 fixture（`scripts/gen-screen-scope-fixture.mjs`）双向锁死。
   */
  internal enum class ScreenCommandVerdict(val wire: String) {
    ALLOW("allow"),
    DENY_UNPARSED("deny-unparsed"),
    DENY_ORPHAN_TARGET_TOKEN("deny-orphan-target-token"),
    DENY_UNCERTIFIED_TARGET("deny-uncertified-target"),
  }

  fun handle(context: Context, op: String, args: JSONObject): JSONObject = when (op) {
    "shExec" -> exec(context, args)
    "shPull" -> pull(context, args)
    "shPush" -> push(context, args)
    "shRemove" -> remove(context, args)
    else -> JSONObject()
      .put("__error", "未知特权 shell 操作 $op")
      .put("reason", "unknown-op")
      .put("op", op)
  }

  private fun exec(context: Context, args: JSONObject): JSONObject {
    val command = args.optString("command", "")
    if (command.isBlank()) return fail("shExec 缺少 command", "shell-empty")
    scopeDenied(context, command)?.let {
      // G-7：执行点拒绝**必须落账**（旧实现 `return` 早于 audit，安全事件 screen-out-of-scope 零留痕）
      audit(context, "shExec", command, ControlAudit.RESULT_DENIED)
      return it
    }
    val result = ShizukuTransport.runShell(
      context,
      command,
      timeoutMs = args.optInt("timeoutMs", 20_000),
      capture = args.optBoolean("capture", false),
    )
    // 2026-09-30（主人定例「我们不是做 root 适配吗」）：**su 直连回退**。
    //
    // 为什么：Shizuku 通道的可用性押在「Shizuku 已安装 + 在运行 + 已授权 + 服务端以 root 启动」
    // 四件事上，任一不成立整条链就死（本机实测：服务端判 denied ⇒ 通道恒不可用 ⇒ 连属主自愈
    // 都跑不了）。而本机 su 是好的 ⇒ 应用自身获 Root 管理器授权即可执行 root 命令。
    // 判据：只在**通道级失败**（code 以 shizuku- 开头 / root-grant-required / 未绑定）时回退——
    // 命令自身跑失败（exitCode≠0）不重跑（那是命令的事实，不是通道的问题）。
    val code = result.optString("code")
    // Policy refusals and ambiguous post-dispatch Binder failures must never replay a command.
    val channelBroken = !result.optBoolean("ok") && !result.optBoolean("noReplay") && canFallbackBeforeDispatch(code)
    if (channelBroken && RootGrant.isGranted(context) && RootAccess.isGranted(context)) {
      val viaSu = RootAccess.execRoot(context, command, args.optInt("timeoutMs", 20_000))
      if (viaSu.optBoolean("ok") || viaSu.optString("code") != "no-su") {
        audit(context, "shExec", command, resultOf(viaSu))
        return viaSu.put("op", "shExec").put("transport", "su")
      }
    }
    audit(context, "shExec", command, resultOf(result))
    return result.put("op", "shExec").put("transport", "shizuku")
  }

  internal fun canFallbackBeforeDispatch(code: String): Boolean = code in setOf(
    "shizuku-absent", "shizuku-not-running", "shizuku-denied", "shizuku-prev11",
    "shizuku-user-service-not-bound", "shizuku-user-service-too-old",
  )

  private fun pull(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    val local = args.optString("local", "")
    if (remote.isBlank() || local.isBlank()) return fail("shPull 需要 remote 与 local", "shell-path-missing")
    val result = ShizukuTransport.pullFile(context, remote, local)
    audit(context, "shPull", "$remote -> $local", resultOf(result))
    return result.put("op", "shPull").put("transport", "shizuku")
  }

  private fun push(context: Context, args: JSONObject): JSONObject {
    val local = args.optString("local", "")
    val remote = args.optString("remote", "")
    if (local.isBlank() || remote.isBlank()) return fail("shPush 需要 local 与 remote", "shell-path-missing")
    val result = ShizukuTransport.pushFile(context, local, remote)
    audit(context, "shPush", "$local -> $remote", resultOf(result))
    return result.put("op", "shPush").put("transport", "shizuku")
  }

  private fun remove(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    if (remote.isBlank()) return fail("shRemove 需要 remote", "shell-path-missing")
    val result = ShizukuTransport.removeRemote(context, remote)
    audit(context, "shRemove", remote, resultOf(result))
    return result.put("op", "shRemove").put("transport", "shizuku")
  }

  /** §6：virtual-only / real-only 屏幕范围在本通道执行点复查；两份判据与引擎侧同口径。 */
  private fun scopeDenied(context: Context, command: String): JSONObject? {
    when (ScreenScopePrefs.current(context)) {
      ScreenScope.ALL -> return null
      ScreenScope.REAL_ONLY -> {
        if (realOnlyScreenCommandAllowed(command)) return null
        return JSONObject()
          .put("__error", "用户当前开放屏幕范围为 real-only；屏幕命令只能作用于物理屏 display 0。虚拟屏或无法确认的显式显示目标已拒绝。")
          .put("reason", "screen-out-of-scope")
          .put("op", "shExec")
      }
      ScreenScope.VIRTUAL_ONLY -> Unit
    }
    // 块G F5（0.14.1）：目标屏是**已注册虚拟屏**的命令放行——`screencap -d <虚拟屏 id>` 读的是
    // 范围内的屏，与无参 `screencap`（读真实屏 0）根本不是一件事。
    //
    // 为什么壳侧必须有这一条（真缺陷，不是可选优化）：引擎侧 `screen-scope.ts` 的
    // `realScreenAdbCommandDenied` 已修了 F2，但本函数是同一判据的 **Kotlin 副本**——它在
    // **执行点**（Shizuku 通道真正下发命令前）复查。只修引擎侧 ⇒ 壳侧这条二次拦截会把 F2
    // 完全抵消（引擎放行、壳侧仍拒），用户看到的仍是「范围允许 virtual-1 却说不许访问真实屏」。
    // 两处必须同口径，且由跨语言 fixture 锁死等价性。
    //
    // 0.14.1 复审：判据从「整条命令里每个 -d 都属虚拟屏」升级为**段级自证**——
    // 引号感知切段 + 每段各自认证（否则 `screencap -d <虚拟屏>; screencap /sdcard/real.png`
    // 会被第一个 `-d` 整行洗白），且命令词匹配前先归一化目标屏参数（否则 `input -d 0 tap 1 2`
    // 这种**选项在子命令前**的正式写法不进命令词面）。逐条理由见 decideScreenCommand。
    //
    // 走完整判定（不做「无命令词即放行」的短路）：短路会把 `deny-unparsed`（引号不闭合）也一并
    // 放行——而那条恰恰是「看不懂就不放行」的 fail-closed 面。SF token 反查的开销由
    // screenVerdictWithRegistry 的**惰性谓词**化解，不靠短路省。
    val verdict = screenVerdictWithRegistry(context, command)
    if (verdict == ScreenCommandVerdict.ALLOW) return null
    val guidance = if (verdict == ScreenCommandVerdict.DENY_UNPARSED) {
      "本条命令含无法安全解析的 shell 语法、脚本执行器或屏幕命令别名，无法核对目标屏，故拒绝。" +
        "请改为直接、可静态核对的命令后重试。"
    } else {
      "命令里显式指定的目标屏须为**已注册虚拟屏**（DisplayManager displayId 或该屏的 SurfaceFlinger token），" +
        "且参数须使用该命令支持的拼写与位置；本条命令未能通过核对，故拒绝。请确认虚拟屏仍在活跃状态" +
        "（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。"
    }
    return JSONObject()
      .put("__error", "用户当前开放屏幕范围为 virtual-only，不允许经特权 shell 读取或操作真实屏幕"
        + "（screencap / screenrecord / uiautomator / input / wm / dumpsys window|display|input / am / cmd activity / monkey）。"
        + guidance)
      .put("reason", "screen-out-of-scope")
      .put("op", "shExec")
  }

  /**
   * real-only 下的 raw shell 判据：无显式 display 参数的屏幕命令使用 Android 物理默认屏 0；
   * 有明确显示参数时仅 0 通过。未知/虚拟目标 fail-closed。非屏幕命令保持可用。
   */
  internal fun realOnlyScreenCommandAllowed(command: String): Boolean {
    val parsed = splitCommandSegments(command)
    if (parsed.unparsed) return false
    for (segment in parsed.segments) {
      val bare = scopeCommandText(segment) ?: ""
      val options = displayOptionsIn(bare)
      val normalized = stripDisplayOptions(bare)
      val families = SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(normalized) }
      for (family in families) {
        if (hasUncertifiedSelector(bare, family)) return false
        val relevant = options.filter { it.first in family.targetFlags }
        if (family.targetFlags.isEmpty() && options.isNotEmpty()) return false
        if (relevant.any { it.second != "0" }) return false
      }
    }
    return true
  }

  /**
   * 命令是否命中「真实屏读写命令词」面（[SCREEN_FAMILIES] 的可测入口）。
   * 生产路径由 [scopeDenied] / [decideScreenCommand] 内部调用，此处单独暴露只为让 JVM 单测锁住
   * **命令词面不得缩水**（缩水 = 直接放行真实屏，是范围门禁的自毁形态）。
   */
  internal fun commandTargetsRealScreen(command: String): Boolean = screenFamiliesIn(command).isNotEmpty()

  /** 归一化（还原静态参数 + 抹目标屏参数）后命中的命令词家族名。 */
  internal fun screenFamiliesIn(command: String): List<String> =
    SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(stripDisplayOptions(scopeCommandText(command) ?: "")) }
      .map { it.name }

  /**
   * 命令的显式目标屏是否**确为**一块已注册虚拟屏（G-F5 放行分支的生产入口）。
   *
   * SF token 反查是 **Shizuku 往返**，因此**惰性求值**：只有 displayId 空间没能自证成功、
   * 真的需要按 token 核对时才付这一跳（审查 N-4：旧实现把 `sfTokensOfRegisteredDisplays(context)`
   * 作为实参**急切求值**，于是每条带 `-d` 的命令都要先跑一次 `dumpsys SurfaceFlinger`）。
   *
   * @param context 用于 SF token 反查；null 时（JVM 单测）等价于「反查不可达」→ 恒拒（fail-closed）。
   */
  internal fun targetsRegisteredVirtualScreen(context: Context?, command: String): Boolean =
    screenVerdictWithRegistry(context, command) == ScreenCommandVerdict.ALLOW

  /**
   * 带注册表的生产判定：`ownsTarget` 的**两个 id 空间**都接上真数据面。
   *
   * `context == null`（JVM 单测）→ 全部判否 ⇒ 只能走到拒绝侧（这正是 `targetsRegisteredVirtualScreen`
   * 单测只覆盖拒绝的原因；放行侧由 [decideTargetsRegisteredVirtualScreen] 的纯判据覆盖）。
   */
  internal fun screenVerdictWithRegistry(context: Context?, command: String): ScreenCommandVerdict {
    if (context == null) return decideScreenCommand(command) { false }
    var sfTokens: Set<String>? = null
    return decideScreenCommand(command) { raw ->
      val id = raw.toIntOrNull()
      if (id != null && id != 0 && VdisplayController.aliasForDisplayId(id) != null) {
        true
      } else {
        val tokens = sfTokens ?: sfTokensOfRegisteredDisplays(context).also { sfTokens = it }
        tokens.contains(raw)
      }
    }
  }

  /**
   * 纯判据：命令的显式目标屏是否确为一块**已注册**虚拟屏（G-F5 放行分支的可测入口）。
   *
   * 为什么单独抽出来：放行分支此前**零测试覆盖**——所有 JVM 用例都传 `context = null`，
   * 而 `null` 恒走 fail-closed 路径（因此只测到了拒绝）。注册表的数据面
   * （`VdisplayController.aliasForDisplayId` / SF 反查）在 JVM 下不可注入（`Record` 持真实
   * `VirtualDisplay`/`ImageReader`），于是「合法目标屏必须放行」这条**在单测里根本无法表达**。
   * 抽成纯函数后，放行与拒绝两侧都能被钉死，且改坏放行逻辑即判红。
   *
   * 与引擎侧 `targetsRegisteredVirtualScreen(command, options)` 同构（同两条 id 空间、同 fail-closed）。
   *
   * @param ownsDisplayId displayId 空间：该 id 是否属于一块已注册虚拟屏（**不含 0**）
   * @param ownedSfTokens token 空间：已注册虚拟屏的 SF token 集合（已与产品别名配对）
   */
  internal fun decideTargetsRegisteredVirtualScreen(
    command: String,
    ownsDisplayId: (Int) -> Boolean,
    ownedSfTokens: Set<String>,
  ): Boolean = decideScreenCommand(command) { raw ->
    if (raw == "0") {
      false
    } else {
      val id = raw.toIntOrNull()
      (id != null && id != 0 && ownsDisplayId(id)) || ownedSfTokens.contains(raw)
    }
  } == ScreenCommandVerdict.ALLOW

  /**
   * 纯判据：一条 raw shell 命令在 virtual-only 下是否**只**作用于已注册虚拟屏。
   *
   * `ownsTarget(raw)`：该十进制串是否属于一块**已注册**虚拟屏（displayId 空间或 SF token 空间，
   * 两个空间的取值都按**原样字符串**比对；`0` 恒为真实屏、永不属于）。
   *
   * 三态拒绝（每一态都有独立的反证用例）：
   *  - [ScreenCommandVerdict.DENY_UNPARSED]：引号不闭合 / 嵌套过深 —— 看不懂就不放行；
   *  - [ScreenCommandVerdict.DENY_ORPHAN_TARGET_TOKEN]：某段带目标屏参数却**自身不含任何屏幕命令词**。
   *    这类 token 没有合法用途，它的存在只为「给同一行的其它命令发通行证」（`echo -d <token>; cat …`）；
   *  - [ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET]：命中屏幕命令词面，但该家族**没有**可用目标屏
   *    参数、参数缺席、或参数值不在注册表里（无参 `screencap`、`-d 0`、`-d <未知>`、
   *    `am start -d 5` 都在此列）。
   *
   * 与引擎侧 `screenCommandVerdict` 同一算法（那侧是调用点第一道，本侧是执行点第二道）。
   */
  internal fun decideScreenCommand(command: String, ownsTarget: (String) -> Boolean): ScreenCommandVerdict {
    val parsed = splitCommandSegments(command)
    if (parsed.unparsed) return ScreenCommandVerdict.DENY_UNPARSED
    for (segment in parsed.segments) {
      val bare = scopeCommandText(segment) ?: ""
      val options = displayOptionsIn(bare)
      val normalized = stripDisplayOptions(bare)
      val families = SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(normalized) }
      if (families.isEmpty()) {
        // 非屏幕命令段：允许，但**不得**携带目标屏凭据（否则就是洗白凭据）。
        if (options.isNotEmpty()) return ScreenCommandVerdict.DENY_ORPHAN_TARGET_TOKEN
        continue
      }
      for (family in families) {
        if (hasUncertifiedSelector(bare, family)) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        if (family.targetFlags.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        val owned = options.filter { it.first in family.targetFlags }.map { it.second }
        // 该家族必须在**本段内**自证：参数缺席、或任一值不属于已注册虚拟屏 → 拒（不得只认证其中一个）。
        if (owned.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        if (!owned.all { ownsTarget(it) }) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
      }
    }
    return ScreenCommandVerdict.ALLOW
  }

  /** 引号感知切段结果（与引擎侧 `CommandSegments` 同构）。 */
  internal class ParsedCommand(val segments: List<String>, val unparsed: Boolean)

  private fun dynamicExpansionCanAffectScreenScope(prefix: String): Boolean {
    val bare = stripQuotedText(prefix).trimEnd()
    if (bare.trim().isEmpty() || (!bare.contains(' ') && !bare.contains('\t'))) return true
    if (SHELL_C_PAYLOAD.containsMatchIn(bare) || SCREEN_COMMAND_HEAD.containsMatchIn(bare)) return true
    return COMMAND_LAUNCHER_HEAD.containsMatchIn(bare) && SCREEN_COMMAND_WORD.containsMatchIn(bare)
  }

  /**
   * 引号感知地把一条命令切成**可判定段**：顶层段 + 反引号 / `$()` / `sh -c` 的嵌套执行体。
   *
   * 关键不变量（与引擎侧 `splitCommandSegments` 对应，跨语言 fixture 锁定）：分隔符仅在引号外切段；
   * 嵌套执行体递归检查；`-c` 只取首个 shell 参数；动态命令词/目标与不透明解释器 fail-closed；
   * 引号未闭合或无法提取载荷时拒绝。
   */
  internal fun splitCommandSegments(command: String): ParsedCommand {
    val segments = ArrayList<String>()
    var unparsed = false

    fun scan(text: String, depth: Int) {
      if (depth > MAX_NESTING) {
        unparsed = true
        return
      }
      val buf = StringBuilder()
      fun flush() {
        segments.add(buf.toString())
        buf.setLength(0)
      }
      var i = 0
      while (i < text.length) {
        val ch = text[i]
        if (ch == '\\') {
          buf.append(text, i, minOf(i + 2, text.length))
          i += 2
          continue
        }
        if (ch == '\'') {
          val end = text.indexOf('\'', i + 1)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          // A quote can be part of the command word (`screen"cap"`) or the command itself
          // (`'screencap'`). Quoted arguments after a command remain ordinary data.
          if (buf.toString().trim().isEmpty() || (buf.isNotEmpty() && buf.last() != ' ' && buf.last() != '\t')) {
            unparsed = true
          }
          buf.append(text, i, end + 1)
          i = end + 1
          continue
        }
        if (ch == '"') {
          var j = i + 1
          while (j < text.length) {
            if (text[j] == '\\') {
              j += 2
              continue
            }
            if (text[j] == '"') break
            // Double quotes still expand variables, $(...), and backticks. In a restricted
            // screen scope their resulting executable words cannot be proven statically.
            if (text[j] == '$' || text[j] == '`') unparsed = true
            j += 1
          }
          if (j >= text.length) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          if (buf.toString().trim().isEmpty() || (buf.isNotEmpty() && buf.last() != ' ' && buf.last() != '\t')) {
            unparsed = true
          }
          buf.append(text, i, j + 1)
          i = j + 1
          continue
        }
        if (ch == '`') {
          val end = backtickEnd(text, i + 1)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          if (dynamicExpansionCanAffectScreenScope(buf.toString())) unparsed = true
          scan(text.substring(i + 1, end), depth + 1)
          buf.append(' ')
          i = end + 1
          continue
        }
        if (ch == '$' && i + 1 < text.length && text[i + 1] == '(') {
          val end = parenEnd(text, i + 2)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          if (dynamicExpansionCanAffectScreenScope(buf.toString())) unparsed = true
          scan(text.substring(i + 2, end), depth + 1)
          buf.append(' ')
          i = end + 1
          continue
        }
        // Bare parameter expansion can synthesize an executable command (`cmd=screencap; $cmd`).
        if (ch == '$') unparsed = true
        // Process substitution also executes a nested command but is not represented by `$()`.
        if ((ch == '<' || ch == '>') && i + 1 < text.length && text[i + 1] == '(') unparsed = true
        if (ch == ';' || ch == '\n' || ch == '\r') {
          flush()
          i += 1
          continue
        }
        if (ch == '&' || ch == '|') {
          flush()
          i += if (i + 1 < text.length && text[i + 1] == ch) 2 else 1
          continue
        }
        buf.append(ch)
        i += 1
      }
      flush()
    }

    scan(command, 0)

    // `sh -c` 载荷是**再看一层**的入口：它整段都在引号里（stripQuotedText 会把它抹掉），
    // 必须用**原文**匹配、再解一层引号把内层当命令扫。工作队列让嵌套的 `sh -c "sh -c …"` 也被展开
    // （载荷是子串，必然收缩；上限只是防御性护栏）。
    val pending = ArrayDeque(segments)
    var round = 0
    while (pending.isNotEmpty() && round < 16) {
      round += 1
      val segment = pending.removeFirst()
      val payload = SHELL_C_PAYLOAD.find(segment) ?: continue
      val inner = shellCommandArgument(payload.groupValues[1])
      if (inner == null) {
        unparsed = true
        continue
      }
      if (inner.isEmpty()) continue
      val before = segments.size
      scan(inner, 1)
      for (k in before until segments.size) pending.addLast(segments[k])
    }
    if (pending.isNotEmpty()) unparsed = true
    if (segments.any { segment ->
        val view = scopeCommandText(segment)
        if (view == null) true else {
          val head = view.split(' ').dropWhile { Regex("""^[A-Za-z_][A-Za-z0-9_]*=""").containsMatchIn(it) }.joinToString(" ")
          OPAQUE_EXECUTION.containsMatchIn(head) ||
            head.substringBefore(' ') == "__shell_argument__" ||
            OPAQUE_DISPLAY_API.containsMatchIn(head) ||
            SHELL_CONTROL_HEAD.containsMatchIn(head) ||
            COMMAND_GLOB_HEAD.containsMatchIn(head) ||
            (EXECUTABLE_PATH_HEAD.containsMatchIn(head) && !TRUSTED_SHELL_PATH_HEAD.containsMatchIn(head)) ||
            (COMMAND_LAUNCHER_HEAD.containsMatchIn(head) && !(SAFE_SHELL_LAUNCHER_HEAD.containsMatchIn(head) && SHELL_C_PAYLOAD.containsMatchIn(segment))) ||
            EXECUTION_ENV_OVERRIDE.containsMatchIn(view) ||
            (SHELL_INTERPRETER.containsMatchIn(head) && !SHELL_C_PAYLOAD.containsMatchIn(segment))
        }
      }) unparsed = true
    return ParsedCommand(segments.filter { it.isNotBlank() }, unparsed)
  }

  /** 反引号段结束位置；`\`` 转义不算结束。返回 -1 = 未闭合。 */
  private fun backtickEnd(text: String, from: Int): Int {
    var i = from
    while (i < text.length) {
      if (text[i] == '\\') {
        i += 2
        continue
      }
      if (text[i] == '`') return i
      i += 1
    }
    return -1
  }

  /** `$(` 的配对 `)` 位置（内部引号与嵌套括号都计入）。返回 -1 = 未闭合。 */
  private fun parenEnd(text: String, from: Int): Int {
    var depth = 1
    var i = from
    while (i < text.length) {
      val ch = text[i]
      if (ch == '\\') {
        i += 2
        continue
      }
      if (ch == '\'' || ch == '"') {
        val quote = ch
        i += 1
        while (i < text.length) {
          if (quote == '"' && text[i] == '\\') {
            i += 2
            continue
          }
          if (text[i] == quote) break
          i += 1
        }
        i += 1
        continue
      }
      if (ch == '(') {
        depth += 1
      } else if (ch == ')') {
        depth -= 1
        if (depth == 0) return i
      }
      i += 1
    }
    return -1
  }

  /** Read the first shell word after `-c`, removing the outer shell quoting. Null means ambiguous. */
  private fun shellCommandArgument(text: String): String? {
    val out = StringBuilder()
    var quote: Char? = null
    var sawArgument = false
    var i = 0
    while (i < text.length) {
      val ch = text[i]
      if (quote == null) {
        if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == ';' || ch == '&' || ch == '|' || ch == '<' || ch == '>') break
        if (ch == '\'' || ch == '"') {
          quote = ch
          sawArgument = true
          i += 1
          continue
        }
        if (ch == '\\') {
          if (i + 1 >= text.length) return null
          sawArgument = true
          if (text[i + 1] != '\n') out.append(text[i + 1])
          i += 2
          continue
        }
        sawArgument = true
        out.append(ch)
        i += 1
        continue
      }
      if (quote == '\'' && ch == '\'') {
        quote = null
        i += 1
        continue
      }
      if (quote == '"' && ch == '"') {
        quote = null
        i += 1
        continue
      }
      if (quote == '"' && ch == '\\') {
        if (i + 1 >= text.length) return null
        val next = text[i + 1]
        if (next == '$' || next == '`' || next == '"' || next == '\\') out.append(next)
        else if (next == '\n') { /* shell line continuation */ }
        else out.append('\\').append(next)
        i += 2
        continue
      }
      out.append(ch)
      i += 1
    }
    return if (quote == null && sawArgument) out.toString() else null
  }

  /**
   * 还原静态 shell 参数，引用参数仍是一个词；注释和重定向文件名不参与目标认证。
   * 不支持的控制语法与描述符重定向返回 null，由调用方 fail-closed。
   * 与引擎侧 scopeCommandText 同规则。
   */
  private fun scopeCommandText(text: String): String? {
    val words = ArrayList<String>()
    val word = StringBuilder()
    var active = false
    var redirect = false
    var quote: Char? = null
    fun flush() {
      if (!active) return
      if (redirect) redirect = false else {
        val value = word.toString()
        val assignment = Regex("""^[A-Za-z_][A-Za-z0-9_]*=""").find(value)?.value ?: ""
        words.add(if (Regex("[ \\t\\r\\n]").containsMatchIn(value)) assignment + "__shell_argument__" else value)
      }
      word.setLength(0)
      active = false
    }
    var i = 0
    while (i < text.length) {
      val ch = text[i++]
      if (quote == '\'') {
        if (ch == '\'') quote = null else word.append(ch)
        continue
      }
      if (ch == '\\') {
        if (i >= text.length) return null
        val next = text[i++]
        if (next == '\n') continue
        if (quote == '"' && next !in listOf('$', '"', '\\', 96.toChar())) word.append('\\')
        word.append(next)
        active = true
        continue
      }
      if (quote == '"') {
        if (ch == '"') quote = null else word.append(ch)
        continue
      }
      if (ch == '\'' || ch == '"') { quote = ch; active = true; continue }
      if (ch == '#' && !active) break
      if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') { flush(); continue }
      if (ch == '<' || ch == '>') {
        if (active && Regex("[0-9]+").matches(word)) { word.setLength(0); active = false } else flush()
        if (redirect) return null
        if (i < text.length && text[i] == ch) {
          if (ch == '<') return null
          i += 1
        }
        if (i < text.length && text[i] in "&|(>") return null
        redirect = true
        continue
      }
      if (ch in "(){};&|") return null
      word.append(ch)
      active = true
    }
    if (quote != null) return null
    flush()
    return if (redirect) null else words.joinToString(" ")
  }

  private fun hasUncertifiedSelector(text: String, family: ScreenFamily): Boolean {
    val words = text.split(' ')
    var i = 0
    while (i < words.size) {
      val word = words[i]
      if (word == "-d" && (family.name.startsWith("am") || family.name.startsWith("cmd-activity"))) {
        i += 2
        continue
      }
      if (family.name == "wm" && word == "-u") return true
      if (word in listOf("-d", "--display", "--display-id")) {
        if (word !in family.targetFlags || !Regex("[0-9]+").matches(words.getOrNull(i + 1) ?: "")) return true
        var at = words.indexOf(if (family.name == "cmd-activity") "activity" else family.name)
        if (at < 0) return true
        when (family.name) {
          "input" -> {
            at += 1
            if (Regex("^(?:keyboard|dpad|gamepad|touchscreen|mouse|stylus|trackball|touchpad|touchnavigation|joystick)$").matches(words.getOrNull(at) ?: "")) at += 1
            if (i != at) return true
          }
          "wm" -> if (i != at + 2 && i != at + 3) return true
          "am", "cmd-activity" -> if (i != at + 2) return true
          "screencap" -> if (!words.subList(at + 1, i).all { it == "-p" || it == "-h" }) return true
          "screenrecord" -> if (i != at + 1) return true
        }
        i += 1
      } else if (Regex("^-d.+|^--display").containsMatchIn(word)) return true
      i += 1
    }
    return false
  }

  /** 仅用于动态展开前缀检测的去引用视图；真实参数认证使用 scopeCommandText。 */
  internal fun stripQuotedText(text: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < text.length) {
      val ch = text[i]
      if (ch == '\\') {
        if (i + 1 < text.length) out.append(text[i + 1])
        i += 2
        continue
      }
      if (ch == '\'' || ch == '"') {
        val quote = ch
        var j = i + 1
        while (j < text.length) {
          if (quote == '"' && text[j] == '\\') {
            j += 2
            continue
          }
          if (text[j] == quote) break
          j += 1
        }
        if (j >= text.length) {
          out.append(' ')
          i = text.length
          continue
        }
        out.append(' ')
        i = j + 1
        continue
      }
      out.append(ch)
      i += 1
    }
    return out.toString()
  }

  /** 把目标屏参数整体抹成空白（命令词匹配前归一化，使 `input -d 0 tap …` 也进命令词面）。 */
  internal fun stripDisplayOptions(text: String): String = DISPLAY_OPTION.replace(text, " ")

  /** 命令里的全部目标屏参数（拼写 + 原样数字串）。 */
  internal fun displayOptionsIn(text: String): List<Pair<String, String>> =
    DISPLAY_OPTION.findAll(text).map { it.groupValues[1] to it.groupValues[2] }.toList()

  /**
   * 当前**已注册**虚拟屏的 SF token 集合（块G F6）。经 Shizuku shell 通道读
   * `dumpsys SurfaceFlinger`（收窄到 Virtual Display + name 两行），把 `name="DSH <alias>"`
   * 配对回产品别名，再与 `VdisplayController.activeAliases()` 求交——**只有配对别名仍注册**
   * 的 token 才有效（虚拟屏已销毁 → 其 token 立刻失效）。
   *
   * 必须**先 grep 收窄**：设备实测全量 `dumpsys SurfaceFlinger` 为 31,590 B，而虚拟屏段落在
   * 第 ~9,500 字节之后，超出 shell 通道的 inline 回传窗口 ⇒ 全量取回拿不到目标行、反查恒空。
   *
   * fail-closed：通道不可达/超时/输出为空/解析不出 → 空集（调用方据此拒绝）。
   */
  private fun sfTokensOfRegisteredDisplays(context: Context): Set<String> {
    val registered = VdisplayController.activeAliases()
    if (registered.isEmpty()) return emptySet()
    return try {
      val r = ShizukuTransport.runShell(
        context,
        "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
        timeoutMs = 8_000,
      )
      if (!r.optBoolean("ok")) return emptySet()
      val stdout = r.optString("stdout", "")
      if (stdout.isBlank()) return emptySet()
      parseSfDisplayTokens(stdout).filter { it.first in registered }.map { it.second }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  /**
   * 纯函数：解析 `dumpsys SurfaceFlinger` 输出里的 `Virtual Display <token>` + 紧跟
   * `name="DSH <alias>"` 配对（与引擎侧 `screenTokensFromSfDump` 同规则）。
   *
   * 设备实测形态：
   * ```
   *     name="mumuscreen000"
   * Virtual Display 11529215046816944610
   *     name="DSH virtual-1"
   * ```
   * 尾随空白必须**容忍**：设备 `dumpsys` 输出常见行尾空格，而旧实现用 `matchEntire` 钉死整行
   * ⇒ 壳侧解析恒空、判定恒拒（审查 N-5 的功能回归面）。
   *
   * @return (alias, token) 列表；token 原样字符串
   */
  internal fun parseSfDisplayTokens(sfDump: String): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    var pending: String? = null
    for (raw in sfDump.lines()) {
      val tokenMatch = SF_DISPLAY_LINE.matchEntire(raw.trim())
      if (tokenMatch != null) {
        pending = tokenMatch.groupValues[1]
        continue
      }
      if (pending == null) continue
      val nameMatch = SF_NAME_LINE.matchEntire(raw.trimEnd())
      if (nameMatch == null) continue
      val displayName = nameMatch.groupValues[1]
      val token = pending
      if (displayName.startsWith(SF_NAME_PREFIX) && token != null) {
        out.add(displayName.removePrefix(SF_NAME_PREFIX) to token)
      }
      // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
      pending = null
    }
    return out
  }

  /**
   * 命令里的目标屏数字串（**保留原样，不数值化**）——token 超 `Int`/`Long` 值域，
   * 数值化即失真（见坑 147）。与引擎侧 `adbCommandDisplayTokens` 的取法一致。
   */
  internal fun commandDisplayTokens(command: String): List<String> =
    splitCommandSegments(command).let { parsed ->
      if (parsed.unparsed) emptyList() else parsed.segments.flatMap { displayOptionsIn(scopeCommandText(it) ?: "").map { option -> option.second } }
    }

  /**
   * 落一条审计。
   *
   * G-7（2026-09-25）：`result` 由调用方按**真实结果**传入（[ControlAudit.RESULT_OK] /
   * [ControlAudit.RESULT_FAILED] / [ControlAudit.RESULT_DENIED]），不再恒为 ok。
   * `detail` 已截断到 512 字符，避免把整条命令行（可能含长路径）写爆审计文件。
   *
   * @param context 用于解析 filesDir 与 Shizuku uid。
   * @param op 动作名（shExec / shPull / shPush / shRemove）。
   * @param detail 可读摘要（命令或路径对）。
   * @param result 真实结果三态之一。
   */
  private fun audit(context: Context, op: String, detail: String, result: String) {
    val uid = ShizukuTransport.identity(context).optInt("uid", -1)
    ControlAudit.log(
      context,
      op,
      result,
      mapOf(
        "transport" to "shizuku",
        "uid" to uid,
        "op" to op,
        "detail" to detail.take(512),
        "ok" to (result == ControlAudit.RESULT_OK),
      ),
    )
  }

  /** 由 Shizuku 结果对象取真实结果串（ok=true → ok，否则 failed）。 */
  internal fun resultOf(result: JSONObject): String =
    if (result.optBoolean("ok")) ControlAudit.RESULT_OK else ControlAudit.RESULT_FAILED

  private fun fail(message: String, reason: String): JSONObject = JSONObject()
    .put("__error", message)
    .put("reason", reason)
}
