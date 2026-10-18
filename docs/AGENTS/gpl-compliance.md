# gpl-compliance.md — GPL 合规

## WSL 来源构建的 Termux 许可补齐（2026-10-15）

认证仓库的新闭包含 c-ares 1.34.8、libicu 78.3、nodejs-lts 24.18.0-1、resolv-conf 1.3。矩阵按包名补登记，许可分别为 MIT、Unicode-3.0 及 ICU 附带 notices、Node.js MIT 及捆绑第三方 notices、Public Domain；实际版本仍由快照 dpkg status 和来源 provenance 记录，不允许未知包自动通过。

c-ares 与 Node 全文从已认证包的 copyright 保留在 `LICENSES/c-ares.txt`、`LICENSES/Termux-Nodejs-LTS.txt`；resolv-conf 的维护方许可声明与配方来源写入 `LICENSES/Termux-resolv-conf.txt`。ICU 的认证 deb 内 `share/doc/libicu/LICENSE` 实为 `404: Not Found`：其配方把 `release-78.3` 错改成 `release-78-3` 取原文，不能把错误页视为许可。正确全文取自 [ICU release-78.3](https://raw.githubusercontent.com/unicode-org/icu/release-78.3/LICENSE)，以 `LICENSES/ICU-78.3.txt` 固化，SHA-256 为 `e55522d81edc687a341a4411e0776e54ca654e90147f354a90458aaced4116af`。本地候选的文档修复仅替换许可成员并记录输入/输出哈希，程序载荷不变；全文也随 APK assets/licenses 分发。根因与门禁证据见 [gotchas.md](gotchas.md) 坑 324；实际 APK 内文本与修复后的快照仍须最终核验。

## 7. GPL 合规（2026-08-23 定稿）

- 快照包：`usr/share/doc/<pkg>/copyright`（多数为软链 → `usr/share/LICENSES/<fam>.txt`）或 COPYING* 实体文件；`licenses` 包在 TARGETS 显式锁定（x86_64 曾漏带）。
- 仓库：`LICENSES/`（GPL-2.0/3.0、LGPL-2.1/3.0 全文）+ `THIRD_PARTY_NOTICES.md`（80 组件矩阵，含源码要约与再加工工具清单）+ `scripts/third-party-licenses.json` + `scripts/check-third-party.mjs`（矩阵覆盖 + copyleft 全文在场，三形态判定）；门禁接入 build-apk-013.ps1，缺失即拒打包。
- APK：`assets/licenses/`（LICENSES + notices，随包分发）。
- 声明文：`docs/RELEASE.md §7`（D 章合规声明 + 源码要约 + 修改工具）。
