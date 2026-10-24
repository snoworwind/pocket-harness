# R3 审计修复账本（2026-10-24）

> 发现清单见 [SECURITY-AUDIT-2026-10-24-R3.md](SECURITY-AUDIT-2026-10-24-R3.md)；坑位 512-537。本文件是修复状态的唯一真源：每项落地后在此登记 PR、验证证据与边界；未登记 = 未修复。

## 修复计划（分批 PR，按铁律 3 原子交付）

| 批 | 内容 | 项 | 风险档 | 验证要求 |
|---|---|---|---|---|
| PR-1 | 通知决策队列完整性绑定（R3-01） | 壳侧 L2 | Kotlin 单测 + 伪造/篡改/无签三方反证 | |
| PR-2 | 壳侧凭据出口与传输小加固（R3-02/03/04/14/15/16/17/18/19/29/30） | 壳侧 L2/L3 | Kotlin 单测（可测项）+ 静态门禁 | |
| PR-3 | 门禁判据批（R3-06/07/08/21/22/23/31/32/34） | L1 门禁自身 | 各脚本 --self-test + 受控负控（铁律 2 L1 档） | |
| PR-4 | 插件/子仓批（R3-24/25/26）+ R3-09 记账 | 插件 L2 | 插件 npm test + lib 同步 | |
| PR-6 | 子仓批（R3-27/28） | L1/L3 | 各子仓测试 | |
| PR-7 | 构建链批（R3-05/11/12/20/33） | L1 供应链 | 来源链自检/负控 | |
| PR-8 | CI/配置批（R3-35/36/37） | L1 | 静态门禁 | |
| 延后 | Gradle dependency verification（C1-F3）、浏览器 LAN 警示（R3-13 缓解面） | — | 需网络/设计评审，独立 PR | |

每批合入前：`node scripts/ci/local-gate.mjs` 本地自查（CI 亦自动跑）。涉及壳侧 Kotlin 的批次属高风险面即时验档，**当前无在线 ARM64 设备：三层验收缺失，PR 描述显式标注「未做设备验证」**，进入发版候选前必须补验。

## 已完成

- **PR-4（R3-24 + R3-26）凭据出口掩码与浏览器恢复地址复验**：bridge 插件 `maskCredentialShapes`（stringify 前递归掩码，实测纠正转义后掩码破坏 JSON 的缺陷），audit.ndjson 与 .live.ndjson 双出口收口，插件套件 172/172；BrowserBody 外部打开对恢复地址同过 parseBrowserAddress，UI 全量 757/757，lib 构建通过（lib 为构建期产物，不入树）。
- **R3-09（坑 520）记账为下一批**：linux_bash 正确接线需要引擎会话信封的跨插件改造（runtime 由 bootstrap 独立装配、tool args 不携带会话；仓促上门比登记缺口更糟）。计划：runtime 工具 execute 注入与 android 家族同源的档位门（复用 sandboxPolicy.resolve），并纳入 capability-gate 掩蔽组。
- **PR-3（R3-06/07/08/21/22/23/31/32/34；坑 517/518/519/532/533/534 + 537 三子项）门禁判据批**：workflow 接线断言可执行行判定（负控：注释 11 条 run 行后 FAIL、恢复后 PASS）；动态 kind 路由 fail-closed 计为候选 + self-test 反例；esbuild sha512 必需；STRICT 传播全白名单断言；snapshot-server 绑 127.0.0.1；shellQuote/argv 消除三处 shell 内插；patch-test-manifest stale 方向纯函数 + 正反证；tool-name-promises 扫描面边界如实登记；auto-approve 显式确认门。各门禁 --self-test 与全跑通过。**本机 local-gate.mjs 因宿主条件（bash 3.2 / node 20 / bsdtar）不可整跑，属坑 335 族环境限制；CI 为权威跑点。**
- **PR-1（R3-01，坑 512）通知决策队列完整性绑定**：serialize 每行 HMAC-SHA256（canonical 定序串；密钥 Android Keystore 非导出，不可用回退进程内临时密钥），parse 对缺签/验签失败/形状不符 fail-closed 丢弃。反证五组（无签/空 mac/篡改 outcome·state·eventId/异钥/非 hex）+ 往返全过；`:app:testDebugUnitTest` 全量 1364 例 0 失败；check-kotlin-comments / check-code-map 通过。**未做设备验证**；升级时旧无签行一次性丢弃（引擎侧审批超时、用户重新作答）。
- **文档（R3 全部）**：发现清单 + 修复账本 + 坑位 512-537（PR #116 已合入）。
