# 项目基线与未迁移标识

## 来源

- 仓库：`snoworwind/dsh-mobile-apk`
- 分支：`security/hardening`
- 提交：`cb1c3152b62664626dd2409e970e4e01e37ad621`（2026-10-18 02:14:09 +0800）
- 说明：本仓第一个提交是该提交的完整快照，运行时代码、Android 资源、插件、脚本逻辑、测试与快照内容均未改动。

## 第一个提交改了什么

只改仓库级标识与一处夹具 capture 元数据，不改变应用行为或构建产物：

- README / README.en / README.zh 的项目名、来源说明、issue 入口、构建命令与社区入口。
- `AGENTS.md`、`docs/AGENTS/SECURITY-HARDENING.md`、`docs/AGENTS/build-and-env.md`、`docs/RELEASE.md` 中的仓库坐标与维护分支（`main`）。
- `CODEOWNERS`、`settings.gradle.kts` 的 `rootProject.name`。
- 下载页 `release.js` 的默认仓库坐标；页面内容与产物名未改，且首个提交暂停了 push 自动部署。
- 来源草稿入口的分支校验：`refs/heads/security/hardening` → `refs/heads/main`。
- 补丁夹具 `manifest.capture.registrySha256` 重封：基线前 registry 已加入 vendor-only 补丁，engine 夹具字节未变；理由见 [known-gaps.md](known-gaps.md) 对应行。

## 刻意未改的应用/产物标识

以下标识仍沿用基线值。它们会改变安装身份、用户可见文案或发布产物，必须单独提交并完成仓库规定的验证；本轮环境没有 Android SDK 与 adb，无法完成编译、打包与设备三层验收。

| 标识 | 基线值 | 为什么不在首个提交改 |
|---|---|---|
| `applicationId` / `namespace` | `com.dsharnessmobile.shell` | 改变安装身份、签名与升级路径；旧包无法覆盖升级，需重签名并做设备验收 |
| 应用显示名 | `DeepCode`（无障碍服务名 `DeepCode 设备控制`、控制台标题同源） | L3 UI 文案；`UserCopy.APP_NAME` 与单测、`strings.xml`、控制台标题需同步，且必须模拟器三层验收 |
| APK 产物前缀 | `dsh-mobile-apk-v<版本>-<abi>.apk` | 与发布链、站点资产名、`SHA256SUMS` / `MANIFEST`、Python 发布准备与 CI artifact 名绑定，改名需同步全部门禁 |
| Gradle 子仓目录名 | `dsh-mobile-apk/` 兼容探测 | 多个门禁同时支持「协调仓布局」与「自包含布局」；改名要逐项回归，否则门禁会找不到树 |
| 历史文档中的旧 URL | 旧仓库、旧 Actions run、旧 PR | 属于事实记录与来源证据，按安全加固宗旨不得改写成新项目事实 |

## 其他边界

- 旧 LFS 底座 `base/*.tar.xz` 未导入：它们只是指针文件，来源链明确不读取；新仓不启用 LFS，避免留下无法解析的 LFS 指针。
- `LICENSE` 保留原版权声明。新增修改者的版权行、仓库公开范围与许可证策略需由项目所有者确认后另行提交。
- 子仓 `package.json` 的 `repository` 字段是上游归属信息，不是本仓的运行时坐标，未改。

## 迁移这些标识时

每一项按独立 PR 处理，并携带对应档位的证据：

- 应用名 / applicationId：来源链构建 + Kotlin 单测 + 模拟器三层验收（竖屏与横屏）+ 真机补充门禁。
- APK 产物前缀：同步发布链、站点、校验清单与测试，跑 `check-release-gates.mjs` 与相关 Node 测试。
- Gradle 目录名：逐项跑布局相关门禁，确认自包含布局与协调仓兼容探测都不回退。

本文记录首个提交的边界，不构成「永不改名」的承诺。
