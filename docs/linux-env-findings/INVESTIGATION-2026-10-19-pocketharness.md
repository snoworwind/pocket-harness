# 复核报告：实机「Linux 环境安装失败」发现 vs pocket-harness `main`（2026-10-19）

> 性质：**只做调查，未修改本仓任何代码**。所有设备侧事实来自 `ORIGINAL-REPORT-2026-10-19.md` 与 `ORIGINAL-PATCHES-2026-10-19.md`；本机结论来自源码比对与两段可复现实验。
> 复核对象：本仓（HEAD `b836d3a`，versionName 0.14.8，targetSdk 34）。
> 结论：原报告 5 条问题 + 1 条可观测性问题中，① ② ④ 完全成立；③ 结论成立但归因错误（不是 f2fs）；⑤ 结论成立但范围需收窄（不是 Android 10+ 一律）；⑦ 成立且比原报告更严重。④ 的「显式 env 加 LD_PRELOAD 仍失败」还需设备复验（更像缺 force mode）。当前 `main` 未修复其中任何一条。
>
> **本文保留调查过程，不作为当前执行结论。** 历史汇总与“暂不移除”决策见 [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md)；2026-10-20 复核发现当前源码已有 `BIONILUX_LOADER`，旧 noexec 唯一归因和 PRoot 排除理由需更正，见 [当前恢复方案](RECOVERY-PROPOSAL-2026-10-20.md) §2。

---

## 0. 结论表

| # | 原报告结论 | 复核判定 | 一句话依据 | 级别 |
|---|---|---|---|---|
| ① | `linux-bootstrap` 读未声明的 `ctx.filesDir`，`apply()` 抛错 → 所有请求 503 | **成立（本机复现）** | 真实 Cordis 下 1:1 复现 `cannot get property "filesDir" without inject` | P0，一行修 |
| ② | 硬链接校验用未规范化路径 → rootfs 必失败 | **成立（本机复现）** | 别名目录 + 合法硬链接 → 精确报出同一句错误；规范路径下成功 | P0，一行修 |
| ③ | 修复②后仍因「文件系统禁硬链接」失败 | **结论成立，归因错误** | 不是 f2fs；是本仓已登记两次的「Android 应用域/SELinux 拒 `link(2)`」 | P0，复制兜底 |
| ④ | `prepare-rootfs.sh` 被剥掉 termux-exec 环境，宿主工具 `EACCES` | **成立** | `cleanHostEnvironment()` 剥 `LD_PRELOAD`/`TERMUX_EXEC__*`；脚本第 62 行用 `find` | P0，宿主侧可修 |
| ⑤ | bionilux 无法在 Android 10+ exec glibc guest，需后端 fake-exec | **成立，但范围要收窄** | 是「本 app（untrusted_app / targetSdk 34）」的域限制；上游 README 的 V2425A「已验证」是 `adb shell` 域，不构成反证 | 设计级，硬阻塞 |
| ⑦ | 失败不落盘 `lastError`、503 文案混用 | **成立，且更严重** | 本仓装配清单**默认就插入** `linux-bootstrap`，503 实际是「激活崩溃」而非「未启用」 | P2，诊断性 |

**总判断**：原报告对用户现象的定位准确，修复顺序也对；但它把 ③ 归因到 f2fs、把 ⑤ 说成「Android 10+ 一律不行」，这两处会误导上游。更关键的是：**即便 ①–④ 全修完，安装仍会停在 ⑤**，因此不能把「装到只剩 smoke probe」理解为「功能接近可用」。

---

## 1. 证据基线：报告引用的就是当前 `main` 的产物

报告的结论不是旧包残留。它给出的两个 sha256 与本仓 `main` 的构建产物**逐字节一致**，引用行号也一一对齐：

| 文件 | 本仓 sha256 | 报告给出的值 | 行号对齐 |
|---|---|---|---|
| `plugins/dsh-linux-bootstrap/lib/index.js`（= `src/index.js`，`build.mjs` 平拷贝） | `7517AC3C…382645` | `7517ac3c…382645` | `apply()` 的 `ctx.filesDir` 在 589 行 |
| `plugins/dsh-android-linux-env/lib/linux-host-asset-io.js` | `50F10C91…53A717` | `50f10c91…53a717` | 硬链接收尾在 202–209 行 |
| `plugins/dsh-android-linux-env/lib/linux-environment.js` | —（未给哈希） | 503 块引用 289–293 行 | 实际 503 在第 291 行，吻合 |

版本口径也一致：`@dsh-android/linux-bootstrap` 0.5.0、`@dsh-android/linux-runtime` 0.5.0、bionilux 0.4.2（`vendor/bionilux/Cargo.toml`），app 0.14.7（报告）vs 0.14.8（本仓 HEAD）——**相关文件在 0.14.8 没有任何改动**，所以报告发现的问题今天仍然成立。

---

## 2. 逐条复核

### 2.1 ① `ctx.filesDir`：成立，且是「每轮必崩」

**代码事实**

- `plugins/dsh-linux-bootstrap/src/index.js:10`：`export const inject = ['linuxPluginHost', 'linuxBootstrapConfig']`——没有 `filesDir`。
- 同文件 `:589`：`const filesDir = config.filesDir ?? ctx.filesDir ?? process.env.DSH_FILES_DIR`。
- 同文件 `:590-591`：`dataDir` 本来就有 `config.dataDir ?? hostConfig.dataDir ?? …` 两级回落。
- 宿主 `plugins/dsh-android-linux-env/src/index.ts:355-361` 只 `provide` 了 `linuxPluginHost` 和 `linuxBootstrapConfig`，**全仓没有任何 `provide('filesDir', …)`**。
- Cordis 的 getter 在 `.deploy-tmp/engine-021rc2/.../@deepseek-ai/cordis/lib/index.js:676` 直接 `throw new Error('cannot get property "filesDir" without inject')`；插件 fiber（`fiber.runtime` 非空）走的是抛错分支，不是 `ctx.reflect.get` 的可选回落。

**关键点**：`??` 是短路的。`config.filesDir` 为 `undefined` 时先去求值 `ctx.filesDir`，**根本轮不到**已经存在的 `process.env.DSH_FILES_DIR`。所以「环境变量明明有」并不能救它。

**本机复现（真实 Cordis，非 mock）**

用 `.deploy-tmp/engine-021rc2` 里的 cordis 0.2.1-rc.2 包搭最小上下文，只 `provide` 宿主今天真正提供的那两个服务，然后 `app.plugin(bootstrap)`：

```
RESULT: activation threw -> cannot get property "filesDir" without inject
CONTROL: plain-object ctx threw -> releaseUrl or manifestProvider is required
```

对照组说明：把 ctx 换成普通对象（现有集成测试的做法）时，`ctx.filesDir` 只是 `undefined`，**不会抛**，`apply()` 能继续往下走。这正是测试全绿、设备必崩的分界。

**比原报告更严重的一点**

`scripts/profile-web.cordis.patch.yml:86-89` 在**出厂装配清单里无条件插入** `linux-bootstrap`（没有 `disabled`），`build-apk.mjs:310-316` 会把它随快照打进所有 profile。所以在本仓这个版本上：

> 503 不是「插件没启用」，而是「插件被装载后在 `apply()` 崩了」。

原报告说「文案把人引向『需要显式启用』，实际是插件崩了」——完全正确；而且在这个版本里，**那条文案永远不可能准确**，因为不存在「未启用」的 503 分支（除非用户手工改 profile）。`docs/AGENTS/BRIDGE-API.md` 与 AGENTS.md 里「默认不启用」的口径也需要区分：bootstrap 是默认装载的，默认不启用的是 **runtime/安装动作**。

**可用的临时绕法（不是修复）**

因为 `config` 来自 profile 条目，给它加 `config: { filesDir: '/data/data/<pkg>/files' }` 就能短路掉 `ctx.filesDir`，让插件激活。这只能绕过 ①，②③④⑤ 一个不少；而且它会把真实问题藏起来，不建议作为交付。

---

### 2.2 ② 硬链接路径规范化：成立，且是「必中」而非「可能」

**代码事实**（`plugins/dsh-android-linux-env/lib/linux-host-asset-io.js`，与 TS 源同构）

```js
const root = resolve(destination);                     // 202 行：纯词法，不解析符号链接
...
const sourceInfo = await lstat(entry.source);
const physical = await realpath(entry.source);          // 204 行：解析到物理路径
if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !physical.startsWith(root + sep))
  throw new Error('Archive hard link must target an extracted regular file');  // 206 行，恒触达
await link(entry.source, entry.target);                 // 208 行
```

**为什么设备上必中**

本仓自己的坑位已经把这个模式写死了两次：

- `docs/AGENTS/gotchas.md:10`（坑 1）：「Android 上 `/data/user/0` 可能是 `/data/data` 的软链——只把文件侧 realpath 后再与未 realpath 的 ws 比较必拒。**新路径校验代码一律双侧规范化。**」
- `docs/AGENTS/gotchas.md:142`（坑 67）：「Android 把 `/data/user/0` 解析为 `/data/data`，只做一侧会永远拒绝。」

`DSH_FILES_DIR` 来自 `EngineManager.shellEnv()` 的 `context.filesDir.absolutePath`（`EngineManager.kt:2326`），不经过 canonical 化；而 `extractVerifiedArchive` 的 `destination` 是 `<DSH_FILES_DIR>/linux-environment/...`。只要 `absolutePath` 与 `realpath` 不同形（无论是哪个方向），`startsWith(root + sep)` 必为 false。这不是「概率问题」，是这条路径的固有行为。

**本机复现（Windows junction，与 Android 的目录别名同构）**

造一个 `real\`，再建 junction `alias -> real`；用 Python 生成含 `./` 根目录、`./file`、`./copy -> ./file`（`LNKTYPE`）的 tar.xz；`filesDir` 分别用 alias 与 real 调用真实 `createHostAssetIO().extractArchive`：

```
ALIAS:   extractArchive threw -> Archive hard link must target an extracted regular file
CANONICAL: extractArchive succeeded; hard link preserved = true
```

第一行与设备上那句错误逐字相同；第二行证明归档本身合法、硬链接语义正确，问题只在路径比较。

**修复方向**

- 起点就规范化：`root = await realpath(destination).catch(() => resolve(destination))`（destination 是刚校验过的空目录，realpath 安全）；或按原报告那样保留 `root`、额外算 `rootCanonical` 只用于比较。
- **不要**只把 `physical` 改成词法路径——那会削弱越界防护。
- 顺便把 `safeParents` / `resolveInside` 的路径基准统一到同一个 `root`，避免同一个函数里两种写法。

---

### 2.3 ③ 硬链接被拒：结论成立，**真因不是 f2fs**

原报告写：「本机 app 数据分区（f2fs）不允许创建硬链接（不是 SELinux 的 exec 问题，普通 `ln` 也拒绝）」。

这个归因不成立，理由有三：

1. **f2fs 本身支持硬链接**（POSIX 文件系统的基本能力），「f2fs 禁硬链接」在文件系统层面没有依据。`stat -f -c %T` 只证明了分区类型，证明不了「该类型不支持 link」。
2. 本仓已把这件事实登记过两次，且明确归因 SELinux/应用域：
   - `docs/AGENTS/gotchas.md:126`（坑 66）：Android 应用域禁 `link(2)`；
   - `docs/AGENTS/gotchas.md:635-636`（坑 171）：「Android 应用域 SELinux 拒绝 hardlink（`EACCES`，denial 被 dontaudit 静默）——与坑位 #77 同一 sepolicy 限制的第 4 个站点。」
   - 坑 171 的现象与本报告完全同型：覆盖已有文件正常（走 `rename`），**新建**走 `link(2)` 就 `EACCES`。
3. 上游 bionilux 自己的设备记录（`.deploy-tmp/linux-runtime-source/docs/STATUS.md:122-126`）写的是：
   > 「创建硬链接一律 `EPERM` | **设备策略（连 App 自己的私有目录也一样）** | `link`/`linkat` 回退为复制；dpkg 依赖此」

   「设备策略」而不是「f2fs 不支持」，且发生在 app 私有目录——与 SELinux 拒绝一致。

**为什么要较真**：如果按「f2fs 不支持」去修，容易得出「换分区/换路径就好」的错误结论；按「应用域策略恒拒」去修，才会得到正确的通用做法——**任何 `link(2)` 站点都必须有复制兜底**，而本仓已经有三个同族先例（`fs-local-link-F8`、`spj-migration-link-F5`、`attach-durable-F2`，见 `docs/AGENTS/RUNTIME-PATCHES.md:123-155`）。`linux-host-asset-io.js:208` 是**第 4 个裸 `link(2)` 站点**，且是 2026-10-18 离线资产接线时新引入的——属于对既有规则的回归。

**错误码集合**：设备上可能是 `EACCES`（SELinux）或 `EPERM`（ROM/策略），两者都要接；原报告列的 `EPERM/EACCES/ENOTSUP/EXDEV/ENOSYS` 是合适的。兜底不要用裸 `rename`（会丢 no-replace 语义，虽然这里目标是新建目录、风险低），**复制**是语义等价的（hardlink 退化为独立 inode，仅多占 ~4 MB；dpkg/apt 不依赖 link count）。

---

### 2.4 ④ 宿主准备脚本被剥 termux-exec：成立；机制要再拆一层

**代码链路（全部确认）**

- `vendor/dsh-linux-runtime/modules/manager.js:19-42`：`HOST_ENV_ALLOWLIST` 不含 `LD_PRELOAD`、`TERMUX_EXEC__*`。
- 同文件 `:369-375`：`cleanHostEnvironment()` 只拷贝白名单变量。
- 同文件 `:722-737`：`_prepareRootfs()` 以 `file:'sh'`、`env: cleanHostEnvironment()` 调用 `_runManaged`。
- 同文件 `:213-221`：`spawnCommand()` 把 `spec.env` **显式**传给 `spawn`；不传就继承宿主 env。
- `vendor/bionilux/scripts/prepare-rootfs.sh:62`：`links=$(find "$ROOTFS" -type l)`——`find` 按 `PATH` 解析；引擎的 `PATH` 是 `<files>/usr/bin:/system/bin`（`EngineManager.kt:2298`），所以先命中 app 私有 ELF。
- `EngineManager.kt:2336-2338` 给引擎进程注入了 `LD_PRELOAD=<prefix>/lib/libtermux-exec-ld-preload.so`、`TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`、`TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1`。

**失败机制（比「env 被剥」更精确）**

1. `node` 进程自身带着 termux-exec 的 preload（`fork` 后映射仍在），所以 `spawn('sh')` **第一次** exec 会被 hook 改写成 `/system/bin/linker64 <prefix>/bin/bash`，`sh` 能起来。
2. 但传给子进程的 `env` 是 `cleanHostEnvironment()`：`bash` 自己的 `environ` 里没有 `LD_PRELOAD`/`TERMUX_EXEC__*`，于是 bash 再 exec `find` 时**没有 hook**，内核直接 exec app 私有 ELF → `EACCES`。
3. 这与报告看到的 `prepare-rootfs.sh[62]: .../usr/bin/find: Permission denied` 完全吻合。

**对报告表格的一处修正**

报告写「`spawn(file, args, { env })` 显式传 env（哪怕 env 里带 `LD_PRELOAD`）→ app 私有 ELF 一律 `EACCES`」。这句话如果字面成立，会推翻「只要把 trio 传进去就好」的修法。更可能的解释是：那轮实验只补了 `LD_PRELOAD`，**没补 `TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`**，而 `EngineManager.kt:2334-2335` 的注释明确说 force mode 是必需的（hook 默认只对 `untrusted_app_25/27` 域改写）。若把三项一起传，`bash` 及其子进程都应被改写，`find` 应能经 linker64 启动。

> 这一点**必须设备复验**才能定论（见 §5 实验 4）。在定论前，最稳的修法不是调 env，而是**让准备脚本完全不依赖 app 私有 ELF**。

**推荐修法（按稳健度排序）**

1. **系统 toybox 路线（最稳，无需 env）**：`/system/bin/sh` + `PATH=/system/bin`。toybox 自带 `find/readlink/dirname/stat/chmod/ln/mkdir/wc/sed/awk`；报告已实测「正常」。脚本里的 `pwd -P`、`ln -sfn`、`stat -c %a` 都在 toybox 能力内。这一改可以落在宿主 `runCommand`（热推 JS），也可以落在 `prepare-rootfs.sh`（需新 runtime 资产）。
2. **宿主侧 `runCommand`，只对 `spec.file === 'sh'` 生效**：显式 env = `{...spec.env, LD_PRELOAD: <preload>, TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE:'force', TERMUX_EXEC__EXECVE_CALL__INTERCEPT:'1'}`，并保持 `spawnCommand` 的捕获上限（256 KiB/流）、`TERM`→1.5 s→`KILL`、进程组语义。
3. **不要让 trio 进全局 allowlist**：`cleanHostEnvironment()` 同时服务 guest `execute()`（`manager.js:944-958`）。把 trio 加进白名单会让 guest 的 bionilux 也带上 termux-exec，而报告 §6 已实测过：termux 拦截会把 bionilux 的 `execve(glibc loader)` 改写成 `linker64`，直接触发 `Could not find a PHDR`。还会破坏 `vendor/dsh-linux-runtime/test/manager.test.mjs:508-521` 明确断言的「guest env 派生、不继承宿主」不变量。

**对报告补丁 4a 的一个安全提醒**

报告用 `spawnWithoutExplicitEnv()` 把 `spec.env` 临时并进 `process.env` 再 `spawn`。如果这个 `runCommand` 被注入给 manager 的所有 `_runManaged`（包括 `execute()` 的 guest 命令），子进程会继承**整个宿主 env**——包括 `DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`、`DSH_PICK_TOKEN` 等（`EngineManager.kt:2354-2360`）。这与 manager 的设计意图和现有测试直接冲突。正确做法是**只在 host-prep 的 `sh` 分支**构造 env，guest/bionilux 分支保持原样；或者干脆走上面的 toybox 路线。

---

### 2.5 ⑤ bionilux 启不动 glibc guest：成立，但「Android 10+」这个范围要收窄

**代码事实**

- `manager.js:541-567` 的 `_probeRuntime()` 是安装提交前的强制门：`launcher node --version`，10 s 超时，stdout 必须匹配 `^v\d+\.\d+\.\d+…`。
- `manager.js:816-873` 的顺序：解 node → 解 backend → 解 rootfs → `prepare-rootfs.sh` → 写 metadata → rename → 结构健康检查 → **probe**。probe 失败 → 整个 staged instance 清理，保留旧 active。
- `vendor/bionilux/src/launcher/exec.rs:46-84`：对 glibc 目标，`exec_target` 是 **glibc loader**（`ld-linux-aarch64.so.1`），最终 `execve(exec_path, …)`；失败时打印 `[ERROR] execve failed: …`、`EACCES` 映射 exit 126。
- `vendor/bionilux/src/preload/hooks.c:583-592`：preload 的 `execve` hook 只是把目标**重定向到 bionilux launcher**，最终仍然要 `execve(glibc loader)`——没有 ptrace、没有用户态映射（`exec.rs` 注释也写明「for a glibc target this is the loader」）。
- 构建脚本 `scripts/source-build/build-linux-assets.sh:42-48` 产出的是 **bionic 链接的 bionilux**（`aarch64-linux-android24-clang` + `/system/bin/linker64`），glibc guest 是另一侧的 ELF。

**为什么这是硬限制**

本 app 的 SELinux 域是 `untrusted_app`（targetSdk 34，`app/build.gradle.kts:19`）。该域对 `app_data_file` 没有 `execute_no_trans`，所以**内核 exec app 私有 ELF** 被拒（`EACCES`，且常被 `dontaudit` 静默）。termux-exec 的 force 模式能把 **bionic ELF** 改写成 `linker64 <elf>`（引擎 node、termux 工具都靠它），但 glibc loader 不是 bionic linker 能加载的对象——报告实测的 `Could not find a PHDR: broken executable?` 正是这条路走不通的证据。

**关键补充：上游 README 的「V2425A 已验证」不能当作 app 域可用的反证**

`.deploy-tmp/linux-runtime-source/ORIGINAL-REPORT-2026-10-19.md:17` 写「已在真机 arm64（vivo V2425A，Android 16 / SDK 36，SELinux enforcing，无 root）验证」。但它的设备验收脚本 `tests/acceptance.sh`：

- `:140-148` 用 `"$ADB" shell …` 直接在设备上执行 `LAUNCHER`；
- `:205-210` 的前置检查也是 `adb shell "test -x <launcher> && test -d <rootfs>"`；
- `:226-227` 明确把「设备宿主根」定为 `/data/local/tmp`。

也就是：这套设备验收跑在 **shell 域（uid 2000，`/data/local/tmp`）**，不是我们 app 的 `untrusted_app` 域。`shell` 域可以 exec `/data/local/tmp` 下的 ELF，所以 bionilux 能工作；这恰好解释了为什么「同一台设备、同一份 bionilux，shell 域能用、我们 app 里不能用」。

上游自己的 `docs/STATUS.md:122-126` 也把「硬链接一律拒绝」记为**设备策略**（EPERM），进一步说明这台机器的策略比通用 AOSP 更严。

**精确表述**（建议在上游 issue 里这样写）

> 不是「Android 10+ 一律不能跑 glibc guest」，而是「**targetSdk ≥ 29 的 app 域（`untrusted_app`）不能内核 exec app 私有 ELF**；bionilux 的 glibc loader 启动必须走内核 exec，所以在我们的 app 内必失败。Termux（targetSdk 28，`untrusted_app_27`）或 `adb shell` 域不受此限。」

**不要在 ⑤ 上做的两件事**

1. **不要放宽/绕过 `_probeRuntime`**。`manager.js:960-982` 的 `execute()` 走的是同一条 `launcher …` 路径；probe 放过只会把失败推迟到用户第一次 `linux_bash`，而且会先花掉 ~60 MB 的 rootfs 解包。
2. **不要用「加 termux 拦截」救**。报告已实测 `PHDR`；而且它只对 bionic ELF 有效。

**真实可选方向**

- **上游 bionilux 加 proot 式 fake-exec**（ptrace 截获 `execve`，用户态加载 glibc loader）——这是 Termux `proot-distro` 在 Android 10+ 跑 Debian 的关键；
- **改用 proot 后端**：快照目前**没有** `proot`（`scripts/snapshot-config/preinstall.json` 未列），需要新增资产与一套 rootfs/命令适配；
- **放弃 glibc Debian 路线**，只保留 bionic 工具链——但这样 `apt/dpkg` 等 Debian 用户空间就跑不了，「Linux 环境」的核心卖点消失；
- **能力探测 + 明确不支持**：安装前先做域/exec 探测，直接给「本应用当前不支持该运行时」的稳定错误码，而不是解包 60 MB 后失败。这是产品决策，不是修复。

---

### 2.6 ⑦ 可观测性：成立，且 503 文案比报告说的更失真

**三层问题**

1. **激活崩溃无处落盘**：`apply()` 抛错时服务根本不存在，`linux-bootstrap` 的 `save()` 路径压根没执行。这不是「catch 里少一个 `save()`」，而是「激活失败」在 HTTP 面没有表达。要靠 loader/插件管理器的激活错误可见性，或宿主在 `linuxBootstrap` 缺席时读 engine.log 的激活错误做归因。
2. **安装失败不落盘**：`plugins/dsh-linux-bootstrap/src/index.js:401-412` 的 catch 只 `state.lastError = safeError(error); emit()`，没有 `await save()`。重启后 `lastError` 丢失；而路由 catch（`linux-environment.ts:373`）固定回「Linux 环境操作失败，请检查环境状态与日志后重试」，连内存里的 `lastError` 都没回给前端（`normalizeLinuxStatus` 的 `error` 字段只在独立的 `status` GET 里出现，`linux-environment.ts:275`）。
3. **503 文案与装配事实矛盾**：见 §2.1——bootstrap 在出厂 profile 里默认插入，503 实际是激活崩溃。`BRIDGE-API.md` / AGENTS.md 的「默认不启用」应区分「bootstrap 装载」与「runtime 安装/启用」。

**建议**（下一轮再做）

- install/reinstall 的 catch 补 `await save()`；
- 路由 500 带**稳定错误码**（如 `linux-activation-failed` / `linux-rootfs-extract-failed` / `linux-runtime-probe-failed`）+ 脱敏短原因，而不是固定一句；
- 503 分两种：`linuxBootstrap` 缺席时，优先读 engine.log/loader 状态判断「激活失败」，文案改成「内部插件激活失败（见日志）」；只有确实不在装配清单时才说「未启用」；
- 前端面板按错误码显示「下一步」，不要把 500 一律显示成「请重试」。

---

## 3. 为什么 CI/单测全绿，设备一装就炸

这不是「测试不够多」，而是每条缺陷都恰好落在测试的盲区里：

| 缺陷 | 测试盲区 | 具体位置 |
|---|---|---|
| ① | **server 的 `apply()` 从未在真实 Cordis 下运行** | `plugins/dsh-android-linux-env/test/offline-install-integration.test.mjs:144` 直接 `createBootstrap({...})`，绕过 `apply`；`plugins/dsh-linux-bootstrap/test/` 只有 client apply（`client-http.test.mjs:13`），没有 server apply |
| ② | 临时目录是 **canonical 路径**，没有「别名根」用例 | 同上 `:20` 的 `mkdtemp`；`linux-host-asset-io.test.mjs` 无 symlink/junction 根 |
| ③ | 解包测试是 **posix-only**，Linux ext4 上 `link` 成功，还断言 inode 相等 | `offline-install-integration.test.mjs:38-48`（`:46` 断言 `ino` 相等）；Windows 上整条 skip |
| ④ | `runCommand` 被替换成 **fake runner**，真实 spawn/env 从未执行 | 同上 `:135-138` 的 `nativeRunner`，`:144` 注入 |
| ⑤ | probe 在 fake runner 下永远返回 `v24.22.0`；真实 ARM64 资产从未在本机跑 | 同上；且 `known-gaps.md:103` 已明写「设备验收尚未执行」 |

**根因不是「忘了写测试」，而是「测试用替身替掉了出问题的那一层」**：Cordis 代理、真实 spawn、真实文件系统策略、真实 ARM64 ELF。原报告说「本机所有临时补丁已验证到只剩 smoke probe」，这个「验证」也是同类替身验证——它能证明逻辑走到哪一步，不能证明设备能完成。

---

## 4. 修复可行性矩阵（只评估，未实施）

| 缺陷 | 落点 | 能否热推（不打包） | 是否需新资产/APK | 门禁影响 | 主要风险 |
|---|---|---|---|---|---|
| ① | `plugins/dsh-linux-bootstrap/src/index.js`（vendored） | 可以（改 `lib/` 后热推） | 否 | **会撞** `scripts/check-vendored-linux-bootstrap.mjs` 的 `LOCAL_PATCHES` 摘要，需同步更新（或上游修） | 低；删掉 `ctx.filesDir` 即可，`dataDir` 已有回落 |
| ② | `plugins/dsh-android-linux-env/src/linux-host-asset-io.ts` | 可以（宿主插件 JS） | 否 | 现有单测不覆盖；建议补「别名根」正控 | 低；规范化起点即可，注意别削弱越界检查 |
| ③ | 同上（`link` 兜底） | 可以 | 否 | 同上；建议补「link 抛 EACCES」的受控负控 | 低；复制等价，注意 `chmod` 保留 mode + `COPYFILE_EXCL` |
| ④ | 首选：宿主 `runCommand`（`createLinuxBootstrapConfig().runtimePluginConfig`）；次选：`prepare-rootfs.sh` 改系统 toybox | 宿主侧可以 | 脚本改则需 **新 runtime 资产**（CI） | 无 | 中；**不要把 trio 加进全局 allowlist**，不要让 `runCommand` 把宿主 env 泄给 guest；保持 `spawnCommand` 的上限/终止语义 |
| ⑤ | bionilux 上游（proot 式 fake-exec）或换 proot 后端 | **不可以** | 是（后端 + 资产 + 协议） | 无 | 高；设计级，不能靠 JS/配置修 |
| ⑦ | bootstrap catch + `linux-environment.ts` 路由 + 前端 | 可以 | 否 | 无 | 低；注意错误码与脱敏 |

**发布口径建议**

- ①–④ 修完后，安装会推进到 ⑤ 并失败；此时**不要**对外宣称「Linux 环境已修复/可用」，最多写「安装链路已修到平台 exec 限制处」。
- ⑤ 未解决前，建议加**安装前能力探测**（域 + `exec` 探测），直接返回稳定错误码，避免 60 MB 解包 + 30 s 等待后失败。
- 所有修复都要补**真 Cordis + 真实 spawn + 别名根 + link(EACCES) + probe 域对照**这五类反证，否则同类缺陷还会再回来。

---

## 5. 建议的设备复验实验（不改代码，按变量分离）

> 前提：真机 V2425A 可用；每一步都在临时目录，不污染用户数据。

1. **① 归因**：`grep -n "did not activate\|without inject" <files>/engine.log`；再把 profile 里 `linux-bootstrap` 的 `config` 加上 `filesDir: <files>` 重启，确认 503 消失、`files/linux-environment/` 出现——证明「崩溃」而非「未启用」。
2. **② 方向**：在 engine 进程的 env 下比较 `path.resolve(DSH_FILES_DIR)` 与 `fs.realpath(DSH_FILES_DIR)` 的字符串；预期两者不同形（`/data/data` ↔ `/data/user/0`）。这能一锤定音，不用猜方向。
3. **③ 错误码**：在 app 私有目录 `ln a b`，记录 `errno`（EACCES vs EPERM）；再 `stat -f -c %T` 确认 f2fs。**f2fs 支持硬链接**，所以 `stat -f` 不是原因证据；若能看到 `avc: denied { link }`（可能需要 `dmesg`/root）即可坐实 SELinux，否则以「设备策略」表述。
4. **④ 三变量分离**（同一脚本，三次 spawn）：
   - A：不传 env（继承）→ 预期成功；
   - B：显式 env + 只加 `LD_PRELOAD` → 报告说失败；
   - C：显式 env + `LD_PRELOAD` + `TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force` + `TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1` → **本轮最需要的新数据**；若成功，说明原表格的结论只是缺 force mode；
   - D：`/system/bin/sh` + `PATH=/system/bin` → 预期成功（toybox 路线）。
5. **⑤ 域对照**（关键）：
   - 同一份 bionilux + rootfs 放到 `/data/local/tmp`，`adb shell` 执行 `bionilux node --version` → 预期成功（上游已验证的正是这个域）；
   - 同一份资产在 app 内（probe）→ 预期 `EACCES`；
   - 若 A 成功 B 失败，就坐实「域限制」，而不是「bionilux 坏了」或「Android 版本限制」。建议开 `BIONILUX_DEBUG=1` 保留 `execve:` 行。

---

## 6. 建议登记的文档项（本轮未改，供下一轮）

- `docs/AGENTS/gotchas.md` 文末追加（编号递增，不重编号）：
  - 「Cordis 插件读未 inject 的 `ctx.filesDir` → 整插件不激活，路由全 503」；
  - 「解包器硬链接只 realpath 一侧 → 别名根恒拒（坑 1/67 的第 N 个站点）」；
  - 「`cleanHostEnvironment` 同时用于 host prep 与 guest exec → host prep 缺 termux-exec」；
  - 「bionilux 的 glibc loader 依赖内核 exec；app 域（targetSdk 34）不可用，shell 域可用」。
- `docs/AGENTS/known-gaps.md`：把 §「Linux 内部插件」从「设备验收尚未执行」更新为「已有真机证据：①–④ 已定位、⑤ 为硬阻塞」，并链接本报告与原报告。
- `docs/AGENTS/changelog-archive.md`：一行摘要（若本轮只调查则可不写版本条目，按仓库惯例）。
- `docs/AGENTS/BRIDGE-API.md` 与 AGENTS.md：修正「bootstrap 默认不启用」的表述（默认装载的是 bootstrap；默认不启用的是 runtime/安装），与 `profile-web.cordis.patch.yml:86-89` 对齐。
- `scripts/check-vendored-linux-bootstrap.mjs`：若在 vendored 树里修 ①，更新 `LOCAL_PATCHES` 的 `src/index.js` 摘要；若走上游，保留现状。

---

## 7. 一句话总结

> 原报告把「点了没反应」追到「插件激活崩溃」是准确的；② 的路径规范化、③ 的硬链接兜底、④ 的宿主 env 都是真 bug，且都能在本仓修复。但 ③ 的真因是 Android 应用域/SELinux 拒绝 `link(2)`，不是 f2fs；⑤ 也不是「Android 10+ 一律不行」，而是「本 app 的 `untrusted_app` 域不能内核 exec app 私有 ELF」——上游在同一台机器上的设备验收脚本走的是 `adb shell` 域，不能拿来当反证。**①–④ 修完仍会停在 ⑤；在 ⑤ 有后端方案之前，这个功能不构成「可安装」。**

---

## 附录 A：本机复现记录（只读项目，写入均在临时目录）

### A.1 真实 Cordis 激活复现

- 环境：`.deploy-tmp/engine-021rc2` 内的 `@deepseek-ai/cordis` 0.2.1-rc.2（`lib/index.js:676` 的那份），拷贝到临时 `node_modules` 以解析 `@deepseek-ai/cosmokit`、`@standard-schema/spec`。
- 上下文：`app.provide('linuxBootstrapConfig', {dataDir})` + `app.provide('linuxPluginHost', {install})`，与 `plugins/dsh-android-linux-env/src/index.ts:355-361` 一致。
- 结果：

```
RESULT: activation threw -> cannot get property "filesDir" without inject
CONTROL: plain-object ctx threw -> releaseUrl or manifestProvider is required
```

### A.2 硬链接别名根复现

- 目录：`<temp>\hl\real` + junction `<temp>\hl\alias -> <temp>\hl\real`。
- 归档：Python `tarfile` 生成 `./` 根目录 + `./file` + `./copy`（`LNKTYPE -> ./file`），`lzma.compress(FORMAT_XZ)`。
- 调用：真实 `createHostAssetIO({filesDir}).extractArchive(archive, dest, {kind:'rootfs'})`，两份文件分别走 alias 与 real。
- 结果：

```
ALIAS:     extractArchive threw -> Archive hard link must target an extracted regular file
CANONICAL: extractArchive succeeded; hard link preserved = true
```

> 上述脚本与临时树在 `本机临时目录（不入仓）`，是丢弃式证据；项目工作树 `git status` 未被本次调查改动（仅读）。

---

## 附录 B：2026-10-19 实机补充（修正 §2.5 的域归因）

实机 agent 的三组对照与挂载检查，把 ⑤ 的归因从「SELinux/域」改为「挂载标志」：

- 本 ROM 把 `/data/data` 单独挂成 `tmpfs rw,nosuid,nodev,noexec`；`EACCES` 来自 `do_open_execat()` 的 `MNT_NOEXEC`，发生在 SELinux 之前。因此 **不是 targetSdk，也不是 `untrusted_app` 域**。
- `env -i /system/bin/sh -c 'exec $P/usr/bin/node --version'` → `126 EACCES`；`linker64 <bionic node>` → 成功。`env -i` 清掉了 termux-exec 的 `LD_PRELOAD`/`TERMUX_EXEC__*`，所以 probe 退化成裸 `execve`。
- `ptrace` PoC 通过（`SEIZE OK`），W1/W2 的能力前提成立。

**但这不等于「bionilux 原样可用」**：agent 测的 `$P/usr/bin/node` 是 **bionic** v24.18；runtime 的 guest node 是 **glibc** v24.22，bionilux 必须 `execve` glibc loader，而 `linker64` 不能加载 glibc loader（此前 `PHDR` 实测）。因此：

- 把 probe 改成 `linker64 <P/usr/bin/node>` 会造成 **假绿**：安装通过，`linux_bash` 仍失败。
- 仍需验证 **bionilux → glibc guest**；最小候选是 W5：把 glibc loader 放到非 noexec 且 app 可 exec 的路径，用 `BIONILUX_LOADER` 指向它；不通再走 W2 fake-exec / W1 proot。

计划中的 §10 S2 与 WP-6 已按此更新；本报告 §2.5 的「Android 10+/域限制」结论以附录 B 为准。

---

## 附录 C：2026-10-19 第二轮实机（W5 失败，路线改为 W3-lite/W2）

第二轮把 W5 跑完，结论是**结构性失败**，不是“再修一版”：

- guest node 确认为 **glibc v24.22.0**（interp `/lib/ld-linux-aarch64.so.1`），不是 bionic；
- bionilux 本身能启动（bionic 0.4.2），卡在**子进程** `execve(ld-linux-aarch64.so.1)` → `EACCES`；
- 保留 termux trio 时，PHDR 也发生在子进程 exec loader，而不是 bionilux 启动；
- **`BIONILUX_LOADER` 不存在**，二进制里只有 `BIONILUX_PRELOAD`；
- 非 noexec 落脚点矩阵：`/data/local/tmp`、`/dev/shm`、`/tmp`、`/cache` 可 exec 但 app 不可写；`/sdcard` 可写但 FUSE noexec；app 私有目录全部 noexec。**任何仍 `execve(loader)` 且 loader 在 app 私有的变体都会 EACCES。**

因此计划改为：

1. **W3-lite**（若 APK native lib 或 `/data/local/tmp` 对 app 可 exec）：一次性把 loader 放到非 noexec 路径，app 侧 bionilux 使用它；先测 read/traverse/exec 与 bionilux 是否接受 rootfs 外 loader（没有 `BIONILUX_LOADER`，需要 symlink 或最小补丁）。
2. **W2a memfd**（纯 app）：把 loader 写入 `memfd_create` 的匿名文件再 `fexecve`，可能绕过 noexec；先做最小 PoC。
3. **W2b fake-exec**（纯 app）：ptrace 已验证可用；截获 bionilux 的 `execve(loader)`，mmap loader 后跳 entry。
4. **W3 全量（shell 域，最稳妥）**：rootfs/loader 放 `/data/local/tmp`，以 shell 域跑 bionilux；这也最接近上游 V2425A 验证的环境。代价是 rootfs 不再 app 私有、需要 Shizuku。
5. **W1 proot**：注意 **proot 不天然绕过 noexec**——它是 ptrace chroot，最终仍让内核 exec guest loader；只有 rootfs 在非 noexec 路径（W3）时才有意义。不要把它当作纯 app 的万能解。
6. **W4 bionic-only** 作为最后后备。

**稳妥策略**是分层：Tier 0 原生 bionilux（标准设备）→ Tier 1/2 外部 loader（本机最便宜）→ Tier 3 shell 域（本机最可能成功）→ Tier 4 W2b（纯 app 的用户态 loader）→ Tier 5 bionic-only/不支持。能力探测选择 Tier，不硬编码单点 hack。

测试边界：这轮资产是手动解到 `~/tmp/lx`，没有安装运行时插件槽位；exec 结论有效，完整安装链 ①–④ 仍需单独验收。



