package com.dsharnessmobile.shell

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebView

/**
 * Explicit compatibility storage for devices whose WebView provider lacks MULTI_PROFILE.
 *
 * This is deliberately **not** an isolated profile: it uses the process-wide Default
 * CookieManager, so browser cookies are shared with the engine WebView and across
 * sessions. The user opts in through the browser panel (never silently), and the UI
 * shows the downgrade. Loopback is still denied by [BrowserHostNavigationPolicy]
 * because a compatibility WebView is never passed `isolatedProfile = true`.
 *
 * Kept in its own file so the source-level guard that forbids global CookieManager
 * use in [BrowserHostProfile] still protects the isolated path.
 */
internal object BrowserSharedFallback {
  private const val PREF = "dsh_browser"

  fun enabled(context: Context): Boolean =
    context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean("compatibility", false)

  fun setEnabled(context: Context, enabled: Boolean) {
    context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
      .edit().putBoolean("compatibility", enabled).apply()
  }

  /** Must run before settings/load/attach-root, like the profile path. */
  fun attach(browser: WebView) {
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    cookies.setAcceptThirdPartyCookies(browser, false)
  }

  /** No profile-owned storage to release; never clear the engine's shared jar. */
  fun dispose() = Unit
}
