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

## 当前检查结果与验收边界

RC3 补丁夹具已从官方源码构建缓存捕获，包含 53 个目标文件；`check-patch-fixtures.mjs --require` 通过。完整引擎补丁探针以同一来源包和 source-build manifest 运行，26/26 补丁应用成功。此前发现并修复两处 RC2 假设：MiMo 适配器改为校验引擎根包与目标 DSH 模块同版、pi-ai 固定 `1.1.0`；PTC 适配器移除硬编码 RC2 版本拒绝，保留包身份与精确补丁锚点。另修复来源发布测试中仍创建 RC2 夹具目录的旧路径。

OrbStack Linux 隔离环境完成 Harness 来源构建阶段；完整 Node 来源构建测试 167/167、Python 来源构建测试 62/62、补丁测试 77/77 通过。补丁解析回归也已修正 Node 20 与 Node 24 的 ESM 判定差异，补丁清单在 macOS Node 20 和 OrbStack Node 24 两边都为 77/77。三份 `assets/patched` 已由 RC3 来源构建树经全补丁链重出，并与已施加补丁的探针目标逐字节比较通过。资产字节数与上一版本恰好相同；这表示本轮所指包文件的字节内容未变，不代表沿用了旧来源。

本机 OrbStack PR Gate 对提交 `b1c1e49f9d39ad44da3f3972f07a95f5554421a4` 完成 28/28 步；`:app:testDebugUnitTest` 编译并通过 125 个测试类、1386 个用例，Kotlin 测试计数门禁通过。`node scripts/check-state-registry.mjs` 也通过。Kotlin 编译器输出若干既有 nullable `File?` 测试警告，但构建与测试成功。

**本分支仍不是可发布或已验收的升级。** 当前快照/APK 没有由最终提交的正式 main 来源链重建；三份覆盖资产尚未与该最终快照逐字节对账。Android 16 / API 36 ARM64 AVD、真机、CDP 或 ADB 用户体验三层验收未完成。GitHub CLI 保存凭据仍被判无效，因此分支尚未推送、PR 尚未创建。测试环境的来源构建证据来自隔离验证副本，只证明 Harness 构建阶段和已列测试结果，不能冒充正式发布链。

## 发布前仍需补齐

1. 将本分支通过标准 PR 合入 `main` 后，从最终 main 提交运行正式来源链，核对依赖闭包、包版本、来源清单、双构建与最终 APK。
2. 在最终快照中逐字节对账三份 `assets/patched`，并完成签名、权限、APK 资产和冷启动门禁。
3. 运行 Kotlin 单测及适用的静态/来源门禁；设备就绪后在 Android 16 / API 36 官方 ARM64 AVD 和 ARM64 真机完成代码、CDP、ADB 三层验收，任务与证据遵循 `emulator-test-protocol.md`。
4. 将设备缺口和真实验收证据补入 release notes；未补齐前保持开发候选，不公开发布或标记功能完好。
