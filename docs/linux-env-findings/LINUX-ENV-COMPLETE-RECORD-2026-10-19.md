# Linux 环境功能：调查、实机证据与保留决策（2026-10-19）

> 文档性质：调查与决策记录，**不包含代码改动**。本轮只新增 `docs/linux-env-findings/` 文档，不改任何代码。
> 适用对象：pocket-harness `main`（复核时 HEAD `b836d3a`，versionName 0.14.8，targetSdk 34）。
> 原始报告：[ORIGINAL-REPORT-2026-10-19.md](<ORIGINAL-REPORT-2026-10-19.md>)、[ORIGINAL-PATCHES-2026-10-19.md](<ORIGINAL-PATCHES-2026-10-19.md>)。
> 过程文档：[INVESTIGATION-2026-10-19-pocketharness.md](<INVESTIGATION-2026-10-19-pocketharness.md>)、[REMEDIATION-PLAN-2026-10-19.md](<REMEDIATION-PLAN-2026-10-19.md>)。
> 本文档是上述材料的**最终汇总与决策记录**；过程文档保留为证据附录。
> **2026-10-20 更正**：本文保留 10-19 决策与实验历史；当前源码已有 `BIONILUX_LOADER`，旧 noexec 唯一归因及 PRoot 排除理由证据不足。当前方案与一手依据见 [恢复方案](RECOVERY-PROPOSAL-2026-10-20.md) §2。以下旧实验结果不构成当前 APK 验收。

---

## 0. 决策摘要

### 0.1 本轮决定：**不移除 Linux 环境功能**

理由：

1. **移除本身是一个项目，不是一次清理**：审计命中 141 个文件（含 `node_modules`），一手文件约 100 个，分布在 `plugins`、`vendor`、`app`、`scripts`、`.github`、`docs`、`release` 七个根；涉及构建链、来源资产、Kotlin 桥、工作流、门禁、测试与文档。
2. **功能目前是隔离的实验性面**：`linux-bootstrap` / `linux-runtime` / `bionilux` 只在 Linux 环境路径上使用，不影响主引擎、Termux 工具链、Shizuku、浏览器、虚拟屏等主功能。
3. **设备不在线**：移除后无法完成三层验收；在设备缺席时做“大删除”会制造无法验证的构建风险。
4. **产品上还没有“永久放弃”的结论**：本轮只是确认“当前实现过于复杂、不能宣称可用”；将来若 Shizuku/APK native lib/memfd 某条路走通，代码仍有复用价值。
5. **文档与代码分离成本低**：先把事实记录清楚，避免下一位再次重复调查；移除可以等产品明确放弃时再做。

### 0.2 “保留”具体意味着什么

- **保留代码**：`plugins/dsh-android-linux-env`、`plugins/dsh-linux-bootstrap`、`vendor/dsh-linux-runtime`、`vendor/bionilux`、Kotlin `LinuxAssetIO`/`LinuxAssetPrepare`、Linux 资产构建链都不动。
- **不宣称可用**：任何文档、发布说明、UI 都不得写“Linux 环境已修复/可用”。
- **不再投入实现**：本轮之后不再为 ①②③④⑤ 写新代码；除非产品明确选择一条后端路线并给预算。
- **保留已知缺陷**：① 未修，插件在每轮 boot 会崩、路由 503；②③④ 未修；⑤ 结构性阻塞。这不是“已解决”，只是“暂不处理”。
- **最小止血建议（未执行）**：若要避免每轮 boot 的激活崩溃，二选一——修 ①（删 `ctx.filesDir`，一行）或把 `linux-bootstrap` 从出厂 profile 移除，恢复 D-014 的“默认不加载”。本轮只记录，不改。

### 0.3 当前可用性判定

> **不可用。** 旧实验中 `bionilux` 可以启动，但 glibc loader 直接执行失败。具体执行策略仍需按真实进程和文件重新归因；安装链也没有完整走通（详见 §8）。

---

## 1. 背景与时间线

| 时间 | 事件 | 产出 |
|---|---|---|
| 2026-10-19 15:50 | 原报告记录真机“安装 Linux 环境”失败，提出 5 个问题 | `ORIGINAL-REPORT-2026-10-19.md`、`ORIGINAL-PATCHES-2026-10-19.md` |
| 2026-10-19 17:00 | 本仓源码复核：确认 ①②④，修正 ③ 归因，⑤ 初步归因 | `INVESTIGATION-...md` |
| 2026-10-19 17:30 | 制定修复计划（WP-1..7 + CI） | `REMEDIATION-PLAN-...md` |
| 2026-10-19 18:00 | 实机第一轮：`/data/data` 是 `tmpfs noexec`；`ptrace` 可用 | 实验 1a/1b/1c、mount、ptrace PoC |
| 2026-10-19 18:15 | 实机第二轮：guest 是 glibc v24.22；bionilux 启动但 `execve(loader)` EACCES；W5 失败；`BIONILUX_LOADER` 不存在 | W5 失败、路径矩阵 |
| 2026-10-19 18:30 | 评估 proot/qemu/JIT/转换层 | 路线与可行性 |
| 2026-10-19 18:52 | 决策：不移除，只整理文档并记录 | 本文档 |

---

## 2. 版本与环境基线

### 2.1 代码同一性

原报告引用的文件与 `main` 的构建产物**逐字节一致**，因此不是旧包残留：

| 文件 | 本仓 sha256 | 报告值 |
|---|---|---|
| `plugins/dsh-linux-bootstrap/lib/index.js`（= `src/index.js`） | `7517AC3C…382645` | `7517ac3c…382645` |
| `plugins/dsh-android-linux-env/lib/linux-host-asset-io.js` | `50F10C91…53A717` | `50f10c91…53a717` |
| `plugins/dsh-android-linux-env/lib/linux-environment.js` | 503 在第 291 行 | 引用 289–293 |

### 2.2 设备/运行时事实

| 项 | 值 |
|---|---|
| 设备 | vivo V2425A，arm64，Android 16 / SDK 36，SELinux enforcing，无 root |
| 应用 | `com.snoworwind.pocketharness`，0.14.7（设备）/ 0.14.8（HEAD） |
| targetSdk / minSdk / compileSdk | 34 / 26 / 36 |
| 应用数据根 | `/data/data/com.snoworwind.pocketharness/files`（与 `/data/user/0/...` 同一目录的两种写法） |
| 关键挂载 | `/data`：`rw,nosuid,nodev,noatime`（无 noexec）；**`/data/data`：`tmpfs rw,nosuid,nodev,noexec`** |
| bootstrap | `@dsh-android/linux-bootstrap` 0.5.0 |
| runtime | `@dsh-android/linux-runtime` 0.5.0 |
| bionilux | 0.4.2（bionic，NDK r30，interp=`/system/bin/linker64`） |
| guest Node | `node-glibc-v24.22.0-linux-arm64`（glibc，interp=`/lib/ld-linux-aarch64.so.1`） |
| 引擎/快照 Node | bionic v24.18.0（interp=`/system/bin/linker64`） |

### 2.3 测试边界（重要）

第二轮实机是把 APK 内的 `bionilux-backend`、`node-glibc-v24.22.0`、`debian-minimal` **手动解到 `~/tmp/lx`**，**没有安装运行时插件槽位**（`plugins/linux-runtime` 不存在）。因此：

- 这些实验对 **exec/bionilux 层**有效；
- 对**完整安装链**（bootstrap → 插件 → rootfs → prepare → probe）不作证明；
- 安装链的 ①–④ 仍是另一条验收线。

---

## 3. 功能调用链

```text
设置页“安装”
  → POST /api/android/linux-environment/install
  → linuxBootstrap.install()
     ① 读取/校验 APK 内置 manifest
     ② 复制并校验 runtime 插件包
     ③ pluginHost.install()（Cordis 激活 runtime 插件）
     ④ RuntimeManager.install()：解 node/backend/rootfs
     ⑤ prepare-rootfs.sh（宿主工具）
     ⑥ _probeRuntime：bionilux → guest node --version
     ⑦ 写 active 记录、state
```

失败分层：

- ① 激活期：`apply()` 抛错 → `linuxBootstrap` 服务缺席 → 所有 Linux 路由 503；
- ②③④ 安装/解包期：路径、硬链接、宿主命令；
- ⑤⑥ 运行期：glibc loader 的 exec；
- ⑦ 可观测性：失败不落盘、文案泛化。

---

## 4. 五个问题与补充问题

### 4.1 ① `ctx.filesDir`：插件激活即崩

**位置**：`plugins/dsh-linux-bootstrap/src/index.js:589`

```js
export const inject = ['linuxPluginHost', 'linuxBootstrapConfig']   // 第 10 行
const filesDir = config.filesDir ?? ctx.filesDir ?? process.env.DSH_FILES_DIR
```

**机理**：

- 宿主从未 `provide('filesDir')`；`inject` 也没有它；
- Cordis 的 getter 对未声明属性抛 `cannot get property "filesDir" without inject`（`@deepseek-ai/cordis/lib/index.js:676`）；
- `??` 短路：`config.filesDir` 为空时先求值 `ctx.filesDir`，轮不到已经存在的 `DSH_FILES_DIR`。

**证据**：

- 用 engine 0.2.1-rc.2 的真实 Cordis 跑 `app.plugin(bootstrap)`：
  `RESULT: activation threw -> cannot get property "filesDir" without inject`；
- 普通对象 ctx 不抛，所以现有集成测试（直接 `createBootstrap`）覆盖不到。

**影响**：

- 若 `linux-bootstrap` 在出厂 profile 里，每轮 boot 都会出现 `1 entry did not activate`；
- 所有 Linux 路由返回 503，文案却让人“去显式启用”，实际是崩溃。

**架构矛盾（必须记录）**：

- 本仓 `scripts/profile-web.cordis.patch.yml:86-89` **无条件插入** `linux-bootstrap`；
- 上游 D-014（`.deploy-tmp/linux-runtime-source/docs/DECISIONS.md:180-198`）要求它**不进入 profile/注入集**，因为需要函数型 config；
- `docs/AGENTS/BRIDGE-API.md:209` 与 AGENTS.md 又说“默认不启用”；
- `scripts/check-vendored-linux-bootstrap.mjs` 头注还说它“deliberately sits OUTSIDE the injection set”。

结论：这是**未解决的设计漂移**，不是单行 bug。修 ① 只是让插件能激活，但同时会把“实验插件常驻”固化；正确做法是先决定 A（接受 always-loaded，更新文档/安全评审）或 B（回到 D-014，移除 profile 插入 + 宿主显式加载）。

### 4.2 ② 硬链接路径规范化：别名根必失败

**位置**：`plugins/dsh-android-linux-env/lib/linux-host-asset-io.js:202-209`

```js
const root = resolve(destination);                     // 纯词法
const physical = await realpath(entry.source);          // 物理路径
if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !physical.startsWith(root + sep))
  throw new Error('Archive hard link must target an extracted regular file');
```

**原因**：`DSH_FILES_DIR` 来自 `context.filesDir.absolutePath`，未 canonical 化；`/data/data` 与 `/data/user/0` 是同一目录的两种写法。只 realpath 一侧必拒。本仓坑 1/67 已登记同一类问题（“新路径校验代码一律双侧规范化”）。

**本机复现**：Windows junction 别名根 + 合法硬链接 → 与设备逐字相同的错误；规范路径下成功且硬链接保留。

### 4.3 ③ 硬链接被拒：结论成立，归因需更正

- 原报告归因 f2fs 不支持硬链接；**不成立**。f2fs 支持硬链接。
- 本仓坑 66/171 登记为“Android 应用域/SELinux 拒 `link(2)`”；上游 `STATUS.md:122-126` 也记为“设备策略（连 App 私有目录也一样）”。
- `link(2)` 失败可能是 `EACCES` 或 `EPERM`；兜底应覆盖 `EPERM/EACCES/ENOTSUP/EXDEV/ENOSYS/EMLINK`，用复制 + `chmod`。
- bionilux 的 guest preload 已有 `link`/`linkat` → copy 的兜底；③ 主要影响**宿主侧解包器**。

### 4.4 ④ 宿主准备脚本：noexec + 被剥的 termux 环境

**位置**：

- `vendor/dsh-linux-runtime/modules/manager.js:19-42`（`HOST_ENV_ALLOWLIST`）
- 同文件 `:369-375`（`cleanHostEnvironment`）
- 同文件 `:722-737`（`_prepareRootfs`，`file:'sh'`，`env: cleanHostEnvironment()`）
- `vendor/bionilux/scripts/prepare-rootfs.sh:62`（`find "$ROOTFS" -type l`）

**机理**：

- `find` 等工具先在 `PATH` 的 `<prefix>/bin` 命中 app 私有 ELF；
- `/data/data` 是 noexec，直接 `execve` 失败；
- `cleanHostEnvironment()` 又剥掉 `LD_PRELOAD`/`TERMUX_EXEC__*`，子 shell 没有 termux trampoline；
- 结果：`prepare-rootfs.sh[62]: .../usr/bin/find: Permission denied`。

**修法方向**（本轮不实施）：

- 首选 Node 侧实现根准备（`readdir`/`lstat`/`readlink`/`symlink`/`unlink`），完全避开 app 私有 ELF；
- 次选系统 shell + `PATH=/system/bin`（toybox），但需逐 applet 验证；
- 不要把 termux trio 加进全局 allowlist（会污染 guest/probe）。

### 4.5 ⑤ 运行时 exec：结构性阻塞（本轮最核心）

#### 4.5.1 现象

`_probeRuntime`（`manager.js:541-567`）在安装提交前运行：

```js
file: health.paths.launcher,      // bionilux（bionic）
args: ['node', '--version'],      // guest node（glibc）
```

失败：`execve(…/rootfs/usr/lib/ld-linux-aarch64.so.1)` → `EACCES`。

#### 4.5.2 历史归因：`/data/data` 的 `tmpfs noexec` 行不足以单独定因

- 历史记录观察到 `/data/data` 挂载行含 `tmpfs rw,nosuid,nodev,noexec`；
- 尚未提供实际 loader 文件所属 mount ID、进程 mount namespace 与 syscall 证据，不能只凭该行和 `EACCES` 定位到 `MNT_NOEXEC`；
- 不能排除 SELinux/应用执行策略。当前 targetSdk 是 34；Android API 29 起已有应用私有文件直接执行限制，见恢复方案 §2.2。

#### 4.5.3 为什么 app 自己的 bionic 程序能跑

```text
execve("/system/bin/linker64")          ← /system，允许 exec
  └─ linker64 加载 app 私有 bionic node  ← 观察到成功，仍需核对文件可执行映射策略
```

内核直接 exec 的入口变成系统 linker；`env -i` 清掉 `LD_PRELOAD` 后，旧实验的裸 `execve(node)` 返回 `EACCES`。该差异支持“直接执行受限”，但不证明文件处于 noexec 挂载：文件可执行 mmap 本身也受 noexec 检查。

#### 4.5.4 为什么 Linux 模块不行

guest node 是 glibc ELF，interp=`/lib/ld-linux-aarch64.so.1`；bionilux 最后必须：

```text
execve(<rootfs>/usr/lib/ld-linux-aarch64.so.1)   ← app 私有，noexec → EACCES
```

`linker64` 是 bionic linker，不能加载 glibc loader（`Could not find a PHDR` / `unexpected e_type`）。所以“救 bionic node 的那一招”对 glibc 不成立。

#### 4.5.5 bionilux 不是转换层

- 它是 **bionic launcher + glibc preload**：
  - launcher（bionic Rust）读 ELF、选解释器、`execve(glibc loader)`；
  - preload（glibc .so）注入 guest，做路径/身份/环境映射；
- guest 的 libc 仍是 rootfs 里的 glibc；没有 glibc→bionic 的 ABI 转换；
- 它做的是 **rootfs/路径/身份/exec 路由**，不是 libc 翻译；
- 因此它必然依赖 `execve(glibc loader)`——noexec 卡的正是这一步。

#### 4.5.6 W5（外部 loader）为什么失败

第二轮实测：

```text
[DEBUG] resolved: …/tmp/lx/node/bin/node
[DEBUG] Aarch64 glibc -> native loader
[DEBUG] execve: …/tmp/lx/rootfs/usr/lib/ld-linux-aarch64.so.1
[ERROR] execve failed: EACCES: Permission denied
```

两个硬事实：

- 旧报告称当时被测二进制没有 `BIONILUX_LOADER`；当前 vendor 源码已有此配置及子进程传递，不能沿用为当前接口结论（恢复方案 §2.1）；
- 非 noexec 落脚点矩阵：

| 路径 | 可写 | exec |
|---|---|---|
| `/data/local/tmp` | ✗ | ✓ |
| `/dev/shm` | ✗（SELinux 拒） | ✓ |
| `/tmp` | ✗ | ✓ |
| `/cache` | ✗ | ✓ |
| `/sdcard` | ✓ | ✗（FUSE noexec） |
| app 私有（`/data/data`、`/data/user/0`） | ✓ | ✗ |

该次实验的实际 exec 路径仍指向私有 rootfs loader，证明这一调用失败，未证明当前源码配合 APK 外置可信 loader 必然失败。新路线必须单独验证来源产物、外置入口与 guest 映射。

### 4.6 ⑦ 可观测性

- 激活崩溃：服务不存在，`save()` 无从执行；
- 安装失败：`installRuntime` catch 只 `emit()`，不 `save()`；重启后 `lastError` 丢失；
- 路由 500 固定泛化文案，不返回 `lastError`/稳定 code；
- 503 文案与出厂 profile 插入事实矛盾（“需要显式启用”，实际是激活崩溃）。

---

## 5. 实机实验记录

### 5.1 第一轮（2026-10-19 18:00 左右）

| 组 | 命令 | 结果 |
|---|---|---|
| 1a | `$P/usr/bin/node --version`（DSH shell 默认 env） | **v24.18.0** ✅（bionic node） |
| 1b | `env -i /system/bin/sh -c 'exec $P/usr/bin/node --version'` | **126 EACCES** ❌ |
| 1c | `env -i LD_LIBRARY_PATH=$P/usr/lib /system/bin/sh -c 'exec /system/bin/linker64 $P/usr/bin/node --version'` | **v24.18.0** ✅ |
| 2 | `adb shell` 域 | 未就绪（ADB/Shizuku 双通道未就绪） |
| PoC | `ptrace`（python3 ctypes `PTRACE_SEIZE`/`CONT`） | `SEIZE OK / stopped=1 sig=5(SIGTRAP) / CONT OK` → **可用** |

**关键结论**：

- noexec 是 EACCES 的来源；
- termux-exec 的 trampoline 让 bionic node 绕过 noexec；
- 1a 的 node 是 **bionic v24.18**，不是 guest glibc v24.22；
- `ptrace` 可用，W1/W2 的能力前提成立。

### 5.2 第二轮（2026-10-19 18:15 左右）

| # | 实验 | 实测 | 判定 |
|---|---|---|---|
| 1 | guest node interp/版本 | `/lib/ld-linux-aarch64.so.1`；`v24.22.0` | ✅ glibc，非 bionic |
| 2 | clean env 跑 node | `Permission denied`，126 | ✅ noexec |
| 3 | 保留 termux trio 跑 bionilux | bionilux 0.4.2 **正常启动**；PHDR 在**子进程** `execve(loader)` | ✅ 位置修正 |
| 4 | W5：`linker64 <bionilux>` + 非 noexec loader | `execve(loader)` EACCES；`BIONILUX_LOADER` 不存在 | ❌ 结构性失败 |

**实验 1 的附带信息**：直接 `node --version` 报 `unexpected e_type: 2`，是 **linker64 的措辞**——execve 已被 termux 改写成 `linker64 <node>`，而 glibc ET_EXEC 进不了 bionic linker。

**实验 3 的位置修正**：bionilux 本身不是失败点；它经 bash 的 termux trampoline 正常启动。PHDR 发生在它内部 `execve(ld-linux)` 时，从 bash 继承的 preload 把这一跳也改写成 linker64。加 `-n` 同样失败，说明不是 bionilux 自己的 preload。

### 5.3 清理与保留

- 探针文件 `files/tbprobe`、`/sdcard/ld.so` 已清理（实机 agent）；
- PoC 脚本留在 `~/tmp/{ptrace_poc,seize_poc}.py`；
- 解包目录 `~/tmp/lx/{bio,node,rootfs}` 保留可复现；
- 本轮本机只读源码；临时复现脚本在 `本机临时目录（不入仓）`。

---

## 6. 根因模型（一页）

```text
app 私有 ELF 直接执行受限（具体策略待复核）
  ├─ bionic ELF：旧实验可由 /system/bin/linker64 加载
  │    └─ node/busybox/bionilux 本身能跑
  └─ glibc ELF：需要 glibc loader 被内核 exec
       ├─ loader 在 app 私有 → EACCES
       ├─ linker64 不能加载 glibc loader → PHDR/e_type
       └─ termux 改写 loader → linker64 → 同样 PHDR
```

**一句话**：

> 两条路径的内核 exec 入口不同；不能据此断言 noexec 只拦后者。APK 入口与 guest 可执行映射必须分别验证。

---

## 7. 为什么“转换层 / JIT”不划算

### 7.1 glibc→bionic 转换层

不是“改 interp”或“加 shim”，而是重写 glibc 的 ABI/loader：

- 两套 libc 不能同进程共存（TLS/`errno`/`malloc`/`pthread`/`FILE`/`stat`）；
- glibc 内部调用绕过 PLT（`__open`/`__stat`/`__execve`/`mkstemp`），preload 拦不住；
- NSS/iconv/locale/dlopen 模块用 `GLIBC_PRIVATE`；
- 符号版本（`GLIBC_2.34` 等）bionic 没有；
- 现实先例：`gcompat` 只覆盖简单二进制；Wine 数十年；Termux 选择重编 bionic；proot/qemu 选择运行真 glibc。

### 7.2 JIT

- 同架构 aarch64-on-aarch64：无指令集收益；JIT 是编译器级工程；
- 绕过 noexec 的关键是“用户态加载 ELF”，不是 JIT；QEMU 的 bypass 来自它自己加载 ELF；
- JIT 翻译指令，不翻译 libc ABI；解决不了 glibc→bionic 的语义问题。

### 7.3 QEMU linux-user

- 能绕过 noexec（自己加载 glibc loader）；
- `-L` 只设 interp/库前缀，**不是 chroot**；guest 绝对路径可能落到宿主；
- `/proc`/`/dev`/fake root/`chown` 仍需 proot 或 bionilux preload；
- 同架构 TCG 慢；作为 PoC/后备可以，作为完整 Debian 主路线中低。

### 7.4 proot

- Termux PRoot 用自带 `PROOT_LOADER` 加载 guest/interpreter，旧“内核直接 exec guest loader”归纳不准确；
- 仍需验证自身入口、ptrace 和 guest 可执行映射；不能保证解决真正的 noexec backing mount；
- 可将 PRoot 及自身 loader 放 APK 原生目录作为无特权候选，不应预先限定必须走 shell 域；
- proot-distro 本身不要求 root/Shizuku；Termux 上无 root 运行。

---

## 8. 当前可用性判定

| 层 | 状态 | 说明 |
|---|---|---|
| bootstrap 激活 | ❌ 崩溃 | ① 未修；每轮 boot `did not activate`，路由 503 |
| 安装链 ②③④ | ❌ 未闭环 | ② 路径、③ 硬链接、④ 宿主准备均未修 |
| runtime 插件安装 | ⚠️ 未证明 | 第二轮手动解包，未安装插件槽位 |
| probe / 运行时 | ❌ 结构性阻塞 | noexec + glibc loader；W5 失败 |
| `linux_bash` | ❌ 不可用 | 依赖 bionilux → glibc loader |
| UI/文档 | ❌ 失真 | 503 文案、默认启用口径、发布说明都不能写“可用” |

**结论**：功能不可用；不能因为“插件能加载”或“bionilux 能启动”就认为接近可用。

---

## 9. 决策：暂不移除

### 9.1 为什么移除代价高

审计（只读）命中：

- **7 个根**：`plugins`、`vendor`、`app`、`scripts`、`.github`、`docs`、`release`；
- **141 个文件**（含 `node_modules`），一手文件约 **100**；
- 构建链：Linux 资产（Debian keyring、交叉工具链、bionilux Rust、rootfs、glibc Node）、`build-linux-assets.yml`、`build-apk-source.yml` 的 Linux 步骤、`linux-source-manifest.json`、`check-linux-sources`、`prepare-linux-snapshot-bundle`；
- 插件/厂商：2 个插件目录 + 2 个 vendor 目录；
- Kotlin：`LinuxAssetIO.kt`、`LinuxAssetPrepare.kt`、`AndroidBridge` 方法、单测；
- 门禁：`check-vendored-linux-bootstrap`、API 路由 auth、tool surface、op registry、contract、inject 完整性；
- 文档：17 个 `docs/AGENTS` 文件 + AGENTS.md + 发布说明。

移除不是“删目录”，而是**同时改构建链、门禁、测试、文档、工作流**，还要在设备上重新验收。设备不在线时做这件事，风险高于收益。

### 9.2 保留的代价

- ① 未修：每轮 boot 崩溃、503；
- ②③④ 未修：安装链仍失败；
- ⑤：结构性阻塞；
- 文档漂移（D-014/profile、默认不启用/实际插入）；
- 未来维护者可能再次误以为“只差一点”。

### 9.3 保留期间的最小纪律

1. 任何文档/发布说明/UI 不得写“Linux 环境可用”。
2. 若要止血，优先二选一：修 ①，或从 profile 移除 `linux-bootstrap` 恢复默认不加载；本轮不做。
3. 如未来重启该功能，先做 §10 的决策门，不要直接从 ① 开始“修一行”。
4. 不再为 ②③④⑤ 写新代码，除非产品选定后端路线并给预算。

### 9.4 重新评估移除的条件

- 产品明确“永久不做 Linux 环境”；
- 维护成本（门禁、资产、文档）持续影响主版本；
- 设备可用，能完成移除后的三层验收；
- 有足够时间做构建链/来源链/门禁的完整迁移。

---

## 10. 如果将来重启：路线与决策门（不实施）

> 以下为 10-19 候选历史；当前优先顺序由 [恢复方案](RECOVERY-PROPOSAL-2026-10-20.md) 替代。

| 路线 | 做法 | 可行性 | 决策门 |
|---|---|---|---|
| **W3-lite-A** | loader 作为 APK native lib；rootfs app 私有 | 中；最便宜 | `nativeLibraryDir` 文件 mode 是否带 x；SELinux `apk_data_file` 是否允许 exec；`extractNativeLibs=true` |
| **W3-lite-B** | loader 放 `/data/local/tmp`；app 使用 | 中低 | app 对 `/data/local/tmp` 的 read/traverse/exec；Shizuku 一次性写入 |
| **W2a** | loader 读入 `memfd` + `fexecve` | 中；纯 app | memfd/fexecve 是否绕过 noexec；glibc loader 能否启动；`/proc/self/exe` 影响 |
| **W2b** | ptrace 截获 `execve(loader)`，mmap + 跳 entry | 中低；纯 app | `ptrace` 已验证可用；实现/维护成本；apt/dpkg 子进程 exec 链 |
| **QEMU linux-user** | 现成用户态 loader/JIT | 中；PoC 高，完整 Debian 中低 | `qemu-aarch64 -L rootfs node --version`；apt/dpkg 路径语义；性能 |
| **W3** | Shizuku/shell 域，rootfs 在 `/data/local/tmp` | 高（最接近上游验证） | Shizuku 可用；rootfs 生命周期/权限撤销；安全模型变化 |
| **W4** | bionic-only | 高；可立即交付 | 产品接受放弃 Debian/apt |
| **proot** | 仅与 W3 组合 | 中 | 不绕过 noexec；只有 rootfs 非 noexec 才有意义 |

**建议的决策顺序**：先测 W3-lite-A（半天）→ W2a（一天）→ 若都失败且有 Shizuku，W3 → 否则 W2b 评估 → 最后 W4。

---

## 11. 未决问题与风险

| ID | 问题 | 影响 |
|---|---|---|
| U1 | profile 插入 vs D-014 “默认不启用” | 架构/安全口径不一致；① 修复会固化常驻 |
| U2 | ① 未修 | 每轮 boot 崩溃、503 |
| U3 | ②③④ 未修 | 安装链仍失败 |
| U4 | ⑤ noexec/glibc loader | 运行时不可用 |
| U5 | 第二轮测试未装 runtime 插件 | 安装链未端到端验证 |
| U6 | 设备离线 | 无法做三层验收 |
| U7 | 移除成本高 | 本轮保留 |
| U8 | proot/qemu 许可证 | 若引入，GPL-2.0 合规 |
| U9 | rootfs 不是安全沙箱 | 文档不得宣称隔离 |

---

## 12. 复现与证据

### 12.1 关键命令（设备）

```sh
# 挂载与 noexec
cat /proc/self/mounts | grep ' /data/data '

# bionic node 对比（v24.18）
$P/usr/bin/node --version
env -i /system/bin/sh -c 'exec $P/usr/bin/node --version'          # 126 EACCES
env -i LD_LIBRARY_PATH=$P/usr/lib /system/bin/sh -c \
  'exec /system/bin/linker64 $P/usr/bin/node --version'            # v24.18

# guest glibc node（v24.22）
<runtime>/shared/node/.../bin/node --version
readelf -l <runtime>/shared/node/.../bin/node | grep interpreter

# bionilux 当前 probe
<runtime>/backend/bin/bionilux --rootfs <rootfs> node --version    # EACCES

# ptrace PoC（python3 ctypes）
# SEEZE OK / SIGTRAP / CONT OK
```

### 12.2 本机复现

- 真实 Cordis 激活：`RESULT: activation threw -> cannot get property "filesDir" without inject`
- 别名根硬链接：`ALIAS: ... must target an extracted regular file` / `CANONICAL: succeeded`
- W5 verifier：`CURRENT: verifier threw -> incomplete canonical engine patch: ptc-android-native-A1` / `AFTER FIX: passed`（这是 CI 修复的复现，与 Linux 无关）

### 12.3 证据路径

- 原始报告：`ORIGINAL-REPORT-2026-10-19.md`、`ORIGINAL-PATCHES-2026-10-19.md`
- 源码复核：`INVESTIGATION-2026-10-19-pocketharness.md`
- 修复计划：`REMEDIATION-PLAN-2026-10-19.md`
- 本文档：`LINUX-ENV-COMPLETE-RECORD-2026-10-19.md`
- 本机临时脚本：`本机临时目录（不入仓）`
- 实机保留：`~/tmp/lx/{bio,node,rootfs}`、`~/tmp/{ptrace_poc,seize_poc}.py`

---

## 13. 文档索引

| 文档 | 内容 | 状态 |
|---|---|---|
| `ORIGINAL-REPORT-2026-10-19.md` | 实机 agent 原始报告（5 个问题） | 原始证据，结论部分以本文档为准 |
| `ORIGINAL-PATCHES-2026-10-19.md` | 原始修复建议 | 参考；W5/`BIONILUX_LOADER` 部分已失效 |
| `INVESTIGATION-2026-10-19-pocketharness.md` | 本仓源码复核、①②③④、本机复现 | 过程记录 |
| `REMEDIATION-PLAN-2026-10-19.md` | 修复计划、WP-1..7、WP-CI、路线矩阵 | 计划；未执行 |
| **本文档** | **最终汇总、实机两轮、真因、决策** | **权威记录** |

---

## 14. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-10-19 | 汇总原始报告、源码复核、两轮实机、真因、路线评估；记录“暂不移除、只保留文档”的决策 |



