# 上游源码第二轮复核（2026-10-20）

本轮按用户要求继续读源码并完善计划，只提交文档。固定输入与实施顺序分别见 [跟踪账本](UPSTREAM-TRACKING.md) 和 [实施计划](UPSTREAM-ABSORPTION-PLAN-2026-10-20.md)。下文的“存在差异”指固定源码中的差异，“风险推导”不是设备复现；本轮未构建 APK、未运行实现测试、未做设备验证。

## 取证方法与覆盖边界

联网读取两个仓库 main 的 commit API：上游仍为前轮样本，本仓 main 为已合并计划的提交。本轮取得上游稀疏源码副本，静态读取源码、测试文本、注入清单和方法调用关系，没有执行上游构建或程序。

先用固定提交的 git ls-tree 列出受选源码、测试、包清单和 workflow；排除文档、APK/快照、生成 lib、依赖目录和缓存。比较清单只归一化换行及已知包 namespace，不归一化权限、控制参数、配置路径或产品行为。初次稀疏检出遇到上游跟踪的 npm 缓存长路径，随后收窄范围；最终选中清单没有不可读项。临时清单在 .deploy-tmp/upstream-source-inventory-20261020.json，逐块差异在 .deploy-tmp/upstream-reviewed-diffs/，它们用于当轮定位；后续依据固定 SHA 和下面的源码入口重新取证。

字节相同或仅 namespace 相同不证明调用关系相同。此次逐块比较的核心范围包括：

| 面 | 读取的主要入口 | 覆盖边界 |
|---|---|---|
| 悬浮层 | OverlayService、OverlayController、EngineService、OverlayPanel、OverlayServiceLifecycleTest | 服务起停、任务划除、自清理与现有引擎收尾；召回条只读职责和几何入口 |
| 输入 | AdbKeyboardReceiver、AdbKeyboardService、ime-broadcast、manage 输入分支与契约测试 | 授权、投递路由、每次回执、批编辑、清空、重试；测试只读未运行 |
| 虚拟屏 | VdisplayHost、VdisplayController、vdisplay client、sidebar-bubbles | 等比公式、显式目标和末端范围门、属性生产者与观察目标 |
| 插件与恢复 | PluginOfflinePanel、PluginPatchOffline、PluginManagementRepository、UndoGate、EngineService/EngineStartFlow、profile patch、SnapshotTransaction | 离线读写和恢复调用关系；未穷尽 EngineStartFlow 的所有修改 |
| Linux | linux-host-asset-io、release pin、宿主资产路径及 bootstrap 注入接口 | 重点比较执行载荷从归档还是从 mutable unpacked 树产生；未审完所有 bootstrap/运行时差异 |
| 浏览器与客户端 | BrowserHost/Profile、BrowserOverlayPolicy、native-browser presentation/adapter/bridge、conversation-dock、mobile-workspaces | 本地兼容模式、舞台租约与会话身份；未逐行审计整个双工作区控制器 |
| 语言、配置与构建 | AppLanguage、UiText、GeneralSettings、i18n、MainActivity 桥接、SnapshotUserData、快速打包脚本、sidebar-keep-wide registry | 真实配置真源、双语持久化、构建边界和抽屉补丁锚点 |

其他被清单标为 changed 的文件仍只是候选定位，不能据此记为行为已审计或适合移植。

## R1：悬浮球生命周期修复应独立于隐藏召回功能

上游 [OverlayService.onStartCommand/onTaskRemoved](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt#L197) 返回 START_NOT_STICKY，空 Intent 自停，任务划除也自停，再由 onDestroy 清窗口。本仓 OverlayService 只有 onCreate/onDestroy；EngineService.onTaskRemoved 确实会停止悬浮服务，但引擎未启动时不能假设该服务存在并替它收尾。

上游 [生命周期测试](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/test/java/com/dsharnessmobile/shell/OverlayServiceLifecycleTest.kt) 仅证明返回策略，没有证明真实系统回收或窗口清理。处置：新增独立生命周期工作包，先复现引擎未启动/已停止时的任务划除路径，再提取最小服务策略；不要求同时移植 #415 的召回条、面板尺寸或主题变化。实际复活和清理效果待本仓设备验证。

## R2：输入回执可吸收，清空和重试不能整体复制

上游 [服务编辑方法](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/AdbKeyboardService.kt#L79) 返回底层 commit/delete 的布尔结果，并把批编辑作为可选能力，本仓仍有只要实例存在就返回已处理的路径。可借鉴“真实编辑结果 → Receiver → 每次广播解析”的结果链。

但上游 clearText 只读取选区前后长度，再调用 deleteSurroundingText；前后均为 0 就返回 true，读取 null 也被折成 0。Android 的 [InputConnection 契约](https://developer.android.com/reference/android/view/inputmethod/InputConnection#deleteSurroundingText(int,int)) 明确该方法不删除选区本身。因此“全部文本已被选中”可使该代码在没有执行删除时返回成功；读取失败和长度截断也不能证明文本已清空。这是源码与 API 契约推出的反例，本轮未在设备执行。

上游 [manage 输入分支](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-manage/src/index.ts#L1998) 收到未就绪/无连接后会延时重发；[isCommitAccepted](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-manage/src/ime-broadcast.ts) 还将旧壳 0/null 视为可继续。由于失败码可能合并了底层编辑失败，不能直接据此认定重放没有副作用。

处置：强化工作包 A，覆盖选区、读取未知、截断、组合文本、部分执行及目标变化；结果未知不自动重放。上游还有动态接收器以兼容经典隐式广播，本仓官方调用已点名组件，当前不因吸收回执就扩大接收面；若以后确有该兼容需求，单独验证两类接收器互斥和一次提交。

## R3：虚拟屏保留本地目标门，补客户端可见性

上游 [sidebar-bubbles](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-client-ui-responsive/src/client/mobile/sidebar-bubbles.ts#L440) 在 documentElement 翻转 data-dsh-popover-open，而 [vdisplay observer](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-vdisplay/src/client/index.ts#L183) 观察 document.body 的子树。属性虽列入过滤器，祖先 html 的变化不会因此成为 body 子树事件；现有轮询仍会重新读取，所以风险是不能靠该观察器证明即时让位，不能夸大为永不更新。

本仓已存在 open/closing/closed 菜单状态，BrowserHost 也已消费，应复用它补 vdisplay。与此同时，上游 VdisplayController 仍有 selectedRecord() 优先于显式 target 的启动/取证路径；本仓 targetRecord 与 scopeDenial 已修复目标选择并在派发前复核范围。此处不能整文件覆盖。

两边 [VdisplayHost](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/VdisplayHost.kt#L183) 的等比公式在相同正值输入下代数等价：本仓 height=min(W/a,H)、width=a×height；上游按 W/a 与 H 比较分支。浮点取整仍需设备几何回归，源码不同和上游注释不能单独证明本地算法需要替换。工作包 B 继续限于可见性。

## R4：离线插件管理只借鉴边界和原子替换，不复制解析器

上游 [PluginOfflineRepository](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/PluginOfflinePanel.kt#L39) 核对 Hard 清单、拒绝目标软链接，用同目录临时文件校验后 ATOMIC_MOVE，并用相同解析器回读。这些可作为本仓 C1/C2 的设计参考。

实际限制也须登记：它只读取 profile patch；读取异常折为空字符串；[rows](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/PluginPatchOffline.kt#L120) 以 distinctBy(id) 折叠重复项；setEnabled 可改已有 disabled 行；写后回读失败路径未见恢复原字节的事务。其“拒绝歧义”“保留原清单”文案不能代替这些判据的实现证据。

处置：C1 必须区分空清单、读取失败、组合无法确定；C2 必须纳入 HOME/bundle 层、重复身份、并发、中断和真实回滚条件。上游解析器与成功文案不直接吸收。

## R5：UndoGate 类仍在，但上游自动恢复调用已断开

归一化差异表明 UndoGate.kt 只见更新器相关注释差别，SnapshotTransaction 的本轮差别集中在英文进度回调。然而上游 [EngineService](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/EngineService.kt#L254) 的 undoReady 固定 false，UNDO 分支无动作，健康拍不再 noteHealthy；profile patch 也已退役 undo-savepoint 挂载。上游 EngineStartFlow 同时加入 RepairState/原生修复助手相关控制。

本仓仍挂载 undo-savepoint，并由 EngineService 和 EngineStartFlow 调用 UndoGate。处置：保留本地 exact fingerprint known-good、启动恢复和 Soft composition 语义，不把上游退役决定、RepairState 或大段启动流程一起带入。未来吸收启动修复，先画出入边和出边，不能只比被调用类是否存在。该差异还意味着“上游有同名恢复类”不等于其离线插件写入享有自动恢复保护。

## R6：Linux 实际载荷来源不同，本地重解包路径应保留

上游 [extractArchive](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/plugins/dsh-android-linux-env/src/linux-host-asset-io.ts#L178) 对归档算摘要后定位宿主 unpacked 目录，再复制该目录。摘要标识了所选目录，不能由此推出目录中的每个文件仍等于归档内容。

本仓 extractArchive 调用 extractVerifiedArchive，从 bootstrap 取得并复验的归档重新解包，另保留签名快照内来源 pin、manifest sidecar 和运行时依赖闭包。处置：本轮已确认这项差异，不将上游复制 unpacked 树的实现移入本仓；D 的后续审计只追查尚未覆盖的激活、卸载、升级和失败恢复差异。本结论不声称同 uid 任意写隔离问题已解决。

## R7：BrowserHost 兼容模式是本地产品差异

BrowserOverlayPolicy、原生浏览器 presentation、在线 PluginManagementRepository 与 SnapshotUserData 在 namespace/换行归一化后相同；这些文件没有新的行为移植项。BrowserHost/Profile 与客户端 adapter/bridge 的主要已核对差异是本仓显式 shared 兼容模式：不支持 MULTI_PROFILE 时由用户开启、状态报告 shared、仍拒绝 loopback；上游默认拒绝该场景。

处置：保留 [ARCHITECTURE.md](ARCHITECTURE.md) 记录的用户决定及本仓 MainFrameBridge。引入客户端或工作区更新时要同时覆盖 isolated/shared/unavailable，不能整文件替换掉兼容状态，也不能将 shared 标成隔离。相关浏览器与虚拟屏设备事实仍以本仓验收为准。

## R8：双语功能有清晰分层，但持久化同步需重做

上游 AppLanguage 提供 system/zh/en、用 applicationContext 读取系统语言以避开被包装的 Activity context；document-start 的 locale bootstrap、UiText、Web tr 和 resources 形成了可借鉴的分层。

不过 [syncDshLocale](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/AppLanguage.kt#L98) 直接改 profile patch，rename 失败会退回直接 writeText；[MainActivity setter](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt#L1239) 忽略该同步返回值，setMode 也会吞持久化异常。由此不能保证“界面选择、偏好与活动配置”同时已保存。

处置：将 #450 从“仅看标题、待审计”细化为独立语言工作包。先定唯一偏好真源和明确的部分失败状态，优先使用已有 settings revision/事务或本仓受限写入边界；保持 MainFrameBridge 和正常配置原字节。资源/翻译层可先整理，桥协议和配置写入另按风险验收。尚未将整项承诺为本轮功能交付。

## R9：会话身份复用可从双工作区中拆出

上游 [existingConversation/retainDockIdentity](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-client-ui-responsive/src/client/mobile/conversation-dock.tsx#L39) 在当前 owner 内跨 conversation/subagentchat 地址查找同一 child，优先聚焦既有 tab；释放时只恢复自己仍拥有的包装器。另有 [身份用例](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-client-ui-responsive/tests/conversation-dock-identity.spec.ts)，但这些 fixture 不替代实际 rc.2 store 契约。

本仓尚无该包装器。处置：新增条件候选，先复现不同入口造成的意外重复 tab，再以真实 owner/session 与 contentId 定义去重范围。明确保留用户主动创建多个镜像视图的能力，不以全局 child ID 无条件合并；不要求引入 MobileWorkspaces、keepMounted 或分屏 CSS。

## R10：抽屉常驻补丁需两个锚点，双工作区需保留能力限制

上游 [sidebar-keep-wide-B2](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/scripts/patches/data/sidebar-keep-wide-B2.mjs) 同时修改 wide 判据和收起时内联宽度，并登记到 registry；只取一个锚点会把内容保活与窄宽度冻结混在一起。本地没有该补丁。处置：P2 性能候选，先取得本仓打开帧耗时、保活内存与冷启动收起态数据；收益成立才移植两个锚点及版本夹具，不能只复制一行判断。

上游 [MobileWorkspaces](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/dsh-client-ui-responsive/src/client/mobile/mobile-workspaces.ts#L10) 对 tab 类型显式许可，拒绝 virtual display 分屏/浮动，也拒绝两个原生浏览器同时分屏，并依赖 rc.2 owner.adopted/store 私有结构。处置：双工作区继续单独需求评估；若选用，保留这些限制、store 契约、生命周期和 shared 浏览器回归，不把它误记成所有工具视图都可任意分屏。

## R11：快速打包不解决本仓来源构建前置问题

上游 [build-apk-dev-fast](https://github.com/kelai141/dsh-mobile-apk/blob/7cd7ccab8247514e20be2925c92d46b45e70d152/scripts/build-apk-dev-fast.mjs) 明示跳过所有发布门禁，复用已有 snapshot 后运行 assembleDebug。它不属于本仓获准的来源链。处置：保持实施计划的候选来源构建决定项，不用此脚本、旧协调仓链或改分支名来绕过 main-only 规则；本轮没有修改该规则。

## R12：活动配置传输主路径已经覆盖，不按旧类名重做

两边 MainActivity 的导入导出都调用 EngineManager，再进入 SnapshotUserData.configurationDocument/exportConfiguration/importConfiguration；后者会选择迁移后的 profile patch，并避免历史共享 settings.yaml 覆盖它。ConfigTransfer.kt 中的历史复制类仍在，但未见它实例化为当前导入导出入口。

处置：不新增“迁移活动配置导入导出”的重复功能 PR。后续离线写者盘点必须把 SnapshotUserData.importConfiguration 纳入排他边界，因为真正执行的入口会替换活动配置；查旧类和注释不足以列全写者。

## 计划修订结论

B/A/C1/C2 保持主线，补入 F 悬浮服务生命周期和 G 会话身份复用两个可独立复现、独立交付的候选；语言与抽屉常驻细化为条件工作包。保留本地自动恢复、显式屏幕目标/末端范围门、Linux 重解包和浏览器兼容模式。每项的进入/退出、源码触点、反例、回滚和真实任务要求在实施计划维护，本报告只存源码证据和处置依据。
