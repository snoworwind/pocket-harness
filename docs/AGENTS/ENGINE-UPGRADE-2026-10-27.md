# DeepSeek Harness 0.2.1-rc.3 升级记录

## 目标与来源

将 Pocket Harness 的引擎来源目标从 `0.2.1-rc.2` 提升到 DeepSeek Harness 最新可审计源码发布 [`dsh-v0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)，固定提交 `1f81c047fc48fa190a683e469daa699857e9afe8`。复查期间确认 npm 已发布 [`@deepseek-ai/dsh@0.2.1-rc.4`](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions) 并标为 `next`，但该版本元数据没有 `gitHead`，公开 Harness 仓库没有 `dsh-v0.2.1-rc.4` 标签，且公开 master 提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 的根包仍为 `0.2.1-rc.3`。本仓 APK 必须从官方源码构建，故不把来源无法绑定的 npm 预编译包冒充源码；rc.4 源码可核验后再追版。

已核对源码归档 SHA-256 为 `79b0da4ded4f675cfd086d07fbf530a203455b7300034322d7e14e4f6b0d7494`，解出 Git tree 为 `fe242286aaa4a399c91814de21e55f874ea34295`，与固定提交一致。官方 lockfile SHA-256 为 `911b049924e8256d8d6e684235cf935ca75b28fd0dd46f0c3b316a51c2cf5dc1`；来源链使用 pnpm `11.28.5`。

上游 rc.3 增加左侧栏、会话视图和右侧栏的 More 菜单，修复切换会话后新建会话丢失未发送草稿，并更新 DeepSeek API Key 适配器的模型列表同步方式。详情以[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)为准；这些上游功能尚未在 Pocket Harness WebView 上验收。

## 已落地的源码变更

- `scripts/contract.json`、`scripts/snapshot-config/engine-overlay.json` 固定 rc.3 提交和包版本，按 rc.3 源码清单刷新第一方包版本；新增并启用官方 `@deepseek-ai/dsh-client-ui-entry-customization` Web 包。
- Web UI 槽位合同从 90 条增至 93 条。新增的三个 `list/root` 槽位由上述官方包消费，用于三个 More 菜单；本仓 Android 插件没有注册这些槽位。
- 插件 `package.json`、marketplace peer 元数据和十份 npm lockfile 同步到 rc.3 peer 版本。
- 来源构建、部署 closure、Termux 装配和快照检查均固定到 rc.3 源提交；来源工作流的夹具上传路径同步更新。
- 应用开发版本提升到 0.14.9 / versionCode 53。
- Android 的来源构建阶段直接调用上游客户端编译器，原先漏传官方客户端构建环境，Web 标题因此回退到本地构建文案。现在注入上游 official profile 的提交短哈希、Harness 版本、品牌 profile 和标题，并在构建时检查 UI bundle、官方侧栏品牌槽位与 HTML title。

## 开发期检查结果与验收边界

RC3 补丁夹具已从官方源码构建缓存捕获，包含 53 个目标文件；`check-patch-fixtures.mjs --require` 通过。完整引擎补丁探针以同一来源包和 source-build manifest 运行，26/26 补丁应用成功。此前发现并修复两处 RC2 假设：MiMo 适配器改为校验引擎根包与目标 DSH 模块同版、pi-ai 固定 `1.1.0`；PTC 适配器移除硬编码 RC2 版本拒绝，保留包身份与精确补丁锚点。另修复来源发布测试中仍创建 RC2 夹具目录的旧路径。

OrbStack Linux 隔离环境完成 Harness 来源构建阶段；完整 Node 来源构建测试 167/167、Python 来源构建测试 62/62、补丁测试 77/77 通过。补丁解析回归也已修正 Node 20 与 Node 24 的 ESM 判定差异，补丁清单在 macOS Node 20 和 OrbStack Node 24 两边都为 77/77。三份 `assets/patched` 已由 RC3 来源构建树经全补丁链重出，并与已施加补丁的探针目标逐字节比较通过。资产字节数与上一版本恰好相同；这表示本轮所指包文件的字节内容未变，不代表沿用了旧来源。

本机 OrbStack PR Gate 对提交 `b1c1e49f9d39ad44da3f3972f07a95f5554421a4` 完成 28/28 步；`:app:testDebugUnitTest` 编译并通过 125 个测试类、1386 个用例，Kotlin 测试计数门禁通过。`node scripts/check-state-registry.mjs` 也通过。Kotlin 编译器输出若干既有 nullable `File?` 测试警告，但构建与测试成功。

`cloud-workflow.test.mjs` 已覆盖官方 profile 环境的正向条件与错误 profile/title、缺少 commit/version、漏掉三项构建产物断言的受控负控。

**在 PR #148 合入后的开发候选阶段，该候选尚不可发布或视为已验收。** 当时快照/APK 尚无最终 main 提交的正式来源链重建，三份覆盖资产尚未与最终快照逐字节对账，设备三层验收未完成。OrbStack 隔离验证副本只证明 Harness 构建阶段及相应来源检查结果，不能冒充正式发布链。后续正式来源构建及当前设备验收边界见下节。

## 正式发布结果与剩余验收

1. main 提交 `625fd8e0311d79cbb9788d41603517facdd8f6d7` 的来源 run [40473155658](https://github.com/snoworwind/pocket-harness/actions/runs/40473155658) 双构建、独立 APK 核验与签名检查通过；Pocket Harness v0.14.9 已发布，tag 为 `hardening-source-625fd8e0311d-40473155658-1`，APK SHA-256 为 `4671883239489e6881a5aa04ddc54c2281e576c382abe31cad1d7b074a7d94da`。
2. Android 16 ARM64 host-GPU AVD 覆盖安装 0.14.8、启动应用并核对官方 WebView 标题的烟测通过。`verify-webview-015` 为 38/39；唯一失败使用过期 Settings 选择器，人工 ADB/CDP 检查确认手机控制页和已启用的重置控件正常。
3. 完整设备验收仍未完成：AVD 使用 Android 16 / API 36 default 镜像而非要求的 Google APIs 镜像；未完成模型驱动多步任务、横屏操作或 ARM64 真机测试。发布时保留了这些限制；不得将发布烟测描述成完整三层验收。
4. 完整记录见 [v0.14.9 发布说明](../../release/v0.14.9/notes.md) 与 [GitHub Release](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-625fd8e0311d-40473155658-1)。
