# Linux 插件迁移（开发中）

基线：9793fbb2，开发分支 codex/downloadable-linux-runtime。历史现场由本地 codex/preserve-linux-9779dbb5 保留。用户已有 docs/harmonyos/ 与 dsh-shell-linux/ 未纳入本次修改。

Termux 引擎、快照启动链不变。可下载 payload 由本仓源码构建，未引入上游预构建 0.6.2 runtime。Android PRoot/native 仍由 APK 携带，其余归档显式安装时下载；可信 manifest 来自签名 APK。冷启动只恢复已安装且明确启用的 runtime，并重新验包；移除不复活，失败只停 Linux。linux_environment_status 在 runtime 未就绪时也可查询。

健康判据为 getconf + Node + /bin/true/嵌套 bash/yes 管道/PTY 与真实 child_process 执行；安装前执行，失败保留 exit 和双流诊断到 linux-trial-failed.log，可由分享诊断包导出。proot-env 仅接受两个 PROOT_POCKET_* 的 0/1 开关；不自动打开 workaround。

本地已运行 runtime 管理器与 Linux 插件回归、source builder self-test、rootfs 打包反证、vendored/bootstrap 来源门禁、工具预算与执行地图检查。实际命令与最终结果在收口时更新；尚未完成的门禁不计 PASS。

未执行最终来源 APK 构建、CDP、ADB 与 SGT-AL10 三条设备判据。PRoot patch 已在锁定原始源码完整回放，但不等于设备 EFAULT 已解决。公开发布前需最终产物及设备证据；下载归档必须与 manifest 的固定版本 URL 同步上传。

工具预算评审：`linux_environment_status` 必须在 Linux 缺席、安装失败和激活失败时可见，因此不放入 runtime 的动态注册，也不以 phone/browser/virtual-display 掩蔽。它只输出 phase/reason，不具备执行或权限能力。通过缩短既有工具说明抵消大部分 wire 成本；更新基线记录这一个明确需求的新常驻工具。

下载发布约定见 `docs/AGENTS/build-and-env.md` 的“可下载 Linux 插件来源链”。对应自动发布工作流与校验 helper 已落代码，尚未触发真实公开发布；草稿阶段匿名安装仍不可用，不得记下载链 PASS。

定向验证（macOS，源码工作区）：Linux 插件 91/91，runtime manager 40/40，PRoot source builder self-test 12/12（含编译执行的 EFAULT 限次重试正反控），backend receipt 4/4，第三方许可 13/13，Linux workflow/base-lock 12/12。发布准备 13 项中 11 通过、2 个 Linux 专属用例在 macOS 跳过；rootfs/原生完整回归的 Linux 专属用例交由 Linux 门禁，未把 skip 当通过。工具 wire 新基线 18718 B，初始可见 3068 B。完整门禁以 [PR #333 的最终检查](https://github.com/snoworwind/pocket-harness/pull/333/checks)为准，未完成检查不计通过。

DeepSeek 评审处置：发布 URL 由正式来源 Release 的 published 事件闭合；草稿白名单/上传同步包含 payload；restore 增加 restoredThisLoad 守卫且强制只用 retained archive；IO 再核 signed manifest 成员、手动限制 CDN 重定向并预检空间；/dev 清理扩展至所有非目录非链接；NDK 两条 workflow 共享摘要缓存，每次仍验 738633529 字节、SHA-256 与 Google 元数据 SHA-1；常驻状态工具增加 enum/ready/engine 与系统指引；阈值来自 manifest（当前树无 Kotlin 同名判定）；健康检查合为一次客体启动，使用实际共享 Node 绝对路径；删除 seccomp 导致 182 的错误归因；loader 限次重试已有编译执行反证。最终 APK/CDP/ADB 与 SGT-AL10 任务仍未执行。

NDK pin 核对：Google `https://dl.google.com/android/repository/repository2-3.xml` 的 `ndk;30.0.16248370` 给出 Linux 归档 size/SHA-1；本轮下载同一官方归档，先核原 pin/size，再计算 SHA-256 `753611f410d002cfcd3f3dc2ef49aad532089d3180b436c060a90bf0fcb64df2`，写入 linux-inputs.json。缓存命中不免验证。

冷启动恢复还会调用 manager.verify，在无下载的前提下重新执行客体健康脚本；真实 Cordis 集成回归覆盖恢复后工具重新出现与再次卸载，不以文件存在替代该次执行验证。

真实 ARM64 原生构建已通过：Linux/amd64 验证容器 + 已验 size/SHA-1/SHA-256 的官方 NDK r30，talloc configure/build、shmem 与 PRoot build 全通过，loader 与四件闭包通过 ELF 校验。receipt 与命令结论在 `.deploy-tmp/linux-plugin-0153-20261114/`；这不是 APK 构建或设备验收。

五小时后检查发现来源草稿 run 43475958074 失败：x86_64 已完成双构建、实际 APK 比对与签名；ARM64 在所有原生/rootfs/Node 前置验证后因 provenance CLI 路径传错而中断，未产生双 ABI 草稿。修正调用为 JSON 文件，并以构建脚本的原始命令执行正控/目录负控；修复前回归失败、修复后通过。重建将直接触发 release-source-draft.yml；实际草稿结论以随后 run 为准。
