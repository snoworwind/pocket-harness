package com.snoworwind.pocketharness

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 出厂全局指令基线（`home/.dsh/AGENTS.md`）的归属与迁移判据。
 *
 * 三条边界，各自都对应过真实形态：
 *  - 净安装：工厂版必须落盘（否则用户拿到的还是一个「出厂没有全局纪律」的安装）；
 *  - 升级且用户没动过：不得凭空制造 `~/.agents/AGENTS.md`（否则用户面被我们塞了文件）；
 *  - 升级且用户改过：**先迁到 `~/.agents/AGENTS.md` 再替换**，内容一个字都不能丢。
 *    第 4 例覆盖「用户已经有自己的 `~/.agents/AGENTS.md`」——此时旧工厂件另存，而不是互相覆盖。
 */
class GlobalAgentsBaselineTest {
  private val sentinel = "<!-- dsh-mobile-factory-baseline -->"
  private val factory = "$sentinel\n# 出厂基线\n本文件随安装包发布，升级时整份替换。\n"
  private val previousFactory = "$sentinel\n# 出厂基线（上一版）\n旧版本的运行时说明。\n"
  private val userEdited = "# 我自己写的全局纪律\n不要往 \$PREFIX 写东西。\n"

  private fun put(root: File, name: String, content: String) = File(root, name).apply {
    parentFile!!.mkdirs()
    writeText(content)
  }

  private fun fixture(): Triple<File, File, File> {
    val root = Files.createTempDirectory("global-agents").toFile()
    val live = File(root, "live")
    val stage = SnapshotTransaction.stageRoot(root)
    put(live, "usr/bin/node", "old-node")
    put(stage, "usr/bin/node", "new-node")
    return Triple(root, live, stage)
  }

  private fun swap(root: File, live: File, stage: File) {
    SnapshotTransaction.swap(root, stage, File(live, "usr"), File(live, "home"),
      SnapshotUserData.preservedNames.toSet(), "0123456789abcdef".repeat(4), 1L)
  }

  @Test fun freshInstallSeedsFactoryBaseline() {
    val (root, live, stage) = fixture()
    try {
      put(stage, "home/.dsh/AGENTS.md", factory)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue("净安装不该产生迁移说明: " + notes, notes.none { it.contains("全局指令") })
      assertFalse(File(live, "home/.agents/AGENTS.md").exists())

      swap(root, live, stage)
      assertEquals(factory, File(live, "home/.dsh/AGENTS.md").readText())
      assertFalse(File(live, "home/.agents/AGENTS.md").exists())
    } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun untouchedFactoryBaselineIsNotMigrated() {
    val (root, live, stage) = fixture()
    try {
      put(live, "home/.dsh/AGENTS.md", factory)
      put(stage, "home/.dsh/AGENTS.md", factory)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue("内容相同不该迁移: " + notes, notes.none { it.contains("全局指令") })
      assertEquals(factory, File(live, "home/.dsh/AGENTS.md").readText())
      assertFalse(File(live, "home/.agents/AGENTS.md").exists())
    } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun previousFactoryBaselineIsReplacedWithoutMigration() {
    val (root, live, stage) = fixture()
    try {
      // 上一版工厂件：内容与新版必然不同，但它是我们自己发的，不能被当成用户笔记迁走
      // （否则每次基线更新都会把陈旧说明再灌进 ~/.agents/AGENTS.md）。
      put(live, "home/.dsh/AGENTS.md", previousFactory)
      put(stage, "home/.dsh/AGENTS.md", factory)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue("旧版工厂件不该被迁移: " + notes, notes.none { it.contains("全局指令") })
      assertEquals(previousFactory, File(live, "home/.dsh/AGENTS.md").readText())
      assertFalse(File(live, "home/.agents/AGENTS.md").exists())

      swap(root, live, stage)
      assertEquals(factory, File(live, "home/.dsh/AGENTS.md").readText())
      assertFalse(File(live, "home/.agents/AGENTS.md").exists())
    } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun editedBaselineMovesToUserRootBeforeFactoryReplacesIt() {
    val (root, live, stage) = fixture()
    try {
      put(live, "home/.dsh/AGENTS.md", userEdited)
      put(stage, "home/.dsh/AGENTS.md", factory)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue("应记录迁移: " + notes, notes.any { it.contains("迁移用户改过的全局指令") })
      assertFalse("换树前必须让出工厂文件名", File(live, "home/.dsh/AGENTS.md").exists())
      assertEquals(userEdited, File(live, "home/.agents/AGENTS.md").readText())

      swap(root, live, stage)
      assertEquals("工厂版必须整份替换", factory, File(live, "home/.dsh/AGENTS.md").readText())
      assertEquals("用户内容必须原样保留", userEdited, File(live, "home/.agents/AGENTS.md").readText())
    } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun existingUserAgentsFileWinsAndOldFactoryCopyIsKept() {
    val (root, live, stage) = fixture()
    try {
      put(live, "home/.dsh/AGENTS.md", userEdited)
      put(live, "home/.agents/AGENTS.md", "# 更早的用户约定\n")
      put(stage, "home/.dsh/AGENTS.md", factory)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue("应说明另存: " + notes, notes.any { it.contains("另存为") })
      assertEquals("# 更早的用户约定\n", File(live, "home/.agents/AGENTS.md").readText())
      val superseded = File(live, "home/.dsh").listFiles().orEmpty()
        .filter { it.name.startsWith("AGENTS.md.superseded-") }
      assertEquals("旧内容必须另存一份: " + superseded.map { it.name }, 1, superseded.size)
      assertEquals(userEdited, superseded.single().readText())
    } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun editedBaselineAloneDoesNotCreateEmptyAgentsDirOnNoop() {
    val (root, live, stage) = fixture()
    try {
      // 老快照根本没有工厂基线时，任何迁移逻辑都不得介入。
      put(live, "home/.dsh/AGENTS.md", userEdited)
      val notes = SnapshotUserData.prepareStagedSnapshot(File(stage, "home/.dsh"), File(live, "home/.dsh"))
      assertTrue(notes.none { it.contains("全局指令") })
      assertEquals(userEdited, File(live, "home/.dsh/AGENTS.md").readText())
      assertFalse(File(live, "home/.agents").exists())
    } finally { SnapshotFs.deletePath(root) }
  }
}
