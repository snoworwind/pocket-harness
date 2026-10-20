# Pocket Harness 0.14.8 草稿候选说明

本版本将引擎升级到 DeepSeek Harness 0.2.1-rc.2，带来上游新增模型与网页搜索设置能力，并适配 Android 插件、子代理会话和 PTC 运行环境。

本候选包含 Linux 设置服务 bootstrap 激活修复：使用宿主提供的 Linux 数据目录配置，避免读取未声明的 Cordis `ctx.filesDir`。该修复让状态服务能够激活，不代表 Debian/glibc 执行通路已验证。

## 获取与安装

- 本候选仅提供 ARM64 APK：`pocket-harness-v0.14.8-source-arm64.apk`。仅在 ARM64 Android 设备上安装；可使用 Android 包安装器，或执行 `adb install -r -t pocket-harness-v0.14.8-source-arm64.apk`。
- 当前 Release 为 Draft + prerelease，尚未公开。草稿标签：`hardening-source-f37eaafe887c-39424480383-1`。

## 来源与验证

- 源码提交：[`f37eaafe887c49503471d22173daadbb3e5b9e3a`](https://github.com/snoworwind/pocket-harness/commit/f37eaafe887c49503471d22173daadbb3e5b9e3a)
- 来源构建：[Actions run 39424480383](https://github.com/snoworwind/pocket-harness/actions/runs/39424480383)
- 两个独立 ARM64 来源构建及 APK payload 规范化比较通过；完整 Kotlin 单测通过；最终 APK 在隔离签名任务中使用仓库固定的 Pocket Harness 发布证书完成签名验证。
- 下载资产 SHA-256 清单通过；`provenance.zip` 中的独立重建证明绑定到上述源码提交和最终 APK。APK SHA-256：`a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`。

## 验收限制

Device validation has NOT been performed for this candidate. 华为 Mate 80 Pro Max 上提供的失败日志来自修复前 APK；修复后候选尚未在 ARM64 真机安装、升级或完成代码层、CDP 层和 ADB 用户实际体验层验收。不得将本候选视为设备验收通过；公开发布前必须补齐设备验收。glibc 执行路径仍需独立验证。
