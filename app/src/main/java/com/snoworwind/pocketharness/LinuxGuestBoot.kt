package com.snoworwind.pocketharness

import org.json.JSONObject
import java.io.File

/**
 * 纯 Linux 客体启动（实验）：用已安装的 PRoot/Debian 实例运行 DSH 引擎，而不是 Termux 快照。
 *
 * 这里只负责“能不能起、按什么 argv/env 起”，不碰进程管理；调用方负责 spawn 与回退。
 * 所有判定都基于真实文件存在性与 JSON 结构，缺一项就给出稳定拒绝码，绝不半启动。
 */
internal object LinuxGuestBoot {
  const val PREFERENCE_FILE = "boot-mode.json"
  const val MODE_TERMUX = "termux"
  const val MODE_LINUX = "linux"

  private const val ACTIVE_SCHEMA = 1
  private const val GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  private const val ADDON_PACKAGE = "@deepseek-ai/node-addon-system-linux-arm64"
  /** 客体里的引擎树挂载点；引擎 JS 与 addon 都从这棵宿主树 bind 进去。 */
  const val GUEST_ENGINE_ROOT = "/opt/dsh"
  const val ENGINE_ENTRY = "@deepseek-ai/dsh/lib/bin.js"

  data class Launch(val argv: List<String>, val env: Map<String, String>, val workingDirectory: File)

  sealed class Result {
    data class Ready(val launch: Launch) : Result()
    data class Refused(val code: String, val detail: String) : Result()
  }

  /**
   * 启动模式：boot-mode.json 显式写 `termux`/`linux` 时以它为准；文件缺失时按实例是否就绪决定，
   * 文件损坏按 Termux 处理，避免坏文件让应用起不来。
   */
  fun mode(linuxEnvironment: File, runtimeInstalled: Boolean): String {
    val file = File(linuxEnvironment, PREFERENCE_FILE)
    if (!file.isFile) return if (runtimeInstalled) MODE_LINUX else MODE_TERMUX
    return try {
      when (JSONObject(file.readText()).optString("mode")) {
        MODE_TERMUX -> MODE_TERMUX
        MODE_LINUX -> MODE_LINUX
        else -> if (runtimeInstalled) MODE_LINUX else MODE_TERMUX
      }
    } catch (_: Exception) {
      MODE_TERMUX
    }
  }

  data class Paths(
    val filesDir: File,
    val nativeLibraryDir: File,
    val homeDir: File,
    val port: Int,
  )

  /** 读取/落地内置实例；未安装时由调用方决定是否解包。 */
  fun resolve(paths: Paths): Result = build(
    paths = paths,
    command = listOf(
      // require-builtin 的降级路径需要 V8 内部绑定；Termux 侧同样带这个开关。
      "NODE", "--expose-internals", "$GUEST_ENGINE_ROOT/$ENGINE_ENTRY", "web",
      "--port", paths.port.toString(), "--no-open",
    ),
  )

  /**
   * 在同一个客体实例里执行任意命令（控制台、终端、Undo CLI 共用）。
   * [command] 是客体命令（如 `/bin/bash -i`），不是宿主路径。
   */
  fun command(
    paths: Paths,
    command: List<String>,
    cwd: File? = null,
    guestEnv: Map<String, String> = emptyMap(),
  ): Result = build(paths, command, cwd, guestEnv)

  private fun build(
    paths: Paths,
    command: List<String>,
    cwd: File? = null,
    guestEnv: Map<String, String> = emptyMap(),
  ): Result {
    val instance = when (val opened = LinuxInstanceInstaller.open(paths.filesDir)) {
      is LinuxInstanceInstaller.Result.Ready -> opened.instance
      is LinuxInstanceInstaller.Result.Failed -> return Result.Refused(opened.code, opened.detail)
    }
    if (command.isEmpty()) return Result.Refused("linux-guest-command-empty", "客体命令为空")
    val proot = File(paths.nativeLibraryDir, "libpocketharness_proot.so")
    val loader = File(paths.nativeLibraryDir, "libpocketharness_proot_loader.so")
    for ((file, code) in listOf(
      proot to "linux-guest-native-missing",
      loader to "linux-guest-native-missing",
      instance.rootfs to "linux-instance-incomplete",
      instance.node to "linux-instance-incomplete",
      File(instance.engine, ENGINE_ENTRY) to "linux-guest-engine-missing",
    )) {
      if (!file.exists()) return Result.Refused(code, "缺少 ${file.absolutePath}")
    }
    val prootTmp = File(instance.root, "proot-tmp").apply { mkdirs() }
    val shm = File(instance.root, "dev-shm").apply { mkdirs() }
    val working = (cwd ?: paths.homeDir).takeIf { it.isDirectory } ?: paths.homeDir
    val resolved = command.map { if (it == "NODE") instance.node.absolutePath else it }

    val argv = mutableListOf(
      proot.absolutePath, "-r", instance.rootfs.absolutePath, "-0",
      "-w", working.absolutePath, "--sysvipc", "--kill-on-exit",
      "-b", "/dev/null", "-b", "/dev/zero", "-b", "/dev/random", "-b", "/dev/urandom",
      "-b", "${shm.absolutePath}:/dev/shm",
      "-b", "${instance.node.absolutePath}:${instance.node.absolutePath}",
      "-b", "${instance.engine.absolutePath}:$GUEST_ENGINE_ROOT",
      "-b", "${paths.homeDir.absolutePath}:${paths.homeDir.absolutePath}",
      // 引擎资产、急救 CLI 等宿主私有文件按原路径可见，避免再造一套路径映射。
      "-b", "${paths.filesDir.absolutePath}:${paths.filesDir.absolutePath}",
      "/usr/bin/env", "-i",
      "HOME=/root",
      "PATH=$GUEST_PATH",
      "TMPDIR=/tmp",
      "LANG=C.UTF-8",
    )
    for ((key, value) in guestEnv) argv.add("$key=$value")
    argv.addAll(resolved)

    val env = mapOf(
      "PROOT_LOADER" to loader.absolutePath,
      "PROOT_TMP_DIR" to prootTmp.absolutePath,
      // Android 16/6.6 上 PRoot 的 seccomp 加速器会间歇性 exit 182，客体执行统一关掉它。
      "PROOT_NO_SECCOMP" to "1",
      "LD_LIBRARY_PATH" to paths.nativeLibraryDir.absolutePath,
    )
    return Result.Ready(Launch(argv = argv, env = env, workingDirectory = working))
  }

  /** 实例是否已就绪（不解包，只读结构）。 */
  fun installed(filesDir: File): Boolean = LinuxInstanceInstaller.open(filesDir) is LinuxInstanceInstaller.Result.Ready

  private val SAFE_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
}
