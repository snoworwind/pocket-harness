package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 壳侧路由与失败面编排的回归（CONTRACT §1/§3/§4/§6/§8）。
 *
 * 为什么必须有它：本改动横跨**三处壳侧咽喉**，每一处坏掉都只在设备上表现为
 * 「用户永远停在坏页面」或「自动回滚永不触发」，而两者都不可从 UI 反推——
 *
 * - [LogCollector] 的契约行分流（前缀逐字一致 / failedIds 解析）；
 * - [MainActivity] 的控制台分支顺序与「不吞第三方日志」；
 * - [EngineStartFlow] 的 latch、防弹回闸门与一次性回滚编排。
 *
 * 其中编排部分需要 Activity/WebView，无法在 JVM 里实例化，故用「纯函数直测 +
 * 生产源码结构断言（剥注释后）」两层：前者证判据，后者证**接线**（块J FIX-4 的教训：
 * 能力在、入口无 = 未完成）。
 */
class ClientPluginFailRouteTest {

  /**
   * 剥掉 Kotlin 注释后的「真代码」文本（先块注释、再行注释）。
   *
   * 为什么必须剥：本仓已实测过「判据命中了注释里的同一个词」造成的假红假绿
   * （见 BootPageConsoleRouteTest 的同名工具）。源码结构断言只看会执行的行。
   */
  private fun codeOnly(src: String): String =
    src.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .lineSequence()
      .joinToString("\n") { line -> line.substringBefore("//") }

  private fun src(name: String): String =
    java.io.File("src/main/java/com/dsharnessmobile/shell/" + name).readText()

  // ── §1 契约行前缀：必须与页面侧 BOOT_FAILED_PREFIX 逐字一致 ──────────────────
  @Test
  fun pluginFailPrefixMatchesThePageSideConstantVerbatim() {
    assertEquals("[dsh-boot-failed]", LogCollector.PAGE_PLUGIN_FAIL_PREFIX)
  }

  // ── §3 失败行识别：行首前缀判定（trimStart 后 startsWith）─────────────────────
  @Test
  fun pluginFailLineIsRecognisedByLeadingPrefixOnly() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail detail=reason=x failedIds=live2d-pet pageSideRuntime={}"
    assertTrue(LogCollector.isClientPluginTreeFailureMessage(line))
    assertTrue("前导空白不得让契约行漏判", LogCollector.isClientPluginTreeFailureMessage("  " + line))
    assertFalse("就绪行不是失败行", LogCollector.isClientPluginTreeFailureMessage("[dsh-boot-ready] dsh-boot-diag"))
    assertFalse("卡住行不是失败行", LogCollector.isClientPluginTreeFailureMessage("[dsh-boot-stall] dsh-boot-diag"))
    assertFalse("仅子串出现不得命中（前缀必须在行首）",
      LogCollector.isClientPluginTreeFailureMessage("see [dsh-boot-failed] for details"))
    assertFalse("空行不得命中", LogCollector.isClientPluginTreeFailureMessage(""))
  }

  // ── §3 failedIds 解析（含 '-'、空、超限、截断）──────────────────────────────
  @Test
  fun failedIdsAreParsedCommaSeparatedWithoutQuotesOrSpaces() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=live2d-pet,@scope/pkg,third.one pageSideRuntime={}"
    assertEquals(listOf("live2d-pet", "@scope/pkg", "third.one"), LogCollector.clientFailedIdsOf(line))
  }

  @Test
  fun emptyPlaceholderAndMissingFieldYieldNoIds() {
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=- pageSideRuntime={}"))
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail pageSideRuntime={}"))
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds= pageSideRuntime={}"))
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf(""))
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf("no field here"))
  }

  @Test
  fun illegalAndOverlongIdsAreRejectedInsteadOfFabricated() {
    // 形状不合法（与页面侧同款过滤口径）：引号包裹、含空格、等号起头。
    // 注意：字段值以空白结束（契约保证「无引号无空格」），因此这里只放**不含空格**的坏项。
    val dirty = "[dsh-boot-failed] dsh-boot-diag failedIds='quoted',=x,ok-one pageSideRuntime={}"
    assertEquals(listOf("ok-one"), LogCollector.clientFailedIdsOf(dirty))
    // 超长 id（>120）必须被拒——它是 fold 截断的典型残骸，传进外科拔除就是误删风险。
    val longId = "a".repeat(121)
    assertEquals(emptyList<String>(),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + longId + " pageSideRuntime={}"))
    val maxId = "a".repeat(120)
    assertEquals(listOf(maxId),
      LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + maxId + " pageSideRuntime={}"))
  }

  @Test
  fun atMostEightIdsSurvive() {
    val nine = (1..9).joinToString(",") { "id-" + it }
    val ids = LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedIds=" + nine + " pageSideRuntime={}")
    assertEquals(8, ids.size)
    assertEquals("id-1", ids.first())
    assertEquals("id-8", ids.last())
  }

  @Test
  fun truncatedTrailingIdIsNotGuessed() {
    // fold 截断把最后一个 id 劈成半截：半截仍是合法形状时必须**原样返回**（不猜、不补），
    // 由上层 clientPullCandidate 的「必须唯一命中」判据兜底。
    val truncated = "[dsh-boot-failed] dsh-boot-diag failedIds=good-one,live2d-pet@dsh-android/dsh-live2d-pe"
    assertEquals(listOf("good-one", "live2d-pet@dsh-android/dsh-live2d-pe"), LogCollector.clientFailedIdsOf(truncated))
    // 字段本身被截断（连 failedIds= 都没写全）：空列表，绝不臆造。
    assertEquals(emptyList<String>(), LogCollector.clientFailedIdsOf("[dsh-boot-failed] dsh-boot-diag failedId"))
  }

  // ── §3 routePageConsole 第三分支（source 仍 page-console，排在 ready/stall 之后）──
  @Test
  fun pluginFailLineRoutesToPageConsoleAsThirdBranch() {
    val line = "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=x pageSideRuntime={}"
    val route = LogCollector.routePageConsole(line)
    assertEquals("page-console", route?.source)
    assertTrue("detail 必须原样透传（壳侧不再序列化，避免两处格式漂移）", route!!.detail.startsWith("[dsh-boot-failed]"))
    // 既有两条分支语义不变（顺序契约：ready/stall 先生效）。
    assertEquals("page-console", LogCollector.routePageConsole("[dsh-boot-ready] x")?.source)
    assertEquals("page-console", LogCollector.routePageConsole("[dsh-boot-stall] x")?.source)
  }

  @Test
  fun multiLineFailureLineIsFolded() {
    val route = LogCollector.routePageConsole("[dsh-boot-failed] dsh-boot-diag\nmore\nlines")
    assertEquals("page-console", route?.source)
    assertFalse(route!!.detail.contains("\n"))
  }

  // ── §8 路由不得吞掉第三方日志 ────────────────────────────────────────────────
  @Test
  fun unrelatedConsoleLinesAreNeverConsumed() {
    assertNull(LogCollector.routePageConsole("Uncaught TypeError: x is not a function"))
    assertNull(LogCollector.routePageConsole(""))
    assertNull(LogCollector.routePageConsole("prefix [dsh-boot-failed]"))
  }

  // ── §3 分支顺序与消费语义（源码结构断言）──────────────────────────────────────
  @Test
  fun consoleBranchOrderIsReadyThenStallThenClientFailThenRenderError() {
    val code = codeOnly(src("MainActivity.kt"))
    val onConsole = code.substringAfter("override fun onConsoleMessage(").substringBefore("override fun onShowFileChooser")
    val ready = onConsole.indexOf("isPageReadyMessage(")
    val stall = onConsole.indexOf("isPageStallMessage(")
    val clientFail = onConsole.indexOf("isClientPluginTreeFailureMessage(")
    val renderErr = onConsole.indexOf("isRenderErrorMessage(")
    assertTrue("顺序必须是 ready → stall → client-fail → render-error",
      ready in 0 until stall && stall < clientFail && clientFail < renderErr)
    val clientBlock = onConsole.substring(clientFail, renderErr)
    assertTrue("必须调用 onClientPluginTreeFailed", clientBlock.contains("engineFlow.onClientPluginTreeFailed("))
    assertTrue("契约行必须落 page-console 诊断", clientBlock.contains("LogCollector.writeBootDiag("))
    assertTrue("client-fail 返回 true（已消费）", clientBlock.contains("true"))
    assertTrue("render-error 仍返回 false（不吞页面报错）", onConsole.substring(renderErr).contains("false"))
    assertTrue("未命中必须交回默认 console 行为", onConsole.contains("else -> false"))
  }

  @Test
  fun renderErrorExclusionSetHasThreePrefixes() {
    val code = codeOnly(src("MainActivity.kt"))
    val fn = code.substringAfter("internal fun isRenderErrorMessage(").substringBefore("\n  }")
    assertTrue("必须排除就绪前缀", fn.contains("isPageReadyMessage("))
    assertTrue("必须排除卡住前缀", fn.contains("isPageStallMessage("))
    assertTrue("排除集必须扩到三个前缀（CONTRACT §3）", fn.contains("isClientPluginTreeFailureMessage("))
  }

  // ── §4 latch 置位/清除与双通道落盘（源码结构断言）────────────────────────────
  @Test
  fun latchIsDeclaredAndDefaultsToFalse() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    assertTrue("latch 必须默认 false（健康启动零动作）",
      Regex("@Volatile private var clientPluginTreeFailed = false").containsMatchIn(code))
    assertTrue("一次性回滚预算必须默认未花",
      Regex("@Volatile private var clientPluginTreeRecoverySpent = false").containsMatchIn(code))
    assertTrue("必须暴露只读访问器 clientPluginTreeFailedLatch",
      code.contains("internal val clientPluginTreeFailedLatch: Boolean get() = clientPluginTreeFailed"))
    assertTrue("必须提供 clearClientPluginTreeFailureLatch",
      code.contains("internal fun clearClientPluginTreeFailureLatch()"))
  }

  @Test
  fun onClientPluginTreeFailedWritesBothChannelsAndLatches() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("fun onClientPluginTreeFailed(").substringBefore("private fun maybeRecoverFromClientPluginTreeFailure(")
    assertTrue("必须落 boot-fail（stage=client-plugin-tree-failed）",
      fn.contains("LogCollector.writeBootFail(activity, \"client-plugin-tree-failed\""))
    assertTrue("必须有 Log.e 双通道", fn.contains("Log.e("))
    assertTrue("必须先置 latch 再呈现", fn.indexOf("clientPluginTreeFailed = true") < fn.indexOf("presentClientPluginFailure"))
    assertTrue("必须起后台回滚线程（不在 WebView 线程做 IO）", fn.contains("maybeRecoverFromClientPluginTreeFailure("))
  }

  @Test
  fun recoverySpendsExactlyOnceAndGoesThroughUndoGateExecute() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("private fun maybeRecoverFromClientPluginTreeFailure(")
    val head = fn.substringBefore("val engine = activity.engineManager")
    assertTrue("已花预算即直接 return（只花一次）", Regex("if \\(clientPluginTreeRecoverySpent\\) return").containsMatchIn(head))
    assertTrue("必须过一次性入口 UndoGate.onClientPluginTreeFailure",
      head.contains("UndoGate.onClientPluginTreeFailure(activity,"))
    assertTrue("实际动作必须走 UndoGate.execute（不重复决策）",
      fn.contains("UndoGate.execute(activity, engine, candidate)"))
    assertTrue("必须用 clientPullCandidate 纯判据点名", fn.contains("PluginMounts.clientPullCandidate("))
    assertTrue("必须区分「清单未变」才允许整份回滚", fn.contains("PluginMounts.mountUnchangedSinceHealthy("))
    assertTrue("成功后必须复位看门狗与冷却并强制重启引擎",
      fn.contains("WatchdogV2.reset()") && fn.contains("engine.resetCooldown()") &&
        fn.contains("engine.startEngine(force = true)"))
    assertTrue("成功后必须解 latch 并放行一次 WebView",
      fn.contains("clearClientPluginTreeFailureLatch()") && fn.contains("activity.showWeb()"))
  }

  /**
   * 设备实测 #2（DEVICE-FINDING-2）回归：**数据修好不等于屏幕修好**。
   *
   * 真机事实：拔除确实执行了（undo-gate 出现 pulled plugin、patch 与基线逐字节相同），
   * 但屏幕 3 分钟仍停在旧的 "Failed to load plugins" 页，手动冷启动才恢复。
   *
   * 真因：成功分支只调 showWeb()，而 MainActivity.showWeb() 只在 enginePageFailed == true 时才
   * reload——本场景失败的是**插件装配**而非导航传输，enginePageFailed == false，于是 showWeb()
   * 只执行 guideRenderer.showWeb()：把**已经持有旧失败文档**的 WebView 重新露出来，从不重新导航。
   * 而客户端插件清单是文档加载时拉的，引擎重启不会让旧文档重拉，用户看到的仍是坏的。
   *
   * 判据：成功分支必须**同时**出现 reloadEnginePage()（真正 webView.reload()）与 showWeb()，
   * 且顺序为 reload 在前。只 showWeb 即判红——把这条缺陷钉死，防止将来「顺手简化」又删掉它。
   */
  @Test
  fun recoverySuccessBothReloadsAndRevealsTheWebView() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("private fun maybeRecoverFromClientPluginTreeFailure(")
    val success = fn.substringAfter("if (result.executed) {").substringBefore("} else {")
    assertTrue("成功分支切片不得为空（切片判据失效会静默变假绿）", success.trim().length > 50)
    assertTrue("成功分支必须重新导航（否则旧失败文档原样留在 WebView 里）", success.contains("reloadEnginePage()"))
    assertTrue("成功分支必须把引导页换回 WebView", success.contains("showWeb()"))
    assertTrue("必须先 reload 再展示（数据修好 + 屏幕修好，缺一即判红）",
      success.indexOf("reloadEnginePage()") < success.indexOf("showWeb()"))
  }

  /**
   * 设备实测 #3（DEVICE-FINDING-3）回归：**拔掉插件不等于引擎不再服务它**。
   *
   * 真机事实：拔除成功、patch 磁盘上已干净（坏条目 0），但引擎进程 ETIME 早于拔除时刻 ——
   * **从未重启**，屏幕 240s 恒定停在「插件装配失败」，不手动冷启动就不恢复。
   *
   * 真因：成功分支调 `engine.startEngine()`（不带 force），而 EngineManager.startEngine 里
   * `if (!force && engineUsable && !degradedHttp) return true` 直接早退——客户端插件装配失败时
   * 引擎 **HTTP 是健康的**，坏的只是它装配出来的插件树。于是引擎继续用**启动时读入的旧 profile**
   * 组合并服务 window.__DSH_BOOT__，那份清单里仍含刚被拔掉的坏插件；即使 WebView 真的 reload
   * （fix#2 已保证），重新取回的**还是同一份坏 manifest**。
   *
   * 判据：成功分支必须是 `startEngine(force = true)`；写成无 force 的 `startEngine()` 即判红。
   * 安全边界不在本调用点，而在 startEngine 既有护栏（PORT_FOREIGN 仍拒、OUR_HTTP 但无本壳子进程
   * 句柄仍拒、killExistingEngine 只停本壳持有的句柄）——本函数不得自行实现这些判据。
   */
  @Test
  fun recoverySuccessForceRestartsTheEngine() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("private fun maybeRecoverFromClientPluginTreeFailure(")
    val success = fn.substringAfter("if (result.executed) {").substringBefore("} else {")
    assertTrue("成功分支切片不得为空（切片判据失效会静默变假绿）", success.trim().length > 50)
    assertTrue(
      "成功分支必须 startEngine(force = true)：不 force 则引擎判定「已有可用引擎」直接早退，" +
        "继续服务启动时读入的旧 profile（仍含刚拔掉的坏插件），reload 拿回的仍是同一份坏 manifest",
      success.contains("startEngine(force = true)"),
    )
    // 反证：无 force 的 `startEngine()` 正是 DEVICE-FINDING-3 的缺陷形态——等于没修。
    assertFalse(
      "不得写成无 force 的 startEngine()（DEVICE-FINDING-3：拔除后引擎从未重启）",
      Regex("startEngine\\(\\)").containsMatchIn(success),
    )
  }

  /**
   * 设备实测 #4（DEVICE-FINDING-4）回归：**reload 不得与引擎启动赛跑**。
   *
   * 真机事实：整条链已打通（拔除成功、patch 回基线、引擎 PID 15592→15673 真的换了），但屏幕显示
   * 的是「页面加载失败」——enginePageFailed 那一支。
   *
   * 真因是**时序**而不是缺调用：startEngine(force = true) 只保证**进程已 spawn**，不保证 HTTP 已
   * listen（冷启动实测 5-45s）。紧接着发起的 reload 撞上未监听窗口 ⇒ ERR_CONNECTION_REFUSED ⇒
   * onReceivedError 置 enginePageFailed ⇒ 回落 Error 相位。fix#2 加的 reload 方向对，但发起太早。
   *
   * 判据：成功分支必须**先有就绪等待、再有 reload**——顺序反了即判红。有界性由既有
   * ENGINE_BOOT_BUDGET_MS 保证，不得用固定 sleep 糊（冷启动耗时为宽分布）。
   */
  @Test
  fun recoverySuccessWaitsForEngineReadinessBeforeReloading() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val fn = code.substringAfter("private fun maybeRecoverFromClientPluginTreeFailure(")
    val success = fn.substringAfter("if (result.executed) {").substringBefore("} else {")
    assertTrue("成功分支切片不得为空（切片判据失效会静默变假绿）", success.trim().length > 50)
    assertTrue("成功分支必须有有界就绪等待（否则 reload 撞未监听窗口 ⇒ 页面加载失败）",
      success.contains("awaitEngineHttpReady("))
    val waitAt = success.indexOf("awaitEngineHttpReady(")
    val reloadAt = success.indexOf("reloadEnginePage()")
    assertTrue("就绪等待必须排在 reloadEnginePage() 之前（顺序反了就是 DEVICE-FINDING-4）",
      waitAt in 0 until reloadAt)
    assertTrue("就绪等待必须复用既有预算常量（不得写死秒数）", success.contains("ENGINE_BOOT_BUDGET_MS"))
  }

  /**
   * [awaitEngineHttpReady] 的**有界性**逐条反证（纯函数：注入时钟/睡眠/探针，无真实 IO）。
   *
   * 为什么必须有：这条等待最危险的形态是「变成无限等」——它跑在回滚的后台线程上，一旦不受预算
   * 约束就会把恢复流程永久挂住。因此对「超预算必返回、进程死必提前收手、换代必提前收手、
   * 就绪即返回」四种收敛路径各断言一条。
   */
  @Test
  fun engineReadinessWaitIsBoundedAndConverges() {
    // ① 迟迟不就绪：到预算即停（不是无限循环），且确实轮询过。
    var clock = 0L
    var probes = 0
    val notReady = awaitEngineHttpReady(
      budgetMs = 5_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { true }, current = { true },
    )
    assertFalse("超预算必须返回 false（有界，不得无限等）", notReady)
    assertTrue("必须真的轮询过（不是一次都没试就放弃）", probes >= 5)

    // ② 第 3 拍就绪：立即返回 true，不再空等。
    clock = 0L; probes = 0
    val ready = awaitEngineHttpReady(
      budgetMs = 30_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; probes >= 3 }, processAlive = { true }, current = { true },
    )
    assertTrue("引擎就绪必须返回 true", ready)
    assertEquals("就绪即停（不得走满预算）", 3, probes)

    // ③ 进程已死：再等也不会就绪，提前收手（不空耗满预算）。
    clock = 0L; probes = 0
    val dead = awaitEngineHttpReady(
      budgetMs = 90_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { false }, current = { true },
    )
    assertFalse("进程已死必须提前收手", dead)
    assertTrue("必须远早于 90s 预算就收手（实测 clock=" + clock + "）", clock < 10_000L)

    // ④ 世代已换代（Activity 销毁/新启动）：立刻收手，避免对着废弃世代做动作。
    clock = 0L; probes = 0
    val stale = awaitEngineHttpReady(
      budgetMs = 90_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      probe = { probes++; false }, processAlive = { true }, current = { false },
    )
    assertFalse("换代必须立刻收手", stale)
    assertEquals("换代后不得再探活", 0, probes)
  }

  // ── §4 防弹回闸门（latch 期内 showWeb / 监控 / 冻结看门狗早退）────────────────
  @Test
  fun showWebIsBlockedWhileLatchIsSet() {
    val code = codeOnly(src("MainActivity.kt"))
    val fn = code.substringAfter("internal fun showWeb()").substringBefore("internal fun reloadEnginePage()")
    assertTrue("showWeb 必须查 latch", fn.contains("engineFlow.clientPluginTreeFailedLatch"))
    assertTrue("必须早退而非继续展示", Regex("clientPluginTreeFailedLatch\\) return").containsMatchIn(fn))
    // 反证（CONTRACT §0）：这条闸门必须先于 enginePageFailed/claimLoadErrorRetry 那一支生效，
    // 否则 latch 期内仍会走「加载失败 → 自动重载」——正是被点名的重载环。
    val latchAt = fn.indexOf("clientPluginTreeFailedLatch")
    val retryAt = fn.indexOf("claimLoadErrorRetry()")
    assertTrue("latch 闸门必须排在 enginePageFailed 重载支之前", latchAt in 0 until retryAt)
  }

  @Test
  fun monitorAndFreezeWatchdogsExitEarlyWhileLatchIsSet() {
    val code = codeOnly(src("EngineStartFlow.kt"))
    val monitor = code.substringAfter("private val engineMonitorRunnable").substringBefore("private val freezeHandler")
    assertTrue("前台监控必须查 latch", monitor.contains("if (clientPluginTreeFailed) return"))
    val freeze = code.substringAfter("private val freezeRunnable").substringBefore("fun startMonitor()")
    assertTrue("冻结看门狗必须查 latch", freeze.contains("if (clientPluginTreeFailed) return"))
    // 反证：latch 闸门不得写成 enginePageFailed（CONTRACT §0 点名的重载环形态）。
    assertFalse("latch 闸门不得写成 enginePageFailed",
      Regex("if \\(activity\\.enginePageFailed\\) return").containsMatchIn(monitor + freeze))
  }

  @Test
  fun explicitOutletsClearTheLatch() {
    val flow = codeOnly(src("EngineStartFlow.kt"))
    val start = flow.substringAfter("fun start() {").substringBefore("val token = flowOwnership.begin()")
    assertTrue("start() 入口必须清 latch（用户显式重试/安全模式路径）", start.contains("clearClientPluginTreeFailureLatch()"))
    val activity = codeOnly(src("MainActivity.kt"))
    val outlet = activity.substringAfter("internal fun startEngineFlow()").substringBefore("internal fun applyGuidePhase(")
    assertTrue("显式启动出口必须清 latch", outlet.contains("clearClientPluginTreeFailureLatch()"))
  }

  // ── §4 onResume 消费挂起呈现 ─────────────────────────────────────────────────
  @Test
  fun onResumeConsumesPendingClientPluginFailurePresentation() {
    val code = codeOnly(src("MainActivity.kt"))
    assertTrue("必须声明挂起标记", code.contains("pendingClientPluginFailurePresentation"))
    val resume = code.substringAfter("override fun onResume()").substringBefore("override fun onPause()")
    assertTrue("onResume 必须消费它", resume.contains("if (pendingClientPluginFailurePresentation)"))
    assertTrue("消费时必须落地错误相位", resume.contains("GuidePhase.Error"))
    assertTrue("必须复用同一文案串", resume.contains("R.string.ds_client_plugin_fail_hint"))
  }

  // ── §4/§6 纯判据与文案 ──────────────────────────────────────────────────────
  @Test
  fun recoveryRouteIsExhaustiveAndConservative() {
    assertEquals(ClientPluginFailureRoute.CLIENT_PULL,
      clientPluginFailureRoute(PluginMounts.FailedEntry("live2d-pet", "dsh-live2d-pets"), false))
    assertEquals(ClientPluginFailureRoute.KNOWN_GOOD,
      clientPluginFailureRoute(null, true))
    assertEquals("点不出名且清单已变 ⇒ 不动作（绝不抹掉用户插件）",
      ClientPluginFailureRoute.NO_ACTION, clientPluginFailureRoute(null, false))
  }

  @Test
  fun failedIdsParseFeedsTheRouteDecision() {
    // 端到端纯面：契约行 → id 列表 → 路线判定。三跳全部可离线反证。
    val ids = LogCollector.clientFailedIdsOf(
      "[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail failedIds=- pageSideRuntime={}")
    assertEquals(emptyList<String>(), ids)
    assertEquals(ClientPluginFailureRoute.KNOWN_GOOD, clientPluginFailureRoute(null, true))
    assertEquals(ClientPluginFailureRoute.NO_ACTION, clientPluginFailureRoute(null, false))
  }

  @Test
  fun userFacingCopyMatchesTheContractAndHasNoEmoji() {
    val xml = java.io.File("src/main/res/values/strings.xml").readText()
    assertTrue("必须新增标题串", xml.contains("<string name=\"ds_client_plugin_fail_title\">插件装配失败</string>"))
    val hint = "<string name=\"ds_client_plugin_fail_hint\">界面插件没能装载（%1\$s）。已尝试自动回退；仍失败可点下方「安全模式启动」：只摘第三方插件、保留本应用插件，并把含报错原文的修复指令复制到剪贴板。</string>"
    assertTrue("提示串必须与 CONTRACT §6 逐字一致", xml.contains(hint))
    // 禁 emoji（AGENTS.md 铁律 7）：代理对与常见符号区段一律不得出现在资源里。
    val emoji = Regex("[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\uFE0F]")
    assertFalse("文案不得含 emoji", emoji.containsMatchIn(xml))
  }
}
