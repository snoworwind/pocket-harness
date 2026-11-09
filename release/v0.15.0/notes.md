# Pocket Harness v0.15.0

本版为 0.14.12 之后的版本线提升（versionCode 57），引擎仍为 DeepSeek Harness `0.2.2-rc.1`（固定源码 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）。

## 安装与升级

- 仅提供来源链构建的 ARM64 / x86_64 APK；正式候选以来源草稿的双 ABI 产物为准。
- 应用版本 0.15.0（versionCode 57）；覆盖安装保留应用数据。
- 安装前请核对 Release 附带 `SHA256SUMS.txt`。

## 更新内容（候选）

- 快照管理面板层级修复：面板重新压过对话正文，遮罩恢复整屏（恢复 #288 的页眉提升 + titleRow 解除 containment）。
- 沿用 0.14.12 的修复：`URL.canParse` polyfill（WebView 114 下助手正文空白）、AppFrame 顶栏避让（左上抽屉键与标题行对齐）、Termux 包选版与 ICU 79 ABI 同步。

## 验证范围与限制

- 草稿阶段：代码与静态门禁随 PR 执行；设备层验收待最终 APK 装机后按发布规范补充。
- 已知限制：x86_64 资产不含离线 PRoot Linux 与 Android Canvas native；设备验收覆盖的 WebView 为 Chromium 114。

**待补**：目标 Commit、来源 run 与 APK SHA-256 在草稿构建完成后填写；正式发布前按项目规范记录未执行层与剩余风险。
