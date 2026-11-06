# DeepSeek Harness 0.2.2-rc.1 升级记录

## 目标与固定来源

Pocket Harness v0.14.12 将运行时从 0.2.1-rc.5 升级到官方预发布 `dsh-v0.2.2-rc.1`。来源固定为 commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，Git tree `3aeac580e803b0ce82f867b1374ed494a59662c2`。上游 `pnpm-lock.yaml` SHA-256：`aa1293f2e8d3ee82cb3cfcb0e65ba8a0ef73ab80fad4c35d7ed2f7c67b95a625`；package manager 仍为 pnpm 11.28.5。上游将 Node 要求提高到 `>=24.9.0`，来源链使用 Node 24.21.0。

上游参考：[0.2.2-rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)。本记录涵盖固定源码、Android 适配、来源构建和设备验收；本版本已作为 ARM64 正式版发布，设备范围限制见下文。

## 上游变化及 Android 适配

- Cordis 更新到 4.1.0，Schemastery 更新到 3.19.0，pi-ai 更新到 1.3.0；overlay 按固定 rc.1 package manifests 和 lockfile 同步。
- 工具执行器拆分为 native 与 PTC 插件，并改变工具可用性和 prompt assembly 接口。本仓保留 native 执行器，PTC 执行器继续关闭；Android 所有插件 peer/devDependency 同步到 0.2.2-rc.1、Cordis 4.1.0 与 Schemastery 3.19.0。
- 上游 base/web-app 行面从 192 项变为 197 项：新增 7 项，删除旧 subagent list 与 model-label 行。新 PTC 执行器仍标为禁用；新增上游 UI 插槽 6 项均未发现本仓 Android renderer 消费。旧模型标签包已从 overlay 移除。
- 上游将 fs-observation-policy 在 base 配置中设为禁用。Android profile 明确覆盖为启用，以保留每个会话的观察状态、写入 no-clobber、编辑/删除前读取以及版本校验语义；本仓已有 Android 原子写入适配仍需来源链门禁覆盖。
- 上游 Web Fetch 取消默认公有地址校验，允许访问私网目标。按项目要求，本次保留通用 fetch provider 与 `tool-web.fetch`，继承 rc.1 的默认可用行为。Android 没有按工具隔离的网络出口控制，因此用户启用 `web_fetch` 时它可能访问私网地址；本版本没有新增网络出口过滤。
- PTC 控制通道改为 birpc、SSH helper 协议升到 v3、调用方取消的 `run_code` 状态改为 `ABORTED`。当前 Android profile 不挂 PTC 执行器，仍由来源构建兼容检查确认运行时代码未误挂此路径。

## 来源链与文件清单

本次同步了 engine tag/commit/version/Node 断言、overlay package pins、源码导出与部署检查、Termux bootstrap、preview pruning、marketplace 元数据校验，以及 Android 插件 manifests。新增上游 package rows 和 client slots 已重新捕获并人工审阅；来源锁文件没有上游改写。

依赖与工具链台账见 [DEPENDENCIES.md](DEPENDENCIES.md)，用户可见说明见[候选发布说明](../../release/v0.14.12/notes.md)。

## 交付与验收

- 正式应用版本：0.14.12 / versionCode 56；仅发布 ARM64 APK。
- 引擎升级 PR #236、来源资产 PR #241、设备回归修复 PR #242 与横屏探针修复 PR #243 均已合入 `main`。PR #243 的 merge commit 为 `a8c341006e452b1c4024749f865f3e28694ffae8`，PR Gate run [42242027113](https://github.com/snoworwind/pocket-harness/actions/runs/42242027113) 全绿。该 PR 只修改验收探针与文档，不改变 APK 运行时代码。
- 最终 Android APK 来自 main 来源草稿 run [42227774209](https://github.com/snoworwind/pocket-harness/actions/runs/42227774209)，构建目标提交 `99b396c8fae05328dc29542abcf7e59b455c32a8`。ARM64 primary/reference 双构建、APK 字节交叉核验、签名与草稿创建全部通过。正式 Release tag 为 [`hardening-source-99b396c8fae0-42227774209-1`](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-99b396c8fae0-42227774209-1)，APK SHA-256：`f5dca2c8019feab61e37ccefa53dbd8499283ce607a8620bd78f574ae49fed49`。
- 10 个 Android 插件 npm `package-lock.json` 已按更新后的 peer/devDependency 重生成；来源工作流已通过锁文件解析、依赖安装与来源构建闭包检查。
- Android Studio Google 官方 Android 16/API 36 `default/arm64-v8a` host-GPU AVD 已安装并启动该来源 APK；快照刷新完成标志已核实。最终 APK portrait 与 landscape 的 `verify-webview-015` live CDP 均 39/39 通过。ADB 用户操作覆盖 portrait 抽屉打开/系统 Back 关闭、设置页返回，以及 landscape 设置返回和新会话入口；屏幕截图与 CDP 日志保存在 `.deploy-tmp/v0.14.12-release-42227774209/`。探针修复自测 24/24、含受控负控；同 PR Gate 的 Kotlin 编译/单测和静态门禁/源码回归全绿。
- **设备验收范围受限**：ARM64 真机 V2425A 不可用，未做真机竖屏/横屏验收；模拟器没有模型凭据，未发送真实 AI 请求。新会话入口实际显示添加 API key/登录提示。已完成的 AVD/CDP/ADB 检查通过，但不能据此声称真机或模型请求链已验收；发布按项目设备协议记录上述豁免和剩余风险。
- `web_fetch` 保持可用。Android profile 的 `web-fetch-http` 与 `tool-web.fetch` 继承上游默认行为；引擎 0.2.2-rc.1 不再默认拒绝私网目标，Android 没有按工具隔离的网络出口过滤，因此该工具可能访问私网地址。
