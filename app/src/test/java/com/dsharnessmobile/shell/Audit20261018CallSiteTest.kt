package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A01 / A03 / A04 / A05（2026-10-18 分区复审）的调用点契约回归。
 *
 * 这四项的缺陷形态都落在「某个调用点漏了/调错了」，而它们依赖 Android 网络、广播身份与
 * VirtualDisplay 运行态，纯 JVM 无法构造生产对象。与 [CallSiteContractTest] 同思路：
 * 直接对壳侧源码断言真源表达式与调用形态，撤掉修复即变红。
 */
class Audit20261018CallSiteTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（注释里出现旧形态不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取一个成员体的文本：从签名起，到下一个同级成员声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  // ── A01：原生 3080 连接必须携带 relay 准入凭据 ─────────────────────────────

  @Test
  fun controlPollerAttachesRelayAdmission() {
    val post = memberBody(codeOnly(source("ControlPoller.kt")), "private fun post(")
    assertTrue(
      "A01：控制轮询 POST 必须经受 origin 约束的共享入口附 relay 凭据",
      post.contains("EngineAuth.attach(context, connection)"),
    )
  }

  @Test
  fun fileIncomingDeliveryAttachesRelayAdmission() {
    val deliver = memberBody(codeOnly(source("FileIncoming.kt")), "private fun deliverOnce(")
    assertTrue(
      "A01：来件投递是原生连接，必须自带 relay 凭据（JSON 里的控制令牌发生在转发之后）",
      deliver.contains("EngineAuth.attach(context, conn)"),
    )
    assertTrue("控制令牌仍必须保留（两层鉴权互不替代）", deliver.contains("X-DSH-Control-Token"))
  }

  @Test
  fun engineAuthConfinesRelayHeaderThroughOneEntry() {
    val confine = memberBody(codeOnly(source("EngineAuth.kt")), "private fun confineConnection(")
    assertTrue("relay 头必须由共享入口统一附加", confine.contains("EngineTransport.attachAdmission(conn)"))
    val transport = codeOnly(source("EngineTransport.kt"))
    assertTrue("共享入口必须存在", transport.contains("internal fun attachAdmission(connection: java.net.HttpURLConnection)"))
    assertTrue("共享入口写入 X-DSH-Relay", transport.contains("setRequestProperty(\"X-DSH-Relay\", admissionToken)"))
  }

  // ── A03：sender UID 属于 BroadcastReceiver，不属于 Intent ─────────────────

  @Test
  fun receiverReadsSentFromUidOnTheReceiverInstance() {
    val receiver = codeOnly(source("AdbKeyboardReceiver.kt"))
    assertTrue("必须在接收器实例上取发送者 UID", receiver.contains("getSentFromUid()"))
    assertTrue(
      "取得身份后必须传入来源校验",
      receiver.contains("isTrustedSender(context, intent, senderUid())"),
    )
    val service = codeOnly(source("AdbKeyboardService.kt"))
    assertFalse(
      "A03：不得再在 Intent 上反射 getSentFromUid（该类没有此方法，异常被吞后白名单恒不命中）",
      service.contains("Intent::class.java.getMethod(\"getSentFromUid\")"),
    )
    assertTrue(
      "来源校验必须显式接收发送者 UID",
      service.contains("isTrustedSender(context: Context, intent: Intent, senderUid: Int?)"),
    )
    assertTrue("身份不可验证时仍 fail-closed（只认 nonce）", service.contains("senderUid != null"))
  }

  // ── A04 / A05：显式目标优先 + 最后派发点范围复核 ─────────────────────────

  @Test
  fun launchPathsNeverLetSelectedOverrideExplicitTarget() {
    val code = codeOnly(source("VdisplayController.kt"))
    for (signature in listOf(
      "fun launchSettingsProbe(",
      "fun launchApp(",
      "fun sendBackProbe(",
    )) {
      val body = memberBody(code, signature)
      assertTrue("$signature 必须走显式目标解析", body.contains("targetRecord(target)"))
      assertFalse("$signature 不得再用 selected 遮住显式 target", body.contains("selectedRecord() ?: recordOf(target)"))
      assertTrue("$signature 必须在派发前复核当前原生范围", body.contains("scopeDenial("))
    }
    val helper = memberBody(code, "private fun targetRecord(")
    assertTrue("显式 target 不得回退", helper.contains("if (target != null) recordOf(target) else selectedRecord()"))
  }

  // ── A02：插件只能经认证渠道读回原生范围，不得再以可写文件为真源 ─────────────

  @Test
  fun screenScopeIsReadableThroughControlChannelOnly() {
    val status = memberBody(codeOnly(source("VdisplayController.kt")), "fun status(context: Context)")
    assertTrue(
      "vdInfo 应答必须携带当前原生范围（neverA11y 读回渠道）",
      status.contains(".put(\"scope\", ScreenScopePrefs.current(appContext).wire)"),
    )
    val carrier = codeOnly(source("ControlCarrier.kt"))
    assertTrue(
      "控制应答 caps 必须携带当前原生范围",
      carrier.contains(".put(\"screenScope\", ScreenScopePrefs.current(app).wire)"),
    )
    val scope = codeOnly(source("ScreenScope.kt"))
    assertFalse("范围授权不得回落到 prefs 文件", scope.contains("shared_prefs"))
    assertFalse("范围授权不得回落到 prefs 文件", scope.contains("getSharedPreferences"))
  }
}
