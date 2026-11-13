# Pocket Harness v0.16.0

> 2026-11-13 正式版（versionCode 60），引擎仍为 DeepSeek Harness `0.2.2-rc.1`。
> 本版把运行时从 Termux 快照整体切换为**内置 Debian/glibc 客体**：APK 直接携带 `rootfs`、`node`、`engine`、`home` 四件套与实例清单，宿主 PRoot/loader/talloc/shmem 与原生终端从固定源码构建。
> 来源链改为 main 上的 ARM64 Linux 构建；双副本独立比对通过后由隔离作业以生产证书签名，再创建 ARM64 draft prerelease。

## 安装与升级

- 单 ABI：`pocket-harness-v0.16.0-source-arm64.apk`；Android 16（API 36）ARM64 设备/AVD。
- 应用版本 0.16.0（versionCode 60）；生产证书签名，可从 0.15.x 覆盖升级并保留应用数据。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖 APK、`provenance.zip` 与 `notes.md`）。
- 旧 Termux 快照实例不再作为产品输入；升级由 Linux 实例事务装配并保留用户 apt 软件与 home。

## 更新内容

- **运行时**：内置 Debian 13 aarch64 rootfs + 官方 Node + 源码构建的 Harness engine + 工厂 home；四件套经 `assets/linux/manifest.json` 绑定压缩摘要与受管树摘要。
- **宿主**：PRoot、静态 loader、talloc、android-shmem 与原生终端均从固定源码/固定 NDK 构建；不再下载 Termux bootstrap 或滚动 `.deb`。
- **引擎来源**：固定 Harness 源码底座按内容键复用/双副本构建；第一方包从源码导出，第三方补丁目标从固定 registry 校验 sha512 后拉取；引擎补丁在构建期施加并独立重放核对。
- **Bash 与工具面**：`dsh-shell-linux` / `LinuxBashExecutor` 与模型工具 `android_linux_channel_exec` 使用 Debian 客体路径；旧工厂 shell 条目仅迁移已知 id/包名组合，用户配置保留。
- **CI 与签名**：build-base 只接受 main；来源链只接受 main + ARM64；构建副本用一次性证书，`verify-abi` 双副本比对后才由 `sign-abi` 用生产 keystore 重签；`release-source-draft` 校验证据与生产指纹后创建 ARM64 draft prerelease。
- **许可**：按本轮 Debian/Node/Harness 实际来源收据生成第三方通知；宿主原生库许可证随 APK 分发。

## 已知限制

- 本版只提供 ARM64；x86_64 仅保留本地开发 QA，不进入发布。
- 生产签名依赖仓库 secrets；draft prerelease 需人工复核设备证据后再公开。
- 设备验收状态：见下方验证范围；未执行层不得记为通过。

## 验证范围

- 来源构建：main 上 `reference=true` 的双副本独立比对通过后才允许签名；APK 通过 v1/v2/v3 与生产证书指纹校验，证据经 verifier 与 signer 两个 artifact 边界保存。
- 设备：本版发布前需按 AGENTS.md §2.1 在 Android 16 ARM64 AVD 完成安装与运行验证；结论与截图在发布记录中补充。未执行层按未验收记录。
- 门禁：PR Gate 静态/单测/Kotlin 编译全绿；Linux 契约、原生 loader 审计、载荷负控与发布准备负控均实际执行。
