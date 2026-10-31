# Pocket Harness 0.14.10（开发候选，未验收）

## 更新内容

- DeepSeek Harness 引擎来源从 0.2.1-rc.3 累计升级到 0.2.1-rc.5，包含中间 rc.4 的改动。
- rc.4 修复 ACP 模式诊断信息混入 stdout；rc.5 优化思考内容展示，并隐藏用于模型处理的签名元数据。
- Android 版本候选为 0.14.10（versionCode 54）。

详细源码来源、两段版本差异和本仓适配见[引擎升级记录](../../docs/AGENTS/ENGINE-UPGRADE-2026-10-31.md)。

## 安装与升级

来源草稿 CI [run #41175692871](https://github.com/snoworwind/pocket-harness/actions/runs/41175692871) 已在 main 提交 `67df6c6` 完成 ARM64 双构建、交叉核验和签名检查，并创建含 4 项资产的 GitHub 预发布草稿。草稿未公开。此后合入的 PR #199 只修正来源预检脚本与文档，没有改动引擎、运行时或 APK 资产输入；因此本草稿仍绑定 `67df6c6`，最终候选发布前仍须从最终 main 重跑来源构建。

设备三层验收和覆盖安装尚未完成；普通使用请继续使用已发布的 Pocket Harness v0.14.9，不要将此草稿作为正式版本发布。

## 验证状态

- rc.5 官方 npm tarball 夹具检查通过，26/26 引擎补丁锚点命中。
- 固定 rc.5 官方源码树合同检查通过：93 个客户端槽位、187 个上游行，15/15 个运行期 peer 判定通过。
- 已合并 PR #196 修复 Windows 测试的 CRLF 与路径转换问题；WSL Ubuntu 下完整补丁回归清单 77/77 通过。Windows 原生运行有 2 项因已登记的 symlink 平台限制跳过；PR Gate 全绿。
- 来源草稿 CI [run #41175692871](https://github.com/snoworwind/pocket-harness/actions/runs/41175692871) 成功：ARM64 双构建、交叉核验、签名检查和草稿资产准备通过；生成的预发布草稿含 4 项资产，未公开。该产物对应 main 提交 `67df6c6`；PR #199 合入后，最终发布候选仍须从最终 main 重跑来源构建。
- PR #199 修复来源预检从已移除的 workflow 固定语句读取 marketplace 输入的问题；`preflight-source-chain.mjs --self-test` 的 1 个真实输入和 5 个受控负控通过，PR Gate 通过。
- **未做设备验证**：尚未完成 CDP、ADB 用户操作、横屏或 ARM64 真机验收。本轮执行环境访问 WSL 返回 `Wsl/E_ACCESSDENIED`，因此无法确认或使用 WSL 中的 Android SDK/ADB。

本文件是开发草稿，不代表可发布版本；候选进入发布前必须从最终 main 重跑来源链，并完成仓库验收规范要求的设备验证。
