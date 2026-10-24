# 安全审计 2026-10-24（第三轮，全仓逐行）

> 基线：main `8c99c00`。审计方式：8 个分区块独立逐行审查（壳侧桥面/引擎快照/特权入口/设备控制四组 Kotlin + 构建链/门禁两组脚本 + 插件 vendor + UI 子仓 + CI/清单配置面），全部发现经第二轮调用链复核；关键项（R3-01/02/03/04/05/07/09/10/11）由主审逐行复核源码确认。坑位登记 512-537。
> 证据边界：全部为静态审查 + JVM 单测级反证（修复项除外）。**未做设备验证、未构建 APK**。本文件不构成「已发现全部漏洞」或候选可发布的结论。
> 修复状态以 [SECURITY-REMEDIATION-2026-10-24-R3.md](SECURITY-REMEDIATION-2026-10-24-R3.md) 为准。

## 威胁模型与对照

本轮把「模型运行时（引擎 Node/Termux bash，同 app UID，无路径级沙箱）被提示注入驱动」作为一等攻击者，与坑 376/503 的既有口径一致。同 UID 原生代码攻击者（可读全部应用文件、可用 Keystore）不在静态修复的边界内——对该档位整个应用无私密可言，只能靠进程边界之外的手段。

## 发现清单

严重级：critical（未发现）/ high / medium / low / info。编号 R3-NN，坑位号见括号。

### High

**R3-01（坑 512）审批决策耐久队列可被同 UID 运行时伪造「用户已批准」**
- 位置：`app/src/main/java/com/snoworwind/pocketharness/NotifyDecisionQueue.kt:132-146`（parse 只验 requestId 非空）、`:189`（文件在 `filesDir/notify-decisions.ndjson`，引擎 home 在 `filesDir/home`，同 UID 可写）、`:297-354`（flush 把 outcomeJson 原样投递给引擎 `$events/result`）。
- 攻击链：提示注入 → 模型 bash 追加一行伪造 pending 决策（eventId 是它自己发出的待审批请求，必然可知）→ 重启自身网关使壳侧 NotifyBridge 掉线重连（ready 帧 flush 触发点，NotifyBridge.kt:226）→ 伪造 `allowed-once` 被投递 → 引擎认为用户已批准 → 执行原需人工审批的工具。
- 根因：决策文件按「投递耐久性」设计，未按「授权数据」对待，违反 ScreenScope.kt:53 的既有纪律（「不得从同 UID 可写文件恢复授权」）；坑 376 修复了 prefs 三键，本文件是同族残留面。
- 修复方向：HMAC-SHA256 完整性绑定（Android Keystore 非导出密钥；JVM 测试注入）；parse/load 对缺签或验签失败的行 fail-closed 丢弃。升级时旧无签行一次性丢弃（决策丢失表现为引擎侧审批超时，fail-closed 方向）。

### Medium

**R3-02（坑 513）安全模式 prompt / 401 兜底把未脱敏日志尾巴（含引擎启动令牌）写入系统剪贴板**
- 位置：`GuidePageRenderer.kt:489-512`、`MainActivity.kt:1461-1468`、`SafeMode.kt:558-569/685-708`。`readFailureContext`/`readEngineLogTail` 原文返回；`buildSafeModePrompt` 逐字拼入；`copyToClipboard` 直写剪贴板。engine.log 含 `dsh web: ...?token=`（EngineAuth.kt:51），违反 #184「令牌行不得进入外发文本」纪律；该纪律只覆盖了 copyGuideLog/tailEngineLog 两条出口。
- 修复：`buildSafeModePrompt` 内对 logTail 统一 `EngineAuth.redact`（单一咽喉，覆盖全部现存与未来调用方）+ 单测反证。

**R3-03（坑 514）调试日志日文件出口只脱敏令牌、不过 LogSanitizer；同一内容两个出口双标**
- 位置：`LogCollector.kt:1025-1034`（appendToDayFile 仅 EngineAuth.redact → `Documents/dshdata/log/dsh-<date>.log` 共享存储）；对照 `LogShare.kt:181-229`（打包出口全条目 LogSanitizer fail-closed）。用户在对话中粘贴的 `sk-` 密钥/Cookie/PEM 以明文沉淀在共享存储，持存储权限的应用可离线收割。`setDevLogEnabled` 无特权确认门。
- 修复：appendToDayFile 复用 `LogSanitizer.sanitizeOrNull`（脱敏失败按既有纪律丢条并计数）；setDevLogEnabled 维持普通偏好（数据面脱敏后降级成立），登记残余。

**R3-04（坑 515）VdisplayController.create 资源上限 TOCTOU：并发双线程可突破 MAX_VIRTUAL_DISPLAYS=1**
- 位置：`VdisplayController.kt:364`（锁外快照）→ `:366`（Shizuku binder 往返拉大窗口）→ `:385` 锁内创建块不重查。三条真实并发入口：控制队列线程、WebView JavaBridge 线程（MainActivity.kt:1340）、binder 线程（DeviceControlService.kt:669）。后果是特权资源上限被绕过（非范围绕过）。
- 修复：把「查空 + 创建」合并进同一 `synchronized(lock)` 临界区，锁内重查。

**R3-05（坑 516）引擎 overlay 第三方闭包：sha512 取自与字节同信道的实时 registry 元数据，本地缓存命中免复核**
- 位置：`scripts/build-snapshot-013.mjs:218-239`（缓存命中零校验；`dist.sha512` 可缺席；sha 来自同一 fetch 的元数据）。实测约 100 个第三方包（commander/got/undici/openai/@anthropic-ai/sdk/@modelcontextprotocol/* 等）走此路径进引擎树，无门禁绑定到已评审字节；同链 deb（签名）、pnpm/canvas（npmIntegrity pin + 缓存命中复验）都设防，overlay 是残余未设防面。
- 修复：给 overlay 登记表补每包 sha512 pin（`PREINSTALL.npmIntegrity` 同款），下载与缓存命中两条路都 `verifyPinnedNpm`，`dist.sha512` 缺席即拒；解包后校验 package.json name/version。

**R3-06（坑 517）门禁接线断言是子串匹配：注释里留门禁名即可让 CI 接线面假绿**
- 位置：`scripts/check-release-gates.mjs:311/499/306`（`text.includes(gateName)`）；`check-gate-skips.mjs:78`（executionSites 只覆盖两条构建链，不审 workflow 文件）。实测 `pr-gate.yml:125` 注释含门禁名与 `:132` 真实调用并存——把 run 行删掉、名字留注释，两条门禁全绿，CI 从此不跑该门禁。
- 修复：`executionSites()` 扩展到 POSITIONS 中 kind=gate-names 的 workflow 文件（可执行行级断言），补负控自检。

**R3-07（坑 518）check-api-route-auth 只认字面量 `kind`，动态 kind 注册可整体逃逸路由清单**
- 位置：`scripts/check-api-route-auth.mjs:70-78`（`kindMatch === null → continue`）、`:198-220`（unlistedSources/字面量反向断言只遍历 discovered）。恶意 PR 加一条 `kind: COND ? 'exact' : 'prefix'` 的无鉴权 mobile-owned 路由，门禁全绿随版本出货；与文件头「cannot hide a route」自述矛盾。self-test 无动态 kind 反例。
- 修复：有 `path:` 但缺 kind 字面量的 `register({...})` 也计为候选（fail-closed 允许误报红）+ 动态 kind 反例进 self-test。

**R3-08（坑 519）check-browser-syntax-floor 的 esbuild sha512 校验是条件性的，且镜像清单仓内可控**
- 位置：`scripts/check-browser-syntax-floor.mjs:185-200`（`dist.sha512` 缺席时不校验直接解包并在门禁进程执行）、`:144-147`（镜像优先读仓内 `preinstall.json` 的 npmMirrors）。镜像被劫持 + 省略 sha512 → 恶意二进制在构建链每台机器执行。
- 修复：sha512 缺席即 die（与 `lib/pinned-npm.mjs` 同纪律）；镜像清单变更走门禁评审。

**R3-09（坑 520）linux_bash 工具无会话档位门，且不受渐进披露掩蔽**
- 位置：`vendor/dsh-linux-runtime/lib/index.js:56-112/126-168`（execute 直连 manager.execute，无 gateFor/sandboxPolicy.resolve）；对照 `plugins/dsh-android-bridge/src/index.ts:501-505`（TIER_REQUIRED_OPS）与 capability-gate.ts 三个掩蔽组。read-only 会话的模型可借 linux_bash 旁路 android_shell_exec 的档位门，直接读写应用私有目录（PRoot guest 即 app UID）。
- 修复：registerLinuxBash 注入与 android 家族同源的档位门；纳入掩蔽组需用户 `android_capabilities` 显式解锁。

**R3-10（坑 521）兼容模式（shared fallback）未安装 ServiceWorkerClient，SW 上下文请求绕过回环拦截策略**
- 位置：`BrowserSharedFallback.kt:31-35`（只配 CookieManager）；对照 `BrowserHostProfile.kt:101-119`（隔离 profile 装 SW client）。兼容模式 WebView 里站点注册 SW 后，SW 内 fetch 可直达回环（含非 3080 端口）。既有防线（引擎 cookie SameSite + /api browser-trust fence）压制了对引擎面的实际收益；残余面是非 /api 端点与回环其他本地服务。类注释「Loopback is still denied」对 SW 上下文不成立。
- 修复：兼容模式激活时为 Default profile 装窄门 SW client（仅放行 `127.0.0.1:3080` 精确 origin）；或至少在面板文案如实声明。倾向前者。

**R3-11（坑 522）遗留脚本 build-snapshot-arm64.mjs：零校验下载 + 索引名未消毒即拼 shell 串与文件路径**
- 位置：`scripts/build-snapshot-arm64.mjs:44-58/70/75`。全仓 grep 确认不被来源链/workflow/门禁调用（唯一引用 EXECUTION-MAP.md），但保留在树内且名字暗示正式性；一旦执行：恶意 index 可注入开发机 shell、写出工作区外、零完整性判据。
- 修复：按 build-apk-013.ps1 同口径退役（删除或头部禁用声明 + EXECUTION-MAP 摘除）。

**R3-12（坑 523）`--npm-mirror` 把 corepack/pnpm 执行体也交给镜像；文件头「镜像不改字节」声明只对依赖 tarball 成立**
- 位置：`scripts/source-build/run-local-source-chain.mjs:278-305`（三个 registry 变量含 COREPACK_NPM_REGISTRY）；`build-engine.sh:67-88`（corepack 拉 pnpm 的 integrity 来自同一镜像）。opt-in 面（CI 不设），恶意镜像可投递恶意 pnpm → 构建机 RCE。
- 修复：corepack 通道不走镜像（不导出该变量）或预下载钉 integrity 的 pnpm；帮助文本如实声明残余。

**R3-13（坑 524）隔离浏览器允许 LAN 私有地址导航，literal-host 策略不防 DNS rebinding**（已登记为设计取舍，本轮补纵深）
- 位置：`BrowserHostNavigationPolicy.kt:200-211`（注释自认取舍）。用户批准的域名可被 DNS 解析到 RFC1918 内网地址，模型经 browser_snapshot 读内网内容。
- 处置：登记为已接受取舍 + 缓解（设置开关或回执警示），不在本轮强改准入语义（避免破坏移动端内网调试的真实需求）。

### Low（修复清单内）

- **R3-14（坑 525）** relay 准入令牌非常量时间比较（`EngineTransport.kt:37-43`）→ `MessageDigest.isEqual`。loopback 时序侧信道理论面，修复成本一行。
- **R3-15（坑 526）** MuxClient 分片消息无总量上限（`MuxClient.kt:153-185` continuation 无界追加）；ControlPoller 错误体整读（`:212` readText 后才 take(200)）——违反 ProcIo「一切子进程/对端输出必须有界」纪律，失控引擎可 OOM 壳进程。
- **R3-16（坑 527）** LinuxAssetIO 来源白名单未钉端口（`LinuxAssetIO.kt:91-120`），`https://github.com:8443/...` 可过；TLS 主机名校验使其现实不可达，纵深补齐。
- **R3-17（坑 528）** ConsoleActivity 特权 consoleBridge WebView 无导航来源锁定（`ConsoleActivity.kt:104-112`）；当前无触发路径，属回归面。
- **R3-18（坑 529）** MainActivity `dsh.notify.session` extra 无形态校验（`:604-638`），第三方应用可拉起触发同一路由；影响可忽略，加白名单。
- **R3-19（坑 530）** ShellOps/RootAccess 的 timeoutMs 无上界钳制（`ShellOps.kt:139-143/156`），模型可占用特权 shell 通道。
- **R3-20（坑 531）** build-snapshot-013.mjs 对 Termux 索引字段不消毒（`:524/553/566-576`）：包名直入文件路径与 shell 串、altlink 路径可 `../` 逃出 stage。来源链内有验签 webroot 前置，纵深补齐（复用 `safe_termux_package_filename` 判据）。
- **R3-21（坑 532）** check-mcp-client-deps 严格档 `--require` 未被聚合入口传播（`check-release-gates.mjs:620` 白名单缺它），与 gate-skips-declared.json 申报理由漂移。
- **R3-22（坑 533）** snapshot-server.mjs 无鉴权监听 0.0.0.0:8899（`:26`）→ 绑 127.0.0.1。
- **R3-23（坑 534）** 三处 `sh()/execSync` 字符串内插 CLI 路径可 shell 注入（`check-third-party.mjs:147/196`、`check-engine-overlay.mjs:230`、`pi-catalog-diff.mjs:66`）——本地自伤面，统一改 argv 形态。
- **R3-24（坑 535）** 桥审计与 .live.ndjson 记录完整 args.command，模型命令内联凭据明文落本机文件（`plugins/dsh-android-bridge/src/index.ts:148-162/1833`）——写入前按已知凭据形状掩码。
- **R3-25（坑 536）** undo-savepoint 导出加密固定 salt（`vendor/dsh-undo-savepoint/lib/core.mjs:2805-2825`）→ 随机 per-file salt + 格式版本字段。
- **R3-26（坑 537）** 浏览器「外部打开」对持久化恢复地址跳过协议白名单复验（`dsh-client-ui-responsive/src/client/mobile/upstream-browser/view/BrowserBody.tsx:59,73,99-101`）——恢复路径同样过 parseBrowserAddress。
- **R3-27** shell-termux fence 环境防线漏 `dshEnv` 通道（`dsh-shell-termux/src/index.ts:141-150/200`；父类合并序 dshEnv 最后）——受信调用方才能到达，属「自包含环境」声明与实现不符；resolve 后对 spec.dshEnv 的 FENCE 键重盖。
- **R3-28** host-web-compat 字符串替换注入遇 `$&`/`` $` `` 等序列会被替换语义静默改写（`lib/index.js:1118-1120/960`）——当前模板无此序列，改函数替换一次性消除整类。
- **R3-29** AdbKeyboardService 类注释描述的「当前输入法校验」不存在（`AdbKeyboardService.kt:22-26` vs 实现 `:113-121`）——按 §5 当场改文档。
- **R3-30** SafeMode.newId 用 java.util.Random（`SafeMode.kt:548-550`）——id 不承担安全职能，换 SecureRandom 对齐仓内随机源纪律。
- **R3-31** check-patch-test-manifest 白名单缺 stale 方向校验（`:104` 只单向）。
- **R3-32** check-tool-name-promises 扫描面与自述不符（只扫 plugins/*/src，`:63-84`）。
- **R3-33** NDK 以 SHA-1 钉定（`build-apk-source.yml:496-505`、`linux-inputs.json`）——换官方 SHA-256。
- **R3-34** auto-approve.mjs 无条件自动批准全部审批请求、无确认 gate（footgun，非门禁假绿）——文件头警示 + 显式 env 确认。
- **R3-35** pr-gate 敏感信息扫描模式窄（4 族正则、不扫 release/final-acceptance/notes.md/webpages）——扩充模式族与目录。
- **R3-36** 托管 PR Gate 可被单个仓库变量整体休眠且 skipped job 满足 required checks——加恒跑哨兵 job。
- **R3-37** FileProvider `external_shared` 映射整个外部存储根（`file_paths.xml:17`）——加门禁断言「生成该映射 URI 的调用方只有 PathOpen.openChooser」。

### 已接受 / 已登记不修（本轮）

| 项 | 处置 |
|---|---|
| NSC 全域放行明文（network_security_config.xml:44） | 0.14.1 块 K 用户拍板、注释留痕，维持（审计独立确认过决策链） |
| 引擎令牌经 URL 查询串注入主 WebView（MainActivity.kt:367） | cookie 不可用时的降级路径；loopback 内、token 本在 engine.log；登记残余 |
| PathOpen/FileProvider 选择器面覆盖外部存储 | 0.13.7 有意设计（用户介导），加警示文案属后续 |
| release 不开 R8/资源裁剪 | 公开仓定位，逆向面非本轮威胁；登记 |
| 下载页第三方反代镜像 | sha256 从官方源注入且页面可核对；确认 UI 呈现即可 |
| Gradle 依赖无 verification-metadata/locking | 修复清单内但需网络生成元数据，独立 PR（B-6），本轮登记 |
| marketplace 安装遥测（vendor minified lib） | 默认开、可关（DSHM_NO_TELEMETRY）；vendor 产物非本仓源码面，登记 |
| check-snapshot-secrets 白名单制（home/.dsh/credentials 无点变体不命中） | 设计口径，登记纵深 |
| SKIP 机制残留（未打印 SKIP 计 0、申报表无 stale） | 机制级，本轮未发现现行利用实例，登记 |
| 来源链「校验后重开」TOCTOU 模式（5 处） | 隔离工作区 + 单用户 runner 下非现实攻击面，登记加固建议 |
| UndoGate 之外的 vdDestroy 档位面（R3-09 之外的 vdCreate/vdDestroy 不在 TIER_REQUIRED_OPS） | 与 R3-09 一并处置 |
| P1 浏览器 LAN 内网 + DNS rebinding | R3-13 已列 |

## 与既有账目的关系

- 坑 376/377（屏幕范围与敏感桥写授权）修复完好——本轮核实无模型侧写口残留；R3-01 是同族**不同数据面**。
- 坑 380/382/384/340（市场审批、下载上限、nonce、模型凭据出口）修复完好——逐项复核无残留。
- 坑 339/336（来源链宿主写入、组件来源）现状稳固（10 写根 + A11 续跑摘要 + 独立 git 目录判据）。
- R2 审计 385（快照 payload 字节绑定）仍未闭，本轮不重复登记。
- 坑 390/391/392（前端注入层）修复残留核查通过。
