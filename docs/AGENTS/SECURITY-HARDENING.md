# 安全加固分支宗旨

> 2026-10-18：项目迁入独立私有仓 `snoworwind/pocket-harness`，维护线改为 `main`。本文保留原分支时期的安全宗旨与证据要求；文中「本分支」按当前 `main` 维护线理解，历史分支名只作为迁移来源记录。

## 目标与范围

第二轮 17 项发现的修复与兼容变化见 [当轮修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md)；后续 Linux 离线资产及来源构建证据见 [后续修复账本](AUDIT-REMEDIATION-2026-10-18.md)，当前 namespace 与来源构建进展见 [迁移记录](NAMESPACE-MIGRATION-2026-10-19.md)。源码修复不等于设备验收；设备证据仍未补齐。下面「只登记」描述保留原审计轮次事实。

第二轮发现时的历史记录为 [SECURITY-AUDIT-2026-10-17-R2.md](SECURITY-AUDIT-2026-10-17-R2.md)，17 项发现、坑位 376-392；当时只登记未修，当前实施以上方修复账本为准。上一轮四项修复及此前设备缺口见 [SECURITY-AUDIT-2026-10-17.md](SECURITY-AUDIT-2026-10-17.md)。

`main`（原 `security/hardening`）的宗旨是：**最大程度提高软件的安全性和可验证性**。

审查范围包括当前全部代码和历史遗留实现，包括安卓壳、原生桥、插件、自包含副本、快照与恢复、构建和发布链、下载页面及相关配置。持续发现漏洞、修复根因、减少攻击面，并为每项安全结论提供可复核的证据。以用户数据完整、授权边界清晰和必要功能可用为约束。

这是持续加固目标。完成一批修复后，仍需记录剩余风险、检查覆盖和证据缺口；文档中的目标不构成“没有漏洞”或“已经全面验收”的结论。

## 铁律：APK 只能从源码构建

本仓**任何 APK 都必须由来源链产出**，禁止用 `build-apk-013.ps1`、`build-release.ps1` 或其他本地/协调仓链产出、归集或发布 APK。理由：只有来源链的输入面可从源码复核——它只构建**已提交 HEAD**、在**隔离检出**内执行、**不读 `base/*.tar.xz` LFS 底座**（Termux 基座由官方验签仓库包组装）、不使用协调仓，并把 `project-component-provenance` / `component-source-provenance` 写进产物。

| 项 | 允许（来源链） | 禁止 |
|---|---|---|
| 云端入口 | `.github/workflows/build-apk-source.yml`（`build-apk.yml` 复用的就是它） | 旧 LFS Release 链：`release.yml` 已删除，不得复活 |
| 本地入口 | `node scripts/source-build/run-local-source-chain.mjs` | `pwsh -File scripts/build-apk-013.ps1 ...`、`scripts/build-release.ps1` |
| 底座输入 | Termux 官方签名仓库 + 固定 bootstrap（逐 deb 哈希） | `base/*.tar.xz` LFS 归档 |
| 产物要求 | 携带来源链 provenance，且 `sourceRepository` 必须等于**本次构建实际所在仓库** | 无 provenance、或 provenance 指向其他仓库的产物 |

**发布面（2026-10-17 用户更新决定）**：允许手动来源构建成功后自动创建 ARM64 预发布草稿，禁止自动公开；入口、权限隔离与资产要求以 [RELEASE.md §5](../RELEASE.md#5-来源链预发布草稿2026-10-17-按用户决定) 为准。旧 `release.yml` 和手工发布脚本不恢复，公开前须完成候选设备验收。

**「独立」的含义（避免歧义）**：本仓的构建、验证都不需要 kelai141 名下任何仓库——来源链只取 `deepseek-ai/deepseek-harness`、Termux 官方签名仓、npm registry 与 Android SDK。Linux launcher/runtime/bootstrap 源码由本仓按来源提交导入并在树内哈希校验；其上游出处与许可必须保留，构建时不访问旧仓。**跨树镜像纪律已整体退役**（2026-10-15）：`check-patch-mirror.mjs` 只保留 registry↔IMPLS 自洽面，`check-release-gates.mjs` 的「两树同版」断言删除，`scripts/patches/**` 与各子仓副本在本仓内即权威，不再有「先合本仓镜像 PR、再合协调仓权威源 PR」这条要求。手工发布脚本（`upload-release.mjs` / `sync-release-notes.mjs`）与 `.github/workflows/release.yml` 均已删除；新草稿入口仅走来源链；残留的本地/协调仓链脚本（`build-apk-013.ps1` / `build-release.ps1`）禁止作为构建入口；`build-snapshot-013.mjs` 仍由来源链内部调用，不得独立运行它绕过来源校验。保留的许可声明、仓库字段、README 来源说明及历史记录描述事实来源，不得改写成「我们的」。

## 引擎吸收：2026-10-19

固定官方 0.2.1-rc.2，按源码构建并重核插件、路由、补丁和依赖闭包；两条 PTC 执行路径的授权与环境边界均保留。完整来源/反证、PR 与最终来源链状态统一在 [升级记录](ENGINE-UPGRADE-2026-10-19.md)。这是含 L2/L3 的开发候选，未做设备验证；设备缺席不写成通过，公开发布仍被最终候选三层验收阻断。

## 维护方式

2026-10-18 用户决定：仓库保持私有，暂不使用收费分支保护，不升级套餐。继续通过 PR 交付，合并前复核同一提交的 CI；Actions 已强制 SHA 固定，默认 token 只读且不允许工作流代批 PR。上述控制不能替代远端分支保护，不将其登记为已启用。当前仅构建 ARM64，设备证据不可得时如实保持未验收。

本仓作为独立私有项目的长期维护线，以 `main` 为默认分支；安全加固与来源链规则继续适用。

| 项 | 当前值 |
|---|---|
| 分支 | `main`（默认分支） |
| 迁移来源 | `snoworwind/dsh-mobile-apk` 的 `security/hardening` 分支，基线提交 `cb1c315` |
| 合并策略 | `main` 即交付线；不以上游 `main` 为合并目标，上游改动经安全审查后择优吸收 |
| 配套详档 | 缺口与验证边界 [known-gaps.md](known-gaps.md)；缺陷与修法 [gotchas.md](gotchas.md) |

- 日常交付采用可追溯的提交与 PR，CI 通过后合入 `main`。
- 引入上游改动时，须重新审查其对本仓安全约束和证据的影响。
- 参考上游检查游标、逐项处置与验证边界见 [上游跟踪账本](UPSTREAM-TRACKING.md)。
- 原 `security/hardening` 只作为迁移来源记录，不在新仓复活为长期并行分支；维护方向以用户后续明确指示为准。

## 实施原则

1. **审查全部可达路径**：同时检查 UI、原生桥、后台服务、调试入口、生命周期续继及跨进程调用；追踪输入、权限、执行目标、结果回传和持久化状态。
2. **最小权限与最小暴露面**：移除不需要的能力、权限、网络入口与共享目录；明确 Intent 接收组件、文件归属、受信来源和目标设备屏幕。
3. **授权在执行边界落实**：调用方声明不能代替执行端校验；跨层传递的路径、URL、命令、身份、状态与权限事实都须核对。授权不足、解析失败、扫描超限或目标无法确认时拒绝敏感操作，并提供明确原因。
4. **保护凭据与用户数据**：约束凭据的发送目标和重定向；日志按出口脱敏；文件读写限定归属与路径。事务中断、升级、回滚和清理均须保留可靠恢复来源，处理符号链接、并发与校验后被替换的风险。
5. **修复根因并保持可审计性**：代码、桥声明、生成产物、镜像副本和文档同步；成功、失败、取消、超时与部分完成分别如实报告，保留不含秘密的诊断证据。
6. **安全结论可证伪**：为结论说明触发条件、生产调用链、检查方法和预期失败行为。获准执行测试后，用真实生产路径的正例、反例及必要的设备事实检查修复是否成立；静态字面量匹配只证明其覆盖的结构条件。
7. **基线与豁免有依据**：保留其他功能的检查强度。完整功能退役时，只定点删除对应实现、用例和基线，记录用户要求、范围与数量变化；每项已接受风险注明原因和剩余影响。

## 当前明确决策

| 决策 | 原因与边界 |
|---|---|
| 移除应用内更新 | 用户要求删除此功能；已移除 APK 检查、下载、安装及旧在线快照更新入口。内嵌快照部署和历史中断事务恢复保留，详见 [gotchas.md](gotchas.md) 坑 317。 |
| 保留历史 debug 签名 key | 用户明确要求兼容已经使用该 key 的历史版本。公开 key 无法提供独占签名身份保证；此项是已接受的剩余风险，不能计为已修复。 |
| 验证范围随当前任务记录 | 先前加固批次按用户要求仅编译和静态检查；用户随后要求在 WSL 从源码构建可验证 APK，本次执行来源链规定的测试与产物门禁。设备验收尚未执行，旧批次未测记录不改写成当时已通过。 |

## 证据与结论要求

每项发现与修复须能追溯到：**源码提交、触发条件、根因、受影响入口、修复位置、检查命令、实际结果、证据位置和未覆盖范围**。检查失败、跳过、无法判定和未执行分别记录；环境阻塞也要保留原始错误及其发生阶段。

| 证据 | 可支持的结论与边界 |
|---|---|
| 人工审查、符号扫描、协议与权限静态门禁 | 支持已检查的源码关系和结构约束；不能证明运行时行为或所有攻击路径安全。 |
| Kotlin PSI 语法解析 | 支持语法成立；不包含 Android 依赖解析、完整类型检查或 APK 构建。 |
| TypeScript/插件编译 | 支持被编译源码的类型与产物生成；不证明 APK 内嵌产物、设备运行结果或安全策略有效。 |
| 完整 Android 构建 | 支持对应源码可生成产物；运行时安全与交互仍需各自证据。 |
| 自动化测试与设备验收 | 只在获准且实际执行后登记结果，绑定同一源码和产物；接受标准按 [emulator-test-protocol.md](emulator-test-protocol.md) 及仓库风险分档执行。 |

本地 `.deploy-tmp` 日志用于本机复核。需要提交评审或形成发布结论时，应提供可取得的证据、产物身份与重现方法，明确本地日志的可用范围。发布须满足对应风险档位的证据要求及用户授权。

## 复核轮次：2026-10-15（该轮基线 `3036e2d`）

该轮应用源码基线为 `3036e2d`（**历史轮次记录**，此后提交见 [changelog-archive.md](changelog-archive.md)）。本轮补充分支文档，并修正维护文档静态门禁的换行比较；该轮结果如下：

- UI、bridge、manage 插件重新编译通过，日志为 `.deploy-tmp/branch-purpose-build-{0,1,2}.log`。
- 更新入口、桥方法、安装权限及专用 URI 映射在原生源码、前端源码和 UI 生成产物中未发现残留；保留历史事务恢复。
- 桥对称、Kotlin 注释、control op、op registry、工具名承诺、Manifest 加固及执行地图静态门禁通过；日志为 `.deploy-tmp/branch-purpose-check-*.log`。门禁输出中的已有豁免仍按原范围保留。
- 维护文档门禁修正 CRLF 行尾误报后通过；生成内容校验要求不变，根因与检查范围见 [gotchas.md](gotchas.md) 坑 318。
- Kotlin 语法解析、XML 解析、JavaScript 语法检查及基线退役账目核对通过；本次本地日志使用 `.deploy-tmp/branch-purpose-` 前缀。
- 完整 Android 编译仍在 Gradle 配置阶段报 `Type T not present`（`.deploy-tmp/branch-purpose-android-compile.log`），详见 [known-gaps.md](known-gaps.md) 的编译环境条目；本次未产出 APK，未运行测试或设备验收。

可重复执行的编译与静态检查入口（命令不包含测试）：

前置：三条 `run build` 需要各目录先装依赖（各目录 `npm ci`；Windows 侧按 [build-and-env.md](build-and-env.md) 用已配 npmmirror 源的 `npm install`）。八条 `node scripts/check-*.mjs` 不读 `node_modules`，本仓单树即可跑（本机实测 exit 0）；`check-release-gates.mjs` 的跨树镜像层已退役，当前本仓即可执行静态接线检查；需要运行时产物的门禁仍需对应输入。

```powershell
# Windows（PowerShell）
npm.cmd --prefix dsh-client-ui-responsive run build
npm.cmd --prefix plugins/dsh-android-bridge run build
npm.cmd --prefix plugins/dsh-android-manage run build
```

```bash
# macOS / Linux / WSL 等价写法
npm --prefix dsh-client-ui-responsive run build
npm --prefix plugins/dsh-android-bridge run build
npm --prefix plugins/dsh-android-manage run build
```

```bash
node scripts/check-bridge-symmetry.mjs
node scripts/check-kotlin-comments.mjs
node scripts/check-control-ops.mjs
node scripts/check-op-registry-parity.mjs
node scripts/check-tool-name-promises.mjs
node scripts/check-manifest-hardening.mjs
node scripts/check-code-map.mjs
node scripts/check-maintenance-docs.mjs
node scripts/check-release-gates.mjs         # 聚合入口：静态接线断言（本仓）
node scripts/check-release-gates.mjs --list  # 现数门禁集合及「仅构建/发布」标注
```

门禁归属：`--list` 里多数条目是「仅构建/发布」，需要快照或两棵树同时在场的条目在本地单跑给不出有效结论（SKIP 不计通过）；四项已下沉到 apk-ci/本地链；`check-maintenance-docs.mjs` 只作 PR Gate 提示 job，不在聚合 `--run` 段内。发布链跑的是聚合入口的 `--run` 段，手动单跑各脚本与它不等价。

### 该轮追加：启动诊断与外部导入加固（2026-10-15）

修复启动诊断文件及 logcat 中的 launch-token 暴露路径：`writeBootDiag` 在写入前对完整诊断行调用 `EngineAuth.redact`；boot-fail 与显式健康标记经共享有界追加器再次脱敏；`writeBootFail` 的 logcat 记录保留失败阶段、detail 和异常类型，但不再把原始 Throwable 交给 Android 打印未脱敏栈。完整栈仍写入应用私有 `boot-fail.log`，并在落盘边界脱敏。根因、调用链与检查边界见 [gotchas.md 坑 319](gotchas.md)。

首次源码及静态门禁检查通过。Windows Java 24.0.1 下尝试 `:app:compileDebugKotlin --no-daemon`，在创建 `:app:outgoingVariants` 任务时于 Gradle 配置阶段报 `Type T not present`，Kotlin 编译任务未执行。首次 WSL Java 17 重试因缺 Android SDK 而停止；其后已按用户授权安装 Linux SDK 并完成主源码编译，见 [build-and-env.md](build-and-env.md) 的 WSL 编译小节。未新增或运行测试、未做设备验收、未构建 APK。`EngineAuth.redact` 当前针对 URL query 中的 `token=` 值；这不是对任意格式秘密的通用扫描器，诊断调用方仍应避免传入其他凭据。

继续沿生产调用方复核时，发现 `EngineStartFlow.onClientPluginTreeFailed` 在调用 `writeBootFail` 后又直接把页面契约原文写入 logcat，绕过集中出口的脱敏。现将该函数的文件 detail 与 logcat 摘录统一改用先脱敏、后截断的诊断副本；恢复逻辑仍使用内存中的原文。根因、编译输入和检查证据见 [gotchas.md](gotchas.md) 坑 320。编译器警告中的可空父目录与恒定条件已静态查看，当前调用处有固定应用目录前提，未据警告本身宣称存在安全漏洞。

外部文件导入继续复核（2026-10-15）：`MainActivity` 的 exported VIEW/SEND 入口曾允许整个应用私有目录的 file URI，且 content URI 没有 Provider 归属或读授权检查，可能借壳权限把受保护文件搬进可分享的来件工作区。已收紧来源权限，在 `copyIn` 与实际打开前重检，并通过实际持有的普通文件 FD 核对共享存储归属后直接读取；目标叶文件排他创建，分享参数采用 Uri 类型化解析并处理运行时解析异常。没有将「自动搬入草稿」描述成「已经向外发送」；根因与证据见 [gotchas.md](gotchas.md) 坑 321。WSL Kotlin 主源码编译与静态检查通过；未新增或运行测试、未做设备验证、未构建 APK。设备来源/授权/FD 兼容性仍未验收。

## 当前状态与未覆盖范围

### 草稿发布资产集合漏验（2026-10-17）

写权限任务已补上传集合与哈希清单的一一对应检查，防止通配符夹带未登记 APK；真实旧 shell 反例与修复回归见 [gotchas.md 坑 371](gotchas.md)。未构建 APK、未做设备验证、未实际发布草稿，不能替代候选验收；输入目录自身和祖先链接的排查未在本项中形成可达漏洞结论。

### 来件清理的叶对象边界（2026-10-17）

已修复清单中的叶链接被解析成删除目标、目录被递归删除及嵌套元数据可删的问题。清理只接收工作区顶层普通文件，保留 Android 目录别名兼容；旧生产实现三条反证均误删，修复后插件 26 项通过，见 [gotchas.md 坑 370](gotchas.md)。未做设备验证，不计为数据删除行为的三层关闭。

### 来件下载的路径替换窗口（2026-10-17）

已修复 content 路由在校验后异步重开路径的问题：普通文件 FD 完成归属校验后直接用于读取。旧生产实现的叶文件/父目录替换均能返回工作区外测试秘密；修复的生产路由与打开前替换拒绝反证、FD 释放断言共 23 项通过，见 [gotchas.md 坑 369](gotchas.md)。未做设备验证，Android `/proc/self/fd` 与实际下载交互仍须设备验收；不计为三层关闭。

### 历史日志清理类型边界（2026-10-17）

历史日志槽目录误入递归删除器的源码路径已修复，普通文件限制与扫描后替换反证见 [gotchas.md 坑 367](gotchas.md)。Linux 插件 63 项通过；本轮未构建 APK、未做设备验证，尚未完成数据删除行为的设备验收，不计为三层关闭。

### 初始 loopback 监听者冒充（2026-10-17）

坑 350 的源码修复使用壳进程持续持有的 TCP 3080 listener 与私有、逐连接校验对端 UID 的 Unix socket；覆盖原生 HTTP/WS、WebView、控制队列和来件载荷，入口拒绝发生在发送秘密之前。宿主 HTTP/WS 反证已通过，Kotlin 与设备用例编译结果及边界统一记录于 [gotchas.md 坑 352](gotchas.md)。当前没有在线 ADB 设备，**未做设备验证**，不能视为漏洞三层验收关闭或发布候选通过。

### 模型能力探测凭据出口（2026-10-16）

被动/主动 fetch 重定向、Gemini query key 和诊断回显的泄漏路径已修，插件编译及 170 项测试通过，源码/lib 同步。真实 HTTP 服务反证覆盖跳转和正常请求，真实 apply/discover 覆盖诊断日志出口。高风险 runtime 面的 CDP/ADB 层当前因设备离线未执行，**未做设备验证**，不构成功能或候选验收；继续条件、兼容变化与完整证据统一见 [gotchas.md](gotchas.md) 坑 340。

### 来源链宿主写入边界复核（2026-10-16）

修复初建/续跑目录链接、报告叶子及 dangling link 绕过隔离目录的宿主写入路径。真实 runner 负控与原始缓存兼容性证据见 [gotchas.md](gotchas.md) 坑 339；来源套件 89/89 通过。该 L1 修复未构建 APK、未做设备验证，不提供对并发恶意进程或硬链接的通用沙箱保证。

### 归一化信息完整性复核（2026-10-16）

后续权限反例确认 v2 仍未覆盖 Unix mode、空目录与特殊条目，现已修复并升为 v3；WSL 真实执行及负控见 [gotchas.md](gotchas.md) 坑 338。旧版本摘要均须重算，权限结论不能从 Windows 文件系统测试推出。

构建链内部的快照摘要与 tarball 重打包存在信息丢失及入口重排，已修复原字节哈希、特殊字段保留、条件导出顺序与 gzip 时间戳。旧版归一化摘要不能继续支撑语义等价结论，需按 v2 重算；历史 APK 的签名、字节哈希和提交身份记录保留。反证、命令与边界统一见 [gotchas.md](gotchas.md) 坑 337。本轮未构建 APK、未做设备验证，不构成最终候选验收。

### 来源证明一致性复核（2026-10-16）

发现并修复构建结束时信任可写输入报告的路径：组件来源身份改为从固定提交独立重建，新增源码在输入、输出两端重查。根因、攻击反例、真实 CLI 负控、真实既有构建的复核及信任边界统一见 [gotchas.md](gotchas.md) 坑 336。本轮未改 Android 或运行时源码，未重建 APK、未做设备验证；上一轮 APK 的提交身份不变，不改记为包含此次修复。

截至 `a649df9`（2026-10-15）：

| 面 | 当前事实 | 能支持什么结论 |
|---|---|---|
| 静态门禁 | 八条本地门禁在 macOS 26.6.2 + Node 20.18.0 下于本尖端实测 exit 0：bridge 对称、Kotlin 注释、control op、op registry 平权、工具名承诺、Manifest 加固、执行地图、维护文档生成块；聚合入口 `check-release-gates.mjs` 同样 exit 0（声明门禁集 35 项）。但它的「两树同版」断言在本机走的是**对端缺席跳过**分支——脚本对跳过也打印 PASS 且 PASS 不打印 detail，**不计为已比对**；`check-patch-mirror.mjs` 的镜像层同理需要协调仓树在场 | 只支持静态关系成立，不证明运行时行为；跨树一致性在本机未取得证据 |
| Kotlin 全量测试 | 来源链执行 1218 例零失败零跳过（旧测试放行未认证长选项等预期已修正，生产屏幕授权逻辑未放宽，见坑 322）；引擎侧屏幕范围 47 例通过；已登记的 MiMo 精确 verifier 补接分派，并以完整补丁通过、部分补丁拒绝、未知 verifier 拒绝证明判据，见坑 323 | 绑定当时源码与产物，不覆盖设备行为 |
| 来源审计 APK | 隔离检出从已提交源码（`bc6637f`）产出 arm64 APK，14 项独立复核通过，判据为语义归一化摘要 | 支持产物与源码的对应关系；**未做设备验收、未发布** |
| Windows 完整编译 | Java 24 下 Gradle 配置阶段仍报 `Type T not present`，未改工程版本规避 | 该环境阻塞未解除，不记通过 |
| 设备验收 | 未执行：竖屏 16416 / 横屏 16384、arm64 真机、覆盖升级均未跑 | 不得据此称功能验收通过或具备发布结论 |

复核面、命令与产物身份见 [build-and-env.md](build-and-env.md) 的来源审计小节；逐条改动状态见 [changelog-archive.md](changelog-archive.md)。

## 复核轮次：2026-10-16（吸收上游 `main`，上游尖端 `5fca94f`）

按用户要求把上游 `kelai141/dsh-mobile-apk` 的 `main`（`d19ab1b` → `5fca94f`，7 个提交）并入本分支。宗旨的「分支维护方式」写着**引入上游改动时须重新审查其对本分支安全约束和证据的影响**，本轮逐项审查如下。

| 吸收项 | 内容 | 本分支的安全/证据审查 |
|---|---|---|
| 剪贴板回退镜像（上游 `1f60bf3`） | `dsh-host-web-compat` 0.1.13 → 0.1.14：包住 `navigator.clipboard.writeText`，回落链「原生 API → 壳侧桥 `androidBridge.copyText` → `execCommand('copy')`」，三条全失败给人话回执 | 只写不读剪贴板；桥方法 `copyText` 是本分支早已存在的既有面，**未新增桥方法、权限、网络或文件面**；注入层仍只作用于引擎页。证据：`scripts/smoke-injections.mjs` 18 项在本机全过，含「未包装的拒绝写入仍然拒绝」（负控）、「桥收到精确文本」、「无桥时回落 execCommand」、「全失败必须留可见回执」 |
| 主题算法改色（上游 `5fca94f`） | 引擎页 `WebViewShim.applyBaseline(..., appOwnsTheme = true)`，新旧 provider 都关闭算法深色；主题桥只在空 `#root` 启动期写底色 | 面**收窄**而非扩大：只有引擎页关算法改色，**隔离浏览器（BrowserHost）继续走默认策略**（`WebViewShimTest` 有断言）；无新权限/IO/网络。证据：`scripts/boot-watchdog.test.mjs` 本机通过，含「移除守卫即双模式判红」负控 |
| 手机端宽表格 / 终端卡片（上游 `db03c5f` / `493dae3`） | 新增两份 CSS 注入（`mobile-table.css.ts` / `terminal-block.css.ts`）与配套 spec | 纯样式，不触碰桥、权限、存储；选择器只用稳定属性与结构关系（`data-dsh-frame` / `data-terminal` / `html[data-dsh-mobile-form]`），不用 CSS Modules 哈希类名 |
| 刷新窗口内的启动请求（上游 `438538c`） | `EngineStartFlow` 按 destroyed/running 分开处置 + 有界等待续跑；`EngineManager.lastRefreshDeferred` 与失败语义分开；新增 `stage=safe-mode-restart-started` 等 boot-fail 记录 | 直接落在本分支的 **L2 敏感面**（快照事务窗口 + 启动流 + 诊断落盘）。逐条审查：① 判据用**跨进程真源** journal 文件而非本 Activity 实例的内存态，与本分支「状态与授权在执行边界核实」同向；② 新增三处 boot-fail 记录的内容只有 phase、账龄与决定，**不含 URL 或凭据**，且仍走坑 319/320 建立的脱敏出口；③ 等待有界（16 分钟预算 + 1s 步进），不引入无限挂起；④ journal 只读，未新增权限、网络与文件写面 |
| 文档与赞助码（上游 `2100e62` / `659ea9c`） | 上游 README 增加自愿赞助说明与两张收款码；坑位与执行地图文档 | 属于宗旨「独立」口径里**明确保留的归属与出处类内容**（不得改写）；两张 PNG 无代码面影响 |

**冲突解决口径**（本分支与上游**同名编号含义不同**，按 §5.1「编号递增、不得重编号」续编）：

- 坑位：上游 309/311/312/313/310 → 本分支 **329/330/331/332/333**，条目内保留上游原编号便于逐条对照（例：本分支 313 = 路径脚本隐藏屏幕操作，上游 313 = 陈旧工作树回退）；
- 执行地图：保留上游新增/修改行，锚点按**本分支合并后的实际行号**重取——上游写的 `EngineStartFlow.kt:700`、`EngineManager.kt:207`、`EngineManager.kt:813、1344-1369` 在合并后全部漂移（这正是 known-gaps 里「锚点只验行号存在性、不验语义」那条已知缺口的现实样本）；
- Kotlin 单测基线：本分支 1218（含 `featureRetirements`）+ 上游 `DeferredEngineStartTest` 13 例 + 上游未记账的 `WebViewShimTest` 1 例 = **1232**；
- 上游的 `UpdateManager` 执行地图行**不复活**：该实现已按用户要求整体退役（坑 317），复活一行只会制造 phantom 锚点并让门禁判红。

**本机验证证据（2026-10-16；Android 真机 + Termux 运行时；Node 24.18.0 / OpenJDK 17 / Gradle 8.11.1 + API 36）**：

- 代码层（壳侧）：`dsh-gradle :app:testDebugUnitTest --no-daemon --parallel` —— 主源码与测试源码**编译通过**（合并后的 `EngineStartFlow.kt` / `EngineManager.kt` / `MainActivity.kt` / `WebViewShim.kt` 与新增的 `DeferredEngineStartTest`）；**1232 例中 1231 通过**，唯一一例 `EngineAuthPolicyTest` 是本机文件系统 birthtime 不可得导致的**环境误红**（探针实测、为什么不是本合并引入、为什么不改用例，见坑 334）。
- 代码层（注入/插件面）：`dsh-host-web-compat` 三个 `node:test` 文件与 `smoke-injections.mjs` 18 项全过；`dsh-client-ui-responsive` 的 vitest 套件在**与合并树逐字节相同**的副本上跑（`src`/`tests` 目录哈希一致）：两份被吸收的 spec 76 例全过（`terminal-block-css` 6 / `sidebar-gestures` 70），全量结果见下。
- 静态门禁：`check-code-map`、`check-kotlin-comments`、`check-bridge-symmetry`、`check-maintenance-docs`、`check-control-ops`、`check-op-registry-parity`、`check-tool-name-promises`、`check-manifest-hardening`、`check-patch-mirror`、`check-gate-skips`、`check-api-route-auth`、`check-dead-tokens`、`check-bounded-io`、`check-state-registry`、`check-patch-fixtures`、`check-patch-test-manifest`、`check-combo-cache`、`check-build-chain-abort`、`check-build-parallel-cap`、`check-snapshot-builder-output`、`check-tool-output-schema`、`check-mcp-client-deps` 全部 exit 0。
- 本机运行环境的两个**非仓库缺陷**（后续在本机跑套件的人会再遇到，根因见坑 334/335）：① 凡是用 `process.execPath` 派生子 node 进程的东西都必失败——本机 `process.execPath` 是 `/apex/com.android.runtime/bin/linker64`（node 是经 linker 启动的 ELF 共享对象），于是 `node --test` 报 `expected absolute path: "--test-concurrency=0"`、vitest 默认 `forks` 池报 `EPIPE`、`check-release-gates.mjs` 的「171 个脚本全部可解析」整项判红（而手工 `node --check <单个文件>` exit 0）；绕行 = 逐文件直跑 + `--pool=threads`，真结论回 WSL/Windows 跑。② `pnpm install` 在 sdcard（FUSE）上因 symlink/rename 失败（`ERR_PNPM_ENOSYS` / `ERR_PNPM_ENOENT`），需装到应用私有目录（`$HOME`）或改用 `--node-linker=hoisted --package-import-method=copy`。

**未取得结论的（不记通过）**：

- **设备验收未做**：L2（快照事务窗口 / 启动流）与 L3（主题、宽表格、终端卡片）按铁律 2 都要求补三层验收，本轮**一层都没做**（既无 CDP 层也无 ADB 用户层）。客观原因：本分支禁止用本地/协调仓链产出 APK（铁律 9），本机没有可安装的来源链产物。补验条件 = 来源链出包 + 模拟器竖横两向 + arm64 真机补充。
- 需要 `node_modules` 或已构建 `lib/` 的门禁在本机不可判：`check-tool-surface-budget`、`check-protocol-v2`、`check-contract`（原样返回「先构建」提示）；需要 `snapshot.tar.xz` 的门禁（`check-snapshot-*`、`check-strip-noop`、`check-engine-overlay`、`check-third-party`、`check-inject-completeness`、`check-patch-mounts`）在净检出上走用法/SKIP 面。二者都是**环境阻塞，不计通过也不计失败**。
- 聚合入口 `check-release-gates.mjs` 本机判红，唯一缺口项是坑 335 的 `process.execPath` 问题（「171 个脚本全部可解析」整项），其余接线项 PASS；该项按环境阻塞记账，不在本机下仓库结论。
- `check-kotlin-test-count` 在本机判红，唯一原因是坑 334 那条环境误红；数量面本身通过（111 个源测试类 = 111 个结果类，1232 ≥ 基线 1232）。

## 维护入口

接手顺序：本文件（宗旨与边界）→ [changelog-archive.md](changelog-archive.md) 最新一行（做到哪了）→ [known-gaps.md](known-gaps.md)（还缺什么）→ 上方检查入口（先干跑一遍）。

- [known-gaps.md](known-gaps.md)：当前风险、环境限制和待取得的证据。
- [gotchas.md](gotchas.md)：具体缺陷的现象、根因、修法与检查记录。
- [EXECUTION-MAP.md](EXECUTION-MAP.md)：生产调用链、执行顺序和覆盖地图。
- [changelog-archive.md](changelog-archive.md)：阶段改动与验收状态。

本文件维护分支宗旨、实施原则和已接受边界；具体缺陷与证据留在对应详档，持续随源码更新。

## 复核轮次：2026-10-19（吸收参考仓 #414 堆上限）

按 [UPSTREAM-TRACKING.md](UPSTREAM-TRACKING.md) 的参考 PR #414 实施；GitHub API 恢复后确认源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`、上游合并提交 `f2df6fa0d2a3b70f171f2a28ed3f020dcad5997a`。当前 `main` 尖端仍为检查游标 `18439f1b8cb96f7d4d9b8508bdb02aa2695143a3`。

- 根因补充：原上限 1024 恰等于 V8 自然 `heap_size_limit≈1120MB` 对应的 `--max-old-space-size` 值（标志值 +96MB），所以常见设备上 `totalRam/2` 恒被截成 1024，自适应分支退化成常量。新增 `ENGINE_HEAP_NATURAL_MAX_FLAG_MB` 唯一真源、上限须严格高于它及区间宽度至少 1024MB 的门禁 F；自检新增三条负控，其中一条以双源同为 1024 直接复现原缺陷。JVM 断言检查 1/2/3/4/6GB 档不被上限压成常量。
- `--max-old-space-size` 是 V8 老生代天花板，并非预分配；上限增大本身不等于 RSS 立刻增加，`lmkd` 仍基于真实内存压力处理。但不能据机制推论宣称无风险，实际设备的长任务峰值和系统回收仍待观察。
- 代码级检查：`node scripts/check-engine-heap-floor.mjs --self-test`（正样本 1 + 负控 11）、`node scripts/check-engine-heap-floor.mjs --require`、`node scripts/patches/tests/ptc-node-wrapper-c1.test.mjs`、`node scripts/check-code-map.mjs` 均通过；wrapper 测试中的跨树分支 `SKIP` 不计为证据。JVM 档位断言已更新；本机单测未取得结果（WSL 返回 `Wsl/E_ACCESSDENIED`，本机 Gradle 调用约 120 秒无输出后中止），但 PR #38 的 CI Kotlin 编译/单测门禁通过。敏感信息扫描和维护文档检查也通过；PR 以 merge commit `ff2261b80b5d573afaef6e46abfa6f8c69feca5e` 合入。
- **未做设备验证，也未构建来源链 APK**。没有低/中/高内存设备上的 LMK、长任务峰值、后台切换或 CDP/ADB 用户体验证据。高内存设备内存压力保持开放，进入发版候选前须用最终来源包补验；见 [known-gaps.md](known-gaps.md) 本轮条目。


## 复核轮次：2026-10-17（吸收上游 `e3e728b`）

本轮合入 `kelai141/dsh-mobile-apk` 的 `5fca94f..e3e728b`，共 11 个提交；保留本分支来源构建、应用内更新退役、凭据 transport 与权限边界。管理中心新增文件仍引用已退役的 `updateButton`、`apkUpdate` 和 `GuidePhase.Updating`，已定点删除引用，未恢复安装权限或更新入口。源码及本机生成的 UI/Linux `lib/` 已重建。

- Linux 资产桥只接受清单，宿主决定落点，先验摘要格式与体量，逐跳约束下载主机，复用现有解包器；新增路由保持鉴权。bootstrap 仅 vendored，未加入快照注入集，默认未启用；具体待接入边界见 known-gaps.md，不能宣称 Linux 已可用。
- 管理中心复用 `EngineProbe.rpc` 和本分支认证 transport，Hard 插件在读取及修改两端校验；设置按 revision 做字段合并，不把脱敏配置整份覆盖。
- Shizuku 改用逐代绑定与主线程生命周期，保留原权限与屏幕范围判据；堆下限与快照 wrapper 同区间，诊断出口继续脱敏。新桥及 UI 行为属于 L2/L3，代码检查不能替代设备验收。
- 文档冲突合并两侧内容；上游新增坑 314–323、325 在本分支追加为 353–362、364（保留上游原条目次序与编号空缺），既有 1–352 不变；Kotlin 基线按合并后的各类数求和，保留 featureRetirements。
- 证据目录 `.deploy-tmp/upstream-20261017/`；UI 50 文件 / 748 项通过（Node 26 运行 vitest 需 `NODE_OPTIONS=--no-experimental-webstorage`，否则宿主全局 localStorage 覆盖 jsdom）；Linux 新增 26 项在 WSL 通过，Windows 临时目录 rename EPERM 不计通过。堆门自检正控 1 + 负控 8、vendored 自检正控 1 + 负控 3 通过；补丁测试通过，但 PTC 两个跨树检查显式 SKIP，不计入有效证据。静态门禁日志各自留存。
- **未做设备验证**：ADB 清单为空，两个指定模拟器端口均 connection refused；未生成本轮来源链 APK，未执行 CDP、ADB 自主任务或真机测试。本轮是源码同步，不是候选发布验收，设备三层仍阻断发布。

本轮最终 Kotlin XML：119 类、1301 项，失败/错误/跳过均为 0；主源码和单测源码编译通过。上游基线遗漏 ShizukuBindStateTest 新增的 5 项，本轮按实测结果提升为 26，总基线 1301，未降低任何既有类基线。日志 `kotlin-final.log` 与 `instrumentation-compile-final.log`（开头 XML 汇总）；`:app:compileDebugAndroidTestKotlin` 通过，设备测试仅编译未执行。Linux-env 全套在 WSL 通过（`linux-all-wsl-test.log`）。


本轮复现入口（仓库根；Gradle 需 Java 17 + SDK 36，工作树外 buildDirectory 配置见 build-and-env.md）：

```text
npm --prefix dsh-client-ui-responsive ci
npm --prefix dsh-client-ui-responsive run build
NODE_OPTIONS=--no-experimental-webstorage npm --prefix dsh-client-ui-responsive test
npm --prefix plugins/dsh-android-linux-env run build
npm --prefix plugins/dsh-android-linux-env test
node plugins/dsh-linux-bootstrap/build.mjs
./gradlew :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin --no-daemon
node scripts/check-engine-heap-floor.mjs --self-test
node scripts/check-vendored-linux-bootstrap.mjs --self-test
node --test scripts/patches/tests/sidebar-bubble-reorder.test.mjs scripts/patches/tests/ptc-node-wrapper-c1.test.mjs scripts/patches/tests/combo-probe-p1.test.mjs
```

上述 NODE_OPTIONS 赋值为 POSIX 写法，Windows PowerShell 用 `$env:NODE_OPTIONS='--no-experimental-webstorage'`。本机 UI 首跑因 Node 26 的 webstorage 与 jsdom 冲突失败，禁用宿主该实验功能后全通过；未改测试断言或产品源码。Windows/Linux 失败原日志保留，不覆盖成通过。

## 复核轮次：2026-10-17（Linux 审查三项修复）

本轮修复等长代码篡改、确认参数断链和资产准备互斥失效；根因、生产正反证、原始日志及三层未覆盖范围统一见 [gotchas.md 坑 366](gotchas.md)。保留默认不启用与来源构建约束；未做设备验证，不构成发布候选通过。

## 复核轮次：2026-10-17 晚（第二轮漏洞挖掘，只登记、未修复）

按用户 2026-10-17 指示：「继续挖掘漏洞，从各个方面，挖掘出来后先不修，先记到项目文档里」。本轮**没有修改任何代码、没有新增测试、没有构建 APK、没有设备验证**，产出只有登记文档：

- 详档：[SECURITY-AUDIT-2026-10-17-R2.md](SECURITY-AUDIT-2026-10-17-R2.md)（基线 `2fbcc7f`，17 项，逐条含根因行号、触发/前置、影响、去重检索证据、复核方式、未证边界）。
- 坑位：[gotchas.md](gotchas.md) 376-392（每条标注「登记，未修复」）。
- 分类摘要：壳侧授权 2 项（376/377，用户拥有的屏幕范围与 AI root 门可被 app-uid 代码/同源页面脚本改写）、跨应用信任 1 项（379，通知监听可代按审批）、可用性 2 项（378/383，3080 中继槽位与未鉴权 status 占队列）、模型面/供应链 2 项（380 市场无确认安装、381 Linux 第三方 Release 信任锚）、资源/启动 1 项（382 响应体无上限）、前端注入层 3 项（390 标题当路径、391 子串哨兵、392 open-path 会话范围）、来源链 5 项（385 快照无字节绑定、386 preinstall 不重建、387 pnpm/canvas 自声明摘要、388 .debs 只比 size、389 Gradle 无校验和）、命令构造 1 项（384 nonce 引号）。
- **证据边界**：全部是静态审查（390 另有仓库外假 DOM harness）。没有设备、没有 CDP/ADB、没有利用复现；若干项依赖设备时序或构建环境，条目内逐条标注「本轮未证」。本文件不构成「已发现全部漏洞」或「候选可发布」的结论。
- **下一步由用户定优先级**：按指示本轮不修；修复时须补对应三层验收与受控负控，不得把本轮的静态结论当运行时关闭。

