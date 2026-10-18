package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import java.lang.reflect.Method
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/** Keeps the synchronous page API while requiring a capability unavailable to untrusted frames. */
internal class MainFrameBridge(private val nonce: String = newNonce()) {
  private data class Endpoint(val receiver: Any, val methods: Map<Pair<String, Int>, Method>)
  private val endpoints = ConcurrentHashMap<String, Endpoint>()
  @Volatile private var closed = false

  /** Only methods explicitly declared as page APIs may be dispatched; Object/reflection APIs never enter this map. */
  fun register(name: String, receiver: Any) {
    check(!closed)
    require(name.matches(Regex("[A-Za-z][A-Za-z0-9_]*")))
    val methods = receiver.javaClass.methods.filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
    require(methods.isNotEmpty())
    val bySignature = methods.associateBy { it.name to it.parameterCount }
    require(bySignature.size == methods.size)
    check(endpoints.putIfAbsent(name, Endpoint(receiver, bySignature)) == null)
  }

  /** Revocation also applies to calls queued by a renderer which is being destroyed. */
  fun close() {
    closed = true
    endpoints.clear()
  }

  /** The only native method visible in every frame. Authenticate before parsing or invoking anything. */
  @JavascriptInterface
  fun invoke(capability: String?, bridge: String?, method: String?, arguments: String?): String {
    if (closed || capability == null || capability.length != nonce.length ||
      !MessageDigest.isEqual(nonce.toByteArray(Charsets.UTF_8), capability.toByteArray(Charsets.UTF_8))) {
      return failure("bridge-unauthorized")
    }
    return try {
      val endpoint = endpoints[bridge ?: return failure("bridge-method-unavailable")]
        ?: return failure("bridge-method-unavailable")
      val args = JSONArray(arguments ?: return failure("bridge-invalid-arguments"))
      val target = endpoint.methods[(method ?: return failure("bridge-method-unavailable")) to args.length()]
        ?: return failure("bridge-method-unavailable")
      val values = target.parameterTypes.mapIndexed { index, type -> argument(args.opt(index), type) }.toTypedArray()
      val value = target.invoke(endpoint.receiver, *values)
      JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL)
        .put("void", target.returnType == Void.TYPE).toString()
    } catch (_: Throwable) {
      failure("bridge-call-failed")
    }
  }

  /** Inject only by native document-start/top-document evaluation; never serve this script as a page resource. */
  fun bootstrapScript(): String {
    val methods = JSONObject()
    endpoints.toSortedMap().forEach { (name, endpoint) ->
      methods.put(name, JSONArray(endpoint.methods.keys.map { it.first }.distinct().sorted()))
    }
    return BOOTSTRAP_TEMPLATE
      .replace("__ORIGIN_JSON__", JSONObject.quote(EngineAuth.BASE_URL))
      .replace("__TOKEN_JSON__", JSONObject.quote(nonce))
      .replace("__METHODS_JSON__", methods.toString())
  }

  private fun argument(value: Any?, type: Class<*>): Any? {
    if (value == null || value === JSONObject.NULL) {
      require(!type.isPrimitive)
      return null
    }
    return when (type) {
      String::class.java -> (value as? String) ?: throw IllegalArgumentException()
      Boolean::class.javaPrimitiveType -> (value as? Boolean) ?: throw IllegalArgumentException()
      Double::class.javaPrimitiveType -> (value as? Number)?.toDouble()?.also { require(it.isFinite()) }
        ?: throw IllegalArgumentException()
      Int::class.javaPrimitiveType -> {
        val number = (value as? Number)?.toDouble() ?: throw IllegalArgumentException()
        require(number.isFinite() && number == number.toInt().toDouble())
        number.toInt()
      }
      else -> throw IllegalArgumentException()
    }
  }

  private fun failure(code: String): String = JSONObject().put("ok", false).put("error", code).toString()

  companion object {
    const val TRANSPORT = "__dshNativeBridge"

    private fun newNonce(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }
      .joinToString("") { "%02x".format(it.toInt() and 255) }

    // The nonce lives in an outer lexical closure, never in any publicly inspectable function body.
    internal val BOOTSTRAP_TEMPLATE = """
      (() => {
        if (window !== window.top || location.origin !== __ORIGIN_JSON__) return;
        const transport = window.__dshNativeBridge;
        if (!transport || typeof transport.invoke !== 'function') return;
        if (window.__dshNativeBridgeReady === true) return;
        const capability = __TOKEN_JSON__;
        const methods = __METHODS_JSON__;
        Object.keys(methods).forEach(bridge => {
          const facade = Object.create(null);
          methods[bridge].forEach(method => {
            facade[method] = function(...args) {
              const result = JSON.parse(transport.invoke(capability, bridge, method, JSON.stringify(args)));
              if (!result.ok) throw new Error(result.error || 'bridge-call-failed');
              return result.void ? undefined : result.value;
            };
          });
          Object.defineProperty(window, bridge, {value: Object.freeze(facade), configurable: false, writable: false});
        });
        Object.defineProperty(window, '__dshNativeBridgeReady', {value: true, configurable: false, writable: false});
        window.dispatchEvent(new Event('dsh-native-bridge-ready'));
      })();
    """.trimIndent()
  }
}
