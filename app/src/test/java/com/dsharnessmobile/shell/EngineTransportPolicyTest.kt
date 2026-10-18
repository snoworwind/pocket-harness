package com.dsharnessmobile.shell

import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.*
import org.junit.Test

class EngineTransportPolicyTest {
  @Test
  fun `idle upload cannot block response and later upload still arrives`() {
    java.nio.channels.ServerSocketChannel.open().use { server ->
      server.bind(java.net.InetSocketAddress("127.0.0.1", 0))
      java.net.Socket("127.0.0.1", (server.localAddress as java.net.InetSocketAddress).port).use { browser ->
        browser.soTimeout = 2000
        server.accept().use { channel ->
          channel.configureBlocking(false)
          relayChannelInput(channel).use { input ->
            relayChannelOutput(channel).use { output ->
              val waiting = java.util.concurrent.CountDownLatch(1)
              val received = java.util.concurrent.CompletableFuture<Int>()
              val upload = Thread {
                waiting.countDown()
                try {
                  while (!received.isDone) {
                    try { received.complete(input.read()) }
                    catch (_: java.net.SocketTimeoutException) { }
                  }
                } catch (e: Throwable) { received.completeExceptionally(e) }
              }.apply { isDaemon = true; start() }
              try {
                assertTrue(waiting.await(1, java.util.concurrent.TimeUnit.SECONDS))
                Thread.sleep(100)
                // Browser keeps its upload half open while waiting for the HTTP response.
                output.write(65)
                assertEquals(65, browser.getInputStream().read())
                browser.getOutputStream().write(66)
                assertEquals(66, received.get(2, java.util.concurrent.TimeUnit.SECONDS).toInt())
              } finally { channel.close(); upload.join(1500) }
            }
          }
        }
      }
    }
  }

  @Test
  fun `relay admission requires exact secret in a header or cookie field`() {
    val token = "test-secret"
    assertFalse(EngineTransport.admissionAuthorized("GET / HTTP/1.1\r\nHost: 127.0.0.1", token))
    assertFalse(EngineTransport.admissionAuthorized("GET /?x-dsh-relay=$token HTTP/1.1\r\nX-Other: $token", token))
    assertFalse(EngineTransport.admissionAuthorized("GET / HTTP/1.1\r\nCookie: dsh-relay=$token-extra", token))
    assertTrue(EngineTransport.admissionAuthorized("GET / HTTP/1.1\r\nX-DSH-Relay: $token", token))
    assertTrue(EngineTransport.admissionAuthorized("GET / HTTP/1.1\r\nCookie: a=b; dsh-relay=$token", token))
  }
  @Test
  fun `cookie attachment refuses unowned transport before modifying connection`() {
    val connection = object : HttpURLConnection(URL(EngineAuth.BASE_URL)) {
      var touched = false
      override fun connect() { touched = true }
      override fun disconnect() { }
      override fun usingProxy() = false
      override fun setRequestProperty(key: String?, value: String?) { touched = true }
    }
    try { EngineAuth.attach(connection); fail("must reject unowned initial listener") }
    catch (_: SecurityException) { }
    assertFalse(connection.touched)
  }

  @Test
  fun `mux credentials refuse unknown ownership even before context initialization`() {
    try { EngineAuth.attachMux(); fail("must reject before retrieving credentials") }
    catch (_: SecurityException) { }
  }

  @Test
  fun `health probe cannot send requests to an unowned TCP listener`() {
    val probe = EngineProbe.check(100)
    assertFalse(probe.getBoolean("running"))
    assertFalse(probe.getBoolean("listening"))
    assertEquals("unknown", probe.getString("auth"))
    assertEquals("Engine transport ownership unavailable", probe.getString("error"))
  }
}
