# 项目基线与未迁移标识

## 来源

- 仓库：`snoworwind/dsh-mobile-apk`
- 分支：`security/hardening`
- 提交：`cb1c3152b62664626dd2409e970e4e01e37ad621`（2026-10-18 02:14:09 +0800）
- 说明：本仓首个提交以该提交的源码树为基线；移除了旧 LFS 底座指针与社区/赞助二维码，调整仓库级名称/坐标/维护分支，并重封一项 vendor-only 夹具 capture 元数据。其余 Android 运行时代码和插件在首个提交未改；来源链分支校验、相关测试及站点文档有少量仓库迁移改动，故不是逐字节完整快照。

## 第一个提交改了什么

只改仓库级标识与一处夹具 capture 元数据，不改变应用行为或构建产物：

- README / README.en / README.zh 的项目名、来源说明、issue 入口、构建命令与社区入口。
- `AGENTS.md`、`docs/AGENTS/SECURITY-HARDENING.md`、`docs/AGENTS/build-and-env.md`、`docs/RELEASE.md` 中的仓库坐标与维护分支（`main`）。
- `CODEOWNERS`、`settings.gradle.kts` 的 `rootProject.name`。
- 下载页 `release.js` 的默认仓库坐标；页面内容与产物名未改，且首个提交暂停了 push 自动部署。
- 来源草稿入口的分支校验：`refs/heads/security/hardening` → `refs/heads/main`。
- 补丁夹具 `manifest.capture.registrySha256` 重封：基线前 registry 已加入 vendor-only 补丁，engine 夹具字节未变；理由见 [known-gaps.md](known-gaps.md) 对应行。

## 应用身份迁移

独立身份已实现，旧 DeepCode 保持并行安装；不会自动复制旧应用数据。此基线记录形成时，来源 APK 构建与设备验收仍待完成。后续 Pocket Harness v0.14.9 已完成来源构建并正式发布；当前完整设备三层验收仍未完成，见[版本说明](../../release/v0.14.9/notes.md)。

| 标识 | 当前值 | 迁移说明 |
|---|---|---|
| `applicationId` | `com.snoworwind.pocketharness` | 独立安装身份；与旧 `com.dsharnessmobile.shell` 并排安装，不覆盖升级、不自动迁移数据 |
| Kotlin `namespace` | `com.snoworwind.pocketharness` | 2026-10-19 按用户决定统一迁移类、AIDL 与源码目录；升级和验证边界见 [迁移记录](NAMESPACE-MIGRATION-2026-10-19.md) |
| 应用显示名 | `Pocket Harness`（无障碍服务名、控制台标题同源） | `UserCopy.APP_NAME`、`strings.xml`、控制台标题、管理页已同步；v0.14.9 已在 Android 16 ARM64 host-GPU AVD 完成覆盖安装与启动烟测，完整三层验收仍未完成；MuMu x86_64 不能安装 ARM64 产品 APK，详见[版本说明](../../release/v0.14.9/notes.md) |
| APK 产物前缀 | `pocket-harness-v<版本>-arm64.apk` | 发布链、下载页、来源 artifact 与 Python 发布准备已统一为 ARM64 独立命名 |
| 发布签名 | `POCKET_SIGNING_KEYSTORE_BASE64` 与 `POCKET_SIGNING_KEYSTORE_PASSWORD` 仓库 Secret | 私钥不入库；发布 APK 校验提交的证书 SHA-256 指纹 |
| Gradle 子仓目录名 | `dsh-mobile-apk/` 兼容探测 | 多个门禁同时支持「协调仓布局」与「自包含布局」；改名要逐项回归，否则门禁会找不到树 |
| 历史文档中的旧 URL | 旧仓库、旧 Actions run、旧 PR | 属于事实记录与来源证据，按安全加固宗旨不得改写成新项目事实 |

## 其他边界

- 旧 LFS 底座 `base/*.tar.xz` 未导入：它们只是指针文件，来源链明确不读取；新仓不启用 LFS，避免留下无法解析的 LFS 指针。
- `LICENSE` 为 MIT，**双版权**：原项目 `kelai141/dsh-mobile-apk`（版权人 `kelai141`）与本仓 `snoworwind/pocket-harness`（版权人 `snoworwind`）。本项目是原项目的修改版，原版权声明保留，修改部分以同一 MIT 条款发布；2026-10-20 经项目所有者确认后写入。
- 子仓 `package.json` 的 `repository` 字段是上游归属信息，不是本仓的运行时坐标，未改。

## 后续验证与边界

Gradle 子仓目录名仍保持历史兼容探测；此前下列项目不再是待迁移项：

- 设备验收：来源链 ARM64 构建 + Kotlin 单测 + 模拟器三层验收（竖屏与横屏）+ 发布前真机补充门禁。
- Gradle 目录名：逐项跑布局相关门禁，确认自包含布局与协调仓兼容探测都不回退。

本文记录基线导入与独立身份迁移边界，不构成「永不改名」的承诺。
