package com.snoworwind.pocketharness

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 决策耐久队列回归（§6.3.1 / NT-14、NT-17）：requestId 幂等、指数退避 <=60s、
 * append-only 状态折叠（后写覆盖前写）。
 *
 * 坑 512（R3-01）：决策行必须带 HMAC 完整性——伪造行、被篡改行与旧版无签行在 parse 一律丢弃。
 * JVM 单测注入固定密钥替身（Android Keystore 在 JVM 不可用，见 [ProductionIntegrity] 的回退语义）。
 */
class NotifyDecisionQueueTest {

  /** 固定密钥 HMAC 替身：与生产同语义（签/验、常时比较），密钥来源换成测试常量。 */
  private class FakeIntegrity : NotifyDecisionQueue.DecisionIntegrity {
    private val key = SecretKeySpec("notify-decision-test-key".toByteArray(Charsets.UTF_8), "HmacSHA256")
    private fun mac(data: ByteArray): ByteArray =
      Mac.getInstance("HmacSHA256").apply { init(key) }.doFinal(data)
    override fun sign(canonical: String): String =
      java.util.Base64.getEncoder().encodeToString(mac(canonical.toByteArray(Charsets.UTF_8)))
    override fun verify(canonical: String, mac: String): Boolean = runCatching {
      java.security.MessageDigest.isEqual(
        java.util.Base64.getDecoder().decode(mac),
        mac(canonical.toByteArray(Charsets.UTF_8)),
      )
    }.getOrDefault(false)
  }

  @Before
  fun injectTestIntegrity() {
    NotifyDecisionQueue.integrity = FakeIntegrity()
  }

  @After
  fun restoreIntegrity() {
    NotifyDecisionQueue.integrity = NotifyDecisionQueue.ProductionIntegrity
  }

  @Test
  fun requestId_同决策恒同ID_不同决策不同ID() {
    val a = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    val b = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    val c = NotifyDecisionQueue.requestIdFor("e1", "approval", "{\"kind\":\"result\",\"value\":\"rejected\"}")
    val d = NotifyDecisionQueue.requestIdFor("e2", "approval", "{\"kind\":\"result\",\"value\":\"allowed-once\"}")
    assertEquals(a, b)
    assertEquals(16, a.length)
    assertFalse(a == c)
    assertFalse(a == d)
  }

  @Test
  fun 指数退避封顶60s且单调() {
    assertEquals(2_000L, NotifyDecisionQueue.retryDelayMs(0))
    assertEquals(4_000L, NotifyDecisionQueue.retryDelayMs(1))
    assertEquals(8_000L, NotifyDecisionQueue.retryDelayMs(2))
    var prev = 0L
    for (attempt in 0..12) {
      val d = NotifyDecisionQueue.retryDelayMs(attempt)
      assertTrue("delay 必须单调不减: " + attempt, d >= prev)
      assertTrue("delay 必须 <= 60s: " + d, d <= NotifyDecisionQueue.MAX_BACKOFF_MS)
      prev = d
    }
    assertEquals(60_000L, NotifyDecisionQueue.retryDelayMs(9))
  }

  @Test
  fun 序列化解析往返() {
    val d = NotifyDecisionQueue.Decision("0123456789abcdef", "e1", "question", "{\"kind\":\"result\"}", 123L, "pending", 2)
    val back = NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d))
    assertNotNull(back)
    assertEquals(d, back)
    assertNull(NotifyDecisionQueue.parse("garbage"))
    assertNull(NotifyDecisionQueue.parse("{\"eventId\":\"e1\"}"))
    assertTrue("序列化行必须带 mac 字段", NotifyDecisionQueue.serialize(d).contains("\"mac\":"))
  }

  // ── 坑 512（R3-01）：决策行完整性——伪造/篡改/无签一律 fail-closed ─────────

  @Test
  fun 无签行_旧版本格式_必须丢弃() {
    val line = "{\"requestId\":\"0123456789abcdef\",\"eventId\":\"e1\",\"kind\":\"approval\"," +
      "\"outcome\":\"{\\\"kind\\\":\\\"result\\\",\\\"value\\\":\\\"allowed-once\\\"}\"," +
      "\"ts\":1,\"state\":\"pending\",\"attempts\":0,\"waitAttempts\":0}"
    assertNull("旧版无 mac 的行不得再成为可投递决策", NotifyDecisionQueue.parse(line))
  }

  @Test
  fun 空mac行必须丢弃() {
    val d = NotifyDecisionQueue.Decision("0123456789abcdef", "e1", "approval", "{}", 1L)
    val line = NotifyDecisionQueue.serialize(d).replace(Regex("\"mac\":\"[^\"]*\""), "\"mac\":\"\"")
    assertNull(NotifyDecisionQueue.parse(line))
  }

  @Test
  fun 篡改任意字段必须验签失败丢弃() {
    val signed = NotifyDecisionQueue.serialize(
      NotifyDecisionQueue.Decision("0123456789abcdef", "e1", "approval", "{\"kind\":\"result\",\"value\":\"rejected\"}", 1L),
    )
    // 攻击者的目标：把 rejected 换成 allowed-once（同 requestId 形状、同字段结构）
    val forged = signed.replace("rejected", "allowed-once")
    assertNull("被篡改的 outcome 不得通过验签", NotifyDecisionQueue.parse(forged))
    val tamperedState = signed.replace("\"state\":\"pending\"", "\"state\":\"settled\"")
    assertNull("被篡改的 state 不得通过验签", NotifyDecisionQueue.parse(tamperedState))
    val tamperedEvent = signed.replace("\"eventId\":\"e1\"", "\"eventId\":\"e2\"")
    assertNull("被篡改的 eventId 不得通过验签", NotifyDecisionQueue.parse(tamperedEvent))
  }

  @Test
  fun 错误密钥签出的行必须丢弃() {
    val d = NotifyDecisionQueue.Decision("0123456789abcdef", "e1", "approval", "{}", 1L)
    val foreign = FakeIntegrityWithDifferentKey().sign(NotifyDecisionQueue.canonical(d))
    val line = NotifyDecisionQueue.serialize(d).replace(Regex("\"mac\":\"[^\"]*\""), "\"mac\":\"$foreign\"")
    assertNull("非本进程密钥签出的行不得通过验签", NotifyDecisionQueue.parse(line))
  }

  @Test
  fun requestId形状不对的行不必验签即丢() {
    val d = NotifyDecisionQueue.Decision("not-hex-shape!!", "e1", "approval", "{}", 1L)
    assertNull(NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d)))
  }

  /**
   * 生产实现直测（JVM 上 AndroidKeyStore 不可得 → 走临时密钥回退，坑 512 自审补口：
   * sign 不得因 Keystore 缺席抛异常——那会让 Keystore 故障设备上的全部通知决策无法落盘）。
   */
  @Test
  fun 生产实现_Keystore缺席时走临时密钥_签名验签往返() {
    val d = NotifyDecisionQueue.Decision("0123456789abcdef", "e1", "approval", "{}", 1L)
    NotifyDecisionQueue.integrity = NotifyDecisionQueue.ProductionIntegrity // 先切生产实现（JVM=临时密钥回退）
    val line = NotifyDecisionQueue.serialize(d)
    val parsed = NotifyDecisionQueue.parse(line)
    assertNotNull("Keystore 缺席（JVM）时 serialize 必须成功且可验签", parsed)
    assertEquals(d, parsed)
    val tampered = line.replace("approval", "question")
    assertNull("篡改行必须丢弃", NotifyDecisionQueue.parse(tampered))
  }

  /**
   * 坑 545 反证：密钥「在场但不可用」也必须回退——Mac.init 失败（这里用 null 编码的 Key
   * 构造，任何 Mac 实现都必然拒绝；SunJCE 对「算法名不匹配」反而会照常 init，测不到这条
   * 路径），sign 只在 null 时回退的话这类设备上每个决策都会静默丢失。
   */
  @Test
  fun 生产实现_主密钥在场但不可用时回退临时密钥() {
    val bogus = object : java.security.Key {
      override fun getAlgorithm(): String = "HmacSHA256"
      override fun getFormat(): String = "RAW"
      override fun getEncoded(): ByteArray? = null
    }
    val ephemeral = SecretKeySpec("ephemeral-key".toByteArray(Charsets.UTF_8), "HmacSHA256")
    val bytes = "v2|3:req|2:e1".toByteArray(Charsets.UTF_8)
    val expected = Mac.getInstance("HmacSHA256").apply { init(ephemeral) }.doFinal(bytes)
    val viaBogus = NotifyDecisionQueue.ProductionIntegrity.signWithFallback(bogus, ephemeral, bytes)
    assertArrayEquals("主密钥失效必须落到临时密钥且结果即临时密钥的 MAC", expected, viaBogus)
    val viaNull = NotifyDecisionQueue.ProductionIntegrity.signWithFallback(null, ephemeral, bytes)
    assertArrayEquals("Keystore 整体缺席（null）同样走临时密钥", expected, viaNull)
  }

  /** 坑 544 反证：字段值含 `|` 时 canonical 必须不可重切（长度前缀让切分唯一）。 */
  @Test
  fun canonical_字段含竖线时不同决策不得同串() {
    val d1 = NotifyDecisionQueue.Decision("0123456789abcdef", "a|b", "c", "{}", 1L)
    val d2 = NotifyDecisionQueue.Decision("0123456789abcdef", "a", "b|c", "{}", 1L)
    // v1 裸拼接下两者 canonical 字节相同（合法签名行可被重切成另一条 Decision）；v2 必须不同
    assertNotEquals(NotifyDecisionQueue.canonical(d1), NotifyDecisionQueue.canonical(d2))
    // 含竖线字段的往返仍精确
    val back = NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d1))
    assertEquals(d1, back)
  }

  private class FakeIntegrityWithDifferentKey : NotifyDecisionQueue.DecisionIntegrity {
    private val key = SecretKeySpec("attacker-held-key".toByteArray(Charsets.UTF_8), "HmacSHA256")
    private fun mac(data: ByteArray): ByteArray =
      Mac.getInstance("HmacSHA256").apply { init(key) }.doFinal(data)
    override fun sign(canonical: String): String =
      java.util.Base64.getEncoder().encodeToString(mac(canonical.toByteArray(Charsets.UTF_8)))
    override fun verify(canonical: String, mac: String): Boolean = false
  }

  @Test
  fun fold_同requestId后写覆盖前写() {
    val lines = listOf(
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("1111111111111111", "e1", "question", "{}", 1L, "pending", 0)),
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("2222222222222222", "e2", "approval", "{}", 2L, "pending", 0)),
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("1111111111111111", "e1", "question", "{}", 1L, "submitted", 1)),
    )
    val folded = NotifyDecisionQueue.fold(lines)
    assertEquals(2, folded.size)
    val r1 = folded.first { it.requestId == "1111111111111111" }
    assertEquals("submitted", r1.state)
    assertEquals(1, r1.attempts)
  }

  @Test
  fun lru_同requestId只接受一次且容量有界() {
    val lru = NotifyDecisionQueue.Lru(2)
    assertTrue(lru.accept("a"))
    assertFalse(lru.accept("a"))
    assertTrue(lru.accept("b"))
    assertTrue(lru.accept("c"))
    // 容量 2：最旧的 a 已被挤出，可再次接受（LRU 是防连点，不承担永久去重）
    assertTrue(lru.accept("a"))
    assertTrue(lru.contains("a"))
  }


  // ── NOT_READY 墙钟预算（2026-09-13 设备实测后的修复口径）────────────────

  @Test
  fun 预算必须显著大于实测引擎冷启动上限_且不照60s卡死() {
    assertTrue(
      "预算必须大于实测冷启动上限",
      NotifyDecisionQueue.NOT_READY_BUDGET_MS > NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS,
    )
    assertTrue("实测上限本身就要 >60s", NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS > 60_000L)
    assertTrue("预算必须 >60s", NotifyDecisionQueue.NOT_READY_BUDGET_MS > 60_000L)
    assertEquals(300_000L, NotifyDecisionQueue.NOT_READY_BUDGET_MS)
  }

  @Test
  fun NOT_READY_预算内等待_到期才失败() {
    val ts = 1_800_000_000_000L
    assertEquals(NotifyDecisionQueue.WaitAction.RETRY, NotifyDecisionQueue.notReadyAction(ts, ts))
    assertEquals(
      "冷启动实测上限处仍必须等待（不因引擎慢启动误判失败）",
      NotifyDecisionQueue.WaitAction.RETRY,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS),
    )
    assertEquals(
      NotifyDecisionQueue.WaitAction.RETRY,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS - 1),
    )
    assertEquals(
      "到期即判失败（落到可见的「提交失败，点击重试」）",
      NotifyDecisionQueue.WaitAction.FAIL,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS),
    )
    assertEquals(
      NotifyDecisionQueue.WaitAction.FAIL,
      NotifyDecisionQueue.notReadyAction(ts, ts + NotifyDecisionQueue.NOT_READY_BUDGET_MS + 60_000L),
    )
  }

  @Test
  fun NOT_READY_独立计数参与退避且封顶60s() {
    var prev = 0L
    for (w in 0..10) {
      val d = NotifyDecisionQueue.retryDelayMs(w)
      assertTrue("NOT_READY 退避必须单调不减：w=" + w, d >= prev)
      assertTrue("NOT_READY 退避必须 <=60s：w=" + w, d <= NotifyDecisionQueue.MAX_BACKOFF_MS)
      prev = d
    }
    assertEquals(60_000L, NotifyDecisionQueue.retryDelayMs(10))
  }

  @Test
  fun 预算窗口内退避至少能排若干次() {
    var total = 0L
    var w = 0
    while (total < NotifyDecisionQueue.NOT_READY_BUDGET_MS && w < 100) {
      total += NotifyDecisionQueue.retryDelayMs(w)
      w++
    }
    assertTrue("退避阶梯必须在预算内至少能排若干次", w >= 5)
    assertTrue("累加必须能走到预算（不然预算就没意义）", total >= NotifyDecisionQueue.NOT_READY_BUDGET_MS)
  }

  @Test
  fun waitAttempts_序列化往返与默认值() {
    val d = NotifyDecisionQueue.Decision("ffffffffffffffff", "e2", "question", "{}", 42L, "pending", 1, 3)
    val back = NotifyDecisionQueue.parse(NotifyDecisionQueue.serialize(d))
    assertNotNull(back)
    assertEquals(3, back!!.waitAttempts)
    assertEquals(1, back.attempts)
    assertEquals(d, back)
    // 构造缺省 waitAttempts=0 的往返（optInt 默认链路）。真·旧格式无签行走「无签行丢弃」用例；
    // v1 有签行在坑 544 的 v2 canonical 下同样按验签失败丢弃（fail-closed 升级语义）。
    val legacy = NotifyDecisionQueue.parse(
      NotifyDecisionQueue.serialize(NotifyDecisionQueue.Decision("0123456789abcdef", "e", "question", "{}", 1L, "pending", 2)),
    )
    assertEquals(0, legacy!!.waitAttempts)
    assertEquals(2, legacy.attempts)
  }

  // ── 触发点自愈（真缺陷：进程死亡带走重试定时器 → 预算永不被评估）──────────

  @Test
  fun 重启后触发点按预算重评_滞留pending不会被永久搁置() {
    val now = 1_800_000_000_000L
    fun d(id: String, ts: Long, st: String) =
      NotifyDecisionQueue.Decision(id, "e-" + id, "approval", "{}", ts, st, 0, 8)
    val budget = NotifyDecisionQueue.NOT_READY_BUDGET_MS
    val cold = NotifyDecisionQueue.ENGINE_COLD_START_OBSERVED_MS
    val plan = NotifyDecisionQueue.resumePlan(
      listOf(
        d("expired", now - budget - 1_000L, "pending"),
        d("failed-kept", now - budget - 1_000L, "failed"),
        d("slow-boot", now - cold, "pending"),
        d("fresh", now - 1_000L, "pending"),
        d("submitted", now - budget - 1_000L, "submitted"),
        d("settled", now, "settled"),
        d("expired-state", now, "expired"),
      ),
      now,
    )
    assertTrue("已超预算的滞留决策必须重评为到期", plan.expired.contains("expired"))
    assertTrue("FAILED 也要重评（否则重启后永远不再尝试）", plan.expired.contains("failed-kept"))
    assertTrue("冷启动实测上限内不算到期（不许慢启动误判）", plan.waiting.contains("slow-boot"))
    assertTrue(plan.waiting.contains("fresh"))
    assertFalse(plan.expired.contains("submitted"))
    assertFalse(plan.waiting.contains("submitted"))
    assertFalse(plan.expired.contains("settled"))
    assertFalse(plan.expired.contains("expired-state"))
    assertEquals(2, plan.expired.size)
    assertEquals(2, plan.waiting.size)
  }

  @Test
  fun 空队列的重评计划为空() {
    val plan = NotifyDecisionQueue.resumePlan(emptyList(), 1L)
    assertTrue(plan.expired.isEmpty())
    assertTrue(plan.waiting.isEmpty())
  }

  @Test
  fun 状态枚举闭集() {
    assertEquals("pending", NotifyDecisionQueue.State.PENDING.wire)
    assertEquals("submitted", NotifyDecisionQueue.State.SUBMITTED.wire)
    assertEquals("settled", NotifyDecisionQueue.State.SETTLED.wire)
    assertEquals("failed", NotifyDecisionQueue.State.FAILED.wire)
    assertEquals("expired", NotifyDecisionQueue.State.EXPIRED.wire)
    assertEquals(NotifyDecisionQueue.State.PENDING, NotifyDecisionQueue.State.of("unknown-state"))
    assertEquals(NotifyDecisionQueue.State.SETTLED, NotifyDecisionQueue.State.of("settled"))
  }
}
