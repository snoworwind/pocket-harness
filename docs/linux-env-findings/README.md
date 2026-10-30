# DSH Linux 环境调查 · 文档索引

> runtime/bootstrap `0.6.2` 已包含在 0.14.9 来源提交 `625fd8e0311d`；来源构建、独立 APK 核验和签名由 run [40473155658](https://github.com/snoworwind/pocket-harness/actions/runs/40473155658) 通过并发布。PRoot 安装和工具执行仍未完成 ARM64 设备端到端验收，不能据构建成功宣称 Linux 可用。此前 0.6.1 的 `/dev/shm` 修复与草稿构建 run [39899439859](https://github.com/snoworwind/pocket-harness/actions/runs/39899439859) 是历史状态。0.6.2 的缺陷与源码修复见[修复记录](REMEDIATION-ANDROID-PROOT-2026-10-23.md)；当前架构、安全限制、来源与验收边界见[PRoot 迁移记录](PROOT-MIGRATION-2026-10-22.md)。

## 当前结论

1. **实现路线已更换，功能仍待验收。** Termux 官方签名仓库提供的 ARM64 PRoot 包与锁定依赖用于运行 Debian/glibc rootfs；当前 0.14.9 来源 APK 已包含 runtime/bootstrap 0.6.2。Android app 域中的 PRoot 执行入口、guest ELF、DNS、apt/dpkg 和多级子进程仍需 ARM64 设备证据。
2. **PRoot 不是安全沙箱。** guest 程序仍按应用 UID 执行；`-0` 不会授予 Android root。宿主 `/proc` 不映射给 guest，以减少进程元数据和 app 私有路径暴露；工作区路径 allowlist 仍不是同 UID 强制隔离。
3. **硬链接降级有明确代价。** 被 Android 拒绝的普通文件硬链接最多复制 1 GiB；副本不共享 inode、会多占空间，也可能与依赖硬链接的安装/更新语义不同，必须用真实 dpkg 场景验证。

## 阅读顺序

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 1 | [PROOT-MIGRATION-2026-10-22.md](PROOT-MIGRATION-2026-10-22.md) | 当前后端、Android 权限边界、proc/DNS/文件系统策略、来源和许可证 | 当前实现；APK/设备待验 |
| 2 | [REMEDIATION-ANDROID-PROOT-2026-10-23.md](REMEDIATION-ANDROID-PROOT-2026-10-23.md) | Android PRoot seccomp 与 Debian login PATH 导致的 Linux 安装失败 | 源码候选已修；设备复验待做 |
| 3 | [ORIGINAL-REPORT-2026-10-19.md](ORIGINAL-REPORT-2026-10-19.md) | 实机 agent 原始报告 | 历史证据；部分归因已被后续修正 |
| 4 | [INVESTIGATION-2026-10-19-pocketharness.md](INVESTIGATION-2026-10-19-pocketharness.md) | Bionilux 阶段的源码复核和实机调查 | 历史调查 |
| 5 | [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md) | Bionilux 旧路线的实机结论、保留决策 | 历史记录；路线已被 PRoot 迁移取代 |
| 6 | [REMEDIATION-ANDROID-EXEC-2026-10-22.md](REMEDIATION-ANDROID-EXEC-2026-10-22.md) | Bionilux 原生 loader 方案和后续证据 | 历史方案；不代表当前 PRoot 路线 |
| 7 | [REMEDIATION-HOST-TOOLS-DNS-2026-10-22.md](REMEDIATION-HOST-TOOLS-DNS-2026-10-22.md) | Bionilux 阶段 GNU 工具识别与 Android DNS 接线 | 历史实现记录；DNS 约束由 PRoot 迁移记录重新描述 |

其余 `ORIGINAL-*`、`REMEDIATION-*`、`RECOVERY-PROPOSAL-*` 文档保留原始问题与当时方案，不能当作当前后端实现说明。
