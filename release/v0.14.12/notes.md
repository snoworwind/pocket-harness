# Pocket Harness v0.14.12 版本候选说明

Pocket Harness 将 DeepSeek Harness 引擎升级到官方 `0.2.2-rc.1`，固定源码提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。本版本保留原生工具执行；PTC 执行器仍关闭。Android 显式恢复文件观察策略，`web_fetch` 保持可用。上游 rc.1 不再默认拒绝私网目标；Android 没有按工具隔离的网络出口过滤，因此启用该工具后可能访问私网地址。

## 安装与升级

- 应用版本：0.14.12（versionCode 56），目标产物为 ARM64 Android APK。
- 必须由合入 `main` 的源码通过发布草稿来源链构建；本地 APK 不作为发布产物。
- main 来源 run [42206049909](https://github.com/snoworwind/pocket-harness/actions/runs/42206049909) 已完成 ARM64 双构建、签名、证明包和草稿创建；APK SHA-256 为 `34666b901fb2490b31bec50b9f8d08cc001ce7f8f6818d765b1d16e4c3fe646f`。该构建目标为合并提交 `32a0be53d1b756cd7ac67651e69df383a24e5970`，草稿 tag `hardening-source-32a0be53d1b7-42206049909-1`。其 APK 在设备检查中发现问题，已安装但不作为发布候选；修复合并后必须重新跑来源链并更新记录。草稿保持未公开。

## 验证范围与限制

- 引擎与运行时覆盖资产在来源链中逐字节同源，`CHECK-RUNTIME-ASSETS` 组合 3、SKIP=0；旧草稿 APK 的签名和 APK 哈希已核验。
- Android 16 API 36 ARM64 host-GPU AVD 已覆盖安装并启动该 APK。CDP 39 项有 36 项通过；复核后 1 项属于探针误判，另 2 项暴露 drawer CSS specificity 与返回层重复计数缺陷。已在后续修复分支加入代码、断言和单测，定向回归通过；PR CI、修复后来源构建与设备复测待完成。
- **设备验收未完成**：新 APK 的 CDP、竖屏/横屏 ADB 操作尚未复验，ARM64 真机也不可用。旧草稿不发布；正式 Release 前须用修复后的最终 APK 完成适用设备验收，或明确记录未验收层、原因与风险。
