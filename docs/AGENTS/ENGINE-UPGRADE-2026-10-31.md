# DeepSeek Harness 0.2.1-rc.5 升级记录

## 目标与来源

Pocket Harness 当前正式版仍是 v0.14.9，来源目标为 DeepSeek Harness 0.2.1-rc.3。本候选将引擎推进到官方 `dsh-v0.2.1-rc.5`，因此包含 rc.3→rc.4 和 rc.4→rc.5 两段累计升级，不只包含最后一个 tag。

- rc.4：官方发布说明记录 ACP 模式的诊断输出不再混入 stdout。源码也调整了会话视图菜单、DeepSeek 账号模型列表和 MCP 客户端相关实现。
- rc.5：官方发布说明记录改进对话中思考内容的展示。源码会从展示文本中剥离 `<signature>…</signature>` 元数据；`conversation.chat.reasoning.body` 插槽新增 `rawText` 原文字段，`text` 改为已处理的展示文本。
- 完整来源提交链：rc.3 `1f81c047fc48fa190a683e469daa699857e9afe8` → rc.4 `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` → rc.5 `b830ec950faba0a46dda564be3e2d854afed94f1`。rc.5 Git tree 为 `83b5907ce7d490eaafc7f5acadb81876b25bb77a`。官方 pnpm lockfile SHA-256 与 rc.3 相同：`911b049924e8256d8d6e684235cf935ca75b28fd0dd46f0c3b316a51c2cf5dc1`；package manager 仍为 pnpm 11.28.5。

来源依据：[rc.4 官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.4)、[rc.5 官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)。

## 本仓适配

- 引擎合同、overlay、源码构建断言、Termux 装配检查、pnpm deploy 检查、marketplace peer 适配和来源工作流均固定到 rc.5 提交及包版本。
- 重新枚举官方客户端生产槽位后仍为 93 项：无新增/删除，kind/scope 无漂移；上游 bundle row 仍为 187 项。
- `check-contract.mjs` 使用固定 rc.5 官方检出通过（93 个槽位、187 个行、15/15 个运行期 peer 判定，SKIP=1 仅因自包含仓无协调仓专属文档）。本机不带覆盖参数时读到旧 rc.2 临时检出而失败；该临时目录不属于源码固定目标。
- 对仓内插件与客户端源码做了 reasoning body 槽位消费者检索，没有本地插件读取该插槽，因此不需要改造自定义 renderer。Termux、响应式 WebView、8 个插件以及 marketplace 元数据中的 DSH peer 均已同步到 rc.5。
- Android 版本候选提升到 v0.14.10 / versionCode 54。

## 当前开发证据与边界

- `scripts/check-patch-fixtures.mjs` 通过；当前 53 个补丁夹具由官方 npm 发布 tarball 捕获，台账明确标为 `published-tarball`，不是本轮来源构建产物。
- `node scripts/probe-engine-anchors.mjs` 对这些 rc.5 发布包的 26 个引擎补丁全部命中。正式来源链会从固定源码重建包并重新捕获夹具；该来源构建尚未执行，发布包夹具不能替代来源构建产物的逐字节证据。
- Windows 测试可移植性修复已由 [PR #196](https://github.com/snoworwind/pocket-harness/pull/196) 合并，修正 CRLF profile 处理与 `URL.pathname` 的 Windows 路径转换；两个受影响文件的用例 5/5 通过。随后在 WSL Ubuntu 运行 `node scripts/check-patch-test-manifest.mjs`，32 个文件、77/77 用例通过；Windows 原生复跑为 75 项通过、2 项失败但均属于台账已登记的 symlink 平台限制，门禁按登记规则通过。PR #196 的 PR Gate 全部成功。
- WSL 未配置 Android SDK 或 ADB，当前尚未构建并安装最终 ARM64 APK，也未完成 CDP/ADB 三层设备验收。当前是开发候选，不可标记为已验收或发布。

进入发版前，必须从最终提交运行 ARM64 来源链，核对两份独立构建与签名，并按[模拟器验收规范](emulator-test-protocol.md)补齐设备三层验收；设备缺席须在发布说明中保留限制。
