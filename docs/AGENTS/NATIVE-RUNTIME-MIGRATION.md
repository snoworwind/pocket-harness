# 脱离 Termux 的 Linux 运行时实验账本

用户在 2026-11-12 明确的最终约束：**实验分支，不合并 main；免 Root；摆脱 Termux；
完整 Linux/glibc 用户空间；允许 PRoot 等兼容层；接受 Android 权限和路径限制。**
不要求 VM/QEMU 运行时，不把低 targetSdk 当作绕过限制的前提。
本分支可提交实验结果，不执行合并或正式发布。后续 PR 如有，只用于审阅与 CI，不自动合并。

组件来源按用户最终决定分为两层：宿主 PRoot/loader/talloc/libandroid-shmem 从固定源码
自编译并保留来源、补丁和工具链证据；客体统一使用 Debian apt 与 npm 的固定包，
不再要求客体组件自编译。发行版与 npm 预编译件如实登记，不称作本仓源码编译产物。
具体边界见下文“组件来源原则”。

目标结构：Android 壳直接启动 APK 安装到 `nativeLibraryDir` 的 PRoot/loader 及宿主依赖，
引擎、Node、shell、包管理器和开发工具统一运行在 Debian/glibc rootfs。
宿主可执行程序保持 ELF 入口，以 `lib*.so` 名称打包，不改成 JNI API；
**Linux 客体程序和共享库保留标准路径与 SONAME，不逐个改成 Android `.so`。**
PRoot 提供路径/系统调用兼容，不提供新内核或 Android 权限提升；允许 PRoot 后，
原计划“所有工具逐个改名进 APK 原生目录”收敛为“宿主代码进 APK，完整 Linux 工具留在 rootfs”。

“摆脱 Termux”的完成判据包括：不依赖 Termux App、bootstrap、包仓、私有前缀和
termux-exec 环境钩子。可审阅并借鉴开源 Android PRoot 补丁，但宿主后端必须建立本仓
固定源码/补丁/工具链的构建与来源证明，不能把使用 Termux 打包的 PRoot 原件称作已脱离。

## 当前交付状态

当前源码已将主引擎启动切换到 PRoot/Debian，并内置 rootfs、Node、引擎和 home 种子。
`38f8a9a2` 的来源构建已按用户要求停止，先修复启动与升级问题。修复已完成：
启动闸门改为 Linux 实例判据、缺件只修受管组件且 rootfs 保留、显式重置与原生数据导出、baseId 与
asset/磁盘摘要校验、journal 升级事务与隔离子客体试运行、home 只补缺失、旧 Termux 布局迁移与回收、
PRoot 的 /proc·PTY·link2symlink·canonical bind、`env -i` 后注入变量、包管理器 PATH/前缀/CA 统一、
旧快照代码与 Linux 设置页下载安装入口下线。Kotlin 1490 项与本地门禁通过；修复后的来源 APK 与设备验收尚未执行。
下列未完成项仍属本次迁移范围，不作为已交付或已验收功能。

| 阶段 | 交付物与完成判据 | 状态 |
| --- | --- | --- |
| P0 实际载荷盘点 | 扫 APK 原生目录和当前快照，支持独立 Linux rootfs/Node 目录；自证、负控；来源链携带报告 | 扫描器、自测与来源接线已实现；`186c7d55` ARM64 来源 APK 报告已生成，628 ELF/511 脚本，仍为 inventory-only |
| P1 独立 Linux 来源底座 | 固定 Debian snapshot 包闭包，当前客体仅 ARM64；源码构建 Android PRoot/loader，不再依赖 Termux bootstrap/包仓 | PRoot/loader/talloc/shmem 双 ABI 已实际自编译并过 ELF 门禁，已接入 Linux 资产和 APK 来源校验协议，完整 Linux 资产与 ARM64 来源 APK 已构建；AVD 首装、模型调用及重启恢复定向通过，其余待实现，见 [构建详档](PROOT-SOURCE-BUILD.md) |
| P2 壳直接引导 Linux | Kotlin 解包/校验/事务准备 rootfs；不能先起 Termux Node 才安装 Linux；宿主与客体 env 分开 | 已实现 `LinuxGuestBoot` 与 `LinuxInstanceInstaller`，壳首装直接解包并启动客体；rootfs 只铺底，更新仅替换受管 Node/引擎、补 home 种子并迁移；新来源 APK 设备复验待执行 |
| P3 引擎/工具统一迁入 Linux | DSH 与原生 addon 使用 Linux ABI；PTY、PTC、Undo、控制台、文件路径和插件桥统一客体启动合同，替代 shell-termux | 源码已切客体启动合同，已删除 Termux 引擎启动分支；npm 提供客体原生依赖，完整 APK 与设备行为待验 |
| P4 常用工具补齐 | 下表工具/helper/依赖通过 Debian apt/npm 固定包预装；用户可在客体安装依赖与编译，必须验证新产物实际可运行 | `guest-tools.json` 基线（76 包/55 条探针）已跑通：Debian 13 aarch64 根文件系统 1.2 GB，55/55 命令在客体解释器下返回版本；宿主 addon `flock` 交叉编译并在客体 Node 中 `require()` 成功 |
| P5 收口与平台验证 | 移除 Termux runtime/钩子/来源依赖；隔离旧数据并验证迁移，不原地覆盖用户树；双构建与设备证据 | 待实现 |
| P6 targetSdk 验证 | 保持当前高 target 验证，不回退到 28；后续提升 SDK 单独验证平台行为 | 待实现 |

本分支不进入正式版本发布流程，不以实验提交触发正式 Release。

2026-11-12 定向设备证据：来源 APK `186c7d55`、签名与实际工具调用结果见
[已知缺口的实验验证范围](known-gaps.md)；
原始证据入口 `.deploy-tmp/native-runtime-p0/resume-validation.md`。P0 盘点通过不表示宿主
ELF 已迁出快照，P1 的 AVD 探针通过也不替代 P2/P3 主启动链迁移。

现有可复用代码：`build-linux-assets.sh` 已构建 Debian 13 rootfs 与 Linux Node；
`prepare-proot-source-backend.py` 已从本仓固定源码构建回执组装 APK 内 PRoot/loader；`LinuxAssetIO` 提供宿主解包原语；
`vendor/dsh-linux-runtime` 有客体启动与安装事务逻辑。
当前 Android 宿主 PRoot/loader/talloc/shmem 从固定源码自行构建，不再消费 Termux
PRoot 二进制包；客体 Debian rootfs、Linux Node 和原生 npm 包使用有记录的包管理器输入。
Linux 已成为主引擎启动路径。旧快照刷新、RuntimeTree/PythonPackages 与 UI 入口仍待在
新 APK 验证后单独清理；不能仅凭源码切换宣称设备迁移完成。

## P2/P3 输入审计：客体 boot 需要哪些原生 addon（2026-11-12）

结论先行：**当前快照的 `node_modules` 不是按客体 ABI 组装的，直接拿它进 Debian/glibc 起
DSH 会在原生 addon 处失败。** 因此 P2 不能只写“Kotlin 起来跑 PRoot + 同一个引擎树”，
必须同时决定引擎树的组装目标。

已核实的事实与证据：

1. 引擎包在**构建宿主机平台**（linux-x64）上做平台过滤，`native/system/packages/linux-arm64`
   等可选依赖被判为 `Unsupported platform` 丢弃。以 `17d7ed22` 的完整来源链日志计，
   `Unsupported platform` 命中 361 行，其中 `linux-arm64` 一类即客体需要的预编译件。
   证据：`.deploy-tmp/native-runtime-p0/local-apk-source-chain-17d7ed22.log`
   （`grep -c 'Unsupported platform'` 与 `grep 'linux-arm64'`）。
2. Android 运行时侧观察到的 addon 行为是“**Bionic 降级**”而不是通用实现：
   `node-addon-require-builtin` 找不到 binding 回退 `require()`；
   `node-addon-system` 无 android-arm64 flock binding，被 stub 成立即成功。
   这两条出现在设备 `engine.log`，说明 addon 是按平台挑 binding 的，换到 glibc 会走不同分支。
3. 因此 P2 的“壳直接引导 Linux”若沿用现有快照树，最可能的结果是：PRoot 与 Node 起得来，
   引擎在加载 addon 或 `better-sqlite3` 一类原生模块时失败——这属于 P3 的范围，不能当作
   P2 验收通过。

选项 B 的首个可验证产物（2026-11-12）：`scripts/source-build/build-guest-addons.py` 已能从固定
harness 源码交叉编译 `@deepseek-ai/node-addon-system` 的 `flock`（glibc/aarch64），产物在
Debian 13 aarch64 的 Node v24.22.0 里 `require()` 成功并导出 `tryLock`，收据记录源码、头文件、
编译器摘要与 ELF 事实。尚未接入 Linux 资产打包，`landlock-run`（musl）与其余 addon 未完成。

对后续实现的要求（写入判断依据，不是承诺）：

- 客体引擎树需要**按 linux-arm64 目标单独组装**：保留该平台的可选依赖，或从源码为
  glibc/aarch64 重建这些 addon，并记录与 Android 树分开的来源与摘要。
- 同一份 APK 内可出现两套 addon 目录，但必须按 boot 模式显式选择，禁止“谁先找到用谁”。
- P2 的验收只覆盖“壳能在没有 Termux Node 的情况下解包、校验并启动客体 Node”，
  addon 全部可用属于 P3；两层证据分开记录。

## 组件来源原则（2026-11-12 用户定例）

**能用包管理器管理的，就不自己编译成原生库。** 宿主侧只有 PRoot/loader 及其 bionic 依赖
（talloc、libandroid-shmem）必须自编译并以 `lib*.so` 放进 `nativeLibraryDir`；客体侧
（引擎、node-pty、flock、gcc/python/git 等）一律来自 Debian apt 或 npm 固定版本包。
这样用户 `apt install` 的软件、包管理器的升级路径、以及 ABI/补丁兼容性都由 Debian 承担。

## 客体引擎树（2026-11-12 实测）

`package-guest-engine.py` 已能从 Android 引擎树装配出客体树：保留 JS、裁掉非 linux-arm64 原生变体、
保留 npm 提供的 `node-pty` linux-arm64 prebuild 与 `node-addon-system-linux-arm64`。
客体树必须在平台死重剔除之前装配。早期自编译件装配曾在 Debian 客体输出
`0.2.2-rc.1`；该历史烟测不替代当前 npm 组件 APK 的验证。

## 客体引擎依赖清单（2026-11-12 实测）

“DSH 跑在真正的 Linux 上”需要的不只是 Node，还包括 Node 侧原生模块与 shell：

| 组件 | 客体形态 | 状态 |
| --- | --- | --- |
| `@deepseek-ai/node-addon-system`（flock） | glibc/aarch64 `system.node` | 当前链使用 npm 平台包；早期自编译烟测不作为当前包证据 |
| `node-pty` 1.2.0-beta.15 | glibc/aarch64 `pty.node` + `lib/` | 当前链保留 npm linux-arm64 prebuild；自编译脚本仅为离线工具 |
| `node-addon-require-builtin` | 纯 JS（无原生二进制） | npm 包内只有 `lib/index.js`，降级路径可用 |
| bash / zsh / 其余工具 | Debian 13 包 | 55/55 探针通过，`aarch64-unknown-linux-gnu` |
| SQLite | Node 内置 `node:sqlite` | 无需 addon |

宿主侧可执行件（PRoot/loader/talloc/shmem）保持 `lib*.so` + `nativeLibraryDir`；客体程序保持
真实路径与真实文件名，不改成 `.so`（见坑位 685）。

## 参考实现与复用边界

查阅日期：2026-11-12。以下链接指向当时仓库默认分支，尚未冻结参考 commit；
当前扫描器为本仓独立实现，没有复制外部源码或二进制。真正复用前记录准确 commit、
文件、许可证、来源构建方法与差异，禁止直接以第三方 APK/预编译产物替代本仓来源链。

| 项目与证据 | 可参考部分 | 尚不能据此证明的部分 |
| --- | --- | --- |
| [dsh-for-android README](https://github.com/Windmill12/dsh-for-android/blob/main/README.md) | Node/bash/rg/Python 以 `lib*.so` 打包，命令链接，`native/jsrun.c` 脚本启动器；双 ABI 构建入口 | 本轮只读到文档与文件入口，源码页面未取全；文档明确没有 Git/C 工具链，不覆盖完整生态 |
| [termux_AI](https://github.com/WangChengYeh/termux_AI) | 大批 Termux 工具与依赖打包，安装期命令链接；rename 脚本及 TermuxInstaller 是后续复核入口 | 文档中任意脚本加 `.so` 后缀、无需 `lib` 前缀等说法不能直接采信；尚未源码/产物验证 |
| [KernelSU KsuCli.kt](https://github.com/tiann/KernelSU/blob/main/manager/app/src/main/java/me/weishu/kernelsu/ui/util/KsuCli.kt) | 已读源码，从 nativeLibraryDir 取 `libksud.so` 并作为程序调用 | Root 项目，不能证明普通 app UID 的工具链与嵌套执行可用 |
| [dsh-Go 构建配置](https://github.com/ccch1mneyyy/dsh-Go/blob/main/app/android/app/build.gradle.kts)、[架构](https://github.com/ccch1mneyyy/dsh-Go/blob/main/docs/architecture.md) | 已读原始配置：按 ABI 组织 runtime/out、PRoot/loader 原生打包、useLegacyPackaging；分层升级设计 | 当前明确 targetSdk=28，私有 rootfs 执行依赖此选择；不是 API 29+ 宿主原生执行迁移的完成证明。代码涉及 AGPL，借鉴设计与复制代码须区分 |
| [QwenchC/dsh-android](https://github.com/QwenchC/dsh-android) | 文档说明 Node/rg/bash 原生打包，以及 PTY helper、PTC 环境继承等查点 | 原生库仍保留在可写运行时树；不是所有原生代码都进入 APK 原生目录的方案 |
| [DSHA 构建配置](https://github.com/DSH-APP/DSHA/blob/main/app/build.gradle)、[运行引擎](https://github.com/DSH-APP/DSHA/blob/main/docs/runtime-engines.md) | 已读原始配置与 ProotBootstrap：PRoot/loader 原生打包、统一 RuntimeLauncher/RuntimeNativeFiles、客体与宿主区分、16 KB 原生会话启动器 | 所读 build.gradle 声明 targetSdk 37，但配置和文档带不同历史版本，不能代替当前 Release APK/设备证据；运行引擎文档明确 Standard PRoot 原件精确源码修订未核实，不能复制其预编译原件进入本仓来源链 |

Android 平台依据：[API 29 执行限制](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)、
[16 KB 页大小](https://developer.android.com/guide/practices/page-sizes)。
安装位置只是约束之一，还要验证 ELF/动态链接、SELinux、minSdk、ABI 与页大小。

## P0 使用与判据

```sh
python3 scripts/source-build/inventory-native-runtime.py --self-test
python3 scripts/source-build/inventory-native-runtime.py <已解包快照根> <树外报告.json> --abi arm64 --apk <对应APK>
python3 scripts/source-build/inventory-native-runtime.py <Linux根目录> <树外报告.json> --abi arm64 --layout linux-rootfs
python3 scripts/source-build/inventory-native-runtime.py <Linux-Node目录> <树外报告.json> --abi arm64 --layout linux-node
# x86_64 使用 --abi x86_64；自定义设备前缀用 --prefix <绝对usr路径>
```

来源链复用 `Snapshot semantic normalization digest` 已从本轮 APK 提取的树，在归一化后、
清理前调用扫描器，包含 injected-cache 命中路径；不追加全树解包，不修改快照。
报告为 `.deploy-tmp/source-build/native-runtime-inventory.json`，跟随 builder、verify、signer
三段 artifact 传递。`snapshotArchiveSha256` 绑定 APK 中快照成员的压缩字节，正式重签不改变它；
该摘要不等于整个 APK 摘要，后者仍由现有 `apk-sha256.txt` 管理。
`--apk` 假定调用者传入从该 APK 解出的树，扫描器本身不重新比对整树与归档。

报告包含：

- ELF 内容识别，不依赖扩展名/执行位；包括 `.node`、共享库、helper 和可重定位编译输入。
- ELF32/ELF64、小端、架构、类型、入口、解释器、DT_NEEDED/SONAME/RPATH/RUNPATH、
  PT_LOAD 对齐及可写可执行段。仅凭解释器/依赖作 Android、非 Android、未分类判别，
  未分类静态 ELF 不能据此宣布 Android 兼容；`elf16kAligned` 也不代表运行时页大小适配通过。
- 脚本 shebang、未知可执行文件、符号链接及词法解析状态；不跟随目录链接遍历树外文件。
  同一包的 `/data/data/` 与 `/data/user/0/` 前缀等价解析，旧 Termux 前缀不冒认成当前应用。
- 每个 ELF/脚本/未知可执行文件的摘要，以及按稳定相对路径排序的盘点摘要。
  数据文件不进入载荷摘要；`inventorySha256` 不是整树摘要。
- 原生 APK 成员的实际 ELF、摘要、压缩方式；与快照载荷分别登记。
  proposedApkName 使用相对路径完整 SHA-256 避免同名 helper 冲突，只是候选名。
  APK 可以没有 `lib/` 成员（旧 x86_64 产物即如此），此时如实报告空成员表；快照整体
  非空与必需程序判据仍执行。PRoot/JNI 缺件继续由其专用 APK 组装门禁负责。

阻断：空盘点、当前快照的 node/bash（rootfs 档为 bash，Node 归档档为 bin/node）
缺失/无执行位/非匹配 ABI 可执行 ELF、损坏 ELF 结构、
非法/重复/非普通文件 APK 原生成员、错 ABI、输入根为链接。自证包含相应受控负控。
其余缺失链接、未分类和非 Android 载荷均如实报告，不能误称它们已经迁移或可用。
报告 `phase=inventory-only`，快照动态 ELF `migrationStatus=pending`，ET_REL 为 `build-input`；
Linux 档使用客体根解析绝对链接，ELF 标为 `guest-payload`，不生成 APK 候选名。

扫描范围是展开后的文件树和 APK `lib/` 成员，不展开嵌套归档。
PRoot Linux rootfs/离线资产归档须在后续客体清单独立盘点，不能混为 Android 宿主代码。
P0 不会因为宿主 ELF 仍在快照内而判失败；清空宿主 ELF 的阻断条件在迁移完成后启用。

## 工具范围与后续设计约束

| 分组 | 纳入对象 |
| --- | --- |
| 迁入 Linux 的已有工具 | Node、bash/zsh、Python/pip、Ruby、Perl、rg、Git及 helper、BusyBox applets、GNU 工具、OpenSSL、socat、压缩解压与包管理入口 |
| 常用命令与客户端 | jq、SQLite CLI、OpenSSH、rsync、tmux、gh、PostgreSQL/MySQL 客户端、FFmpeg/ffprobe |
| 编译工具链 | Clang/LLVM/LLD/binutils、make、CMake、Ninja、pkg-config、Rust/Cargo、Go、Java/JDK |
| JS 开发命令 | tsc、ESLint、Prettier、Vite等脚本入口，以及实际引入的 esbuild 等原生子程序 |
| 独立浏览器 | Chromium/Playwright 类能力另立 Android 兼容实现查点；不能把桌面 ELF 改名当作完成 |

先确认每个工具的 Linux 来源、ABI、许可与完整闭包，再向预装清单加项；不把一个 CLI 启动成功
等同于其安装脚本、helper、插件、原生模块均可用。
P1 只对 Android 宿主依赖审阅 SONAME/版本名与 APK 打包转换，Linux rootfs 保留标准布局。
P3 必须覆盖 argv[0]/BusyBox applet、shebang/env、Node process.execPath/fork/worker、
旧 shell-termux 退出后的 shell 合同、PTC 环境擦除、Git exec-path、PTY helper、控制台和急救 CLI。

包管理器不得覆盖 APK 管理的宿主代码；Linux 包和原生扩展可以在客体内安装和编译，
要验证 apt/dpkg、pip 原生扩展、npm 原生 addon 及其嵌套子进程，不限制成只能装纯脚本。
不承诺 Android 禁止的系统服务/挂载/内核能力；编译器可启动不能证明新产物可运行。

## 验证与完成标准

P0 按 L1 执行自证和受控负控；ELF/路径判据调整按 L2 增补正反例。
后续启动和插件行为按 L3 提交相关单测与组件回归，代码/输入变化后重验关联证据。
开发 PR 不要求设备验收；正式 Release 按 `emulator-test-protocol.md` 执行最终源码 APK 的
代码/CDP/ADB 三层，未执行层不得记 PASS。

最终必须满足：无 Termux 运行时/来源包依赖、工具清单无缺项、宿主原生执行/加载不依赖
可写快照代码、Linux 客体原生安装与编译可用、双 ABI 产物可复核、
嵌套调用与升级恢复有证据；记录 APK/安装体积、启动耗时和内存成本。
回滚通过追加提交或独立 revert PR，禁止改写历史或发布不可追溯的临时二进制。
