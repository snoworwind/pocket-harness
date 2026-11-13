# 0.16.0 双 ABI 候选验证记录

候选源码：`26b924a71a7184f2f688157d7c8c8ecf5c10dc99`（PR #320 的 merge commit；PR #319 的 `dd5d1981` 含运行时实现）。本记录不构成公开发布或设备验收通过。

## 代码与 CI

- PR #319 最终 head：`629506a065c19149f0d64ac01010947d0a8d2781`。
- PR Gate run `43396026683`：静态门禁、完整 Kotlin 编译/单测、文档与安全扫描通过；Linux 资产验证 run `43396026673` 通过。
- macOS 本地：Node 24.21.0 全套 363 项，329 通过、34 按条件跳过、0 失败；Python 3.13 的 source-build 132 项，22 项按平台/依赖条件跳过；Kotlin 1506 用例及数量/新鲜度门禁通过，SKIP=0。
- Linux CI 实际编译并调用生产 JNI，`test_actual_jni_reads_aligned_blocks_and_rejects_unsupported_descriptors` 通过；覆盖对齐读取、截断、篡改与不支持直接 IO 的文件描述符。该测试不替代 Android/FUSE/SAF 设备证据。
- 本地证据：`.deploy-tmp/dual-abi-20261113/evidence.json`、同目录测试日志和 `pr-static.log`。macOS 完整 local-gate 受 Bash 3/GNU tar 与不可用 Docker daemon 限制，最终完整门禁以以上 Linux CI 为准。

## 来源构建与签名

首次 `release-source-draft.yml` run `43396861701` 的目标为 `dd5d1981`，固定 `abi=all`、`reference=true`；引擎基础双副本构建与比对通过，但 x86_64 两路在源码预检遇到 ARM64 测试夹具继承 `DSH_ABI` 的问题，不能计为来源构建通过。PR #320 已修复并经 CI run `43399474366` 全部必检验证；待新的 main 来源链结果。修复后启动单副本 x86_64 开发来源 run `43401048477`（`reference=false`，不生产签名），复用已比对基础并验证真实 x86 资产路径。尚无本候选生产 APK 或草稿通过结论。

## 设备

实际查询发现 `emulator-5554`，`ro.product.cpu.abilist=arm64-v8a`。交接时旧包首启失败，不能计入本候选证据。最终 ARM64 APK 尚待安装与验证；未查询到 x86_64 设备，不得在 ARM64 AVD 上替代验收。

CDP、ADB、ARM64 真机、x86_64 设备、首次展开体积/耗时、迁移磁盘峰值与真实 SAF/FUSE 导出负控均未完成。本候选保持未验收，不公开发布。


## 集中补充修复的本地证据

x86 开发 run `43401048477` 在独立的原生 APK self-test 发现第二处环境耦合。按用户要求，随后暂停新 CI，集中复核从源码包到签名收据的 ABI 链：修复双 ABI 原生 APK 自检、addon 源码清单和构建收据身份、目标 glibc loader 白名单、引擎装配的 addon 身份及最终 APK 对后端来源 ABI 的绑定。

本地直接提取 `build-apk-source.yml` 的完整 “Verify pinned source replacement before the expensive build” 命令块，在 `DSH_ABI=arm64` 和 `DSH_ABI=x86_64` 两种环境逐一执行通过（包含独立 self-test，而非只运行单测文件）。Python 137 项通过（22 项按平台/依赖条件跳过）；Node 全套 364 项，330 通过、34 按条件跳过、0 失败。相关包身份、异架构 loader、错后端收据及 ZIP 篡改/符号链接/压缩模式均有负控。Node arm64/x64 固定 SHA-256 和 Canvas x64 integrity 已与官方固定版本元数据核对。日志位于 `/tmp/pocket-arm64-full-preflight.log`、`/tmp/pocket-x86_64-full-preflight.log` 和 `/tmp/pocket-batch-node-tests.log`，后续随候选证据落盘。

以上是代码/本地证据，未代表最终 APK、生产签名或设备验收通过。


## Debootstrap 第二阶段调查

旧 ARM64 作业从 09:16:59 UTC 的 Unpacking the base system 到 09:48:34 取消，未输出进展；不能写作构建通过。源码核对后，本地在 debootstrap 1.0.134ubuntu2/QEMU 8.2.2 下用固定 snapshot 的同一 56,162,922 字节 Packages，原版 STANZAS 解析耗时宿主 0.43 秒、QEMU ARM64 45.91 秒，两份输出 SHA-256 完全一致。该微基准证明仿真解析开销，不单独证明 CI 的全部停顿原因。

使用官方宿主 --second-stage-target 接口，本地最小 ARM64 rootfs 第二阶段 14.9 秒成功，dpkg 架构 arm64、dpkg --audit 无错误；原始 InRelease SHA-256 为源码固定的 0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675。第一阶段按相同签名快照取件/逐 deb 校验，第二阶段断网执行。本地环境为 ARM64 Mac 上的 amd64 Linux 用户环境，目标包执行环境不等同于 GitHub x86 主机上的 QEMU；完整工具集仍须来源链验证。

来源链改用 run-linux-bootstrap.py 在宿主编排，保留目标 chroot 包操作；每 30 秒输出内部日志，15 分钟上限，失败/超时/取消都不打包并清理目标进程组。证据路径：.deploy-tmp/dual-abi-20261113/debootstrap-investigation/。


本地 Linux 门禁补充：`809d927a605d` 的完整静态/脚本/插件门禁 24/24 通过，证据 `.deploy-tmp/local-gate/6e93508065d7.json` 与同名 `.log`（本轮刻意不重跑 Kotlin，输入未变，沿用 PR #321 已通过证据）。随后对“父进程失败但仍有后代”的清理作追加修正，并在 Linux 单独执行全部 7 条 bootstrap 自检通过，日志 `/tmp/pocket-bootstrap-linux-selftest.log`。未把本地最小 rootfs 或这些门禁写作最终 APK/设备通过。
