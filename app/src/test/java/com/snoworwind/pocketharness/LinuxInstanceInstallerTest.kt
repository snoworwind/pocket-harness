package com.snoworwind.pocketharness

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Termux 式“只铺底、不替换”的判据：基础镜像永不替换，用户 apt 装的软件不能因覆盖更新丢失；
 * node/engine 是应用管理的运行时，可以随 APK 更新。
 */
class LinuxInstanceInstallerTest {
  @Test
  fun rootfsIsNeverReplacedByAnAppUpdate() {
    val plan = LinuxInstanceInstaller.planUpdate("a", "b", "c", "d")
    assertTrue(plan.replaceNode)
    assertTrue(plan.replaceEngine)
    assertFalse("基础镜像不得随 APK 覆盖更新替换", plan.replaceRootfs)
  }

  @Test
  fun identicalRuntimeDigestsNeedNoWork() {
    val plan = LinuxInstanceInstaller.planUpdate("same", "same", "same", "same")
    assertFalse(plan.replaceNode)
    assertFalse(plan.replaceEngine)
    assertFalse(plan.replaceRootfs)
  }
}
