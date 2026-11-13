package com.snoworwind.pocketharness

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.TimeUnit

/** Trial uses a private home and an ephemeral loopback port; no live auth cache or user profile is mutated. */
internal object LinuxCandidateProbe {
  internal fun glibcSatisfies(actual: String, minimum: String): Boolean {
    fun version(value: String): List<Int>? = Regex("(?:glibc )?(\\d+)\\.(\\d+)").matchEntire(value.trim())
      ?.groupValues?.drop(1)?.map { it.toInt() }
    val a = version(actual) ?: return false
    val b = version(minimum) ?: return false
    return a[0] > b[0] || (a[0] == b[0] && a[1] >= b[1])
  }

  fun verify(context: Context, instance: LinuxInstanceInstaller.Instance, manifest: JSONObject, progress: (String) -> Unit) {
    progress("验证 Linux 兼容性与候选引擎…")
    val trial = File(context.filesDir, ".linux-trial")
    SnapshotFs.deletePath(trial)
    val home = File(trial, "home").apply { mkdirs() }
    val current = File(context.filesDir, "home/.dsh")
    val config = File(home, ".dsh").apply { mkdirs() }
    // Sessions, attachments and workspaces are not needed to validate a candidate engine.
    for (name in listOf("profiles", "settings.yaml", ".credentials.yaml", "AGENTS.md")) {
      val source = File(current, name)
      if (source.isDirectory) LinuxFileTree.mergeMissing(source, File(config, name))
      else if (source.isFile && !java.nio.file.Files.isSymbolicLink(source.toPath())) source.copyTo(File(config, name))
    }
    val port = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
    val paths = LinuxGuestBoot.Paths(context.filesDir, File(context.applicationInfo.nativeLibraryDir), home, port)
    val env = mapOf("DSH_HOME" to "/root/.dsh", "DSH_FILES_DIR" to trial.absolutePath, "SHELL" to "/bin/bash", "TERM" to "xterm-256color")
    val output = File(trial, "compatibility.log")
    fun launch(command: List<String>, log: File): Process {
      val result = LinuxGuestBoot.candidate(paths, instance, command, env)
      require(result is LinuxGuestBoot.Result.Ready) { "candidate launch rejected: $result" }
      return ProcessBuilder(result.launch.argv).apply {
        environment().clear(); environment().putAll(result.launch.env)
        directory(home); redirectErrorStream(true); redirectOutput(log)
      }.start()
    }
    fun tail(file: File): String {
      if (!file.isFile) return ""
      return java.io.RandomAccessFile(file, "r").use { reader ->
        reader.seek((reader.length() - 128 * 1024).coerceAtLeast(0))
        val bytes = ByteArray((reader.length() - reader.filePointer).toInt())
        reader.readFully(bytes); bytes.toString(Charsets.UTF_8)
      }
    }
    var process: Process? = null
    try {
      process = launch(listOf("/usr/bin/getconf", "GNU_LIBC_VERSION"), output)
      check(process.waitFor(20, TimeUnit.SECONDS)) { "glibc preflight timed out" }
      check(process.exitValue() == 0 && glibcSatisfies(output.readText(), manifest.getString("minimumGlibc"))) { "rootfs glibc does not satisfy candidate runtime" }
      val nodeScript = "const {createRequire}=require('module');const r=createRequire('/opt/dsh/@deepseek-ai/dsh/package.json');r('@deepseek-ai/node-addon-system');const p=r('node-pty').spawn('/bin/bash',['-c','printf PTY_OK'],{env:process.env});let s='';p.onData(x=>s+=x);p.onExit(e=>process.exit(e.exitCode===0&&s.includes('PTY_OK')?0:1));"
      process = launch(listOf("NODE", "--expose-internals", "-e", nodeScript), output)
      check(process.waitFor(30, TimeUnit.SECONDS) && process.exitValue() == 0) { "guest Node/addon/PTY preflight failed" }
      val log = File(trial, "engine.log")
      process = launch(listOf("NODE", "--expose-internals", "/opt/dsh/" + LinuxGuestBoot.ENGINE_ENTRY, "web", "--port", port.toString(), "--no-open"), log)
      val deadline = System.currentTimeMillis() + 180_000
      var cookie: String? = null
      var healthy = false
      while (System.currentTimeMillis() < deadline && process.isAlive) {
        if (cookie == null && log.isFile) {
          val token = EngineAuth.TOKEN_RE.find(tail(log))?.groupValues?.get(1)
          if (token != null) runCatching {
            request(port, "/?token=$token").let { connection ->
              try {
                if (connection.responseCode in 200..399) cookie = connection.getHeaderField("Set-Cookie")?.substringBefore(';')
              } finally { connection.disconnect() }
            }
          }
        }
        if (cookie != null) {
          val anonymous = runCatching { request(port, "/api/android/env/status").let { c -> try { c.responseCode } finally { c.disconnect() } } }.getOrNull()
          val authenticated = runCatching { request(port, "/api/android/env/status", cookie).let { c ->
            try {
              // Bounded read: a wedged candidate must not turn the readiness probe into an
              // unbounded wait (the connect/read timeouts do not bound a buffered reader).
              val body = c.inputStream.use { it.readNBytes(64 * 1024).toString(Charsets.UTF_8) }
              c.responseCode == 200 && JSONObject(body).length() > 0
            } finally { c.disconnect() }
          } }.getOrDefault(false)
          if (anonymous == 401 && authenticated) { healthy = true; break }
        }
        Thread.sleep(500)
      }
      check(healthy) { "candidate HTTP/auth/mobile-plugin trial failed; live runtime retained" }
      LinuxUpgradeTransaction.atomicWrite(File(context.filesDir, "linux-trial-result.json"), JSONObject().put("ok", true).put("epochMs", System.currentTimeMillis()).put("baseId", manifest.getString("baseId")).put("engineSha256", manifest.getString("engineSha256")).toString())
    } catch (error: Exception) {
      LogSanitizer.sanitizeOrNull(tail(File(trial, "engine.log")) + "\n" + tail(output))?.let {
        LinuxUpgradeTransaction.atomicWrite(File(context.filesDir, "linux-trial-failed.log"), it)
      }
      throw error
    } finally {
      process?.let { child -> if (child.isAlive) { child.destroy(); if (!child.waitFor(5, TimeUnit.SECONDS)) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS) } } }
      SnapshotFs.deletePath(trial)
    }
  }

  private fun request(port: Int, path: String, cookie: String? = null): HttpURLConnection =
    (URL("http://127.0.0.1:$port$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
      connectTimeout = 1500; readTimeout = 1500; instanceFollowRedirects = false
      if (cookie != null) setRequestProperty("Cookie", cookie)
    }
}
