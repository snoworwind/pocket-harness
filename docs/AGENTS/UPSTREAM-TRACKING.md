# 参考上游更新跟踪

本仓独立维护；`kelai141/dsh-mobile-apk` 是参考来源，不是构建依赖或镜像权威。按问题选择性移植，每个逻辑改动独立 PR，保留出处，重新审查本仓安全约束并按风险分档验证。上游发布和测试不代替本仓验收。

## 检查规则

- 建议每周及准备发版时检查；本文件不创建定时任务。
- 后续从上次检查游标查看新增提交，并复查暂缓项的触发条件。游标表示已检查范围，不表示已吸收。
- 每项记录本仓判断、处置和证据链接；实现后追加对应 PR 与验证结论，不把静态判断写成设备通过。
- 引擎升级单独处理依赖、补丁、插件 peer、槽位契约和夹具；不得只换版本号。应用身份、签名、来源链与插件能力边界继续以本仓规则为准。

## 2026-10-19 首次检查

| 项 | 记录 |
|---|---|
| 参考仓库 | https://github.com/kelai141/dsh-mobile-apk |
| 检查游标（main） | `18439f1b8cb96f7d4d9b8508bdb02aa2695143a3`，提交时间 2026-10-18 21:00:09 +0800 |
| 本仓对照提交 | `aa33edf0560e84b0717eaa52e5dc56eac141cb09` |
| 检查范围 | main 最近 30 条提交列表、重点提交说明/文件范围和相关本仓实现；非全仓逐行差异审计 |
| 最新公开 Release | [v0.14.8](https://github.com/kelai141/dsh-mobile-apk/releases/tag/v0.14.8)；发布说明中的验证缺口未视作通过 |
| 方法与边界 | GitHub 页面与只读 API、本地源码检索；未移植代码、未构建、未做设备验证 |

以下保留首次比较结果；处置已按后续源码与宗旨复核修订，不代表已启动实施或已承诺发版。当前范围以本文后续队列和独立实施计划为准。

| 优先级 | 上游更新 | 本仓静态判断 | 处置与重新评估条件 |
|---|---|---|---|
| 已吸收（2026-10-19） | [#414 堆上限 1024→4096](https://github.com/kelai141/dsh-mobile-apk/pull/414)，源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`，上游合并提交 `f2df6fa0d2a3b70f171f2a28ed3f020dcad5997a` | 双源上限提升至 4096MB；并修复 1024 上限等于 V8 自然上限标志造成的自适应退化，新增自然标志真源及防退化门禁 | JVM 机型档断言、wrapper 反例和 11 条门禁负控已同步；设备内存压力未验，见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 与 [known-gaps.md](known-gaps.md) |
| P1（代码已实施，设备验收开放） | [#420 ADB 键盘投递与来源校验](https://github.com/kelai141/dsh-mobile-apk/pull/420) | 本仓已有显式接收组件、nonce、API 34+ 发送 UID 校验和文本输入回读；接收器未回传应用层处理结果，clear 路径也没有结果真源 | 已按本仓最小方案增加 typed 编辑结果、逐次 ordered-broadcast 回执与安全 IME 恢复/重放约束；WSL Kotlin 单测 1330/1330、manage 插件 102/102，细节见 [吸收计划](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md)。本轮按用户要求未构建 APK、未做 CDP/ADB 验收，仍开放 |
| P1（代码已实施，设备验收开放） | [#403 虚拟屏比例与弹层遮挡](https://github.com/kelai141/dsh-mobile-apk/pull/403) | 本仓 `VdisplayHost` 已有等比 letterbox 的宽/高约束公式；vdisplay 客户端缺少与现有 DOM 弹层状态一致的 SurfaceView 显隐协调 | 只补 vdisplay 呈现消费端，复用 sidebar bubbles、menu/dialog/listbox 与 dockkit pointer 状态，不改比例算法或执行授权。插件编译和 96/96 离线用例通过；本轮按用户要求未做设备复现/CDP/ADB，仍开放，见 [吸收计划](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md) |
| 条件诊断；写入方案撤回 | [#416 离线插件管理与启动即时反馈](https://github.com/kelai141/dsh-mobile-apk/pull/416) | 后续源码复核已纠正启动反馈判断：`EngineStartFlow.kt` 已在前置探测前显示 Starting；`PluginManagementPage.kt` 的离线清单与管理动作仍依赖引擎 RPC | 启动即时反馈已具备，不重复移植；C1 只在必要任务受阻时复用已有可信信息提供只读诊断，C2 通用原生离线写入方案已撤回，日常启停继续走引擎/插件协议 |
| 已实施，最终候选待验 | [#403 引擎 0.2.1-rc.2](https://github.com/kelai141/dsh-mobile-apk/pull/403)、[#408 模型能力设置](https://github.com/kelai141/dsh-mobile-apk/pull/408) | 官方目标独立源码构建，重核来源链、PTC 两路、peer/槽位/路由与真实夹具；模型能力插件继续保留，因为其能力与设置页的等价范围尚未逐项证明 | 本仓实现与证据统一见 [升级记录](ENGINE-UPGRADE-2026-10-19.md)；未引入同 PR 的虚拟屏 UI 修复，未借用参考设备结论；模型插件是否退役按下方计划重新评估 |
| 可选 | [#411 双工作区与紧凑控制窗](https://github.com/kelai141/dsh-mobile-apk/pull/411)、[#412 抽屉常驻挂载](https://github.com/kelai141/dsh-mobile-apk/pull/412)、[#415 悬浮球隐藏召回](https://github.com/kelai141/dsh-mobile-apk/pull/415) | 属于交互扩展；本轮只核查部分变更范围，未逐项完整审计 | 暂缓，明确产品需求后评估；重点看常驻挂载内存、召回条命中区域、横竖屏和 overlay 生命周期 |
| 暂不移植 | [#418 原生启动失败修复助手](https://github.com/kelai141/dsh-mobile-apk/pull/418) | 新增 RepairTools 等壳侧模型工具与文件写入/命令能力，偏离本仓“AI 可见能力全部来自插件”的边界 | 保留启动失败恢复需求；只有经过本仓架构与安全审查、形成符合插件边界的方案后再评估实现 |
| 已有相关实现 | [#383 Shizuku 分支兼容](https://github.com/kelai141/dsh-mobile-apk/pull/383)、[#402 重置后重建](https://github.com/kelai141/dsh-mobile-apk/pull/402)、[#393 导航栏透明](https://github.com/kelai141/dsh-mobile-apk/pull/393) | ExternalLinks 已含 Stellar；ShizukuTransport 已先注销连接缓存再移除服务；WebUiChrome 已关闭导航栏对比度叠加 | 不重复移植；只确认相关代码存在，未声明与上游完整等价或已做本轮设备验证 |

本次没有把上游应用更新、旧签名、双 ABI 发布、协调仓镜像规则作为待吸收能力；这些面以本仓现行政策为准。后续实现 PR 应回填本表，未解决项继续保留。

## 2026-10-20 全面对比与吸收计划

### 对照口径

| 项 | 本轮采用的证据 | 边界 |
|---|---|---|
| 本仓 | 产品代码对照基线 `eb4ea6a2f1f1fcc264e988e167e19f39fa1a457c`（后续计划分支只追加文档）；产品/实现基线见 [BASELINE.md](BASELINE.md)、[ENGINE-UPGRADE-2026-10-19.md](ENGINE-UPGRADE-2026-10-19.md)、[SECURITY-HARDENING.md](SECURITY-HARDENING.md) | `0.14.8` 来源草稿实际输入提交为 `9ebe0fc1589a070cb2ee12417f27d89236f7153a`；当前 HEAD 后续主要是文档提交。草稿已有双 ARM64 来源构建证据，尚无设备验收和公开 APK。 |
| 上游发布 | [v0.14.8 Release](https://github.com/kelai141/dsh-mobile-apk/releases/tag/v0.14.8)，tag commit `a10d230`，versionCode 52，2026-10-17 发布 | 这是最新可核验公开 Release。其自述验证以 Android 15/x86_64 模拟器为主；无 ARM64 真机验证，部分 UI 用开发包加热推，几何改动横屏未复跑。上游证据不能替代本仓验收。 |
| 上游当前源码 | [main `7cd7ccab8247514e20be2925c92d46b45e70d152`](https://github.com/kelai141/dsh-mobile-apk/commit/7cd7ccab8247514e20be2925c92d46b45e70d152)，2026-10-20 06:19 +0800，`feat: 壳侧与注入插件界面文案双语，壳侧新增语言切换 (#450)` | 这是本轮源码比较基线，已核对 v0.14.8 之后的 `main` 尖端；后续检查从该 SHA 继续。 |
| Release 与源码关系 | [v0.14.8 Release](https://github.com/kelai141/dsh-mobile-apk/releases/tag/v0.14.8)，tag commit `a10d230`，2026-10-17 发布 | Release 早于当前 `main`；资产 ABI、功能状态与验证说明只能代表该 tag，不能覆盖当前源码结论。源码中 Linux 注入已变化，见下表。 |
| 上游 README | [仓库 README](https://github.com/kelai141/dsh-mobile-apk) | README 仍写 0.14.6、versionCode 50、引擎 0.2.0-rc.2；与 v0.14.8 Release 不一致。版本、插件和发布状态以 Release 为准，README 仅用于识别架构描述与历史接口。 |

### 项目对照矩阵

| 维度 | 本项目 Pocket Harness | 上游 dsh-mobile-apk | 判断 |
|---|---|---|---|
| 产品身份 | `com.snoworwind.pocketharness` / `Pocket Harness`，独立签名、独立安装；不覆盖 DeepCode，也不自动迁移旧数据。 | `com.dsharnessmobile.shell` / DeepCode；同签名覆盖安装并保留既有用户数据。 | 身份、签名和数据迁移策略是产品边界，保持本仓独立，不吸收旧包身份或签名。 |
| 应用骨架 | 两边都采用 Android 壳、WebView UI、Termux 快照、前台服务/看门狗、SAF、控制台和插件扩展；本仓 BrowserHost 区分独立 profile 与用户显式开启的 shared 兼容模式，生命周期与来源另有约束。 | 上游 README 描述同一主体架构，并带虚拟屏、浏览器工作台、设置页和插件管理。 | 基础平台能力大体同源。比较后续代码时按调用链和边界找差异，不能把相同功能重复移植。 |
| 引擎与补丁 | 固定官方 DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；从源码形成部署树，重验 24 条补丁、peer、槽位、路由和一次/持久 PTC。 | v0.14.8 同样追到 `0.2.1-rc.2`，Release 记载 24 条补丁；其“348 包”与本仓 345 个源码导出包统计口径不同，不能直接据数字判缺包。 | 版本目标相同；已有引擎升级不再重复做。未来追版按本仓独立来源审计与全部补丁/依赖闭包流程执行。 |
| 构建、ABI、签名 | 当前来源链只构建 ARM64，并以 primary/reference 两份构建复核；从已提交本仓 HEAD 隔离重建、记录 provenance，以本仓私有 PKCS12 签名。 | 当前 `main` 的 build-apk-source workflow 也是 ARM64 primary/reference 双构建；Gradle 配置引用仓内 keystore，workflow 另有签名步骤。v0.14.8 Release 资产另含 x86_64，不能推断当前 main 有 x86_64 构建。 | 两边都已有来源构建和双构建复核，比较具体输入、可复现性与签名边界；不复制上游密钥、包身份或旧协调仓链。双 ABI 是独立产品/设备决策。 |
| AI 工具与插件 | 工具只由插件注册。自包含副本含 bridge、manage、model-capability、file-open、browser、linux-env、vdisplay 等；源码、`package.json` 与 `lib/` 产物须同步。 | 当前 scripts/plugin-dirs.json 与 Cordis patch 均注入 Linux 环境插件；model-capability 目录与注入项已不存在。其构建哈希循环和 profile 注释仍提到 model-capability，属于源码内残留引用。 | 插件边界相同，但当前有效清单不同。保留本仓模型能力插件；上游删除不能视为等价替代，也不要把残留注释当成有效注入。 |
| Linux 环境 | 本仓已接入 ARM64 离线资产与 bootstrap；本地保留 linux-release-pins、离线安装集成用例及来源/摘要闭包。设备验收尚缺。 | 当前 main 的 Linux 插件包版本为 0.1.2，scripts/plugin-dirs.json 和 profile patch 均启用；linux-host-asset-io 将宿主已暂存资产交给 bootstrap 复验，不自行下载。v0.14.8 Release 的“未注入”结论已被后续源码改变。 | Linux 能力不是本仓独有。保留本仓离线资产来源与 pin；以当前源代码比较摘要复验、路径约束、失败关闭和恢复语义，只对证实的缺口提取实现；第二轮已证实解包载荷来源不同，保留本仓从已验归档重新解包，详见源码复核 R6。 |
| 虚拟屏 UI | VdisplayHost 已有宽/高受限等比 letterbox；本仓 vdisplay 客户端未消费已有气泡菜单开合状态；BrowserHost 已消费 `data-dsh-sidebar-bubbles` 的 open/closing 状态。 | 当前 main 的 vdisplay 客户端监听 data-dsh-popover-open，并将遮挡状态合并到 viewer visible 判据；页面侧在打开/收起弹层时翻转属性。 | 比例算法已具备；#403 仍是明确源码差异。优先让 vdisplay 消费本仓已有菜单状态，补恢复逻辑，不再另建全局开合信号。 |
| 管理和启动体验 | 本仓 EngineStartFlow 已在前置所有权探测和 worker 工作之前显示“正在启动”，与 #416 的即时反馈效果一致；PluginManagementPage 离线时仍只提供状态/启动入口，清单与启停依赖运行中 RPC。 | 当前 main 同样先在主线程显示 Starting；另新增 PluginOfflinePanel/PluginPatchOffline，离线列出并启停 Soft 插件。写入前核对状态，Hard 清单不可写，临时文件原子替换后回读确认。 | 启动反馈已经具备，不再列为吸收项。离线管理是功能差异，不自动构成本仓缺陷或新增壳侧管理器的理由；当前仅条件保留 C1 只读诊断，撤回 C2 通用原生写入设计。 |
| 输入回执 | ADB 键盘已有显式组件、nonce、Android 14+ sender UID 校验和文本回读；目前接收器不写应用处理结果码，服务 handle 还会忽略底层编辑调用结果。清空-only 或无障碍无法回读时，shell 命令成功可能被当成处理成功；文本不一致时另有一次自动清空/重投。 | 当前 main 的接收器只对有序广播写回 committed/not-ready/rejected/bad-request/no-connection；manage 插件点名组件、发有序广播并解析结果，同时兼容旧壳的默认 0/缺失结果码。 | 源码已证明存在可收窄的假成功面。新增结果回执应按每条广播分别判读，保留 nonce/UID 门，不因结果码缺失或错误自动重投；重新审查本仓现有文本重试，避免与回执叠加造成重复输入。 |
| 更新与恢复 | 本仓已按用户决定移除 APK 自更新与在线快照入口；本地快照解压/刷新由事务、校验与 UndoGate 管理，APK 只能从源码链生成。 | 当前 main 源码仍含 UpdateChecker、UpdateManager 和 REQUEST_INSTALL_PACKAGES；在线快照更新校验 hash/大小后走 SnapshotTransaction。Release 资产/README 与当前源代码是不同时间截面。 | 保持本仓不提供 OTA、安装权限或在线快照入口。只复用能独立验证的事务/解压缺陷修复，不移植 updater 或绕过本仓来源链。 |
| 原生桥与安全 | 本仓 MainFrameBridge 将可调用方法收窄到显式注册的注解方法，并用随机 capability 校验后再分发；还有独立测试。 | 当前 main 的 MainActivity 仍直接向主 WebView 注册 AndroidBridge JavascriptInterface，未见对应 MainFrameBridge capability 分发层。 | 保留本仓桥面收窄与 nonce/capability 设计；不以功能相似为由替换为上游直接桥。继续核对 iframe、导航、renderer 销毁和 capability 生命周期。 |
| 自动 Soft 恢复 | 本仓仍挂载 undo-savepoint，由健康拍记录 known-good，启动流和看门狗可执行 UndoGate。 | 上游虽保留 UndoGate 类，profile 挂载和 EngineService 的自动恢复调用已退役，另接原生修复助手。 | 保留本地自动恢复与 exact fingerprint 判据，不以同名类存在认定行为等价；见第二轮源码复核 R5。 |
| 快照事务与沙箱 | 本仓 SnapshotTransaction、SnapshotExtractor、SnapshotFs 和 UndoGate 覆盖本地刷新/恢复；shell-termux 的路径级隔离仍是已知缺口。 | 上游也有 SnapshotTransaction/Extractor，并由 UpdateManager 驱动在线更新；两边 shell-termux 都明确报告 enforcement=partial，边界仍是 Android 应用域，没有 bwrap/landlock 路径隔离。 | 事务文件均有本地产品语义，不能整文件覆盖；路径级沙箱仍是本仓独立 P0，当前上游源码也没有解决它。 |
| 验收与发布 | 按风险档验证；L2/L3 当轮代码/CDP/ADB 三层，真实任务由模型自主编排，几何改动双方向；当前 ARM64 设备不可用，候选未做设备验收。 | v0.14.8 Release 的证据针对 tag、模拟器与开发运行时；当前 main 后续源码不因此自动获得同等设备验证。 | 上游源码用于设计比较，Release 证据用于理解 tag；两者都不替代本仓按当前提交和 ARM64 真机自验。 |

### 源码级对照锚点

以下按当前 main 的可执行源码、注入清单和调用链判断；README、Release 文案、注释和残留构建清单互相冲突时，以有效源码路径为准。源码比较以行为和边界为单位，不以同名文件或哈希不同直接判定优劣。

| 源码面 | 上游当前 main | 本仓对应源码 | 结论 |
|---|---|---|---|
| 构建与有效注入 | [build-apk-source.yml](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/.github/workflows/build-apk-source.yml)、[plugin-dirs.json](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/scripts/plugin-dirs.json)、[profile patch](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/scripts/profile-web.cordis.patch.yml) | .github/workflows/build-apk-source.yml、scripts/plugin-dirs.json、scripts/profile-web.cordis.patch.yml | 两边都用 ARM64 双副本来源构建；上游有效注入含 linux-env、不含 model-capability。上游 workflow 哈希列表和注释中的 model-capability 是陈旧引用，不能当作实际包内容。 |
| WebView 原生桥 | [MainActivity.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt) 直接暴露 AndroidBridge JavascriptInterface | app/src/main/java/com/snoworwind/pocketharness/MainFrameBridge.kt、MainActivity.kt | 保留本仓方法白名单、capability 校验和关闭后撤销；不吸收上游直连桥的暴露面。 |
| 启动反馈 | [EngineStartFlow.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt) 在所有权探测/worker 前切到 Starting | app/src/main/java/com/snoworwind/pocketharness/EngineStartFlow.kt | 行为已覆盖，无需新 PR；保留本仓启动所有权和恢复顺序。 |
| 离线插件管理 | [PluginOfflinePanel.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/PluginOfflinePanel.kt)、[PluginPatchOffline.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/PluginPatchOffline.kt) | app/src/main/java/com/snoworwind/pocketharness/PluginManagementPage.kt、PluginManagementRepository.kt | 有明确源码差异；Hard 归属、失败关闭和数据完整性可作审查参考，不据此默认新增原生解析/启停/恢复体系。C1 限已有可信信息的必要诊断，C2 原方案撤回；已有 Safe Mode/UndoGate 等恢复继续保留并接受审查。 |
| ADB 键盘结果 | [AdbKeyboardReceiver.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/AdbKeyboardReceiver.kt)、[ime-broadcast.ts](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-manage/src/ime-broadcast.ts) | app/src/main/java/com/snoworwind/pocketharness/AdbKeyboardEdit.kt、AdbKeyboardReceiver.kt、AdbKeyboardService.kt、plugins/dsh-android-manage/src/ime-broadcast.ts、src/index.ts | 首轮实现已建立服务→Receiver→逐次广播解析及同屏回读；WSL Kotlin 单测 1330/1330、插件 102/102（ADBKeyboard 专项 41/41）、TS 编译、执行地图、桥对称与 Kotlin 注释门禁通过。APK/CDP/ADB 三层证据未完成，本项保持开放。 |
| 虚拟屏与网页弹层 | [vdisplay client](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-vdisplay/src/client/index.ts) 观察 data-dsh-popover-open 并隐藏 SurfaceView；[sidebar-bubbles.ts](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-client-ui-responsive/src/client/mobile/sidebar-bubbles.ts) 发出开合信号 | plugins/dsh-android-vdisplay/src/client/index.ts、VdisplayHost.kt | 几何比例已有；复用本仓 sidebar-bubbles.ts 与 native-browser-presentation.ts 的菜单语义，补 vdisplay 消费和关窗/重载/旋转时的恢复判据。 |
| 运行时更新 | [UpdateManager.kt](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/UpdateManager.kt) 保留在线快照替换并复用事务 | app/src/main/java/com/snoworwind/pocketharness/SnapshotTransaction.kt、SnapshotExtractor.kt | 本仓保留事务实现，拒绝吸收在线更新入口、安装权限和签名策略。只对具体事务缺陷做独立反例比较。 |
| Linux 环境 | [linux-host-asset-io.ts](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-linux-env/src/linux-host-asset-io.ts) 只转交宿主已暂存资产并拒绝自行下载；bootstrap 复算摘要和体量 | plugins/dsh-android-linux-env/src/linux-host-asset-io.ts、linux-release-pins.ts、app/src/main/java/com/snoworwind/pocketharness/LinuxAssetIO.kt | 准备/复验方向相近，执行载荷不同：上游复制宿主 unpacked 树，本仓从保留归档重解包。保留本地 pin、依赖闭包与重解包；剩余激活/卸载/恢复差异继续审计。 |
| 沙箱声明 | [dsh-shell-termux](https://github.com/kelai141/dsh-mobile-apk/tree/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-shell-termux) 诚实报告 enforcement=partial | dsh-shell-termux/src/index.ts、known-gaps.md | 上游没有路径级执行隔离；本仓 P0 缺口不能以“上游也如此”关闭。 |

源码比较修正了基于 Release 的两项判断：当前上游 main 已注入 Linux 插件；当前 main 的启动即时反馈已实现且本仓也已有对应行为。反过来，当前 main 的在线更新器仍在源码中，model-capability 插件则确实不在有效包/挂载清单中。后续报告需同时写清 commit/tag，避免把一个时间截面的状态套到另一个时间截面。

### 第二轮源码复核与计划修订

本轮联网复核时，上游 main 仍与“对照口径”的固定样本一致；本仓 main 为 1a8cbfc0792f9d17bfdda463aa6d1cc4105c8b2a。两边历史和源码均已取到本地静态比较，范围涵盖受选源码/测试/清单/workflow；不是只看 PR 标题，也未将文件差异清单当成全仓行为审计。

证据、路径、调用关系和静态推导集中见 [第二轮源码复核报告](UPSTREAM-SOURCE-REVIEW-2026-10-20.md)，实施要求仍以独立计划为准。本轮新增/修订处置：

| 复核项 | 对计划的影响 |
|---|---|
| R1：无引擎服务时悬浮层自收尾 | 新增独立 F 生命周期候选；与 #415 隐藏召回条分开 |
| R2/R3：输入选区、失败重投与弹层观察目标 | A 补清空语义反例，B 复用本仓菜单状态；上游实现不能直接整体移植 |
| R4/R12：离线解析与真正活动配置写者 | C1 只复用已有可信信息且区分未知和空；C2 通用原生写入方案撤回。importConfiguration 仍是真实写者，后续相关事务审查不能遗漏 |
| R5/R6/R7：自动恢复、Linux 载荷与浏览器模式 | 保留本地调用链、归档重解包、屏幕末端范围门和显式 shared 兼容语义；保留不等于安全审查豁免 |
| R8/R9/R10：语言、会话身份与抽屉补丁 | 源码线索保留为 G/H/I 非默认备选，先证明必要任务缺陷或明确产品需求；不承诺 H1/H2 或整体分屏实现 |
| R11：快速打包 | 只沿用 main 来源链，不提出 PR 提交构建 APK 的例外；证据与现行规则的冲突按具体 PR 如实记录 |

本轮只交付源码审计和计划文档，未移植代码、未运行实现测试、未构建 APK、未做设备验证。新增候选是否在设备上复现、方案是否通过三层验收，留待其独立实施 PR 取证。

### 吸收优先级与交付顺序

宗旨复核按安全性、数据完整性、清晰授权和必要功能重新排序，详见 [实施计划 §1](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md#1-宗旨审查结论与实施顺序)。撤回扩大壳侧配置职责的默认设计与分支 APK 构建例外方向，产品扩展不因上游已有而自动进入队列。各实现维持“一项一个逻辑 PR”；仅完成静态比较、没有复现或设备不可用时，明确保留待办状态，不写成已吸收。

| 阶段 | 优先级 | 工作项 | 进入条件、边界与交付 |
|---|---|---|---|
| 0 | 已完成；持续 | 固定源码比较基线 | 已核对 `main` 到 7cd7ccab，并逐项查看构建/注入清单、桥、启动、离线插件页、ADB 回执、虚拟屏、快照更新、Linux 适配和 shell 沙箱。下轮从此 SHA 检查新增提交；Release 与 main 分开记录。 |
| 安全优先 | 已知高风险，独立处理 | 本仓 `dsh-shell-termux` 路径级隔离缺口 | 以原审计、known-gaps 和现行规则处理真实风险；不声称 `workspace-write`/`read-only` 已提供目录隔离，不被 UI 验收覆盖。本计划不自行新增或豁免全局发布门禁，也不将既有问题移出安全审查。 |
| 1 | P1 / L2 | ADB 键盘有序结果回执（#420） | 本地源码已显示清空-only、读回不可用时会把 am broadcast 的命令成功当应用处理成功。先让 AdbKeyboardService 回传真实编辑结果，再为每条点名广播返回有序结果码，manage 端分别解析 clear/input 的结果；继续 nonce 与 sender UID 校验。兼容无结果码旧壳时回退到已有回读语义，不增加因回执缺失而重投；单独审查并约束现有“回读不一致后重发一次”，避免重复输入。 |
| 2 | P1 / L3 | 虚拟屏弹层遮挡（#403） | 本仓比例算法已具备；先复现 HTML 弹层被原生 SurfaceView 盖住，再让 vdisplay 消费本仓现有 open/closing/closed 状态，避免双份信号。卸载、旋转、页面重载和异常路径都须恢复显示；呈现显隐不改变执行授权。单独 UI PR，按两方向三层验收。 |
| 已具备 | 不新开 PR | 启动即时反馈（#416） | 本仓 EngineStartFlow 已在前置所有权探测和 worker 前显示 Starting，源码行为与上游修正相符。回归或差异复现时再开单项修复，不重复移植。 |
| 2A | P1 / L3，先复现 | #443 悬浮服务生命周期 | 最小提取 OverlayService 自停/非粘性策略；在引擎未启动、已停止和运行中分别复现任务划除，三层取证后独立交付，不引入召回条与面板重排。 |
| 条件 C1 | 必要性成立后 / L3 | 离线只读诊断（#416） | 复用已有可信 manifest/composition，区分未知、空和读取失败，只展示必要状态并到达已有恢复入口；不新增通用解析器、配置写接口或长期状态，在线启停仍走现有 RPC。 |
| 撤回 C2 | 不进入默认范围 | 通用原生离线配置写入 | 原拟 Kotlin 解析、HOME 编辑、pending/journal 和恢复编排尚未实施，现撤回；不扩大壳为第二个配置管理器，也不删除既有恢复。以后有明确需求时先评审引擎/插件复用方案。 |
| 安全调查 D | 按具体风险优先 | Linux 环境源码差异 | 当前两仓都实际挂载 Linux 插件，且都有“宿主暂存、bootstrap 复验、不自行下载”的代码路径。保留本仓已验归档重解包与离线 pin；剩余激活/卸载/升级/恢复面按具体反例审查，信任/数据缺陷优先于非必要 UI 扩展，不以追齐上游为目标。 |
| 保留 | 不吸收删除 | model-capability 插件差异 | 上游当前有效注入不含该插件，但本仓模型目录、models.dev 缓存、来源梯与诊断仍是本地能力。除非产品决定退役，不能以对齐上游为理由删除；如评估退役须逐项盘点数据迁移和替代项。 |
| 5 | P3 / 有指标再做 | 快照门禁提速 | 上游一次解码供多个门禁复用，Release 自报最慢三项 134.2s→57.7s。本仓先采集来源链逐门禁耗时；确认解码重复是实际瓶颈后再独立优化，保留完整 XZ 尾部校验、损坏反证与每个消费者的独立失败归因。 |
| 非默认备选 G | 必要任务缺陷成立后 | #411 中的跨入口会话身份复用 | 已核对 existingConversation/retainDockIdentity；先证实真实 store 契约及跨会话错误、状态丢失或意外资源重复，不合并用户主动镜像，不引入双工作区。 |
| 非默认备选 H | 明确产品需求后 | #450 壳侧双语与语言切换 | 已核对资源/bootstrap/桥与配置同步，保留源码线索；不承诺 H1/H2。必要显示修复优先复用已有 locale；未来跨层语言选择须有单一真源，不新增平行壳侧 Cordis 写者。 |
| 非默认备选 I | 必要瓶颈与收益成立后 | #412 手机抽屉宽内容保活 | 先采集本仓帧耗时、内存和后台副作用；必要性成立并选中后才评估双锚点及真实引擎夹具，不因上游已有而默认增加补丁。 |
| 产品备选 | 未纳入本轮需求 | #411 双工作区整体、#415 悬浮球隐藏召回 | G/I 与 F 不等于整项已吸收；后续明确需求时仍须保留 tab 能力限制，核对 store 契约、内存、焦点、横竖屏和 overlay 生命周期。 |
| 排除 | 不移植 | APK/快照 OTA、旧签名、双 ABI 资产、协调仓构建链、#418 壳侧修复助手 | 与本仓产品身份、来源链或“AI 工具只由插件注册”边界冲突。启动恢复需求仍可通过插件/非模型控制路径另行设计。 |

### 已有实现与无需重复吸收项

- 本仓已实现 DSH `0.2.1-rc.2`、堆上限自然值修复、刷新窗口启动续跑、Shizuku 兼容与重建、导航栏透明、主题、剪贴板回退、宽表格/终端卡片、管理中心、会话侧栏拖入和窄屏气泡导航。对应源码/版本证据见 [changelog-archive.md](changelog-archive.md)、[ENGINE-UPGRADE-2026-10-19.md](ENGINE-UPGRADE-2026-10-19.md) 与本账本前表；候选设备验收按本仓缺口记录，不借用上游结果。
- XZ 快照尾部校验和损坏反证已经纳入本仓门禁；只研究可证明的耗时优化，不重复移植判据。
- 模型能力插件的整体退役不吸收：上游当前有效插件清单不含该插件，本仓仍有独立目录、来源与探测链；删除必须有本地产品决定和迁移方案，不能为了源码对齐而做。
- 启动即时反馈已在本仓 EngineStartFlow 实现，无需重复吸收；虚拟屏比例也已实现，#403 只剩原生 SurfaceView 与 HTML 弹层协调。
- Linux 插件不再记作本仓独有：当前上游 main 已将其编入来源链和 Cordis 挂载。本仓离线 pin、应用身份/签名、来源闭包及 Hard/Soft/Data 持久化仍按本仓设计和证据验收。

### 详细吸收执行计划

宗旨审查、现行 main 来源链与职责边界、最小修复步骤、撤回/备选范围、模型自主任务和 PR 完成条件统一维护在 [上游源码吸收实施计划](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md)。本账本只维护比较结论、优先级和实际吸收记录；历轮执行与未验收边界见该计划末尾的对应记录。

## 2026-10-19 吸收记录

本轮经 GitHub API 核对 #414 已合并：源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`，上游合并提交 `f2df6fa0d2a3b70f171f2a28ed3f020dcad5997a`。此前检查游标 `18439f1b8cb96f7d4d9b8508bdb02aa2695143a3` 仍是上游 `main` 当前尖端，故不前移。吸收不只提升上限：原上限 1024 恰等于重现 V8 自然 1120MB 堆上限的标志值，导致常见设备 `totalRam/2` 恒被截断；本仓新增自然标志真源、cap/区间宽度门禁、双源同为 1024 的反证，以及现实内存档 JVM 断言。设备内存压力仍待设备复核。

## 2026-10-21 上游增量检查

| 项 | 结果 |
|---|---|
| Pocket Harness 同步 | `git fetch --prune origin` 成功；本地 `main` 与 `origin/main` 同为 `f57001d6f52ade37a86b9c65b61f78a448ae51de`，无待拉取提交。清理了 12 条远端已删除的旧跟踪分支。当前实施从该同步点新建分支。 |
| 上游检查游标 | 上次记录 `7cd7ccab8247514e20be2925c92d46b45e70d152`；最新 `main` 为 [`1a8f9fb309580c8c1a3c826272c8da17c9e4877b`](https://github.com/kelai141/dsh-mobile-apk/commit/1a8f9fb309580c8c1a3c826272c8da17c9e4877b)，2026-10-20。其间新增 42 个提交；检查了提交列表、重点生产代码、相关测试及注入/产物门禁，不将发布说明或测试自述当成本仓证据。 |
| 选择性吸收 | 快照用户文件保全、配置原子发布和精确残留归属（`bbae1ca` / `a4c44d7` / `20fda3b`）；待发来件台账/TTL 清理（`e5330fe` / `fc93163`）；来件附件会话使用当前引擎 `uiWorkspace.openSession`（`5a6761b`）；产物鉴权门禁按每个 tar 成员分别核对（`8edfdb8`）。本仓逐项保留既有包身份、插件边界和本地路径语义后实现。 |
| 暂缓或排除 | 注入清单把 `dsh-undo-savepoint` 移入退役项不能直接照搬：本仓仍主动挂载并使用 UndoGate；离线启动页/视频、下载页视觉改版属于未提出的产品扩展；通知混合队列与本仓互动通知、待答报告队列职责不同；工厂 profile 退役修复仅在本仓受证实的原子发布风险范围内评估，不搬入上游对已退役插件所有权的整套语义。 |
| 设备边界 | 当前环境未发现 `adb` 命令，ARM64 设备不可用。代码与离线反例可执行；涉及快照/来件安全或用户可见导航的改动，设备三层未完成即保持开放，不写成验收通过。 |

逐项改动、验证命令与状态见 [2026-10-20 计划的 10-21 执行附录](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md#12-2026-10-21-增量吸收执行)。本轮没有改上游游标的含义：`1a8f9fb` 表示已检查，不表示已吸收。

## 2026-10-21 吸收 PR 与验证状态

| 吸收项 | 本仓 PR | 本机证据 | 未完成边界 |
|---|---|---|---|
| 快照用户文件保全、配置原子发布与残留归属 | [#80](https://github.com/snoworwind/pocket-harness/pull/80) | `SnapshotTransactionTest`、`SnapshotMoveResidueTest`；完整 Kotlin 套件 1338/1338 | 已合并 `f46e9b1`；L2 实机三层验收未做，尚未验收 |
| 产物路由鉴权逐归档成员检查 | [#81](https://github.com/snoworwind/pocket-harness/pull/81) | `check-api-route-auth.mjs --self-test` 含受控假绿负控通过 | 已合并 `39ab569`；来源快照集成输入未提供；未做实机验收（L1 门禁改动不依赖设备） |
| 待发来件台账并发、引用与 TTL 清理 | [#82](https://github.com/snoworwind/pocket-harness/pull/82) | 完整 Kotlin 套件 1349/1349 | 已合并 `63c3371`；L2 实机三层验收未做，尚未验收 |
| 来件附件草稿导航切到 `uiWorkspace.openSession` | [#83](https://github.com/snoworwind/pocket-harness/pull/83) | 插件测试 753/753；产物包含新导航调用 | 已合并 `acc442e`；`npm run typecheck` 仍有既存 `conversation-dock.tsx:137-138` 错误；CDP/ADB 未做，L3 尚未验收 |
| 工厂 profile 修复先备份并原子发布 | [#84](https://github.com/snoworwind/pocket-harness/pull/84) | 完整 Kotlin 套件 1354/1354；`check-code-map.mjs`、`check-kotlin-comments.mjs`、`check-kotlin-test-count.mjs`、`git diff --check` 通过 | 已合并 `255806b`；L2 实机三层验收未做，尚未验收 |

五个实现 PR 已按依赖顺序以 merge commit 合入 `main`。本机与 CI 证据不代表实机验收：#80、#82、#84 的 L2 与 #83 的 L3 三层设备验收未做，本轮按用户明确要求先行合并；这些改动仍属未验收，进入发版候选前必须补齐三层证据。#81 是 L1 门禁改动，`--self-test` 与受控负控通过；没有执行实机验收。本记录中的测试为各实现分支对应提交的本机证据，完整限制见实施计划 §12.2–§12.3。

## 2026-10-23 上游增量检查与处置

| 项 | 结果 |
|---|---|
| 本仓比较基线 | 远端 `main` 已核实为 [`99edec7cc5ba2dcf64fde4b7b2705153fc950dca`](https://github.com/snoworwind/pocket-harness/commit/99edec7cc5ba2dcf64fde4b7b2705153fc950dca)。相较先前本地缓存的 `511b7e3`，新增 PR #111 仅更新构建环境、坑位、已知缺口与 Linux 调查文档中的 CI 证据；产品代码、插件源码和依赖清单未变。 |
| 上游检查游标 | 上次 `1a8f9fb309580c8c1a3c826272c8da17c9e4877b`；已通过 GitHub main Atom 与 `git ls-remote` 核实最新为 [`a8d79b5e861574b6a0229767629eded577c55766`](https://github.com/kelai141/dsh-mobile-apk/commit/a8d79b5e861574b6a0229767629eded577c55766)，更新时间 2026-10-22 13:48:14 UTC。检查两游标间 13 个提交说明、文件范围与本仓对应源码/测试；逐项结果见 [实施计划 §13](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md#13-2026-10-23-上游增量复核与处置)。 |
| 符合本仓宗旨且本轮可执行的源码吸收 | 未发现。已具备的刷新让行不重复移植；clean-install 依赖修复在本仓干净安装与完整插件测试中未复现；其余 UI/启动功能属于非默认产品扩展，或是需要复现和设备三层证据的 L2/L3 改动。此次只更新比较账本与处置计划，没有把“检查完”写成“源码已吸收”。 |
| 本仓证据 | 使用 Node `v24.22.1` 执行 `npm ci --no-audit --no-fund`，从无 `node_modules` 的工作树干净安装成功；随后 `npm test` 为 52 个测试文件、757 项通过。UI 测试目前 mock 了 primitives，且本仓根本未声明上游修复所替换的缺失包；测试通过说明当前版本没有 #483 所述 clean-install 故障，不说明 primitives 浏览器组件已获得额外渲染覆盖。 |
| 高风险候选与设备边界 | #474 的重试退避/启动失败诊断值得在可复现连续启动故障时单独评审；其 logcat 数据面和“启动失败后允许 su 回退”会改变诊断及特权路径，不能整体照搬。当前环境没有 `adb`，故不改 Shizuku/桥/本机界面代码，也不把这些未验证候选列为已吸收。#481 同属壳侧语言桥与 Activity 重建变更，本仓没有对应语言 setter/同步调用链，暂不扩展。 |

此游标仅表示检查已覆盖到 `a8d79b5`。并未吸收上游版本号、签名、Pages 发布清单、README 群二维码、开屏视频、分栏/浮窗、语言切换、临时探针处置或跨仓镜像规则；逐项理由与可重开条件见实施计划 §13。
