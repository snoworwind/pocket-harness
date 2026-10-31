# Pocket Harness 0.14.10（开发候选，未验收）

## 更新内容

- DeepSeek Harness 引擎来源从 0.2.1-rc.3 累计升级到 0.2.1-rc.5，包含中间 rc.4 的改动。
- rc.4 修复 ACP 模式诊断信息混入 stdout；rc.5 优化思考内容展示，并隐藏用于模型处理的签名元数据。
- Android 版本候选为 0.14.10（versionCode 54）。

详细源码来源、两段版本差异和本仓适配见[引擎升级记录](../../docs/AGENTS/ENGINE-UPGRADE-2026-10-31.md)。

## 安装与升级

尚无本版本 APK。正式来源构建、签名和 ARM64 安装验收完成前，请继续使用已发布的 Pocket Harness v0.14.9。

## 验证状态

- rc.5 官方 npm tarball 夹具检查通过，26/26 引擎补丁锚点命中。
- 固定 rc.5 官方源码树合同检查通过：93 个客户端槽位、187 个上游行，15/15 个运行期 peer 判定通过。
- 补丁回归全套门禁在本机 Windows 未通过：存在 CRLF/Windows 路径测试问题，另有 2 个已登记的 Windows symlink 限制；Linux PR Gate 尚未运行。
- 正式源码构建、APK 双构建与签名核验尚未完成。
- **未做设备验证**：当前环境没有 Android SDK 或 ADB，未完成 CDP 检查、ADB 用户操作、横屏或 ARM64 真机验收。

本文件是开发草稿，不代表可发布版本；候选进入发布前必须完成仓库验收规范要求的来源链和设备验证。
