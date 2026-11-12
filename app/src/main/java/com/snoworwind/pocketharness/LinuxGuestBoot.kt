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

  data class Launch(val argv: List<String>, val env: Map<String, String>, val workingDirectory: File)

  sealed class Result {
    data class Ready(val launch: Launch) : Result()
    data class Refused(val code: String, val detail: String) : Result()
  }

  data class Paths(
    val runtimeRoot: File,
    val nativeLibraryDir: File,
    val engineUsr: File,
    val engineBin: File,
    val homeDir: File,
    val port: Int,
  )

  /**
   * 启动模式：
   * - boot-mode.json 显式写 `linux`/`termux` 时以它为准；
   * - 文件缺失时，装了 Linux 实例就走客体（本轮目标“PRoot 下的纯 Linux”），没装就走 Termux；
   * - 文件损坏按 Termux 处理，避免一个坏文件让应用起不来。
   */
  fun mode(linuxEnvironment: File, runtimeInstalled: Boolean): String {
    val file = File(linuxEnvironment, PREFERENCE_FILE)
    if (!file.isFile) return if (runtimeInstalled) MODE_LINUX else MODE_TERMUX
    return try {
      when (JSONObject(file.readText()).optString("mode")) {
        MODE_LINUX -> MODE_LINUX
        MODE_TERMUX -> MODE_TERMUX
        else -> if (runtimeInstalled) MODE_LINUX else MODE_TERMUX
      }
    } catch (_: Exception) {
      MODE_TERMUX
    }
  }

  fun runtimeInstalled(linuxEnvironment: File): Boolean =
    File(linuxEnvironment, "runtime/active.json").isFile

  fun resolve(paths: Paths): Result {
    val active = File(paths.runtimeRoot, "active.json")
    if (!active.isFile) return Result.Refused("linux-guest-not-installed", "active.json 不存在")
    val record = try {
      JSONObject(active.readText())
    } catch (error: Exception) {
      return Result.Refused("linux-guest-install-corrupt", "active.json 无法解析：${error.message}")
    }
    if (record.optInt("schemaVersion", -1) != ACTIVE_SCHEMA) {
      return Result.Refused("linux-guest-install-corrupt", "active.json schemaVersion 不是 $ACTIVE_SCHEMA")
    }
    val instanceId = record.optString("instanceId")
    val nodeKey = record.optString("nodeKey")
    if (!SAFE_ID.matches(instanceId) || !SAFE_ID.matches(nodeKey)) {
      return Result.Refused("linux-guest-install-corrupt", "active.json 的实例或 Node 键非法")
    }

    val instance = File(paths.runtimeRoot, "instances/$instanceId")
    val rootfs = File(instance, "rootfs")
    val proot = File(paths.nativeLibraryDir, "libpocketharness_proot.so")
    val loader = File(paths.nativeLibraryDir, "libpocketharness_proot_loader.so")
    val node = File(paths.runtimeRoot, "shared/node/$nodeKey/arm64/bin/node")
    val addonPackage = File(rootfs, "opt/pocket-harness/addons/$ADDON_PACKAGE")
    val addon = File(addonPackage, "bin/glibc/system.node")
    val resolv = File(instance, "proot-tmp/resolv.conf")

    for ((file, code) in listOf(
      rootfs to "linux-guest-install-incomplete",
      proot to "linux-guest-native-missing",
      loader to "linux-guest-native-missing",
      node to "linux-guest-node-missing",
      paths.engineBin to "linux-guest-engine-missing",
      addon to "linux-guest-addon-missing",
    )) {
      if (!file.exists()) return Result.Refused(code, "缺少 ${file.absolutePath}")
    }

    val binds = mutableListOf(
      "-b", "/dev/null", "-b", "/dev/zero", "-b", "/dev/random", "-b", "/dev/urandom",
      "-b", "${instance.absolutePath}/dev-shm:/dev/shm",
      "-b", "${node.absolutePath}:${node.absolutePath}",
      "-b", "${paths.engineUsr.absolutePath}:${paths.engineUsr.absolutePath}",
      "-b", "${addonPackage.absolutePath}:${paths.engineUsr.absolutePath}/lib/node_modules/$ADDON_PACKAGE",
      "-b", "${paths.homeDir.absolutePath}:${paths.homeDir.absolutePath}",
    )
    if (resolv.isFile) binds.addAll(listOf("-b", "${resolv.absolutePath}:/etc/resolv.conf"))

    val argv = mutableListOf(
      proot.absolutePath, "-r", rootfs.absolutePath, "-0",
      "-w", paths.homeDir.absolutePath, "--sysvipc", "--kill-on-exit",
    )
    argv.addAll(binds)
    argv.addAll(
      listOf(
        "/usr/bin/env", "-i",
        "HOME=/root",
        "PATH=$GUEST_PATH",
        "TMPDIR=/tmp",
        "LANG=C.UTF-8",
        // require-builtin 的降级路径需要 V8 内部绑定；Termux 侧同样带这个开关。
        node.absolutePath, "--expose-internals", paths.engineBin.absolutePath, "web",
        "--port", paths.port.toString(), "--no-open",
      ),
    )

    val env = mapOf(
      "PROOT_LOADER" to loader.absolutePath,
      "PROOT_TMP_DIR" to File(instance, "proot-tmp").absolutePath,
      // Android 16/6.6 上 PRoot 的 seccomp 加速器会间歇性 exit 182，客体执行统一关掉它。
      "PROOT_NO_SECCOMP" to "1",
      "LD_LIBRARY_PATH" to paths.nativeLibraryDir.absolutePath,
    )
    return Result.Ready(Launch(argv = argv, env = env, workingDirectory = paths.homeDir))
  }

  private val SAFE_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
}
