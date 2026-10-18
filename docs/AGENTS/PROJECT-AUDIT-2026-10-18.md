# 项目分区复审（2026-10-18）

审查基线：`187246a4109230bdea371dea635f4f80027c400e`。本轮由主 agent 与三个子 agent 分区检查原生安全/控制、插件/运行时、构建/发布/文档；随后对配置迁移、公共仓供应、插件挂载、Safe Console 与验证脚本补查，原生补充复查无新确认缺陷，门禁自检补查新增 A14。与 [此前综合审查](COMPREHENSIVE-AUDIT-2026-10-18.md)、[修复账本](AUDIT-REMEDIATION-2026-10-18.md) 和安全审计去重；本报告编号仅在本文有效。

本轮修正文档，未修复产品实现、未重建插件 lib、未构建 APK、未做设备验证。源码确认与宿主反例不等于 Android 设备复现；不能据此宣布全部模块安全或验收通过。P1 为主要能力阻断，P2 为功能、策略或来源证明缺陷。

> **后续状态（2026-10-18）**：A01–A14 已按用户要求修复源码并补代码层/宿主反例，见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md) 的「项目分区复审 A01–A14 修复」一节与坑 423–435。未重建 APK、未做设备验证；本报告的发现时事实保留。

## 发现清单

| 编号 | 优先级 | 问题 | 证据 |
|---|---|---|---|
| A01 | P1 | 原生控制轮询、外部文件投递缺少 relay 准入凭据 | 源码闭环及准入谓词正反例 |
| A02 | P1 | 屏幕范围迁移到原生内存后，插件仍读取旧 XML | 跨层源码闭环 |
| A03 | P2 | ADB 输入 sender UID API 在错误的类上调用 | 源码及平台 API 归属 |
| A04 | P2 | 虚拟屏启动静默忽略显式目标 | 启动与输入分支对照 |
| A05 | P2 | 虚拟屏启动没有原生执行点范围复核 | 源码确认，普通插件路由可能先拦截 |
| A06 | P2 | HTTP chunk 分别解码会损坏中文来件路径 | UTF-8 跨块反例 |
| A07 | P2 | 附件响应忽略背压和断连取消 | 慢消费者反例，64 MiB 全量入缓冲 |
| A08 | P2 | 悬浮球 live 流把字符数当字节偏移 | 中文反例，同一 result 被处理六次 |
| A09 | P2 | 本地来源链按阶段续跑漏掉最终复验 | 生产入口 dry-run |
| A10 | P2 | 引擎包重打包重复收入目录内容 | 生产函数及 tar 成员清单 |
| A11 | P2 | 本地来源续跑允许未提交源码沿用原 HEAD 身份 | WSL 生产函数反例 |
| A12 | P2 | 下载页不识别来源链资产及校验文件 | 生产 pickAsset 反例；上线前缺口 |
| A13 | P2 | Windows CRLF 检出使旧 Safe Mode 补丁升级自验失败 | 生产 runner 及单变量诊断 |
| A14 | P2 | mobile-owned 路由门禁的存在性断言未剥注释 | 生产脚本临时副本三态反例：注释掉的 guard 仍 PASS |

### A01 P1 原生请求缺少 relay 准入凭据

- 位置：`app/src/main/java/com/dsharnessmobile/shell/ControlPoller.kt:197`、`FileIncoming.kt:369`、`EngineTransport.kt:20`、`EngineTransport.kt:134`。
- `ControlPoller.post()` 只设置 Content-Type，来件投递只设置 X-DSH-Control-Token；二者都未携带 X-DSH-Relay 或 dsh-relay Cookie。relay 在连接转发到 Unix 后端前只检查 HTTP 头并关闭不合格连接，JSON 内控制 token 不能替代准入凭据。WebView CookieManager 不会替这些原生连接自动附头。
- 影响：控制承载者的 a11y/browser/vdisplay/shell 队列请求无法送达；外部分享文件也无法被引擎受理，重试不能补足缺失的凭据。不是服务心跳在线即可排除的问题。
- 修复方向：在受精确 origin 约束的共享连接入口附 relay 凭据，保留各路由自身 token/browser 鉴权。反证须用真实 relay 跑 pending/result/来件的有凭据、无凭据和错误凭据三种请求。
- 证据：`native-relay-proof.mjs` 对实际源码缺失 carrier 作检查，并对同形准入谓词作正反例；未执行生产 Kotlin 或设备网络。

### A02 P1 屏幕范围真源迁移后插件仍读旧文件

- 位置：`ScreenScope.kt:52`、`MainActivity.kt:1264`、`plugins/dsh-android-bridge/src/screen-scope.ts:783`、`plugins/dsh-android-bridge/src/index.ts:721`。
- 原生 setter 只修改进程内 `@Volatile scope`；插件 currentScreenScope 仍读 retired `shared_prefs/dsh_screen_scope.xml`。没有从原生内存传回插件的更新渠道；测试专用环境覆盖不能解决产品链路。
- 影响：全新安装文件缺席时，用户原生确认 all/real-only 后插件仍判 virtual-only，在前置门拒绝真实屏；升级设备可能长期读旧值。原生执行点仍复核，尚未证实因此越权。A01 会掩盖此问题，不能只修 relay。
- 修复方向：提供经认证的原生状态读取协议，以当前进程授权为真源；覆盖授权、撤销、进程重启、旧 XML 与新安装的跨层反例，不能恢复同 UID 可写文件作为授权真源。

### A03 P2 输入法来源 UID API 调错类

- 位置：`AdbKeyboardService.kt:142`、`:160`；`AdbKeyboardReceiver.kt`。
- `sentFromUid(intent)` 反射 Intent.getSentFromUid()，但该 API 属于 [BroadcastReceiver](https://developer.android.com/reference/android/content/BroadcastReceiver#getSentFromUid())。异常被吞后返回 null，SDK 34+ adb/root UID 白名单无法命中。
- 影响：IME 活跃时，无 nonce 的标准 ADB_INPUT_TEXT/CLEAR 广播被拒；插件携 nonce 的路径不受此项影响。此项是误拒，未发现权限绕过。
- 修复方向：在接收器获取可用的 sender 身份并传入策略；身份不可验证时仍 fail-closed，并按平台实际身份可用条件修正兼容承诺。

### A04 P2 显式虚拟屏启动目标被替换

- 位置：`VdisplayController.kt:571`、`:685`；正确对照为 input 的 `:611`。
- launchApp/launchSettingsProbe 使用 selectedRecord() ?: recordOf(target)，选中屏存在时永不解析显式 target。
- 影响：已创建 virtual-1 后，显式请求不存在或过期的 virtual-2 也会在 virtual-1 启动，而非 screen-not-ready。当前单屏限制不排除这个无效目标反例。
- 修复方向：显式目标优先且不得回退，缺省时才取 selected；覆盖无效目标不得产生副作用。

### A05 P2 虚拟屏启动缺少范围执行门

- 位置：`VdisplayController.kt:568`、`:679`；对照 input 的 `:614`。
- 两个启动函数解析 display 后直接派发，没有复核 ScreenScopePrefs；REAL_ONLY 明确不包括 virtual-N。
- 影响：虚拟屏存活、范围切为 real-only 后，直达原生 carrier 的已鉴权启动请求仍能写入排除的虚拟屏。普通模型路线可能先被插件拒绝，A01 当前也会阻断队列，因此不扩大为已证实的端到端越权。
- 修复方向：在最后启动派发点核对当前原生范围，覆盖切换后无副作用反例。

### A06 P2 HTTP 分块解码损坏中文路径

- 位置：`plugins/dsh-android-file-open/src/index.ts:600`；同类写法在 `:653`、`:815`。
- 每个 Buffer 独立 toString 后拼接，TCP chunk 不保证 UTF-8 字符完整。拆开“中”的字节后，`/incoming/中文.txt` 变成 `/incoming/���文.txt`；JSON 仍能解析，入队查文件却失败。
- 修复方向：StringDecoder、setEncoding 或按 Buffer 累积后统一解码；长度上限按字节计。用真实 handler 的多种中文分块覆盖，不能只测一次完整 data 事件。

### A07 P2 附件内容流忽略背压

- 位置：`plugins/dsh-android-file-open/src/index.ts:777`；原生单文件上限为 `FileIncoming.kt:160` 的 200 MiB。
- data 回调无条件 res.write，不处理 false/drain，也不在响应关闭时销毁源流。慢消费者可使文件被持续读入发送缓冲。
- 证据：同形 data→write 的 64 MiB 输入、64 KiB highWaterMark 慢 Writable，峰值 writableLength 为 67,108,864 字节，整文件排队。是宿主内存反例，未设备压测，也未声称每个网络客户端都会达到同一峰值。
- 修复方向：正确 pipeline/暂停恢复，并将响应错误和断连接到源流取消；测试缓冲上界、断连后停止读取及 FD 关闭。

### A08 P2 live 消费偏移使用字符下标

- 位置：`OverlayLiveFeed.kt:87`、`:91`。
- 从 UTF-8 字节解码 String 后，使用 lastIndexOf 换行的字符下标推进 RandomAccessFile 字节偏移。含中文的工具参数会少推进，后续 drain 重读旧尾段和后续完整事件。
- 证据：200 个“中”的 tool_call 加一条 tool_result，共 678 字节；按生产偏移算法循环消费，tool_call 一次、同一 tool_result 六次。`overlay-offset-proof.mjs` 校验源码相关语句后执行该反例，未运行 Android Service。
- 影响：重复工具结果或 turn_end 可错误清除当前工具/忙态/待答卡，且重复解析截断行。修复应直接在字节缓冲寻找换行，以实际 consumed bytes 推进；NotifyStore.drainBytes 已有正确方向。

### A09 P2 本地阶段过滤漏掉最终检查

- 位置：`scripts/source-build/run-local-source-chain.mjs:131`、`:153`；workflow `:845`、`:876`。
- 未映射步骤归 misc，索引为 -1，--from apk/--only apk 过滤掉最终快照语义归一化及 APK 文件复验，违背“跟随上一阶段”的注释。
- 复现：`node scripts/source-build/run-local-source-chain.mjs --dry-run --from apk` 仅选择 Build ARM64 APK。构建内部尚有其他检查，不能扩大为正式签名已完全无验证。
- 修复方向：实现阶段继承，直接测试生产步骤选择和最终复验不可省的负例。

### A10 P2 重打包重复 tar 成员

- 位置：`scripts/source-build/normalize-snapshot.mjs:145`；调用方 `export-dsh-engine.mjs:93`。
- 已递归枚举目录和文件，却传给仍递归目录的 tar -cf。生产 canonicalizePackedManifest 处理 package/lib/deep/index.js 后，文件在清单出现三次、deep 目录两次。
- 影响：归档体积和解包工作增长，canonical 归档出现重复成员及硬链解释差异；未证明导致最终 APK 功能损坏。
- 修复方向：使用不递归的显式成员打包，并断言每个路径唯一，保留当前 manifest 条件导出顺序规则。

### A11 P2 来源续跑没有绑定工作树源码字节

- 位置：`scripts/source-build/local-source-workspace.mjs:129`。
- 续跑只验证 marker/HEAD/路径安全。WSL 临时仓调用生产 prepareSourceWorkspace 创建隔离检出，改写 app/src/main/probe.kt 后再调用，返回 accepted:true、sameHead:true，文件仍为 UNCOMMITTED SOURCE。
- 影响：“只构建已提交 HEAD”对本地续跑不足；不是云端独立双构建或正式签名已被绕过的证明。
- 修复方向：绑定阶段输入哈希，或只允许预期生成变更；workflow 自身会修改部分输入，不能简单一律要求干净工作树而破坏正常续跑。

### A12 P2 Pages 与来源发行格式脱节

- 位置：`webpages/src/assets/release.js:110`、`webpages/tools/build.mjs:105`。
- pickAsset 只推导旧版文件名，不识别 pocket-harness-v0.14.7-source-arm64.apk；直接传入此真实命名的资产列表返回 null。页面仍找 MANIFEST.txt，来源草稿实际提供 SHA256SUMS.txt，tag 也使用 hardening-source-*。
- 影响：来源产物不能直接接到当前下载页。Pages 目前手动部署，文档已保留下载就绪待项，因此这是上线前交付缺口，不是已观察的线上故障。
- 修复方向：明确正式发布的 tag/asset/checksum 合同，再以 prepare-source-release 的实际输出驱动页面测试；现有旧命名夹具全部通过不能证明兼容。

### A13 P2 Safe Mode 补丁升级不兼容 CRLF 检出

- 位置：`scripts/patches/apply-patches.mjs:559`，自验合同在 `:68`；输入为 `scripts/patches/data/undo-safe-transaction-snippet.mjs`。
- runner 插入原样 snippet，而自验显式拒绝事务段的 CR。当前 Git index 为 LF、Windows 工作树为 CRLF；升级旧 S2/S4 的两个测试因此失败，runner 安全拒绝写出。
- 证据：`repro-s2-crlf.mjs` 使用原 runner 得到 exit 1；仅在诊断副本规范载入 snippet 的 CRLF 后 exit 0。它不是此前“测试函数切片依赖 LF”同一问题，这里是生产 patcher 的输入/输出合同冲突。
- 修复方向：对该输入固定 LF 和/或在载入时规范生成段；保留 LF 自验，不能放宽自验掩盖差异。此项是宿主构建/修复兼容问题，不是已证明的 Android Safe Mode 漏洞。

### A14 P2 mobile-owned 路由门禁的存在性断言未剥注释

- 位置：`scripts/check-api-route-auth.mjs:153`、`:154`、`:168-170`、`:175`；对照 `:270` 的 `stripSourceComments()` 与 `:443-455` 上游段。
- 同一文件上游段的注释写明「存在性断言一律先剥注释（历史实锤：对注释掉的 guard 做裸 contains 恒真 = 假绿）」，且 `--self-test` 有「剥注释后 guard 存在性断言不再被注释满足」项；但 mobile-owned 段仍用 `read()` 的原始文本做注册表达式、endpoint、guard、公开响应 marker 四条 `includes` 断言。即该收口只落在上游段，没有覆盖扫本仓 28 条路由的那一段。
- 复现：`addendum-api-comment-repro.mjs` 把生产脚本与 `scripts/lib/shell.mjs` 复制到临时目录，用最小 policy/fixture 让 guard 取 active、`//` 注释、缺失三态：active 与 comment-only 都 exit 0，只有 absent exit 1；comment-only 仍打印「PASS fixture 受保护路由的 guard 在注册块内」。临时副本不改仓库文件，未运行 Android。
- 影响：受保护 `/api` 路由的 guard 若被注释（调试残留、错误合并），门禁不会拦住；这是 L2 门禁判据的假绿。当前源码的实际 guard 均为真实调用，未发现现存无鉴权路由，因此不扩大为线上越权。
- 修复方向：mobile-owned 四条存在性断言统一先剥注释，并为 comment-only 形态补 `--self-test` 负例；修复后以 `--require` 跑全档。不能只放宽测试判定来消除红项。

## 文档纠正与已有问题

- 已纠正模块地图中协调仓权威源、已删除 UpdateChecker 的当前导航，及网页 README 的 CORS/ARM64 探测说明。
- 已纠正执行地图：外部来件的会话实际由客户端 runtime.createSession 创建，插件 ensureSessions 只有定义；不再把死实现写成真实执行链。
- 架构与桥文档已如实写明 A02 的原生内存/插件旧文件断链，避免把不一致描述为已打通。
- SnapshotExtractor 的 entry.size 双重累计已在 EXECUTION-MAP 的 K03 登记，确认仍在，不计为本轮新发现。
- 本仓没有 clean-deploy-tmp.mjs，而 AGENTS 仍要求在协调仓运行；这是独立维护流程依赖缺口。本轮未删除既有证据或近三天活动目录，未新增大型资产。

## 覆盖与验证边界

| 分区 | 审查内容 | 限制 |
|---|---|---|
| 原生安全/数据 | MainFrameBridge、AndroidBridge、EngineAuth/Transport、Snapshot 系列、UndoGate、Root/Shizuku、PathOpen、Manifest、IME；补查 ConfigTransfer、ReverseMigration、PublicRepoProvision、PluginManagementRepository、SafeConsole/SafeMode、PluginMounts、LinuxAssetIO/Prepare、ConsoleSession | 静态调用链检查，没有完整设备攻击面验证；补查未新增确认缺陷，但不等于这些模块无缺陷 |
| 控制/生命周期/UI | ControlCarrier/Poller、DeviceControlService、ShellOps、Vdisplay 启动/输入、BrowserHost/Profile/导航、EngineService、通知队列/消费/应答、Overlay live | 大型文件未逐行穷尽；未做视觉或真实多步任务验收 |
| 插件/运行时 | bridge/manage/browser/file-open、model-capability、Linux bootstrap/env/runtime、Termux/host/UI、marketplace、运行时补丁 | 部分完整测试受依赖或宿主限制；不宣称全部通过 |
| 来源/发布/文档 | source-build、签名/双构建/隔离/续跑、Gradle、PR Gate、Pages、依赖锁/Action 固定、主要项目文档；补查 API 路由门禁判别力 | 未运行新的云端构建，全部脚本和文档未逐文件穷尽 |

本轮独立日志前缀为 native-*、native-addendum.md、build-docs-*、runtime-*、addendum-*、root-tests.log、overlay-offset-proof.mjs，位于 `.deploy-tmp/audit-2026-10-18/`。同目录还有此前审查的日志，尤其 kotlin-linux.log 的 1310 项不属于本轮重新执行，不能混计。

- 构建/Pages 六套 Node 测试：82 项，67 通过、15 平台跳过、0 失败；Action pins 自检和受控负控、10 个 lock 根声明通过。
- browser/file 组合 16 项：15 通过，file-open 因缺本地 bridge 包失败。model-capability 111 项：103 通过、7 缺包失败、1 HTTP 断言失败；后者与环境 loopback 拒绝一致，但没有取得有效的真实传输验证。Linux bootstrap/runtime 37 项：34 通过、1 因沙箱 loopback EACCES 失败、2 跳过；不把该失败算产品漏洞或通过。
- 主 agent 的桥/启动/浮层/性能组合：12 项中 11 通过，性能脚本因 Windows symlink EPERM 在夹具创建处失败。未达到业务断言的检查不作绿证据。
- host/patch 组合 121 项初跑 110 通过、10 失败、1 跳过。受控切换可写 TEMP 后 116 通过、4 失败、1 跳过：六项 rename EPERM 被证明是环境限制；剩余两项是 A13、两项是 symlink EPERM，不能记绿。完整命令与日志对应见 runtime-findings.md；不能用旧 ignored lib 或换行问题推断 Android 功能故障。
- 本轮未执行 Kotlin 编译/单测、CDP、ADB 或 ARM64 装机。系统 java -version 在当前环境未返回，已终止，未据此修改 Java 配置。

修复优先串通 A01/A02，再处理 A04/A05 的执行点约束；文件导入 A06/A07 与 live A08 应各自有行为反例。来源及交付 A09–A13 需要独立 PR 与相应负控；A14 的门禁修复须以 comment-only 负例自证。L2/L3 修复须遵守三层验收，宿主探针不能替代最终来源 APK 与设备证据。
