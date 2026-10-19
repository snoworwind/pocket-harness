package com.snoworwind.pocketharness

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A08（2026-10-18 审计）：live 流的消费偏移必须是**字节**边界。
 *
 * 旧实现把 `String.lastIndexOf('\n')` 的字符下标直接加到 `RandomAccessFile` 的字节偏移上；
 * 含中文的行字符数小于字节数，偏移推进不足 → 下一次 drain 重读旧尾段，同一 tool_result /
 * turn_end 被重复消费（审计用 200 个「中」复现同一 tool_result 六次）。
 */
class OverlayLiveOffsetTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/snoworwind/pocketharness", name),
      File("app/src/main/java/com/snoworwind/pocketharness", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（注释里出现旧形态不算命中）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun chineseLineAdvancesByEveryConsumedByte() {
    val line = """{"k":"tool_call","name":"bash","args":"${"中".repeat(200)}"}""" + "\n"
    val bytes = line.toByteArray(Charsets.UTF_8)
    val consumed = liveConsumableBytes(bytes)
    assertEquals("整行必须一次消费完", bytes.size, consumed)
    // 反证：旧算法（字符下标）在同一行上会少推进，少推进量恰为多字节字符多出来的字节数。
    val oldStyle = line.lastIndexOf('\n') + 1
    assertEquals("旧算法的「消费量」是字符数（含换行）", line.length, oldStyle)
    assertTrue("前提：该行含多字节字符，旧算法必须少推进", oldStyle < consumed)
    assertTrue("少推进量 = UTF-8 字节数 - 字符数 > 0", bytes.size - line.length > 0)
  }

  @Test
  fun partialLineDoesNotAdvance() {
    val bytes = """{"k":"tool_result","s":"会话""".toByteArray(Charsets.UTF_8)
    assertEquals("半行（无换行）必须返回 0，偏移不动", 0, liveConsumableBytes(bytes))
  }

  @Test
  fun multipleLinesConsumeOnlyThroughLastNewline() {
    val complete = """{"k":"tool_call","args":"中文"}""" + "\n" + """{"k":"tool_result"}""" + "\n"
    val bytes = (complete + """{"k":"turn_end"}""").toByteArray(Charsets.UTF_8)
    val consumed = liveConsumableBytes(bytes)
    assertEquals("只消费到最后一个换行（含）", complete.toByteArray(Charsets.UTF_8).size, consumed)
    assertEquals(0, liveConsumableBytes(bytes, 0))
  }

  @Test
  fun drainUsesByteBoundaryAndOldCharIndexIsGone() {
    val code = codeOnly(source("OverlayLiveFeed.kt"))
    assertTrue("必须按字节边界消费", code.contains("liveConsumableBytes(buf)"))
    assertTrue("偏移按已消费字节推进", code.contains("readOffset += consumableBytes"))
    assertFalse("不得再用 String 的字符下标推进字节偏移", code.contains("text.lastIndexOf('\\n')"))
    assertFalse("不得把字符下标直接加到 readOffset", code.contains("readOffset += lastNewline"))
  }
}
