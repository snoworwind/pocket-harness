# Pocket Harness 0.14.10（开发候选，未验收）

## 更新内容

- DeepSeek Harness 引擎来源从 0.2.1-rc.3 累计升级到 0.2.1-rc.5，包含中间 rc.4 的改动。
- rc.4 修复 ACP 模式诊断信息混入 stdout；rc.5 优化思考内容展示，并隐藏用于模型处理的签名元数据。
- Android 版本候选为 0.14.10（versionCode 54）。

详细源码来源、两段版本差异和本仓适配见[引擎升级记录](../../docs/AGENTS/ENGINE-UPGRADE-2026-10-31.md)。

## 安装与升级

最终 main 源码构建 CI [run #41180533767](https://github.com/snoworwind/pocket-harness/actions/runs/41180533767) 于提交 `701773c` 成功完成 ARM64 primary/reference 双构建、实际 APK 字节交叉核验（digest `7b782d8d4f10f0909c87dbe59780095b3331676252c1082acef2ed985615f8b0`）和签名检查，并创建含 4 项资产的 GitHub 预发布草稿 [`untagged-b74e0f24963968b9599e`](https://github.com/snoworwind/pocket-harness/releases/tag/untagged-b74e0f24963968b9599e)。草稿未公开。之后仅更新验收证据文档，不改变 APK 输入。

设备三层验收和覆盖安装尚未完成；普通使用请继续使用已发布的 Pocket Harness v0.14.9，不要将此草稿作为正式版本发布。

## 验证状态

- rc.5 官方 npm tarball 夹具检查通过，26/26 引擎补丁锚点命中。
- 固定 rc.5 官方源码树合同检查通过：93 个客户端槽位、187 个上游行，15/15 个运行期 peer 判定通过。
- 已合并 PR #196 修复 Windows 测试的 CRLF 与路径转换问题；WSL Ubuntu 下完整补丁回归清单 77/77 通过。Windows 原生运行有 2 项因已登记的 symlink 平台限制跳过；PR Gate 全绿。
- 最终 main 来源草稿 CI [run #41180533767](https://github.com/snoworwind/pocket-harness/actions/runs/41180533767) 成功：提交 `701773c` 的 ARM64 primary/reference 双构建、交叉核验、签名检查和草稿资产准备全部通过；实际 APK 字节重建 digest 为 `7b782d8d4f10f0909c87dbe59780095b3331676252c1082acef2ed985615f8b0`。预发布草稿 [`untagged-b74e0f24963968b9599e`](https://github.com/snoworwind/pocket-harness/releases/tag/untagged-b74e0f24963968b9599e) 含 4 项资产，仍未公开。
- PR #199 修复来源预检从已移除的 workflow 固定语句读取 marketplace 输入的问题；`preflight-source-chain.mjs --self-test` 的 1 个真实输入和 5 个受控负控通过，PR Gate 通过。
- **未做设备验证**：尚未完成 CDP、ADB 用户操作、横屏或 ARM64 真机验收。本轮执行环境访问 WSL 返回 `Wsl/E_ACCESSDENIED`，因此无法确认或使用 WSL 中的 Android SDK/ADB。

本文件是开发草稿，不代表可发布版本；候选进入发布前必须从最终 main 重跑来源链，并完成仓库验收规范要求的设备验证。
