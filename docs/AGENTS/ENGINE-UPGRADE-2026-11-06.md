# DeepSeek Harness 0.2.2-rc.1 升级记录

## 目标与固定来源

Pocket Harness v0.14.12 将运行时从 0.2.1-rc.5 升级到官方预发布 `dsh-v0.2.2-rc.1`。来源固定为 commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，Git tree `3aeac580e803b0ce82f867b1374ed494a59662c2`。上游 `pnpm-lock.yaml` SHA-256：`aa1293f2e8d3ee82cb3cfcb0e65ba8a0ef73ab80fad4c35d7ed2f7c67b95a625`；package manager 仍为 pnpm 11.28.5。上游将 Node 要求提高到 `>=24.9.0`，来源链使用 Node 24.21.0。

上游参考：[0.2.2-rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)。本记录只描述固定源码与 Android 适配，不表示 APK 已构建或设备验收已完成。

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

## 交付状态

- 目标应用版本：0.14.12 / versionCode 56。
- PR、合并提交、PR Gate 与 main 来源草稿 CI：待完成后记录。
- 10 个 Android 插件 npm `package-lock.json` 已按更新后的 peer/devDependency 重生成；CI 将核验锁文件解析、依赖安装与来源构建闭包。
- ARM64 模拟器 CDP/ADB 与真机验收：尚未执行；开发 PR 不以设备验收阻塞，公开正式 Release 前按 [设备验收规范](emulator-test-protocol.md) 执行。
