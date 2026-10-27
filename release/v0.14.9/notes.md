# Pocket Harness 0.14.9（开发草稿，未发布）

## 计划变更

- 引擎来源目标更新为 DeepSeek Harness `0.2.1-rc.3`。上游版本增加多个 More 菜单、修复切换会话后未发送草稿的恢复，并调整 API Key 适配器的模型列表同步。
- 应用源码版本为 0.14.9，versionCode 为 53。

## 状态与限制

RC3 是目前可核验的官方源码标签。npm 已出现 `0.2.1-rc.4` `next` 包，但公开源码仓没有匹配标签或提交 provenance；本候选不包含这个无法绑定到源码的包。RC3 夹具、补丁回归和三份运行时覆盖资产已从官方来源构建产物重出，并在隔离验证环境通过 Harness 构建阶段和补丁测试。正式 main 来源链、最终快照/APK、设备验收和发布资产仍未完成；该草稿不能作为安装指引，也不代表升级已验收。

## 验证

- `node scripts/check-contract.mjs --require`：通过，协调仓文档缺席为预期 `SKIP=1`。
- package-lock 根声明、code map、维护文档、workflow action pin 自检、补丁夹具/测试清单自检和差异空白检查：通过。
- RC3 补丁夹具检查通过；引擎补丁探针 26/26、来源构建 Node 测试 167/167、Python 测试 62/62、补丁测试 77/77 通过。
- OrbStack 本机 PR Gate 28/28；Kotlin 单测 125 个测试类、1386 个用例通过；状态登记门禁通过。
- 三份运行时覆盖资产与 RC3 完整补丁探针树逐字节一致；最终快照/APK 字节对账尚未完成。
- 正式 main 来源链、最终 APK、Android 16 ARM64 AVD 与真机 CDP/ADB 用户验收：未完成；本候选未做设备验证。

升级过程和剩余门禁见 [ENGINE-UPGRADE-2026-10-27.md](../../docs/AGENTS/ENGINE-UPGRADE-2026-10-27.md)。
