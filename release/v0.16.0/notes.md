# Pocket Harness v0.16.0

> 2026-11-13 正式版（versionCode 60），引擎仍为 DeepSeek Harness `0.2.2-rc.1`。
> 本版把运行时从 Termux 快照整体切换为**内置 Debian/glibc 客体**：APK 直接携带 `rootfs`、`node`、`engine`、`home` 四件套与实例清单，宿主 PRoot/loader/talloc/shmem 与原生终端从固定源码构建。
> 来源链改为 main 上的 ARM64 与 x86_64 Linux 构建；双副本独立比对通过后由隔离作业以生产证书签名，再创建双 ABI draft prerelease。

## 安装与升级

- 按设备 ABI 选择 `pocket-harness-v0.16.0-source-arm64.apk` 或 `pocket-harness-v0.16.0-source-x86_64.apk`；Android 16（API 36）对应 ABI 设备/AVD。
- 应用版本 0.16.0（versionCode 60）；生产证书签名，可从 0.15.x 覆盖升级并保留应用数据。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖 APK、`provenance.zip` 与 `notes.md`）。
- 旧 Termux 快照实例不再作为产品输入；升级由 Linux 实例事务装配并保留 home；旧 Termux 软件需要在 Debian 内重装，后续 Linux 实例升级保留用户 apt 软件。

## 升级须知

- 首启会解包 Linux 实例，请保持前台并预留充足空间。审计中的旧 ARM64 样本解包约 2.89 GB（建议至少约 3 GB 可用），旧 `usr` 约 1.1 GB、整份 home 备份约 2.0 GB 时迁移峰值约 6 GB；这些是裁剪及缩小备份范围前的样本，当前双 ABI 最终包的实际占用与峰值尚待实测，用户数据会增加空间需求。
- 旧 `~/.dsh/opt` 下基于 Android/Bionic 的工具（如 gh、aapt2、qemu）不能在 glibc 客体中执行，请在 Debian 内重新安装相应 Linux 版本。
- 用户自装插件若含 Android/Bionic `.node` 模块，需要为目标 Linux ABI 重新安装或编译；保留插件目录不代表原生模块兼容。
- `~/.agents/AGENTS.md` 属于用户资产，不会被覆盖。请人工移除旧 `$PREFIX`、linker64、Termux `/tmp` 等前提，并按 Debian 路径更新；出厂指令与用户指令的归属见仓库持久化说明。
- 数据导出先在私有目录暂存并校验，再同步写入目标并以 `O_DIRECT` 回读；不支持直接读取的文档提供方会报失败并尝试删除半成品。请使用支持此能力的本地存储提供方。

## 更新内容

- **运行时**：内置 Debian 13 arm64/amd64 rootfs + 官方 Node + 源码构建的 Harness engine + 工厂 home；四件套经 `assets/linux/manifest.json` 绑定压缩摘要与受管树摘要。
- **宿主**：PRoot、静态 loader、talloc、android-shmem 与原生终端均从固定源码/固定 NDK 构建；不再下载 Termux bootstrap 或滚动 `.deb`。
- **引擎来源**：固定 Harness 源码底座按内容键复用/双副本构建；第一方包从源码导出，第三方补丁目标从固定 registry 校验 sha512 后拉取；引擎补丁在构建期施加并独立重放核对。
- **Bash 与工具面**：`dsh-shell-linux` / `LinuxBashExecutor` 与模型工具 `android_linux_channel_exec` 使用 Debian 客体路径；旧工厂 shell 条目仅迁移已知 id/包名组合，用户配置保留。
- **CI 与签名**：build-base 只接受 main；来源链只接受 main + 对应 ABI；构建副本用一次性证书，`verify-abi` 双副本比对后才由 `sign-abi` 用生产 keystore 重签；`release-source-draft` 校验证据与生产指纹后创建双 ABI draft prerelease。
- **许可**：按本轮 Debian/Node/Harness 实际来源收据生成第三方通知；宿主原生库许可证随 APK 分发。

## 已知限制

- 双 ABI 来源构建及最终设备验收尚待当前候选完成；支持范围不等于设备验收通过。
- 生产签名依赖仓库 secrets；draft prerelease 需人工复核设备证据后再公开。
- 设备验收状态：见下方验证范围；未执行层不得记为通过。

## 验证范围

- 来源构建：main 上 `reference=true` 的双副本独立比对通过后才允许签名；APK 通过 v1/v2/v3 与生产证书指纹校验，证据经 verifier 与 signer 两个 artifact 边界保存。
- 设备：本版发布前需按 AGENTS.md §2.1 在 Android 16 ARM64 AVD 完成安装与运行验证；结论与截图在发布记录中补充。未执行层按未验收记录。
- 门禁：当前候选的本地测试与 CI 结论须随最终提交更新；不得复用上一候选的全绿结论。
