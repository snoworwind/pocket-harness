# 上游增量吸收阶段记录（2026-10-28，已冻结）

> 本文保留截至 2026-10-28 的中间审查范围和证据；后续固定范围审查及 PR 收口状态见 [2026-10-29 审查结果](UPSTREAM-ABSORPTION-2026-10-29.md)。

固定范围：`kelai141/dsh-mobile-apk` 的 `4a41e6ac9bf2b0f786e3c336cfc344068a8fd1e7..b665ce40`，GitHub compare 返回 94 个提交、124 个文件；本仓基线 `c5d753a5`。范围包含合并提交，不等于 94 个独立功能。当前仅完成提交与文件分类及重点调用链初审，**未完成逐项源码和测试审查，不推进上游跟踪游标**。

## 初步队列

| 优先级 | 候选及上游来源 | 本仓证据、实施边界和验收 |
|---|---|---|
| 1 | 无障碍状态真实性 [#666](https://github.com/kelai141/dsh-mobile-apk/pull/666) | bridge `a11ySource()` 将独立控制队列的取活作为无障碍在线证据；须检查服务重连、旧心跳与并发，并保留轮询独立诊断。桥协议 L2，需反证、同步源码和 lib、桥对称门禁、设备矩阵及三层。 |
| 1 | 配置归一化备份及发布 [#629](https://github.com/kelai141/dsh-mobile-apk/pull/629)、[#642](https://github.com/kelai141/dsh-mobile-apk/pull/642) | `EngineManager.normalizeLegacySinglePointPatch` 忽略备份失败，rename 失败后直写目标；确保完整备份后原子发布，禁止破坏已有用户文件，审查并发及清理。用户数据 L2，需故障注入及三层。上游本身仍保留直写回退，不能原样照搬。 |
| 1 | 安全模式 insert 边界及迁移恢复 [#637](https://github.com/kelai141/dsh-mobile-apk/pull/637) | `SafeMode` 只以顶层列表项结束 insert；列零注释可能被纳入过滤。新旧状态同时存在时当前直接拒绝；需单独证明相同字节且常规文件时的恢复与中断安全。拆分为可独立回滚的事务，L2 三层。 |
| 1 | 快照 journal 目标 [#595](https://github.com/kelai141/dsh-mobile-apk/pull/595) | `writeMarker` 尚无非普通文件目标拒绝，且 rename 失败后直写的注释把失败错误推断成目标不存在；需连同旧 journal 保全、临时文件和符号链接进行失败反证。L2 三层。 |
| 2 | 旧 WebView 内建 [#619](https://github.com/kelai141/dsh-mobile-apk/pull/619)、[#624](https://github.com/kelai141/dsh-mobile-apk/pull/624) | 本仓 compat 未发现 `toSorted`/`findLast`。先核实 rc.3 产品调用与支持的 WebView；对照标准验证空洞、泛型、参数及属性描述符，不因上游声称符合规范而照搬。同步构建产物并做 L3 三层。 |
| 2 | 遥测运行时依赖 [#656](https://github.com/kelai141/dsh-mobile-apk/pull/656) | 本仓 rc.3 overlay 声明 otel 启用，来源链使用 pnpm 部署和独立依赖链接检查，不适合直接套旧 npm overlay。需检查 rc.3 锁文件、实际快照解析路径和受控错版负控，确定是否有缺口后按来源链修复。 |
| 2 | 启动拒绝诊断 [#663](https://github.com/kelai141/dsh-mobile-apk/pull/663) | 逐一核对本仓启动出口与调用者已有落盘，避免重复记录和泄露敏感信息；确认缺口后独立实现与验收。 |
| 待需求 | 剪贴板模型配置、About 入口与设置导航 | 先核对本仓实际 UI、权限和引擎 rc.3，明确用户收益及读取凭据边界；新增交互不因上游有功能自动吸收。 |

## 分类及排除边界

固定范围变更按路径初分：原生生产 23、runtime 22、构建与门禁 20、CI 5、测试 26、文档 27、其他 1。数字按 GitHub compare 文件列表计算，代表路径而非功能。提交和文件均须继续逐项核对，不能以此分类代替完整审查。

上游 APK/运行时更新与 dev 快速打包不符合本仓 main 来源链；上游镜像门禁依赖协调仓，本仓已收归树内权威。远程 renderer 的管道和重连修复针对上游多进程实现，本仓 BrowserHost 架构不同，需查对应生产路径而非复制类；本仓截图编码失败处理与缓存清理已由 `b4f5c80a` 独立修复，设备侧截图验收仍待最终候选验证。修复助手的冷启动恢复依赖本仓不存在的原生 AI 修复助手。双语、下载页与上游发布配置按实际产品需求审查，不直接同步。PR Gate 已有同 PR 并发取消，来源工作流已有部分超时，其他 workflow 的超时应以本仓耗时及失败语义评估。

## 执行约束及当前证据

每个逻辑改动独立分支和 PR；保留用户数据与现有安全边界，补对应文档、反证及风险级门禁。L2/L3 须当轮完成代码、CDP 和 ADB 真实任务三层；来源 APK 只能从已提交 main 的允许来源链构建。当前执行环境 `adb devices -l` 在提升权限后返回空设备列表，ABI 未知，无法宣称设备验证或绕过该门槛。开发可继续做只读审查、故障模型和非设备依赖工作；每项未验收保持开放，不能随候选发布。原子 PR、main-only 来源与即时验收的时序仍须按现行流程实际闭合，不以未经授权的分支 APK 代替。

## 重点复核补充

- 遥测：本仓 `check-dsh-runtime-dependencies.mjs` 逐个解析第一方包的直接 dependencies 和必需 peer 的实际安装路径，但只验证存在，不核对已解析版本，也不遍历第三方传递依赖；上游错版负控不能用本仓当前判据证明被拦截。pnpm 锁和快照实际内容尚未核对，因此这是**门禁覆盖缺口**，不是已证实产品错版。应先用本仓 pnpm 布局的可控 fixture 复现错版，再以适用范围为所有实际加载的必需闭包评估最小修复。
- 来源字节：本仓已对上游补丁、registry、fixture、许可文本及 compat JS 设置行尾属性；`scripts/snapshot-config/engine-overlay.json` 没有对应属性，而 `base-lock.mjs` 以文件原始字节计入组件键。来源脚本会从 Git 对象恢复该文件，但其他计算调用点是否先于恢复尚需确定。需在 `core.autocrlf=true` 的隔离检出做正反控并检查所有调用链，再决定是否需要属性变更。
- 本仓 `ci-verify-snapshot.py` 的 applicationId 查找仍遗漏自包含仓根，但此脚本不在当前来源链的对应调用路径中；旧打包脚本不能成为交付路径。不能只照搬上游接线，应先核对来源链已有的应用路径、快照资产和 ABI 验证，避免把旧链加入权威链。
- 无障碍不仅是陈旧 prefs：`a11ySource()` 在 prefs 为 true 时优先接受独立队列的新鲜时间，控制队列在服务缺席时仍能运行；这是源码上可构造的误报。心跳改动还须验证服务绑定竞态、恢复时序与旧时间戳，且桥返回值变化属于协议变更。
- 浏览器远程渲染：本仓没有上游 `RemoteRendererHost`/`CapturePipeDrain`，BrowserHost 按 Activity 所有并在原生 WebView 中管理标签，不能直接迁移上游 Binder 管道修复。本仓截图编码失败处理、异常文件清理与有界缓存已由 `b4f5c80a` 修复；最终候选的设备截图验收仍待完成。

## 2026-10-28 继续核验

- 固定 Harness checkout 为 `1f81c047fc48fa190a683e469daa699857e9afe8`，与本仓 rc.3 overlay 一致。其产品客户端中，`ui-model-selection`、`ui-settings-models`、`ui-schedule` 使用 `toSorted`；`ui-chat` 多处使用 `findLast`/`findLastIndex`。因此旧 WebView 的内建兼容是有实际调用点的候选，仍需设备复现、规范语义测试和最终产品验收。
- 无障碍修复提交 `a7bdd979`：仅独立心跳可作为在线证据；在 OrbStack Linux Node 24 下插件 176/176、桥对称和执行地图门禁通过。用户指定本次使用现有 Android 16 ARM64 default 映像，安装 Google APIs 映像的尝试已取消；此选择仅针对本次验收。CDP 与 ADB 证据待运行，未验收。
- 上游截图管道涉及独立进程与 Binder 管道，本仓 `BrowserHost.shotOp` 在本地 WebView 绘制，使用 `FileOutputStream.use` 和 `finally` 回收 bitmap；上游的管道读线程泄漏形态不对应本仓此调用链。本仓 `Bitmap.compress` 失败处理、异常临时文件清理及截图缓存上限已由 `b4f5c80a` 修复；设备侧截图验收仍未完成。

## 已启动的独立交付（2026-10-28）

| PR | 状态与证据 |
|---|---|
| [#151](https://github.com/snoworwind/pocket-harness/pull/151) | 来源 overlay 检出字节保护；autocrlf 正控及移除属性负控通过，全部 PR CI 通过，merge commit `b4c297f755ba0ae23c7855a2c2322bed5be1fed2` 已合并。未做设备验证。 |
| [#152](https://github.com/snoworwind/pocket-harness/pull/152) | rc.3 客户端所需旧 WebView 数组方法；OrbStack 插件 62 项及注入冒烟通过，草稿，设备三层未完成。 |
| [#153](https://github.com/snoworwind/pocket-harness/pull/153) | 无障碍只以独立心跳证明服务在场；OrbStack 桥插件 176 项及桥对称、执行地图检查通过，草稿，设备矩阵及三层未完成。 |
| [#154](https://github.com/snoworwind/pocket-harness/pull/154) | 配置归一化复用本仓验证备份与原子发布；两组 Kotlin 共 47 项通过，草稿，用户数据和设备三层未完成。 |
| [#155](https://github.com/snoworwind/pocket-harness/pull/155) | journal 拒绝非普通路径并保留旧记录；事务 Kotlin 62 项通过，草稿，设备中断恢复与三层未完成。 |
| [#156](https://github.com/snoworwind/pocket-harness/pull/156) | 安全模式 insert 后顶层注释保留；Kotlin 38 项通过，草稿，设备三层未完成。 |
| [#157](https://github.com/snoworwind/pocket-harness/pull/157) | 第一方直接依赖精确版本检查；OrbStack 8 项及现有安装包只读检查通过，草稿，最终候选设备三层未完成。 |
| [#159](https://github.com/snoworwind/pocket-harness/pull/159) | 上游浏览器样式、屏幕范围夹具和 undo 源的检出字节保护；PR Gate 六项检查成功（run [40631128959](https://github.com/snoworwind/pocket-harness/actions/runs/40631128959)），已由 merge commit `c5881fc29183596759184f0c40af8d14a6c4766b` 合并；未做设备验证。 |
| [#160](https://github.com/snoworwind/pocket-harness/pull/160) | 来源 APK 组装前核对最终快照的 profile 权威字节、负控、规范路径、applicationId 与应用路径；`--self-test` 含 1 个正例和 14 个受控负例。已由 merge commit `fdb0136047a15c7a5ad761431112b7176c53787f` 合并；未做设备验证，最终来源候选仍须补验。 |

模拟器 `emulator-5554` 已启动、API 36、`arm64-v8a`，本次按用户指定使用 default 映像；已安装 `0.14.9-source`，快照指纹存在且事务标记不存在。该 APK 不可调试，标准热推的 `run-as` 不可用；上述新代码未在设备运行。现行 main-only 来源 APK 规则、PR 合并前即时三层验收与不可调试现有包之间的取证时序尚未闭合，不能将旧 APK 或 CI 编译冒充新候选。设备事实与来源链规则均不能因进度压力放宽。

遥测补证：已在模拟器现有 `0.14.9-source` 安装快照只读检查 `@deepseek-ai/dsh-otel` 的本地依赖链接，`api-logs`、`otlp-exporter-base`、`otlp-transformer`、`sdk-logs` 均为 `0.222.0`，`core`、`resources` 均为 `2.11.0`，与该包直接精确依赖一致。此证据仅覆盖该安装包的这些直接依赖，不覆盖传递闭包、其他 consumer 或将来的来源构建；门禁只验在场的缺口仍需单独处理。

## 增量逐类处置与剩余审查

此表以 compare 文件列表和提交主题为目录，防止将未检查的生成文件当作已审计；每组均记录当前结论及证据边界。更新游标须在所有「待查」项闭合后再议。

| 上游变更组 | 本仓处置 |
|---|---|
| Android 更新下载、换源、检查超时与下载隔离（`ApkUpdateAction`、`UpdateChecker`、`SourceSettings` 等，#583/#620） | 本仓退役在线 APK/快照更新；不得恢复上游身份、下载与安装链。审计本仓仍保留的历史事务恢复，与下载功能分开。 |
| 原生修复助手相关延迟启动观察（#650） | 依赖上游 `RepairState` 和原生模型修复助手；本仓无该产品路径，不直接移植。启动所有权与拒启日志仍需独立审查。 |
| 启动拒绝出口落日志（#663） | 本仓有不同的拒启码与调用者诊断，尚未逐出口证明日志唯一且完整；候选，待建立生产调用点反例。 |
| profile 归一化备份、发布和所有权（#629/#641/#642） | 本仓已有 `replaceWithVerifiedBackup`，#154 复用并避免上游仍保留的直写回退；并发写者与设备中断恢复仍需验证。 |
| Safe Mode insert 边界（#637） | #156 三处读取统一边界；设备验证未完成。旧状态迁移两文件相同后删除旧文件的上游做法仍待查：本仓有多入口且 `status` 未同步，不能仅凭比较时相同就认定跨进程删除无竞态。 |
| 快照 journal 非文件目标（#595） | #155 同时拒绝临时路径非普通文件，并取消直接写目标回退；需设备中断恢复验收。 |
| 无障碍可用性（#666） | #153 采用心跳而非独立队列作为服务证据。没有照搬 prefs 纠正写入；服务重连和设备真实关闭/开启仍待验证。 |
| 隔离浏览器重连、截图管道 EOF 与读线程（#582/#627/#636） | 本仓无上游 RemoteRendererHost/Binder 管道，当前截图路径是本地 WebView 绘制；该修复不适用。本仓压缩失败处理、异常残留文件清理与有界缓存已由 `b4f5c80a` 单独修复；设备侧截图验收仍待最终候选验证。 |
| 剪贴板模型配置与 onboarding（#626 等） | 新增原生读取桥、用户授权与凭据处理能力，非既有窄修复；需先确定本仓产品需求和读取/撤销安全边界，不自动引入。 |
| About 恢复与焦点（#589） | 上游 `about-entry.ts` 在本仓不存在，不能复制；本仓设置返回焦点是否存在同类问题待真实页面验证。 |
| ES 数组内建（#619/#624） | #152 按 rc.3 已见调用点补三个方法；本仓没有照搬上游完整四件套。旧 WebView 实机、其他使用者及规范边界尚待验证。 |
| UI 响应与设备测试入口/多语言（#617/#601/#631/#634） | 上游两套语言与设置导航不同；只迁移与本仓实际页面相符的断言，不能把上游截图或测试结果作为本仓证据。待对照脚本入口与本仓页面。 |
| 遥测精确依赖（#656） | #157 针对本仓 pnpm 实际解析增加第一方直接依赖精确版本检查，受审 Koffi 覆盖单独列出；范围版本与第三方传递闭包不覆盖，须保留为待查。 |
| 校验 applicationId、快照门禁接线（#646/#659） | 上游接的是旧 PS1/MJS 链；本仓只用来源链。旧 `ci-verify-snapshot.py` 缺自包含布局的 applicationId 路径，但是否有可调用入口及来源链等价验证仍待逐项核查，不为吸收而启用旧链。 |
| 上游补丁与许可/夹具字节（#598） | 本仓补丁、registry、fixture、许可与 compat 已有字节属性；overlay 输入由 #151 保护。上游 CSS 的来源摘要、屏幕范围源夹具及 undo 源均在本仓且有字节/上下文约束；#159 逐文件补检出属性和受控负控。 |
| dev 档 ABI、指纹、设备推断（#665/#700/#701） | 上游 dev/旧打包入口不是本仓 APK 来源；不得以此绕过 main-only。实际设备 ABI 仍在安装前查询。 |
| CI 并发与超时（#702/#704） | 本仓 PR Gate 已按 PR 取消旧运行，来源链已有部分超时；上游各 job 值不直接搬用，需按本仓实际运行分布检查尚未设置的 job。 |
| 桥对称自检、Kotlin 基线、镜像目录、i18n 镜像规则（#625/#649/#652/#667） | 本仓与协调仓镜像关系已退役，基线/测试均以本仓实况为准；不恢复跨仓约束。检查各本地门禁自检是否失败，再对具体失败独立修复。 |
| 文档、发布 Pages、上游贡献和设备记录 | 上游版本、身份、设备及发布资料不移植；仅把对本仓仍成立的原因、约束与验证记录写入本仓详档，保留来源署名。 |

**本记录冻结说明**：以上仅记录 `4a41e6a..b665ce4` 历史增量当时的分类和证据，不代表后续差异。本轮后续固定范围的审查停止点、吸收结果与排除理由见 [2026-10-29 审查结果](UPSTREAM-ABSORPTION-2026-10-29.md)。用户要求保持 main-only；不得伪造 `SOURCE_REF` 或从 PR 构建 APK。
