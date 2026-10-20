# Linux 环境恢复方案（2026-10-20）

> 状态：完整恢复方案尚未实施。bootstrap `apply()` 对 `ctx.filesDir` 的访问已由 PR #77 修复并合入；真实 Cordis 回归、来源双构建、APK payload 比对、签名与资产校验通过，草稿 `hardening-source-f37eaafe887c-39424480383-1` 已生成。修复后 APK SHA-256 为 `a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`，尚未做设备复验；修复前 APK `862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf` 上的 loader / noexec 证据仍未取得。
> 复核基线：`5aad44537881ebe27e7485bbe54158fb7e8f71cd`。
> 目标：恢复用户主动安装、使用、升级和卸载本机 Debian/glibc 环境，保留 `linux_bash` 插件入口。
> 本文更新路线选择与证据要求；10-19 原始报告仍保留为历史实验记录，不能作为当前 APK 的验收。

## 1. 推荐决策

优先验证 **APK 原生库目录中的 bionilux launcher + 与 rootfs 同源的 glibc loader**。rootfs 与用户文件继续放应用私有目录，runtime manager 统一使用壳侧提供的可信执行配置。

先取得真实 app 进程中的执行证据，再投入完整安装链修复。主线通过后只实现这一条后端；若失败，根据执行与映射的具体失败点选择备选，不同时维护多条试验后端。

成立条件：APK 原生目录内的两个入口可执行，私有目录中的 guest 程序、libc 和 preload 可作可执行映射，且多级子进程能继续使用同一执行配置。任一条件未证实，都不能声称方案已经可用。

## 2. 必须先更正的调查前提

### 2.1 当前源码已有外部 loader 接口

`vendor/bionilux/SOURCE.json` 固定来源 commit `4865754bd9e3e030e62a60793b418a6a0f643b14`。当前源码：

- `src/launcher/config.rs` 从 `BIONILUX_LOADER` 读取显式 loader；
- `src/launcher/resolve.rs::find_loader` 优先使用存在的显式路径；
- `src/launcher/env.rs` 与 `src/preload/hooks.c` 向子进程保留该配置；
- `scripts/source-build/build-linux-assets.sh` 从这棵 vendor 源码编译资产。

因此，旧实验中“二进制没有 BIONILUX_LOADER”的观察只能描述当时被测产物，不能推出当前源码缺少接口。需核对最终 APK 中二进制、来源回执与执行结果；版本号同为 0.4.2 不足以证明字节相同。

当前实际缺口是 `vendor/dsh-linux-runtime/modules/manager.js` 的 `_probeRuntime` 与 `_executionEnvironment` 都没有接入可信外部 loader。

### 2.2 直接执行失败已观察到，noexec 的唯一归因尚未证实

旧记录只给出 `/proc/self/mounts` 中 `/data/data` 的挂载行，没有实际 loader 文件所属 mount ID、进程 mount namespace、可执行映射探针及完整 syscall 证据。父目录挂载选项不足以证明其下文件经过别名、bind mount 后的实际挂载属性；`EACCES` 也不能排除权限或 SELinux。

Android 官方明确记录 target API 29 起应用私有目录的直接 `execve` 限制；本项目 target 34，不能据此排除该因素。Linux 的 `do_mmap` 同样检查 `path_noexec`，拒绝该文件的可执行映射，所以“noexec 只拦 exec，不影响 linker mmap 执行”不是正确的通用解释。

依据：[Android 执行限制](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)、[Linux v6.12 mm/mmap.c](https://github.com/torvalds/linux/blob/v6.12/mm/mmap.c)。

### 2.3 PRoot 不能按旧理由直接排除

Termux PRoot 的 `enter.c` 会把内核 exec 目标替换成自己的 `PROOT_LOADER`，由其 `loader.c` 映射 guest 与 interpreter；并非总让内核直接 exec guest glibc loader。它仍受文件可执行映射等策略限制，不能承诺解决真正的 noexec backing mount。

依据：[PRoot exec 路径](https://github.com/termux/proot/blob/master/src/execve/enter.c)、[PRoot 用户态 loader](https://github.com/termux/proot/blob/master/src/loader/loader.c)。这里只作路线依据；若引入，须另外固定 commit、来源摘要与许可证。

## 3. 第一阶段：证明执行通路

在 ARM64 目标设备、真实应用启动的进程中完成；ADB shell 或 `run-as` 的成功不能替代应用身份。诊断记录至少包含：

| 检查 | 必须记录 | 判定 |
|---|---|---|
| 同一性 | 源码 commit、APK/launcher/loader/rootfs 摘要、ABI、ROM、内核 | 不沿用旧产物结果 |
| 进程与文件 | UID、SELinux domain、mount namespace、真实路径、文件 mode/context、对应 mountinfo | 分别检查 launcher、loader、guest 与共享库 |
| 执行与映射 | 私有目录与 APK 原生目录的 exec 结果；guest/libc/preload 的 `PROT_EXEC` 映射结果；可取得的 AVC | 缺 AVC 不等于排除 SELinux；证据不足记 `INCONCLUSIVE` |
| 多级执行 | glibc Node、bash，以及 Node → shell → 外部程序；shebang 脚本 | 不能只用 `node --version` |
| 进程控制 | cwd、环境、退出码、信号、超时取消后的子进程回收 | probe 和正式调用必须一致 |

这一步需要来源链 APK：原生入口、Manifest/Gradle 打包配置改变不能用 JS 热推代验。按本仓规则在 `main` 合入原子 PR 后出来源候选；在取得证据前阻止该候选发布。

停止条件：若 guest 文件的可执行映射本身被拒，单独迁移 loader 不能解决问题，应停止这条实现并选择备选。只有私有目录入口直接 exec 失败，而 APK 原生目录两入口 exec、guest 可执行映射及多级执行均已通过，才继续主线实现。

## 4. 第二阶段：固定 APK 执行入口

1. 把 bionilux launcher 和匹配 glibc loader 作为 `jniLibs/arm64-v8a/lib*.so` 形态的原生资产交给 Android 安装器，显式配置 native library extraction，并核验最终合并 Manifest、安装后的文件 mode、SELinux、ELF 与哈希。它们作为可执行入口使用，不通过 JNI `dlopen` glibc loader。
2. 两者都必须迁移。`vendor/bionilux/src/preload/hooks.c` 的 guest exec 路由会直接 `real_execve(launcher)`；只迁 loader 会出现“初次探测成功，子进程失败”。
3. 壳侧每次启动从 `ApplicationInfo.nativeLibraryDir` 读取路径，经现有宿主配置提供给插件；不持久化安装目录绝对路径，不允许模型或 HTTP 请求指定 loader 路径。AI 能力继续由插件提供。
4. runtime manager 建立一份执行配置，供 install probe、健康检查和 `linux_bash` 共用，显式配置 launcher、`BIONILUX_LOADER`、rootfs、preload 和 guest 环境。
5. 保留宿主/guest 环境隔离，不向 guest 整组透传 Termux 的 `LD_PRELOAD` 与 `TERMUX_EXEC__*`；验证 guest → launcher → loader 的环境切换。
6. loader 与 rootfs glibc 建立受信版本/摘要对应关系。应用更新后重新解析入口并验证组合；不允许 `apt` 静默更新 libc6 后继续配旧 loader。首版需约束这些核心包升级并向用户说明，后续随 APK/运行时协调更新；普通包安装仍须通过验收。
7. 原生资产纳入现有来源双构建、签名、provenance、payload 比对与许可证清单，复用同一 Linux 资产来源，避免 APK 与快照各自产出一份无绑定的 loader。

## 5. 第三阶段：恢复安装与状态闭环

建议明确采用“管理服务随 profile 加载；Linux runtime 默认禁用，用户确认才安装/激活”的架构。这样设置页可始终查询状态；这是对旧 D-014 默认不加载 bootstrap 口径的设计变更，实施时同步更新桥文档、profile 说明与来源摘要。

| 当前缺陷 | 修改位置 | 必要反证 |
|---|---|---|
| Cordis 激活时读取未声明的 `ctx.filesDir` | PR #77 已合入；`plugins/dsh-linux-bootstrap/src/index.js::apply` 不再读该属性，优先使用已声明的 `linuxBootstrapConfig.dataDir`，保留显式配置和 `DSH_FILES_DIR` 回退 | 真实 Cordis `Context.plugin()` + 真实 `apply()` 用例、CI 全量门禁与来源双构建通过；修复后草稿 APK 已生成但尚待设备验证 |
| 解包根与硬链接源一侧词法、一侧物理路径 | `plugins/dsh-android-linux-env/src/linux-host-asset-io.ts` | 当前分支已规范化根并复核目录身份；别名根正控及越界/符号链接负控通过；ARM64 设备未验证 |
| 设备拒绝硬链接后直接终止 | 同上 | 当前分支仅对受控 errno 使用 `COPYFILE_EXCL` 复制并保留 mode；未知错误负控通过；ARM64 设备未验证 |
| rootfs 准备依赖 app 私有 sh/find | `vendor/dsh-linux-runtime/modules/manager.js` | Node fs 原语完成准备，不执行私有辅助 ELF；绝对链接与目录逃逸负控 |
| 失败只更新内存、路由文案泛化 | bootstrap 状态与 `linux-environment.ts` 路由/客户端 | 重启后错误仍在；区分激活、解包、执行不支持；错误脱敏 |
| 安装失败后的事务与恢复 | manager / bootstrap | 新实例探测通过才切 active；取消、失败、空间不足不破坏旧实例与用户数据 |

现有 `offline-install-integration.test.mjs` 的 `nativeRunner` 返回模拟 Node 版本，并直接调用 `createBootstrap()`。该测试对安装逻辑有价值，但没有覆盖真实 Cordis 激活或 Android ELF 执行，两类证据都要补。

安装前用 APK 内的小型可信探针检查后端能力，探测失败或无结论时拒绝激活，并记录原因；不让用户反复解包后才得到泛化 500。

## 6. 备选与切换条件

| 路线 | 启动条件 | 必须解决的边界 |
|---|---|---|
| APK PRoot + 自带 loader | 可执行映射可用，但 bionilux 的子进程/路径语义未达标；ptrace 可用 | 真实 fork/exec、shebang、信号、PTY、包管理与性能；固定来源及 GPL 合规 |
| Shizuku shell 后端 | 本地无特权方案未通过，且用户明确接受此运行方式 | 独立 rootfs 生命周期、受控传输、摘要核验、授权撤销、取消/回收、清理；不能自动升权 |
| memfd / QEMU | 前两条路线均不满足，并有明确设备证据支持继续试验 | memfd 执行策略、子进程继承；QEMU 路径语义和性能。首轮不并行实现 |

现有 `ShizukuUserService` 可复用 Binder/argv/输出传输，但它不是 Linux rootfs 管理器。shell UID 运行意味着 guest 取得相应能力，不能把 `linux_bash` 静默切为 shell 权限执行；不扩大现有 spool 路径校验，不使用世界可写 rootfs，也不宣称 Debian 路径映射构成安全沙箱。

memfd 不是无条件可执行的内存文件，内核已有 `MFD_NOEXEC_SEAL`、`MFD_EXEC` 与 `vm.memfd_noexec` 策略。依据：[Linux memfd 执行策略](https://docs.kernel.org/userspace-api/mfd_noexec.html)。

## 7. 交付拆分与验收

建议按依赖拆为：诊断/执行 PoC → APK 入口及可信执行配置 → 激活修复 → 安全解包 → Node 准备 → 状态与恢复 → 最终集成验收。每个 PR 一个逻辑改动；能独立实施的修复可并行，但不能替代执行通路的先决证据。源码、树内 lib 产物、vendor 本地补丁清单与当前来源摘要同步更新，保留历史证据不改写。

验收按 `AGENTS.md` 风险等级执行，L2/L3 当轮三层，不推迟到最后一个 PR。最终候选必须从最终 main 来源链构建，正式签名、重新安装并验证升级；本方案不指定未讨论的版本号或未经 PoC 支持的交付日期。

最终成功标准：

- 从设置页安装后，`linux_bash` 实际执行 glibc 程序；多级子进程、cwd、环境、脚本、信号、取消全部成立。
- 离线受控 `.deb` 安装/删除通过，包含 maintainer script；另测联网 apt/DNS/证书。联网失败必须做宿主/guest 对照：宿主正常而 guest 的 DNS、证书或路径映射失败属于产品缺陷；只有证实的外部故障才记环境阻塞，且不能充当运行时通过。
- 模型只获得目标、约束和成功标准，自行完成“准备缺失依赖 → 处理输入文件 → 多级调用生成结果 → 核对并汇报”的真实任务；记录工具序列、重试、结果文件及设备事实。
- 覆盖引擎/应用重启、APK 覆盖升级、失败恢复、卸载后重装；保留用户工作区，不将捆绑只读资产误判为卸载残留。
- 代码层、CDP 状态语义、ADB 真人交互分别给结论；ARM64 真机横竖屏各有实际操作和截图，证据落 `.deploy-tmp/<round>/`。

本轮仅形成方案和纠正文档，未修改运行时代码、构建 APK 或取得新的设备可用性结论。
