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
  private const val GUEST_PATH = "/opt/node/bin:/root/.local/bin:/root/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  private const val ADDON_PACKAGE = "@deepseek-ai/node-addon-system-linux-arm64"
  /** 客体里的引擎树挂载点；引擎 JS 与 addon 都从这棵宿主树 bind 进去。 */
  const val GUEST_ENGINE_ROOT = "/opt/dsh"
  const val ENGINE_ENTRY = "@deepseek-ai/dsh/lib/bin.js"

  data class Launch(val argv: List<String>, val env: Map<String, String>, val workingDirectory: File)

  sealed class Result {
    data class Ready(val launch: Launch) : Result()
    data class Refused(val code: String, val detail: String) : Result()
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

  internal fun candidate(paths: Paths, instance: LinuxInstanceInstaller.Instance, command: List<String>, guestEnv: Map<String, String> = emptyMap()): Result =
    build(paths, command, guestEnv = guestEnv, candidate = instance)

  /** env -i isolates the guest: values must appear after it, rather than only in the host ProcessBuilder. */
  internal fun withEnvironment(launch: Launch, values: Map<String, String>): Launch {
    validateGuestEnvironment(values)
    val at = launch.argv.indexOf("LANG=C.UTF-8") + 1
    require(at > 0)
    return launch.copy(argv = launch.argv.take(at) + values.map { (key, value) -> "$key=$value" } + launch.argv.drop(at))
  }

  private fun validateGuestEnvironment(values: Map<String, String>) {
    require(values.keys.all { it.matches(Regex("[A-Za-z_][A-Za-z0-9_]*")) &&
      it !in setOf("LD_LIBRARY_PATH", "LD_PRELOAD") && !it.startsWith("PROOT_") && !it.startsWith("TERMUX") }) {
      "host loader environment cannot cross the guest boundary"
    }
  }

  private fun build(
    paths: Paths,
    command: List<String>,
    cwd: File? = null,
    guestEnv: Map<String, String> = emptyMap(),
    candidate: LinuxInstanceInstaller.Instance? = null,
  ): Result {
    val instance = candidate ?: when (val opened = LinuxInstanceInstaller.open(paths.filesDir)) {
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
      File(instance.engine, "@deepseek-ai/dsh/node_modules/$ADDON_PACKAGE/bin/glibc/system.node") to "linux-guest-addon-missing",
    )) {
      if (!file.exists()) return Result.Refused(code, "缺少 ${file.absolutePath}")
    }
    val prootTmp = File(instance.root, "proot-tmp").apply { mkdirs() }
    val shm = File(instance.root, "dev-shm").apply { mkdirs() }
    // cwd 用宿主 home 的同路径（已 bind 进 PRoot），客体侧等价于 $HOME。
    val working = (cwd ?: paths.homeDir).takeIf { it.isDirectory } ?: paths.homeDir
    val resolved = command.map { if (it == "NODE") "/opt/node/bin/node" else it }

    val argv = mutableListOf(
      proot.absolutePath, "-r", instance.rootfs.canonicalPath, "-0", "--link2symlink",
      "-w", working.absolutePath, "--sysvipc", "--kill-on-exit",
      "-b", "/proc:/proc", "-b", "/sys:/sys",
      "-b", "${instance.rootfs.canonicalPath}:${instance.rootfs.canonicalPath}", "-b", "/dev/pts:/dev/pts", "-b", "/dev/ptmx:/dev/ptmx",
      "-b", "/dev/null", "-b", "/dev/zero", "-b", "/dev/random", "-b", "/dev/urandom",
      "-b", "${shm.absolutePath}:/dev/shm",
      "-b", "${instance.node.parentFile!!.parentFile!!.canonicalPath}:${instance.node.parentFile!!.parentFile!!.canonicalPath}",
      "-b", "${instance.node.parentFile!!.parentFile!!.absolutePath}:/opt/node",
      "-b", "${instance.engine.absolutePath}:$GUEST_ENGINE_ROOT",
      "-b", "${paths.homeDir.absolutePath}:${paths.homeDir.absolutePath}",
      // 用户数据落在宿主 home，挂到客体 /root：覆盖安装替换 rootfs 时 $HOME 内容不会丢。
      "-b", "${paths.homeDir.absolutePath}:/root",
      "/usr/bin/env", "-i",
      "HOME=/root",
      "PATH=$GUEST_PATH",
      "TMPDIR=/tmp",
      "LANG=C.UTF-8",
      "DSH_BUNDLED_LINUX=1",
      "SHELL=/bin/bash",
      "npm_config_prefix=/root/.local",
      "NPM_CONFIG_PREFIX=/root/.local",
      "COREPACK_HOME=/root/.local/share/corepack",
      "PNPM_HOME=/root/.local/share/pnpm",
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      "PYTHON=/usr/bin/python3",
      "npm_config_python=/usr/bin/python3",
      "CC=/usr/bin/gcc",
      "CXX=/usr/bin/g++",
      "MAKE=/usr/bin/make",
      "PKG_CONFIG=/usr/bin/pkg-config",
    )
    val isolatedEnv = argv.indexOf("/usr/bin/env")
    val bridge = File(paths.filesDir, "audit").apply { mkdirs() }
    val selected = listOf(bridge, File(paths.filesDir, "undo-emergency.mjs"), File(paths.filesDir, "adb-keyboard-nonce"),
      File(paths.filesDir, "linux/instance.json"), File(paths.filesDir, ".linux-legacy-migration.json"),
      File(paths.filesDir, "linux-trial-result.json"))
    val binds = selected.filter { it.exists() && !java.nio.file.Files.isSymbolicLink(it.toPath()) }
      .flatMap { listOf("-b", "${it.canonicalPath}:${it.canonicalPath}") }
    argv.addAll(isolatedEnv, binds)
    validateGuestEnvironment(guestEnv)
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
