package com.dsharnessmobile.shell

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.Semaphore

/** Owns the public port for the entire shell process; forwards only to a private, UID-checked socket. */
object EngineTransport {
  @Volatile private var listener: ServerSocket? = null
  @Volatile private var endpoint: File? = null
  private val slots = Semaphore(32)
  private val admissionToken = java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID().toString()
  fun admissionCookie(): String = "dsh-relay=$admissionToken"

  internal fun admissionAuthorized(header: String, token: String): Boolean =
    header.split("\r\n").drop(1).any { line ->
      val name = line.substringBefore(':').lowercase()
      val value = line.substringAfter(':', "").trim()
      (name == "x-dsh-relay" && value == token) ||
        (name == "cookie" && value.split(';').any { it.trim() == "dsh-relay=$token" })
    }

  @Synchronized fun initialize(context: Context) {
    if (listener != null) return
    val channel = java.nio.channels.ServerSocketChannel.open()
    val server = channel.socket()
    try {
      // Linux still forbids a second listener; allow rebinding after the previous shell's TIME_WAIT.
      server.reuseAddress = true
      server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 3080), 32)
      endpoint = File(context.filesDir, "engine-private.sock")
      listener = server
      android.webkit.CookieManager.getInstance().setCookie(
        "http://127.0.0.1:3080", admissionCookie() + "; Path=/; HttpOnly; SameSite=Strict",
      )
      channel.configureBlocking(false)
      Thread({ admit(channel) }, "engine-private-relay").apply { isDaemon = true }.start()
    } catch (e: Exception) {
      server.close()
      listener = null
      endpoint = null
      throw IOException("Engine port is not owned by this shell", e)
    }
  }

  /** Never release this binding on engine restart: a freed port could receive persisted browser cookies. */
  fun requireOwnedPort() {
    val server = listener
    if (server == null || server.isClosed || !server.isBound) {
      throw SecurityException("Engine transport ownership unavailable")
    }
  }

  fun ownsPort(): Boolean = listener?.let { it.isBound && !it.isClosed } == true

  private fun backend(): LocalSocket {
    requireOwnedPort()
    val socket = LocalSocket()
    try {
      socket.connect(LocalSocketAddress(endpoint!!.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
      // SO_PEERCRED belongs to this established connection, not a preflight port observation.
      if (socket.peerCredentials.uid != Process.myUid()) throw SecurityException("Foreign engine socket")
      socket.soTimeout = 60_000
      return socket
    } catch (e: Exception) {
      socket.close()
      throw e
    }
  }

  fun backendReachable(): Boolean = try { backend().use { true } } catch (_: Exception) { false }

  /** The packaged preload changes only the engine's HTTP bind; unrelated servers keep their normal ports. */
  fun preparePreload(context: Context): File {
    initialize(context)
    val socket = endpoint ?: throw IOException("Missing engine socket")
    if (socket.exists() && !socket.delete()) throw IOException("Could not remove stopped engine socket")
    val preload = File(context.filesDir, "engine-private-transport.cjs")
    context.assets.open("engine-private-transport.cjs").use { input ->
      preload.outputStream().use { input.copyTo(it) }
    }
    return preload
  }

  /** Unauthenticated connections never consume a backend or streaming slot.
   * One selector, bounded memory and absolute deadlines resist slow-header trickles.
   * At capacity evict the oldest untrusted peer so newcomers can authenticate.
   */
  private fun admit(server: java.nio.channels.ServerSocketChannel) {
    data class Pending(val bytes: java.nio.ByteBuffer, val deadline: Long)
    val pending = LinkedHashMap<java.nio.channels.SocketChannel, Pending>()
    java.nio.channels.Selector.open().use { selector ->
      server.register(selector, java.nio.channels.SelectionKey.OP_ACCEPT)
      while (server.isOpen) {
        selector.select(100)
        val now = android.os.SystemClock.elapsedRealtime()
        val expired = pending.filterValues { now >= it.deadline }.keys.toList()
        for (socket in expired) { pending.remove(socket); socket.close() }
        val admitted = mutableListOf<Pair<java.nio.channels.SocketChannel, ByteArray>>()
        val keys = selector.selectedKeys().iterator()
        while (keys.hasNext()) {
          val key = keys.next(); keys.remove()
          if (!key.isValid) continue
          if (key.isAcceptable) {
            val socket = server.accept() ?: continue
            if (pending.size >= 128) {
              val oldest = pending.keys.first()
              pending.remove(oldest); oldest.close()
            }
            socket.configureBlocking(false)
            pending[socket] = Pending(java.nio.ByteBuffer.allocate(16 * 1024), now + 2_000)
            socket.register(selector, java.nio.channels.SelectionKey.OP_READ)
          } else if (key.isReadable) {
            val socket = key.channel() as java.nio.channels.SocketChannel
            val state = pending[socket] ?: continue
            try {
              if (socket.read(state.bytes) < 0) { pending.remove(socket); socket.close(); continue }
              val bytes = state.bytes.array().copyOf(state.bytes.position())
              val text = String(bytes, Charsets.ISO_8859_1)
              val end = text.indexOf("\r\n\r\n")
              if (end < 0) {
                if (!state.bytes.hasRemaining()) { pending.remove(socket); socket.close() }
                continue
              }
              pending.remove(socket)
              key.cancel()
              if (!admissionAuthorized(text.substring(0, end), admissionToken) || !slots.tryAcquire()) {
                socket.close(); continue
              }
              admitted.add(socket to bytes)
            } catch (_: Exception) { pending.remove(socket); runCatching { socket.close() } }
          }
        }
        if (admitted.isNotEmpty()) {
          selector.selectNow() // Deregister admission keys before handing off to the two I/O selectors.
          for ((socket, bytes) in admitted) {
            try { stream(socket, bytes) }
            catch (_: Exception) { slots.release(); runCatching { socket.close() } }
          }
        }
      }
      pending.keys.forEach { runCatching { it.close() } }
    }
  }

  private fun stream(client: java.nio.channels.SocketChannel, prefix: ByteArray) {
      Thread({
        try {
          client.use { tcp ->
            backend().use { unix ->
              unix.outputStream.write(prefix)
              val activity = java.util.concurrent.atomic.AtomicLong(android.os.SystemClock.elapsedRealtime())
              relayChannelInput(tcp).use { input ->
                relayChannelOutput(tcp).use { output ->
                  val upload = Thread({
                    try { copyActive(input, unix.outputStream, activity) }
                    catch (_: Exception) { }
                    finally { runCatching { unix.shutdownOutput() } }
                  }, "engine-private-upload").apply { isDaemon = true; start() }
                  try { copyActive(unix.inputStream, output, activity) }
                  finally { tcp.close(); unix.close(); upload.join(1_000) }
                }
              }
            }
          }
        } catch (_: Exception) { runCatching { client.close() } }
        finally { slots.release() }
      }, "engine-private-stream").apply { isDaemon = true; start() }
  }

  /** A streaming response also keeps its upload half alive, even when the browser sends no more data. */
  private fun copyActive(
    input: java.io.InputStream,
    output: java.io.OutputStream,
    activity: java.util.concurrent.atomic.AtomicLong,
  ) {
    val buffer = ByteArray(8192)
    while (true) {
      val count = try { input.read(buffer) } catch (e: java.io.InterruptedIOException) {
        if (android.os.SystemClock.elapsedRealtime() - activity.get() >= 60_000) throw e
        continue
      }
      if (count < 0) return
      activity.set(android.os.SystemClock.elapsedRealtime())
      output.write(buffer, 0, count)
    }
  }
}

/** SocketAdaptor streams share blockingLock on Android: an idle upload would block every response.
 * Keep the channel nonblocking and give each direction its own readiness selector instead.
 */
internal fun relayChannelInput(channel: java.nio.channels.SocketChannel): java.io.InputStream =
  object : java.io.InputStream() {
    private val selector = java.nio.channels.Selector.open().also {
      channel.register(it, java.nio.channels.SelectionKey.OP_READ)
    }
    override fun read(): Int {
      val one = ByteArray(1)
      return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 255
    }
    override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
      if (length == 0) return 0
      val buffer = java.nio.ByteBuffer.wrap(bytes, offset, length)
      val count = channel.read(buffer)
      if (count != 0) return count
      selector.select(1_000)
      selector.selectedKeys().clear()
      val ready = channel.read(buffer)
      if (ready == 0) throw java.net.SocketTimeoutException("Relay read idle")
      return ready
    }
    override fun close() { selector.close() }
  }

internal fun relayChannelOutput(channel: java.nio.channels.SocketChannel): java.io.OutputStream =
  object : java.io.OutputStream() {
    private val selector = java.nio.channels.Selector.open().also {
      channel.register(it, java.nio.channels.SelectionKey.OP_WRITE)
    }
    override fun write(value: Int) { write(byteArrayOf(value.toByte()), 0, 1) }
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
      val buffer = java.nio.ByteBuffer.wrap(bytes, offset, length)
      var lastProgress = System.nanoTime()
      while (buffer.hasRemaining()) {
        if (channel.write(buffer) > 0) { lastProgress = System.nanoTime(); continue }
        if (System.nanoTime() - lastProgress >= 60_000_000_000L) {
          throw java.net.SocketTimeoutException("Relay write stalled")
        }
        selector.select(1_000)
        selector.selectedKeys().clear()
      }
    }
    override fun close() { selector.close() }
  }
