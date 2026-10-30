# Linux 环境安装失败修复计划：宿主子进程动态库路径（2026-10-21）

> 状态：源码修复已实现；按用户要求未做实机测试，不能据此判定 Linux 环境已恢复。依据更新后的 `linux-env-install-failure-20261021-2117(1).log` 与当前仓库源码。原始日志保存在仓库外的用户临时目录，没有复制进仓库。
> 范围：修复已观测到的 rootfs 预处理失败，并单独登记后续执行入口门槛；不把不同阶段的故障合并为一个根因。本文记录的是 Bionilux 后端时期；该后端已由 2026-10-22 的 Termux PRoot 迁移取代，不作为当前操作指南。

## 1. 已确认的失败

设备上的安装从 APK 内置资产目录离线复制四份 Linux 资产，摘要校验和解包均成功；runtime 插件也已写入插件目录。失败发生在 `prepare-rootfs.sh` 的第 62 行：

```sh
links=$(find "$ROOTFS" -type l) || exit 1
```

引擎父进程环境实测含：

- `PATH=/data/user/0/com.snoworwind.pocketharness/files/usr/bin:/system/bin`
- `LD_LIBRARY_PATH=/data/user/0/com.snoworwind.pocketharness/files/usr/lib`

`find` 是 Termux 前缀内的 ELF，依赖 `libandroid-support.so`，自身 `DT_RUNPATH` 却指向不存在的 `/data/data/com.termux/files/usr/lib`。日志里的正反实验表明：子进程保留引擎的 `LD_LIBRARY_PATH` 时脚本成功；删掉该变量时动态链接器找不到 `libandroid-support.so`，shell 最后只显示 `Permission denied`。

## 2. 当前源码中的根因链

1. [`manager.js`](../../vendor/dsh-linux-runtime/modules/manager.js) 的 `HOST_ENV_ALLOWLIST` 没有 `LD_LIBRARY_PATH`；`cleanHostEnvironment()` 因而丢弃引擎实际使用的 Termux 库目录。
2. `_prepareRootfs()` 用 `cleanHostEnvironment()` 启动 `sh`，但传入的 `PATH` 仍包含 `$PREFIX/bin`。
3. 当时的 `vendor/bionilux/scripts/prepare-rootfs.sh` 按 PATH 找到 `$PREFIX/bin/find`，动态链接失败后退出，runtime 安装事务回滚。Bionilux 源码目录已随后端迁移移除。
4. 同一环境构造函数也被 `_probeRuntime()` 和 `_executionEnvironment()` 使用，故修复范围需要覆盖相同环境契约，并验证不会把宿主库路径错误地带进 glibc guest。

这解释了本次 HTTP 500；网络不参与安装，内置资产摘要、存储空间和 bootstrap 激活均不是本次失败点。路由原先把异常折叠为泛化 500，bootstrap 安装失败原先只更新内存 `lastError`、没有持久化；这两处已一并修复为稳定错误码、持久化诊断和页面脱敏摘要，但不是 `find` 失败的原因。

## 3. 修复拆分

### PR 1：为宿主子进程提供可信的 Termux 库目录（源码已实现）

**改动范围**：`vendor/dsh-linux-runtime/modules/manager.js`、对应测试，以及 `vendor/bionilux/src/launcher/config.rs` / `env.rs` 的 guest 环境隔离回归。未更改 rootfs 解包或运行时后端。

**实现要求**：

1. 增加明确的宿主环境构造规则，从壳侧注入的 `DSH_FILES_DIR/usr/lib`（或显式 `TERMUX__PREFIX` / `PREFIX`）解析库目录；只传入该目录，不直接信任或透传父进程任意 `LD_LIBRARY_PATH`。Android 上目录无法解析或不存在时明确失败。
2. 让 rootfs 准备脚本执行 `find` / `readlink` 时收到该宿主库路径，同时保留现有的其他环境白名单，不透传 `LD_PRELOAD`、`TERMUX_EXEC__*` 或请求方提供的任意变量。
3. 明确区分宿主 ELF 环境和 Debian/glibc guest 环境。Termux 路径传给宿主工具及 Bionilux launcher；Bionilux 只在首次进入 guest 时剔除宿主继承值，guest 自己为后代进程设置的 `LD_LIBRARY_PATH` 仍可保留。
4. 不修改已解出的设备文件来绕过故障。安装会从受摘要校验的资产重新解包，临时改动会被覆盖。

**代码层反证**：

- manager 测试断言运行 rootfs 准备命令的子进程环境含预期的 `$DSH_FILES_DIR/usr/lib`，且保留必要的 Android 系统变量。
- 正控验证以父进程实际环境启动 `find` / `readlink` 时可成功；负控移除库文件或给出不可信路径时必须失败关闭并返回可辨认的阶段错误。
- 对 `_probeRuntime()` 与 `_executionEnvironment()` 添加环境边界断言，确保修复覆盖共用代码路径且不把 Termux 库配置错误地当成 guest glibc 配置。
- 运行 runtime 插件自己的测试与其构建；本计划阶段不把 fake runner 的 `node --version` 返回值当作 Android ELF 执行证明。

### PR 2：让安装失败可诊断、可跨重启读取（源码已实现）

**改动范围**：`plugins/dsh-linux-bootstrap/src/index.js` 与 `plugins/dsh-android-linux-env/src/linux-environment.ts`，独立于 PR 1 提交。

1. 安装 catch 在抛出前持久化 `lastError`，并确认写状态失败不会覆盖原始安装异常。
2. 路由返回稳定错误码（`linux-rootfs-prepare-failed` 等）及短、脱敏的阶段原因；详细异常保存在 bootstrap 状态文件，不把任意 stderr 原样暴露给页面。
3. 对照重启前后的 status 结果验证错误可读；成功安装后清除旧错误，避免把历史失败显示成当前状态。

### 后续独立门槛：验证 Bionilux/glibc 的实际执行入口

本次日志没有走到 smoke probe，故 PR 1 通过不能推出 `linux_bash` 已可用。当前 manager 的 launcher 路径位于应用私有 runtime 目录；虽然 vendored Bionilux 源码支持 `BIONILUX_LOADER`，manager 的 probe 和执行环境目前没有接入该配置。应用私有目录的直接执行、loader 映射、SELinux/noexec 与多级子进程仍需在目标 ARM64 设备上按 [恢复方案](RECOVERY-PROPOSAL-2026-10-20.md) 单独取证。若这道门失败，应另立后端/入口改造 PR，不扩大本次环境变量修复的范围。

## 4. 验收顺序与通过标准

1. **代码层**：manager 的环境构造正反例、runtime 插件完整测试及对应静态门禁通过；记录提交、输入摘要、Node/平台和命令。测试不能只使用永远返回成功的 fake runner。
2. **设备安装层**：用包含修复的最终 ARM64 来源 APK，在目标 ARM64 设备上从设置页安装。安装必须越过 rootfs 准备和 smoke probe，status 明确显示已安装且健康；保存 engine 日志、status 前后值和设备截图。
3. **实际执行层**：让模型只接收目标、约束和成功标准，自行规划一个需要在 Debian 环境中使用 `find`/`readlink`、调用子进程处理文件并核对生成结果的真实任务；不提供逐条操作步骤。记录工具调用、重试、产物与核对结果，证明 `linux_bash` 及其子进程确实可用。
4. 验收按仓库 §2.1 记录代码/CDP/ADB 用户层结论；设备无在线或证据不足时明确记为未验收，不以宿主单测、热推或来源构建通过代替。`vendor/dsh-linux-runtime` 的最终发布候选须从最终提交重建 ARM64 来源 APK 并重新安装验证。

**完成判据**：安装不再因 `find` 的 `libandroid-support.so` 加载失败而回滚；状态错误可跨引擎重启读取；Linux guest 命令和子进程真实完成任务。前两项通过但第三项失败，仍不得宣称 Linux 环境恢复可用。

## 5. 本轮未做事项

代码级结果：`vendor/dsh-linux-runtime/test/manager.test.mjs` 28/28 通过；本次新增 HTTP 脱敏错误码与跨 bootstrap 重启持久化用例通过；Linux source manifest（37 文件）、bootstrap vendored source 与 code-map 检查通过。Linux-env 插件全套测试 71/78 通过；其余 7 项在本机因 `/var` 与 `/private/var` 路径别名、ESM fixture 被 Node 当作 CommonJS、以及 BSD tar 不支持 GNU `--sort=name` 失败。Bionilux Rust 定向测试因离线 Cargo 缓存缺少 `clap` 无法编译；bootstrap 完整 `npm run build` 的 client bundle 步骤受本机 `node_modules` 内 `@esbuild/linux-x64` 与当前 macOS arm64 不匹配影响，服务端 `src/`→`lib/` 复制步骤已成功。

源码级验证不等于设备验收。用户明确要求本轮不做实机测试，因此不会据此宣称 Linux 环境已恢复可用；仍需用最终 ARM64 来源 APK 在目标设备验证真实 Termux `find`、smoke probe 与 guest 多级执行。更新后的日志还确认全部资产已在 APK 内置目录，安装完全离线，这没有改变直接根因。Bionilux/glibc 执行入口仍是单独的后续设备门槛。
