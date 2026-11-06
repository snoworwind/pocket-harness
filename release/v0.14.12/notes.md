# Pocket Harness v0.14.12 版本候选说明

Pocket Harness 将 DeepSeek Harness 引擎升级到官方 `0.2.2-rc.1`，固定源码提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。本版本保留原生工具执行；PTC 执行器仍关闭。Android 显式恢复文件观察策略，`web_fetch` 保持可用。上游 rc.1 不再默认拒绝私网目标；Android 没有按工具隔离的网络出口过滤，因此启用该工具后可能访问私网地址。

## 安装与升级

- 应用版本：0.14.12（versionCode 56），目标产物为 ARM64 Android APK。
- 必须由合入 `main` 的源码通过发布草稿来源链构建；本地 APK 不作为发布产物。
- 来源双构建、签名、APK 哈希、证明包和 GitHub Release 草稿：待 CI 完成后补录。草稿保持未公开。

## 验证范围与限制

- PR 风险门禁与来源链 CI：待执行。
- 文件观察策略、Android 插件与 rc.1 运行时兼容性：待 CI 验证。
- **设备验收未完成**：CDP、ADB 用户操作、横屏、ARM64 真机和覆盖安装均未验证。草稿会明确标记未做设备验证；公开发布前仍须完成适用的设备验收。
