# Pocket Harness v0.14.12

> 当前发布（2026-11-09）：提交 `b6e6324b82bb`，来源 run [42556539194](https://github.com/snoworwind/pocket-harness/actions/runs/42556539194)，**ARM64 + x86_64 双 ABI**。
> 本版修复：助手正文整段空白（WebView 114 缺 `URL.canParse`）、左上角抽屉键高过标题行（frame 改透明 `border-top` 避让）、
> 快照按滚动 Termux 仓库选版并跟随上游把 node 迁到 ICU 79。ARM64 APK SHA-256 `0911301f563682c289e360e47444624c36a6c72d5b40f82f8c3e105f6a6e3bc0`。
> 设备验收（用户执行）：HUAWEI SGT-AL10 / Android 36 / WebView 114 安装 ARM64 包后启动成功、对话正文恢复、左上角按钮对齐；
> CDP verify 套件本轮未执行，x86_64 未做设备层验证。下方各节描述上一版（`080daeed` / run 42375273206）的 ARM64 单 ABI 发布，保留作历史对照。

本版修复 Android 竖屏设置界面与左侧栏入口问题，并继续基于 DeepSeek Harness `0.2.2-rc.1`。

## 安装与升级

- 仅提供 ARM64 Android APK：`pocket-harness-v0.14.12-source-arm64.apk`。
- 应用版本为 0.14.12（versionCode 56）；升级安装会保留应用数据。
- 本次来源构建对应 main 提交 `080daeedeb436525408bf89c2c56b4a3be881627`，PR #246 已合入。
- 来源工作流：[run 42375273206](https://github.com/snoworwind/pocket-harness/actions/runs/42375273206)。
- APK SHA-256：`9048b841f2b416a48c4529438075527645dd8e22ca0a122d755afc0857e301ea`。安装前请核对随包 `SHA256SUMS.txt`。
- x86_64 设备不兼容此 ARM64 APK。

## 更新内容

- 竖屏设置恢复为 DSH 自带的双栏 Web 界面：分类导航与设置内容并排显示，分别在各自列内滚动；不再使用手机专属两级设置页。
- 修复左侧栏出现两个打开按钮的问题：收起时由页眉按钮打开，展开后由 DSH 栏内按钮关闭。
- 保留 rc.1 的原生工具执行器并继续关闭 PTC。Android 文件观察策略保持启用。
- `web_fetch` 保持可用。rc.1 默认允许私网目标；Android 没有按工具隔离的网络出口过滤，因此该工具可能访问私网地址。

## 验证范围与限制

- CI 来源工作流通过 ARM64 primary/reference 双构建、APK 字节交叉核验、签名检查和来源证明核验；[PR Gate run 42374900879](https://github.com/snoworwind/pocket-harness/actions/runs/42374900879) 的 Kotlin 编译、插件单测与静态源码回归通过。
- 使用本地 Android 16 API 36 x86 WebView 临时回归 APK，按固定 rc.1 SettingsRoot 结构和本次 CSS 检查竖屏、横屏双栏显示。该测试页不是完整 Pocket Harness 应用，也不证明完整应用的壳侧集成。
- **设备验收未完成**：本地只有 x86_64 Android 16 模拟器，不能安装此 ARM64 APK；最终 APK 未在 Google 官方 Android 16 `arm64-v8a` AVD 或 ARM64 真机 V2425A 上完成 CDP/ADB 操作。真机当前不可用，且没有可发送真实 AI 请求的模型凭据。
- 剩余风险：完整应用中的 WebView/壳侧集成、ARM64 设备上的触摸与系统 inset 行为，以及真实模型请求尚未由最终 APK 验证。本版按未完成设备验收范围发布，不代表这些项目已通过。
