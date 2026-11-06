# Pocket Harness v0.14.12

Pocket Harness 升级至 DeepSeek Harness `0.2.2-rc.1`。本版保留原生工具执行并继续关闭 PTC 执行器；Android 文件观察策略明确保持启用。`web_fetch` 保持可用。

## 安装与升级

- 仅提供 ARM64 Android APK：`pocket-harness-v0.14.12-source-arm64.apk`。
- APK 由 main 来源链构建，应用版本为 0.14.12（versionCode 56）。请通过本页下载 APK 和 `SHA256SUMS.txt`，安装前核对哈希；升级安装会保留应用数据。
- 来源工作流：[run 42227774209](https://github.com/snoworwind/pocket-harness/actions/runs/42227774209)，APK 对应提交 `99b396c8fae05328dc29542abcf7e59b455c32a8`。PR #243 之后合入的改动只修正横屏验收探针，不更改 APK 运行时代码。
- APK SHA-256：`f5dca2c8019feab61e37ccefa53dbd8499283ce607a8620bd78f574ae49fed49`。

## 更新内容与限制

- 更新 Cordis、Schemastery、pi-ai 等运行时依赖至 rc.1 固定版本；继续使用 native 工具执行器，不启用 PTC。
- Android 显式启用文件观察策略，保留会话观察状态、no-clobber 写入以及编辑/删除前读取和版本校验。
- `web_fetch` 继承上游默认可用行为。rc.1 不再默认拒绝私网目标；Android 没有按工具隔离的网络出口过滤，因此该工具可能访问私网地址。
- 只发布 ARM64 包；x86_64 设备不兼容此 APK。

## 验证范围

- 来源工作流完成 ARM64 primary/reference 双构建、APK 字节交叉核验、签名检查与草稿创建；[PR Gate run 42242027113](https://github.com/snoworwind/pocket-harness/actions/runs/42242027113) 的 Kotlin 编译/单测、静态门禁和源码回归均通过。
- 已在 Google 官方 Android 16/API 36 `default/arm64-v8a` host-GPU 模拟器安装并启动 APK。快照刷新完成后，portrait 和 landscape live CDP 均 39/39 通过；ADB 操作覆盖抽屉打开/返回关闭、设置页返回和新会话入口。
- 设备证据目录：`.deploy-tmp/v0.14.12-release-42227774209/`。`web_fetch` 的 rc.1 包和 Android profile 配置已在已安装 APK 的运行时文件中核实。
- **未完成的验收**：ARM64 真机 V2425A 当前不可用，未做真机竖屏/横屏操作；模拟器无模型凭据，未发送真实 AI 请求。新会话入口显示添加 API key/登录提示。AVD 检查通过，但不代表真机或模型请求链已验收。
