# Pocket Harness v0.14.11

> 2026-11-09 按远端事实修正：本版已于 2026-11-04 作为正式 ARM64 发布（versionCode 55），不再只是版本号候选。原文「没有构建或发布」的记录已过时——来源构建、签名与 Release 均已完成。

## 发布信息

- 提交 `eee974d91589f3957468e01b7b906a05dad97da9`；来源 run [41798463258](https://github.com/snoworwind/pocket-harness/actions/runs/41798463258) 完成 primary/reference 双构建、APK 校验、独立签名与来源证明。
- Release [`hardening-source-eee974d91589-41798463258-1`](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-eee974d91589-41798463258-1)，已公开（非草稿、非预发布）。
- APK：`pocket-harness-v0.14.11-source-arm64.apk`，SHA-256 `46765c6100dc0648ced49f23d038029b254dc5124538320b2d58980ea93b426e`。
- 引擎保持 DeepSeek Harness `0.2.1-rc.5`；来源构建把 Linux PRoot 精确固定至 5.1.107.102，版本不匹配时失败关闭。

## 升级关系

- 后继版本 0.14.12（引擎升级到 `0.2.2-rc.1`）的 Release 对象已于 2026-11-09 因缺陷删除，source tag 保留。
- 因此从本版直接覆盖升级到 0.15.0 时，会同时获得 `0.2.1-rc.5` → `0.2.2-rc.1` 的引擎升级。
