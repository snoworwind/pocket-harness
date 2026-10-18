# 交付政策与历史发布约定

> 当前 `main` 只允许来源链构建，允许手动来源构建后自动创建预发布草稿；现行政策见 §5，构建入口见 [构建详档](AGENTS/build-and-env.md)。§1、§3、§4 为旧协调仓流程存档，禁止作为本仓操作指南。

---

## 1. 历史仓库职责划分（已退役）

| 仓库 | 维护内容 | 产物 |
|---|---|---|
| dsh-shell-termux/ | 源码 + package.json + 基线 | lib/（tsc 输出）、*.tgz |
| dsh-client-ui-responsive/ | 源码 + 构建配置 | lib/、*.tgz |
| dsh-host-web-compat/ | 源码（lib/index.js 即源码） | lib/、*.tgz |
| dsh-mobile-apk/ | Gradle/Kotlin 源码 + 资源 | build/、snapshot/（快照输入，按 ABI 命名） |
| 主仓库（总控） | docs/ + scripts/ + release/（发布产物唯一出口） | release/v<版本>/... |

## 2. 版本号管理（单一事实源）

| 项 | 规则 |
|---|---|
| 主版本 | 以 app/build.gradle.kts 的 versionName / versionCode 为准 |
| release tag | 来源草稿使用独立 hardening-source 标签，见 §5 |
| 插件版本 | 以各 package.json 为准，独立演进（tgz 文件名带插件版本） |
| 归档 | 已发布版本移入 release/archive/ |

## 3. 历史 release/ 目录规范（已退役）

    release/
    ├── v<版本>/apk/pocket-harness-v<版本>-arm64.apk   # 当前独立发行只提供 ARM64
    ├── v<版本>/snapshot/snapshot-<abi>.tar.xz         # 双快照（在线更新/重打包用）
    ├── v<版本>/plugins/*.tgz                          # 3 插件
    ├── v<版本>/MANIFEST.txt                           # sha256 清单
    ├── v<版本>/notes.md                               # 发布说明 + 各 ABI 验证记录
    └── archive/                                       # 历史版本

## 4. 历史一键构建（本分支禁止）

    powershell -File scripts/build-release.ps1 -Version 0.10.2

门禁：双快照 ELF 架构断言 + npm 层断言 + 快照内插件 hash 与发布 tgz 一致性 + check-snapshot-secrets（凭据/会话/sourcemap）+ MANIFEST 生成。

快照输入：dsh-mobile-apk/snapshot/snapshot-<abi>.tar.xz（设备侧 make-snapshot.sh 产出后按 ABI 命名放入；打快照前必须先部署最新插件，否则一致性门禁中止）。

## 5. 来源链预发布草稿（2026-10-17 按用户决定）

本仓允许手动触发来源构建，成功后自动创建 **draft + prerelease**；不会自动公开，不恢复旧 LFS 发布链。

```bash
gh workflow run build-apk.yml --repo snoworwind/pocket-harness --ref main -f draft_release=true
```

也可运行 `release-source-draft.yml`。工作流只接受 `main`，复用同提交 `build-apk-source.yml`：

1. 只读构建任务执行原有来源链及全部测试、产物门禁。
2. 只读准备任务仅下载同次运行 artifact，核对必需证据、来源仓库、提交与 APK 哈希，原字节复制 APK 并压缩证据。
3. 独立 `contents: write` 任务只下载整理后的同次 artifact、复核哈希并创建草稿；不检出源码、不编译、不重签。

草稿资产为 ARM64 APK、`provenance.zip`、`SHA256SUMS.txt` 与 `notes.md`。tag 为 `hardening-source-<短提交>-<run_id>-<run_attempt>`，避免与主线版本及重跑冲突；不覆盖已有 Release。APK 由仓库加密 Secret 中的独立发布密钥签名，最终门禁核对提交的证书 SHA-256 指纹。自动生成的说明明确标为未做设备验证；公开发布由维护者验收后手动完成。

构建或证据核验失败不进入写权限任务。上传失败可能留下部分资产的草稿，不得直接公开；检查该次失败记录后重跑，新 attempt 创建独立草稿。来源证明支撑链路追溯，不等于 APK 字节可复现或设备已验收。

## 6. 来源链产物命名

APK 由 `scripts/build-apk.mjs` 按 `pocket-harness-v<versionName><suffix>-arm64.apk` 命名。当前来源工作流固定 `--abi arm64 --suffix -source`；下载入口与证据清单见 [构建详档](AGENTS/build-and-env.md)。

## 7. 第三方许可合规声明（2026-08-23 起，GPL 义务）

快照运行时预装 Termux 软件包（dpkg 清单见快照 `usr/var/lib/dpkg/status`，标准文本副本与清单见仓库根 `LICENSES/` 与 `THIRD_PARTY_NOTICES.md`，并随 APK 打包在 `assets/licenses/`）。

- **许可证全文随包分发**：每个包 `usr/share/doc/<pkg>/copyright`（或 COPYING*），标准文本统一位于 `usr/share/LICENSES/*.txt`（Termux `licenses` 包，构建链已显式锁定——实测 x86_64 缺省闭包曾漏带，`build-snapshot-013.mjs` TARGETS 已固化 `licenses`）；
- **源码要约（GPL §3）**：各 copyleft 组件对应源码与构建脚本见 [termux/termux-packages](https://github.com/termux/termux-packages)（版本标签对应，详见 THIRD_PARTY_NOTICES.md 的组件/版本/许可表）；要约自本发行发布起三年内有效；
- **对二进制的再加工**（A4，全部随本仓库开源）：前缀/编译期路径重写 `scripts/fix-shebang.py`、`scripts/inject-snapshot.py`、`termux-elf-cleaner` 调用与 `scripts/build-snapshot-013.mjs`（shebang/RUNPATH/elf 处理）、快照注入与打包 `scripts/inject-all.py`、`scripts/build-apk.mjs` 及 `scripts/patches/`；
- **门禁**：`scripts/check-third-party.mjs`（矩阵覆盖 + copyleft 全文在场）由来源链的 APK 打包门禁执行，缺失即拒绝打包；
- **无额外限制**：上述二进制保持其上游许可，未施加任何附加条款；本工程 dsh 引擎/壳/插件（MIT 系）与 GPL 二进制为进程级聚合，非链接派生，不受传染（详 THIRD_PARTY_NOTICES.md 说明）。
