package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Exercises the actual native dispatcher; browser frame isolation is verified separately. */
class MainFrameBridgeTest {
  class Target {
    var calls = 0
    @JavascriptInterface fun set(value: Boolean) { calls++; enabled = value }
    @JavascriptInterface fun get(): Boolean = enabled
    @JavascriptInterface fun show(): String = "zero"
    @JavascriptInterface fun show(value: String?): String? = value
    @JavascriptInterface fun scale(value: Double): Double = value
    @JavascriptInterface fun count(value: Int): Int = value
    fun notExposed(): String = "private-value"
    private var enabled = false
  }

  private fun reply(gate: MainFrameBridge, token: String?, method: String, args: String): JSONObject =
    JSONObject(gate.invoke(token, "androidBridge", method, args))

  @Test fun wrongCapabilityRejectsBeforeParsingOrSideEffects() {
    val target = Target()
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", target) }
    for (token in listOf(null, "", "guessed", "test-secreu")) {
      assertEquals("bridge-unauthorized", reply(gate, token, "set", "not-json").getString("error"))
    }
    assertEquals(0, target.calls)
  }

  @Test fun validCapabilityPreservesSynchronousTypedValuesAndVoid() {
    val target = Target()
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", target) }
    assertTrue(reply(gate, "test-secret", "set", "[true]").getBoolean("void"))
    assertTrue(reply(gate, "test-secret", "get", "[]").getBoolean("value"))
    assertEquals(0.75, reply(gate, "test-secret", "scale", "[0.75]").getDouble("value"), 0.0)
    assertEquals(3, reply(gate, "test-secret", "count", "[3]").getInt("value"))
    assertEquals(1, target.calls)
  }

  @Test fun nullableAndZeroArgumentOverloadsKeepTheirExistingContract() {
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", Target()) }
    assertEquals("zero", reply(gate, "test-secret", "show", "[]").getString("value"))
    assertTrue(reply(gate, "test-secret", "show", "[null]").isNull("value"))
    assertEquals("text", reply(gate, "test-secret", "show", "[\"text\"]").getString("value"))
  }

  @Test fun reflectionAndUndeclaredMethodsStayUnavailableEvenWithCapability() {
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", Target()) }
    for (method in listOf("getClass", "wait", "notExposed", "constructor", "close")) {
      assertFalse(reply(gate, "test-secret", method, "[]").getBoolean("ok"))
    }
    assertFalse(JSONObject(gate.invoke("test-secret", "other", "get", "[]")).getBoolean("ok"))
  }

  @Test fun invalidTypesAndAritiesNeverReachTheEndpoint() {
    val target = Target()
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", target) }
    for (args in listOf("[]", "[true,false]", "[1]", "[\"true\"]", "[null]", "{}", "invalid")) {
      assertFalse(reply(gate, "test-secret", "set", args).getBoolean("ok"))
    }
    assertFalse(reply(gate, "test-secret", "count", "[1.5]").getBoolean("ok"))
    assertEquals(0, target.calls)
  }

  @Test fun revokedAndIndependentBridgesRejectPreviousCapabilities() {
    val first = MainFrameBridge("first-secret").also { it.register("androidBridge", Target()) }
    val second = MainFrameBridge("second-secret").also { it.register("androidBridge", Target()) }
    assertFalse(reply(second, "first-secret", "get", "[]").getBoolean("ok"))
    first.close()
    assertFalse(reply(first, "first-secret", "get", "[]").getBoolean("ok"))
  }

  @Test fun onlyTheAuthenticatedDispatcherIsExposedToAllFrames() {
    val exposed = MainFrameBridge::class.java.methods.filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
    assertEquals(listOf("invoke"), exposed.map { it.name })
  }

  @Test fun productionScreenScopeAndPickerSecretRequireCapability() {
    var scope = "virtual-only"
    var nativeApproved = false
    val bridge = AndroidBridge({}, {}, { _, _ -> }, pickToken = "private-picker-token",
      onSetScreenScope = { scope = it; scope }, onGetScreenScope = { scope }, onConfirmPrivileged = { nativeApproved })
    val gate = MainFrameBridge("test-secret").also { it.register("androidBridge", bridge) }
    val denied = reply(gate, "fake-secret", "setScreenScope", "[\"all\"]")
    assertFalse(denied.getBoolean("ok"))
    assertEquals("virtual-only", scope)
    assertFalse(reply(gate, "fake-secret", "getPickToken", "[]").toString().contains("private-picker-token"))
    assertEquals("virtual-only", reply(gate, "test-secret", "setScreenScope", "[\"all\"]").getString("value"))
    nativeApproved = true
    assertEquals("all", reply(gate, "test-secret", "setScreenScope", "[\"all\"]").getString("value"))
    assertEquals("private-picker-token", reply(gate, "test-secret", "getPickToken", "[]").getString("value"))
  }
}
