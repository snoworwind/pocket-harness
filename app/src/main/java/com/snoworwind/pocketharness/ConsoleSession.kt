package com.snoworwind.pocketharness

import android.content.Context
import android.util.Log
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.Executors

/**
 * Console session: spawns the snapshot bash (env matching the engine: PATH/LD_LIBRARY_PATH/
 * HOME/DSH_HOME/TERMUX_*), writes commands to stdin, reads merged stdout/stderr on a background
 * thread, and streams output back to the UI via a Listener. Works even when the engine is not
 * running (for diagnosing engine startup failures); the process dies with the Activity.
 *
 * Non-PTY interaction (bash -i): no job-control prompts, commands run line by line; full PTY
 * (script -q -c bash) is planned for a later iteration.
 */
class ConsoleSession(private val context: Context) {

  /**
   * 控制台会话的状态（S1-18）。
   *
   * 为什么要有这个枚举：旧实现只把**文案**推给页面（`onStatus("bash 已启动（快照 Termux 环境）")`），
   * 页面于是靠对文案做子串正则判就绪（`/已启动/`、`/退出|失败|缺失/`）。措辞一改，判据就静默错判
   * （页面永远停在「启动中」、输入框永久禁用，而壳侧一切正常）。现在状态是显式契约，文案只用于显示。
   *  `wire` 是与页面共享的字符串，**改名即与页面失配**（有测试钉住）。
   */
  enum class State(val wire: String) {
    /** 正在拉起 bash。 */
    STARTING("starting"),

    /** bash 已就绪，可执行命令。 */
    READY("ready"),

    /** 拉起失败（exec 被拒、环境异常…）——重连**有意义**。 */
    FAILED("failed"),

    /** bash 已退出（含退出码）。 */
    EXITED("exited"),

    /** 快照里的 bash 不存在——重连**必然同样失败**（S1-16），页面据此把按钮换成「返回应用」。 */
    MISSING("missing"),
  }

  interface Listener {
    /** Output chunk (\r collapsed, bell ignored); callback on any thread. */
    fun onOutput(text: String)
    /** 状态（显式枚举 + 面向用户的文案）；callback on any thread。 */
    fun onStatus(state: State, text: String)
    /** bash process exit code. */
    fun onExit(code: Int)
  }

  @Volatile private var process: Process? = null
  @Volatile private var closed = false
  @Volatile private var generation = 0
  private val stateLock = Any()
  private var starting = false // guarded by stateLock
  private val starter = Executors.newSingleThreadExecutor { task ->
    Thread(task, "dsh-console-start").apply { isDaemon = true }
  }

  /** Queue bash startup off the Activity thread; false means this session cannot accept a start. */
  fun start(listener: Listener): Boolean {
    val gen = synchronized(stateLock) {
      if (closed || starting || process != null) return false
      starting = true
      generation += 1
      generation
    }
    return try {
      starter.execute { startProcess(listener, gen) }
      true
    } catch (t: Throwable) {
      finishStart(gen)
      notifyIfCurrent(gen) {
        listener.onStatus(State.FAILED, "控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
      }
      false
    }
  }

  /** File checks, environment setup and ProcessBuilder.start all run on the private worker. */
  private fun startProcess(listener: Listener, gen: Int) {
    var proc: Process? = null
    try {
      if (!isCurrent(gen)) return
      val engineManager = EngineManager(context, EngineManager.ensurePickToken())
      val bash = File(engineManager.usrDir, "bin/bash")
      if (!bash.exists()) {
        // P3-6：快照内的相对路径不上屏（用户看不懂 `usr/bin/bash`，也做不了什么）——
        // 正文说清「缺什么组件、能不能重试」，路径进日志。
        Log.w(TAG, "console unavailable: bash missing at " + bash.absolutePath)
        notifyIfCurrent(gen) {
          listener.onStatus(State.MISSING,
            "运行时缺少命令行组件（快照不完整），无法打开控制台——请重新安装应用或重装运行时快照")
        }
        return
      }
      // Exec-bit fallback: some devices/filesystems lose the exec bit after extraction (execve → EACCES,
      // "Permission denied"). The tar mode is theoretically preserved; this is an idempotent hardening step.
      try {
        bash.setExecutable(true, false)
      } catch (t: Throwable) {
        Log.w(TAG, "bash setExecutable failed: " + (t.message ?: t.javaClass.simpleName))
      }
      fun build(argv: List<String>): ProcessBuilder =
        ProcessBuilder(argv).also { p ->
          p.environment().putAll(engineManager.shellEnv())
          p.environment()["PS1"] = "dsh:\\w$ "
          p.redirectErrorStream(true)
        }
      val argv = listOf(bash.absolutePath, "-i")
      // Same fallback as the engine: Android 15/16 and some OEM systems (Honor/Huawei, measured)
      // forbid the app domain from exec'ing an app-data ELF directly (EACCES Permission denied);
      // loading via /system/bin/linker64 matches the Android system-lib mechanism and always works.
      val startedProcess = try {
        build(argv).start()
      } catch (e: java.io.IOException) {
        Log.w(TAG, "console: direct exec denied, falling back to linker64: " + e.message)
        build(listOf("/system/bin/linker64") + argv).start()
      }
      proc = startedProcess
      val accepted = synchronized(stateLock) {
        if (closed || generation != gen) false
        else {
          process = startedProcess
          starting = false
          true
        }
      }
      if (!accepted) {
        startedProcess.destroy()
        return
      }
      val outputBatcher = ConsoleOutputBatcher { text ->
        notifyIfCurrent(gen) { listener.onOutput(text) }
      }
      val reader = Thread {
        var pendingCr = false
        var pendingHighSurrogate: Char? = null
        try {
          InputStreamReader(startedProcess.inputStream).use { r ->
            val chars = CharArray(1024)
            while (true) {
              val count = r.read(chars)
              if (count < 0) break
              if (count == 0) continue
              val raw = StringBuilder(count + 1)
              var offset = 0
              pendingHighSurrogate?.let { high ->
                if (Character.isLowSurrogate(chars[0])) {
                  raw.append(high).append(chars[0])
                  offset = 1
                } else {
                  raw.append('\uFFFD')
                }
                pendingHighSurrogate = null
              }
              var end = count
              if (end > offset && Character.isHighSurrogate(chars[end - 1])) {
                pendingHighSurrogate = chars[end - 1]
                end -= 1
              }
              if (end > offset) raw.append(chars, offset, end - offset)

              val normalized = StringBuilder(raw.length)
              for (c in raw) {
                if (pendingCr) {
                  normalized.append('\n')
                  pendingCr = false
                  if (c == '\n') continue
                }
                when (c) {
                  '\r' -> pendingCr = true
                  '\u0007' -> Unit
                  else -> normalized.append(c)
                }
              }
              if (normalized.isNotEmpty()) outputBatcher.append(normalized.toString())
            }
            if (pendingCr) outputBatcher.append("\n")
            if (pendingHighSurrogate != null) outputBatcher.append("\uFFFD")
          }
        } catch (t: Throwable) {
          if (isCurrent(gen)) Log.w(TAG, "console reader ended: " + (t.message ?: t.javaClass.simpleName))
        } finally {
          outputBatcher.close()
        }
        // destroy() race: after bash closes stdout on SIGTERM (read hits EOF) the process may not have
        // fully exited yet — exitValue() then throws IllegalThreadStateException (measured when the app
        // is killed). Report as exited, or mark -1.
        val code = try {
          startedProcess.exitValue()
        } catch (_: IllegalThreadStateException) {
          -1
        }
        notifyIfCurrent(gen) { listener.onExit(code) }
      }
      reader.isDaemon = true
      reader.name = "dsh-console-output"
      // Post READY before starting the reader so an immediate EOF cannot be followed by stale READY.
      notifyIfCurrent(gen) { listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境）") }
      reader.start()
    } catch (t: Throwable) {
      val failedProcess = proc
      if (failedProcess != null) {
        synchronized(stateLock) { if (process === failedProcess) process = null }
        failedProcess.destroy()
      }
      if (isCurrent(gen)) {
        LogCollector.log(TAG, "console start FAILED: " + (t.message ?: t.javaClass.simpleName))
        notifyIfCurrent(gen) {
          listener.onStatus(State.FAILED, "控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
        }
      }
    } finally {
      finishStart(gen)
    }
  }

  private fun isCurrent(gen: Int): Boolean = !closed && generation == gen

  /** Hold the lifecycle lock through callback delivery so restart cannot race a stale event. */
  private fun notifyIfCurrent(gen: Int, callback: () -> Unit): Boolean = synchronized(stateLock) {
    if (closed || generation != gen) false
    else {
      callback()
      true
    }
  }

  private fun finishStart(gen: Int) {
    synchronized(stateLock) {
      if (generation == gen) starting = false
    }
  }

  /** Write one command (appends \n). */
  fun writeCommand(cmd: String) {
    val proc = process ?: return
    try {
      proc.outputStream.write((cmd + "\n").toByteArray(Charsets.UTF_8))
      proc.outputStream.flush()
    } catch (t: Throwable) {
      Log.w(TAG, "console write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  fun isAlive(): Boolean {
    val proc = process ?: return false
    return try {
      proc.exitValue()
      false
    } catch (_: IllegalThreadStateException) {
      true
    }
  }

  fun restart(listener: Listener): Boolean {
    val oldProcess = synchronized(stateLock) {
      if (closed) return false
      generation += 1 // invalidate an in-flight start or reader callback before stopping it
      starting = false
      process.also { process = null }
    }
    oldProcess?.destroy()
    return start(listener)
  }

  /** Terminate the session (Activity destroyed). */
  fun destroy() {
    val oldProcess = synchronized(stateLock) {
      if (closed) return
      closed = true
      generation += 1
      starting = false
      process.also { process = null }
    }
    oldProcess?.destroy()
    starter.shutdownNow()
  }

  companion object {
    private const val TAG = "dsh-console"
  }
}
