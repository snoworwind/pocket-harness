# 脱离 Termux 的 Linux 运行时实验账本

用户在 2026-11-12 明确的最终约束：**实验分支，不合并 main；免 Root；摆脱 Termux；
完整 Linux/glibc 用户空间；允许 PRoot 等兼容层；接受 Android 权限和路径限制。**
不要求 VM/QEMU 运行时，不把低 targetSdk 当作绕过限制的前提。
本分支可提交实验结果，不执行合并或正式发布。后续 PR 如有，只用于审阅与 CI，不自动合并。

补充构建原则：随包交付的所有可执行程序及必要原生依赖以固定源码自行构建，保留可修改的
补丁、完整编译参数、来源和测试证据；先落实 PRoot/loader/talloc/shmem，再覆盖解释器、
Linux 用户空间与开发工具。预编译 NDK/编译器或发行版种子可作为有记录的构建引导工具，
不能将它们提供的运行时二进制直接混入最终出货闭包并称为已自行编译。
Linux 工具采用固定发行版源码包及对应构建配方或固定上游源码构建；不能只锁 `.deb`
摘要而省略 `.dsc`、源码归档、发行版补丁、构建依赖和产物身份。独立编译并不自动修复
上游缺陷，源码补丁和兼容性证据必须分别登记。

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

本轮开始实施完整迁移，按可独立回退的提交拆分。当前首批实现是最终 APK 的原生载荷盘点，
没有切换 Node/bash 启动路径，没有新增工具，也没有提升 targetSdk。
下列未完成项仍属本次迁移范围，不作为已交付或已验收功能。

| 阶段 | 交付物与完成判据 | 状态 |
| --- | --- | --- |
| P0 实际载荷盘点 | 扫 APK 原生目录和当前快照，支持独立 Linux rootfs/Node 目录；自证、负控；来源链携带报告 | 扫描器、测试和现有 APK 接线已实现；真实来源构建报告待生成 |
| P1 独立 Linux 来源底座 | 固定 Debian snapshot/源码包闭包、双 ABI；源码构建 Android PRoot/loader，不再依赖 Termux bootstrap/包仓 | PRoot/依赖的独立编译验证中，其余待实现 |
| P2 壳直接引导 Linux | Kotlin 解包/校验/事务准备 rootfs；不能先起 Termux Node 才安装 Linux；宿主与客体 env 分开 | 待实现 |
| P3 引擎/工具统一迁入 Linux | DSH 与原生 addon 使用 Linux ABI；PTY、PTC、Undo、控制台、文件路径和插件桥统一客体启动合同，替代 shell-termux | 待实现 |
| P4 常用工具补齐 | 下表工具/helper/依赖均从固定源码构建后预装；用户可在客体安装依赖与编译，必须验证新产物实际可运行 | 待实现 |
| P5 收口与平台验证 | 移除 Termux runtime/钩子/来源依赖；隔离旧数据并验证迁移，不原地覆盖用户树；双构建与设备证据 | 待实现 |
| P6 targetSdk 验证 | 保持当前高 target 验证，不回退到 28；后续提升 SDK 单独验证平台行为 | 待实现 |

本分支不进入正式版本发布流程，不以实验提交触发正式 Release。

现有可复用代码：`build-linux-assets.sh` 已构建 Debian 13 rootfs 与 Linux Node；
`prepare-proot-backend.py` 已组装 APK 内 PRoot/loader；`LinuxAssetIO` 提供宿主解包原语；
`vendor/dsh-linux-runtime` 有客体启动与安装事务逻辑。
当前仍有明确缺口：底座仅 ARM64、PRoot 来自 Termux 验签包、Linux 是已启动引擎内的
可选插件而非壳直接引导的主运行时、主 Node/bash 仍来自 Termux。以上不能标为已完成。

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
