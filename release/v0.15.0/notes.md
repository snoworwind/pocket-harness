# Pocket Harness v0.15.0

> 当前发布（2026-11-09）：提交 `680f41c75ced`，来源 run [42628809984](https://github.com/snoworwind/pocket-harness/actions/runs/42628809984)，**ARM64 + x86_64 双 ABI**，Release [`hardening-source-680f41c75ced-42628809984-1`](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-680f41c75ced-42628809984-1) 已公开并设为 Latest。
> 本版把版本线提升到 0.15.0（versionCode 57），新增快照管理面板层级修复与出厂全局指令基线。引擎为 DeepSeek Harness `0.2.2-rc.1`（固定源码 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）：与 0.14.12 相同；但由于 0.14.12 已撤回，从 0.14.11（引擎 0.2.1-rc.5）升级到本版会同时获得这次引擎升级，差异见[升级记录](../../docs/AGENTS/ENGINE-UPGRADE-2026-11-06.md)。
> ARM64 APK SHA-256 `c39c3a592aa6a11f6ec1b6ca0547873b94be1a66752ea010b898071f816e9f5b`，x86_64 为 `9165fc4cdfe7e68dea420a94db1ba3e099aff62f6d99a433fd80a1ed7701926b`。
> 上一版 0.14.12 的 Release 对象已于 2026-11-09 删除（存在缺陷），其 source tag `hardening-source-b6e6324b82bb-42556539194-1` 保留。

## 安装与升级

- 双 ABI：`pocket-harness-v0.15.0-source-arm64.apk`（真机）与 `pocket-harness-v0.15.0-source-x86_64.apk`（模拟器开发 QA）；真机只能用 ARM64 包。
- 应用版本 0.15.0（versionCode 57）；覆盖安装保留应用数据，可从 0.14.11 或更早版本直接升级。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖两个 APK、`provenance.zip` 与 `notes.md`）。
- APK 使用 Pocket Harness 独立签名身份；来源证明在 `provenance.zip` 下按 ABI 分目录。
- x86_64 包不含离线 PRoot Linux 资产与 Android Canvas native，这两项只在 ARM64 包中提供。

## 更新内容

- 快照管理面板层级修复（PR [#266](https://github.com/snoworwind/pocket-harness/pull/266)）：面板重新压过对话正文，遮罩恢复整屏覆盖，修复被页眉提升与 `titleRow` containment 破坏的层级。
- 出厂全局指令基线（PR [#268](https://github.com/snoworwind/pocket-harness/pull/268)）：基线文件随安装包交付到每一次安装，升级时整份替换；用户自己的全局约定写 `~/.agents/AGENTS.md`，项目约定写项目根 `AGENTS.md`，均不受升级影响。
- 版本线提升到 0.15.0 / versionCode 57（PR [#267](https://github.com/snoworwind/pocket-harness/pull/267)）。
- 沿用 0.14.12 的修复：`URL.canParse` / `URL.parse` polyfill（WebView 114 上助手正文整段空白）、AppFrame 顶栏避让（左上抽屉键不再高过标题行）、Termux 包选版与 libicu 79 ABI 同步。
- 保留 rc.1 的原生工具执行器并继续关闭 PTC；Android 文件观察策略保持启用；`web_fetch` 保持可用（rc.1 默认允许私网目标，Android 没有按工具隔离的网络出口过滤）。

## 验证范围与限制

- CI：来源 run 42628809984 的 prepare、ARM64/x86_64 两个 `termux-package-inputs`、两个 ABI 各自的 primary/reference 构建、`verify-abi`、`sign-abi` 与 `draft` 全部成功；APK 字节未经改动直接上传。PR #264/#266/#267/#268 的 PR Gate 均已通过。
- 设备层（部分执行，如实记录）：最终 ARM64 APK 已安装并在用——设备上 `base.apk` 的 SHA-256 `c39c3a59…e9f5b` 与发布包逐字节一致，本说明对应的会话即运行在该包内（界面加载、会话与工具调用正常）。
- 设备层（未执行，剩余风险）：CDP verify 套件（`verify-webview-015.mjs` 等）未跑，组件几何与跨层状态语义没有自动断言；横屏、多步用户任务、覆盖升级安装、冷启动矩阵未做截图级验收；x86_64 包未做任何设备层验证。
- 本版按「部分设备验收 + 已披露豁免」发布，不声明上述未执行层通过。
