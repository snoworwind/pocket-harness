# 构建阶段拆分与增量复用（2026-11-11）

> 本文保留主线旧链的分阶段设计与测量；`codex/linux-runtime-experiment` 已直接装配 Linux 四件套，不调用本文的 Termux/快照流程。当前执行契约见 [Linux CI](LINUX-CI.md)。

来源链目前是一条单体 `build-apk-source.yml`：Termux 输入 → 引擎 source build → Termux base → Linux assets → source snapshot → inject-all → 门禁 → Gradle → 验签/签名。实测（run 42950780693，arm64 primary）：

| 阶段 | 实测耗时 | 现状 |
|---|---|---|
| 门禁 + inject-all（含 xz 解压/重压缩） | ~10 分钟（inject 6.9） | 无缓存；`DSH_INJECT_PRESET` 可调 |
| Gradle assembleRelease + 单元测试 | ~3 分钟 | Gradle 缓存已接 |
| Harness source build | 9.8 分钟 | engine base 缓存存在，但 `base-lock` 随 `contract.json` 失效 |
| Termux base 组装 | 6.4 分钟 | 无缓存 |
| source snapshot 构建 | 5.5 分钟 | 无缓存 |
| Linux ARM64 assets | 5.5 分钟 | 缓存已接，但 save 因 rootfs 属主失败 |

## 目标拓扑：按内容哈希的独立阶段

每个阶段 = 一个可独立触发/复用的构建单元，输出「tar/zip + manifest」，key = 输入内容哈希：

1. **engine-base**（已有 `build-base.yml`）：Harness commit + overlay + patches → `base-engine-<key>.tar.zst`；内容键缓存 + manifest 自证（`base-lock.json` 已不再消费）。
2. **termux-base**：bootstrap pin + preinstall + node-pty 构建输入 → `base-usr-<abi>.tar.xz` + provenance。
3. **linux-assets**（已有 `build-linux-assets.yml` 雏形）：linux-inputs + 脚本哈希 → `assets/provenance/native-libs`。
4. **source-snapshot**：termux-base + engine-base + snapshot-config/patches → `snapshot.tar.xz`。
5. **injected-snapshot**：source-snapshot + 插件源码/补丁/profile patch → `snap-final2.tar.xz`。
6. **apk**：injected-snapshot + 壳侧源码 + native `.so` → APK；发布时仍须独立副本比对 + 生产签名。

最终构建 CI 只下载 key 命中的产物；未命中才触发对应阶段。发布链保留「双副本独立重建 + 比对 + 生产签名」，不因拆分而降到单副本。

## 已落地（本轮）

- engine base：内容键自动构建 + 自证复用（#293）；稳定缓存命中即跳过 Harness 源码构建，`base-lock.json` 不再参与消费链。
- pnpm store：key 改为工具链 + replica，避免 contract 变更误伤、避免双副本抢同一 cache key。
- Linux assets：缓存改为 `assets/provenance/native-libs`，不再打包 root-owned `rootfs`，修复 save 失败；`Restore` 已移到 apt 之前（#313），命中时真正跳过 apt/keyring。
- injected snapshot：以 `源快照 sha256 + 插件/补丁/profile patch/构建脚本 输入哈希` 为 key 缓存 `snap-final2.tar.xz`；命中时 `build-apk.mjs` 跳过 inject-all，仍对所有门禁跑在缓存快照上。key 不绑定 APK project commit（下游校验绑定的是 Harness source manifest）。
- Linux assets：key 为 pinned 输入哈希（不绑定 project commit）；命中后 `attest-linux-cache.mjs` 校验 release manifest/摘要与 provenance 输入逐字节一致，再把 `project-source-commit.txt` 改写为当前 commit，并写 `reused-from-commit.txt` + `reuse-attestation.json`。
- `fast` 输入：inject `lzma preset=1`、Termux base `xz -6`（开发档，产物内容一致、体积略大）。
- 可靠性：apt update/install 有界重试（#310/#311）；发布草稿标题从 APK 文件名生成 `Pocket Harness vX.Y.Z (ARM64 + x86_64)`（#314）。

## 待办

- termux-base / source-snapshot 的独立缓存或独立 workflow。
- 把上述阶段拆成独立 workflow（`workflow_call` + artifact），最终 APK 作业按 key 拉取。
- 发布链保持双副本 + 生产签名；dev 链路允许单副本 + 生产签名（当前 `reference=true` 才能签）。
