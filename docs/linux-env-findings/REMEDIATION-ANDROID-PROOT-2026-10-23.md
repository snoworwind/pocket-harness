# Android PRoot 安装探针修复（2026-10-23）

> 后续 syscall 调查已修正本文对 exit 182 的初步归因：`PROOT_NO_SECCOMP=1` 未降低失败率，详见 [syscall 级调查](PROOT-SYSCALL-EXIT-182-2026-10-23.md)。本文中的 `/bin/bash -c` PATH 修复仍适用；seccomp 绕过不再作为修复。

## 现场复现

用户提供的设备报告记录了 HarmonyOS / Android 16 / Linux 6.6.98 上的安装失败状态：

```text
lastError: "PRoot guest smoke probe failed (exit 182): "
lastErrorCode: "linux-install-failed"
```

报告使用同一 runtime 插件、参数和清理后的 host environment，发现两个可独立复现的问题：

1. 初期单次对照看起来像是 `PROOT_NO_SECCOMP=1` 后可启动 guest；后续重复 100 次和 120 次的 syscall 级实验显示两种模式失败率分别为 9% 与 11%，该变量并未修复 exit 182。
2. 关闭 seccomp 后，健康探针仍会失败为 exit 127：`bash -lc` 读取 Debian `/etc/profile`，将 PATH 重置为 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`；Node 只在绑定的共享 Node 目录中，因而 `node` 不可见。

## 修复

- 0.6.2 曾在 Android runtime 设置 `PROOT_NO_SECCOMP=1`；后续 trace 证明该绕过不是 exit 182 的修复，0.6.3 已撤销此设置。
- 安装健康探针和 `linux_bash` 改用 `/bin/bash -c`。`prootArguments()` 的显式共享 Node PATH 不会再被 login profile 覆写。
- 健康探针失败时，`lastError` 现在记录宿主 cwd、guest cwd、guest 命令、guest/PRoot 环境摘要和 stdout/stderr。输出流各最多记录 4096 字符，防止 profile 噪声无限放大状态文件。
- 0.6.2 曾同步 runtime、bootstrap 与 Linux release manifest 版本，让已有 `0.6.1` 安装能发现当时的离线 runtime；后续 syscall 修复候选升为 `0.6.3`。

## 验证边界

Runtime manager 单测 35/35 通过，覆盖非 login PATH、Android PRoot 环境、exit 127 的双流诊断、exit 182 的空输出诊断及失败时不切换 active runtime。`node scripts/check-vendored-linux-bootstrap.mjs --self-test` 的正控和 4 条负控通过；`node scripts/source-build/check-linux-sources.mjs` 校验 30 个来源文件；`node scripts/check-code-map.mjs` 通过。尝试启动 `plugins/dsh-android-linux-env/test/offline-install-integration.test.mjs` 时因工作树未安装锁文件中的 `tar-stream` 而在 import 阶段中止，因此该跨层测试未验收。源码测试不能证明 Android ROM 的真实 PRoot 行为；0.6.2 来源 APK 和目标 ARM64 设备安装仍待验证。后续 0.6.3 的重试代码也尚未通过本地测试、来源构建或设备复验；在设备复验前不宣称 Linux 安装已恢复。
