# Android Linux 执行入口修复（2026-10-22）

## 现场与边界

新实机证据确认两条独立限制：Android app domain 拒绝直接 `execve()` `filesDir` 中的 ELF；glibc loader 不是 Bionic 可执行文件，`/system/bin/linker64` 无法加载它。Bionilux 在 AArch64 glibc 分支直接执行 rootfs 内 `ld-linux-aarch64.so.1`，因此旧入口无论增加 `LD_LIBRARY_PATH` 或调整 termux-exec 变量都无法成立。

本项目固定 `targetSdk = 34`。降到 28 会改变应用全局执行安全边界，也与项目兼容/安全基线冲突；不采用。给 Debian loader 手工补 `PT_PHDR` 会改写经过验证的 Debian 二进制并仍需设备验证；不采用。实现使用已有的 `BIONILUX_LOADER` 覆盖接口，把与当前 rootfs 同一构建产物的 launcher 和 glibc loader 放在 APK 原生库目录。

硬链接失败是另一项文件系统限制，不是这次 exec 死结的原因。资产解包只对明确的平台拒绝错误，将根内普通文件以独占复制方式落盘并恢复 mode；Bionilux guest 的 `link`/`linkat` 也只在常见平台拒绝错误且源为普通文件时复制。未知 errno、符号链接目标和已存在目标仍失败关闭。该路径不制造硬链接语义或 inode 共享，尚待设备上的 dpkg 场景复验。

这不是完整 Linux 容器语义：Bionilux 不 mount 私有 `/proc`、`/sys`、`/dev`，而把这些路径交给宿主内核；`/proc/self/exe` 由 preload hook 映射回 guest 可见路径。Android app-data 的 `nosuid` 也不会授予真实 root、setuid 或 capabilities；Bionilux 仅模拟 uid/gid 与 chown 行为以满足常见 apt/dpkg 检查。依赖真实特权或隔离 procfs 的程序仍可能不兼容，不能把模拟 root 当作安全边界。

## 源码修复

- Linux 资产来源链从本轮交叉编译生成的 Bionilux executable，以及同一 Debian rootfs 的 `/lib/ld-linux-aarch64.so.1`，产出 `arm64-v8a/libpocketharness_bionilux.so` 与 `libpocketharness_glibc_loader.so`。构建门禁核对 ELF64/AArch64/ET_DYN、launcher 的 `/system/bin/linker64` `PT_INTERP`、loader 没有 `PT_INTERP`、非零 entry point、mode 和体积。
- Gradle 把两个文件作为 `jniLibs` 打包，启用 legacy extraction，使 PackageManager 将它们展开到 `ApplicationInfo.nativeLibraryDir`；保留这两个 ELF 的原始字节。构建结束时读取最终 APK，对照源文件 SHA-256 与大小，发现缺文件、重复成员、符号链接或字节变化就失败。
- 壳侧 `EngineManager.shellEnv()` 将 PackageManager 给出的 `nativeLibraryDir` 作为 `DSH_LINUX_NATIVE_LIBRARY_DIR` 交给 runtime。
- Runtime 分开构造环境：`hostExecutionEnvironment()` 只用于 Termux GNU 工具和 rootfs 准备，继续携带 `LD_PRELOAD` 与 termux-exec 执行代理；`bioniluxExecutionEnvironment()` 直接执行 APK nativeLibraryDir 中的 Bionilux，并将同目录 glibc loader 作为 `BIONILUX_LOADER`，不让 termux-exec 把 launcher 重写到 linker64。Bionilux 从 `current_exe` 得到包管理器安装的 launcher 路径，guest 子进程继续经同一路径重入。
- Android 安装在下载资产前先验证 Termux host 工具环境，再以 `--print-config` 启动 APK 内 launcher。rootfs 完成后，安装流程通过同一 launcher 和 external loader 运行随包 glibc Node `--version`；若 native 启动失败或 guest ELF 映射失败，不提交新的 active runtime。
- Linux manifest、runtime package 与 bootstrap package 的版本号统一提升到 `0.5.3`，方便故障日志、资产和已安装插件对应到同一发布批次；bootstrap 行为未变。
- Rootfs 构建将 `libc6:arm64` 与 `libc-bin:arm64` 标为 apt hold，并把配套版本写入 provenance。Bionilux 使用 APK 内同一批次复制的 glibc loader；guest apt 的常规升级不能单独替换 rootfs glibc。要更新 glibc，必须在同一来源构建中更新 loader 与 rootfs。用户强制绕过 hold 仍可能造成不匹配，runtime 安装时 Node smoke 会拦住启动失败。

## 验证与未决项

- Runtime manager：33/33；覆盖实际环境分流、路径、Termux 变量清理、缺失 native 资产负控、launcher EACCES 负控及下载前失败。
- Linux 资产 PR workflow 新增 ARM64 preload hook 编译和集成用例：通过跨文件系统 `link` 触发复制回退，并确认 symlink 源仍返回失败且不留目标；该用例尚待 GitHub Linux runner 执行，本机 macOS 无法编译这份 Linux hook。
- Copy fallback opens its source with `O_NOFOLLOW` and verifies the opened device/inode still matches the regular file checked before copying; a symlink swap or source replacement fails closed.
- Native ELF checker：`--self-test` 通过，能拒绝给 glibc loader 加入 `PT_INTERP` 的样本。
- APK native payload checker：`--self-test` 覆盖两项资产匹配与篡改负控；来源链还会检查最终 APK 中的实际字节。
- Linux rootfs 构建固定并检查 glibc 包的 hold 状态与同版本关系；`linux-loader-apt-holds.txt` 随构建 provenance 上传。
- **没有设备测试。** APK nativeLibraryDir 的文件标签/执行策略、glibc loader 对 private rootfs Node 的可执行映射、Bionilux 多级 exec、bash/shebang 和 dpkg 硬链接回退，都还需要 ARM64 真实 app 进程实测。源码检查不能证明 Android ROM 的实际 SELinux 与挂载策略已满足假设。
- 构建链运行后还需检查 `mergeReleaseNativeLibs`/APK verifier 的真实结果；成功构建仍不等于 Linux 功能已恢复。目标设备验收前，本轮不得把 Linux 环境描述为可用。

## 后续设备判据

从最终 ARM64 APK 安装后，以真实 app 进程身份记录 `nativeLibraryDir` 的 mount、mode、SELinux label；先跑 native launcher `--print-config`，再安装 Linux 并检查 Node smoke，随后执行 `bash`、Node 启动 shell 和外部 ELF 的多级任务、shebang 以及 dpkg 更新/回滚。失败时保留完整 `lastError`、Bionilux debug 输出、`/proc/self/mountinfo` 与 AVC 证据，不把 API 级成功当作 guest exec 完成。
