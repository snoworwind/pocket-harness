# known-gaps.md — 当前缺口与验收入口

> 本分支宗旨及当前验证边界见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md)。源码有改动不等于新包已验收；来源构建状态以 [变更记录](changelog-archive.md) 最新条目为准。

- Pocket Harness 独立身份与签名改造已完成：`applicationId=com.snoworwind.pocketharness`、仅 ARM64 下载与产物、独立 PKCS12 证书 pin。2026-10-20，main `9ebe0fc1589a070cb2ee12417f27d89236f7153a` 的云端来源 run [39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296) 已通过双路独立 ARM64 构建、APK payload 比对、完整 Kotlin 单测、生产签名及来源证明核验，并创建 Draft + prerelease。当前草稿尚未公开；详见 [候选说明](../../release/v0.14.8/notes.md) 与 [构建环境记录](build-and-env.md)。
- 该候选尚未完成 ARM64 设备安装、升级及代码/CDP/ADB 三层验收；按用户要求，设备验证暂缓。设备验收完成前不得公开发布或称为已验收版本。

## 当前入口

- **2026-10-24 R3 复审二轮登记的残余面（坑 546/548 复审发现，未修复）**：① LogSanitizer 的分块边界处理只覆盖 PEM 类——`readEngineLog` 按 256KB 切 chunk，`sk-` 密钥/Authorization 头/环境变量导出行被切在边界时「带标记的半段」被打码、另一半段不匹配任何规则，明文落共享存储日文件；修复需要跨 tick 的 carry-over 状态（保留尾部残行拼入下一 chunk）而非逐 chunk 正则，属设计级改动，登记待独立 PR。② check-gate-skips 的「全白名单一致」断言硬编码同一份 7 项清单自镜像比对——新增支持 `--require` 的门禁若忘传严格档，该断言不可见（漏检方向）；根治需从 check-release-gates 的实际传参行解析清单再做差集。③（坑 549 复审追加）凭据键值掩码的 JSON **转义**形态（`\"password\":\"x\"`，`String(d.arguments)` 一类 JSON 序列化后再掩的文本）键与冒号间被反斜杠隔开，桥侧 maskCredentialShapes 与壳侧 LogSanitizer 的键值规则都不掩——桥侧只影响瞬态 .live.ndjson 显示路径（audit.ndjson 掩解析后的原始值已覆盖；厂商密钥/Bearer 形态仍被各自规则掩住），壳侧日志行同族形态同理；根治需在两处规则统一支持 `\\?` 前缀容错或改为解析后掩码。见 [R3 修复账本](SECURITY-REMEDIATION-2026-10-24-R3.md) 复审二轮段与全量复审轮段。
- **2026-10-23 Auto Review 默认策略（PR #103 已合并，PR Gate 通过）**：新会话默认 Auto；模型审查覆盖原生工具、PTC 外层程序与内层调用。high 分类在执行边界硬拒绝，用户不能批准该调用；medium 拒绝可逐次确认；reviewer 错误和 Auto 集成缺席 fail closed。reviewer 卸载时活跃会话回退到 `workspace-write`，Android Shell 会在 spawn 前拒绝该受限档位。该决定基于模型提示分类，存在误判/漏判可能，不是确定性数据流分析；Android 工具仍以应用 UID 运行，没有路径级文件系统沙箱。切换当前会话的权限档位会停用 Auto Review，默认值只影响新会话。实现和测试边界见 [坑 503](gotchas.md#503-auto-review-高风险拒绝必须绕过用户审批并由单调守卫收口)；**未做 APK、CDP/ADB 设备验证**。
- **2026-10-23 Linux 安装失败修复候选**：main 上的 runtime/bootstrap `0.6.1` 已补建 Debian 缺省的 `/dev/shm` 挂载点，ARM64 来源构建和签名由 run [39899439859](https://github.com/snoworwind/pocket-harness/actions/runs/39899439859) 通过。用户随后提供的目标设备实测显示安装探针仍会遇到 Android PRoot seccomp exit 182，且 Debian login profile 把共享 Node PATH 覆盖导致 exit 127；当前源码候选一致关闭 Android PRoot seccomp 加速，探针和 `linux_bash` 改用非 login Bash，并扩展持久诊断。runtime manager 35/35、bootstrap vendor 自检、30 个 Linux source 哈希与 code-map 均通过。候选版本为 0.6.2；来源 APK 构建、签名和目标设备验收尚待完成，细节见[修复记录](../linux-env-findings/REMEDIATION-ANDROID-PROOT-2026-10-23.md)与[坑 510](gotchas.md#510-android-proot-seccomp-偶发静默退出login-bash-又覆盖共享-node-path)。PRoot 仍不是沙箱，guest 以 app UID 执行；ARM64 设备上的 apt/dpkg 和多级子进程也仍待验证。
- **2026-10-22 Linux 后端已改为 Termux PRoot，runtime/bootstrap 0.6.1 已构建**：rootfs `/dev/shm` 修复已合入 commit `511b7e3`，ARM64 来源构建、双构建 APK 字节比对、签名和草稿预发布均由 run [39899439859](https://github.com/snoworwind/pocket-harness/actions/runs/39899439859) 验证通过；设备验收尚未完成。Bionilux launcher/preload/native loader 构建链与 Cargo 许可收集器已移除，bootstrap 的历史来源仍保留。PRoot 资产来自 Termux 官方签名 ARM64 仓库包，Debian/Node/原生依赖的锁和 provenance 已改为对应来源。PRoot 不提供沙箱，guest 仍以 app UID 执行；宿主 `/proc` 不绑定进 guest，依赖 guest procfs 的工具可能不完整。硬链接拒绝最多复制 1 GiB，但副本不是共享 inode，dpkg 兼容性和磁盘行为仍待 ARM64 实机验收。原生 PRoot 版本探针已修为接受 Termux ASCII banner 中的精确版本 token，见 [坑 496](gotchas.md)。[PR #102](https://github.com/snoworwind/pocket-harness/pull/102) 固定 recipe commit/hash 后，又发现把滚动 `stable` 的 InRelease 摘要放进提交锁会随官方发布过期；PR #105 已合入，通过每轮验签并记录摘要、由同一预检 job 把已验证包快照交给两路构建。PR #102 的两次失败 run 与结构修复见 [坑 506](gotchas.md#506-滚动-termux-stable-摘要不能作为提交级固定输入)；跨时间包字节复现仍不保证。此前 0.5.x Bionilux 记录仅作历史证据，不代表当前实现。

- 2026-10-20：继续比较上游源码后新增悬浮服务退出候选：本仓 OverlayService 缺少上游 #443 的服务自停/非粘性策略，现有 EngineService 的收尾不覆盖其未启动场景；实际任务划除复活仍待本仓设备复现。输入清空/回执与虚拟屏弹层差异也已细化反例。证据和静态推导见 [第二轮源码复核](UPSTREAM-SOURCE-REVIEW-2026-10-20.md)，实施依赖见 [吸收计划](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md)。**本轮仅文档，未修复、未构建 APK、未做设备验证，不构成候选通过。**

- 2026-10-22：Android `dsh-shell-termux` 尚无真实路径级执行围栏；源码现对 `read-only`/`workspace-write` 在 spawn 前 fail-closed，并要求每次会话策略显式选择 `danger-full-access` 才启动 bash。该档仍以应用 UID 运行，app-domain 不是工作区隔离；独立 UID/Landlock、秘密隔离与设备行为仍未验收。详见 [dsh-shell-termux 沙箱边界审计](SHELL-TERMUX-SANDBOX-AUDIT-2026-10-19.md)。本轮有宿主代码回归，**未构建 APK、未做设备验证**。

- 2026-10-22：能力组撤销/解锁的持久化失败语义已在源码修复：写入失败不再返回成功，撤销仍立即锁住当前会话并提示旧磁盘授权在重启后可能恢复；只有原子写成功才承诺跨重启状态。源码反例与落盘/rename 失败用例通过；[PR #97](https://github.com/snoworwind/pocket-harness/pull/97) 待 CI/设备层验证，**未构建 APK、未做设备验证**。实现见 [能力持久化坑位](gotchas.md#498-能力组撤销与解锁必须等待持久状态写入成功)；这不等于写入失败时能清除旧授权。

- 2026-10-22：浏览器工具的 `approval`/`confirm`/`full-access` 契约已接入执行闸：用户批准逐次绑定到工具调用，身份切换要求两次确认，截图要求会话显式选择 `danger-full-access`；拒绝、取消、审批服务缺席与策略缺席均 fail-closed。[PR #98](https://github.com/snoworwind/pocket-harness/pull/98) 等待 CI；源码回归 `plugins/dsh-android-browser/npm test` 23/23，完整插件套件 38/38。**未构建 APK、未做 CDP/ADB 设备验证**，设备层仍待补。

- 2026-10-22：会话导出下载现仅接受 `shouldOverrideUrlLoading` 提供的真实用户手势；`DownloadListener` 无手势/frame 来源参数，命中导出端点即拒绝，不会触发带引擎 Cookie 的 HTTP 请求。[PR #99](https://github.com/snoworwind/pocket-harness/pull/99) 等待 CI；纯判据与 Kotlin 编译通过。WebView 上实际触发回调的路径仍待设备复现。**未构建 APK、未做设备验证**。

- 2026-10-22：P2-2 源码修复已加入客户端 Session 删除收敛与 `workspaceClose` 窄桥命令：连续三次官方列表缺席后销毁对应 WebView、请求删除该 nonDefault profile，并重试失败；共享兼容 Cookie jar 保留。[PR #100](https://github.com/snoworwind/pocket-harness/pull/100) 等待 CI。profile 磁盘清理可能异步，**未构建 APK、未做设备验证**，真实 BrowserHost/Sidebar/WebView 生命周期仍待设备复验。

- 2026-10-22/23：P2-4 的 recipe URL 已改用不可变 Termux commit 和文件 SHA（[PR #102](https://github.com/snoworwind/pocket-harness/pull/102)）；后续 run [39809445254](https://github.com/snoworwind/pocket-harness/actions/runs/39809445254)、[39820055985](https://github.com/snoworwind/pocket-harness/actions/runs/39820055985) 证明不能把滚动 stable InRelease 摘要当作提交级 pin。PR #105 改为单独 job 每轮验签、记录 provenance 并上传一份包闭包供两路 ARM64 构建共用，当前等待远端验证；跨时间包字节复现仍不保证。详见 [坑 506](gotchas.md#506-滚动-termux-stable-摘要不能作为提交级固定输入)。本机没有 `gpg/gpgv`；未完成 APK 构建、未做设备验证。

- 2026-10-18 在 main `187246a` 上的分区复审发现原生 relay 准入遗漏、屏幕范围内存/旧 XML 断链、路由门禁注释假绿，以及文件/虚拟屏/来源续跑等问题，见 [项目分区复审](PROJECT-AUDIT-2026-10-18.md)。**A01–A14 已在源码层修复**，实现、宿主反例与新增测试见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md) 的「项目分区复审 A01–A14」一节。本轮未重建 APK、未做设备验证（无在线 ARM64 设备与 Android SDK）；L2/L3 面进入发版候选前仍须来源链新包的三层验收。与下方此前综合审查的 A01–A10 是不同编号集合。

- 2026-10-18 综合审查的问题现按用户授权修复，当前进度见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md)；[原审查报告](COMPREHENSIVE-AUDIT-2026-10-18.md) 保留发现时事实。实现、宿主反例与设备证据分别记账；**未做设备验证**。

- 第二轮 376–392 已进入源码修复；以 [修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md) 为当前状态。设备实测按用户决定暂缓，基本修复完成后统一执行；期间保留 **未做设备验证** 状态，不能据此发布。

- 2026-10-19：浏览器在无 `MULTI_PROFILE` 的设备上不再整块拒绝。用户显式启用兼容模式后使用进程级 Default cookie jar（`profileIsolation=shared`，loopback 仍拒，UI 明示共享），以可用性换隔离；每会话隔离与“不回 Default”的旧口径只对显式兼容模式例外。**未做设备验证**，需真机验证面板提示、第三站点导航与 `browser_*`。详见 [坑 437](gotchas.md)。
- 2026-10-19：修复了 Linux 插件依赖闭包导致的路由/bootstrap 未加载问题（源码层）：`@dsh-android/dsh-android-linux-env` 的 `xz-decompress`/`tar-stream` 原先只在引擎树，profile 路径解析不到，插件 import 失败。注入器现把运行时依赖闭包复制进插件自己的 `node_modules/`，`check-inject-completeness` 新增 C1/C2 可达性判据与负控；详见 [坑 436](gotchas.md)。这修复的是插件加载接线，不解决被测 ROM 上 `/data/data` 的 `noexec` 对 glibc loader 的阻断（见 [Linux 环境调查](../linux-env-findings/README.md)）。此源码修复未做设备验收，run [39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296) 已生成来源 APK，后续设备 `engine.log`、面板与 `linux_bash` 流程仍待验。同一轮修复了引擎重启后 reinstall/uninstall 必失败（持久化 pinned manifest 摘要、卸载时重新激活取 manager，见 [坑 438](gotchas.md)）。
- Linux ARM64 离线资产链已接入 APK 来源 workflow：同一提交从源码构建资产、校验来源 commit / 清单 sidecar / 每个资产摘要和长度，再嵌入 ARM64 Termux 快照；离线 bootstrap 已注册、编译客户端 bundle，并由 `linux-env` 提供已签名快照内资产和原始清单摘要。runtime manager 另有 Node 启动探测、有限输出与超时终止。本地单测与自检通过；main `9ebe0fc1589a070cb2ee12417f27d89236f7153a` 的来源 run [39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296) 已通过，证明来源资产进入同提交 APK。该结果只证明构建与封装：设备端完整流程仍未验收，且 2026-10-19 实测 ROM 的 `/data/data` 为 `tmpfs noexec`，glibc loader 无法执行。Linux 保持实验功能，不得宣称可发布；详见 [Linux 环境调查](../linux-env-findings/README.md)。


- 本轮安全团队审计修复四类边界，见 [SECURITY-AUDIT-2026-10-17.md](SECURITY-AUDIT-2026-10-17.md) 与坑 372–375。**未做设备验证**：WSL ADB 无设备且两个模拟器端口拒绝连接；没有本轮来源 APK/CDP/ADB 自主任务证据。L2/L3 三层仍阻塞验收及发布；普通 web 重定向的手势兼容需设备复核。宿主回归不得代替这项缺口。

- 包管理器别名/清数据漏检与子帧特权下载路由已按源码边界收紧，见 [gotchas.md](gotchas.md) 坑 343、344。代码及服务队列反证完成；**未做设备验证**。尤其是 `shouldOverrideUrlLoading` 的 WebView 子 frame/真实 gesture 事实，须等设备在线后核验，不能用 JVM 判据替代。

- 主 WebView 子帧越权的源码修复与代码层反证已完成，见 [gotchas.md](gotchas.md) 坑 342。**未做设备验证**，不能声称恶意 HTML 的 Android 设备攻击复现/修复验收已完成；原生壳改动须来源链新包，不能热推代验。真实同源页面仍属受信面，预览 sandbox 必须继续保持 opaque。

- settings 危险写操作的选项/reset 漏检已修，见 [gotchas.md](gotchas.md) 坑 341。代码层真实控制队列正反证通过；无在线设备，**未做设备验证**，即时 CDP/ADB 层仍阻塞，不构成候选验收。

- 模型能力探测凭据出口已修源码与生成 lib，宿主真实 HTTP 回归通过；CDP/ADB 即时验收因无在线设备阻塞，**未做设备验证**，不能记为运行时验收完成。入口、兼容变化与证据见 [gotchas.md](gotchas.md) 坑 340；最终来源包不得在未补验时作为候选交付。

- 旧快照的归一化证据需重算：v1 吞二进制及 JSON 有序映射差异，v2 未计权限/空目录，不能继续作为语义等价证明；当前报告带 `normalizationVersion: 3`，见 [gotchas.md](gotchas.md) 坑 337、338。未重建 APK、未做设备验证，旧包不包含此次修复。

- 本分支从 [安全加固宗旨](SECURITY-HARDENING.md) 与下方安全加固缺口进入；协调仓 `docs/REFACTOR-2026-10-05.md` 保留为历史计划与事实账入口。仓库地图见 [AGENTS.md](../../AGENTS.md)。
- 恢复与用户数据：[PERSISTENT-DATA.md](PERSISTENT-DATA.md)；协调仓 `docs/RECOVERY-ARCH-0.14.5.md`。当前实现以源码和冻结后的证据为准。
- 三层验收：[emulator-test-protocol.md](emulator-test-protocol.md)。旧包、热推或仅静态审计不能代替最终 ARM64 包的代码/CDP/ADB 用户层验收。

## 安全加固分支（2026-10-15）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| 本批修复验收范围 | 用户要求仅编译和静态检查；输入广播、raw shell 范围门与认证 HTTP 加固见坑 312–316；应用内更新已按用户要求整体移除，见坑 317；启动诊断 token 出口脱敏见坑 319、320 | WSL 完整 Kotlin 主源码编译通过；未新增或运行测试，未做 CDP/ADB 验收；不记功能验收通过，不具备发布结论；分支维护方式见宗旨文档 |
| Android 工程编译环境 | WSL 已安装独立 Linux Android SDK，Java 17 下 `:app:compileDebugKotlin` 成功；Windows Java 24 的 Gradle 配置失败仍是该环境的限制，未改工程版本规避 | SDK 路径、重复命令及证据入口见 [build-and-env.md](build-and-env.md) 的 WSL 编译小节；编译器仍有弃用 API 与可空接收者等警告，编译成功不等于运行时验收 |
| WSL 来源 APK 构建 | 已从已提交源码（`bc6637f`）在隔离检出内产出 arm64 APK，并通过 14 项独立复核（三签含 v1、证书指纹、内嵌快照哈希与语义归一化摘要、引擎 0.2.0-rc.2、LFS 独立性、四份许可全文、无构建机残留）；重建过程中暴露的前提与修正：无 index 的上游检出需显式初始化固定 commit、pnpm 包物化必须先于按物理路径读取的归档门禁、MiMo verifier 分派缺口已修，见坑 323 | 复核面与命令见 [build-and-env.md](build-and-env.md) 来源审计小节；字节级可复现不成立，判据是语义归一化摘要；测试预期修正及全量结果见坑 322，**该产物未做设备验收、未发布**，不构成发布结论 |
| 外部文件导入来源 | 私有 file URI 与同 UID Provider 的权限代用路径已在源码关闭；外部 content URI 要求系统已授读权限，file URI 限共享存储并检查实际 FD；畸形分享参数被安全拒绝，见坑 321 | WSL 主源码编译及静态检查通过；未做设备验证。正常带授权的系统分享、私有 URI 拒绝、链接替换与 FD 关闭均待设备回归；不提供 URI 读授权的旧文件管理器需改用系统分享/打开入口，系统不能解析的 Provider 或 FD 路径失败关闭 |
| raw shell 策略边界 | 范围门检查提交文本中的静态命令与显示选择器，不具备完整 shell 沙箱的能力 | 不应将文本扫描视作任意可执行程序行为的安全证明；本批只收紧已定位的绕过路径，运行时效果仍待验收 |
| 组件来源证明的信任边界 | 可写输入报告篡改及额外编译源码的漏检已修，见坑 336；输出检查从固定 Git 提交独立重建身份 | 校验器、Git 对象库及执行环境仍须可信；没有隔离任意同 UID 构建代码，也不证明检查间临时改写后恢复的输入。仅构建证明脚本改动，未重建 APK、未做设备验证 |
| **发布链与「APK 只能从源码构建」冲突（已按用户决定收口）** | 按铁律 9，本分支任何 APK 必须由来源链产出。原 `release.yml` 走「`base/*.tar.xz` LFS 底座 + runner 内 `scripts/build-apk-013.ps1`」，属非来源链路径，**已于 2026-10-15 按用户决定整体删除**（当时决定不出 Release；2026-10-17 新来源草稿政策见 RELEASE.md §5）。跨树镜像约束已退役；`build-apk-013.ps1` / `build-release.ps1` 禁止作为入口，`build-snapshot-013.mjs` 仍是来源链内部步骤，不构成对协调仓的依赖 | 新来源草稿入口已按用户决定加入（当前仅 ARM64，资产集 + provenance + 只读构建/独立写权限提升）；**不得复活 `release.yml` 那条链** |
| **仓库坐标写死上游（已修）** | 实测：`record-project-components.mjs` 把 provenance 的 `sourceRepository` 写死 `github.com/kelai141/dsh-mobile-apk`（而来源链会调用它两次）；`upload-release.mjs` / `sync-release-notes.mjs` 写死 `OWNER/REPO` 并需对方 PAT；`webpages/` 的 canonical/og/发布 API/下载链接全指向上游 | 已改为运行时解析（`DSH_*` 环境变量 > CI 变量 > `git origin`，取不到即判红）与构建期占位符注入，默认指向本 fork；站点测试同步改为按解析值断言。**两个手工发布脚本已按用户指示删除**（零调用者、非来源链路径）。证据与根因见坑 327 |
| **跨树镜像纪律退役（永久分叉，已记账）** | 按用户决定移除跨树镜像层：`check-patch-mirror.mjs` 只保留 registry↔IMPLS 自洽（`--peer` / `--require-peer` / `DSH_MIRROR_PEER` 显式拒绝，exit 2），`check-release-gates.mjs` 的「两树同版」断言删除，AGENTS §4.6 改为「树内副本即权威」。受影响文件：`scripts/check-patch-mirror.mjs`、`scripts/check-release-gates.mjs`、`scripts/build-apk.mjs`（注释） | 这些文件自此与协调仓永久分叉，将来若引入上游改动必冲突；**代价不是依赖而是合并成本**。原跨树防线（防「云端快照静默缺引擎补丁」）在本分支不再适用：不存在第二棵树，交付只由本仓自洽面 + 补丁回归 + fixtures 代对齐保障 |
| **补丁夹具 capture 重封（vendor-only registry 变更）** | `1dac77f` 新增 vendor 补丁 `market-install-approval-R2` 后未重跑 `probe-engine-anchors --fixtures`；PR Gate 的 `check-patch-fixtures` 比较完整 registry 哈希，在 `main` 首次运行即判红。CI 失败明细只报 capture 身份不符，未报任何 fixture 文件 hash 不符，说明 engine 夹具字节仍与 capture 一致 | 已将 `manifest.capture.registrySha256` 重封为当前 registry 哈希 `671699cb51c447204f45fcdca6529ae57f9d9e4d1a97dc047c8a2407fe0def9e`；engine / sourceCommit / 文件哈希未改。补丁夹具的真实重捕获仍应在下一次有 engine 产物的构建中执行，届时覆盖本行 |
| **来源链草稿发布** | 用户于 2026-10-17 允许手动来源构建成功后自动创建 ARM64 预发布草稿；旧 LFS 发布链仍禁用 | 具体政策见 [RELEASE.md §5](../RELEASE.md)；自动公开未启用，候选设备验收仍须补齐 |

## 吸收上游 `main`（2026-10-16，上游尖端 `5fca94f`）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| 吸收范围与冲突口径 | 上游 `main` 的 7 个提交（剪贴板回退镜像 0.1.14 / WebView 算法改色 / 手机端宽表格 / 终端卡片 / 刷新窗口启动请求 P1 / 文档与赞助码）已并入本分支。冲突按本分支口径解决：坑位续编 329–333（上游 309/311/312/313/310）、执行地图锚点按合并后行号重取、Kotlin 单测基线 1232、上游 `UpdateManager` 行不复活 | 逐项安全审查与结论见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 的 2026-10-16 复核轮次；**未做设备验证** |
| 代码层证据（本机） | Kotlin `:app:testDebugUnitTest` 编译通过、1232 例中 1231 通过；`dsh-host-web-compat` 三份 `node:test` + `smoke-injections` 18 项通过；`dsh-client-ui-responsive` 全量 vitest 48 文件 709 通过 / 1 跳过（0 失败），且运行副本的 `src`/`tests` 与合并树逐字节相同 | 编译与单测证据**不覆盖运行时行为**；唯一红例是本机文件系统 birthtime 不可得造成的环境误红，见坑 334（不改用例、不放宽 `EngineAuth` 判据） |
| **设备验收（缺）** | 本轮吸收含 **L2 面**（快照事务窗口内的启动/等待、boot-fail 新 stage）与 **L3 面**（主题算法改色、宽表格、终端卡片）：CDP 层与 ADB 用户层**一层都没做**。本分支禁止本地链出 APK（铁律 9），本机没有可安装的来源链产物 | 按铁律 2 的「不可省的两条」，这些改动的设备结论为空，**进入发版候选前必须补验**；补验条件 = 来源链出包 + 模拟器竖横两向 + arm64 真机补充 |
| 本机跑套件的环境坑 | `process.execPath` 在本机是 `/apex/com.android.runtime/bin/linker64`（node 是经 linker 启动的 ELF 共享对象），凡是用它派生子 node 进程的东西必失败：`node --test` 报 `expected absolute path: "--test-concurrency=0"`、vitest 默认 `forks` 池报 `EPIPE`、`check-release-gates.mjs` 的「171 个脚本全部可解析」整项判红（手工 `node --check <单文件>` 却 exit 0）；另 `pnpm install` 在 sdcard（FUSE）上因 symlink/rename 失败（`ERR_PNPM_ENOSYS` / `ERR_PNPM_ENOENT`） | 绕行：逐文件直跑、`--pool=threads`、装到 `$HOME` 或 `--node-linker=hoisted --package-import-method=copy`。属环境限制而非仓库缺陷，**不得据此判仓库红**；根因、实测矩阵与判据见坑 335，pnpm 见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 该轮证据段 |
| 上游锚点漂移（已知缺口的现实样本） | 上游写进执行地图的 `EngineStartFlow.kt:700`、`EngineManager.kt:207`、`EngineManager.kt:813、1344-1369` 在本分支合并后全部指错位置，而 `check-code-map.mjs` 仍 `exit 0`（它只验「行号 ∈ [1, 文件行数]」） | 本轮按实际行号手工重取；再次印证下方「锚点只验行号存在性、不验语义」那条缺口——门禁绿不等于锚点对，改代码后必须自查锚点语义 |

## 本轮仍需收口

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| **本机 3080 伪造监听者凭据泄露（高风险，源码已修、设备待验）** | 壳进程持续持有 TCP 端口，转发仅连应用私有 Unix socket 并验证已连接对端 app UID；覆盖探活、refresh、RPC、通知、mux、控制队列、来件与 WebView。根因见 [坑 350，修复及证据见坑 352](gotchas.md) | 宿主 HTTP/WS 正反证已通过；**未做设备验证**（ADB 为空，两个模拟器拒绝连接）。须来源链新包执行 fresh-process 伪造监听者 instrumentation 负控，再补 CDP/ADB 自主任务与双方向验收；补验前不得将此项记为完整关闭 |
| Hard / Soft 插件状态 | 可信 factory identity、四态与真实冷启动健康正在实施；live 用户 patch 不能成为 Hard 来源 | 冻结后统一测试；Disabled 官方条目不能阻止健康；隔离不丢源码/config；退出 Safe Mode 恢复用户配置 |
| 历史 ONLINE 事务与健康 | 本分支已删除新在线更新入口，保留旧 journal、usr-only 交换与 probation/commit/rollback 的恢复兼容 | 最终新包验证历史中断恢复不改用户 HOME；仅 HTTP 活着不得提前提交；失败后可恢复 |
| 回撤节流纪元 | `.undo-auto-done` schema 2 仅抑制相同安装指纹 + 回滚前失败 patch digest，成功回滚后原子写入；身份变化重开观察窗，旧数字时间戳在有效期内保守抑制并记诊断；显式用户重启在确认本壳子进程停止后清 marker，自动重试不清。纯逻辑与源码接线测试已补，仍待本批 Gradle fresh 验证 | 同一失败配置防循环，新安装/新配置不继承旧事件；marker 写入只发生在成功整份恢复后 |
| 许可证 | Shizuku api/provider/aidl/shared 13.1.5 官方 POM 均为 MIT；已补固定许可文本、矩阵、notices 生成及版本/文本反例 | 最终 APK assets/licenses 内含 MIT 全文与 SDK notices；当前源码门禁通过不等于实包已确认 |
| MiMo 与配置保留 | 旧基线真实 wire on/off 成功；虚拟屏目标达成但旧任务 13 次工具调用超出事先 10 次限制，整例未通过 | 新正式包自主任务预先约定可行预算并按真实事件计数；保留既有配置/会话/凭据 |
| UI / 范围 / 通知 / 浏览器 | 有旧版和阶段证据；最终当前树尚未完成三层回归 | 两个模拟器横竖屏、透明度、拒绝面、文件选择、后台任务和旧会话均按同一产物复验 |
| 真机 | MuMu x86_64 是开发首验；arm64 真机是发布前补充 | 华为 WebView identity/安装反馈不能以模拟器替代真机证据 |
| Actions 列表与维护线 | 2026-10-17 API 清单仍含 active 的 `release`，因默认分支仍为 `main`；本仓已删除该文件。旧 `Snapshot Build` / `ADB runtime patch` 已不在该次清单中 | 本仓仅使用显式 `--ref main` 的来源构建入口；Actions 列表中可见历史/其他分支工作流不等于本仓允许运行 |
| `check-code-map.mjs` 锚点语义覆盖仍有限 | 已修复历史「只验行号存在」问题：旧锚点由 `scripts/check-code-map-anchor-baseline.json` 固定源码行内容与引用次数；新增或移动坐标须带 `#expect=<URI 编码片段>`，避免用宽窗口猜符号。自检覆盖内容错配、源码漂移、坐标移动、重复引用、URI 错误和负控；锚点基线刷新会拒绝未标注的新坐标或旧坐标新增引用。剩余限制：尚未为执行地图全部既有引用补齐预期片段，旧锚点依赖行快照而非符号解析；刷新基线仍须人工审阅 diff。 | 2026-10-29 已实现并验证；详见 [UPSTREAM-ABSORPTION-2026-10-29.md](UPSTREAM-ABSORPTION-2026-10-29.md)。

## 0.14.7 已知限制（本轮如实登记，非缺陷隐瞒）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| R2 长按拖动：拖到列表边缘不自动滚动 | `sidebar-reorder.ts` 在拖动期间 `preventDefault` 拦原生滚动（否则手指下列表滚动会让命中行漂移、插入位置乱跳）。Spec §2.2 有「拖到列表边缘自动滚动」一句，本轮**未实现**。 | 已裁定本轮不做（需滚动容器 + rAF 边缘推进，属独立增量）。**用户可见影响：长列表远端目标需分两次拖动**。建议 0.14.8 独立项。 |
| R2 驱动上游 DnD 依赖合成事件 | 触摸屏无原生 drag 触发路径，故用合成 `dragstart/dragover/drop/dragend` 驱动上游 `Rows.tsx` / `WorkspaceBrowser.tsx` 的既有 handler。合成事件 `isTrusted=false`。 | 已核实上游当前**不校验** `isTrusted`。**若上游将来加该校验，本方案会静默失效** —— 届时需改为上游原生触摸拖放或请求上游提供触摸入口。 |
| #348 键盘遮挡：本机无法给出真机键盘证据 | 成因已修（弹层高度钳制纳入 `visualViewport` 底边，见 `composer-popup-guard.ts`）；本机可复现缺口（合成视口关系下溢出 196/96px 归零）。但本机仅有搜狗输入法、`mInputShown` 恒 false，真实键盘弹出态不可得。 | 记「**成因已修 + 待真机键盘复验**」，**不记 PASS**。票据所述澎湃 OS / Android 17 触发条件本机不可覆盖。 |
| Android 16/17 与澎湃 OS 专有行为 | 本机为 Android 15（MuMu x86_64）。`keyboard-boundary.ts` 注释记录的「Android 16 edge-to-edge 上 adjustResize 不缩布局视口」无法在本机复现验证。 | 本机**不可覆盖**，未计入通过项，需真机补充。 |
| R2 跨 account 重排未覆盖 | 上游 `sessionDragOrder` 按 `activeDrag.accountKey` 分组；本机仅有 1 个工作区行、无两个 account 各自的会话。 | 本机数据不具备，标**未覆盖**（不是通过）。已验证的是「跨组落点不改变顺序」（R2-5b）。 |
| 键盘判据在本机语义不稳定 | `mInputShown` 在 CDP 复验读到 false、ADB 探针读到 true；且新建会话后上游聚焦新 composer 本身会弹键盘，属标准 UX。 | 测试侧**只记录键盘数值、不作 FAIL 依据**（避免把正常 UX 写成缺陷）。#349 的「不弹键盘」半条同样待真机复验。 |
| `visualViewport` 判空曾漏 undefined（本轮已修） | `keyboard-boundary.ts` 原按 `vv === null` 判空，漏掉 `visualViewport` 求值为 `undefined` 的宿主，读 `.height` 抛 TypeError 并打断视口复算链。 | 已修为 `window.visualViewport ?? null` 并补 2 条回归用例（含反证）。记入 gotchas 284。 |

## Linux 内部插件的待接入边界（2026-10-16）

本仓交付实验性、默认不启用的宿主服务/API 与条件设置入口。bootstrap 与 runtime 是**我们自己的实验性内部插件**：按用户口径应随应用放入**内置（hard）插件目录**，但**默认不启用（存在不等于启用）**；应用更新或插件新版本发布都不得启用插件，也不得重新启用用户停用的插件。

现状与缺口（如实登记）：bootstrap 源码 vendored 于 `plugins/dsh-linux-bootstrap/`（当前候选 `@dsh-android/linux-bootstrap` 0.6.2；历史上游为 `kelai141/dsh-bionilux@3f86a85` 的 `packages/linux-bootstrap`，这是 bootstrap 来源，不代表执行后端仍用 Bionilux）。它进入 `scripts/plugin-dirs.json`、`scripts/contract.json` 与 profile 插件挂载；来源链重建 `lib/index.js`/`lib/client.js`，并将 PRoot、Debian ARM64 rootfs、glibc Node 和插件资产嵌入快照 `usr/share/pocket-harness/linux-assets`。`linux-env` 以 APK 签名保护下的快照资产、原始 manifest SHA-256 sidecar 和应用版本配置 bootstrap。工具 runtime 不默认启用；安装/激活要求用户明确操作。0.6.2 候选针对 Android PRoot seccomp exit 182、login Bash 覆写 Node PATH 和探针诊断不足作修复；来源 APK 与 ARM64 设备验收未完成。工厂 workflow 的 artifact 仅用于独立检查，APK 来源 workflow 对当前提交重新构建。PRoot 安全边界和未验项以本节上方的迁移与修复记录为准。

漂移由 `scripts/check-vendored-linux-bootstrap.mjs` 守（`--self-test` 含 1 正控 + 3 负控）：断言 vendored 文件集 == 上游包去掉 `test/` 加本仓两个文件、9 个上游一致文件的 EOL 归一秒摘要、以及三条刻意偏差（`exports` 指 `./lib`、保留 `build` 脚本、去掉 `test` 脚本、`private:true`）。它**不进** `check-release-gates.mjs` 的 `GATES`（进册即要求本地链与云端链同时接线，而那是镜像面文件），故以文档化命令 + 自检形式提供。

`kelai141/dsh-bionilux` 的内部 bootstrap 需被启用后提供 `linuxBootstrap` 服务、调用 `linuxPluginHost`（含 `isInjected` 在场查询）后再激活；构造/下载/解包由 bootstrap 拥有，运行时 manager 装配由宿主从激活作用域读出并交回（`install` 返回 `{manager, rollback?}`）。runtime 插件源码位于 `vendor/dsh-linux-runtime/`，APK 来源链从本仓源码构建插件 bundle 并嵌入离线资产，不依赖外部 Release 下载。**未覆盖**：离线生产 bundle 尚未在 Android 设备上实际安装/激活，`linuxPluginHost.install` 与 manager 交接仍只有源码/受控 Cordis 回归证据。

端到端设备验收仍未完成：尚未在 Android 上完整验收离线 manifest/资产读取、PRoot 安装、更新、重装、卸载及工具执行。2026-10-19 的 ROM 证据针对 Bionilux 旧路线，不能直接推断 PRoot 当前能否启动；PRoot 的 app 域 ptrace/nativeLibraryDir、guest `/proc` 缺失影响、DNS、guest ELF、多级子进程、apt/dpkg 和 hard-link fallback 都须用最终 ARM64 APK 验证。内部插件不默认激活，APK 更新不得自行启用；完整安全边界见 [PRoot 迁移记录](../linux-env-findings/PROOT-MIGRATION-2026-10-22.md)。

**2026-10-20 真机证据与首个修复**：Huawei Mate 80 Pro Max（SGT-AL10，Android 16 / API 36，arm64-v8a）上的修复前 APK `862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf` 在 `linux-bootstrap` 的 Cordis `apply()` 阶段因读取未声明的 `ctx.filesDir` 失败；配置已提供 `linuxBootstrapConfig.dataDir`，但 JS 在访问后续 `DSH_FILES_DIR` 回退前就抛错，导致服务未注册、状态路由 503、运行时未安装。PR #77 已移除此属性读取并新增真实 Cordis 激活回归用例；合入 main 的来源双构建和签名校验通过，生成草稿 APK `hardening-source-f37eaafe887c-39424480383-1`，SHA-256 `a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`，尚未设备复验。此结果没有测试 Bionilux、loader、guest ELF 映射、noexec 或 SELinux；这些仍按 [Linux 恢复方案](../linux-env-findings/RECOVERY-PROPOSAL-2026-10-20.md) 保持未验收。

### 0.15.0 追加：宿主侧准备与来源内离线接线（设备验收待做）

已落地并有反证：`LinuxAssetIO`（来源面/落点面/摘要+体量/解包面判据，复用 `SnapshotExtractor` 与 `SnapshotBundledAsset`）与 `LinuxAssetPrepare`（客户端触发入口，`@JavascriptInterface` `linuxAssetPrepare`/`linuxAssetPrepareStatus`）。五条负控（穿越、符号链接逃逸、炸弹、摘要不符、字节数不符）在 Kotlin 侧各有真实用例，且失败一律不发布产物。

**接入与验收边界**：壳侧 `LinuxAssetPrepare` 的网络准备面继续保留原有职责；离线 Linux bootstrap 使用另一条受 APK 签名保护的内置资产路径，不回退到网络下载。离线构建接线、自检与插件单测已经落地；来源 APK 云端全链已由 run [39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296) 验证通过，Android 设备端到端验收仍未完成，不能记为 Linux 功能可用。

以下三条是 **Bionilux 后端时期的历史记录**，已由 2026-10-22 的 PRoot 迁移替代，不描述当前 Linux 执行入口。

**2026-10-21 子进程环境复修**：新版实机日志仍在 `prepare-rootfs.sh` 报 `find: Permission denied`。第二轮复核发现上一修复仅传 `LD_LIBRARY_PATH`，Linux runtime manager 的环境白名单仍过滤 termux-exec preload 与拦截变量；仅加 `TERMUX_APP__DATA_DIR` 还可能让 toybox `find` 返回 0。源码当时改为从 `DSH_FILES_DIR/usr` 推导完整 host env，安装前验证 GNU `find`/`sed`/`wc`，并由 Bionilux 在 guest 环境剔除 Termux 变量。详细原因改指向 `files/linux-environment/linux-bootstrap-state.json`。插件/资产版本统一 bump 至 0.5.1；当时按用户要求未做实机测试，见 [修复记录](../linux-env-findings/REMEDIATION-TERMUX-EXEC-2026-10-21.md)。

**2026-10-22 新日志与后续 DNS 修复（Bionilux 历史实现）**：`sed --version` exit 0 且为 GNU sed，但 Termux linker 让版本首行以绝对 `argv[0]` 路径开头，旧 `^sed` 正则误判；同时 rootfs 准备没传 `--dns`，Debian 资产没有 `/etc/resolv.conf`。当时的 PR 源码放宽 `find/sed/wc` 身份正则，壳侧持续记录 Android 默认网络 DNS，rootfs 初始化与每次 guest spawn 都读取最新值，Bionilux resolver 支持 IPv6 nameserver 并避免沿用旧 resolver。Android API 28+ Private DNS 活跃时 fail-closed：rootfs 清除旧 nameserver，guest 暂不具备外网解析能力，避免绕过系统加密 DNS。Linux/runtime 版本升至 0.5.2。源码构建、自动测试和设备验证状态见 [修复记录](../linux-env-findings/REMEDIATION-HOST-TOOLS-DNS-2026-10-22.md)；旧 APK 不含本修复。

**2026-10-22 Android app-data ELF 执行限制（Bionilux 历史方案，已放弃）**：新设备证据确认 Bionilux 直接 `execve` 私有目录 glibc loader 被 Android 拒绝，linker64 又因 Debian loader 的 ELF PHDR 布局拒载。runtime `0.5.3` 曾把同源 Bionilux launcher 和 glibc loader 从 APK nativeLibraryDir 启动；这条路线没有成为当前后端。targetSdk 34 保持不变；历史分析详见 [Android 执行入口修复](../linux-env-findings/REMEDIATION-ANDROID-EXEC-2026-10-22.md)。当前 PRoot 迁移的验收状态见 [迁移记录](../linux-env-findings/PROOT-MIGRATION-2026-10-22.md)。

**工具链边界**：APK workflow 的 Linux 交叉编译宿主工具由 Ubuntu runner 的 apt 仓库提供，目前未按每个 deb 固定版本与 SHA-256；NDK 官方 Linux 包只有 SHA-1 发布摘要可用，provenance 会披露该事实。离线 bundle 的用户侧信任锚仍是 APK 签名保护的原始 manifest 字节与 sidecar，逐项匹配内嵌资产的 SHA-256 和长度。主机工具链可复现性还需后续提高，不能把 source commit 相同直接等同于 bit-for-bit 可复现。

## 历史事项不自动关闭

旧登记的浏览器自动落位、看门狗恢复入口、API<30 截图回落、多 ROM 限制、动效、滚动条、低置信度依赖判据等，保留当时证据。应按当前源码逐项分类为已改、仍存在或仅特定设备待验；不得把旧“未修”直接当当前事实，也不得把归档当完成。

完整原文在 [历史缺口登记](../archive/known-gaps-pre-0.14.5-2026-10-07.md)。当时版本结论、授权和停止点均不覆盖当前本轮要求。

## 原生管理中心（2026-10-16）

当前上游插件管理 API 不提供静态依赖图。壳侧在停用前确认操作，比较操作前后完整运行清单并尝试恢复造成失活的变更；这是运行状态检查，不等同于静态依赖分析。只读/不可寻址条目保留展示并禁用开关。插件详情复用运行时暴露的配置 Schema；未激活或未提供可编辑 Schema 的插件明确说明原因。高级配置为合并保存，删除 JSON 字段不代表重置。


## 2026-10-17 上游同步验收边界

上游 `e3e728b` 已同步到安全分支工作树；本轮 **未做设备验证**，模拟器两端口拒绝连接且无在线真机。管理中心、气泡导航、Shizuku 及新增 Linux 桥的 CDP/ADB 层均未关闭；本轮没有来源链新 APK，不得沿用上游设备截图作为本分支验收。源码检查和本机测试证据见 SECURITY-HARDENING.md 同日复核。


2026-10-17 Linux 安全复核当时 **未做设备验证**，并发现 bootstrap 未进入注入集、页面没有准备桥调用者。后续源码已完成离线 bootstrap 注册、准备桥与运行时依赖接线（见上述 Linux 内部插件边界及 [坑 436](gotchas.md)）；来源 APK 链已由 2026-10-20 run [39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296) 验证通过。设备端到端验收仍未完成，且被测 ROM 上的 `noexec` 限制使 Linux 运行时不可用，详见 [Linux 环境调查](../linux-env-findings/README.md)。

## 2026-10-17 晚第二轮发现状态（发现记录保留，当前状态逐项核对）

第二轮挖掘（基线 `2fbcc7f`）的原始结论是发现时状态，不能直接当作当前实现事实。原文仍在 [SECURITY-AUDIT-2026-10-17-R2.md](SECURITY-AUDIT-2026-10-17-R2.md)；各项修法、兼容边界和本机/云端验证证据以 [R2 修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) 为准。下表区分源码状态与验证状态；这 17 项均没有本轮设备三层验收：

| 发现 | 当前源码状态 | 验证状态 |
|---|---|---|
| [376](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 授权改为进程内状态，冷启动重新授权 | Kotlin 全量用例通过；设备时序未验 |
| [377](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 敏感桥写入要求原生确认和系统凭据认证 | Kotlin 全量用例通过；真实系统认证流程未验 |
| [378](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 中继先验证随机凭据，并限制未认证连接数量与期限 | 40 连接 instrumentation 负控已加入但未执行；设备压测未验 |
| [379](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 通知动作改为原生确认流程和一次性许可 | Kotlin 全量用例通过；锁屏/通知监听器场景未设备验 |
| [380](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 市场安装改为本地逐次审批，缺信息时拒绝 | 插件和来源宿主回归见账本验证段；设备流程未验 |
| [381](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 清单摘要门已接入，但当前批准列表为空，Linux 安装因此失败关闭 | 仍是功能阻塞项；未取得并审核可批准资产，不能标为关闭 |
| [382](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 多个响应体受字节上限约束，models.dev 刷新有 deadline 且不跟随重定向 | model-capability 回归见账本验证段；设备启动行为未验 |
| [383](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 未鉴权状态路由读取缓存，不再占控制队列 | 插件/来源宿主回归见账本验证段；设备压力场景未验 |
| [384](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | nonce 限制为十六进制输入后再进入命令参数 | 恶意 nonce 负控见来源宿主回归记录；设备命令链未验 |
| [385](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 有源码树与快照逐包比对；把 payload 摘要钉进仓库的尝试因构建输出不稳定而撤回，缓存与快照可协同篡改的缺口仍在 | **未关闭**；须先证明输出可复现，再重新设计独立摘要绑定 |
| [386](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | preinstall 在来源 workflow 中按目标 commit 重建 | 来源链回归见账本验证段；不代表本轮 APK/设备通过 |
| [387](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | pnpm/Canvas 输入有仓库内 SHA-512 锁，下载使用官方 registry | 官方摘要复核与来源宿主回归见账本验证段 |
| [388](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | deb 缓存命中复核签名索引 SHA-256 和字节数，归档解包前复核固定摘要 | 篡改缓存负控见来源宿主回归记录 |
| [389](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | Gradle 8.11.1 下载配置固定官方 distribution SHA-256 | 账本记录的来源构建通过；不替代当前候选来源链验证 |
| [390](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 原生文件选择只认显式 `data-dsh-file-path`，不从标题推断路径 | 源码/宿主回归见账本验证段；设备点击场景未验 |
| [391](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | 不再以整份 HTML 子串决定是否跳过注入；tapIndex 负控证明该子串本身不能抑制脚本 | 本机 harness 已运行；原审计仍标注 Android 注入点可达性为假设，未设备验 |
| [392](SECURITY-REMEDIATION-2026-10-17-R2.md#实现与兼容变化) | open-path 要求有效 Session、realpath 后限制到该会话 cwd 并拒绝链接外逃 | 路径正反例见来源宿主回归记录；设备调用链未验 |

与既有条目的关系：381 是「Linux 待接入边界」里「runtime 只来自 Release」的**安全侧补充**（原条目只登记集成缺口，未登记信任锚）；385/386 与坑 336 同族但**不是同一路径**（336 只覆盖项目组件报告，未覆盖引擎快照与 preinstall）；387/388/389 属来源链从未登记过的下载/缓存缺口。本轮没有改变 336/339/350/352/373/375 的既有结论。

## 参考仓库更新（2026-10-19，#414 堆上限）

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| **高内存设备的引擎堆压力（代码已吸收，设备待验）** | 壳侧与快照 wrapper 将上限从 1024 提至 4096MB，仍取设备总内存一半并保留 512MB 下限；1/2/3/4/6/8/16GB JVM 档断言及自然上限退化反例已补，但未测真实 Android 运行时的 RSS、并行应用压力或长任务峰值 | 来源链 ARM64 包上覆盖低、中、高内存设备的启动与长任务，观察进程峰值、系统回收及前后台切换；当前不得据源码断言所有设备都受益或可发布。详见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 2026-10-19 轮次 |

## 引擎 0.2.1-rc.2 候选（2026-10-19）

源码适配、真实构建产物及代码验证已实施，最终 main 来源双构建与设备证据按 [升级记录](ENGINE-UPGRADE-2026-10-19.md) 收口。ADB 实际为空，目标 ARM64 设备 ABI 不可读；CDP、ADB 自主任务、横竖屏与覆盖升级未验收。旧 runtime-capture 退为历史，不移植参考仓的设备结论；模型能力插件暂保留至替代设置能力实际验收。

## Engine base 复用收口（2026-10-20，PR #61；lock PR 待合入）

PR #61 修正了 capture/report 顺序差异；main run 39357008785 的两个独立构建、完整 tree compare、cache 与 candidate artifact 均通过，真实 candidate 在 Linux gate 容器 materialize 成功。当前 PR 将候选提交为仓内 trust root；合入后仍需 draft source workflow 确认正式 cache restore → materialize → ARM64 source build。详见 [ENGINE-BASE-2026-10-19.md](ENGINE-BASE-2026-10-19.md) 与坑 457、458。

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| Java 钉值 | **已修复并由 runner 验证**：`engine-toolchain.json` 与两条 workflow 均固定到真实存在的 `17.0.20+8`；plan 在 runs 39354019902、39357008785 通过 | 已通过 |
| 本地双构建 | `buildRun` 固定到 `GITHUB_RUN_ID`；独立本地 run 会在 identity 判据失败 | 仅是本地复现限制；正式证据使用 main 上的 hosted 双构建，不放宽 compare |
| 输出树确定性 | PR #61 只规范根 JSON/YAML 无序映射并固定依赖回执顺序；绝对 `file://` 路径仍按原字节计入 | run 39357008785 跨两个 hosted runner 的完整 tree compare 成功；未来路径不同仍会硬失败 |
| 真实 `materialize` | run 39357008785 candidate 与 lock 在隔离 main clone 的固定 Linux gate 容器中通过；materialized 检查为 345 packages / 2435 links | 已通过；lock 合入后由 draft source workflow 复验正式缓存使用 |
| 设备验证 | 按用户要求，本次草稿 release 不做设备验证；不会宣称设备验收或公开发布 | 创建草稿时 notes 必须明示未做设备验证；转公开前仍须补足 §2.1 三层验收 |
## 发布状态（2026-10-20）

仓库已公开，但**尚未对外发布 APK**：三个 `hardening-source-*` 预发布已转为草稿，对外不可见（未认证 API 返回 0 条）。对外发布需先完成设备三层验收，再由维护者手动把草稿转正；当前 ARM64 真机不可用，故该项保持未完成。
