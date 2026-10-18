package com.dsharnessmobile.shell

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.io.File

/**
 * 看门狗升级（0.13.0 PRD F2/M3.4）：
 * - 深度探活：HTTP 状态码 + 页面心跳 + 插件状态（EngineProbe 扩展：/api/android/privilege/status
 *   可达表示插件树健康）+ 引擎日志尾部异常扫描（engine.log 末尾 fatal/Error 关键字）。
 * - 熔断与指数退避：连续失败 → 指数退避（5s→10s→20s→40s→80s 封顶），超过熔断阈值（12 次连续失败）
 *   暂停看门狗并记录（界面提示由 GuideChrome 状态区显示），用户交互或探活成功自动复位。
 * - 开机自启：BOOT_COMPLETED 接收器恢复用户上次同意的运行状态（EngineService.userShutdown 持久化）。
 * - 前台唤醒锁：引擎前台运行期间持有（PARTIAL_WAKE_LOCK，标准档位；获取失败降级尽力模式并记录）。
 * - 授权状态探活：ADB 配对断线时记录（F2.9，桥引导重新配对由桥层返回）。
 */
object WatchdogV2 {

  private const val TAG = "dsh-watchdog"
  const val MAX_CONSEC_FAILURES = 12

  /** FX-212.3：标记文件消费偏移的 prefs 键（跨进程重启不重放历史标记）。 */
  private const val KEY_MARKER_OFFSET = "notify.markerOffset"

  /**
   * A slow HTTP response is distinct from a process that no longer accepts TCP.
   * 0.13.8 #175：DEGRADED 拆分病因——DEGRADED_HTTP = HTTP 失败但端口可连（半死，
   * 连续 N 拍升级为受控重启）；DEGRADED_LOG = HTTP 成功但日志异常签名（绝不触发重启，
   * 保留既有「重启会打断活动 turn」语义）。
   */
  enum class ProbeState { HEALTHY, DEGRADED_HTTP, DEGRADED_LOG, DEAD }

  /** DEGRADED_HTTP 阶梯阈值：6 拍 × 5s = 30s（与 restartDeadConfirmations 同量级，远小于 90s 冷启动上限）。 */
  const val DEGRADED_RESTART_CONFIRMATIONS = 6

  /**
   * 「慢」的宽限拍数（issue #274 ①）：slowProbe 否决破坏性动作的**上界**。
   *
   * 为什么需要上界而不是无条件否决：真机上半死引擎的探活形态也是超时，与长 turn 的单次观测
   * 无法区分；无条件否决会让真卡死的引擎永远救不回来（破坏 0.14.1 锁存盲区回归）。
   * 3 倍阶梯 = 18 拍 ≈ 90s，与 START_COOLDOWN_MS 的冷启动预算同量级。
   */
  const val DEGRADED_SLOW_GRACE_TICKS = DEGRADED_RESTART_CONFIRMATIONS * 3

  /** 引擎日志尾部签名：插件树装配失败（`plugin tree failed to load`）。 */
  const val SIGNATURE_PLUGIN_TREE = "plugin-tree"

  /** 引擎日志尾部签名：其它未捕获异常（不参与升级，保留「HTTP 活着就不打扰」语义）。 */
  const val SIGNATURE_UNCAUGHT = "uncaught"

  @Volatile
  var consecutiveFailures = 0
    private set

  @Volatile
  var consecutiveDegradedHttp = 0
    private set

  /**
   * 插件树装配失败的连续拍数（2026-09-21 新增）。
   *
   * 为什么必须单独立账：`DEGRADED_LOG` 原来在 `planTick` 里**直接早退 IDLE**（HTTP 活着就不打扰），
   * 于是「插件树 failed to load」这条形态既没有阶梯、也永远求值不到 `undoReady()`——设备实测
   * （注入坏插件 → 重启引擎）：引擎 HTTP 活着但插件树挂死，`undo-gate.log` 里连 arm 都没有，
   * 用户只能手动重启。装配失败与「活动 turn 里炸了一次」是两回事，前者必须能自救。
   */
  @Volatile
  var consecutivePluginTreeFailures = 0
    private set

  /** 最近一次探活读到的日志签名（[assessProbe] 写、[recordProbe]/[planTick] 读）。 */
  @Volatile
  private var lastLogSignature: String? = null

  /**
   * 退避阶梯（纯函数，JVM 单测）：5s → 10s → 20s → 40s → 80s 封顶。
   * #210.2：入参必须是 [effectiveFailureCount]（半死与 DEAD 共用计数）。只读
   * `consecutiveFailures` 时 DEGRADED_HTTP 恒 5s——与 [tripped] 的熔断口径自相矛盾。
   */
  fun delayForFailureCount(count: Int): Long {
    val n = (count - 1).coerceAtLeast(0).coerceAtMost(4)
    return (5_000L shl n).coerceAtMost(80_000L)
  }

  /** Exponential delay for destructive recovery attempts (death or half-dead ladder). */
  fun nextDelayMs(): Long = delayForFailureCount(effectiveFailureCount())

  /** Only a confirmed dead process contributes to the restart/undo circuit breaker. */
  fun recordProbe(state: ProbeState, signature: String? = lastLogSignature) {
    consecutiveFailures = if (state == ProbeState.DEAD) consecutiveFailures + 1 else 0
    consecutiveDegradedHttp = nextDegradedCount(state, consecutiveDegradedHttp)
    consecutivePluginTreeFailures = nextPluginTreeCount(state, signature, consecutivePluginTreeFailures)
  }

  /** 纯函数（JVM 单测）：DEGRADED_HTTP 自增，其余状态清零。 */
  fun nextDegradedCount(state: ProbeState, count: Int): Int =
    if (state == ProbeState.DEGRADED_HTTP) count + 1 else 0

  /** 纯函数（JVM 单测）：**只认**插件树签名（不跟 DEGRADED_LOG 整类计数，见字段注释）。 */
  fun nextPluginTreeCount(state: ProbeState, signature: String?, count: Int): Int =
    if (pluginTreeHung(state, signature)) count + 1 else 0

  /** 纯函数：是否「插件树挂死」（HTTP 活着但 loader entry 导入失败）。 */
  fun pluginTreeHung(state: ProbeState, signature: String?): Boolean =
    state == ProbeState.DEGRADED_LOG && signature == SIGNATURE_PLUGIN_TREE

  /** 熔断与退避共用同一计数（#175：半死阶梯与 DEAD 共用退避，防重启风暴）。 */
  fun effectiveFailureCount(): Int = maxOf(consecutiveFailures, consecutiveDegradedHttp, consecutivePluginTreeFailures)

  fun tripped(): Boolean = effectiveFailureCount() >= MAX_CONSEC_FAILURES

  fun degradedHttpTripped(): Boolean = consecutiveDegradedHttp >= DEGRADED_RESTART_CONFIRMATIONS

  fun reset() {
    consecutiveFailures = 0
    consecutiveDegradedHttp = 0
    consecutivePluginTreeFailures = 0
    lastLogSignature = null
    lastProbeTimedOut = false
    lastLogTail = ""
  }

  /**
   * Classifies liveness without treating a temporary HTTP stall or a historical
   * log line as proof of process death. A live port is degraded because the UI
   * may be slow, but restarting it would interrupt the active turn.
   *
   * 只做分类，不承担副作用（#210.4）：标记消费由 [planTick] 的前置段在**任何状态**下
   * 统一执行——挂在 HEALTHY 分支尾部正是「DEGRADED_LOG 早退吞掉消费」的成因。
   */
  /**
   * 引擎日志尾部的**强证据签名**（issue #274 ①）：只有这些才支持「破坏性自愈」。
   *
   * 真因：`assessProbe` 在 HTTP 超 2.5s 预算时给 DEGRADED_HTTP（注释自承实测出现过 3061ms）。
   * 长 turn / 慢磁盘足以让一次探活超预算 ⇒ 连续 6 拍（30s）即升级为「受控重启」，
   * 而那条路径**会回滚用户配置并强杀活引擎**。一次慢响应不该有这种权限。
   *
   * 判据（命中任一条 = 有强证据，才允许跑破坏性阶梯）：
   *  - `EADDRINUSE`：端口被别人占着（我们自己起不来，等下去也不会好）；
   *  - `plugin tree failed to load`：插件树装配失败（引擎没起来，不会自愈）；
   *  - `uncaught`：未捕获异常（进程已不可信）。
   *
   * **反向要求**：`reset()` 不得因此类证据缺失而破坏既有坑 153 的语义——半死引擎的 undo/
   * 重启必须仍能生效。故本判据只否决**破坏性**阶梯（DEGRADED_HTTP → 重启/回滚），
   * 不影响 DEAD 判定（进程真的没了是硬事实，不看日志）。
   */
  internal fun strongEvidenceForDestructiveRecovery(logTail: String?): Boolean {
    if (logTail.isNullOrEmpty()) return false
    return logTail.contains("EADDRINUSE")
      || logTail.contains("plugin tree failed to load")
      || logTail.contains("uncaught", ignoreCase = true)
  }

  /**
   * 端口是否**不是**被本进程持有（issue #274 ① 的第二条判据）。
   *
   * 用途：DEGRADED_HTTP（端口可连但 HTTP 失败）有两种成因——① 我们自己半死（该救）；
   * ② 端口被**别的**进程占着（我们把别人的服务当成了自己的引擎，重启我们毫无用处，
   * 只会强杀活引擎 + 回滚用户配置）。`EADDRINUSE` 是 ② 的日志形态；
   * 拿不到进程归属时保守返回「可能是本进程」（不因测量失败而放宽破坏性动作）。
   */
  internal fun portOwnedByOtherProcess(portOwnedByApp: Boolean?): Boolean = portOwnedByApp == false

  /**
   * 最近一次探活是否**超时**（而非连接被拒）。
   *
   * 为什么必须区分（issue #274 ①）：HTTP 超 2.5s 预算 = 「引擎在忙 / 磁盘慢」，
   * 而连接被拒 = 端口根本没开 = 引擎真的不在。前者绝不该成为回滚用户配置的理由。
   * 实测出现过 3061ms 的一次超预算（本文件注释自承），单靠拍数无法区分这两者。
   */
  @Volatile
  var lastProbeTimedOut = false
    private set

  /**
   * 最近一次探活读到的引擎日志尾部原文（[assessProbe] 写、证据面读）。
   *
   * 为什么保留原文而不只保留签名：回滚的证据门要判 `EADDRINUSE` 这类**具体**形态，
   * 而签名会把它们压成 `uncaught`/`plugin-tree` 之外的 null。原文让判据可扩展、可诊断。
   */
  @Volatile
  var lastLogTail: String = ""
    private set

  fun assessProbe(context: Context, callerCurrent: () -> Boolean = { true }): ProbeState {
    if (!callerCurrent()) return ProbeState.DEAD
    val probe = EngineProbe.check(2_500)
    if (!callerCurrent()) return ProbeState.DEAD
    // 「超时」与「拒绝」是两种病因：前者是慢，后者是死。记下来供证据面使用。
    lastProbeTimedOut = probe.optString("error", "") == "timeout"
    // 日志尾部**必须在任何早退之前读**：证据门关心的正是 DEGRADED_HTTP 这一支
    // （它就在下面那个 `if (!base)` 里提前返回）。旧写法把读取放在健康分支之后，
    // 于是最需要证据的时刻 lastLogTail 恒为空 —— 判据形同虚设。
    val tail = readEngineLogTail(context)
    if (!callerCurrent()) return ProbeState.DEAD
    lastLogTail = tail
    lastLogSignature = logSignatureOf(tail)
    val base = probe.optBoolean("running", false)
    if (!base) return if (EngineProbe.portReachable(1_000)) ProbeState.DEGRADED_HTTP else ProbeState.DEAD
    val signature = lastLogSignature
    if (signature != null) {
      LogCollector.log(TAG, "engine log reports a recoverable warning while HTTP remains alive: " + signature)
      return ProbeState.DEGRADED_LOG
    }
    return ProbeState.HEALTHY
  }

  /**
   * 一拍看门狗的决策。#210.3 / #210.4（源文档 §3.3 B1 顺序约束第 1 条）：
   * 三个状态无关副作用（onEngineProbe 更新回退确认、标记消费、唤醒锁续期）在
   * **任何分支早退之前**执行——含 [tripped] 熔断打开的那一拍；否则 12 拍之后
   * 所有修复都被熔断早退吞掉。调用方（EngineService）只按返回值执行破坏性动作。
   */
  internal fun planTick(
    state: ProbeState,
    now: Long,
    nextRestartAllowedAt: Long,
    engineReady: Boolean,
    engineProcessAlive: Boolean,
    bootAgeMs: Long,
    restartDeadConfirmations: Int,
    startCooldownMs: Long = EngineManager.START_COOLDOWN_MS,
    /** 本拍的引擎日志签名（[assessProbe] 写、这里读；测试显式传，避免为测试在生产面留钩子）。 */
    logSignature: String? = lastLogSignature,
    /**
     * 端口是否归本应用持有（issue #274 ①）。null = 未知（不否决）。
     * 生产面由 EngineService 从进程归属算出；JVM 测试直接传值。
     */
    portOwnedByApp: Boolean? = null,
    /**
     * 本次探活是否**超时**（=引擎在忙/磁盘慢），而非连接被拒（=真的死）。
     * 默认取 [lastProbeTimedOut]；测试可显式注入。
     */
    slowProbe: Boolean = lastProbeTimedOut,
    feedProbe: (Boolean) -> Unit,
    consumeMarkers: () -> Unit,
    refreshWake: () -> Unit,
    undoReady: () -> Boolean,
    callerCurrent: () -> Boolean = { true },
  ): TickPlan {
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    // ── 前置副作用（#210.3/#210.4）：与状态分类无关，先于一切早退 ──
    feedProbe(state == ProbeState.HEALTHY)
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    recordProbe(state, logSignature)
    consumeMarkers()
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    refreshWake()
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)

    val logs = ArrayList<String>(2)
    val degradedLadderTripped = state == ProbeState.DEGRADED_HTTP && degradedHttpTripped()
    val alive = state != ProbeState.DEAD
    if (degradedLadderTripped) {
      logs += "DEGRADED_HTTP 连续 " + consecutiveDegradedHttp + " 拍（端口可连但 HTTP 持续失败）→ 升级为受控重启"
    }
    // 【issue #274 ①】破坏性动作的证据门。**本条只作用于「强杀一个还活着的进程」这一件事**
    // （下面的 RESTART 分支），不拦 undo、也不拦「重启一个已经死掉的进程」。
    //
    // 为什么不能拿「日志里没有强证据」当否决理由：logSignature 只在与已知签名（插件树失败/
    // uncaught）匹配时才非空，**其常态就是 null**（生产也一样）。拿它做前提会让半死引擎
    // 永久救不回来，直接破坏 0.14.1 的锁存盲区回归（halfDeadEngineStillReachesUndo…）——
    // 那条防线要求「托管进程活着但 HTTP 永不健康」时 undo 仍能在预算用尽后介入。
    //
    // 因此判据取**正向证据**（指认「是慢、不是死」或「占着端口的不是我们」），而不是
    // 「缺少证据」：
    //   · [slowProbe]：本次探活**超时**（引擎在忙 / 磁盘慢）⇒ 它可能就是没死，先不动它；
    //   · 端口**由他进程持有** ⇒ 重启我们不解决问题（该处理的是那个占用者）——这条**无上界**（它是硬事实）。
    // 注意 `error=refused`（端口没开）**不算**慢——那是真的死，必须能走恢复流程。
    val portForeign = portOwnedByOtherProcess(portOwnedByApp)
    // 「慢」的否决是**有界宽限**，不是永久封锁 —— 这一点是刻意的，理由如下：
    //
    // 真机上半死引擎（进程在、HTTP 永远不健康）的探活形态**同样是超时**，与「长 turn 导致的
    // 慢」在单次观测里无法区分。若把 slowProbe 做成无条件否决，就再也救不回真正卡死的引擎，
    // 直接破坏 0.14.1 锁存盲区回归（halfDeadEngineStillReachesUndo…：它要求托管进程存活时
    // undo 仍能在预算用尽后介入）——那是**生产语义**，不是测试注入口径。
    //
    // 所以宽限只覆盖「比常态阶梯长得多」的一段：阶梯 6 拍（30s）到达时先不动手，
    // 继续观察；慢若持续到 [DEGRADED_SLOW_GRACE_TICKS] 拍（= 3 倍阶梯，约 90s）仍无改善，
    // 视为真卡死，放行破坏性动作。这既消掉 #274 的「30s 慢响应就回滚」，又不制造死局。
    val slowGraceExhausted = consecutiveDegradedHttp >= DEGRADED_SLOW_GRACE_TICKS
    // 强证据（EADDRINUSE / 插件树装配失败 / uncaught）**解除**「慢」这条否决：
    // 它把「探活超时」从「可能只是在忙」变成「确知引擎坏了」。
    // 注意方向——证据是**放行**的理由，不是**前置条件**（后者会挡掉必需的第 6 拍，见上）。
    val strongEvidence = strongEvidenceForDestructiveRecovery(logSignature)
    // 两组条件作用面不同，故用「或」：
    //  · portForeign：监听者不是我们 ⇒ **任何**恢复动作都不解决问题（含子进程已死时盲目重启）；
    //  · slowProbe：探活只是超时，但**只有在我们确实托管着一个活进程时**才谈得上「别强杀它」；
    //    子进程已死时重启它不具破坏性，不该被这条拦住。
    val destructiveBlocked = degradedLadderTripped &&
      (portForeign || (engineProcessAlive && slowProbe && !slowGraceExhausted && !strongEvidence))
    // DEGRADED_LOG 保留「绝不重启」语义：HTTP 存活时重启会打断活动 turn。
    // **例外：插件树装配失败**（[pluginTreeHung]）。那一刻引擎没起来，且不会自愈——设备实测
    // （2026-09-21，注入坏插件后重启）：本行早退 IDLE ⇒ 自动 undo 永不被求值（调用方还会在 IDLE
    // 拍 disarm），用户只剩手动重启。放行到 undo 决策后，配置回滚才有机会把坏插件剔出去。
    if (alive && !degradedLadderTripped && !pluginTreeHung(state, logSignature)) {
      return TickPlan(TickAction.IDLE)
    }
    if (!engineReady) return TickPlan(TickAction.HOLD)
    // 「confirmed-dead sample」这一档是给**进程死亡**留的观察期；插件树挂死形态下 consecutiveFailures
    // 恒为 0（那是 DEAD 专用计数），不放行的话这里会永远 HOLD，undo 决策同样到不了。
    if (!degradedLadderTripped && !pluginTreeHung(state, logSignature) &&
      consecutiveFailures < restartDeadConfirmations) {
      return TickPlan(
        TickAction.HOLD,
        listOf("confirmed-dead sample " + consecutiveFailures + "/" + restartDeadConfirmations + "; observing before restart"),
      )
    }
    // 冷启动预算内的托管子进程：任何破坏性动作（含配置回滚）都推迟到它用满预算之后，
    // 避免把「还在冷启动」误判成「起不来」。
    if (engineProcessAlive && bootAgeMs in 0 until startCooldownMs) {
      return TickPlan(TickAction.HOLD, logs + "dead probe deferred while the tracked child remains inside its boot window")
    }
    // ── undo 必须先于熔断锁存（0.14.1 修复的锁存盲区）────────────────────────
    // 缺陷形态（存量，非本迭代引入）：[tripped] 曾排在本分支之前，而它一旦为真即**永久** HOLD，
    // 只有 HEALTHY 探活或 EngineStartFlow 的唯一一处 `WatchdogV2.reset()` 能解。而熔断在
    // effectiveFailureCount >= 12 时打开（12 拍 x 5s = 60s），却小于 START_COOLDOWN_MS = 90s 的
    // 启动预算——于是「托管子进程仍存活、但 HTTP 永远不健康」（半死引擎 / 插件树挂住）这条路径上，
    // 计数器先撞满 12，本函数此后**再也不会求值 undoReady()**：自动 undo 与自动重启同时永久失效。
    // 配置回滚（undo）与「禁止盲目重启」（熔断）是两种正交的恢复手段，不应互斥：先给 undo 机会，
    // 熔断继续守它该守的「undo 不可用时不得盲目反复重启」。反向对照见 WatchdogLadderTest 的
    // circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable。
    // 【issue #274 ①】破坏性动作的证据门（**位于 undo 之前**，因为 undo 也会回滚用户配置，
    // 那正是本 issue 要收窄的对象之一）。
    //
    // 只在「托管进程还活着」时才可能误伤——进程已死时下面任何动作都只是恢复，不是破坏。
    // 判据取**正向证据**（指认「是慢、不是死」或「占端口的不是我们」）：
    //   · [slowProbe]：本次探活超时（引擎在忙/磁盘慢）⇒ 它没死，掐掉它是 #274 的靶子；
    //   · 端口由他进程持有 ⇒ 重启/回滚我们都不解决问题。
    // **不得**用「日志里没有强证据」当否决理由：logSignature 常态就是 null（只在与插件树失败 /
    // uncaught 匹配时非空），拿它做前提会把半死引擎永久锁死，破坏 0.14.1 的锁存盲区回归。
    if (destructiveBlocked) {
      return TickPlan(
        TickAction.HOLD,
        logs + if (portForeign)
          "destructive recovery withheld: the listening port belongs to another process; restarting us cannot help"
        else
          "destructive recovery withheld: the probe timed out (slow engine/disk), not a dead engine"
      )
    }
    if (undoReady()) {
      return TickPlan(TickAction.UNDO, logs + ("auto-undo trigger after confirmed failures=" + effectiveFailureCount()))
    }
    // 熔断守的是「undo 不可用时不得盲目反复重启」。插件树挂死是例外：此时 undo 可能被 30 分钟重试窗
    // 闸掉，若再被熔断锁进 HOLD，就再也没有任何自动路径（引擎不会自愈、也永远等不到 HEALTHY 去解锁）
    // ——只剩手动重启。放行重启（仍受退避节流）比锁死好；坏配置下次启动照旧失败，但至少不是死局。
    if (tripped() && !pluginTreeHung(state, logSignature)) {
      return TickPlan(TickAction.HOLD, logs + "watchdog circuit open after confirmed-dead failures; destructive recovery paused")
    }
    if (now < nextRestartAllowedAt) {
      return TickPlan(TickAction.HOLD, logs + ("restart deferred for " + (nextRestartAllowedAt - now) + "ms"))
    }
    return TickPlan(TickAction.RESTART, logs, force = engineProcessAlive)
  }

  /** watchdog 一拍的恢复动作（#210.2/.3/.4）。 */
  enum class TickAction {
    /** 存活且未触发半死阶梯：调用方复位重启窗口并解除 undo 观察。 */
    IDLE,
    /** 本拍不动作（未就绪 / 观察窗 / 熔断打开 / 启动冷却 / 重启节流）。 */
    HOLD,
    /** 触发配置层急救回撤（UndoGate）。 */
    UNDO,
    /** 请求受控重启（force = 托管子进程仍在场，须换进程）。 */
    RESTART,
  }

  /** [planTick] 的决策结果；[logs] 为本次 tick 应写入 dsh-watchdog 的结构化行。 */
  data class TickPlan(
    val action: TickAction,
    val logs: List<String> = emptyList(),
    val force: Boolean = false,
  )

  /** Compatibility projection for callers that only need a strict HTTP health bit. */
  fun deepProbe(context: Context): Boolean = assessProbe(context) == ProbeState.HEALTHY

  /** 会话短哈希（D14：标题缺失时的可区分回落，非字面量）。 */
  private fun markerTag(sessionId: String): String {
    if (sessionId.isEmpty()) return "未知"
    return (sessionId.hashCode() and 0x7fffffff).toString(16).padStart(6, '0').takeLast(6)
  }

  /** 引擎事件桥标记文件（dsh-android-bridge 写入 home/.dsh/.task-done.ndjson；经 context 推导）。 */
  private fun taskMarkerFile(context: Context): java.io.File =
    java.io.File(File(context.filesDir, "home/.dsh"), ".task-done.ndjson")

  /** 标记文件消费偏移（FX-212.3：按字节推进；-1 = 尚未从 prefs 装载）。 */
  @Volatile
  private var markerOffset = -1L

  /** 单次读取上限（与 OverlayLiveFeed / NotifyStore 同口径：行边界在 CAP 内，溢出留到下一轮）。 */
  internal val markerReadCapBytes: Int = 256 * 1024

  /** 消费窗口的纯函数结果：[lines] 整行；[advance] 本次可推进的字节数（到最后一个换行符）。 */
  internal data class MarkerWindow(val lines: List<String>, val advance: Long)

  /**
   * FX-212.3（纯函数，JVM 单测）：从一个读取窗口里取出**整行前缀**。
   * 没有换行（半行）时 advance=0 —— 偏移不推进，等下一拍补齐；多字节被截断的尾字符同理自然消失。
   * 旧实现 readLines() + writeText("") 的三态缺陷（读-清窗口吞行、清零窗口重复投递、无界读）
   * 都靠「只推进整行 + 从不截断」这一条消掉。
   */
  internal fun markerConsumeWindow(payload: ByteArray, length: Int): MarkerWindow {
    val n = length.coerceAtMost(payload.size)
    var last = -1
    var i = n - 1
    while (i >= 0) {
      if (payload[i] == '\n'.code.toByte()) { last = i; break }
      i--
    }
    if (last < 0) return MarkerWindow(emptyList(), 0L)
    val lines = ArrayList<String>()
    for (piece in String(payload, 0, last, Charsets.UTF_8).split("\n")) {
      val t = piece.trim()
      if (t.isNotEmpty()) lines.add(t)
    }
    return MarkerWindow(lines, (last + 1).toLong())
  }

  private fun markerOffsetOf(context: Context): Long {
    if (markerOffset < 0) markerOffset = NotifyCenter.prefs(context).getLong(KEY_MARKER_OFFSET, 0L)
    return markerOffset
  }

  private fun markerOffsetTo(context: Context, value: Long) {
    markerOffset = value
    try {
      NotifyCenter.prefs(context).edit().putLong(KEY_MARKER_OFFSET, value).apply()
    } catch (_: Exception) {
      // prefs 写失败只损「重启后偏移」，不影响本轮消费
    }
  }

  /**
   * 消费任务完成标记（FX-212.3，按偏移推进；**不再截断文件**）。
   *
   * 为什么偏移要落 prefs（对计划口径的唯一增补）：只放内存时，进程每次重启 offset 归零 →
   * 「新壳 + 老引擎」组合（没有 .notify.ndjson，双读不双发门永不置位）会把历史标记**重复通知**一遍；
   * 落 prefs 后：离线期间写入的标记仍会被消费（保留原语义），重启不重放。
   *
   * #210.4：由 [planTick] 的前置段调用——HEALTHY/DEGRADED_HTTP/DEGRADED_LOG/DEAD 四态都要消费。
   */
  internal fun consumeTaskDoneMarkers(context: Context) {
    val debugLog = java.io.File(context.filesDir, "notify-debug.log")
    fun dbg(msg: String) { try { debugLog.appendText(System.currentTimeMillis().toString() + " " + msg + "\n") } catch (_: Exception) {} }
    try {
      val f = taskMarkerFile(context)
      if (!f.exists()) return
      val len = f.length()
      var offset = markerOffsetOf(context)
      if (len < offset) {
        // 文件被轮转/重建（旧 truncate 语义或外部清理）：偏移归零重新读
        dbg("marker shrunk: len=" + len + " offset=" + offset + " -> 0")
        markerOffsetTo(context, 0L)
        offset = 0L
      }
      if (len == offset) return
      var window = MarkerWindow(emptyList(), 0L)
      try {
        java.io.RandomAccessFile(f, "r").use { raf ->
          val want = (len - offset).coerceAtMost(markerReadCapBytes.toLong()).toInt()
          val buf = ByteArray(want)
          raf.seek(offset)
          val read = raf.read(buf)
          if (read > 0) window = markerConsumeWindow(buf, read)
        }
      } catch (e: Exception) {
        dbg("marker read failed: " + (e.message ?: e.javaClass.simpleName))
        return
      }
      dbg("marker window: len=" + len + " offset=" + offset + " consumedBytes=" + window.advance + " lines=" + window.lines.size)
      var notified = 0
      for (line in window.lines) {
        dbg("line: " + line)
        try {
          val j = org.json.JSONObject(line)
          // D14 同源约束：标题缺失时回落可区分标识，不再回落字面量「任务完成」。
          // 0.14.1 批 3（P3-6）：**不再回落哈希片段**——旧实现是「会话 3f9a21」，那是内部 id 的哈希，
          // 用户既认不出也搜不到（审查档 §4.1）。这里退回人类可读标题。
          // 如实说明代价：旧信道**没有**会话可分性（本项目 `legacyFallback` 一律走 `kind="silent"`、
          // dedupeKey 固定，所有帧覆盖同一条通知），所以哈希带来的「可区分」本来就只在**覆盖前后**可见，
          // 不值得为它把机器码留在屏上。会话可分性由 `.notify.ndjson` 新信道（按会话分桶）提供。
          val title = j.optString("title").ifBlank { "一轮任务已完成" }
          dbg("legacy title fallback session=" + markerTag(j.optString("sessionId")))
          val snippet = j.optString("text").ifBlank { "引擎已完成一轮任务处理" }
          // NT-09 双读不双发：.notify.ndjson 已服役时旧信道只做回退（不在两处重复投递）
          val posted = NotifyStore.legacyFallback(context, title, snippet)
          if (posted) notified++
          dbg("notify returned ok=" + posted)
        } catch (e: Exception) {
          dbg("notify threw: " + (e.message ?: e.javaClass.simpleName))
        }
      }
      // 只推进整行字节；**永不 writeText("")**（截断会清零窗口内的行，且崩溃中途会重复投递）
      if (window.advance > 0) markerOffsetTo(context, offset + window.advance)
      dbg("done notified=" + notified + " consumedLines=" + window.lines.size + " newOffset=" + markerOffset)
    } catch (e: Exception) {
      dbg("consume outer threw: " + (e.message ?: e.javaClass.simpleName))
    }
  }

  /** 引擎日志尾部异常扫描（最近 4KB 内 fatal/Error 关键字；命中率控制：只取尾部）。 */
  /** 读引擎日志尾部 4KB，返回命中的签名（[SIGNATURE_PLUGIN_TREE] 优先；无命中 null）。 */

  /** 纯函数：日志尾部文本 → 签名（插件树优先于未捕获异常）。 */
  internal fun logSignatureOf(tail: String): String? = when {
    tail.contains("plugin tree failed to load") -> SIGNATURE_PLUGIN_TREE
    tail.contains("UncaughtException") -> SIGNATURE_UNCAUGHT
    else -> null
  }

  private fun readEngineLogTail(context: Context): String {
    return try {
      val f = java.io.File(context.filesDir, "engine.log")
      if (!f.exists()) return ""
      java.io.RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        val off = (len - 4096).coerceAtLeast(0)
        raf.seek(off)
        val buf = ByteArray((len - off).toInt().coerceAtMost(4096))
        val n = raf.read(buf)
        String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
      }
    } catch (_: Exception) {
      ""
    }
  }

  /** A terminal owner belongs to one Service epoch; no process-global wake handle exists. */
  internal data class WakeAcquisition(val lock: PowerManager.WakeLock, val renewAt: Long)
  internal class WakeLockOwner {
    internal val acquisition = EpochResourceOwner<WakeAcquisition> { held ->
      try { if (held.lock.isHeld) held.lock.release() } catch (_: Throwable) {}
    }
  }

  internal fun acquireWakeLock(context: Context, owner: WakeLockOwner) {
    try {
      owner.acquisition.install(
        acquire = {
          val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
          val candidate = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:engine")
          try {
            candidate.setReferenceCounted(false)
            candidate.acquire(30 * 60 * 1000L)
            WakeAcquisition(candidate, android.os.SystemClock.elapsedRealtime() + 25 * 60 * 1000L)
          } catch (t: Throwable) {
            try { if (candidate.isHeld) candidate.release() } catch (_: Throwable) {}
            throw t
          }
        },
        keepExisting = { held -> android.os.SystemClock.elapsedRealtime() < held.renewAt && held.lock.isHeld },
      )
    } catch (t: Throwable) {
      Log.e(TAG, "wake lock acquire failed (degraded best-effort)", t)
    }
  }

  /** Renew with a new acquisition; a released handle is never re-acquired by a stale tick. */
  internal fun refreshWakeLock(context: Context, owner: WakeLockOwner) = acquireWakeLock(context, owner)

  internal fun releaseWakeLock(owner: WakeLockOwner) { owner.acquisition.close() }
}

/** CAS publication/terminal teardown. Acquisition and release may block, but never hold a lock. */
internal class EpochResourceOwner<T : Any>(private val release: (T) -> Unit) {
  private data class State<T>(val closed: Boolean = false, val resource: T? = null)
  private val state = java.util.concurrent.atomic.AtomicReference(State<T>())

  fun install(acquire: () -> T, keepExisting: (T) -> Boolean = { false }): Boolean {
    val before = state.get()
    if (before.closed) return false
    if (before.resource?.let(keepExisting) == true) return state.get() === before
    // Teardown may win while acquire waits in Binder. Its terminal state rejects publication.
    val candidate = acquire()
    if (!state.compareAndSet(before, State(resource = candidate))) {
      release(candidate) // Only this unpublished acquisition; never the replacement owner's handle.
      return false
    }
    before.resource?.let(release)
    return true
  }

  fun close() {
    val before = state.getAndSet(State(closed = true))
    before.resource?.let(release)
  }
}
