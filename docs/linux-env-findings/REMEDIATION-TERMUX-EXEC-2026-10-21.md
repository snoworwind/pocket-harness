# Linux termux-exec 宿主环境修复记录（2026-10-21）

## 最新现场

按用户提供的第二份安装日志与复现矩阵：上一轮新版 APK 已把 `LD_LIBRARY_PATH` 加入 Linux runtime 的宿主命令环境，但安装仍在 `prepare-rootfs.sh` 第 62 行执行 `find` 时收到 `Permission denied`。报告同时显示资产摘要均变化、离线安装确实载入了新包，但 Linux release 与插件版本仍是 `0.5.0`。

复现矩阵区分了真正修复与假成功：

| 子进程环境 | 观测 |
|---|---|
| `PATH` + `LD_LIBRARY_PATH` | 126 / `Permission denied` |
| 只增加 `TERMUX_APP__DATA_DIR` | exit 0，但 `find --version` 是 toybox |
| shim 三项 + `TERMUX__PREFIX`，无 `TERMUX_APP__DATA_DIR` | 126 |
| 完整 shim 变量 + `TERMUX__PREFIX` + `TERMUX_APP__DATA_DIR` | GNU findutils 4.11.0，成功 |

这轮结论依据的是用户提供的日志摘要与实测矩阵；本记录不声称重新连接设备复现。

## 源码根因

壳侧 `EngineManager.shellEnv()` 已注入 termux-exec 所需的 `LD_PRELOAD`、`TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`、`TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1`、`TERMUX__PREFIX` 与 `TERMUX_APP__DATA_DIR`。但 `vendor/dsh-linux-runtime/modules/manager.js` 的 `cleanHostEnvironment()` 为每次 spawn 创建窄白名单，仅手动补了 `LD_LIBRARY_PATH`，上述执行代理变量全部丢失。于是 Termux shell/ELF 的 app-private `execve` 重写不可用，原生错误被 shell 报成 EACCES。

另有一个必须挡住的误报：只有 `TERMUX_APP__DATA_DIR` 时，系统 shell 可能继续并回退到 toybox；rootfs 准备脚本 exit 0 并不证明调用了预期 GNU 工具。Bionilux 原先也未把这轮新增的 Termux 元数据和 `TERMUX_EXEC__*` 加入 guest 泄漏清单；shebang 环境 overrides 在原有过滤之后应用，也可能重新带入这些宿主变量。

## 本轮修复

1. runtime manager 用统一的 `hostExecutionEnvironment()` 为 rootfs 准备、安装探测和 `linux_bash` launcher 生成宿主环境。Android 下只从绝对 `DSH_FILES_DIR` 推导 `usr`、`usr/lib`、preload 文件、`TERMUX__ROOTFS`、`TERMUX__PREFIX`、`TERMUX_APP__DATA_DIR` 与 PATH；不沿用继承值。缺文件、路径不一致或目录无效时失败关闭。
2. rootfs 准备前通过同一执行环境运行 `find --version`、`sed --version`、`wc --version`，逐项要求 GNU findutils/GNU sed/GNU coreutils 的版本签名。toybox 即使 exit 0 也会以稳定码 `linux-host-toolchain-unavailable` 被拒绝。
3. Bionilux guest 环境过滤新增 Termux app 路径、rootfs/prefix 与 exec 拦截变量；shebang overrides 应用后再执行一次宿主变量清除。`LD_PRELOAD` 内已有的 termux-exec shim 仍会按原逻辑过滤，不进入 glibc guest。
4. Linux 失败文案改为指向应用私有目录 `files/linux-environment/linux-bootstrap-state.json` 的 `lastError`，不再让用户检查不含 Linux bootstrap 记录的 `engine.log`。原始错误继续保存在 bootstrap 状态文件，没有追加到 `engine.log`。
5. Linux release、runtime package 与 bootstrap package 统一升至 `0.5.1`。`prepare-linux-snapshot-bundle.mjs` 改从 `linux-inputs.json` 的 `runtimeVersion` 读取预期版本；旧 `v0.5.0` manifest 夹具仍保留作历史兼容测试。`dshVendor.upstreamVersion` 仍记真实上游版本 `0.5.0`。

旧 staging 资产副本和设备目录中的哈希插件目录未清理；本 PR 不触碰这些用户侧数据。

## 复核状态

已完成的本机复核：

- `node --test vendor/dsh-linux-runtime/test/manager.test.mjs`：30/30；覆盖完整宿主变量、所有三项 GNU 工具探测、缺少 shim 拒绝，以及 toybox exit 0 负控。
- Linux-env 错误文案定向用例：1/1；`npm run build`（`plugins/dsh-android-linux-env`）成功。
- `check-linux-sources.mjs --self-test`：2/2；37 个来源文件摘要通过。`check-vendored-linux-bootstrap.mjs --self-test` 正控与 4 项负控通过。
- `check-code-map.mjs`、`check-package-lock-roots.mjs`、`check-maintenance-docs.mjs` 与 `cargo fmt --check` 通过。

本机其余验证边界：Linux-env 全量测试为 12/18，6 个失败来自这台 macOS 上已知的 `/var` 路径别名与 ESM fixture 解析；资产 Python 测试 1 项通过、GNU tar 相关项跳过，另 1 项受同一 `/var` 别名影响。Bionilux `cargo test` 因本机缺少 `clap` 缓存且 crates.io DNS 不可达而未编译；bootstrap `npm run build` 已重建 `lib/`，但 client bundle 步骤使用了不匹配本机平台的 Linux esbuild 二进制而失败。Linux CI 应在其固定 Ubuntu 环境重跑相应验证。

用户要求本轮先不做实机测试，所以无论代码级验证结果如何，Android 安装恢复状态仍标为**未验收**。发版前必须以最终 ARM64 来源 APK 在目标设备确认：完整 termux-exec 环境生效、三个工具均为 GNU 版本、rootfs 准备完成、安装前 Node smoke probe 成功；随后再验证 Bionilux/glibc guest 多级执行入口。
