package com.dsharnessmobile.shell

import android.webkit.ServiceWorkerClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.Profile
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/** Owns only a browser session's nonDefault data; never obtains any global WebKit singleton. */
internal class BrowserHostProfile(
  sessionKey: String,
  private val allowAnonymousEngineAccess: Boolean = false,
  /** User-approved compatibility mode. Never inferred: the panel enables it explicitly. */
  val compatibility: Boolean = false,
) {
  val name: String = nameForSession(sessionKey)
  private var profile: Profile? = null
  @Volatile private var active = false
  @Volatile private var shared = false
  val serviceWorkerBlockedRequests = AtomicInteger(0)
  /** True only for a verified nonDefault profile; compatibility mode deliberately stays false. */
  val isAssigned: Boolean get() = active && profile != null
  /** A WebView may be created and navigated (isolated profile or explicit compatibility). */
  val isReady: Boolean get() = active
  val isCompatibility: Boolean get() = active && shared

  class Failure(val reason: String, cause: Throwable? = null) : IllegalStateException(reason, cause)

  companion object {
    fun supported(): Boolean = try {
      WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
    } catch (_: Throwable) { false }

    /** Stable across tab/recycle/Activity recreation; no raw session id, cookie or token in the name. */
    fun nameForSession(sessionKey: String): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(sessionKey.toByteArray(Charsets.UTF_8))
      val hex = digest.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
      return "dsh-browser-session-v1-$hex"
    }

    fun blockedResponse(): WebResourceResponse = WebResourceResponse(
      "text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
  }

  /** Explicit compatibility path; separate so the isolated attach order stays auditable. */
  private fun attachCompatibility(browser: WebView) {
    try {
      BrowserSharedFallback.attach(browser)
      profile = null
      shared = true
      active = true
    } catch (failure: Throwable) {
      active = false
      shared = false
      throw Failure("browser-profile-shared-fallback-failed", failure)
    }
  }

  /** Must be the first operation on a newly constructed browser WebView, before even settings. */
  fun attach(browser: WebView) {
    if (!supported()) {
      if (!compatibility) throw Failure("browser-profile-unsupported")
      attachCompatibility(browser)
      return
    }
    val assigned = try {
      WebViewCompat.setProfile(browser, name)
      WebViewCompat.getProfile(browser).also {
        if (it.name != name || it.name == Profile.DEFAULT_PROFILE_NAME) {
          throw Failure("browser-profile-assignment-failed")
        }
      }
    } catch (failure: Failure) { throw failure
    } catch (failure: Throwable) { throw Failure("browser-profile-assignment-failed", failure) }
    // Even a provider policy failure leaves this view unusable, never a Default fallback.
    profile = assigned
    shared = false
    active = false
    try {
      val workers = assigned.serviceWorkerController
      workers.serviceWorkerWebSettings.apply {
        blockNetworkLoads = true
        allowFileAccess = false
        allowContentAccess = false
        cacheMode = WebSettings.LOAD_NO_CACHE
      }
      workers.setServiceWorkerClient(object : ServiceWorkerClient() {
        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? {
          if (blockedRequestReason(request.url.toString()) == null) return null
          serviceWorkerBlockedRequests.incrementAndGet()
          return blockedResponse()
        }
      })
      assigned.cookieManager.setAcceptCookie(true)
      assigned.cookieManager.setAcceptThirdPartyCookies(browser, false)
      active = true
      workers.serviceWorkerWebSettings.blockNetworkLoads = false
    } catch (failure: Throwable) {
      active = false
      try { assigned.serviceWorkerController.serviceWorkerWebSettings.blockNetworkLoads = true } catch (_: Throwable) { /* Still fail closed. */ }
      throw Failure("browser-profile-policy-failed", failure)
    }
  }

  /**
   * Compatibility mode still denies loopback: it is never an isolated profile, even though
   * it can browse public HTTP(S). This is the guard that keeps the shared engine cookie jar
   * out of reach of a browser page.
   */
  fun normalize(raw: String?): String? = if (isReady) BrowserHostNavigationPolicy.normalize(
    raw, isolatedProfile = isAssigned, allowAnonymousEngineAccess = allowAnonymousEngineAccess,
  ) else null

  fun blockedRequestReason(raw: String?): String? = if (isReady) BrowserHostNavigationPolicy.blockedRequestReason(
    raw, isolatedProfile = isAssigned, allowAnonymousEngineAccess = allowAnonymousEngineAccess,
  ) else "browser-profile-not-ready"

  /** Stop workers after the session's views are destroyed; retain its own login data for reuse. */
  fun dispose() {
    active = false
    if (shared) {
      // Never clear or flush the process-wide jar: it also carries the engine session.
      shared = false
      BrowserSharedFallback.dispose()
      return
    }
    val own = profile ?: return
    check(own.name == name && own.name != Profile.DEFAULT_PROFILE_NAME)
    own.serviceWorkerController.serviceWorkerWebSettings.blockNetworkLoads = true
    // A disposed service worker must not regain network access via a stale callback.
    own.serviceWorkerController.setServiceWorkerClient(object : ServiceWorkerClient() {
      override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse = blockedResponse()
    })
    own.cookieManager.flush()
  }

  /**
   * Limited, profile-only clear after dispose. AndroidX 1.12.1 has no complete browsing-data clear:
   * this does NOT promise erasure of IndexedDB, CacheStorage or service worker registrations.
   * Never use CookieManager.getInstance/WebStorage.getInstance or a loaded-profile delete fallback.
   */
  fun clearCookieAndWebStorageData(completed: () -> Unit) {
    check(!active) { "dispose the session before clearing its data" }
    // Compatibility mode shares the process jar; clearing it would sign the engine out.
    // Report completion without touching global state (this method has no UI caller today).
    if (shared) { completed(); return }
    val own = profile ?: run { completed(); return }
    check(own.name == name && own.name != Profile.DEFAULT_PROFILE_NAME)
    own.webStorage.deleteAllData()
    own.geolocationPermissions.clearAll()
    own.cookieManager.removeAllCookies { own.cookieManager.flush(); completed() }
  }
}
