package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalBrowserPolicyTest {
  @Test fun userSelectedWebLinksRemainAvailable() {
    assertTrue(canOpenExternalBrowser("https://example.com/path?q=one#two", true))
    assertTrue(canOpenExternalBrowser("http://192.168.1.2:8080/", true))
  }

  @Test fun rendererCannotLaunchAppsWithoutUserGesture() {
    assertFalse(canOpenExternalBrowser("https://example.com/", false))
    assertFalse(canOpenExternalBrowser("custom-app://perform-sensitive-action", false))
  }

  @Test fun gestureDoesNotPermitNativeSchemesOrAmbiguousAddresses() {
    for (url in listOf(
      "intent://launch#Intent;scheme=app;end", "content://private.provider/file",
      "file:///data/user/0/com.dsharnessmobile.shell/files/engine.log",
      "custom-app://perform-sensitive-action", "javascript:alert(1)", "data:text/html,test",
      "https://user:secret@example.com/", "https://example.com\\@evil.com/",
      "https://example.com\n", "https://example.com:99999/", "https:///path",
      "http://127.0.0.1:3080/?token=secret",
    )) assertFalse(url, canOpenExternalBrowser(url, true))
  }
}
