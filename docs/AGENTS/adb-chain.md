# adb-chain.md — 历史无线 ADB 链路与现行特权传输

> 本文前半记录已退役的无线 ADB 配对实现，供排查旧设备状态与历史故障；它不是当前授权或执行流程。
> 当前桥协议见 [BRIDGE-API.md](BRIDGE-API.md)，模块位置见 [modules.md](modules.md)。

## 当前实现

- Shizuku 是壳侧特权 shell 的正式传输。`ShizukuTransport` 通过 Shizuku UserService 执行系统命令；用户在 Shizuku 管理器授权，壳侧读取授权状态并按需绑定服务。
- 引擎兼容接口仍叫 `execAdbShell` / `execAdbLine`，但命令由 `ControlCarrier`、`ShellOps` 和 Shizuku 执行，不会启动内嵌 ADB server，也不会通过无线调试配对。
- 无障碍操作走 `ControlPoller` 与 `DeviceControlService`。它与 Shizuku 特权面分开授权；需要完全权限会话的门禁、通道选择和屏幕范围检查见 [BRIDGE-API.md](BRIDGE-API.md)。
- Android 13+ 受限设置解锁由 `MainActivity.unlockRestrictedSettingsViaShizuku()` 执行 `appops`。`DeviceControlService` 的无障碍截图仅支持 API 30+；API 较低时该操作返回不支持。模型工具 `android_screenshot` 会在 Shizuku 特权 shell 可用时回落执行截图命令。
- 历史无线 ADB 配对状态与本地偏好不是 Shizuku 授权真源。升级后遇到旧入口或旧设置状态，应以当前设置页的 Shizuku 状态和源码为准。

## 历史无线 ADB 实现（已退役）

旧版本曾提供内嵌 ADB server，通过无线调试配对端口和连接端口执行 shell。旧策略要求三个门同时打开：完全访问、应用内允许开关、真实无线配对；权限档位还要求 `danger-full-access`。配对流程曾包含预热、server 探活、NSD/mDNS 发现和手动端口输入。

这些机制及下表中的问题编号只解释历史版本，不应用于诊断当前 Shizuku 链路：

| 历史症状 | 当时原因与修复记录 |
|---|---|
| 配对时报 protocol fault | 冷启动 fork-server 握手问题；见 gotchas 24 |
| 配对窗口关闭后连接被拒 | 配对端口仅在系统弹窗存活期间监听；见 gotchas 25 |
| NSD 或属性端口发现失败 | 不同 ROM 对系统属性的访问限制；见 gotchas 26 |
| 工具输出 `[object Object]` | 旧 ADB 插件返回结构化输出未提取文本；见 gotchas 28 |
| 旧设备转发探活异常 | `adb forward` 状态失效；见 gotchas 32 |

`AdbState.kt`、`adb pair`、ADB server 预热与无线调试端口发现都不是当前壳侧特权执行的说明入口。更新本文件时，先核对 `ShizukuTransport`、`ControlCarrier`、`ShellOps` 与 `DeviceControlService`。
