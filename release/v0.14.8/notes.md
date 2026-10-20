# Pocket Harness 0.14.8 草稿候选说明

本版本将引擎升级到 DeepSeek Harness 0.2.1-rc.2，带来上游新增模型与网页搜索设置能力，并适配 Android 插件、子代理会话和 PTC 运行环境。

## 获取与安装

- 本候选仅提供 ARM64 APK：`pocket-harness-v0.14.8-source-arm64.apk`。仅在 ARM64 Android 设备上安装；可使用 Android 包安装器，或执行 `adb install -r -t pocket-harness-v0.14.8-source-arm64.apk`。
- 当前 Release 仍为 Draft + prerelease，尚未公开。

## 来源与验证

- 源码提交：[`9ebe0fc1589a070cb2ee12417f27d89236f7153a`](https://github.com/snoworwind/pocket-harness/commit/9ebe0fc1589a070cb2ee12417f27d89236f7153a)
- 来源构建：[Actions run 39374235296](https://github.com/snoworwind/pocket-harness/actions/runs/39374235296)
- 两个独立 ARM64 来源构建及 APK payload 规范化比较通过；完整 Kotlin 单测通过；最终 APK 在隔离签名任务中使用仓库固定的 Pocket Harness 发布证书完成签名验证。
- 下载资产 SHA-256 清单通过；`provenance.zip` 中的独立重建证明绑定到上述源码提交和最终 APK。APK SHA-256：`862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf`。

## 验收限制

Device validation has NOT been performed for this candidate. 尚未完成 ARM64 真机安装、升级以及代码层、CDP 层和 ADB 用户实际体验层验收；不得将本候选视为设备验收通过。公开发布前必须补齐设备验收。
