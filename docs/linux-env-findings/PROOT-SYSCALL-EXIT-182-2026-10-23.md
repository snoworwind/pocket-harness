# PRoot guest loader 偶发 exit 182：syscall 级调查

> 2026-10-23 后续设备调查。它取代了 [0.6.2 修复记录](REMEDIATION-ANDROID-PROOT-2026-10-23.md) 中把 exit 182 归因于 seccomp 加速路径的结论；`/bin/bash -c` 对共享 Node PATH 的修复仍然有效。设备原始 trace 和重复实验由用户提供，本记录不声称独立复现。

## 设备现象

失败稳定落在 guest 启动器对 glibc `ld-linux-aarch64.so.1` 的固定地址 `mmap`：

```text
addr=0x5900000000 len=0x28000 prot=5 flags=0x12(MAP_PRIVATE|MAP_FIXED) fd=3 offset=0
success: 0x5900000000
failure: 0xfffffffffffffff2 (-14 / -EFAULT)
```

用户对成功/失败两次 `proot -v 9` syscall 日志归一化后确认，此调用前日志逐条一致，调用参数也一致；失败返回恒为 `-14`。用户对照的 `mmap(2)` 错误集没有 `EFAULT`，所以该返回值不符合内核 mmap 的错误结果，证据指向 PRoot 转发层自行合成的错误。

跨 guest（Node、`true`、`sh`、Android toybox）、rootfs（含 `-r /`）、cwd、`PROOT_TMP_DIR`、并发以及 `-v 9` 慢速日志重复实验都仍见约 5–16% 失败。设 `PROOT_NO_SECCOMP=1` 的实测是 11%，未设置是 9%；这个变量没有降低失败率。失败序号散布，不随并发或日志减速聚簇。因此 0.6.2 曾采用的 seccomp 绕过不是 exit 182 的修复。

## 已知与未确认的部分

- 已知：失败发生在同一 loader `mmap`，固定返回 `-EFAULT`；失败前调用序列与参数相同。
- 结论：`-EFAULT` 不是这次 mmap 可接受的内核错误结果，来源位于 PRoot syscall 转发路径。
- 未确认：PRoot 源码中具体哪一行产生该值。设备上的 native PRoot 库已 strip，只有动态符号；loader 是 0x468 字节无符号 blob，设备没有 PRoot 源码。ptrace stop、地址空间切换与 tracee 内存访问状态错位是待验证假说，不是本轮已证事实。

## 当前修复

Linux runtime `0.6.3` 在安装阶段的 guest `node --version` 健康探针上，仅对以下完整条件重试：

```text
exitCode === 182 && stdout === "" && stderr === "" && !timedOut
```

总启动次数上限为三次（首次加两次重试）。超时、其他退出码、输出流任一非空、Node 版本格式不符均按原样立即失败；最终失败仍阻止 active runtime 交换。`linux_bash` 的普通命令不重试。PRoot 环境不再设置 `PROOT_NO_SECCOMP=1`。`/bin/bash -c` 保留在安装探针和 `linux_bash` 中，以防 Debian login profile 覆写共享 Node PATH；这是针对 exit 127 的独立修复。

用户在目标设备上做了 30 轮「最多三次」重试实验，全部成功，最差在第三次成功。这支持有限重试的可用性，但不证明 PRoot 根因已被底层修复，也不替代 0.6.3 APK 验收。

## 验证边界

本轮源码改动尚未运行单测、来源构建或设备套件；0.6.3 APK 与 ARM64 设备安装验证待完成。达到发版候选前，须按项目协议重新构建最终来源 APK 并完成对应验收。
