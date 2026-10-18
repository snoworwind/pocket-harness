package com.dsharnessmobile.shell

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

/** Run in a fresh app process before any Activity or EngineService starts. */
class EngineTransportInstrumentedTest {
  @Test fun foreignPortIsRefusedAndPrivatePeerCarriesAuthenticatedRequests() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertFalse("requires fresh target process", EngineTransport.ownsPort())
    ServerSocket(3080, 8, InetAddress.getByName("127.0.0.1")).use { foreign ->
      try { EngineTransport.initialize(context); fail("foreign listener must prevent initialization") }
      catch (_: java.io.IOException) { }
      val conn = URL(EngineAuth.BASE_URL).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
      try { EngineAuth.attach(context, conn); fail("credentials must be blocked before network I/O") }
      catch (_: SecurityException) { }
      finally { conn.disconnect() }
      foreign.soTimeout = 200
      try { foreign.accept().use { fail("foreign listener received a connection") } }
      catch (_: java.net.SocketTimeoutException) { }
    }
    EngineTransport.initialize(context)
    // More than the old 32 streaming slots: these peers never authenticate.
    val untrusted = List(40) { java.net.Socket("127.0.0.1", 3080) }
    val file = File(context.filesDir, "engine-private.sock")
    file.delete()
    LocalSocket().use { bound ->
      bound.bind(LocalSocketAddress(file.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
      LocalServerSocket(bound.fileDescriptor).use { server ->
        val received = AtomicReference<String>()
        val error = AtomicReference<Throwable>()
        val worker = Thread {
          try {
            server.accept().use { peer ->
              peer.soTimeout = 3000
              val reader = peer.inputStream.bufferedReader()
              val lines = ArrayList<String>()
              while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; lines.add(line) }
              received.set(lines.joinToString("\n"))
              // Let the relay's upload half wait for more browser data before responding.
              // SocketAdaptor streams on Android then deadlock the response behind blockingLock.
              Thread.sleep(200)
              peer.outputStream.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
            }
          } catch (e: Throwable) { error.set(e) }
        }.apply { start() }
        val conn = URL(EngineAuth.BASE_URL + "/api/test").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 3000
        conn.setRequestProperty("Cookie", "synthetic-private-cookie")
        conn.setRequestProperty("X-DSH-Relay", EngineTransport.admissionCookie().substringAfter('='))
        try { assertEquals("ok", conn.inputStream.bufferedReader().use { it.readText() }) }
        finally { conn.disconnect(); untrusted.forEach { it.close() }; worker.join(4000) }
        assertNull(error.get())
        assertTrue(received.get().contains("synthetic-private-cookie"))
        assertTrue(received.get().contains("/api/test"))
      }
    }
    file.delete()
    assertFalse("relay binding alone must not count as a live engine", EngineProbe.portReachable())
    try {
      ServerSocket(3080, 8, InetAddress.getByName("127.0.0.1")).use { fail("backend exit must not release public port") }
    } catch (_: java.net.BindException) { }
  }
}
