package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 侧栏终端前缀重定位（0.15.1）：`PREFIX` / `TERMINFO` / `FPATH` 必须由壳侧按**快照真实目录**注入。
 *
 * 缺陷背景：Termux 前缀被搬到 `<files>/usr`，但 zsh/ncurses 二进制里写死的是
 * `/data/data/com.termux/files/usr/...`。缺 `TERMINFO` 时 zsh 的 ZLE 没有 `cub1`（退格只写空格、
 * 光标不回退）；缺 `fpath` 时 `add-zsh-hook` 无法 autoload（首次提示符三行报错）。
 * 这两个副作用只能在设备层观察，但「注入哪些变量、指向哪里」是纯函数，必须在这里锁死。
 */
class RelocatedTermuxEnvTest {

  private fun tempPrefix(): File =
    Files.createTempDirectory("dsh-relocated-prefix").toFile()

  @Test
  fun injectsPrefixTerminfoAndFunctionPathFromTheSnapshotTree() {
    val prefix = tempPrefix()
    File(prefix, "share/terminfo/x").mkdirs()
    File(prefix, "share/zsh/functions/Misc").mkdirs()
    File(prefix, "share/zsh/functions/Completion/Base").mkdirs()
    File(prefix, "share/zsh/site-functions").mkdirs()

    val env = relocatedTermuxEnv(prefix)

    assertEquals(prefix.absolutePath, env["PREFIX"])
    assertEquals(File(prefix, "share/terminfo").absolutePath, env["TERMINFO"])

    val fpath = env.getValue("FPATH").split(":")
    assertTrue(
      "add-zsh-hook/add-zle-hook-widget 在 Misc 子目录里，必须进 fpath",
      fpath.contains(File(prefix, "share/zsh/functions/Misc").absolutePath),
    )
    assertTrue(
      "深一层目录也要展开（zsh 的 fpath 不递归）",
      fpath.contains(File(prefix, "share/zsh/functions/Completion/Base").absolutePath),
    )
    assertTrue(
      "site-functions 必须一起收",
      fpath.contains(File(prefix, "share/zsh/site-functions").absolutePath),
    )
    assertFalse(
      "functions 父目录本身不能进 fpath（autoload 只看条目目录，不会递归）",
      fpath.contains(File(prefix, "share/zsh/functions").absolutePath),
    )
  }

  @Test
  fun neverFabricatesDirectoriesThatDoNotExist() {
    val prefix = tempPrefix()
    File(prefix, "share").mkdirs()

    val env = relocatedTermuxEnv(prefix)

    assertEquals("PREFIX 只在 prefix 目录存在时给出", prefix.absolutePath, env["PREFIX"])
    assertNull("没有 terminfo 目录时不得注入 TERMINFO（否则会把搜索指到空目录）", env["TERMINFO"])
    assertNull("没有 functions 目录时不得注入 FPATH", env["FPATH"])
  }

  @Test
  fun missingPrefixInjectsNothing() {
    val missing = File(File(System.getProperty("java.io.tmpdir") ?: "/", "dsh-prefix-missing"), "usr")
    assertTrue("不存在的 prefix 不得产生任何变量", relocatedTermuxEnv(missing).isEmpty())
    assertNull(zshFunctionPath(missing))
  }
}
