# Pocket Harness v0.14.10 正式发布

DeepSeek Harness 引擎从 0.2.1-rc.3 累计升级到 0.2.1-rc.5，包含 rc.4 的改动。rc.4 修复 ACP 模式诊断信息混入 stdout；rc.5 优化思考内容展示，并隐藏用于模型处理的签名元数据。

## 安装与升级

本版本为 ARM64 Android 正式版，versionCode 54。来源构建 CI [run #41180533767](https://github.com/snoworwind/pocket-harness/actions/runs/41180533767) 基于提交 `701773c` 完成 ARM64 primary/reference 双构建、APK 字节交叉核验和签名检查。

正式发布 APK SHA-256：`bd99ac410362e5bba7b85845f2c1e35a196dd030ff8e40b62dd83bcab2d8785d`。下载后可用 `SHA256SUMS.txt` 校验 APK、来源证明和本说明。APK 使用 Pocket Harness 独立签名身份。

GitHub Release：[Pocket Harness v0.14.10](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-701773cdd2e4-41180533767-1)。

## 验证范围与限制

- 引擎升级回归：rc.5 官方 npm tarball 夹具检查通过，26/26 引擎补丁锚点命中；官方源码树合同检查覆盖 93 个客户端槽位，15/15 个运行期 peer 判定通过。
- WSL Ubuntu 补丁回归清单 77/77 通过；Windows 原生运行有 2 项因已登记的 symlink 平台限制跳过。
- **设备验收尚未完成**：CDP、ADB 用户操作、横屏、ARM64 真机和覆盖安装均未验证。该版本按正式版发布，但这些设备验收项目仍未验证；部署前请将此范围纳入评估。
