# R3 审计修复账本（2026-10-24）

> 发现清单见 [SECURITY-AUDIT-2026-10-24-R3.md](SECURITY-AUDIT-2026-10-24-R3.md)；坑位 512-537。本文件是修复状态的唯一真源：每项落地后在此登记 PR、验证证据与边界；未登记 = 未修复。

## 修复计划（分批 PR，按铁律 3 原子交付）

| 批 | 内容 | 项 | 风险档 | 验证要求 |
|---|---|---|---|---|
| PR-1 | 通知决策队列完整性绑定（R3-01） | 壳侧 L2 | Kotlin 单测 + 伪造/篡改/无签三方反证 | |
| PR-2 | 壳侧凭据出口与传输小加固（R3-02/03/04/14/15/16/17/18/19/29/30） | 壳侧 L2/L3 | Kotlin 单测（可测项）+ 静态门禁 | |
| PR-3 | 门禁判据批（R3-06/07/08/21/22/23/31/32/34） | L1 门禁自身 | 各脚本 --self-test + 受控负控（铁律 2 L1 档） | |
| PR-4 | 插件面批（R3-24/26）+ R3-09 记账 | 插件 L2 | 插件 npm test + lib 同步 | |
| PR-5 | 子仓批（R3-27/28） | L1/L3 | 各子仓测试 | |
| PR-6 | 清理与 CI 批（R3-11/35/36/37） | L1 | 静态门禁 + 负控 | |
| PR-7 | 构建链批（R3-05/11/12/20/33） | L1 供应链 | 来源链自检/负控 | |
| 延后 | Gradle dependency verification（C1-F3）、浏览器 LAN 警示（R3-13 缓解面） | — | 需网络/设计评审，独立 PR | |

每批合入前：`node scripts/ci/local-gate.mjs` 本地自查（CI 亦自动跑）。涉及壳侧 Kotlin 的批次属高风险面即时验档，**当前无在线 ARM64 设备：三层验收缺失，PR 描述显式标注「未做设备验证」**，进入发版候选前必须补验。

## 待续（本会话未闭，原因与前置如实登记）

| 项 | 前置 / 原因 |
|---|---|
| R3-05（坑 516）overlay 每包 sha512 pin | 需 registry 访问逐包取 integrity 并生成 pin（约 100 包），pin 生成脚本 + 门禁改造独立 PR |
| R3-09（坑 520）linux_bash 档位门 | 需引擎会话信封的跨插件改造（见已完成段计划） |
| R3-12（坑 523）corepack 走离镜像 | 改动来源链取件路径，需来源链全链复验支撑 |
| R3-20（坑 531）快照构建器索引字段消毒 | 复用 safe_termux_package_filename 判据，改动 build-snapshot-013.mjs 后需来源链自检 |
| R3-25（坑 536）undo 导出随机 salt | 加密格式 v2 变更需兼容 v1 导入的迁移设计与测试 |
| R3-33（坑 537）NDK SHA-256 pin | 需取得 Google 官方 SHA-256（本会话未联网核对） |
| Gradle dependency verification（C1-F3） | 需网络生成 verification-metadata.xml，独立 PR |

## 已完成

## 复审二轮（2026-10-24 深夜，对当日全部合入 `git diff 8c99c00..5ce2613` 的三路独立复审；坑 544-548）

- **坑 544（P2）**：canonical 裸 `|` 拼接可被字段重切——合法签名行在字段值含 `|` 时可构造出 canonical 字节相同的另一条 Decision。已升 v2 长度前缀（切分唯一）；v1 行 fail-closed 丢弃（未发布无存量）。反证：两 Decision v1 同串/v2 不同 + 含竖线往返精确。
- **坑 545（P2）**：sign 只对 `keystoreKey()==null` 回退——「在场但失效」的 Keystore 密钥（master-key 回滚）让 init/doFinal 抛异常穿出，enqueue 返回 false 且 NotifyActionReceiver 不检查：决策静默丢失。已改 signWithFallback（主密钥任何签名失败都落临时密钥）。JVM 直测注意：算法名不匹配的 SecretKeySpec 在 SunJCE 下照常 init（首版负控假阴性），必须用 null 编码 Key 构造必抛路径。
- **坑 546（P2）**：安全模式剪贴板 prompt 的 logTail 只过 EngineAuth.redact（令牌一类），比日文件出口（全七类）双标——Authorization/sk-/环境变量/PEM 可随尾巴进系统剪贴板。已统一过 LogSanitizer.sanitizeOrNull，脱敏失败不附带尾巴（可见说明，不冒充「未取到」）。SafeModeTest 四形态反证。
- **坑 547（P2）**：坑 542 的行尾注释剥离 `\s#.*$` 不匹配 CRLF 行尾（`$` 不带 m 只匹配串尾、`.` 不跨 `\r`）——Git for Windows autocrlf 检出上伪接线判绿复活。已先归一 `\r\n` 再剥。负控三态：LF 行尾 FAIL / CRLF 行尾 FAIL（旧实现必绿）/ 恢复全绿。已知误报（fail-closed 方向）：引号字符串内的 ` #` 也会被剥，登记坑位防后人反向放松。
- **坑 548（P2+P3 批）**：pr-gate 两道 grep 扫描 `if grep` 把 exit>1（路径缺席等出错）当「无命中」放行——「路径被删 + 真钥在场」实测放行（账本原声称「无 fail-open 风险」过强）；已改三态退出码判定。同批：sk-/xai- 加左边界（`task-management-infrastructure` 类假红）、测试排除从整类通配收窄为具名夹具（SafeModeTest 因坑 546 新夹具入列）、冲突标记扩展名补 .py/.sh/.txt/.patch/.svg、manifest allowlist 改包相对路径键控（子包 PathOpen.kt 不得白嫖）+ 读失败按红处理。四组本机验证 + manifest 负控（临时子包调用方 exit 1）。
- **小项**：VdisplayController 上限判据统一 `size >= MAX`（消除 isNotEmpty 早退 + 永不可达上限分支的死结构）；LinuxAssetIO urlVerdict/hopVerdict 拒 userInfo（坑 527 复审，与坑 541 authority 纪律同源）；桥 live 正文摘要掩码（坑 535 复审，与 tool_call 同口径）；LogSanitizer 分块注释订正（掩码顺序与「中间内容保留」原注释写反，坑 540 复审）；pr-gate 与 pr-gate-workflow.test 的「私有仓/休眠」过时注释更正为公开仓 + 哨兵现实。
- 复审同时确认无缺陷的点：bridge maskDeep 的 stringify 前递归掩码与幂等、shell-termux WeakMap 键迁移（execute 以 resolve 返回值为键 + 无键防御回退）、host-web-compat 两处函数替换（smoke 全过）、BrowserBody 恢复地址三元链、gotchas 544 前编号连续、被删 build-snapshot-arm64 无活引用、待续项对应的文件（build-snapshot-013 / 来源链 / undo-savepoint / build-apk-source.yml）当日确实零改动（无账实漂移）。
- 验证：`:app:testDebugUnitTest` 全量 1372 例 0 失败；bridge `npm test` 172/172；check-release-gates / check-api-route-auth / check-gate-skips / check-kotlin-comments / check-code-map / check-manifest-hardening / pr-gate-workflow.test 全绿；本机 local-gate 因宿主条件不可整跑（坑 335 族，CI 为权威）。**未做设备验证**（决策队列与剪贴板为壳侧行为面，进发版候选前须补三层）。

## 复审轮（2026-10-24 晚，对 R3 全部合入改动 `git diff 8c99c00..6f4552e` 的独立复查；坑 540-543）

- **坑 540**：坑 514 的 PEM 截断补口只堵了 BEGIN 方向——readEngineLog 按 MAX_ENGINE_CHUNK 切块时「后半段先到」的 chunk（只有材料后半 + END、无 BEGIN）密钥材料裸露进共享存储日文件。已补 ORPHAN_END 分支（从文本开头掩到 END），+尾方向与双方向叠加两组 JVM 反证。
- **坑 541**：坑 528 的 Console 来源锁定只钉 scheme+path，`file://<任意host>/android_asset/console.html` 放行（与主 WebView isEngineOrigin 的 authority 纪律不对称）。已补 `host 为空 && userInfo 为 null`。**未做设备验证**（防御纵深收紧，合法初始 loadUrl 不经该回调；进发版候选前须补三层）。
- **坑 542**：坑 517 的 yml 接线断言剥了整行注释，行尾内联注释（`run: x # check-y.mjs`）仍可伪接线。已改 `check-release-gates.mjs` 先剥 `\s#.*$` 再滤整行；受控负控三形态验证，改后门禁全绿。
- **坑 543**：账本文件带着三段合并冲突标记合入 main（4efd96a 手工合并只 union 了 gotchas 537 一侧），且 pr-gate 冲突检查面只有代码文件——docs/scripts/md/mjs 全部不在扫描面，此后 5 个 PR 全绿放行。账本已按 union 语义解决（两侧条目保留、计划表去重），pr-gate 冲突检查面扩至 `app/src scripts .github docs` × 14 扩展名；正反双控验证。
- 复审同时确认无缺陷的点：NotifyDecisionQueue 压缩路径经 serialize 重签、MuxClient 分片总量上限、EngineTransport 常时比较、LinuxAssetIO 443 钉死、ShellOps timeoutMs coerce、maskCredentialShapes 规则序与幂等、shell-termux fence 重盖的 WeakMap 键同步、BrowserBody 三元链、auto-approve 确认门无残留调用方、被删 build-snapshot-arm64 无残留接线、pr-gate 新增扫描路径（release/final-acceptance/webpages/notes.md）全部在 git 内（grep 无 fail-open 风险）。

## 自审轮（2026-10-24，对本轮全部修复的复核；发现于 `git diff 8c99c00..HEAD` 逐文件复查）

- **自审批 A（Kotlin）**：坑 512 补口——ProductionIntegrity 落实临时密钥回退（原实现 Keystore 不可用时 sign 抛异常，Keystore 故障设备上通知决策全部无法落盘；现回退进程内 SecureRandom，verify 双钥匙都接受，+JVM 直测）；坑 514 补口——LogSanitizer 处理分块边界截断 PEM 头（BEGIN 无 END 时掩到文本末尾，+单测）；坑 528 补口——ConsoleActivity 导航锁改路径比对（不误杀页内锚点）；坑 529 补口——session 形态门放宽为可打印 ASCII（原白名单对上游 id 格式无依据）；脱敏失败计数原子化。
- **自审批 B（脚本）**：auto-approve.mjs 全文恢复（加确认门时被截断为头+首行且两道验证全绿——坑 538）；check-engine-overlay 引号按平台分流（win32 保留双引号，POSIX 用 shellQuote，argv 端到端合成用例 EXACT——坑 539）。
- 自审同时复核确认无缺陷的点：maskCredentialShapes 最终形态（Bearer/KV 字符串替换保引号）、Vdisplay 锁内 status 可重入、BrowserBody 改动经 757 例回归、门禁批负控均复跑通过。

- **PR-6（R3-11/35/36/37）清理与 CI 批**：遗留 build-snapshot-arm64.mjs 删除（EXECUTION-MAP 摘行，code-map 通过）；pr-gate 敏感信息扫描扩模式族与目录面（测试文件排除——脱敏器单测必须内置字面假键）；gate-sentinel 恒跑 job（PR_GATE_MODE != on 即红）；check-manifest-hardening 加 FileProvider 调用方 allowlist（负控：移出即 FAIL）。

- **PR-5（R3-27 + R3-28）子仓批**：shell-termux 的 resolve 在 spec 层重盖 fence 三键（父类合并序 dshEnv 最晚，受信通道可顶掉标签；返回新对象并同步 WeakMap 键），`node --test` 4/4；host-web-compat 两处注入改函数替换（消除 `$&` 替换语义整类风险），`smoke-injections` 全过。
- **PR-4（R3-24 + R3-26）凭据出口掩码与浏览器恢复地址复验**：bridge 插件 `maskCredentialShapes`（stringify 前递归掩码，实测纠正转义后掩码破坏 JSON 的缺陷），audit.ndjson 与 .live.ndjson 双出口收口，插件套件 172/172；BrowserBody 外部打开对恢复地址同过 parseBrowserAddress，UI 全量 757/757，lib 构建通过（lib 为构建期产物，不入树）。
- **R3-09（坑 520）记账为下一批**：linux_bash 正确接线需要引擎会话信封的跨插件改造（runtime 由 bootstrap 独立装配、tool args 不携带会话；仓促上门比登记缺口更糟）。计划：runtime 工具 execute 注入与 android 家族同源的档位门（复用 sandboxPolicy.resolve），并纳入 capability-gate 掩蔽组。
- **PR-3（R3-06/07/08/21/22/23/31/32/34；坑 517/518/519/532/533/534 + 537 三子项）门禁判据批**：workflow 接线断言可执行行判定（负控：注释 11 条 run 行后 FAIL、恢复后 PASS）；动态 kind 路由 fail-closed 计为候选 + self-test 反例；esbuild sha512 必需；STRICT 传播全白名单断言；snapshot-server 绑 127.0.0.1；shellQuote/argv 消除三处 shell 内插；patch-test-manifest stale 方向纯函数 + 正反证；tool-name-promises 扫描面边界如实登记；auto-approve 显式确认门。各门禁 --self-test 与全跑通过。**本机 local-gate.mjs 因宿主条件（bash 3.2 / node 20 / bsdtar）不可整跑，属坑 335 族环境限制；CI 为权威跑点。**
- **PR-1（R3-01，坑 512）通知决策队列完整性绑定**：serialize 每行 HMAC-SHA256（canonical 定序串；密钥 Android Keystore 非导出，不可用回退进程内临时密钥），parse 对缺签/验签失败/形状不符 fail-closed 丢弃。反证五组（无签/空 mac/篡改 outcome·state·eventId/异钥/非 hex）+ 往返全过；`:app:testDebugUnitTest` 全量 1364 例 0 失败；check-kotlin-comments / check-code-map 通过。**未做设备验证**；升级时旧无签行一次性丢弃（引擎侧审批超时、用户重新作答）。
- **文档（R3 全部）**：发现清单 + 修复账本 + 坑位 512-537（PR #116 已合入）。
