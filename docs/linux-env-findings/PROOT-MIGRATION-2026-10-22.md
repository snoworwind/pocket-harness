# Linux 环境迁移到 Termux PRoot（2026-10-22）

## 决定与当前状态

Linux 执行后端由 Bionilux 改为 Termux PRoot。Bionilux 在目标 Android app 域中无法直接执行 Debian glibc loader；改为进程内装载还需要补齐完整的后续 `execve` 链，工程量接近重写 PRoot。本轮不继续维护这条自研 loader 路线。

当前源码版本为 Linux runtime/bootstrap `0.6.2`，PRoot pin 为 `5.1.107.101`（Termux recipe commit `d6a36549b20eadb7723015eb3423e753ea125567`）。APK 资产工厂从 Termux 官方签名仓库取得 ARM64 PRoot 包及依赖，创建 Debian 13 ARM64 rootfs，打包 glibc Node；来源链在资产嵌入前验证仓库签名、签名索引摘要、精确软件包版本与 `.deb` 摘要。APK 内的 PRoot launcher/loader 与依赖逐字节复核。Bionilux launcher、loader、preload 与 Cargo 许可收集器已从活跃源码和资产构建路径删除；bootstrap 包的历史上游来源仍保留为来源记录。

本轮完成的是源码迁移和构建前静态/自动检查。2026-10-23 的第一次 `draft_release=true` 来源 run [39922474317](https://github.com/snoworwind/pocket-harness/actions/runs/39922474317) 在两路 ARM64 builder 的 Linux PRoot 资产组装阶段 fail-closed：官方签名 Termux 索引已提供 PRoot `5.1.107.99`，提交锁仍是 `5.1.107.98`，该次没有产出 APK 或草稿 Release。首次 follow-up 已将 PRoot 锁更新到 `5.1.107.99`；2026-10-26 来源 run [40288221965](https://github.com/snoworwind/pocket-harness/actions/runs/40288221965) 发现 stable 又前进至 `5.1.107.101`。本次修复复核其 recipe 与源码摘要并将锁同步到 `.101`；合并后的草稿来源构建结果待补记。**目标 ROM 的 Android 设备验收仍未完成**，不能据 CI 构建证明 PRoot 能在 app 域启动、guest glibc、apt 和多级 `execve`。

2026-10-22 的用户安装报告显示，原生 PRoot 可正常启动并以 exit 0 输出版本横幅，但安装探针只接受字面串 `PRoot v<version>`，误拒 Termux 横幅。源码现已按 manifest 版本 token 校验两种横幅格式，并增加零退出但版本不匹配的负控；宿主测试通过，尚未以新 APK 在设备复验。实现与复验详见 [坑 496](../AGENTS/gotchas.md)。

## 运行边界

- PRoot 通过 `ptrace` 翻译 guest 文件路径和进程视图；`-0` 只是 guest 内的 root 身份，不授予 Android root、mount 权限或内核隔离。runtime 以壳侧显式注入的 `DSH_LINUX_NATIVE_LIBRARY_DIR` 选择 APK 安装目录中的 launcher/loader；`ANDROID_ROOT` 仅作 Android 环境的辅助标记，不是选择原生执行路径的唯一条件。
- guest 程序仍以 Pocket Harness 的 Android UID 运行，继续受 SELinux、seccomp、文件权限及 mount flags（包括 `noexec`/`nosuid`）约束。Linux 环境**不是安全沙箱**；`linux_bash` 运行的代码可能接触 app UID 在 Android 上本来可访问的资源。工作区/共享目录 allowlist 只控制 runtime 显式绑定的 cwd，不是对同 UID 进程的强制隔离。
- guest `/proc` 不绑定 Android 宿主 procfs，避免 guest 通过 `/proc/<pid>/root`、`environ` 或 `fd` 访问宿主进程元数据和 app 私有路径；依赖 guest `/proc` 的工具可能不完整。PRoot 自己仍使用宿主 procfs 翻译被跟踪进程的文件描述符操作，这不等于 guest 能看到宿主 `/proc`。runtime 只绑定 `/dev/null`、`zero`、`random`、`urandom`、app 私有 `/dev/shm`、共享 Node、当前 resolver 和已配置工作区/共享目录；不绑定宿主 `/sys` 或整个 app data 根目录。
- `nosuid` 不会因 PRoot 的 fake-root 消失：guest setuid 位不授予真实特权，依赖真实 mount、`mount/unshare/setuid`、systemd 或特定内核接口的程序可能失败。guest `/proc` 目录保留为空挂载点；PRoot 的宿主 syscall 翻译仍使用 Android 的 procfs。
- DNS 文件不保留构建机 resolver；每次命令将当前 Android 默认网络的 resolver 绑定至 guest `/etc/resolv.conf`。无安全可用 resolver 时绑定空配置，避免沿用旧网络地址。Android Private DNS 活跃时当前实现 fail-closed，guest 暂无外网 DNS。

## 文件系统兼容和剩余风险

TermFold 派生的 glibc preload 只在内核拒绝普通文件 `link(2)`/`linkat(2)` 时，尝试复制普通文件。副本先写入目标同目录的隐藏临时文件，完成源稳定性、权限、时间戳检查并 `fsync` 后，使用 `renameat2(RENAME_NOREPLACE)` 原子发布；因此复制失败或进程被杀不会暴露半写的目标。进程被强制终止时可能留下 `.pocket-harness-link-*` 临时文件，消耗存储但不占用目标名称；每次复制最多 1 GiB，实际 Guest 设备仍需检查空间与重试行为。副本是独立 inode：`st_nlink` 为 1、后续写入不共享，重复数据消耗额外空间。它不是硬链接仿真；dpkg/npm/git 等软件可能依赖硬链接的空间或更新语义，仍须设备和真实包管理器验收。

`dlopen("/proc/self/fd/N")` fallback 同样限制为 1 GiB，并拒绝非普通文件和复制期间变化的源。它从被跟踪进程已有的文件描述符读取并临时复制 guest 文件，不依赖绑定宿主 procfs；磁盘空间不足时按失败处理。

构建重试会删除生成的 rootfs。现在通过读取 `/proc/self/mountinfo` 检查 rootfs 本身及任意深度子挂载，并在 mountinfo 不可读或格式异常时拒绝删除；避免只检查 `/dev` 和 `/proc` 而漏掉 `/sys` 或其他残留挂载。

## 来源与许可证

| 部件 | 来源/版本 | 许可证与随包材料 |
|---|---|---|
| PRoot ARM64 可执行文件、loader、依赖 | Termux 官方签名仓库；PRoot 5.1.107.101，recipe commit `d6a36549b20eadb7723015eb3423e753ea125567`，依赖版本见 `scripts/source-build/linux-backend-packages.json` | PRoot GPL-2.0；libtalloc LGPL-3.0-or-later；libandroid-shmem BSD-3-Clause；保存各包 copyright 和适用许可证全文 |
| rootfs | Debian Trixie 固定 snapshot、签名 InRelease 摘要锁定 | 保留 dpkg 包版本/源版本、deb 摘要和版权材料 |
| glibc Node | Node.js 24.22.0 ARM64 官方归档、SHA-256 锁定 | Node LICENSE 与第三方 notices |
| 兼容 preload | TermFold commit `a9f678d794a9f9942da923161d6fe996b89b935f` 的 Apache-2.0 源码改编 | 源文件、完整 Apache-2.0 许可证、来源 commit/hash 与适配说明 |

`linux-source-manifest.json` 锁住仓内 runtime、PRoot 适配源码和 bootstrap 实际打包输入；外部 PRoot/依赖按 signed repo provenance 与源归档 SHA 记录。来源构建另外核验 APK 中 native libraries 与许可证文件和输入逐字节一致。发行前仍需跑完整许可证门禁和 APK 资产核验。

复现边界（2026-10-23 更新）：PR #102 曾把 Termux `InRelease` 摘要放进仓内输入锁，后续官方 `stable` 发布使两次来源 CI 在官方签名有效后仍被旧摘要拒绝（见 `docs/AGENTS/gotchas.md` 坑 506）。当前设计不把滚动 InRelease 当提交级输入：每轮由固定 bootstrap keyring 验签，校验其 `Packages.gz` 摘要/字节数及每个 `.deb` 摘要，并将摘要、包版本与哈希写入 provenance；APK 来源 workflow 将这一轮的已验证包闭包上传一次，两路 ARM64 builder 共用同一个 run/attempt artifact。PRoot、libandroid-shmem、libtalloc 的 recipe 仍固定到审核过的 `termux-packages` commit 并校验文件 SHA-256。此方案避免仓库正常发布导致旧摘要锁失败，并保证一次双构建使用相同 Termux 输入；跨时间重建仍取决于 Termux 是否保留包，尚无仓内不可变包归档。

## 本轮可本机提前验证的项目

- runtime manager 和 release manifest 的 Node 单测：涵盖 PRoot 资产/版本、Android 原生库选择、宿主 `/proc` 不暴露、DNS 绑定、cwd allowlist、失败不提交等。
- Python 负控：Termux 签名仓库与 `.deb` provenance、rootfs 准备、PRoot ELF 组装、rootfs 清理挂载点检查、APK 成员/摘要/许可证篡改。
- Linux CI 编译 ARM64 preload，执行 PRoot 组件测试和来源清单自检。
- APK 来源链后续还需验证实际包装、签名与双构建；ARM64 设备还需验证 app 域启动、proc、DNS、bash/Node、多级子进程、apt/dpkg 与空间行为。

不允许把宿主单测、静态 ELF 检查或 APK 构建结果写成设备健康证明。
