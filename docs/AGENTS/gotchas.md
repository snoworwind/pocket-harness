# gotchas.md — 关键实现细节与坑（全量）

324. **气泡导航代理必须跟随原生标签栏节点重建**：上游在活动 TabHost 下挂载 strip；同分栏切页会替换结构相同的原按钮。只比 outerHTML 会保留断连按钮闭包，导致全屏、收起和新标签无响应。代理缓存同时比较元素身份，并释放断连 strip 引用。长按后只抑制物理释放产生的标签点击，取消/失焦要清理；系统返回不能被吞，并须把焦点交还三点按钮。列表范围同时读取 visualViewport 与原生 IME inset；Android adjustNothing 下真实键盘出现时 visualViewport 仍可保持全高。真实设备复验入口：`scripts/verify-sidebar-bubbles.mjs`。

> grep 用法：`grep -n "<坑号>\." docs/AGENTS/gotchas.md` 或按关键词（如 `borrowSession`、`MANAGE_EXTERNAL_STORAGE`、`store-rehome`）定位。
> 维护约定：新坑追加到文末并递增编号；修复后保留条目（教训与历史归档）。

## 6. 关键实现细节与坑（每次踩坑必须登记）

1. **realpath 前缀混用（B7 运行时表现，已修）**：Android 上 `/data/user/0` 可能是 `/data/data` 的软链——只把「文件侧」realpath 后再与未 realpath 的 ws 比较必拒。修复：`safeResolveInside` **两侧都 realpath**（ws 侧失败按原样参与），symlink 目标按 `dirname(rel)` 解析（`../../LICENSES` 从 `doc/<pkg>/` 出发 = `share/LICENSES`）。**新路径校验代码一律双侧规范化。**
2. **会话 header meta 白名单**：`Session.create(meta)` 的 `origin` 只允许 `"subagent"`——自定义值报 `session header origin must be "subagent"`；只写白名单键（如 `cwd`）。
3. **surface 事件必须带 surfaceOp**：`user/message` 等 surface-eligible 事件 append 需第 3 参 `{surfaceOp:'append'}`，否则 `requires a surfaceOp marker`。
4. **pnpm 是市场安装的硬依赖（已固化进快照构建）**：`dsh plugin add` spawns `pnpm`（apps/cli plugin.ts）；快照缺 pnpm → `pnpm not found on PATH`；且**陈旧 pnpm 状态记录**（base-dsh 里的 `.modules.yaml`/`.pnpm-workspace-state`/`pnpm-lock`）指向旧 store → `ERR_PNPM_UNEXPECTED_STORE`——build-snapshot-013.mjs 已装配 pnpm 10.12.1 standalone（npm tgz + `usr/bin/pnpm` shim）并清理这三种记录。**市场目录里的部分插件（如 humanizer-ru）不在 npm，安装 404 属上游目录数据，不是本链路缺陷。**
5. **快照 node 需要 OPENSSL_CONF**：运行快照内 node 时务必与 UndoGate 同样注入（否则 OpenSSL config error 静默吞 CLI 输出）。
6. **Windows 侧读 WSL 9p 文件 = EACCES**：stage 文件不可直 stat/read；校验类代码走 `--tar`（wsl tar -tvf 带大小）视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤。
7. **npm registry 元数据可能缺 dist.sha512**：pnpm tgz 完整性校验「在场则严格，缺席降级警告」。
8. **run-as 引号地狱 / adb 二进制传输**：PowerShell 双引号内 `$var` 本地展开；二进制经 `adb exec-out`/push 传输。
9. **template 字符串反斜杠**（页面注入）：`\n` 双写。
10. **签名一致性**：debug.keystore 固定，否则覆盖安装失败。
11. **CDP 断言注意**：input placeholder 不在 innerText（查 `[placeholder]`）；「live 会话禁止 API prompt」；`session.list` 的 stats 字段（turns/llmMs）判断代理是否真跑。
12. **引擎级 OPENSSL_CONF 曾有缺口（2026-08-24 真机实锤，已修）**：快照 node 编译期硬编码 OpenSSL 配置路径 `/data/data/com.termux/files/usr/etc/tls/openssl.cnf`（app 域不可读）——`shellEnv()` 未注入 OPENSSL_CONF 时，**任何 node/npm 子进程（agent 工具调用）启动即 OpenSSL configuration error 退出**；引擎本体侥幸存活（不触发该初始化的路径）。修复 = `shellEnv()` 加 `OPENSSL_CONF=<usr>/etc/tls/openssl.cnf`（与 UndoGate/AdbState 统一；坑 #5 是本坑在 CLI 面的显式版）。
13. **apt/dpkg 编译期路径（issue #80，2026-08-24 重写）**：apt/apt-get/dpkg 二进制内置 `/data/data/com.termux/files/usr` 编译期路径。`-o Dir::Etc=...` 参数覆盖不了 apt.conf.d 早期扫描（仍报 Permission denied）；**有效方案 = APT_CONFIG 主文件**（build-snapshot-013.mjs 7d 段生成 `usr/etc/apt/apt.conf`，wrapper 统一 `export APT_CONFIG`）——注意 `K='...$B...'` 单引号不展开曾令 wrapper 失效。**dpkg 的 SYSCONFDIR（dpkg.cfg.d 配置目录）无 env 可覆盖**（strings 证实无 DPKG_CONFIG_DIR 变量；`--admindir/--instdir` 不覆盖）→ apt 在线安装 dpkg 阶段受限；`scripts/check-prefix-residue.sh` 设备端自检验证。
14. **配对伪成功防御（2026-08-24 真机实锤）**：`nativeBridge()?.setAdbPair?.()` 可选链在桥缺失/方法缺失时返回 undefined → `ok === false` 恒 false → 前端误报「配对完成」——**显式检查 `typeof b.setAdbPair === 'function'` 且无函数即 throw**。设置页两端口输入框是必经项，用户嫌手动抄录——0.13.0 起端口发现用 **NSD/mDNS**（AdbState.discoverPorts：系统属性直读优先 → `_adb-tls-pairing._tcp`/`_adb-tls-connect._tcp` NSD 发现（5s 超时）→ 手动输入硬回退；盲扫 37000-45999 已剔除，Q17）。
15. **临时工作区面板不可见（issue #60，2026-08-24 已修）**：workspace registry 只从**既有会话 cwd** bootstrap——无会话时「临时工作区」不出现在工作区面板。修复：dsh-android-file-open apply 时 `workspaceRegistry.create(tmpWorkspace(), '临时工作区')`（幂等复用）。TTL 清理（7 天）壳侧 FileIncoming.sweepExpired（启动 + 每次入队前）。
16. **老内核 ES2022 polyfill（issue apk#81/#79）**：华为/荣耀/小米定制 WebView（Chromium<92）缺 `Object.hasOwn`/`Array.at`/`String.at` → 前端加载插件报 "Failed to load plugins"。polyfill 注入点 = `assets/patched/web-frontend-index.html` `<head>` 首个 script 之前（引擎 applyAssetPatch 用它替换内核 index.html）；**升级 dsh 后其模块脚本哈希（index-ClqxG24t.js）须同步更新**。
17. **错位目录（issue #80 P5）**：relocate-snapshot 曾把包内绝对路径 `/data/data/com.termux` 当相对路径搬进 usr 树（`usr/data/data/...`）——纯冗余；构建链 7e 无条件删除 `usr/data`。
18. **debug APK 默认 x86_64 快照（2026-08-24 本日重大事故）**：`app/build.gradle.kts` mergeDebugAssets 注释写死「从 GitHub Releases 下载 snapshot-x86_64.tar.xz 放 assets」→ `app-debug.apk` 内快照是 x86_64；**装到 arm64 真机覆盖终版后引擎崩**：`error: "/data/data/.../usr/bin/node" is for EM_X86_64 (62) instead of EM_AARCH64 (183)`。核对方法：解快照 tar 读 `usr/bin/node` 的 ELF e_machine（62=x86_64，183=arm64），或 `aapt dump badging <apk>` 看 native-code。修复/预防：构建/安装前核对设备 ABI 与快照 ABI；换 arm64 快照须**同时替换** `assets/snapshot.tar.xz` + `snapshot.sha256`（指纹变→refreshSnapshot 全量重解压 2-4 分钟，勿中断）。
19. **cordis.patch.yml 装配缺陷**：基座 cordis.patch.yml 只含 shell-termux/host-web-compat/ui-responsive——0.13.0 新增的 android-bridge/android-manage/android-linux-env/android-file-open/undo-savepoint/marketplace **从不进入快照装配** → 引擎不加载这些插件（`/api/android/file-incoming` 404、ADB 设置项缺失、通知事件桥无宿主）。修复：build-snapshot-013.mjs 7b2 用 `scripts/profile-web.cordis.patch.yml` **权威覆盖**快照内同名文件（缺失即 `process.exit` 拒发）。**注意**：真机热改 cordis.patch.yml 后必须**冷启动 app**（`am force-stop` + start）才重装配——watchdog 热重启引擎不重读 profile（只重跑 node）。
20. **EngineService 挂载缺失**：startEngineService 只在 startEngineFlow 首次轮询成功时调用——**引擎先跑、app 后启动（热启动/恢复）时服务从未启动 → watchdog 缺失 → 通知消费（task-done 标记）/自动回退/唤醒锁全链路失效**。修复：MainActivity `onResume` 幂等 `startEngineService()`。
21. **通知链路三缺（2026-08-24 用户实测「任务完成没通知」根因）**：① 引擎事件桥缺失（前端 showNotification 桥无调用方，F0.3 部分实现=以前未做）——补：dsh-android-bridge 监听 `ctx.on('session/event')` 捕获 `assistant/message` → 写 `files/home/.dsh/.task-done.ndjson` 标记；② WatchdogV2.consumeTaskDoneMarkers 消费标记 → `NotifyCenter.notify`（deepProbe 成功路径顺带；JSON 解析失败会丢通知——务必确保标记是 `JSON.stringify` 合法 JSON）；③ EngineService 必须挂载（见坑 20）。验证：`files/notify-debug.log` 落盘每步（诊断时开）；通知 id=`("dsh-"+category).hashCode() and 0x7fffffff` 稳定正数。
22. **免 hooks 环境 ELF 不可执行**：`adb shell run-as ... /usr/bin/<bin> | head` 会报 `not executable: 64-bit ELF file` / `CANNOT LINK ... library libandroid-support.so not found`——因为 run-as 裸环境无 termux-exec LD_PRELOAD 钩子与 LD_LIBRARY_PATH。**验证快照内二进制必须带全套引擎 env**（`LD_PRELOAD=libtermux-exec-ld-preload.so` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`）。这是「run-as 测出假错误」的常见来源（如 node/npm/adb）。
23. **通知 debug 落盘**：WatchdogV2.consumeTaskDoneMarkers 写了 `files/notify-debug.log`（诊断用，**保留**——是排查通知链路的关键工具）。
24. **adb client 冷启动 server 必败（2026-08-27 真机实锤，已修）**：termux-exec/Linker64 重路由环境下，`adb pair` 首次调用自动起 server（fork-server）时握手坏——client 打印 "* daemon started successfully" 后读不到应答，报 `error: protocol fault (couldn't read status message)`，**配对必失败（用户侧观感"光速报错"）**。对照实验证明：client 直连**已存在**的 server（`adb server nodaemon` 常驻）时 pair/connect 全部正常（同码同端口复刻 2/2 成功）。修复 = AdbState 壳内自管常驻 server（runAdb 前 `ensureAdbServer`：spawn `server nodaemon` + 5037 探测 + 日志落 `files/home/adb-server.log`）+ `retryRunAdb`（protocol fault 时毁 server 重建重试一次）；pair 失败首行错误文本入审计（不含码）。另：discoverPorts 同步 NSD 等待 5s 会卡配对页 UI（bridge 同步调用链）——超时压到 2s + 启动后台预取 + 15s TTL 缓存（`cachedPorts`），bridge 缓存优先。**补锤**：app 域直接 exec app-data ELF 恒 EACCES（error=13，server/client 双双中招，审计 error 字段实锤），spawn 一律走 `spawnAdb`（捕获 Permission denied 降级 `/system/bin/linker64` 加载——EngineManager.startWithArgs 同机制）。
25. **配对码窗口被自家冷启动链耗光（2026-08-27 复盘实锤，三探针 logcat/audit/adb-server 时间线定案，已修 F1+F2+F3+F4）**：系统「使用配对码配对」弹窗的端口仅在弹窗存活期监听；用户点「配对」后壳侧才冷启动（linker64 加载 ~3s + 回收配对后密钥删除触发全新 RSA keygen + 首轮 client 握手竞态必吃 protocol fault 再自愈重建），合计 7 秒以上，拨号时窗口已关 → 恒 `Connection refused`（pairing_client.cpp），用户在系统弹窗上点什么都不救得回来。修复四件套 = **F1 常驻预热**（`AdbState.prewarm`：getAdbState 轮询钩子/onResume 后台线程拉起，60s 节流；**密钥生成移出关键路径**——回收配对会删 `$HOME/.android/adbkey*`，下次任何连接都会重新生成）+ **F2 真实就绪判定**（5037 bind ≠ 可服务：`ensureAdbServer` 放行条件收紧为一次真实 `devices` 客户端往返通过，`serverReady` 标志贯穿 spawn/复用孤儿/self-heal 三路径）+ **F3 结构化配对结果**（`setAdbPair` 返回 JSON `{ok, reason, message}` 替代 Boolean，壳侧 `classifyFailure` 归因 window-closed/protocol-fault/server-not-ready/handshake-timeout 等）+ **F4 前端分流**（AdbAuthSection 轮询不再抹操作报错——双通道 pollError/actionError 且后者留存 15s；失败不清空输入框；文案按 reason 分流，refused 明示「窗口已关闭请重开弹窗」而非误导性「核对 6 位码」）。
26. **vivo SELinux 拒读无线调试属性（2026-08-27 logcat 实锤）**：untrusted_app 读 `service.adb.tls.pairing_port` / `service.adb.tls.port` 触发 `avc denied { read } adbd_prop`——AdbState.discoverPorts 的「系统属性直读」优先路径在 vivo OriginOS 上恒失效（异常路径静默吞掉无感知），实际全靠 NSD/mDNS 兜底。勿据此属性在 vivo 上做正确性假设；后续若在此设备上看到直读成功属 ROM 变更，需回归。
27. **引擎侧页面误调 openNativePath（2026-08-27 记录在案）**：logcat 出现 `dsh-image: openNativePath: not exists: 自动扫描系统无线调试的配对/连接端口…`——引擎 UI 包把按钮 title 文案当路径传给了桥调用。壳侧安全拒绝 no-op 无实害；根因在上游引擎页面包（非本仓库管辖），升级引擎时留意。
28. **dsh-shell run() 返回 CollectedOutput 结构体（2026-08-27 活体插桩实锤，已修）**：`shellFace.run()` 契约返回 `{stdout:{text,truncated,spillPath?}, stderr:{…}, exitCode,…}` 而非字符串（引擎内置 bash 工具经 `streamText(output).text` 同款读取）。插件历史代码 `String(r.stdout)` 直取 → 恒 `"​[object Object]"`：**进程真实执行（审计恒 ok）、模型转录全毁**，并连带 device_info 满屏 `?` 占位（拿乱码 grep MODEL= 零匹配）与 lossless 拒收（可选字段 undefined 成员被引擎整值拒绝）。修复 = `collectText()` 解包 + `pickText()` 类型闸 render（非 string 一律 JSON 转写，杜绝 [object Object] 再入转录）+ 可选成员空串兜底。**伴生雷**：NSD 抓的连接端口随无线调试重启轮换（37575 失联实锤）→ `resolveLivePort()` 配置端口失效即回退 5555。**排障方法论沉淀**：①疑似「改码不改行为」先杀引擎进程再验——`force-stop` 后可能有孤儿 `node -`（linker64 链）幸存占 5037/3080 继续用旧模块（/proc 扫 cmdline 对照注入 mtime）；②设备端插件注入用 base64 分块 `printf %s >> ` 通道（MSYS /tmp 不跨执行块存活，stdin 管道会截断）；③插桩指纹（状态消息缀 ⟪标记⟫）一次往返即可判定加载版本。
29. **引擎会话档位为事件溯源、按会话隔离（2026-08-27 澄清，非缺陷）**：UI 档位选择器写入会话日志 `sandbox/mode` 事件（`effectiveSandboxMode` fold，最后一条生效），重启经重放恢复、两会话互不可见；`session.list` projections.permissions.currentValue 为真值。状态端点显示的 `writeMode=workspace-write` 仅部署默认（装配 yml shell-termux config），工具实际放行以会话档位为准（gateFor→sandboxPolicy.resolve）。勿把部署默认当死锁。
30. **ps1 双 ABI 循环后 assets 停留 x86_64（2026-08-29 实锤，坑 18 现代版）**：build-apk-013.ps1 循环内按 ABI 覆盖 `assets/snapshot.tar.xz`，循环结束留在 x86_64——此后直接 `gradlew assembleDebug` 的 debug 包即 x86 树，装 arm64 真机报 EM_X86_64（本轮已踩）。铁律：真机安装只用 ps1 对应 ABI 命名产物；存疑时 `od -A d -j 18 -N 2 -t u1` 读 node ELF 机器码（183=arm64/62=x86_64）。
31. **force-stop 杀不死 linker64 回退子进程（2026-08-29 vivo 实锤，0.14 修复）**：升级后旧引擎孤儿存活 → 双引擎抢 3080（探活打到旧引擎、新引擎 bind 失败循环；两代 engine.log 交错误导排障）。真机找引擎 `ps -A | grep linker64`（进程名非 node，pidof node 必空）；处置：run-as kill 全部 linker64 → 看门狗 ~7s 自愈。`pkill -f bin.js` 在 vivo 疑似不生效（坑 28 排障方法论①的 /proc cmdline 扫描为可靠手段）。
32. **adb forward 静默失效（2026-08-29 实锤）**：APK 重装/USB 重枚举后宿主 forward 清空 → 宿主探活 000，但设备内正常（用户 WebView 秒起）——「引擎挂了」的判断必须先 `adb forward --list` 再重 forward，否则误诊。
33. **系统 HTTP 代理劫持壳侧本地探针（#118 根因1，2026-09-02 实锤）**：WiFi 配置系统代理时，`HttpURLConnection.openConnection()` 默认走 `ProxySelector` 下发的系统代理 → 把 `127.0.0.1:3080` 的本地请求发给代理网关（回不来本机）→ 探针恒 timeout；而 WebView（Chromium 对 loopback 豁免代理）与 curl（不读系统代理）直连正常 → 「网页能开、app 却判引擎没起来」的矛盾现场。修复 = **壳侧所有本地引擎端口调用一律 `openConnection(Proxy.NO_PROXY)`**（EngineProbe / file-incoming / session.export / session.cancel；UpdateManager 的远程下载**不走** NO_PROXY），且诊断包 probe 字段区分 timeout/refused。
34. **UndoGate.runCli 直接 exec app-data ELF 无 linker64 fallback（#118 根因2，2026-09-02 修）**：`runCli` 直接 `ProcessBuilder` exec `usr/bin/node`（对比 `EngineManager.startWithArgs` 有 `/system/bin/linker64` fallback）——Android 15+ 拒绝直接 exec app-data ELF → error=13 → auto-undo 从未真正执行。修复 = 与 startWithArgs 同款：捕获「Permission denied」降级 `linker64` 加载（`build` 复用 shellEnv/OPENSSL_CONF/redirectErrorStream）。
35. **requestLegacyExternalStorage 对 targetSdk≥30 应用无效（#120/MT 调研，2026-09-02 实锤）**：该 flag 仅对「targetSdk≤29 + 运行在 Android 10」生效；targetSdk≥30（含 34）应用即使运行在 Android 10 设备上 flag 也被忽略（SO 63365334 / cgeo #10386 / 小米适配指南多源实锤）→ Android 10 上 SAF 树授权不解锁 FUSE 原始路径、bash 走不了 ContentResolver → 非 root 下「读用户任意目录作工作区」不可达成。落地：SDK 26-28（无分区存储）运行时 READ/WRITE 权限放行；SDK 29 保留拒绝但显式 reason（`__dsh_pick_refused__:android-10`）而非伪装取消；SDK 30+ 维持 All Files Access。
36. **自包含内置子仓副本必须与协调仓同版（2026-09-02 实锤）**：本仓库是**云端自包含构建宿主**（`.github/workflows/build-apk.yml` 依赖 `$GITHUB_WORKSPACE`=本仓库，不签协调私库），仓库内自带整套子仓副本（`dsh-shell-termux`、`dsh-client-ui-responsive`、`dsh-host-web-compat`、`plugins/dsh-android-*`）。**协调仓改动这些子仓的源码或 bump 版本后，必须把产物同步进本仓库对应子目录（src + package.json + lib/），否则自包含链（云端构建 + `gradlew assembleDebug` 直打）注入的是旧副本**——设备上表现「悬浮球开关消失 / ADB 面板缺失 / #120 拒绝信号缺席 / 配置导入导出按钮消失」这类**功能性缺失但编译通过**的幽灵缺陷。0.13.2 实测：协调仓 ui-responsive 0.1.11 含悬浮球开关、apk 仓副本 0.1.9 无它（DevSection 少了 W7 悬浮球开关行 + 配置导入导出块）；host-web-compat 0.1.8 vs 0.1.6（#120 拒绝信号缺席）。**教训：凡协调仓动了这三个独立子仓/bridge/manage，发布前必须比对两个仓库的 package.json version + 抽验 apk 仓副本 lib/client.js 关键字符串（如「悬浮球」），不一致即用 robocopy 从协调仓同步**（`robocopy "<协调仓子仓>" "<本仓\<同名子目录>" /E /XD .git node_modules /XF *.tgz`，lib/ 必须一并拷入——自包含链不对这些子仓执行 npm build）。
37. **快照刷新中途杀进程 → 看门狗拿半解压运行时拉引擎 → 用户 settings 被剪（2026-09-05 三重实锤）**：① refreshSnapshot 全量解压在模拟器实测 **~8 分钟**（44805 文件；流式逐文件覆盖——「bridge mtime 已新」≠ 完成，**唯一完成标志 = `.snapshot-fingerprint` 翻转新值 + `.dsh-backup` 消失**，中途抽验必误判）；② 解压中 force-stop → 无闸门的看门狗 5s 一拍用「半新半旧运行时」spawn 引擎（12:45:26 补丁日志实证）→ 混合态引擎的 settings 归一化把 `llm-pi-ai.providers`（**用户自定义供应商 Hy3/opencode-go 挂此**）剪成出厂空模板，且后续刷新备份忠实保留损坏结果；③ 恢复通道 = `undo-snapshots/auto/<最后好版本>/home-settings.yaml` 拷回 `.dsh/settings.yaml` + 重启（.credentials.yaml 的 apiKeyEnv 引用未受损）。**修复**：`EngineManager.snapshotRefreshing` companion 级 @Volatile 闸门（MainActivity/EngineService 各持实例字段互不可见，同 STARTING CAS 道理），刷新期 startEngine 直接跳过、finally 清标志。**升级/排障铁律：装新包触发重解压期间，禁 force-stop、禁拔 USB、禁 adb reboot（协调仓雷点 1 同源）。**

38. **rc.2 锁定型运行时补丁在引擎升级时抹掉新引擎代码（0.13.3 模拟器实锤，prompt 链阻断）**：assets/patched 的 session-persistence-jsonl/attachment-local 等是 0.1.1-rc.2 原版整文件（无 delta），0.1.2-rc.1 引擎启动前 applyRuntimePatches 整文件覆盖 → 新代码被旧版回退（persistence.borrowSession is not a function → 一切会话写入/发送全断）。**修复/约定**：升级引擎时逐补丁核对上游是否原生覆盖（能退役则退役——fs-local/primitives 已退役）；重出 asset 必须从新版本包文件改起（RUNTIME-PATCHES.md §3-2）；本次重出 SPJ/ATT 的最小 delta = link(2) 失败 EACCES/EPERM/ENOTSUP → rename 回退（grep "rebuild-runtime-patches" 见协调仓 .tmp-upgrade 备忘）。grep `borrowSession`。
39. **rc.1 loader module table 不再应答 client-runtime require（store-rehome 落地）**：上游把 store 引擎迁到 @deepseek-ai/dsh-client-store（web dist 内联 + Module table 命名空间），ui-responsive 构建预设的 RUNTIME_STORE_EXEMPTION（require("@deepseek-ai/dsh-client-runtime/client") external）在新 loader 上必炸——"missed the module table — build-time externals drift"，boot 即 Failed to load plugins。**修复**：源码 import 迁到 client-store；构建预设 CLIENT_EXTERNALS 移除豁免、INLINE_SAFE 加 client-store（内联，官方 ui-layout 同款）；ClientContext 类型改用 cordis Context；自备 slots-augment.d.ts（SlotMap root / GlobalStandardProps.useSessions / Context.slots-sessions 增强抄自 runtime rc.2 types）。grep `store-rehome`。
40. **npm arborist 对复杂 peer 树 + 精确 pin 会崩（spec undefined）**：ui-responsive 升 cordis 4.0.2 + client-store rc.1 后，npm install 带包参数崩（Cannot read properties of undefined (reading 'spec')）；且半装 node_modules 会让 "up to date" 谎报。**处置**：删 node_modules + package-lock 全新 install --legacy-peer-deps；peer cordis 从精确 4.0.1 放宽到 ^4.0.2；装完必须回读 node_modules/<pkg>/package.json 验证版本（npm "up to date" 不代表真装）。grep `legacy-peer-deps`。
41. **overlay 登记表漏项（primitives 缺席 rc.1 升级）**：engine-overlay.json 生成以 research 的 196 包清单为主循环——@deepseek-ai/dsh-client-ui-primitives 在旧树但不在清单 → 未覆盖留在 rc.2。**修复/约定**：登记表必须与基座树全量对账（.tmp-upgrade/audit-manifest.mjs：base-nm-paths 逐包 vs manifest ∪ keepUnpublished，未覆盖即查 npm）；发现 npm 有新版即补登记+拉 tgz。grep `audit-manifest`。
42. **run-as 的权限视图不代表引擎运行时**（Android 15 模拟器实测）：appops MANAGE_EXTERNAL_STORAGE allow 后 run-as cat /storage/emulated/0 仍 Permission denied（run-as/FUSE 评估差异）——引擎进程（同 uid 真实运行）实测可读（AI 轮 read 工具逐字读回）。验证权限问题必须走引擎运行时（会话轮/工具），不能只信 run-as。grep `run-as`。
43. **AppFrame 白屏静默挂起：create 循环 + rc.1 session-scope 严格绑定（0.13.3，两轮定位，已修）**：
（原以「坑 43 修复记录」附录形态追加，2026-09-12 归位为编号条目，正文未改。）

**第二轮定位（原「43 续」）：白屏静默挂起的真因与修复**：


首轮定位到「create 循环静默挂起」后，用 **Runtime.enable + dist 插桩**（设备侧 python 给 index-Df-65__b.js 的 boot await 链插 console.log）拿到完整时序：**50 个 entries 全部 created、r5-pluginboot-done、mount-effect、r6-mounted 全部触达——boot 管线本身是通的**。真因在 mount 后的 **React 渲染错误**：`Error: strict session slot 'details' rendered without a scope binding`（console error，0.13.2 时代无此强制）。

**根因**：rc.1 对 session-scope 槽（details 等）加了**严格 scope binding 强制**——session-scope 槽必须包在框架注入的 `<SessionProvider>` 里渲染（官方 ui-layout AppFrame 的写法：`jsx(SessionProvider, { children: renderSlot("details", {}) })`，SessionProvider 从 AppFrameProps 解构）。我们 rc.2 时代的 AppFrame 直接裸渲染 `renderSlot('details')` → 渲染期 throw → React 卸载整树 → root 空、且 React 渲染错误不进 Runtime.consoleAPICalled（error boundary 前抛出）→ **零 console 静默白屏**。

**修复**：AppFrame.tsx 三处——① 解构加 `SessionProvider`；② 桌面形态 `DetailsColumn` 内包 `<SessionProvider>{renderSlot('details')}</SessionProvider>`；③ 移动形态 bottom sheet 同款。conversation 是 session-maybe scope（无需 binding）；sidebar 是 root scope。

**定位方法论（可复用）**：
1. `Runtime.consoleAPICalled` 事件**必须先发 `Runtime.enable`** 才投递——没 enable 时「零 console」是探针假象（本坑第一轮误判「静默」的根因之一）。
2. 设备侧 python 给 minified bundle 插桩（boot await 链插 console.log）+ push + run-as（带全套引擎 env，坑 22）+ 重启引擎（内存中的旧 bundle 不会自动换）→ CDP reload 读日志——黑盒时序一步到位。
3. 服务器内存 serve：combo bundle 从 flush 时内存 responses 出（非磁盘直读），**改 dist 文件后必须重启引擎**才生效。

**验证**：SessionProvider 修复 + 第 6 次装机解压后——rootLen=411682、零 error、composer（contenteditable）在场、截图实证完整 UI（Hy3 选择器/会话历史/悬浮球全部在场）、session/create+list+prompt 新 wire 全 PASS。


44. **WSL 9p 挂载 chmod 无效 → 归档权限归一化只能在重打包层做（2026-09-08 实测）**：`/mnt/d` 是 9p 挂载且未启用 metadata，`chmod 600` 后 `stat` 仍 777、`tar -tvf` 记录 777（实测探针目录）。因此「归档前 chmod 整棵树」在 Windows 侧是**无效步骤**（白走 6 万文件），快照 tar 的权限只能靠**流式重打包**修正——唯一权威落点 = `scripts/inject-all.py`（重写每个成员：ELF/shebang=0700、数据文件=0600、目录=0700），门禁 `scripts/check-snapshot-file-modes.mjs` 校验注入后快照（= APK 内嵌 + 发布资产同源）。`build-snapshot-013.mjs` 8a3 步已删除并注明原因；`build-apk-013.ps1` 的 `-SkipInject` dev 档跳过该门禁（警告不拒打包）。grep `check-snapshot-file-modes`。

45. **快照含绝对符号链接（9 个 applet 指向 `files/usr/...`）→ 暂存解压必须放行 runtimeRoot 内的绝对目标（2026-09-08 实测）**：final 快照 1989 个符号链接中 554 个是绝对目标——545 个 Termux 残留（`/data/data/com.termux/...`，应拒）与 **9 个指向本应用运行时根**（`/data/user/0/com.dsharnessmobile.shell/files/usr/bin/{editor,ex,nc,pager,vi,view,vim,vimdiff,vimtutor}` → `libexec/{busybox,vim}/*`、`bin/more`；设备实测这 9 条在场）。旧解压器只在 `dest`（当时 = filesDir）内放行，**暂存目录解压（`.snapshot-stage`）会把它们全部静默丢弃** → applet 缺失。修复：`SnapshotExtractor.extract(..., runtimeRoot = context.filesDir)`，绝对目标只要落在 runtimeRoot 内即放行（交换后正是正确路径）；相对链接仍须落在解压根内，Termux 残留与 `../` 逃逸照旧拒绝。在线更新路径（UpdateManager，dest=update-stage）同款受益——此前同样在静默丢链。回归验证：装机后 `run-as ... ls -l files/usr/bin/more` 应见绝对链接。grep `isLinkTargetAllowed`。
46. **无障碍通道的两条「僵尸」陷阱（2026-09-10 模拟器实测）**：① **prefs 僵尸 a11yEnabled**——`am force-stop` 杀进程时 `onDestroy/onUnbind` 不保证执行，`dsh-adb.xml` 里的 `a11yEnabled=true` 会留在原地，而系统已解绑服务；引擎若只读该标记就会把请求投进队列后无人取活（表现为工具 8s 超时）。修复：引擎侧 `a11yEnabled()` = prefs 标记 **且** 队列轮询心跳新鲜（`ControlQueue.pollAgeMs() < 20s`，壳侧长轮询每次调用即刷新 `lastTakeAt`）。② **重启后服务不解绑但也不重连**——force-stop + 重新 `am start` 后必须重新 `settings put secure enabled_accessibility_services ...`（实测 `settings get` 返回 null），否则 `dumpsys accessibility` 的 `Bound services:{}` 为空。排障顺序：`dumpsys accessibility | grep -A2 "Bound services"` → prefs → 队列 `lastTakeAt`。grep `pollAgeMs`。

47. **门禁顺序错位会让新通道永远不可达（用户当场指出的设计缺陷，2026-09-10）**：把无障碍后端接进工具层后，如果 `gateFor()` 仍然只认 ADB 三道人门，工具会先被 ADB 门拒绝——a11y 分支永远走不到（实测：AI 拿到的一律是「请在开发者选项 → 无线调试 配对」）。修复原则（PRD §3.3 B3）：**两条通道等价、无障碍优先**——`gateFor` = a11y 在线 **或** ADB 门齐备，`ControlPolicy.decideControl(op)` 再决定后端；会话档位 `danger-full-access` 对两者同等要求。设置页也必须同步（无障碍为主入口 + 官方 Intent 跳系统设置 + Android 13 受限设置一键解锁，ADB 折叠为高级/脚本面），否则「改了后端没改授权面」等于没改。grep `decideControl`。

48. **`settings.describe(options)` 的 options 被实现忽略（0.13.5 引擎侧踩坑，影响所有读其它命名空间的插件）**：`ctx.settings.describe({namespaces:['llm-pi-ai']})` **不会**按命名空间过滤，返回全部注册命名空间且顺序即注册顺序——取 `[0]` 很可能拿到 `llm-deepseek`，于是自定义路由永远查不到（表现为能力自动补全静默不写回）。正确写法：`.find(d => d.ns === 'llm-pi-ai')`。同族坑：未 `inject` 的服务直接读属性会抛 `cannot get property "credentials" without inject`——可选服务一律走 `ctx.get(name)`。grep `describe(options)`。

49. **inset 通道只做了一半：没有 top 通道 → 关闭沉浸式后顶栏/设置页头被状态栏压住（#135，2026-09-10 模拟器实证）**：`WindowCompat.setDecorFitsSystemWindows(window, false)` 让页面铺满全屏，但 `MainActivity` 的 insets 监听**只缓存 bottom/mandatoryGestures/ime 并推给页面**，`bars.top` 仅用于引导页 padding；同时 Android WebView 实测 `env(safe-area-inset-top) = 0`，于是状态栏可见时（沉浸式关闭）topbar 矩形 `y=0 h=61` 的顶部 16px 与设置面板 nav（`y=12`）都落在状态栏（48 物理 px = 24 CSS px）下面。修复：insets 监听补 `webSystemTopInset = pxToCssPx(max(bars.top, displayCutout.top))` → `pushWebInsets` 推 `--dsh-android-system-top`（状态栏隐藏时 `bars.top=0`，开关天然自洽）；注入层 `.mobileFrame` 定义 `--dsh-mobile-top-inset = max(env(safe-area-inset-top), var(--dsh-android-system-top))`，topbar/抽屉/设置面板/轨迹面板/开发者弹层消费。注意设置面板是被 fixed 遮罩**居中**的，改高度会把头部推回状态栏下——正确做法是 `box-sizing: border-box` + `padding-top`。grep `webSystemTopInset`。

50. **弹出面板几何：宽度上限打在内层滚动容器上 = 卡片留空条 + 滚动条悬空（#135，CDP 实测）**：斜杠菜单 DOM 是「卡片 `[class*=_menu]`（背景/圆角/阴影）> 滚动容器 `[role=listbox]`」，壳侧历史注入脚本的 `[role="listbox"],[role="menu"]{max-width:min(92vw,340px)!important}` 只命中内层 → 卡片仍 410px、内容 340px（实测 `x=16 w=410` vs `x=20 w=340`），右侧 70px 空条、滚动条落在离卡片右缘 70px 处。模型菜单另有 `right:0 + width:max-content`，以触发器为基准 → 360px 视口下左缘 -84px，模型名丢前缀。修复：注入层 `ComposerPopupGuard` 按**实测矩形**写 `--dsh-mobile-popup-max-width`（卡片与滚动容器同值）+ `--dsh-mobile-popup-shift`（水平钳制，`[data-dsh-popup]` 上 translateX）+ 高度上限；按 `data-*` 锚点与测量工作，上游 CSS Module 改名不回归。grep `ComposerPopupGuard`。

51. **无障碍截屏落应用私有目录 → 引擎 read_image 打不开；且多花一轮（#127，2026-09-10）**：`DeviceControlService.handleScreenshot` 原写 `filesDir/control-shots/`，该目录不在引擎可读根内（引擎侧报 `EACCES: open '/data/user/0'`）。修复：改写 `files/home/tmp/dsh-tmp/`（= `EngineManager` 给引擎的 `TMPDIR`，与管理插件 ADB 截图落地同源）+ 目录 LRU 兜底保留 8 份；工具层 `android_screenshot` 读字节 → `attachments.saveImage` → **结果内联图像块 → 立即删除临时文件**（模型不再需要额外一轮 `read_image`，零残留）；路由不支持图像/附件缺失/超上限时回退返回路径。grep `inlineShot`。

52. **点击无生效校验（#129）→ 新增便宜 `state` op**：`AccessibilityService` 的窗口/内容/滚动事件已维护 `invalidated` 标记与快照代次 `generation`，但只在 dump 时暴露。修复：新增 `state` op 返回 `{gen, invalidated, enabled}`（**不建树**），`android_ui_click` 点后 260ms 读一次并回报「已生效/未观察到变化」；同时把 `ACTION_CLICK` 的节点中心 / 手势落点回填到 `x/y`（此前 a11y 归一化路径恒返回 0）。新增 op 必须同时进引擎侧 `ControlOp` 与 `A11Y_OPS`（坑 47 同族）。grep `handleState`。

53. **悬浮球完成态脱节（#133）**：`api-session/status running=false` 只重置 `sessionBusy/toolCount`，**不清该会话的待答/待审批项** → `pendingKind` 仍派生为 question/approval，球停在琥珀「等待你的回答…」且面板不收。修复：完成事件调用 `OverlayPanel.dropPendingFor(agentId)` 丢弃该会话 pending，并按 `overlay_display/auto_collapse_on_done`（默认开）自动收起面板——**有未提交草稿时不收**。grep `dropPendingFor`。

54. **目录同名模型跨厂商方言不一致 → 写入 reasoningEfforts 会让请求被网关拒（#134，独立排查）**：`dsh-model-capability` 从引擎目录按模型 id 取 `thinkingLevelMap` 写 `reasoningEfforts`，但**不写配套的 `compat.thinkingFormat`**；pi-ai 便按探测默认方言（未知 baseURL → `openai`）发送 `reasoning_effort`，真实厂商方言（如 zai）不同的网关可能直接 400，且档位持久化在 `agent-default-model` 被新会话继承。修复（0.2.1）：方言键改用**严格口径**——只要有目录声明了而另一些没声明即视为「方言不明」→ 跳过 `reasoningEfforts` 写入并记冲突；统一时连同 `compat.thinkingFormat/supportsReasoningEffort/maxTokensField` 一起写。grep `pickDialect`。

55. **历史编号保留（内容不可还原）**：该编号由 0.13.5/0.13.6 的更新记录行引用（"新增坑 55-57"），但正文从未落到本文件；`docs/AGENTS/changelog-archive.md` 现存最早条目仅到 0.13.2-preview（2026-08-31），无法还原。按"不重编号"纪律保留该号占位；
如需补正文，从 0.13.6 的认证台账 `docs/AGENTS/0.13.6-CERTIFICATION.md` 与当期 PR 描述回溯（登记义务：找到即回填本条）。
56. **历史编号保留（内容不可还原）**：同坑 55——0.13.5/0.13.6 更新记录行引用的编号，正文不在库内、archive 无对应版本行。保留占位，勿重编号。
57. **历史编号保留（内容不可还原）**：同坑 55——0.13.5/0.13.6 更新记录行引用的编号，正文不在库内、archive 无对应版本行。保留占位，勿重编号。
58. **0.1.5 起 ui-layout 不能禁用（2026-09-10，追上游）**：上游把 `ui-layout` 变成布局服务中枢（`ctx.layout` 五方法、键控 `main` 槽、`provideRoot({hooks:{panelInfo}})`、`layoutInfo` 八字段）。profile patch 若仍 `- id: ui-layout / disabled: true`（0.1.2 时代为换自研 AppFrame 而设），`ui-conversation` 注册不进 `main`、`ui-sidebar-right` 注入不到 `rightbar`、`SidebarRoot` 读不到 `usePanelInfo` → **会话与左栏一起消失**。修复：删除该 disabled 条目，注入层改「移动适配层」（0.2.0 起不再注册 root 槽、也不再 `provide('layout')`——重复 provide 会整链失败，同 directory-picker 事故）。

59. **手机形态不能再锚 `[data-mobile]`（注入层 0.2.0）**：旧 AppFrame fork 自带 `[data-mobile]`/`[data-mobile-topbar]`；去 fork 后这些属性不复存在，样式会静默失效（弹出面板越界、设置页窄条、轨迹详情被遮）。现由 `mobile/form-marker.ts` 发布 `html[data-dsh-mobile-form]`（镜像 `(max-width:767px)`）、`[data-dsh-frame]`（由上游 `[data-rightbar-col]` 反查）、`html[data-dsh-modal-open]`、`[data-dsh-settings-dialog]`；顶栏为 `[data-dsh-mobile-topbar]`。改动样式前先 grep 这五个锚点。

60. **原生「打开方式」两条出口与白名单（0.13.7）**：`PathOpen.openChooser` 与 `FileIncoming.openWithExternalReader` 共用 `FileIncoming.isReaderAllowed`（file_paths.xml 同一映射面）；目录主候选固定 `ACTION_OPEN_DOCUMENT_TREE`（FileProvider 目录 URI 多数文件管理器不可枚举），MT 管理器等按包名进「初始意图」——装了才出现，未装不臆造。返回 `{"ok",reason?}`，页面按 reason 分流文案，绝不静默（`no-handler` 弹提示）。


61. **polyfill 片段共用一个 `<script>`：一个片段语法错误 = 整块 polyfill 静默全灭（0.13.7 模拟器实锤，排查花掉一整轮）**：`dsh-host-web-compat` 的 `POLYFILLS` 数组原来用 `join('')` 拼进同一个 script 元素——Set 集合方法片段以表达式 `})()` 结尾（**没有分号**），紧接着的下一段以 `if (` 开头，两段贴成 `})()if(` → 解析器拒绝**整个 script 元素**（`Unexpected token 'if'`）→ 页面上 `typeof Iterator === 'undefined'`、`Promise.withResolvers` 也没了，上游 0.1.5 客户端包 import 期直接 `Iterator is not defined`（表现为 "Failed to load plugins"，截图见 `.deploy-tmp/0137/now-01.png`）；而**服务出去的 HTML 里片段文本一个不少**，所以 `grep` 类检查全绿，检查脚本用的「`ES2024/2025 builtins`」标记还只是插件源码里的 JS 注释（根本不会出现在页面），假绿 + 假红线同时误导。**防线（三层）**：① 装配规则 `POLYFILL_SCRIPT_BODY` 对每段补 `;` 并用换行分隔；② `apply()` 装载期对装配结果逐段 `new Function` 解析断言，失败直接抛（`host-web-compat: polyfill injection does not parse: …`）；③ 门禁 `node dsh-host-web-compat/scripts/smoke-injections.mjs`（桩 cordis 真装配 + 逐段解析 + 页面标记）+ 设备侧 `scripts/verify-webview-015.mjs` 的「全部内联脚本可解析 / polyfill 活性」断言。**教训：注入类缺陷只能按「装配后能不能解析/能不能用」判，不能按文本在场判。** grep `POLYFILL_SCRIPT_BODY`。

62. **孤儿写锁会让引擎永久起不来（Android 没有 operator）→ F4 引擎树补丁（0.13.7）**：`dsh-atomic-write.withFileLock` 用 `wx` 建 `<file>.lock`（内容 = 持有者 pid），只在 `finally` 里 `rm`。进程被硬杀（用户划掉应用 / 系统 OOM / `am force-stop` / 看门狗重启）时 finally 不执行 → 锁永久残留 → 之后每次写该文件都等到 deadline 抛 `atomic-write: timed out waiting for the writer lock at …/.credentials.yaml.lock`，**引擎 boot 直接失败**（实测现场：重复引擎进程被清掉后仍起不来，只因这一颗残留锁）。上游注释明写「contender never removes an existing lock … orphan recovery is an operator action」——桌面/服务器有位运维能删锁，Android 应用私有目录（`/data/data/<pkg>/…`）用户无任何可达手段。补丁 `atomic-stale-lock-F4`（scope=engine）在超时点做**一次**受控回收：锁记录的 pid 已消失（`process.kill(pid,0)` 得 ESRCH；EPERM 视为存活）且锁内容二次核验一致才删；读数失败/非 pid/不一致/任何异常一律不动锁（退回上游等待-超时语义）。行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs`。排障配套：**同一时刻只许一个引擎进程**（重复进程既制造锁争用也污染 `dsh web:` banner 判读），现场先 `ps -A | grep -E 'linker|node'` 清干净再起。grep `recoverStaleLock`。

63. **`inject-snapshot.py` 只替换快照内已存在的成员——给已有插件包「加新文件」不会进快照（幽灵缺陷温床）**：注入器按 tar 成员逐个判定（`member.isfile() and is_injectable(...)` → 用本地内容替换），只有**整包都不在快照里**时才走 `need_add` 全量新增（`scripts/inject-snapshot.py` 第 90-121 行）。因此「在 `dsh-host-web-compat/lib/` 里新加一个模块文件」这类改动，release 快照里**不会出现该文件**（本地跑得通、设备上 `Cannot find module`；0.13.7 处理 polyfill 缺陷时刻意把修复留在 `lib/index.js` 内就是为了避开这条）。需要新增文件时：要么确认该包整包走 add 路径，要么改注入器补「本地有、tar 内无 → 追加成员」的分支，并**在设备上 `ls` 该文件复核**。grep `need_add`。


61 续（同日第二层，同一入口）：**Iterator 垫片必须长成构造器形状，否则 pdfjs 把整树打挂**。清掉「Iterator is not defined」之后，`ui-sidebar-documentpreview` 的 combo 包仍在 import 期抛 `Cannot read properties of undefined (reading 'join')`。定位方式（可复用）：CDP `Debugger.setPauseOnExceptions: all` 暂停在抛点 + `Debugger.getScriptSource` 取源码行——出错行是 pdfjs 的 `if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = ...`：真 `Iterator` 是构造器且 `.prototype === %IteratorPrototype%`，而第一版垫片是裸对象 `{from}`（`Iterator.prototype` 为 undefined）→ 守卫行即抛，loader 记 `failed to import loader entry ...` → 整树 Failed to load plugins。修复：垫片改成 `function Iterator(){throw new TypeError(...)}` + `from` + `Object.defineProperty(ctor,'prototype',{value:proto})`（proto 仍是打过助手的 %IteratorPrototype%）；同时 `box()` 包装器必须 `Object.create(proto)` 而不是裸对象，否则链式助手 `iter.map(f).toArray()` 全断（真机断言当时报 `toArray is not a function`）。两道回归都进了 `dsh-host-web-compat/scripts/smoke-injections.mjs`：在 `node:vm` 里先删掉 Iterator 全局**和**原生助手方法（如实模拟 Chromium 110）再跑垫片，然后执行 pdfjs 的守卫行与 `Iterator.from([1,2]).map(...).toArray()`。**教训：垫片要按「真实现的结构」补（构造器 + prototype + 继承链），只补名字不够。**


64. **运行时补丁不得引用引擎构建产物（bundle hash）**：`adaptIndexHashes` 用 `-([A-Za-z0-9]{8})\.(js|css)` 抓引擎
    `dist/index.html` 的 bundle 名，而 npm 现包的 hash 已经是 `index-Df-65__b.js` 这种（带 `-`、9 字符）——正则匹配不上就
    「原样返回」，patched 模板的旧引用被整文件写回 → 页面引到不存在的 bundle（白屏）。结论：这类补丁的生命周期跟着上游构建走，
    要么不写，要么写就得随每次引擎升级核对（0.13.7fx-1 直接退役 `web-frontend-index.html`，见 RUNTIME-PATCHES §8）。

65. **Android 应用进程的 cwd 是 `/`，而引擎拿它当默认值**：`SessionCommandController(ctx, agents, process.cwd())` 把
    `process.cwd()` 当「未指定工作区」会话的 cwd；`file-reference-local` 在会话无 cwd 时也回退到同一个进程目录。
    壳侧不设工作目录 → 新会话 cwd=`/` → `@` 菜单列的是设备根目录（acct/apex/cache…），用户看到「@文件功能无法使用」
    （apk #150/#144）。修复：`ProcessBuilder.directory(应用工作区根)`（0.13.7fx-1，EngineManager.workspaceRootDir）。
    同一族的坑：任何「上游拿 process.cwd() 兜底」的地方在 Android 上都会落到 `/`。

66. **Android 应用域禁 `link(2)`：补丁必须清点目标文件的全部 link 站点，不能只补历史锚点**：
    0.13.7 追上游 0.1.5 后，运行期 asset `session-persistence-jsonl-index.js` 只给 `materialize` 路径
    （`lib/index.js:2973`）补了 `EACCES → rename` 回退，漏了 `publishCurrentExclusive()`（:2021/:2032）——
    而后者正是 `v0→v3` 会话迁移的必经路径，结果是**升级前写入的会话全部打不开**（apk #154，贡献者定位）。
    修复：asset 从 0.1.5 包重出（两处都补）、新增构建期补丁 `spj-migration-link-F5`、门禁断言「两处标记都在」、
    并加行为回归 `scripts/patches/tests/spj-migration-link-f5.test.mjs`（桩 fs 让 link 抛 EACCES → 断言 rename 生效）。
    回退必须用**模块顶层导入的 `rename`**：`internals.fs`（defaultFileSystem）只暴露 open/readFile/readdir/stat/lstat/link/rm，
    `internals.fs.rename` 会 `TypeError`（贡献者在 PR #156 里实测记录）。同类站点清点义务适用于所有 fs 原语回退补丁。

67. **文件名净化把 `..` 当「非法字符」处理是无效防线（#177 实锤，0.13.8 修复）**：`sanitizeName`
    旧版只替换 `?*|:"<>` 与控制符，字符类无 `/`、无 `\`、无点——而 `..` 不是非法字符而是**路径语义
    token**：外部 ContentProvider 完全可控 DISPLAY_NAME（`../../../../pwn.txt`），净化后原样落
    `File(dir, name)`，上溯 5 级 = 应用私有数据目录根（任意新建，已存在文件因 uniqueName 的
    exists() 检查不被覆盖）。根因 = validate() 守 URI、sanitizeName() 守字符集，**拼好的最终
    落点无人校验**。修复 = ① sanitizeName 白名单化（`/` `\` → `_`、`\.{2,}` 折叠、百分号解码
    先行、去首尾点）；② copyIn 落点走 safeTarget canonical 归属断言（写前+写后，双侧
    canonical 化——Android 把 `/data/user/0` 解析为 `/data/data`，只做一侧会永远拒绝），fail-closed。
    铁律：凡「外部字符串 → 落盘路径」一律过 safeTarget 同型守门，新增出口先查本坑。

68. **部署默认写面档位不是能力门（#172 实锤，0.13.8 修复）**：`dsh-android-bridge` 的
    `gateFor/gateFacts/controlDecision` 三处曾叠 `&& st.tier !== 'T0'`——出厂装配
    `writeMode: workspace-write`（profile-web.cordis.patch.yml:23）使 `tier` 恒 T0，
    ADB 通道**恒判未就绪**（`android_adb_shell_exec` 永不返回 via:'adb'），且设置页显示
    「未授权（T0）」——坑 29「勿把部署默认当死锁」的活体复刻。修复 = 三处删 tier 条件，
    能力门 = 引擎级三道门 + 会话档位实时 resolve；`tier` 降级为部署视图字段
    （AdbAuthSection 的「已授权」改按三道门，linux-env 的 adbTier 文案标注「档位视图」）。
    铁律：门禁判定只允许「设备全局事实 + 会话实时档位」，任何部署常量进判定即缺陷。

69. **往 profile patch 挂「上游已挂」的包 = 整棵插件树加载失败（0.13.8 批 F/P2-14 实锤）**：
    按设计文档把 `@deepseek-ai/dsh-spill-local` + `dsh-spill-policy` 以 `- insert:` 挂进
    `scripts/profile-web.cordis.patch.yml` 后，设备上引擎起不来，日志真因：
    `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
    duplicate loader entry id: spill-local`。即**上游 host 组合默认已经挂了 spill 子系统**
    （所以「已装未挂」的推断是错的——overlay manifest 只说明包在快照里，不代表没挂）。
    代价是整棵树加载失败，不是单插件降级。铁律：新增 `- insert:` 前先确认 row id 在上游
    组合/预置里不存在；挂载失败先看 duplicate id，再谈配置。
70. **profile patch 的合并语义是「按 id 只增不删」——错误的 row 会永久留在设备上（0.13.8 实锤）**：
    坑 69 的 spill 行写进 `home/.dsh/profiles/web/cordis.patch.yml` 后，**改回代码 + 重装 APK
    + 重解压快照都没能删掉它**（实测：重装后该文件仍是旧的含 spill 版本，引擎持续起不来）。
    根因是快照事务的 profiles 分区合并对 `cordis.patch.yml` 按 id 合并（0.13.8 B345 批
    `SnapshotTransaction.mergePatchYamlById`），设计目的是保住用户手改，代价是**我们自己也删不掉
    已注入的行**。恢复路径（已实测）：`adb shell` 删/改
    `<files>/home/.dsh/profiles/web/cordis.patch.yml`（注意不要留 root 属主备份文件，见坑 71），
    或清应用数据。**发布含义**：0.13.8 之后若需要下线某条已注入 row，老设备上删不掉——
    必须在合并语义上给「上游注入行以 staged 为准」留口子（已登记 known-gaps）。
71. **profiles 目录里放 root 属主文件 → 引擎 watcher EACCES 崩溃（0.13.8 调试时踩到）**：
    用 `adb shell cp`（root）在 `home/.dsh/profiles/web/` 下留了 `cordis.patch.yml.bak-spill`，
    引擎对 profiles 目录做 `watch`，读不到该文件 → `syscall: 'watch', code: 'EACCES'` 直接崩，
    表现为「引擎启动失败」而日志里没有任何插件错误。铁律：调试期在 profiles 目录里造文件
    必须 `chown u0_a53:u0_a53` 或立刻删除（应用 uid 见 `dumpsys package`）。

72. **工具返回面聚合体不得含 `undefined` 成员（0.13.8 批 B0/B1 实锤）**：工具体对返回值做 lossless JSON 判定，
    含 `undefined` 成员的整值被拒收（不是丢字段，是整条结果失败）。铁律：可选键缺省**整键不发**，
    源头（构造对象处）与出口（序列化前）双修；新增/修改返回字段必须在**同一次改动**里进 `output.schema`。
    锚点：`plugins/dsh-android-manage/src/lossless-json.ts` + `plugins/dsh-android-manage/test/privilege-status.test.mjs`。
73. **`defineTool` 之后必须确认进了 `tools()` 的 return 数组**：不进注册数组就是死代码，而提示文案还在引导
    模型去调它（表现为「工具明明写了却 always unknown tool」）。注册完整性**不得**用硬编码名单比对——
    要源码级抽取 `defineTool` 名集合与注册名集合求差集（本轮 T2 门禁 `check-tool-output-schema.mjs`）。
    锚点：`plugins/dsh-android-manage/src/index.ts` 的 `tools()` 数组 + `scripts/check-tool-output-schema.mjs`。
74. **跨语言/跨模块等价门禁只锁「同一输入同一输出」不够，还要锁「输出能被另一端正确解释」**：V2 行句柄口径即此例

143. **对虚拟屏截图拿到的是真实屏画面：ADB 回落路径完全忽略 `screenId`（0.14.0 模拟器实锤）**：
    现象：设备内 agent 把「设置」成功拉到虚拟屏（`dumpsys activity` 确认在 Display #10），
    但 `android_screenshot { screenId: "virtual-1" }` 返回的画面是 **DSH 聊天界面**；
    它据此判定「设置没开在虚拟屏上」，整轮往错误方向排查。

    真因：`android_screenshot` 有两条路，**只有无障碍那条认 screenId**。
    无障碍离线时回落到的 ADB 路径写死了：
      `adb shell screencap -p <remote> && adb pull ...`
    无参 `screencap` 只抓默认屏（display 0），`screenId` 从始至终没被读过一次。
    这是一个**静默错误答案**：工具返回成功、图也真实，只是拍错了屏——比直接报错更有害。

    修法：ADB 路径也解析目标屏（`screenAccessResolved` → `vdInfo`）并落到 `screencap -d <displayId>`
    （该通道 uid=2000，具备此权限）；同时**把分辨率锚点换成目标屏自己的像素**——
    锚点若仍是真实屏尺寸，模型按归一化坐标点击会整体错位。
    未指定 screenId 时不注入 `-d`，保持真实屏默认语义不变。

    通用教训：**同一工具的多条通道必须共享同一份参数语义。**
    这条缺陷的本质不是「截图坏了」，而是「两条路的 screenId 支持度不一致」——
    加通道时只测了主路，回落路径的参数就跟主路脱钩了。
    回归：`a11y-routing.test.mjs` 两条（带 screenId 必须 `-d <id>` + 锚点是虚拟屏像素；不带则不得注入 `-d`）。

144. **「探针值恒为 -1」不一定是解析 bug：先证明产出面在场（0.14.1 块F P0 实锤）**：
    现象：`files/boot-segments.log` 的 `t_compose_total` 在设备上 42/42 样本恒为 `-1`，
    而 `scripts/check-perf-instrumentation.mjs`（P-AC-04）一直判绿——因为它只查「三字段在场」。

    真因（两条，缺一不可）：
    ① **产出面根本不在**：`[perf] TOTAL calls=… totalMs=…` 只有测量用 preload
       `scripts/perf/count-compose.mjs` 会打印（`--import` 注入引擎命令行 + `process.on('exit')` 汇总）。
       该脚本**没有任何发行路径**：不在快照 stage、不在 `engine-overlay.json`、不被 `inject-all.py` 注入，
       出厂 argv 与 env 也都不含它。⇒ 正则/解析器没错，**上游从未产出那一行**。
    ② **解析链挂在默认关闭的开关上**：`maybeEmitComposeTotal` 只被 `tick()` 调用，而 `tick()`
       由调试日志采集器驱动、**采集器默认关闭**。即便探针在场，默认设备上也永远落不出真值。

    修法：口径解析改为**与采集器解耦的有界 tail**（`startProbeTail`，独立读偏移、90s 上限、daemon），
    且**探针缺席时显式落 `note=probe-absent`** + 判据行带 `t_compose_source`，
    使「探针没装」与「采样为 0」从此可区分（`none` vs 真实值）。

    通用教训：**指标恒为缺省值时必须先证产出面**——「解析器存在」不等于「数据源存在」。
    同理：**不得用近似量冒充**（A3 缓存行只有 entries/hits、A5 只有 singles，都不含耗时，
    拿它们填 `t_compose_total` 就是新的假绿）。回归：`EngineBootInstrumentationTest`
    的 `composeSourceDistinguishesAbsentProbeFromZeroSample`（含「A3/A5 在场也不得产出 totalMs」反向断言）。

145. **门禁断言「安全姿态」时，改姿态必须同批改断言，且新断言要守住**真正要守的东西**（0.14.1 块K 实锤）**：
    现象：issue #232 的用户裁定是「撑开 NSC 支持明文 http」（准入面一直放行 http，而平台 NSC
    只白名单回环 ⇒「准入说行、平台必炸」）。撑开后 `check-manifest-hardening.mjs` 立即必红——
    它把 `base-config cleartextTrafficPermitted="false"` 锁死了。

    修法要点（不是把 false 改成 true 了事）：
    - 断言改为**显式声明**：`cleartextTrafficPermitted` 漏写即平台默认 false（=静默收紧）→ 判红；
    - **回环保留面逐字比对**（127.0.0.1 / localhost / 10.0.2.2，多一个少一个都判红）——
      防止「放开全域时顺手把可信回环定义放宽」；
    - 拒绝 `<domain-config cleartextTrafficPermitted="true">` 不带 `<domain>`（=全域明文口子）；
    - **跨层同向**下沉为 JVM 测试 `BrowserHostCleartextConsistencyTest`（真实调用准入面函数 +
      解析 NSC 本体），门禁只断言「该测试仍被接线」——单层门禁发现不了「准入面另开口子」。

    #183「壳侧明文收敛」影响（**必须书面记录**）：原目标「默认禁明文、仅放行回环」对隔离浏览器
    **不再成立**——隔离 WebView 可访问任意明文站点，明文流量回到不受平台默认保护的状态。
    这是用户明确拍板接受的取舍；影响面仅限 BrowserHost（无桥、无 addJavascriptInterface），
    引擎子进程（不受 NSC 约束）、APK 自更新（HTTPS）、主 WebView（回环）三条均零变化。

    通用教训：**门禁锁的应是「要守的性质」，不是「当时的取值」**；姿态变更时若只翻转字面量，
    门禁就变成一句永远为真的废话。

146. **「抑制」类开关默认值翻转必须配存量升级策略，且不得静默改写用户显式选择（0.14.1 块J 实锤）**：
    现象：`NotifyCenter.suppressForeground()` 缺键返回 `true`，导致**前台工作时整条工作汇报被永久丢弃**
    （命中即 `return Result.SUPPRESSED_FOREGROUND`，无入队、无补投；而消费侧已推进字节偏移）
    ⇒ 用户体感「必须划到后台才推送」。用户裁定默认值改为 `false`（前台也真发）。

    存量升级的关键事实：**旧抑制是默认值造出来的，不是 prefs 写出来的**——
    全仓 `setSuppressForeground` 零调用、0.14.0-preview 起从未接线，**没有任何发行版写过该键**。
    ⇒ 改默认值即修好存量用户，**无需改他们任何一个 prefs 字节**。

    因此迁移形态是「**不动 prefs**」：缺键 → 走新默认值（被修好）；**显式存在的值原样保留**
    （那只能是用户/自动化写入的真实意志，静默改写它属于「代理信号当真实状态」的反面错误），
    只备份到 `suppressForegroundLegacy` + 探针留痕；`suppressForegroundSchema` 代次保证只跑一次。

    同批补的另一半：抑制从「丢弃」改为「**延后**」（待投队列 + TTL + 覆盖式去重 + 有界），
    且 `listener` 从「全仓零赋值的空操作」补上真实实现（复用既有 `flashStatus`）——
    否则用户既无系统通知、也无应用内提示，是「一切正常与彻底失败不可区分」的静默失败形态。

    通用教训：**改语义默认值前先查「旧行为是默认值造的，还是被显式写出来的」**——两者迁移策略相反。
    回归：`NotifySuppressQueueTest`（TTL/覆盖/有界/最新优先）+ `NotificationContractTest` 六条。

155. **悬浮窗完成位必须挂在服务级字段：自动收起是默认路径，「完成后用户还没看到面板」才是常态**：
    现象（需求侧）：用户要求「对话完成且首次打开悬浮窗时」显示「已完成，长按查看汇报」。
    若把完成位放进 `unitView` 的视图状态或某次 `setText`，自动收起（`autoCollapseOnDone` 默认 true，
    完成后 900ms 收面板）会 `removeView(unitView)`，完成位随之丢失 → 用户点球重开时**永远看不到**该文案。

    真因：`hidePanel()` 会 `unitView.visibility = GONE` 并 `removeView`，视图状态不是跨展开期的载体。

    修法：完成位放 `OverlayService` 服务级字段（`internal val completion = CompletionNotice()`，
    与 `sessionBusy`/`toolCount` 同族），置位与消费分离——`applyAgentStatus` 的 `running=false` 分支置位，
    `showPanel()` 消费。**且必须覆盖「置位时面板已展开」路径**（autoCollapseOnDone 关闭时）：
    该路径不走 `showPanel`，若不显式消费则展开态永远不显示。

    通用教训：**任何「跨收起/再打开」的用户可见状态，都不能存在会被 remove 的视图里。**

    回归：`OverlayCompletionNoticeTest`（无 pending 的普通完成必须显示、收起再打开回常态、两轮不残留）。

148. **`flashStatus("已完成")` 的真实触发条件不是「工作完成」，而是「有 pending 被丢弃」**：
    现象：既有实现里「已完成」只在 `dropPendingFor` 返回 true 时闪现，故**普通完成（无待答/待审批）
    根本不显示**；且它是 2.5s 瞬时闪现、只在展开态可见。

    真因：两处 `flashStatus("已完成")` 调用都在 `if (dropped)` 之内，`dropped` 来自
    `panel.dropPendingFor(agentId)`。这正是旧认知与本需求的分歧点——先读源码再改，
    不要沿用「完成就会显示已完成」的错误前提。

    另注：自动收起分支里的那次 `flashStatus` 是**死调用**（同点先 `hidePanel()` 同步置
    `expanded=false`，而 `flashStatus` 内有 `if (expanded)` 守卫 → 必不显示）。

    修法：新完成态是**独立常驻状态位**（`CompletionNotice`），触发取自权威信号
    `api-session/status running=false`，与 `dropped` 无关——这样无 pending 的普通完成也能显示。

149. **`as? GradientDrawable ?: return@post` 式取层是静默失败源：drawable 改形态后门禁全绿但功能不动**：
    现象（本轮实锤形态）：`setHalo` 原为
    `val g = hv.background as? GradientDrawable ?: return@post`。把 `newHaloDrawable` 改成
    `LayerDrawable`（glow+ring 两层）后，该 `as?` **恒为 null**，于是每一次状态改色请求都被
    无声吞掉——不抛错、不日志、编译过、门禁绿，表现只是「球不变色」。

    真因：`?: return@post` 把「类型不匹配」这种**结构性错误**降级成了正常控制流。

    修法：显式取层 + 失败留痕（`LogCollector.log`），并让「背景必须是 LayerDrawable」成为
    源码契约断言的一部分（`CallSiteContractTest`：不得再出现 `background as? GradientDrawable`）。

    通用判据（同坑 61）：**任何 `as?` + `?: return` 组合，若其失败分支等价于「功能静默失效」，
    就必须改为显式诊断**——否则它是一道永远发现不了缺陷的防线。

150. **`Color.argb(...)` 在 `unitTests.isReturnDefaultValues = true` 下恒返回 0：颜色类单测会假绿**：
    现象：`Halo` 枚举若用 `android.graphics.Color.argb(...)` 在枚举初始化时求值，JVM 单测里
    `Color.argb` 被打桩返回 **0** → `Halo.values()` 全部取值为 0 → 任何
    `assertEquals(ringColor, Halo.PENDING.color)` 一类的断言**恒真**。
    这类测试看起来在防漂移，实际是「永远不会失败的防线」。

    真因：`app/build.gradle.kts` 的 `unitTests.isReturnDefaultValues = true` 把 android 图形类
    统一打桩成默认值（0/null），纯 JVM 测试拿不到真实图形 API。

    修法：状态色改用**纯 Kotlin ARGB 十六进制字面量**（`0xCDEBBE3C.toInt()` 等，换算口径
    `(a shl 24) or (r shl 16) or (g shl 8) or b`，逐字节等价），枚举即可在 JVM 上求真实值；
    并补一条「四态取值互不相同」的反证——把实现改回 `Color.argb` 时它会立刻变红。

    **连带坑（本轮实际踩到，比坑本身更值得记）**：人工转写十六进制极易**把 g/b 两个字节写反**
    ——`argb(205,235,190,60)` 的正确拆解是 `a=CD r=EB g=BE b=3C → 0xCDEBBE3C`，本轮误写成
    `0xCDEBBC3C`（`BE3C` 错位成 `BC3C`）。更要命的是**设计详档 §4.3 的换算表里写的就是错值**，
    照做即错（已就地更正 `docs/0.14.1-preview-HALO-FREE-MOVE-AND-RING.md:277-278` 与本条）。
    教训：**转写类改动的唯一可靠验收是「逐字节等价断言」，不是肉眼比对**——本轮正是
    `argbLiteralsEqualThePreviousColorArgbValues` 把它抓出来的。
    另注意：契约测试若拿**具体字面量**当「在场」判据（如原文的 `code.contains("0xCDEBBC3C")`），
    会把错值一起钉死 → 修源码后测试反而判红。正确写法 = 断言 8 个**正确**字面量在场
    **且**显式禁止已知错值形态（见 `CallSiteContractTest.haloEnumUsesPlainKotlinArgbLiterals`）。

    回归：`OverlayHaloInvariantTest`（四态互不相同 + 字面量逐字节等价 + 通道语义方向）。

151. **构建器「跑到一半就正常退出」= 打包链静默复用陈旧快照（0.14.0 实锤，本轮修复）**：
    现象（本轮取证）：`scripts/build-snapshot-013.mjs` 跑完打印「瘦身完成」后 **exit 0**，但
    `.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz` 的 mtime 停在 9/15，而同级 `stage/` 已更新到 9/19
    —— **「stage 是新的、产物是旧的」**。整条打包链零报错：`build-apk-013.ps1` 只判「该 tar 是否存在」，
    存在就继续注入/打包，于是**发布产物里嵌的是上一次的快照**。

    真因：提交 `0849579`（0.14.0 正式轮）对 `build-snapshot-013.mjs` 做了**纯尾部删除**（父提交
    866 行 → 823 行），删掉的正是 `── 8. 归档` 整段：`tar -c --mtime=@… | xz -T0 -6` 产出 tar、写
    `snapshot.sha256`、归档内 LICENSES 自检、A1 出厂声明值对账。该提交的 message **完全没提**这件事。

    **第一手信号（最快判据）**：`scripts/snapshot-config/slim.json` 出现**死键**——
    `reflinkGlobs` / `orphanGlobalNodePackages` 在构建器里已无任何消费者（被删的还有依赖它们的
    两步瘦身）。**判据：配置文件的每个键都必须在消费它的构建器里被引用；死键 = 某步被删/被绕过的
    确定性证据**（比「事后去读 diff」快，且不依赖有人记得查历史）。

    修法：从 `0849579~1` 恢复尾块（**+99 行 / 0 删除**的纯新增；尾块与删除前逐行一致、`node --check`
    通过），重跑构建器实测产出 162.7 MB tar 并打通归档后自检；并新增常驻门禁
    `scripts/check-snapshot-builder-output.mjs`：① 产出面构造在场（tar 打包 / sha256 落盘 / 归档后
    LICENSES 自检 / A1 对账 / 两步瘦身，且**纯注释行不计入**，防「只剩注释提到」的假绿）；②
    slim.json 键消费者闭合（死键即红）；③ 与打包链**路径同源**（构建器写 A、打包链读 B 亦属同类
    静默假绿）；④ 两树同版。该门禁自带 `--self-test`（含「尾部删掉归档段必须判红」「纯注释不计入」
    等反向对照），并已用**真实回归版本**实测判红 9 项。

    通用判据：**任何「产物生成器」与「产物消费者」分居两处时，必须有一条断言锁住「产出面还在」**
    —— 只判「产物文件存在」是假防线：文件可能是上一次的。

147. **`screencap -d <Android displayId>` 对虚拟屏必然失败：必须用 SurfaceFlinger 的长整型 display token（0.14.1 块G F6 设备实测）**：
    现象（MuMu x86_64 模拟器，Android 15 / API 35）：已建虚拟屏 `virtual-1`
    （Android `displayId=2`、1200x675、`mHasContent=true`、屏上有前台应用）时：
      `screencap -d 2 -p out.png`  → `Failed to take screenshot. Status: -2`（无文件）
      `screencap -d 0 -p out.png`  → 同样 Status -2
      `screencap -d 4619827820427265280 -p out.png`（真实屏的 SF token）→ 成功 256479 B
      `screencap -d 11529215049621561620 -p out.png`（**虚拟屏的 SF token**）→ 成功 93785 B
        （PNG 1200x675 RGBA，解出 984 种不同 RGB、非全黑；uid=2000 shell 亦成功）
    真因：`screencap -d` 吃的是 **SurfaceFlinger 的 display token**（`dumpsys SurfaceFlinger` 里的
    `Display <长整型>`，虚拟屏那份形如 `11529215049621561620` = `0xa0000000d3c7e114`），
    **不是** `DisplayManager` 的 `displayId`（后者是 `dumpsys display` 的 `mDisplayId=2`）。
    两者在所有现有文档与代码注释里都被当作同一个数——这就是「-d 传对了也不出图」的真因。
    另注：`Status: -2` 与「display id 合法但 SF 认不出」同形，故错误码本身不区分这两种输入。

    影响面（**已交叉核对，非仅 F6**）：`plugins/dsh-android-manage/src/index.ts:550#expect=additionalProperties%3A%20false%2C` 的截图回落
    路径就是 `adb shell screencap -p -d <screenAccessResolved().displayId>`，即传的是
    DisplayManager 的 `displayId` ⇒ **该回落路径对虚拟屏截图在当前实现下必然失败**
    （0.13.8 修的是「忽略 screenId」，本轮暴露的是「传了 screenId 但 id 空间错」）。
    而 `VdisplayController` 的 `ImageReader` 通道注释明写 "not a pixel transport"（只排空帧）。

    已确证的落地形态（F6 收口，见 152）：壳侧按 SF 的 `name="DSH <alias>"` 反查 token，
    再 `screencap -d <token>`。反查命令用**收窄**形式（输出只 ~25 B）：
      `dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'`
    实测输出（逐字）：
      `    name="mumuscreen000"` / `Virtual Display 11529215047793762666` / `    name="DSH virtual-1"`
    注意**不要用全量 `dumpsys SurfaceFlinger`**：本机全量 31,590 B，而虚拟屏段落在第 ~9,500 字节之后，
    超出壳侧 capture 路径的 8 KiB inline 回传窗口 ⇒ 全量取回必然拿不到目标行、反查恒空。
    另注意 token **每世代都变**（同一会话内实测出现过 `...46816944610`、`...49621561620`、
    `...47793762666`），**不得缓存**，必须每次现查。
    （本节此前写「token 数值未在公开 API 暴露、反查未跑通」——已被 F6 的设备实测推翻，就地更正。）

    通用教训：**两个同名不同值域的 id 不可互换**——`-d` 的参数空间必须在代码与文档里写清是
    「SF token」还是「DisplayManager displayId」；本仓此前三处（manage 截图、F2 正则、F5 副本）
    都默认它是 displayId。F2/F5 的放行判据本身不受影响（它们只比对「是否是已注册虚拟屏的
    displayId」，用于范围判定而非透传），但**透传面**必须转成 token。

152. **无障碍通道对虚拟屏**取树/截屏**曾被范围门误拒**（screen-blind；F1 已修，见条末更正）：`android_screenshot {screenId:"virtual-1"}`
     必须走 ADB 回落，SF token 反查因此是**承重路径**而非兜底（0.14.1 块G F6 设备实测）：
     现象（MuMu x86_64 模拟器 / Android 15 / API 35，装机版 0.14.0，a11y 服务已确认 bound）：
       `android_screenshot {screenId:"virtual-1"}` → 返回**真实屏命令词拒绝文案**
       `android_ui_dump {screenId:"virtual-1"}`     → `无障碍取树失败：screen-out-of-scope:
         用户当前开放屏幕范围为 virtual-only，不允许读取或操作真实屏幕`
     真因：a11y 通道在**虚拟屏目标**上被范围门按 `real` 判定而拒（与 F1/F2 同族的 screen-blind 判定：
     门只认「调用点是否把 screenId 传进门」，a11y 分支不解析别名 → 落到 real → virtual-only 下必拒）。
     这同时解释了「模型反复改用 `android_shell_exec` 试 screencap」的行为：它拿到的是一条与真实
     判据不符的拒绝（T3 修过的「文案撒谎」同族），于是整轮在错误前提下排查。
     结论：**ADB 回落是承重路径**，故 F6 的 SF token 修法是必需的，不是锦上添花。
     关于 a11y 侧的 screen-blind 判定——**该结论已过期，就地更正（2026-09-19 收口轮）**：
     当时记「本轮未修，属独立遗留缺陷」已被 F1 修正取代。`bridge/index.ts:832-838` 现在**读
     `args.screenId` 并经 `screenAccessResolved` 按目标屏判定**（不再按 op 名一刀切），
     故 virtual-only 下指虚拟屏的 a11y op **不再被门拒**；上引「无障碍取树失败：screen-out-of-scope」
     是 F1 修好**之前**的现场报文。
     能力面另有新证据（同日实测，MuMu x86_64 / API 35）：虚拟屏 active 时
     `dumpsys window windows` 出现 `WindowsForAccessibilityObserver{mDisplayId=10, mInitialized=true}`，
     且 `uiautomator dump --display 10` 能出 1916 B 真实节点表 → **a11y 通道对虚拟屏可达**，
     原先「对虚拟屏不可用」的推断不成立（真因是范围门，不是能力缺失）。
     **仍未确证**：`takeScreenshot(displayId≠0)` 对**应用自建 private display** 是否成功
     （详档 §6 U5），需引擎工具面端到端调用方可定性；`android_screenshot` 的 ADB 回落
     仍然是已验证可用的那条路。

     复验方式（本轮实际用的，可复用）：页面内 RPC 驱动一次真实模型工具调用——
     `adb forward tcp:29225 localabstract:<webview_devtools sock>` → CDP
     `Runtime.evaluate` 发 `fetch('/api/commands/execute', {agentId,line:'/permission danger-full-access',
     submittedAttachments:[]})` 先提档（否则工具面被 `workspace-write` 门拒绝，会误判成 a11y 失败），
     再 `fetch('/api/session/prompt', {request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}]}})`，
     最后拉 `files/home/.dsh/sessions/<dir>/session.v3.jsonl.zstd` 解出工具结果。
     **两个必踩的坑**：① RPC `payload.args` 的字段名逐方法不同（`session/list` 是 `_request`、
     `session/prompt` 是 `request`、`commands/execute` 是 `agentId/line/submittedAttachments`），
     字段错会得 `gateway/arguments-invalid` 而不是静默失败；② 会话日志是**多帧 zstd 拼接**
     （本机 31 帧），Node 的 `zstdDecompressSync` 只解第一帧（得 243 B），必须按 `28 b5 2f fd`
     魔术字切帧后逐帧解；③ **WebView 在后台会挂起 fetch**（表现是 evaluate 永不返回）——
     必须先把 App 拉到前台（`monkey -p com.dsharnessmobile.shell -c android.intent.category.LAUNCHER 1`）。

153. **看门狗熔断的「永久锁存」与启动预算互斥：半死引擎下自动 undo 与自动重启双双永久失效**
     （存量缺陷，0.14.1 修复；用户口径「引擎崩溃时自动 undo 并重启是不是失效了」的直接真因）：

     现象（审计结论，非设备复现）：`WatchdogV2.planTick` 中 `tripped()` 一旦为真即返回**永久**
     `HOLD`，只有 HEALTHY 探活或 `EngineStartFlow` 里**唯一一处** `WatchdogV2.reset()` 能解。
     而熔断在 `effectiveFailureCount >= MAX_CONSEC_FAILURES`(12) 时打开，看门狗 5s/拍 ⇒ **60s**；
     托管子进程的启动预算 `START_COOLDOWN_MS` 却是 **90s**。

     真因：`tripped()` 的判定原本排在 boot-window 与 `undoReady()` **之前**。于是当引擎
     **进程存活但 HTTP 永远不健康**（半死 / 插件树挂住 / 端口可连但 serve 不响应）时：
     ① 计数器先撞满 12 拍打开熔断（60s）；② 熔断早退使 `undoReady()` **此后永不被求值**；
     ③ undo 的两阶段闸门（`OnProbeFailure` 需先 arm、再过 `WATCH_MS`=15s 才放行）连第一步都
     走不到。结果 = **自动 undo 与自动重启同时永久失效**，且没有任何日志（见下条观测盲区）。
     对照：真·反复死亡（进程不存活）路径正常——第 9 拍(45s) 就在熔断(60s) 之前触发 undo，
     故该缺陷**只在「半死」形态下显现**，这也解释了为什么它长期未被发现。

     修法（两处，正交）：
     ① `planTick` 把 `undoReady()` 提到 `tripped()` **之前** —— 配置回滚与「禁止盲目重启」是
        两种正交恢复手段，不应互斥。熔断继续守它该守的「undo 不可用时不得盲目反复重启」；
     ② undo 成功路径（`EngineService` 的 UNDO 分支 + `EngineStartFlow.maybeAutoUndo`）补
        `WatchdogV2.reset()` —— undo 成功正是「引擎应当重新可用」的时点，不复位会让恢复后的
        世代被上一次的失败计数白白锁住。
     附带同族修复：`EngineStartFlow.kt:256` 原先传 `WatchdogV2.consecutiveFailures`（该计数在
     DEGRADED_HTTP 下恒被清零）→ 改为 `effectiveFailureCount()`，与看门狗侧同口径；
     DEAD 下两者相等，故真死亡路径时序不变。

     不可回退的两条不变量（已写成断言）：① `DEAD` 路径第 9 拍触发 undo 的时序不得回退；
     ② 熔断对「undo 不可用 + 真·反复死亡」的保护不得被削掉——反向对照
     `circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable` 与
     `bootWindowStillGuardsALiveChildFromUndo` 锁住这两条。

     防线（本缺陷能存活至今的根因是「恢复判据无防线」）：`WatchdogLadderTest` 原先**全部**
     `undoReady = { false }`、且**没有任何用例断言 `TickAction.UNDO`**；`UndoGate` 本身零测试。
     本轮补：`WatchdogLadderTest` 四个新用例（正向 undo、真实半死场景、熔断保护反向对照、boot
     预算保护）+ 新增 `UndoGateDecisionTest`（把闸门四态判定抽成纯函数 `UndoGate.decide` 后直测，
     含 WATCH/RETRY 两个窗口的边界值）。判红证据：修复前正向用例得到 `HOLD(circuit-open)`、
     半死用例 `undoReady` 求值 **0** 次。

     教训：**「防抖/熔断」类锁存与其要保护的「恢复动作」若共享同一拍决策链，必须显式排定顺序
     并各写一条断言**——否则「保护」会静默吞掉「恢复」，而且吞掉时既不报错也不留日志。

154. **默认配置下「自动 undo 是否跑过」零观测面：`LogCollector.log` 受 DevLogPrefs 闸门**：
     `LogCollector.log` 在 `appContext == null` 时**直接 return**，而 `appContext` 仅在
     `LogCollector.start` 内设置，后者受 `DevLogPrefs.isEnabled` 闸门且**默认 false**
     （`MainActivity.kt` 的 `dev_log_enabled` 缺键即 false；`EngineService.onCreate` 亦按此判）。
     后果：默认设备上 `auto-undo trigger` / `auto-undo not executed` / `restart requested` 这类
     **看门狗叙述行全部落空**，用户无法判断自动回撤到底跑没跑——这正是「感觉自动 undo 失效了」
     的直接来源（机制其实正常，缺的是证据面）。

     修法：`UndoGate` 自带独立判据落盘 `files/undo-gate.log`（前缀 `dsh-undo-gate`，
     **不经 DevLogPrefs 闸门**，64 KiB 轮转一代），在 arm / trigger / suppress / execute 成功
     / execute 失败 / 各 abort 分支（CLI 缺席、list 超时、无快照）逐点留痕；同时仍双写
     `LogCollector.log`（采集器打开时两处都有）。
     单条取证：`adb shell run-as <pkg> cat files/undo-gate.log`。

     通用判据：**「关键恢复动作是否执行」不得只依赖可开关的调试日志面**——必须有默认在产的
     判据文件或 marker（`.undo-auto-done` 即此范式）；否则用户与排障者都只能靠「感觉」。
156. **`java.util.stream.Stream.toList()` 是 API 34 才有的方法：minSdk 26 下真机必崩且 catch(Exception) 抓不住**：
    现象（真机实锤，华为 NOH-AN00 / **Android 31** / 出厂 0.14.0 vc39，反馈目录
    `报错反馈/0.14.0/20260919-125714-engine-died-during-boot/`）：`engine-died-during-boot` exit=1，
    logcat 里 12:55/12:56/12:57 三时点、主线程与工作线程**反复**同一条硬崩溃：
    `java.lang.NoSuchMethodError: No interface method toList()Ljava/util/List; in class Ljava/util/stream/Stream;`
    → `at com.dsharnessmobile.shell.SnapshotFs.deletePath(SnapshotFs.kt:50)`
    → `SnapshotTransaction.finish` → `EngineManager.applyRecovery` → `recoverInterruptedRefresh` → `EngineService.ensureEngine`。

    真因：`Files.list(dir).use { it.toList() }` 里的 `toList()` 是 **Java `Stream.toList()`**
    （Java 16 引入，`api-versions.xml` 实测 **since=34**），不是 Kotlin 的 stdlib 扩展。项目 `minSdk = 26`
    → API < 34 设备上该接口方法不存在，抛 `NoSuchMethodError`。

    **为什么比普通崩溃更严重（后果链）**：① `NoSuchMethodError` 是 **`Error` 而非 `Exception`**，
    `deletePath` 的 `catch (e: Exception)` **根本抓不住** → 直接打穿整条恢复链；
    ② 恢复流程**永远无法完成**，marker 保留（`recovery marker retained`）→ **快照刷新/恢复在
    Android < 34 上永久卡死**，用户装了新 APK 也可能拿不到新基线（正是「更新后无需操作即得最新基线」
    这一用户诉求被打破的根因之一）。

    修法：改用 `Files.newDirectoryStream(dir).use { it.toList() }` —— `DirectoryStream<Path>` 是
    `Iterable` + `Closeable`，Kotlin 的 `toList()` 是 **stdlib 扩展**（无 API 级别依赖），
    `use` 保证关闭；语义等价（只列直接子项、不跟随符号链接、项读取失败记 onFailure 并跳过）。

    **为什么既有测试拦不住（关键教训）**：JVM 单测跑在 **JDK 17** 上，`Stream.toList()` 在那儿存在
    → 单测恒绿、设备必崩。这是「宿主机 JDK 面 ⊃ 设备 API 面」的**系统性盲区**，只能靠静态 API 守卫补。
    新增 `ApiLevelGuardTest`（禁用清单 + 词法扫描器，已带反证：回退该行即判红）。

    **同类自查（本轮全仓扫描 115 个 .kt 的结论）**：命中 1 处（即本坑），已修；其余疑点均判安全——
    `SnapshotUserData.kt:106` 用的是 `Stream.forEach`（since=24，安全）；`SnapshotTransaction.kt:240` 的
    `File.listFiles()` 是老 API（安全，未混入 Stream）；全仓 23 处 `.toList()` 里其余 22 处接收者均为
    Kotlin 集合/Sequence/FileTreeWalk（stdlib 扩展，安全）。**注意区分两类 `.toList()`**——
    用 grep 全仓搜 `.toList()` 会命中大量安全用法，不可据此改动。

    **扫描器自身的坑（本轮自伤一次，值得记）**：写静态守卫时，若用「本行是否含块注释起始符」判注释，
    会被 `ConfigTransfer.kt` 的 MIME 字面量（图片通配、任意类型通配）**误入块注释态**，静默丢掉
    3273 行代码（占全仓 18%，EngineManager/BrowserHost/NotifyCenter 成片漏扫）→ 防线大面积假绿。
    正确做法是**真正的词法扫描**：先剥字符串、再剥注释（顺序不可颠倒），并断言扫描面覆盖量防止回归。

157. **公开仓泄漏面：设备序列号以「测试注释/夹具」形态随**新文件**混入（0.14.1 P0-c 实锤）**：
    现象：`app/src/test/.../ShellOpsScopeTargetTest.kt` 的注释里写了「设备实测夹具（`emulator-<4 位端口号>` /
    Android 15 / API 35）」，而该文件是**本轮新增的 untracked 文件**（`git show HEAD:<path>` 不存在），
    会随 PR 进公开仓 `kelai141/dsh-mobile-apk`。用户硬要求：设备拓扑（serial / boot_id / 本机路径）
    **只能进协调仓 `docs/`，绝不进公开仓**（`docs/DEVICE-TOPOLOGY-PRIVATE.md` 首段为权威口径）。

    真因：序列号写在「设备实测夹具」这类**注释**里，形态上像技术细节、评审时极易放过；而它在
    **HEAD 中零出现**——「HEAD 零命中」不是安全证据，因为**新增即引入**：
    泄漏判据必须是「会不会进提交面」，不是「历史里有没有」。

    修法：统一写**仓内既有惯例的抽象表述**「MuMu x86_64 模拟器 / Android 15 / API 35」；
    端口 `127.0.0.1:16384` / `:16416` 是既存公开约定（`shell-ops.test.mjs` 等已在用），可保留；
    `emulator-55xx` 形态的 serial、boot_id、本机绝对路径一律不写。
    **本文自己就是反例**（本条初稿把 serial 逐字写进了公开仓，自查时才发现）——记述这类缺陷时
    必须用占位式（`emulator-<端口号>`）而不是逐字复述，否则「讲泄漏」的文档本身成为泄漏源。

    复验（只扫**会进提交的面**，别扫本地产物）：
      `git ls-files`（已跟踪）∪ untracked 且**未被 gitignore**（`git check-ignore` 不命中），
      再 grep 该 serial 形态。**不要**对全树 `Get-ChildItem -Recurse`：`.kotlin/errors/`、
      `.deploy-tmp/`、`build/` 这类本地产物会淹出数十处噪声（本轮实测 87 处），把真泄漏埋掉。

    配套铁律 5：**逐字节镜像（robocopy）前先确认源侧已脱敏**——镜像会把源侧的序列号原样搬进公开仓。
    本轮 `plugins/dsh-android-manage/**` 的镜像就曾把 coord 侧的 serial 带进 apk 工作树
    （3 文件，其中 `test/a11y-routing.test.mjs` 是 TRACKED），故正确顺序是「先脱敏源侧 → 再镜像 →
    再校验双仓逐字节一致且公开仓 serial 命中为 0」。
    gitignore 的 `plugins/*/lib/` 会覆盖 `lib/*.revbak` 等未跟踪产物，那类不入库、无需处理。

158. **补偿动作（catch 里的回滚/清理）会掩盖真因：`deletePath` 逐项容错 → move 到非空目录 → 次生异常取代原始异常（0.14.1 升级路径 P0 实测）**：
    现象（16384 覆盖安装 0.14.0 → 0.14.1）：`.snapshot-transaction` 永久停在 `phase=SWAPPING`（27 分钟不收敛，
    AGENTS 窗口 8–12 分钟），残留 `.snapshot-previous` 922MB + `.snapshot-stage` 160MB，**live 插件树只剩 1/10**
    （`@dsh-android/` 仅 `dsh-android-browser`）→ `dsh-host-web-compat` 缺席 → polyfill 未注入 →
    页面 `Failed to load plugins: … Iterator is not defined`。引擎活着、页面能开，**但插件面整体不可用**——
    比「全旧」或「全新」都糟，因为没有任何用户可见的「升级失败」提示。
    真因（栈已定位到行）：`SnapshotTransaction.mergeProfiles` 的 catch 块旧实现是裸三行
    `deletePath(liveProfiles); move(previousProfiles, liveProfiles); throw t`。而 **`SnapshotFs.deletePath`
    是逐项容错的**（删不掉的子项记 `onFailure` 后继续遍历）→ 它可能**正常返回而目录仍非空** →
    紧接着 `move` 到非空目标抛 `FileSystemException: … Directory not empty`。该次生异常**取代了 `throw t`**，
    于是**原始异常（真因 + 栈）被彻底掩盖**：logcat / 日志里只剩 `Directory not empty`，排障者拿不到真正的失败原因。
    连带：`EngineManager.refreshSnapshot` 的 rollback 走同一路径也失败 → 走
    「rollback failed; recovery marker retained」→ marker 永久留存、**每次启动重试、每次同样失败**（实测重启 3 次仍 SWAPPING）。
    修法：① **补偿一律不得取代真因**——补偿用 `try/catch` 包住，次生错误 `addSuppressed` 到原异常上、
    始终返回/抛出原异常；② **删除失败必须有兜底**——目标仍非空时不再 move 到非空目录，改为把目标
    **改名挪开**（改名只动父目录项、不递归子项，是文件系统层面最后可用的手段）。
    复验：行为级单测 `mergeCompensationNeverMasksTheOriginalFailureAndRecoversTheBackup`（构造 previous 缺席
    使补偿必然失败 → 断言交回的是**原始异常**且次生错误进 suppressed）；反证把 `addSuppressed` 换成
    `throw compensation` → 判红并打印
    `expected same:<IllegalStateException> was not:<NoSuchFileException …>`。
    **为何极易漏测**：全新安装（`uninstall` → `install`）**不触发**该路径，只有**覆盖安装**才走 `swap + mergeProfiles`——
    必须专门跑升级路径。
    配套教训（诊断面）：`refreshSnapshot` 只回布尔值，调用方只能写「返回 false」，导致 `boot-fail.log` 出现
    `error=none(boolean-failure-path)` 这种**不可排障**的形态（用户反馈一「日志与事实不符」的同形复发）。
    故「布尔返回值」的失败 API 必须另设**真因出口**（本例 `EngineManager.lastRefreshFailure`），否则等于没日志。
159. **「修了但没修」：两处写同一个裸字符 = 恒等替换，而单测类路径上的另一份 org.json 让断言假绿（0.14.1 执行地图排查实锤）**：`jsString` 号称把 U+2028/U+2029 转成 `\uXXXX` 文本，实际 `AndroidBridge.kt:420-422` 的 `.replace(<裸 U+2028 字符>, "\u2028")` 在 Kotlin 里两侧编译成同一个裸字符 → 返回原串；而 JVM 单测类路径上有 `org.json:json`（其 `quote()` 自己会转义行分隔符），断言「结果里没有裸字符」依然通过 → **生产没修、单测绿**。真因：① 源码里 `\\u2028` 与 `\u2028` 只差一个反斜杠，写文件时反斜杠被折叠过多次（本仓有前科）；② 断言测的是「结果形态」而不是「替换发生了」，两种实现都能满足。修法：方向定型为「裸字符 → 转义文本」，抽纯函数 `escapeLineSeparators(quoted)`；单测直接判形态（`assertNotEquals(raw, escaped)` + 期望 `a\u2028b` 的转义文本形态）再叠加端到端断言。复验：`./gradlew :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.BrowserHostNavigationPolicyTest"` 9 例 0 失败。**教训：被测函数依赖第三方实现时，只有纯函数面的形态断言才是真判据。** grep `escapeLineSeparators`。
160. **JS 字符串字面量里的 `\w`/`\d` 有被吞风险：正则静默失效，门禁「在跑」其实什么都没查（0.14.1 建执行地图门禁时实锤）**：`new RegExp('([\w.@-]+\.(?:kt)):(\d+)')` 落盘后反斜杠消失，正则变成要求字面 `w` → 锚点一个都匹配不到，而 `--self-test` 反而更容易全绿（「没有命中」被当成「没有违规」）。修法：**字符串里完全不写反斜杠**——`\w` 用 `A-Za-z0-9_`、`\d` 用 `[0-9]`、`\.` 用 `[.]`；自检必须带「正例必须命中、反例必须不命中」的判别样例。复验：`node scripts/check-code-map.mjs --self-test`（8 例全绿）。grep `PATH_GROUP`。
161. **把「尚未探测」渲染成「未就绪」= 让模型放弃一个可用能力（0.14.1 设备实测，缺陷 A1）**：用户会话里状态区显示「Shizuku 特权通道：已授权」且虚拟屏已建成，而同一时刻工具面 `android_capabilities` 报「Shizuku 特权通道：未就绪（**虚拟屏建屏需要它**）」。模型的下一步推理逐字是「Shizuku isn't ready, which means I can't create a virtual display」——**它据此绕开了当时完全可用的路径**。
    真因：工具面读 `svc.shizukuReady()` → `controlQueue.stats().caps.shizuku`，而 `caps` 只随**执行过的控制 op 的回执信封**抵达（`ControlQueue.noteShell` 的唯一调用点在 `POST /api/android/ui/result`）；`android_capabilities` 自己不入队 ⇒ 会话首次询问它时 caps 必然缺席，旧实现把这个「缺席」折成 `false` 并渲染成「未就绪」。壳侧真值一直是活的（`VdisplayController.status → ShizukuTransport.status` 每次重探）。
    修法：**三态**（`true` 就绪 / `false` 已实测未就绪 / `undefined` 尚未探测到）+ caps 缺席时引擎补探一次（`AndroidPrivilegeService.shizukuChannelProbed()`：TTL 内只打一发、探测失败保持 undefined、绝不降级成 false；补探用 `vdInfo`——它**不在** `TIER_REQUIRED_OPS` 内，注释明写「读面/管理面不纳入」，故无需会话档位）。三分文案里「未知」必须给出**可执行动作**（直接试建屏），不得劝阻。
    复验：`node --test plugins/dsh-android-bridge/test/{capability-gate,shizuku-caps-probe}.test.mjs`；反证是「探测失败必须仍为 undefined」与「三态必须是三条不同文案」。grep `shizukuChannelProbed`。
162. **两份「会读设备屏的 op」清单漂移 → 缺省范围下大面积工具不可用，而两侧都自认正常（0.14.1，缺陷 B4/B6）**：引擎 `screen-scope.ts` 的 `REAL_SCREEN_CONTROL_OPS`（8 条）与壳侧 `DeviceControlService.REAL_SCREEN_OPS`（**11** 条）不一致，多出的 `state`/`webSnapshot`/`webAction` 是 `control-policy.ts` 的 `A11Y_OPS`（**后端能力**清单）的陈旧拷贝，与「是否读设备屏」无关：`state`（`handleState`）只回内存快照代次/失效标记且**签名不收 args**，`web*` 的目标是壳自有 WebView。
    后果链：这三条都不带 `screenId` ⇒ 壳侧范围门取默认 `real` ⇒ `virtual-only`（**缺省即此**，fail-closed）下恒拒。于是 `android_web_dump`、`android_ui_click`/`android_ui_input` 的 WebView ref 路径、以及点击**生效校验**（`verifyClick` 读 `state`）在缺省范围下一律报 `screen-out-of-scope`——用户看到的「点击成功但校验被阻止」「virtual-only 和不存在一样」有一半出自这里。
    修法：**壳侧收敛到 8 条**（不是把引擎扩到 11——那只会把过度拦截搬进引擎层），并新增 `scripts/check-op-registry-parity.mjs` 把两份清单锁成逐条相同（跨语言契约，不是实现细节）。复验：`node scripts/check-op-registry-parity.mjs`（自证含「壳侧多 3 条」这个原形反例）。grep `REAL_SCREEN_OPS`。
163. **工具声明了它执行不了的参数：`android_act_input` 的 `screenId` 永远无法兑现（0.14.1，缺陷 B1）**：该工具在参数表里声明 `screenId`（并因此进 `SCREEN_ACTIONS` 被范围门裁决），执行面却是 `input <verb> <args>`——`/system/bin/input` **没有屏幕维度**；范围门对这条命令在 `bridge/index.ts` 直接早退（命令里没有任何目标屏 token，无从核对注册表）恒判拒绝。模型于是反复重试一个不可能成功的参数。
    同族第二种形态：`android_ui_tree` 收 `screenId` 但只有 `uiautomator dump` 一条路，而 `uiautomator` 家族的目标屏参数被判为「无」⇒ 恒拒（本仓设备读数曾把 `uiautomator dump --display 10` 当成功证据，见坑 165）。
    修法：act_input 目标为虚拟屏时改走既有 `vdInput`（`input -d <displayId>`，argv 原生构造，text 作单个 argv 元素直传故不受 ASCII 白名单限制）；`ui_tree` **删掉** `screenId` 参数（它本就只能读默认屏），范围门据 `requested=undefined` 判 real，virtual-only 下给出「当前范围不含真实屏 + 改用 android_ui_dump」的可执行文案。
    复验：`node --test plugins/dsh-android-manage/test/a11y-routing.test.mjs`（含「虚拟屏路径不得再拼真实屏 input 命令」「不带 screenId 的原路径不得被改坏」「壳侧拒绝不得谎报成功」）。**判据：工具声明的每个参数都必须有一条能兑现它的执行路径。**
164. **`am` 退出码 0 ≠ 落在目标屏；且 16 KiB stdout 上限会把虚拟屏那一段吃掉（0.14.1，缺陷 C1）**：跨屏拉起修复前只判 `result.optBoolean("ok")`（=走 Shizuku UserService 的 `Process.exitValue()==0`）就报「已拉起到 virtual-N；真实屏前台不变」。设备实测（MuMu x86_64/API 35）：目标包已在真实屏有 task 时，`am start --display 2 -n <comp>` **仍回 0**，只多打印一行 `Warning: Activity not started, intent has been delivered to currently running top-most instance.`——这句话在成功分支被丢弃（只读 `ok`，不读 `stdout`）⇒ **假成功**。
    第二个坑在取证手段本身：回读要用 `dumpsys activity activities`（42 KB），而 `ShizukuUserService.exec` 的 `OUTPUT_LIMIT = 16 * 1024` 且**读到上限就 break**；display 段按号**递增**排列 ⇒ 截断掉的恰好是虚拟屏那一段，回读会得出**反向错误结论**。修法：服务端先过滤（固定字面量 `dumpsys activity activities | grep -E '^ *Display #|ActivityRecord'`，实测 1,969 B），再按 `Display #<n>` 分组 + `ActivityRecord{` 行 + `包名/` 精确前缀解析（**不得**用 Task 行的 `A=…:pkg` affinity 判落点）。
    三态如实回报：包在目标屏 → `vd-launched`；只在别的屏 → **`ok=false` + `vd-launch-denied`**（带 `landedDisplayIds`）；读不到 → `vd-launched-unverified`（明写「不构成落点证明」）。复验：`./gradlew :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.VdisplayLaunchLandingTest"`（6 例，样本取自真实设备输出）。grep `displaysRunning`。
165. **`uiautomator dump --display <n>` 会被收下但不生效：本仓曾把真实屏的树当虚拟屏证据（0.14.1 判定性实测）**：`known-gaps.md` 曾记「`uiautomator dump --display 10` → 1916 B 真实节点表」并据此讨论 a11y 可达性。2026-09-19 判定性实测（虚拟屏 `virtual-1` displayId=2、其上已放 Settings 且 `dumpsys` 确认 task 在 display 2）：无参 dump / `--display 2` / `--display 0` 三者输出**逐字节相同**（7799 B、19 节点、全是真实屏上的应用），即 `--display` 对 uiautomator **无效**——它恒 dump 默认屏。
    结论：`screen-scope.ts` 把 `uiautomator` 家族的目标屏参数判为「无」**实质正确**，不得放开；要修的是上层工具面（见坑 163）。**教训：把「命令没报错」当成「参数生效」是同一类误读——判定性实测必须让两个取值产生可区分的输出**（彼时虚拟屏是空的，空 vs 满本可区分，却没有做这一比）。
166. **从 Git Bash 跑构建链会触发「假红」：子进程 `tar` 变成 MSYS 版，把 `D:\…` 当远端主机（2026-09-19 两次打包实锤）**：在 Git Bash 里 `pwsh -File scripts/build-apk-013.ps1 -Fast`，PATH 里 `/usr/bin` 在前的 `tar` 被注入完整性门禁继承，于是 `tar -tf D:\coding\...\snap-final2.tar.xz` 被 GNU tar 解析成「主机 `D`」，报 `tar: Cannot connect to D: resolve failed` → 门禁判「注入产物成员不完整」并拒绝打包。**这不是缺陷，是环境**：同一棵树在 PowerShell 里跑全链是绿的。
    修法（二选一）：① 把构建链放在 **PowerShell** 里跑（推荐）；② 必须在 Git Bash 里跑时，显式把 Windows 目录提前：`PATH="/c/Windows/System32:/c/Windows:$PATH" pwsh -File scripts/build-apk-013.ps1 -Fast`（这样 `tar` 解析到 Windows bsdtar）。
    同族陷阱（同一轮踩过，一起记）：`robocopy` 的参数 `/MIR /XD` 会被 MSYS 路径转换吃掉（报 `ERROR 2 ... plugins$p\`，rc=16 一文件未拷）→ 加 `MSYS_NO_PATHCONV=1` 且**用正斜杠**写源/目标（`robocopy "plugins/$p" "dsh-mobile-apk/plugins/$p" /MIR /XD node_modules`）。**判据：打包失败先看报错是不是「路径/工具被解释错」，再怀疑代码——本轮两次都不是代码问题。**
167. **渐进披露的解锁前置对模型不可见：模型如实报「工具不存在」，用户看到的是「工具全不可用」（2026-09-19 设备实测，用户第三问的另一半真因）**：`capability gate` 在 `agent/created` 时把 `DEVICE_TOOLS` 全部掩蔽，只有模型**主动调用 `android_capabilities { group }`** 才逐组解锁；而组锁存在内存里 ⇒ **引擎每次重启（重装/崩溃重启/换版本）都重置**。实测现场（MuMu x86_64 / MiMo 2.5 / 新装包）：用户（与套件）说「把应用拉到虚拟屏上」，模型的回答逐字是
      - 「DONE — `android_app_launch` **不在当前可用工具列表中**，无法执行。」
      - 「DONE — but the required tool (`android_shell_exec` or `android_ui_click`) **is not available in my current environment**, so the click could not actually be executed.」
      **它没说谎**：那一刻工具列表里确实没有 `android_*`。用户看到的现象因此是「各种工具在 virtual-only 状态和不存在一样完全不可用」——与范围门、通道状态都无关，纯粹是**解锁前置没有被工具面暴露出来**。弱模型（本项目专用测试模型 MiMo 2.5）不会自己去读 skill 目录猜出这一步；强模型可能靠 `android_capabilities` 的存在硬撑过去——这正说明「拿强模型验收」会掩盖该缺陷。
      当前处置（不改设计、先让验收可跑）：设备套件在任务文案里显式写明「先调 android_capabilities 解锁 phone 与 virtual-display 组」这个**环境前置**（`verify-screen-scope-matrix.mjs` 的 `UNLOCK_PRECONDITION`）。
      **未修的真缺口**：解锁应有**可发现性**——候选修法：① facade 工具的描述里直写「设备工具默认掩蔽，先调我」；② 首次 `agent/created` 时不掩蔽、改为按首次调用自动解锁；③ 在工具列表里保留一个不可调用的占位说明。三条都要另做取舍（涉及 wire 预算与「模型第一眼看不到设备工具」的原设计意图），故本轮只登记，不擅自改。
168. **「只有 ADB / 纯 Shizuku」下控件树曾经只有一条烂路：`android_ui_tree` 只回 XML 文件路径（2026-09-19 用户实报 + 本轮实修）**：用户口径「猜像素就是折磨」，要求 `android_ui_tree` 做到**与无障碍同等体验**。修前实测该工具的成功返回只有 `treeXmlPath`（一个本地文件路径）+ 一句「控件树已导出」，**既不产出 ref、也不写 `uiCache`**，因此模型拿到它之后**无法用 `android_ui_click/scroll/input` 按 ref 操作**，只能自己读 XML 或猜像素——而它的描述又写着「【ADB 专属 / 兜底】……日常优先 android_ui_dump」，在纯 Shizuku（无障碍关）下 `android_ui_dump` 恒不可用，等于把模型支去撞墙。
    真因是**接线缺失，不是能力缺失**：uiautomator XML 的解析器与剪枝/落明细/写缓存管线**早就存在**（`plugins/dsh-android-manage/src/ui-tree.ts` 的 `parseUiTreeXml`/`checkUiTreeParse`/`pruneNodes`），只是 `android_ui_dump` 的 ADB 回退在用、`ui_tree` 没用。
    修法（单一来源，禁止两份实现）：把那条管线抽成 `uiautomatorTree()`，**两个工具共用**；schema 抽成 `TREE_SCHEMA`、行渲染抽成 `nodeListLines()`，`treeOutput()` 两处共用——「同等体验」因此是**构造上成立**的，不靠两份代码保持同步。描述改为「ADB / 纯 Shizuku **主路**」，明写「无障碍未开启时这就是控件树的唯一来源」与「只读默认屏（虚拟屏走别的路）」。
    判据（可判红，`plugins/dsh-android-manage/test/ui-tree-parity.test.mjs`）：① **同形**——两工具的 `output.schema` 逐字段深度相等（漂移即回归）；② **可用**——无障碍关时 `ui_tree` 返回节点数组、`count===nodes.length`、带 `detailHandle` 与每节点中心坐标；③ **可操作**——清单里的 ref 经 `android_ui_click` 必须恰好注入一次 `input tap <cx> <cy>`（模型只报 ref，**像素由引擎算**）。
    实现坑（同轮踩过）：共享 output 一旦把 schema 根放宽为 `json`，`render` 的参数就会被上下文推断取代——**独立 const 的 render 拿不到上下文类型会退化成隐式 any**，参数显式写成 `unknown` 才逆变兼容；另外 `schema` 抽取时别把外层的 `schema:` 包装一起套进去（运行时会报 `UNSUPPORTED_SCHEMA`，而 TS 因为 `as unknown as` 完全不报）。
169. **通知消费只靠一次文件事件：事件一丢就永久停摆，而「另一个消费者还活着」把现场伪装成正常（0.14.1 真机实报 + 本轮实修）**：真机（V2425A / arm64 / SDK 36）上用户报「消息有但不弹横幅；必须划到后台才收到」「悬浮球长按查看汇报没有内容」。取证三份文件给出**同一个**形状：`files/home/.dsh/.notify.ndjson` 从 8810 长到 9402 B（引擎确实写出了 `kind=report` 行），`shared_prefs/dsh-notify.xml` 的 `notify.offset` **冻在 8810**，`files/notify-responder.log` 里没有任何 `kind=report` 的投递记录。即「文件在长、指针不动、一条也不投」——而同一时刻 `WatchdogV2` 的 `notify-debug.log` 还在按时更新，于是「通知面整体是活的」这个假象成立。
    **真因（结构性）**：`NotifyStore.drain` 的触发点只有两个——`FileObserver` 的事件回调与进程启动时那一次；`NotifyStore` 内**没有任何 Timer/Handler/协程**。一次事件丢失（watcher 构造失败被吞、落盘方式换成「临时文件 + rename」而位集只有 `MODIFY|CREATE`、目录 inode 被换掉导致 inotify 监视静默失效——快照重解包就会重建 `files/home/.dsh`）即**永久停摆**；而 poll 驱动的 `WatchdogV2.consumeTaskDoneMarkers` 照常工作，正好解释「旧信道还活着、新信道死了」的不对称。
    **可控复现（无需等真机复发，MuMu x86_64 实测）**：给同一个 inode 建第二个目录项，从那个名字追加——事件名不是 `.notify.ndjson`，白名单直接忽略，而文件长度确实在长：
    ```bash
    S=127.0.0.1:16416
    adb -s $S shell "run-as com.dsharnessmobile.shell ln files/home/.dsh/.notify.ndjson files/home/.dsh/.notify-inject"
    printf '%s\n' '<一条真实的 report 行>' | adb -s $S shell "run-as com.dsharnessmobile.shell sh -c 'cat >> files/home/.dsh/.notify-inject'"
    # 20 s 后：文件 8733 -> 9064 B，而 notify.offset 仍是 8733，探针零 dispatch  ← 复现成功
    ```
    修法（三条互补，缺一条都不够）：① **兜底驱动**——`NotifyStore.drainTick` 挂到**既有看门狗 tick**（`EngineService` 每 5 s 一拍、持唤醒锁，且是现场唯一被证实还活着的消费者），不自起 Handler（多一处生命周期 = 多一处和事件一起死的东西）；② **监听位扩到 `MODIFY|CREATE|CLOSE_WRITE|MOVED_TO|DELETE|MOVED_FROM`** + 白名单命中 `FILE_NAME`/`ROTATED_NAME`/`path==null`；③ **`drain` 加锁 + 先投递再推进偏移**（三个驱动者并发跑同一份 offset 会重复投递——现场实测同 id 80 ms 内被投 5 次；先推进再投递则会静默丢）。
    取证面同时补齐：每行消费记 `notify drain trigger=<start|tick|watch:名字> … offset a->b len=n`，tick 每 5 分钟记一行 `notify tick alive ticks= lag= watchEvents= watchEventAgeMs=`——**「文件在长但 watchEventAgeMs 一直很大」就是 watcher 失聪**，这一对读数把下次复发的定位从「三份文件对表」压到一行。
    判据（可判红，`NotifyConsumptionStallTest.kt` 五例 + `NotificationContractTest.消费必须有事件之外的兜底驱动`）：①监听位必须含 `MOVED_TO`/`CLOSE_WRITE`（旧位集必红）②`drainStep`/`advanceOffset` 的 Skip/Rotated/Read 与单调性③同 id 同内容窗口内判重复、内容变/窗口外/换 id 不判④尾部倒读只取最后一条 report 行且丢弃被截断的首行；**外加源码级断言「兜底入口写了必须真被 tick 调用」**——防「兜底写了没人调」这类新型假绿。
170. **`seedPhoneControlPreset` 对缺席文件直接 `readText()`：phone-control 预设在任何**干净安装**上恒「加载失败」，且每次启动重试都不自愈（0.14.1 真机实锤，本轮实修）**：预设页「自定义」下 `phone-control` 恒挂红标「加载失败」，文案逐字为 `the composition file agent.cordis.yml is missing — the directory still occupies the id; delete it or restore the file`。
    取证三份事实**互相排除**：① `logcat` 有 `W dsh-engine: phone-control preset seeding failed` + `java.io.FileNotFoundException: …/.agent-presets/phone-control/skills/phone-control/SKILL.md: open failed: ENOENT (No such file or directory)` + `at com.dsharnessmobile.shell.EngineManager.seedPhoneControlPreset(EngineManager.kt:475)`，且**每次引擎启动都在同一行重炸**（实测某次启动的 9 ms 内连发 4 轮）；② `.agent-presets/phone-control/` 四个层级目录的 mtime **精确到纳秒完全相同**（= 一次 `mkdirs()` 的产物）、目录内**文件数为 0**；③ 以**同一 uid** 手工向同一路径写文件**成功**，`/data/user/0/…` 与 `/data/data/…` 两种写法均可 ⇒ **不是权限、不是属主、不是路径解析**。
    真因：`if (skillFile.readText().trim() != PHONE_CONTROL_SKILL.trim())` —— `File.readText()` 在文件缺席时**抛 `FileNotFoundException`**（不是返回空串，Kotlin 没有「读不到给默认值」的语义）。该异常被本函数外层的 `catch (t: Throwable)` 吞掉，函数**当场返回**，于是它后面的三步**一步都没跑**：`customSkillDirs` 注入、`agent.cordis.yml` 从内置 `standard` 预设拷贝、`preset.yml` 写入。而函数末尾的幂等早退判据正是 `if (File(dir, "preset.yml").exists()) return` ⇒ `preset.yml` 永远写不出来 ⇒ 每次启动都从同一行重炸，**永不自愈**（这是确定性死锁，不是偶发）。
    回归出处：#141「fix: phone-control 预设 SKILL 每次启动刷新」把播种语义从「**只在缺失时**播种」改成「**每次启动刷新**」，顺手假设了文件一定在场——而它的验证写的是「**设备侧已热修验证**（`SKILL.md` 含 `android_ui_global`，grep=1）」，热修的前提恰恰是**那台设备已经有这个文件**（#138 播过种）⇒ **干净安装路径从未被测**。#190 在同一段之后追加 frontmatter 与 `customSkillDirs` 注入，验证括号同样明写「存量升级路径验证」，也够不着这条路。**教训：把「刷新」从「缺失才做」改出来时，必须专门验一次「目标不存在」的初态；热修验证天然带着已存在的现场，不能当干净安装的证据。**
    修法：先判在场再读，缺席视同「需要刷新」——`val existingSkill = if (skillFile.isFile) skillFile.readText() else null`，随后 `if (existingSkill?.trim() != PHONE_CONTROL_SKILL.trim())`。
    判据（可判红，`CallSiteContractTest.phoneControlSeedingToleratesAnAbsentSkillFile`）：① 真源表达式 `if (skillFile.isFile) skillFile.readText() else null` 必须在场；② 裸读形态 `skillFile.readText().trim() != PHONE_CONTROL_SKILL` 必须消失——**撤掉守卫即红**。为何用源码契约而非行为测试：`seedPhoneControlPreset` 依赖 `Context`（`context.filesDir` / `context.assets`），纯 JVM 拿不到，与 `CallSiteContractTest` 头部自述的适用面一致；判据一律走 `memberBody` 取函数体（整文件正则跨进相邻成员会误报，见该类教训）。
    设备复验（真机实测，0.14.1）：补一份在场 `SKILL.md` 后重启引擎——`logcat` **首次出现**成功路径的两条日志 `phone-control preset seeded -> …` 与 `phone-control preset: customSkillDirs injected into skill-filesystem row`（修复前从未出现过），`agent.cordis.yml`（13054 B）与 `preset.yml`（187 B）落盘；`agent.cordis.yml` 与内置 `standard` 逐字 `diff` **只差注入的那 3 行（+126 B）**，故与能正常加载的 `standard` 同源，加载性有保障。**注意（勿写错）**：`customSkillDirs` 注入与播种在**同一次启动内**先后完成（19:51:22.825 播种 → .835 注入，间隔 10 ms），因为 `shellEnv()` 在启动路径上会被调用多次 ⇒ 函数第二轮即走到注入分支；不要写成「要下一次启动才生效」（初稿曾如此断言，实测推翻）。
171. **文件写工具在 Android 上建不了新文件：`createIfAbsent` 的 link(2) 没有回退，而退役记录以为上游早就覆盖了它（0.14.1 真机实测 + 本轮实修）**：真机上 `write` 工具报 `EACCES: permission denied, link '<目录>/.<文件名>.<pid>.<uuid>.tmpdir/<文件名>.tmp' -> '<绝对路径>'`，**而覆盖已存在的文件完全正常**——症状是「只能改，不能建」，很容易被当成偶发。
    **真因（结构性，三段链路）**：① `dsh-fs-observation-policy` 对「未观察过／确认不存在」的路径判写意图 `createIfAbsent`；② `dsh-fs-local` 把它透传进 `writeFileAtomic`；③ 该分支**只能**用 `link(2)` 做 no-replace 发布，`catch` 里直接 `throwGuardedCreateFailure` 抛出、**没有任何回退**（对照：覆盖路径走 `rename`，Android 上正常）。Android 应用域 SELinux 拒绝 hardlink（`EACCES`，denial 被 dontaudit 静默）——与坑位 #77 同一 sepolicy 限制的第 4 个站点。
    **判定性实测（三连 + 反证）**：`write` 新建失败 / `write` 覆盖成功 / `edit` 修改成功；同域内 `ln a b` 直接 `Permission denied`（排除 DSH 自身因素）。
    **退役记录为什么没接住**：RUNTIME-PATCHES §「已退役资产」写的是「`fs-local-index.js` 0.13.3 批退役——link(2) 回退族**改由构建期补丁承担**」，但 §7.1 构建期补丁表里**没有 `dsh-fs-local` 行**，且当前快照内 `dsh-fs-local/lib/index.js` grep 不到既有约定的回退标记 `dsh-mobile link->rename fallback`（0 次）。EngineManager 注释同轮的判断「fs-local（rename fallback is upstream-native）」对 0.1.5-rc.1 也不成立：上游把 `rename` 用在**替换**路径上（那是它的正常路径，不是回退），而后来新增的**独占创建**路径又裸用了 `link(2)`。
    **教训**：退役理由「上游已原生覆盖」必须**逐站点**核对，不能按文件整体判定——上游会往同一个文件里继续加新的 `link(2)` 站点。
    **修法**：`EACCES`/`EPERM`/`ENOTSUP` 时改用 **O_EXCL 占位 + rename** 等价实现 no-replace（**不得裸用 rename**：那会静默覆盖并发创建者的文件，把 `link` 的 `EEXIST` 语义变成死代码——这正是坑位 #170（补丁 `publish-exclusive-F7`）修过的形状）；`rename` 失败必须回收占位，否则留下 0 字节目标让之后每次创建都输掉占位竞争。构建期 `fs-local-link-F8` + 运行时 asset `fs-local-index.js` 双路同源。
    **判据（可判红，`scripts/patches/tests/fs-local-link-f8.test.mjs` 19 项）**：① 锚点与接线（权限错误才回退、非权限错误仍走原拒绝路径、`internals` 透传）② 行为三路——占位成功即 `rename` 发布且不回收、占位 `EEXIST` 走原拒绝路径且不 `rename`/不回收（独占语义保住）、`rename` 失败回收占位（带 `force`）并原样抛出；撤掉回退或改成裸 `rename` 即红。该测试支持 `--asset` 由 `check-runtime-assets.mjs` 直测资产本体。
172. **启动页 APK 自更新在 arm64 设备上恒失败：`assetName` 按开发脚本口径拼 `arm64`，而 GitHub Release 资产是 `arm64-v8a`（0.14.1 真机实锤 + 本轮实修）**：arm64 真机点「检查更新」不出现「下载并安装 vX.Y.Z」，而是失败文案 `检查失败：latest release v0.14.1 无 arm64 资产（dsh-mobile-apk-v0.14.1-arm64.apk）`；同一版本在 MuMu（x86_64）上完全正常。
     真因（两套 ABI 命名口径混用）：本仓 ABI 命名有两条互不相通的链——`scripts/build-apk-013.ps1`（本地/开发产物）出 `dsh-mobile-apk-v<版本>-arm64.apk`，`scripts/build-release.ps1`（GitHub Release 资产，按 `docs/RELEASE.md` 第 6 节约定 `abi = arm64-v8a | x86_64`）出 `dsh-mobile-apk-v<版本>-arm64-v8a.apk`。`UpdateChecker.assetName()` 的旧注释逐字写着「须与 scripts/build-apk-013.ps1 的 Copy-Item 命名逐字一致」，即按**开发口径**拼接，却在 `checkLatest()` 里拿它去匹配 **Release 资产名**；同一处注释还自称 `abi ∈ {arm64, x86_64}`，与发布约定直接矛盾。发布侧第 166 行的 ABI 表（`n='arm64-v8a'`）与测试 `assetNameMatchesBuildScriptProductName` 的断言（`…-arm64.apk`）把这个错误期望**固化了两遍**，两边各自自洽，静态门禁拦不住。
     **为什么开发循环看不见**：`x86_64` 在两条链上**同名**，只有 arm64 分叉；而 §2.1 的三层验收主跑 MuMu **x86_64**，真机只在发布前补充门禁 ⇒ arm64 这条分支**从未被走过**。`abiFrom()` 那条「带 ARM 翻译层的 x86 设备必须以首选 ABI 为准」的判据反而成了掩护——它保证 MuMu 走到 x86_64，恰好是唯一不踩坑的分支。
     回归出处（**本条已按实测更正**）：`arm64-v8a` 口径**不是** `c7600f5d` 引入的——该 commit 对 `scripts/build-release.ps1` 的 diff 里 `arm64-v8a` **零命中**（实测 `git show c7600f5d -- scripts/build-release.ps1 | grep -c arm64-v8a` = 0）。`git log -G"n='arm64-v8a'" -- scripts/build-release.ps1` 只命中 `cf05fe6`（2026-08-27，`feat: 云端构建自包含（从源重建快照，去除协调库依赖）(#93)`）与 `6a86590`，且 `git show v0.14.0:scripts/build-release.ps1` **已经是** `n='arm64-v8a'`。真正的偏差成因是**装配链换用**：`build-release.ps1` 的发布口径早在 2026-08-27 就存在，但 v0.14.0 的 Release 资产实测是 `-arm64.apk`（未用该脚本装配），**v0.14.1 才改用 `build-release.ps1` 组装 Release**（`release/v0.14.1/notes.md` 明写双 ABI `arm64-v8a` + `x86_64`），偏差因此在 0.14.1 暴露。三天后 `fix(0.14.1): 批 6 引导页/权限/更新` 又动了 `UpdateChecker.kt`，两处命名始终未对齐。**该归因更正不影响代码修复的正确性，但会误导后人定位，故一并改。**
     修法：`assetName()` 归一到**发布口径**——`val releaseAbi = if (abi == "arm64") "arm64-v8a" else abi`；同时把 `abiFrom()` 与 `assetName()` 的注释改成各自真实职责（前者是**设备 ABI 家族名**，后者才是**发布资产名**），消除「开发口径即资产口径」的暗示。`abiFrom()` 的逻辑与既有断言**一律不动**（其翻译层判据仍然成立，改动面越小越好）。
     判据（可判红，`UpdateCheckerTest.assetNameMatchesReleaseProductName`）：① `assetName("v0.14.1","arm64")` 必须等于真实发布资产名 `dsh-mobile-apk-v0.14.1-arm64-v8a.apk`，且无 v 前缀的 `"0.14.1"` 归一到同一名；② `x86_64` 两侧同名，不受影响；**撤掉映射即红**（回到 `…-arm64.apk`）。该测试是纯 JVM 逻辑，不需要设备即可跑。
     替代验证（本轮无法构建/跑 Gradle，如实记真因）：把 `abiFrom`/`assetName`/`isNewer` 的纯逻辑等比移植到 Node 逐例复算——既有 16 条 `isNewer`/后缀断言 + 4 条 `abiFrom` 断言 + 新增资产名断言共 **23 例全绿**；并以真实 v0.14.1 资产名做命中对照，复现「arm64 未命中 / x86_64 命中」，修后 arm64 转命中。**构建与三层验收（CDP + ADB 真机）仍需在开发机补跑**——本条只完成了代码层。
173. **快照内 git 的编译期 SHELL_PATH 等长重定位：落点必须晚于 7d（git.real 是那一步才诞生的），且白名单内绝大多数是符号链接（apk#247，0.14.1 真机复现 + 本轮落到产出链）**：git 的 `credential.helper`、`!` 前缀 alias、hook、`rebase --exec` 一律经 run-command 走 shell，而 shell 取的是**编译期写死**的 `SHELL_PATH=/data/data/com.termux/files/usr/bin/sh`（38 B，应用域不存在）⇒ 它们全部 `fatal: cannot exec ... No such file or directory`。真机上 `git --version` 正常，症状只在用到 helper 时才现，故长期被「git 存在且能跑」掩盖。
     真因（三类编译期路径里唯一没有运行时覆盖点的那个）：`--exec-path` 有 `GIT_EXEC_PATH`（0.13.0 的 `usr/bin/git` wrapper 已覆盖，issue apk#80/#87）、CA 有 `GIT_SSL_CAINFO`，而 shell 路径**没有任何环境变量可改**；`run-command` 对凭据助手一律 `use_shell=1`，取的就是 `SHELL_PATH`。
     **落点（本轮修正的关键）**：必须放在 `build-snapshot-013.mjs` 的**第 7d 步之后**。`usr/bin/git.real` 是 7d 里由基座 `usr/bin/git` 改名而来（此前不存在，且会被 7d 的 `rmSync` + `rename` 覆盖），所以本步**不能**与 `fix-shebang.py`（第 6 步）同阶段——放那里会被 7d 抹掉。本轮新增第 **7d2** 步，实现为 `scripts/lib/git-shell-path.mjs`。
     **白名单内 152 个符号链接 + 1 个目录 = 153 个非实体条目（本轮实锤，措辞已按实测精确化）**：`libexec/git-core` 共 181 个条目、其中 **152 个是符号链接**（另有 1 个目录 `mergetools`、28 个实体文件）；模块统计的 `skippedLinks: 153` 把该目录也计入了「非实体条目」——**判定行为无误，只有措辞需要精确**。含旧串的 12 个里 5 个是链接，且 `git-shell -> ../../bin/git-shell`、`scalar -> ../../bin/scalar` **指向白名单之外**。枚举时必须用 `lstat` 只认实体文件——用 `stat` 会跟随链接，等于借白名单越权改写 `usr/bin/` 下的文件。实际命中实体 **8 个**（`bin/git.real` + 7 个 git-core 实体）。
     修法：**等长**原地替换——38 B 旧串换成 `/system/bin/sh`（14 B）+ 24 个 NUL 填充。文件长度与 ELF 节表/偏移全不变，故不违反 `relocate-snapshot.py` 头部那条「ELF 不做变长重写」的禁令。用白名单而非「所有含旧串的 ELF」：快照内另有 node / dash / make / tar.real 等二十余个 ELF 含同一字面量（多为 help 文本），不在本 issue 的因果链上，一律维持原状。
     判据（可判红）：① 模块级自证 12 项——白名单命中数、等长、幂等、尾部标记未破坏、非白名单原样保留、**符号链接被跳过且不被写成实体**；把 `lstat` 换回 `stat` 即红。② 设备端 `check-prefix-residue.sh` 新增 **P4b**（静态：`git.real` 内不得残留旧串）与 **P4c**（功能：`credential.helper` 真能被 shell 拉起）——原 P4 只判「git 存在 / `--version` 能跑」，而旧串在场时这两条一样是绿的，自检因此长期假绿。**P4c 必须带 `-c core.askPass=`**：否则 helper 执行失败时 git 会回退到 askpass，可能取到环境里真实存在的凭据，使断言假绿**且会把凭据打印出来**。
     **真机对照（本轮拿真品 git.real 做修前/修后）**：修前 `fatal: cannot exec 'f(){ ... }; f get': No such file or directory`；修后同一命令返回 `username=u`。8 个实体文件修后逐文件字节数与原文**完全相同**（`bin/git.real` 3,562,128 B、`git-remote-http` 2,010,824 B、`git-daemon` 1,950,560 B 等）。
     残留（勿当成已清）：① `pkg upgrade git` 会带回旧串（配方在 Termux 侧，快照侧改不了）——P4b 的静态断言正是为这种复发准备；② `/system/bin/sh` 是 Android 的 mksh 而非快照内 dash，`-c` 与 `!` alias 语义与 Termux 下略有差异，实测可用但不宜假设等价；③ 本轮只完成代码层（无 WSL 构建环境），构建 + 三层验收（CDP + ADB 真机）需在开发机补跑。

174. **上游 peer 门禁与 npm 解析用的是两套 semver 判据，caret 地板留在旧代会在安装期就炸（2026-09-24 追 0.1.7-rc.1 实锤）**：上游 `app-boot/src/plugin-compatibility.ts:77` 判兼容用 `semver.satisfies(runtime, range, { includePrerelease: true })`，而 **npm 自己解析 peer 时不带 `includePrerelease`** ⇒ 同一个 `^0.1.1-rc.2` 在运行时门禁里放行 0.1.7-rc.1、在 `npm install` 里却判不满足。叠上冻结载体就更狠：`@deepseek-ai/dsh-client-runtime` 只发到 **0.1.1-rc.2**（引擎主版本线从来不含它），它自带 16 条 `^0.1.1-rc.2` peer，把它拽进来的仓装 rc.1 时直接 `ERESOLVE`（实测 `plugins/dsh-android-vdisplay`），错误文案指向的却是「dsh-tools 的 peer dsh-agent」——真因在传递图上，不在被点名的那条边。
    **修法（两件，都不许留）**：① 追版时 caret **地板随版抬**（`scripts/bump-plugin-pins.mjs` 按 `contract.json` 一次性抬，形态保留），别只改精确钉；② 只为拿一个类型而依赖冻结载体 = 把一个时代的引擎图拽进安装面 —— 客户端类型按上游自身写法拿：`import type { Context as ClientContext } from '@deepseek-ai/cordis'`（见 `dsh/packages/client/locale/src/client/index.ts:7`），本仓 `dsh-client-ui-responsive` 一直就是这么写的，只有 bridge/vdisplay 两个入口当年抄了 `dsh-client-runtime/client`。
    **判据**：`scripts/check-contract.mjs` §7 拿**设备侧同一个 semver 库**在构建前复刻上游判定（`--runtime <不可满足版本>` 是它的反证档），§6 的 `contract-pin-gaps.json` 让「钉未对齐」必须显式声明、一旦对齐不删条目即红。教训半条：**写死版本号的反例会在抬版后静默失效**——本轮 `--self-test` 就有 2 例这么失效（§7 反例从「装成 0.1.7-rc.1」改成「装成 0.0.1-rc.1」，§9 反例改从 `contract.baseline` 取值），反证必须与进度无关才可重跑。

175. **面板宽度有两份公式而其中一份是死代码，转屏又没人重算——横屏体验与「窗口比内容宽」两类假象同源（2026-09-24）**
    **现象**：横屏（1600x900）上面板看起来「没用上多出来的宽度」；反过来在竖屏打开面板再转横屏，面板保持竖屏宽度；
    而代码里 `OverlayPanel.buildUnit()` 开头明明也算了一次 `width`（屏宽 - 64dp - 32dp，封顶 400dp）。
    **真因**：① 那个 `val width` 在 `buildUnit()` 全文**无人消费**（实测：`buildUnit` 作用域内 `width` 只出现在声明行），
    面板宽的唯一生效口径是 `OverlayService.showPanel()` 里给窗口的 `panelW`——两份公式（还互不相同）只有一份生效，
    留着会让后来人以为改它能改面板宽；② 两个 Activity 都声明 `configChanges="orientation|screenSize|screenLayout"`
    （不重建），`OverlayService.onConfigurationChanged()` 只重刷主题 + 球坐标 + `positionPanel()`，
    **从不重算窗口宽度**（`panelW` 是 `showPanel()` 的一次性局部量），`hidePanel()` 也不清 `unitView`，
    所以没有任何路径会在转屏后替它换宽——不是概率问题，是结构性无人负责。
    **修法**：① 删掉 `buildUnit()` 里的死 `val width`，宽度口径收敛到 `OverlayService.panelWindowWidth()` 单一函数；
    ② `onConfigurationChanged()` 在面板展开时按新屏幕重算 `pp.width` 并 `updateViewLayout` + 重定位。
    **同类（本条只修了汇报栏，会话选择器**未**改——见下面判据）**：抽屉/浮层窗口高度若只按
    `heightPixels` 取比例，横屏会被压没。`OverlayReport` 的 `maxH = sh * 0.40f` 已加 300dp 地板，
    并用「屏高 - 24dp」封顶（地板永不会把抽屉顶出可用屏幕）。
    同形态还在 `OverlayPanel` 的会话选择器：`maxH = screenH * 0.45f`（横屏 405px=270dp，约 6 行），
    但它是 **ScrollView 内的窗口高度**（列表可滚，不构成「条目够不到」），
    ⇒ 本轮**不动它**，等设备层量出「横屏可见行数 / 用户是否需要多次翻页」再决定，不凭比例猜。
    **设备几何实测（校准基准，勿沿用旧值）**：16416 `user_rotation=0`，natural `900x1600 @320dpi`
    ⇒ 可用 900x1600、density 2.0、450x800dp；16384 `user_rotation=1`，natural 同为 `900x1600`
    但 `@240dpi` ⇒ 可用 **1600x900**、density 1.5、1066x600dp。
    注意 `wm size` 报的是 **natural** 尺寸（两台都显示 900x1600），横屏只能从 `user_rotation` 与
    `dumpsys window` 的当前 frame 判读——照 `wm size` 判断方向会得出「两台都是竖屏」的错结论。
    **判据**：几何类改动必须过竖屏 16416 与横屏 16384 两个方向的 tap 级实测（AGENTS §2.1.6）——
    DOM/CDP 断言看不见这类缺陷（§2.1.4）。

176. **退役 combo-lazy-A4：它的收益声明是 0.1.5 时代的量级，上游 0.1.7 惰性化之后结构性无对象；撤它时又牵出 C5 的两条门禁缺陷（2026-09-25）**
    **现象**：`combo-lazy-A4`（engine 补丁：把 `compose()` 推迟到首个图读者、启动期 flush 只标脏）账面收益是
    「9-14 次全表重算（单次 1.8-3.1s，占 LISTEN 墙钟 88%）收敛为 1 次」，看起来是启动性能支柱。实测却不成立。
    **真因（三支）**：
    ① **收益的量级属于旧代上游**。0.1.7 已把 combo 载荷原生惰性化（`dsh/packages/client/modules/README.md`
    「creates combo descriptors without building response bodies」；`src/index.ts:384 lazyBody`），单次
    compose 只剩个位数 ms（设备真值 5-9ms），「2.8s × 9-14 次」的对象不存在。
    ② **裸树只 compose 2 次，不是 9-14 次**（同基线 0.1.7-rc.1 离线 A/B，双臂零 failures）：构造函数先空表
    `this.composed = this.compose()`（records=0，2.27ms），随后 flush 带真记录再 compose（records=67，3.97ms）。
    A4 省掉的是**空表那次**，并把带真记录那次从构造期挪到**首个图读者**（= 首个页面请求路径）。
    A4 臂 1 次 5.79ms ⇒ 总量与裸树同量级，**位置反而更靠近 TTFB**（实测 HTTP−LISTEN 竖屏 557ms / 横屏 1472ms），
    属「位置为负」。
    ③ **撤它时发现 C5 门禁本身是空的**（两条独立缺陷）：(a) `parseProbe` 的
    `/\[perf\] boot singles=(\d+|n\/a)/` **缺 `-1` 分支**，而 P1 在计数缺席时故意打 `singles=-1`（绝不省字段）
    ⇒ 解析返回 `undefined`，C5 对设备真值**恒不可判定**；(b) C5 的正向对照只认
    `globalThis.__dshMobileComboLazyStats.singleBuilds`——那是**已撤销的 A5** 装的计数器，A5 退役后它
    **没有任何生产者** ⇒ 对照永远「没跑起来」，于是「boot singles 恒 0」这条断言在任何环境下都不构成证据。
    **修法**：① registry 31 → 30 条，`apply-patches.mjs` IMPLS 移除 A4 全符号（`ensureComposed` / `composeDirty`），
    `combo-probe-P1` 的 `requires` 清空（P1 保留：C2/C4/C6 仍消费它）；② C5 解析补 `-1` 分支；③ 正向对照改落
    **上游自己的惰性契约**——离线直驱打过 P1 的引擎树，断言单条 URL 命中 200 + 载荷含该 id + `body()` 两次
    调用返回**同一 promise**（`lazyBody` 的 memoize 契约）；④ C5 判据改三态（`0` → 惰性成立；`> 0` → 判红；
    `-1`/缺读数 → 由正向对照裁定，对照真跑通过即等价成立，跑不起来如实 SKIP），**既不恒绿也不恒红**；
    ⑤ C3「compose ≤ 2」**不放宽**（裸树正是 2 次，阈值仍可满足，注释改写明裸树事实）。
    **判据（可证伪）**：① `node scripts/check-boot-budget.mjs --self-test` 必须全绿，且其中 5 条新用例钉住
    C5 四态——「`-1` + 对照跑过但失败 → 判红」证明判别力没因三态丢失；② 真数据跑
    `node scripts/check-boot-budget.mjs --segments … --probe …`：设备真值 `singles=-1` 时 C5 由 SKIP 转 PASS
    （SKIP 1 → 0）；③ 回归测试 `combo-lazy-a4.test.mjs` 已改写成「撤销不变量守卫」，把 A4 id 塞回 registry 即
    判红（实测 2 项失败），还原即绿。
    **为什么记进坑位**：「补丁的收益声明会随上游版本过期，但补丁自身不会自动消失」——退役判据必须落在
    **同基线 A/B 实测**上，而不是补丁注释里那句当年成立的数字；连带发现的门禁缺陷还说明「门禁的正向对照
    依赖一个会退役的补丁符号」本身就是漂移源。

177. **热推脚本（hot-push.mjs）长期「自称可用、实际每个落点必失败」：adb push 建的 stage 目录对 run-as 身份不可列目录（2026-09-26）**
    **现象**：`node scripts/hot-push.mjs --serial 127.0.0.1:16416 --plugin plugins/dsh-android-vdisplay` 恒失败，
    两个 profile 落点都报 `cp: /data/local/tmp/dsh-hot-push/lib/.: Permission denied`，退出码 1。
    脚本头注释与实际用法都宣称它可用，而它**从来没有成功过**——因为没人真跑过它（此前开发循环一律走全链打包）。
    **真因**：`adb push` 在 `/data/local/tmp` 下新建的目录权限是 **`0771`**（`drwxrwx--x shell shell`）——
    others 位只有「可穿越」（`--x`）**没有「可读」**。而脚本用 `cp -r <stage>/lib/. <target>/` 复制，`cp` 递归时
    **必须列目录内容**才对，于是以 `run-as`（`u0_aXX`，属 others）身份读 stage 恒得 EACCES。
    **注意这不是「stage 里文件权限不对」**：文件本身是 `-rw-rw-rw-`（可读），失败的是**目录列举**这一步。
    **修法**：`adb push` 之后加一步 `adb shell chmod -R 755 <stage>`（只读拷贝源，放开 others 读+穿越即可，
    不需要写权限给 run-as）。`scripts/hot-push.mjs` 已实修。
    **判据（可证伪）**：① A/B 实测——不 chmod 时 `cp: …/lib/.: Permission denied`；chmod 755 后同一命令
    输出 `OK` 并列出 5 个条目；② 修复后脚本自身输出 `HOT-PUSH OK（6 文件 × 2 profile）`、exit 0。
    **绕法（不推荐，仅作诊断）**：手工逐个 `cp -f <file> <target>/` 能成功（不列目录 ⇒ 不受权限影响），
    这正是「为什么当初偶发手动热推看起来能行、而脚本从来不行」的原因。**遇到 Permission denied 先查本条，不要手工绕。**
    **为什么记进坑位**：这条同时暴露了**第三条**「文档承诺 ≠ 可执行面」——`dsh-mobile-apk/AGENTS.md` §2 一直教这条命令，
    而 `scripts/hot-push.mjs` **只存在于协调仓**，apk 自包含树里那条文档指向一个不存在的文件。
    故同批把它登记进 `check-patch-mirror.mjs` 的 `MIRROR_TOP`（单边演进即判红），并同步镜像脚本本体。

178. **「App 重启无效」= 根因在 Shizuku 侧的 UserService 实例，只清进程内标志位永远不会好；必须 `remove = true` 强制移除（2026-09-26，P1）**
    **现象**：Shizuku 已授权、通道一度「可创建」，随后跳成「需要准备」；**重新授权与重启 App 均无效**，设置页刷新多少次都停在坏态。
    **真因**：**「App 重启无效」本身就是决定性证据**——进程内任何脏标志位都会被重启清掉，既然重启没用，坏态就不在我们这一侧。
    它指向 **Shizuku 侧那个 UserService 实例已经僵尸化**：绑定请求发出后既不回调也不抛。此时就算我们把 `service = null`、把绑定标志位清零，
    下一次 `bind` 仍会打回**同一个坏实例**，于是表现成「按钮点了毫无反应」。
    **修法（`ShizukuTransport.resetConnection`）**：三件事缺一不可 ——
    ① **承重墙**：调 `Shizuku.unbindUserService(args(app), connection, remove = true)`。该 API 在 AAR 里的实现是
    `IShizukuService.removeUserService(conn, forRemove = true)`（本仓对 AAR 实测 disassemble 确认），即让 Shizuku 管理器**移除**这个 UserService，
    下次绑定才会重建一个干净的。**这一步失败也不许中断重置**（`runCatching` 吞掉 + `Log.w`）——否则 Shizuku 侧已死时连「清空我们这一侧」都做不到。
    ② 清我们这一侧的记账：`service = null` / `connectedAt = 0` / **`bindLatch?.countDown()` 并置 null**（留着僵尸闩会让下一次 `ensureBound` 复用一个永不 countDown 的 latch，
    重置后仍只是「等满预算再报正在建立」= 按钮看起来没反应）；`ShizukuBindState.onReset()` 令 `bindingFlag = false` 使下一次 `beginAttempt` 必然放行。
    ③ **`ControlCarrier.invalidateShizukuCache()`**：caps 的 5s TTL 缓存必须立即失效，否则重置后最多 5 秒内界面仍报旧值，用户会认定按钮没用。
    **纪律**：本方法在设置页每次点击上**同步**执行（UI 高频路径），**绝不 await 新绑定**（与 `kickBind` 同纪律）；重置后的收敛交给既有 2s 轮询 + `kickBind`。
    返回的是**写后回读的 `status()`**，据此如实展示，**不承诺「已修好」**——能否恢复取决于 Shizuku 服务本身是否还在运行。
    **判据（可证伪）**：① 重置后 `bindAttempts` **递增**（证明确实又发起了绑定，而不是只把界面刷了一遍）；
    ② 反证：重置前人为造出「binding 在飞」的态，重置后断言 `binding = false` 且下一步能再次发起；
    ③ `caps.shizuku` 在重置后 5 秒内即反映新态（证明缓存真的失效了，而不是等 TTL 自然过期）。
    **为什么记进坑位**：按「重启无效」直觉去查代码是**方向相反**的排查——重启无效恰恰说明要往**进程外**找。这条坑把「症状→该查哪一侧」的映射钉住。

179. **出厂默认值 = 凭空造事实；未知必须保持未知（含「`reasoning === true` 推不出档位集」）（2026-09-26，P2）**
    **现象**：自定义供应商的路由在引擎目录里查不到对应模型时，思考档位/上下文长度/模态一律缺失，界面无可渲染。
    **错误做法（初版曾想这么干）**：给一个**出厂默认档位集**或默认上下文长度，让界面「先有东西可显示」。
    这等于**凭空造事实**——用户会看到一个我们其实并不知晓的能力声明，且它会被当成已确证的元数据继续流向模型与设置。
    **修法（来源梯，逐级只认显式声明，六级都不中就是「未知」）**：
    `S1 endpoint-descriptor`（问端点自己返回什么）→ `S2 vendor-descriptor`（按响应形状解析厂商 schema）→
    **`S3 models.dev`（新，跨厂商长尾；见 `src/models-dev.ts`）** → `S4 engine-catalog`（pi-ai 随包目录的精确 id 命中）→
    **`S5 user-fallback`（新，只在用户显式配了 `fallbacks` 时存在，出厂无默认值）** → `S6 active-probe`（需显式批准，因它发真实补全请求）。
    不变量（`capability-probe.ts` 文件头明载）：**没有任何一级报出的能力保持缺失（绝不猜测）**；**每个报出的能力都带 `source`**；
    `S3` 与 `S4` 同时描述同一 id 时**逐字段仲裁**——**分歧字段记为冲突且不写入**（「没有任何来源声明的事实保持缺席，而不是变成掷硬币」）。
    **特别提醒（本题最易犯）**：**`reasoning === true` 推不出档位集**。models.dev 的 `reasoning_options[]` 实测有**四种条目形态**
    （仅 `type` / `type`+`values` / `type`+`min`+`max` / `type`+`min`），只有 **`effort` 变体**才点名档位；裸 `type: 'toggle'` 或 `budget_tokens` **一个档位名都不给**。
    因此拿不到 `effort` 档位时**保持未知**，**不回退出厂档位集**（Lead 裁决）。
    **规模与纪律**：models.dev 实测 **223 provider / 8181 模型 / 压缩后约 1.3 MiB**；只保留上列字段（其余全丢），落盘前先量尺寸，超 `MODELS_DEV_MAX_BYTES`（8 MiB）拒写。
    **网络只在 `ensureModelsDev` 一处**：tick 路径传 `allowNetwork = false` 走**纯缓存读**（`$DSH_HOME/models-dev.json`），**0 次网络**；
    证据 = E-P2-4 单测（自动补给路径 fetch 计数为空 + 反证证明该计数面确实能观测 fetch + tick 的 describe 次数不因 S3/S5 合流增加，上界仍为 2）。
    **合流不是替换**：[0.14.2-preview-SHIZUKU-RESET-AND-MODEL-FILL.md](../../../docs/0.14.2-preview-SHIZUKU-RESET-AND-MODEL-FILL.md) §1 的对比结论是
    **两个实现合流**（S3/S5 作为新增两级插进既有四级），不是用一个替换另一个。
    **为什么记进坑位**：这类缺陷的形态是「界面看起来对、数据是编的」——最坏的一种，因为没有任何断言会红。

180. **快照指纹相同 ≠ 插件内容相同：设备验收必须逐文件核 sha256（2026-09-26，task-56 实证）**
    **现象（本轮实测）**：16384 横屏在**同一 APK、同一快照指纹**下，跑的仍是**修复前的旧 `client.js`**（`33072 B / e6da3471`），
    而仓库权威产物是 `33441 B / 1dc4feeb`。后果是横屏九键 keyCode 全为 0——**看起来装了新包，实际验的是旧插件**。
    **真因**：`.`snapshot-fingerprint` 只标识**快照包的身份**，不标识**设备上插件树当前的内容**。
    两者之间还隔着：热推/镜像是否真的落到该设备、profile 是否冷启动重装配、以及**该设备是否从来就没被更新过**。
    指纹一致只能证明「装的是同一个快照包」，**不能证明「树里的文件是同一份」**。
    **修法（验收纪律，不是代码修复）**：装机/热推后，对**每个受影响的插件文件**取设备侧 sha256 与仓库产物逐一比对——
    至少覆盖 `@dsh-android/*/lib/client.js`、`lib/index.js`、`dsh-model-capability/lib/*.js`；**两者必须逐文件一致**才谈验收结论。
    **判据**：本条是 E-B-2 的依据。任一片不等 ⇒ 该设备的验收结论**作废**（不是「差异可以解释」）。
    **为什么记进坑位**：它直接否掉了「指纹对上了就放心了」这个看似稳妥的惯例；且该缺陷**只会以「功能不生效」的形态出现**，不会报错。

181. **`robocopy /MIR` 镜像会把对端**正确**的 lockfile 覆盖成旧版；镜像前先核盘（2026-09-26，本轮实证）**
    **现象**：做 P1 插件镜像时执行 `robocopy plugins/dsh-android-vdisplay dsh-mobile-apk/plugins/dsh-android-vdisplay /MIR`，
    之后 `check-patch-mirror` 判红 `package-lock.json`。追查发现**被覆盖的 apk 侧才是对的**：
    apk 侧 lockfile 钉 `0.1.7-rc.2`（正确的），而**协调仓侧钉的是 `0.1.7-rc.1`（旧的）** —— `/MIR` 把旧的盖到了新的上。
    **真因（两层）**：
    ① `/MIR` 是**双向抹平**：它不判断谁新谁对，只让两边一致，于是**错的一侧可以污染对的一侧**；
    ② 更根本的一层：协调仓 5 个插件目录（bridge / manage / model-capability / vdisplay / shell-termux）的
    **`package.json` 声明 `0.1.7-rc.2`，而同目录 `package-lock.json` 仍钉 `0.1.7-rc.1`** —— 两文件自相矛盾，
    `npm ci --ignore-scripts` 在 5 个目录**全部 ERESOLVE 失败**（实测 exit=1）。apk 侧的 `ed78f5a` 批次修过这个问题，协调仓当时**漏修**。
    **修法**：① 镜像这类**生成物/锁文件**前，先对两侧取 `package.json` 声明的版本与 lockfile 内实际版本做一次核对，
    确认「哪一侧是权威」再决定覆盖方向；② 权威源修在协调仓（把 apk 侧正确的 lockfile 复制过来），
    而不是反过来让镜像把错误固化成「两侧一致」。
    **判据**：`check-patch-mirror` 对 `package-lock.json` 是**逐字节**比对（`MIRROR_TOP` 目录级），
    所以「两侧一致但都错」也能过门禁 —— **门禁只保一致，不保正确**。锁文件的一致性判据必须额外包含
    「lockfile 内版本 == 同目录 package.json 声明版本」。
    **为什么记进坑位**：`/MIR` 是文档反复推荐的镜像手法，而它在**对端更新**时是**破坏性**的；
    本例中它把一个真缺陷（协调仓 lockfile 陈旧）掩盖成了一次「镜像漂移」。

182. **只跑目标单测文件 ≠ 跑过该插件单测：改动跨模块时必跑聚合门禁（2026-09-26，本轮实证）**
    **现象**：改 `keybar/layout.ts` 与 `keybar/mount.ts` 后，只跑 `node --test test/keybar-layout.test.mjs`（10/10 绿）就宣称
    「单测全绿」。随后 `check-plugin-tests` 判红：`keybar-mount.test.mjs:433` 断言「留白变量写在**键条**上」，
    而本次改动正是把它移到了**终端根节点**上 —— 该断言按设计必须红。
    **真因**：`node --test <单个文件>` 只覆盖被点名的文件；同一插件的**其它测试文件**同样消费被改的模块，
    单文件绿**不能**推出插件绿。聚合门禁（`check-plugin-tests`）跑的是整目录，因此会红。
    **后果**：这是**自己给自己发假绿**——若聚合门禁没被跑，这个回归会随 PR 进主干。
    **修法**：改动落在某个插件的 `src/**` 时，收口一律跑聚合门禁（`node scripts/check-plugin-tests.mjs`），
    或至少跑该插件 test 目录**全量**（`node --test test/*.mjs`）；单文件只用于**开发中的快循环**，不得作为收口证据。
    **判据**：插件单测的收口证据必须是聚合门禁的整行输出（含文件数与项数），不得是单文件退出码。
    **为什么记进坑位**：单文件快循环是很自然的工作方式，而它与「验证充分」之间隔着一整类**跨文件断言漂移**，
    后者恰好是本项目测试里最常见的一类（断言写在 A 文件、被改的实现被 B 文件消费）。

183. **`build-release.ps1` 的快照输入必须是**注入后**产物，不是 pre-injection 快照（2026-09-26，本轮实证）**
    **现象**：把 `.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz`（引擎已 rc.2、但**尚未注入插件**）
    放进 `dsh-mobile-apk/snapshot/` 后跑发布链，在**第 0b 步**就被拒：
    `CHECK-API-ROUTE-AUTH FAILED (16): post-injection marker: web/dsh-undo-savepoint/lib/index.js; …`，
    16 条全是「marker 不在归档里」，随后 `CHECK-RELEASE-GATES FAILED -> 中止组装`。
    **真因**：发布链**先门禁、后注入**，而该门禁验的是**注入后**形态：
      - 第 60 行 `check-release-gates --run --require --snapshot-dir dsh-mobile-apk/snapshot` —— 在注入**之前**；
      - 第 114 行才 `python inject-snapshot.py` 做宿主注入；
      - 第 143-148 行的注释自述：0b 验的是「**输入**快照」，2f 才在注入后产物上复跑。
    ⇒ 即「输入」这个词的真实口径是**已经注入过的那份**（历史流程里它来自设备侧 make-snapshot.sh 的产出树），
    不是「未经注入的裸快照」。判据要求 marker 在场，而 marker 只可能来自注入。
    **修法**：把**注入后**快照喂进去 —— 本地链对应 `.deploy-tmp/build-/13-<abi>/snap-final2.tar.xz`
    （由 `build-apk-013.ps1` 产出，含 undo-savepoint / marketplace / @dsh-android 全套）。
    实测该份含 `dsh-undo-savepoint/lib/index.js` ×2（web+headless）、`dshmarketplace-plugin` ×2、
    `@dsh-android/dsh-android-bridge/lib/index.js` ×2，且引擎 = 0.1.7-rc.2。
    **判据**：`tar -tJf <快照> | grep dsh-undo-savepoint/lib/index.js` **非空** 才可作发布输入。
    **为什么记进坑位**：错误方向的直觉（「pre-injection 才是干净输入、让发布链自己注入」）看起来更合理，
    而实际口径相反；喂错方向的表现是 16 条 marker 缺失，很容易被误读成「补丁没进快照」而去查补丁。

184. **发布输入快照会随插件改动一起过期：`dsh-mobile-apk/snapshot/` 必须重出（2026-09-26，本轮实证）**
    **现象**：`dsh-mobile-apk/snapshot/` 里躺着 9/23 旧快照（引擎 `0.1.5-rc.1`，且不含本轮任何插件改动）。
    若直接跑发布链，会打出**引擎回退到 0.1.5-rc.1、且不含本轮修复**的包 —— 与本地全链验过的两个 APK
    完全不是同一个东西。同族于坑 180（指纹相同 ≠ 内容相同）：**输入源认错，验收全白做**。
    **修法**：插件改动后必须重跑 `build-apk-013.ps1`，再把 **snap-final2** 放进 `dsh-mobile-apk/snapshot/`。
    逐文件判据（不能只看指纹）：从待发布输入里抽出 `@dsh-android/<pkg>/lib/client.js`，
    与仓库产物取 sha256 **逐文件相等**。
    **顺带实测**：`.deploy-tmp/build-/13-x86_64/snap-final2.tar.xz` 在只重建 arm64 后会**仍是旧内容**
    （其内的 vdisplay client.js = `1dc4feeb…`，而仓库已是 `1c48647d…`）——即**「建过这个 ABI」不等于
    「这份快照是最新的」**，双 ABI 发布必须两个 ABI 都重出。

185. **页面「自然底边」与「可视底边」的差是真源；壳侧 IME 变量是已生效过的同一高度（2026-09-27，0.14.2-fx-1 实证）**
    **现象**：用户报「九个终端控制键仍旧会额外上抬，上抬距离还恰好是比键盘高一个键盘」。
    **真因**：壳侧 edge-to-edge 对**同一个** IME 做了两件事（`MainActivity.kt:254-279`）：
    ① 把 IME inset 施加到 WebView 自身的**布局尺寸**（`webView.setPadding(0, 0, 0, ime)`，注释自述是 #197 机制①的根治——
    让布局视口真的变短，浏览器就没有可平移的余地）；② **同时**把同一个高度推成 CSS 变量 `--dsh-android-ime-bottom`。
    插件侧旧 `computeBottomInset` 用「布局视口高 − 视觉视口高」当键盘高度，再与壳侧变量取 max ——
    吸收态下两者都等于同一个键盘高，但布局视口**已经**因此变短了，键条的自然底边早已到键盘顶，再加一份留白就是多抬一个键盘。
    CDP 实测（360 CSS 宽，键盘 300，键条高 53）：基线 `innerH=800 vvH=800 ime=0` → 键条 top 747；
    吸收态 `innerH=500 vvH=500 ime=300px` → 键条 top **147**（应 447）；抬升 600 = **两个**键盘高。
    **修法**：判据换成**自足量** `shortfall = max(0, 布局视口高 − (视觉视口高 + 视觉视口偏移))` ——
    不猜键盘多高，只描述「还差多少没让开」；视觉视口可用时壳侧 IME 变量**不参与**，只留作「视觉视口整个读不到」的兜底。
    修后同一组读数键条 top = **447**，抬升恰为 300（一个键盘高）。
    **两个必须记住的边界**（各有单测守着）：
    ① 视觉视口不可用（`height` 为 0）时**不得**算 shortfall —— `layout − 0` 会退化成「整个布局视口高」，
    那不是留白而是把内容顶到屏幕外；该分支一律交给壳侧兜底。（这一条是第一版实现漏掉的，被自己写的测试判红 `800 !== 300` 抓出。）
    ② `visualViewport.offsetTop` 必须一起读——漏掉它会在「布局视口没缩但浏览器平移了内容」的内核上留一条空白带。
    **为什么记进坑位**：两处「让开键盘」的实现分居 Kotlin 与 JS、各自看着都对，
    缺陷只在**同一个量被两侧各算一次**时出现；而症状（上抬量恰好多一个键盘）极易被误读成「留白算大了」而去调系数，
    实际是**通道重复计数**。同类形态（一个事实两条通道各自生效）值得当成一族来查。

186. **上游声明的运行期依赖没随 overlay 走：设备 boot 期 `ERR_MODULE_NOT_FOUND` 硬崩，而本地门禁结构性全绿**（2026-09-27，H-1）
    **现象**：设备 boot 期引擎硬崩，报 `ERR_MODULE_NOT_FOUND`，被依赖的模块是 `@modelcontextprotocol/client`；
    而本地全部门禁绿、打包正常 —— 缺陷只在**设备运行期**出现。
    **真因**：上游 `dsh-mcp-client` 的运行期依赖从 `@modelcontextprotocol/sdk` 换成了 `@modelcontextprotocol/client@2.0.0`（改名/拆包），
    而我们的 overlay 生成器 `scripts/gen-engine-overlay.mjs:66-90` 的 `collectPackages()` 只收 `@deepseek-ai/*`（`:90` 的 filter），
    **第三方运行期依赖根本不在它的收集面内**；`vendorTop` 在生成器里**没有任何写入点**（全文只在旧表保留逻辑里被读），
    靠人工补登 ⇒ 人工没跟上。**三条既有门禁结构性看不见**：`check-engine-overlay` 的正向闭包只对三份 `cordis.patch.yml` 的**行面**问责，
    而 `dsh-mcp-client` 正是「不在我们装配行面上」的那类宿主。
    **修法**：① `scripts/snapshot-config/engine-overlay.json` 的 `vendorTop` 补两条
    `"@modelcontextprotocol/client": "2.0.0"` / `"@modelcontextprotocol/core": "2.0.0"`（36 → 38）；
    实测该闭包 13 个包里 11 个已在快照内，只缺这两个 ⇒ 最小修法成立。
    ② 新增门禁 `scripts/check-mcp-client-deps.mjs`：判据 = `@deepseek-ai/dsh-mcp-client` 的**运行期依赖闭包**在快照内全部可解析
    （逐级读快照内 package.json，缺失即列出**引用者**）；已接进 `check-release-gates.mjs` 声明集（32 → 33）、本地链 `build-apk-013.ps1`、
    云端链 `build-apk.mjs`（两链门禁集差集实测为 0）与 `check-patch-mirror.mjs` 的 `MIRROR_TOP`。
    **为什么不动生成器**：`vendorTop` 是「构建期人工裁决」面（哪些第三方要随引擎顶层走，取决于 Node 解析面），把 npm 闭包全量自动化会引入
    几百条传递依赖的登记抖动；先补缺口 + 用门禁把「再漏」挡住。
    **复验证据**：正证（闭包完整的最小 tar）`CHECK-MCP-CLIENT-DEPS PASSED` exit=0；反证（同一 tar 删掉 `@modelcontextprotocol/client`）
    `FAILED：… 闭包在快照内不可解析 1 条: [@modelcontextprotocol/client]` exit=1；修复前现状快照同判红并逐条列出 `MISS … <- @deepseek-ai/dsh-mcp-client`。
    **同型提醒**：凡「上游改了依赖名/拆了包，而我们的清单/overlay 是人工维护的」，都要问一句「这条依赖有没有进收集面」；
    行面门禁看不见非行面宿主。

187. **「判据常态为 null」被写成否决条件 ⇒ 守卫恒触发 / 恒不触发**（2026-09-27，task-78）
    **现象**：为修 issue #274 ①（探活超时即破坏性自愈），第一版判据写成「日志里没有强证据 → HOLD」。
    跑既有回归时 `degradedHttpLadderEscalatesToRestartOnTheSixthTick` 判红：第 6 拍不再 RESTART，
    连带 `halfDeadEngineStillReachesUndoAfterTheBootWindowExpires` 的 `undoProbed` 恒为 0。
    **真因**：`WatchdogV2` 的 `logSignature` 只在日志尾部匹配到已知签名（`plugin tree failed to load` /
    `uncaught`）时才非空，**其常态就是 null**（生产亦然，不是测试注入口径）。把「缺少证据」当否决条件 ⇒
    这条守卫在**绝大多数正常路径**上都成立，等于把既有的、必需的阶梯语义整条掐死。
    **修法**：判据只认**正向证据**（指认「是慢、不是死」：本次探活 `error=timeout`；或端口非本进程持有），
    且证据是**放行**的理由而不是**前置条件**（`strongEvidenceForDestructiveRecovery` 命中时**解除**「慢」的否决）；
    对「慢」这类单次观测无法与真卡死区分的形态必须有**有界宽限**：`DEGRADED_SLOW_GRACE_TICKS`（3 倍阶梯 ≈ 90s），
    宽限用尽仍无改善即视为真卡死放行 —— 否则会制造「引擎卡死且永不重试」的死局。
    **复验证据**：既有 4 条回归全绿；新增 5 条断言（慢→HOLD / 端口他进程→HOLD / **宽限用尽→放行** /
    `refused`≠慢→放行 / 子进程已死时第 6 拍 RESTART 仍成立）。
    **同型提醒**：任何「观测到 X 就否决」的守卫，先查 X 在**正常路径上的取值分布**；常态为 null/false 的 X
    会让守卫恒触发或恒不触发，与「定义在但没接线」同族。

188. **`treeStats` 把 root 自身计入 ⇒「空目录 = 0 条目」判据永不触发，整条防线作废**（2026-09-27，task-78）
    **现象**：为 issue #273 ① 写「回滚前体检备份，空备份一律拒绝」的 `verifyPreviousForRollback`，
    并在单测里造了一份空备份期望被拒 —— 实测**判红**（没被拒）。
    **真因**：`SnapshotFs.treeStats` 的文档写「不含 root 自身」，实现却从 root 开始 `walk` ⇒ root 被计 1 条；
    于是空目录报告 `entries=1` 而非 0，`if (stats.entries == 0L)` 恒不成立，
    **「拒绝半份备份」整条判据全部作废**。这是本仓反复出现的「判据存在但无判别力」形态。
    **修法**：`treeStats` 只遍历 `dir.listFiles()`（不含 root），并单独处理「root 本身是符号链接」。
    **复验证据（判别力反证）**：把 `verifyPreviousForRollback` 的返回值硬置 null ⇒
    `rollbackRefusesAnEmptyBackupInsteadOfWipingLive` **判红**；还原后复绿。
    **同型提醒**：写「= 0 / 为空」判据时**先证明它造得出来**；造不出来或造出来判据不响，就是边界条件写错了。

189. **测试里的静默 `return` 会伪装成 PASS —— 撤掉修法照样绿（假绿）**（2026-09-27，task-78）
    **现象**：`backupKeepsSymbolicLinksAndRollbackRestoresThem` 需要建符号链接，本机（Windows，无
    `SeCreateSymbolicLinkPrivilege`）建不出来，第一版写成「建不出来就 `return`」⇒ 它显示 **PASS**。
    做判别力反证时（撤掉 A 的修法）**它照样绿**，正是这一点暴露了它：这个用例从来没验过任何东西。
    **真因**：JUnit 里「无法构造前置条件」只能报 **SKIP**，不能静默返回 —— 静默返回与「断言通过」在报告上无法区分。
    **修法**：改用 `org.junit.Assume.assumeTrue(...)`（无权限时如实进 SKIP 计数）。
    **更深一层**：环境受限的能力**不能只靠 e2e** —— 本仓既有范式是把「可能失败/不可观测的一步」做成**可注入原语**
    （`swap` 的 `move` / `delete` / `ownerProbe` / `spaceCheck`）。符号链接三动作（判链接 / 读目标 / 建链接）
    同样抽成可注入接缝后，本机即可拿到真判红：正例断言 `createLink` 被调用且目标名逐字相同；
    反例把它换成「一律当普通文件」判红；反例让 `createLink` 抛 IOException ⇒ 必须**向上冒错**而非静默跳过。
    **接缝要抽到「做判断的那一步」**：只抽下游动作、分支仍读 `attrs.isSymbolicLink`，注入的替身就**永远不会被问到**
    ⇒ 又变成「有接缝但无判别力」（本轮实测踩到并自查出）。
    **复验证据**：SKIP 如实计数（全量实跑 skip=2，含本条与另一条同型 e2e）；
    可注入判据的红/绿对照见 `SnapshotTransactionTest`（CP-A1b / CP-A1c 两条反证实测判红）。
    **同型提醒**：`return` / `if (envOk)` 这类「环境不满足就跳过」的写法，与本仓「判据无判别力」是同一件事。

190. **Kotlin 行首 `+` 是一元加号、不是续行 ⇒ 静态自审全绿但编译炸**（2026-09-27，task-78）
    **现象**：`SnapshotTransaction.kt` 里两处多行字符串拼接写成
    ```kotlin
    notes += name + "…" + relink.restored + "/" + relink.expected
      + " 条（备份缺链接，按 staged 工厂权威补回）"   // 行首 `+`
    ```
    编译报 `Unresolved reference 'unaryPlus' for operator '+'`（String 没有 `unaryPlus`）。
    **真因**：Kotlin 的续行规则是「**上一行以运算符结尾**」，不是「下一行以运算符开头」。行首 `+` 被解析成**一元加号**。
    只有**圆括号/方括号内部**的换行才无条件合法（`Log.w(...)` 那种调用实参里的行首 `+` 因此没事 —— 它在括号内）。
    **修法**：把 `+` 挪到上一行行尾，或用括号包住整个多行表达式（本次采用后者，保留可读缩进）。
    **为什么静态自审抓不到（本条的重点）**：同批改动跑过括号平衡（depth=0）、hash 核对、自写机械核对脚本 28 条全绿
    —— **没有一条能发现编译错误**。括号平衡只数括号（行首 `+` 不改变括号计数），机械核对只匹配写下的模式串。
    **静态 ≠ 编译 ≠ 运行**，三者是三个不同的证据等级。
    **复验证据**：修前编译 `Unresolved reference 'unaryPlus'`（实测）；修后用「行首 `+`/`-` 且处于圆括号/方括号深度 0」的扫描
    确认**全文件 0 处**（其余行首 `+` 全部合法地位于括号/实参内部，逐个看过上下文）。
    **同型提醒**：任何「我用脚本查过所以没问题」的结论，都必须先问「这个脚本能不能看见我要防的那类错误」。

191. **`stage/` 目录与 `snapshot.tar.xz` 不同步：门禁读了阶段树而非产物，得出与实际相反的结论**（2026-09-28，task-78）
    **现象**：`node scripts/check-boot-budget.mjs --pull <serial>` 真检里 C5 的正向对照判 SKIP，理由原文：
    `引擎树存在但未打过 P1 补丁（无 compose 探针面）：…/snapshot-013/x86_64/stage/root/…/dsh-client-modules/lib/index.js`
    同一时刻另两条事实与它矛盾：
      · `snapshot.tar.xz`（同目录，2026-09-28 01:30 重建）**tar 内该文件有 P1 marker**（47,466 B）；
      · **设备引擎树里 P1 marker 命中 4 处**（设备实际跑的就是含 P1 的树）。
    **真因**：该 stage 目录 mtime = **2026-09-08 18:21:32**，即**停留在两个月前的树**；
    而 C5 的输入面读的是 **stage 树** —— 既不是 tar、也不是设备树。重建快照只刷新了 tar，**没有回写 stage**。
    ⇒ 门禁拿到的是一个既不等于产物、也不等于运行时的第三方副本，于是结论与实际完全相反。
    **这是同一根因的第二次现身**：第一次表现为 `-Fast` 静默复用陈旧 stage 树 + boot-budget「有设备产物就真检」
    ⇒ 拿旧读数判红；这一次表现为 C5 正向对照读旧 stage 树 ⇒ 误判「无 P1」。
    **修法建议（未实施）**：① C5 的输入面改读 **tar 或设备树**（二者至少有一个是真相），不再读 stage；
    或 ② 构建链在重建快照后**同步刷新 stage**，并给 stage 树加一条「与 tar 同代」的自检（mtime/内容 hash 二选一）。
    在没有修法之前，读 stage 的正向对照**一律不可信**——它是「第三份副本」，谁都不会去核它。
    **复验证据（实测）**：
      · stage 树文件 mtime = 2026-09-08 18:21:32、P1 marker 命中 **0**；
      · 同目录 tar（01:30 重建）解出该文件 = 47,466 B、P1 marker 命中 **true**；
      · 设备 `run-as grep -c` 该文件 = **4**；
      · `grep -E 'SnapshotTransaction|SnapshotFs|UndoGate|WatchdogV2|EngineService' scripts/check-boot-budget.mjs` = **零命中**（该门禁不读壳侧 Kotlin，故三条红与 task-78 无关）。
    **同型提醒**：凡「门禁/工具读一个中间副本（stage / cache / 中间产物）而不读产物本体或运行时」，
    都要问一句「这个副本由谁负责刷新、有没有人核它」。**三份副本 = 没有真源。**

192. **自愈只挂在「快照刷新」那条链上 ⇒ 指纹已 fresh 的设备永远拿不到修复**（2026-09-28，task-78）
    **现象**：0.14.2-fx-2 的「旧单点写法归一」挂在 `FactoryProfilePatch.merge()` 入口，
    单测全绿、包里也确有该代码（dex 搜到 `normalizeLegacyAgentDefaultModel`），
    但**两台真机**装上含它的包后，冷启动**两次** `live patch` 的 md5 **一个字节都没变**，
    旧形态（`- id: agent-default-model / disabled: true` + 换 id 的 `-mobile` 块）原样保留。
    **真因**：本仓对 profile patch 有**两条**修复通道，各自有独立的门：
      · `merge()`（归一挂的这条）：只在**快照刷新**时跑（`mergePatchYamlById`），门是 `if (snapshotFresh()) return true` ⇒ 现场**已 fresh，早退**；
      · `repairProfilePatch()`：每次 `startEngine` 前的启动前置，门是 per-VERSION_NAME 标记 ⇒ 现场标记已存在，早退。`
    本仓**早已**为同类缺陷写过这条教训（`EngineManager.kt:1443-1444`，apk #214）：
    原文：「这类设备不一定再触发快照刷新（指纹未变则 merge 不跑），所以自愈必须在引擎读 profile 之前做一次，不能只依赖 refreshSnapshot。」
    新写归一代码时**只挂了 merge**，等于重蹈这个坑。
    **修法**：① 归一**同时**挂到 `repairProfilePatch` 的启动前置通道；
    ② 用**独立**幂等标记 `.profile-patch-normalize-<version>`，**不复用**退役行那个标记 ——
    复用会让「已装过同版本」的设备永远补不上这次新修复（现标记语义是「本版本已修退役行」）。
    **复验证据**：修前实测两台 cold start x2 后 md5 均不变（`a7014fab…` / `904788b5…`）；
    设备 fp == APK `assets/snapshot.sha256`（`b2c7244d…`）⇒ merge 早退成立；
    `.profile-patch-repair-<version>` 标记在场 ⇒ repair 早退成立。
    **同型提醒**：凡新增自愈/迁移代码，先问「**它依赖的那条链在这台设备上会不会跑**」。
    判据是「设备的触发条件是否已满足」，不是「代码在不在包里」——本条的假绿形态正是「包里有、跑不到」。

193. **cordis 重启 fiber 的顺序是「先跑新实例、后释放旧 effect」⇒ 单槽注册表上的 effect 每次重启即永久死亡**（2026-09-28，竖屏模拟器 5556 实锤）
    **现象**：在设置里换一次默认模型（或任何改写 `agent-default-model` 条目 config 的动作）之后：
      · `内置插件` 面板从 `196 个 0 失败` 变成 `196 个 1 个失败`，点名 `api-session-controller`；
      · 此后任何控制面动作（新建会话 / 切模型 / 会话控制流）恒得
        `typert gateway: session/create|session/control: active Service "sessionController" is unavailable`；
      · **engine.log 零痕迹**：`dsh web` 的启动审计 warn 出口是空函数（上游 `dsh-bundle-web-app/lib/index.js` 里
        `auditStartupEntries(connectionCtx.root, "dsh web", () => {})`），fiber 失败只在面板上体现，日志里一个字都没有。
    **真因**：两层叠加。
      ① 触发链：config-editor 改写 `agent-default-model` 条目 config ⇒ 该 fiber 重启 ⇒ 依赖 `agentDefaultModel` 的
         session-controller 跟着重启（cordis 的服务实现变更会刷新依赖方）。
      ② 死亡机制：`Fiber._reload()` 的顺序是 `await this._execute(runner)`（跑新实例 body）→ `_updateState()` → `_unload()`（释放旧 effect）。
         于是新 `SessionController` 构造里的 `ctx.effect(() => ctx.fileUploads.registerAgentResolver(...))` 执行时
         **旧注册还在槽里**；上游 `registerAgentResolver` 对已占用槽直接
         `throw new Error("file-upload: Agent resolver is already registered")` ⇒ 新 fiber 判 FAILED，随后旧 fiber 释放
         ⇒ 服务永久缺席（**不是 pending**，所以启动审计不拦、也不自动重试）。
    **定位手段（可复用；本次即由此拿到原始栈）**：插件失败默认无声时，把 cordis 的失败点接出来——
      `cordis/lib/index.js` 的 `_reload()` catch 里，在 `this.ctx.logger.error(reason)` 前插一行 `process.stderr.write(...)`，重启即见栈。
    **修法**：`file-upload-restart-R1`（`scripts/patches/registry.json`，scope=engine）——`registerAgentResolver` 去掉
      already-registered 守卫、改为**同槽覆盖**；disposer 保留身份判据（`if (this.agentResolver === resolve)`），
      旧 fiber 的 disposer 因此不会清掉新注册；仍只有一个槽。不选「改 session-controller 侧」的理由：单槽语义下
      替换与上游意图等价，且全文只有它一个调用方，不依赖 cordis 内部顺序。
    **复验证据（模拟器 5556，同一份运行树）**：补丁前 = 切一次模型即 `1 个失败` + 恒报 service unavailable；
      补丁后 = 冷启动 → 连切 3 次模型 → 面板 `0 失败`、控制台 0 条报错、切完模型真能改。
    **同型提醒**：凡「在插件构造函数里占住某个单槽注册表 / 全局登记处，且靠 effect 释放」的写法，在 cordis 里都经不起
      一次 fiber 重启。**判据**：问「这个注册被重复执行会怎样」——会 throw 的，重启即死。
194. **来源审计构建在 pnpm 安装后备份整个 vendor 包目录，会沿工作区符号链接递归（2026-09-27，远程 run 36261389579）**：
    **现象**：`build-apk-source` 第 9 步在 `prepare-harness-vendor-overrides.py:172` 的 `shutil.copytree(target, backup, symlinks=False)` 抛出异常；日志在 `raise Error(errors)` 后约 5 小时没有新输出，最终碰到 GitHub Actions 6 小时上限而取消，APK 步骤均未执行。此前的 Corepack 下载重试已生效，不能把本轮 6 小时归因于下载；下载完成与 Python 脚本开始之间缺少时间戳，前段耗时不能拆分。
    **真因**：冻结安装先于旧版 Cordis 源码替换，pnpm 已在 `vendor/*/node_modules` 建立工作区链接。锁文件存在 `group → cordis → loader → cordis` 的回环；`symlinks=False` 会跟随链接复制其目标，整个包目录备份因此进入循环依赖图。仅改为 `symlinks=True` 也不够：旧实现随后 `rmtree(target)` 会删掉构建仍需的 `node_modules`。
    **修法**：包根目录保持原位，只把非 `node_modules` 条目移到临时备份，再复制固定提交的源码条目；任一包失败时倒序清理新源码并移回原条目。拒绝固定源码归档顶层携带 `node_modules`。PR 与来源构建入口先跑包含循环链接和跨包回滚的单测。
    **复验证据**：本地非链接用例与回滚用例通过；新远程 run 36288879471 的 Linux 用例通过，五个旧版包在约 1 秒内替换完成，越过原 6 小时卡点。完整来源构建随后遇到锁文件声明漂移（坑 195）。

195. **固定旧版 vendor 清单替换后，构建入口会用冻结锁文件复检声明（2026-09-27，远程 run 36288879471）**：
    **现象**：旧版 Cordis 包已成功替换，但 `pnpm run build` 立即报 `ERR_PNPM_OUTDATED_LOCKFILE`，例如 `vendor/include` 的 `@deepseek-ai/cordis` 与 loader 从锁文件 `workspace:~` 变为旧清单 `workspace:^`；构建在此正常判红。
    **真因**：上游固定 Harness 提交的锁文件与其当代 vendor 清单一致，旧版源码替换也带入了旧版 `package.json`；运行 build 前的 pnpm 依赖状态检查要求 importer 的 specifier 与现有清单相同。另 `pnpm-workspace.yaml` 对 `cosmokit`、`schemastery` 强制 `link:vendor/*`，有效 importer 声明是相对 `link:../*`，不能机械写成旧清单原文 `workspace:^`（远程 run 36289257326 二次判红实锤）。
    **修法**：`reconcile-harness-vendor-lock.mjs` 只对来源报告列出的五个 importer 按工作区覆盖后的有效声明改写 specifier、移除旧清单已无的依赖条目；任何旧清单新增而锁文件没有的依赖直接拒绝，不向 registry 重新解析。原锁文件、改动清单、调整前后哈希进入来源 artifact 与策略报告。旧版源码及打包清单保持固定提交原样。
    **复验证据**：纯函数单测覆盖声明更新、`link:` 覆盖、已锁解析保留、缺失解析拒绝；完整来源构建须由后续远程 run 验证。

196. **当前 Harness 全仓类型检查不能与旧版 Cordis loader 源码混跑（2026-09-27，远程 run 36289546067）**：
    **现象**：旧版源码替换及有效锁文件对齐都完成后，`pnpm run build` 进入 TypeScript 阶段，`speech-to-text`、`llm-deepseek` 等当前包引用的 `loader/volatile-update` 事件在旧版 loader 的 `Events` 中不存在；当前测试还引用旧版 loader 没有的 `src/config/diff.ts`，全仓 `tsc -b tsconfig.host.json` 必红。
    **真因**：来源链把 0.1.7-rc.2 的其余源码与 overlay 固定的较早 Cordis 源码放进同一次全仓类型检查。两者发布时序不同，旧版包的 API 无法满足当前源码的静态检查；这不是缺失依赖或 TypeScript 缓存问题。
    **修法**：先按固定 0.1.7-rc.2 提交完成全仓与 Web UI 构建，再替换五个旧版 Cordis 包、对齐它们的锁文件 importer，单独用各包 tsconfig 和 tsdown filter 编译旧版包。打包时五个旧版 manifest 与源码仍等于固定旧提交，当前其余包来自固定 Harness 提交，不改上游源码。
    **复验证据**：远程 run 36289546067 证明锁文件复检已通过、进入全仓 TypeScript 并在上述不兼容处失败；run 36291011371 的 Harness 全仓与旧版包构建通过。

197. **插件镜像的 package-lock 根声明过期，会让来源构建在昂贵前段完成后才失败（2026-09-27，远程 run 36289938732）**：
    **现象**：Harness 源码构建与 Termux bootstrap 验证均通过后，`Build project plugins and marketplace from source` 在 `dsh-android-linux-env` 的 `npm ci` 报清单与锁文件不同；同类漂移还存在于 browser 与 file-open。
    **真因**：三个插件的 `package.json` 已钉 Harness 0.1.7-rc.2 和 Cordis 4.0.4，镜像里的 `package-lock.json` 根声明仍是 0.1.1-rc.2 / Cordis 4.0.1；旧锁文件未随清单同步。此处与工作区 pnpm 锁文件调整是两套独立依赖图。
    **修法**：按各插件现有清单重算其 npm 锁文件；在 PR 与来源构建的早期步骤运行 `check-package-lock-roots.mjs`，逐个对照所有带锁文件的插件/组件根声明，及早拒绝旧镜像。
    **复验证据**：九份锁文件根声明核对通过，九个目录的 `npm ci --dry-run --ignore-scripts --no-audit --no-fund` 通过，三个修复插件的实际 `npm ci` 与 `npm run build` 通过；远程 run 36291011371 的插件构建步骤通过。

198. **来源部署闭包中的 Linux GNU 原生文件必须逐包审计（2026-09-27，远程 run 36291011371）**：
    **现象**：Harness 与插件构建通过后，`node-pty` Android ARM64 绑定已成功交叉编译，但原生模块审计发现 trycua、ubjs、sherpa-onnx 和 node-addon-require-builtin 的 Linux ARM64/x64 `.node` 文件，报 `unreviewed native module families` 而中止。
    **真因**：`pnpm deploy` 从固定 Harness 的当前依赖图带入跨平台 Linux GNU 包；审计器只认识先前登记的 Sharp、Koffi 等包族，且把 node-addon-require-builtin 限在旧版 0.1.4，实际部署解析到 0.1.6。这些文件名和包名指向 Linux，不是 Android 绑定，不能把审计报错当作 node-pty 编译失败。
    **修法**：按实际锁定版本、包路径、文件名和架构对应关系增加四个包族的严格匹配；将外平台 payload 与原因记入审计报告，未知版本、架构错配和未知原生包继续拒绝。入口增加正反用例。
    **复验证据**：远程日志确认 node-pty Android ARM64 绑定已产出并给出 SHA-256；本地包族正反用例通过，远程 run 36291780773 的交叉编译及原生模块审计步骤通过。

199. **快照行为测试调用已删除的 boot 导出，会把上游接口更新误报成功能失败（2026-09-27，远程 run 36291780773）**：
    **现象**：Termux 基座组装完成后，快照构建器执行 `boot-pending.test.mjs`，五个用例全因 `assertEntriesActivated is not a function` 失败；这些断言均未真正进入待测启动逻辑。
    **真因**：固定 Harness 0.1.7-rc.2 的 `dsh-app-boot` 已改为导出 `auditStartupEntries`，按全局必需 entry id 判定致命错误，可选条目的 pending/failed 只告警。仓库测试仍调用旧导出，并沿用「任何 FAILED 都致命」的旧口径；旧版测试在裸 clone 上因找不到目标而跳过，未及时暴露漂移。
    **修法**：保持快照构建器的镜像脚本不动，改它调用的测试文件：直接注入 Loader 条目调用当前导出，用必需 id `webserver`、可选第三方、pending/failed 和混合状态验证当前契约；目标存在时先断言导出函数存在。
    **复验证据**：使用仓库固定的 0.1.7-rc.2 app-boot 产物夹具及已安装依赖，本地五个真实行为用例全绿；完整来源构建须由下一次远程 run 验证。

200. **来源审计链的检查器停在上一代引擎事实：预设载体断言在 pin 抬到 0.1.7-rc.2 后必然判红（2026-09-27，远程 run 36293117340）**：
    **现象**：快照成功产出（492.2 MB，sha256=e36b77b8…），pnpm 物化、运行时依赖链接、原生模块审计三个后续检查全过，紧接着 `check-dsh-source-snapshot.mjs` 抛 `source snapshot has no built-in dsh-agent-presets entries`，签名与 APK 步骤未执行。
    **真因**：该检查器是权威门禁 `check-engine-overlay.mjs` 的等价实现，而权威源在 0.14.2 追版时已把预设载体从 `@deepseek-ai/dsh-agent-presets/presets/` 重锚为 `agent-preset/skills/` + `web-app/presets/`（0.1.7 把该包拆成 agent-preset + agent-preset-registry）；等价实现没跟上。旧断言此前能通过，是因为上一版 pin 是 0.1.5-rc.1（那一代确有 `agent-presets/presets`，实测 4 项），本链把 pin 抬到 0.1.7-rc.2 后旧载体已不存在——**同一条链在换代后判红，指向的是门禁自身过期，不是产物缺失**。
    **修法**：载体清单抽成 `scripts/source-build/preset-carriers.mjs`（与权威源同口径：目录在场且递归**文件**数 ≥ 1；只断「包在场」是冗余，overlay 已覆盖包版本），检查器改为调用它并把逐载体计数记入报告；新增 `preset-carriers.test.mjs` 双向漂移守卫——它读权威源文本里的 CARRIERS 数组，比对两侧载体路径集合，权威源重锚即判红。测试接进 PR 与来源构建两处入口的早期步骤。
    **复验证据**：本地 6 例全绿；判别力反证两轮（把权威源载体路径改名 / 删掉 CARRIERS 结构）守卫均判红，还原后复绿；pin 侧实测：`packages/preset/agent-preset/skills` 15 个文件、`packages/bundle/web-app/presets` 4 个 `.patch.yml`，两者都在各自 package.json 的 `files` 里，故产物面应非空。完整来源构建须由下一次远程 run 验证。

201. **来源链摘除第一方 overlay 钉，与「按这份清单判定」的 check-contract §7 相撞（2026-09-27，远程 run 36294910834）**：
    **现象**：快照、预设载体检查与签名证书都通过后，APK 步骤的第一批门禁里 `check-contract.mjs` 第 7 节判红 `engine-overlay.json 里没有 @deepseek-ai/dsh-app-boot 钉 —— 运行时版本无从确定`，其余门禁与打包均未执行。
    **真因**：来源链要让快照构建器**不可**按登记表回拉上游发布版 tarball 覆盖已注入的源码产物（`build-snapshot-013.mjs` 的 `overlayExtract` 是整目录替换），故构建期把 `@deepseek-ai/*` 全部摘出 `engine-overlay.json`；而 §7 的运行时版本、以及「profile patch 里 `@deepseek-ai/*` 的 insert 行是否与运行时同版」都按这份清单判——后者还决定哪些挂载行会被上游 boot 期**静默禁用**。这条链此前没暴露，是因为该门禁在**拿不到 semver 时 SKIP**，而旧链的产物树恰好提供不了；本次源码产物树能提供（`dsh-shell-termux/node_modules/semver`），门禁随即真判。教训：门禁的 SKIP 分支会掩盖「判据输入本身已经不存在」这类问题，SKIP 期间被放过的东西不构成「验过」。
    **修法**：新增 `scripts/source-build/restore-overlay-pins.mjs`，在 APK 步骤按 `source-build-policy.json` 记下的摘除清单把钉并回 `engine-overlay.json`（同名不同版判红、清单缺席判红、幂等），还原事实写进 policy provenance；workflow 既有退出 trap 仍把原 overlay 覆盖回去。**不能改为在快照构建期保留**——那正是上面要防的回拉路径。
    **复验证据**：本地端到端复现——按来源链摘掉 315 个钉后 `check-contract.mjs` 复现出与 CI 逐字相同的判红；跑还原脚本后第 7 节转绿（14 条 insert 全过、0 条会被禁用，含两条按 overlay 判同版的引擎包 insert 行），工作树随后还原干净。

202. **来源链现场生成一次性签名证书，等于重新引入 e65818a 修掉的缺陷（2026-09-27，签名专项核查）**：
    **现象**：来源审计构建的 APK 签名证书与仓库内置 `keystore/debug.keystore` 不同（实测 `64:FA:4B:7E…` vs `1D:DE:9D:98…`），且两次来源构建的证书互不相同（上一版 0.1.5-rc.1 的产物是 `4642e0dc…`）。后果：产物既不能 `install -r` 覆盖已有安装（必须先卸载，卸载清数据又触发快照全量重解压），两个版本的来源包之间也互相覆盖不了。
    **真因**：workflow 的签名步骤先 `rm -f keystore/debug.keystore` 再用 keytool 现场生成一张 `CN=DSH Source Build,OU=Ephemeral` 的证书，`repoDebug` signingConfig 于是签的是这张一次性证书。而项目规范恰恰相反且是有来历的——commit `e65818a`（2026-08-20，在 upstream/main 上）：「ci: 内置 debug.keystore 固定签名（否则每次构建新密钥，用户无法覆盖安装升级）」；`gotchas` 坑 10 / `DEPENDENCIES.md` / `design.md` 三处都写着「debug.keystore 固定，否则覆盖安装失败」；（历史）当时的独立快照 workflow `build-snapshot.yml` 就是把仓库 keystore 拷进 `ANDROID_USER_HOME` 以保证 CI 与历史发布同签名；该 workflow 已于 0.14.5 删除（快照构建入口收敛为 `build-apk.yml` / `release.yml`），但这条规范本身不变。**用一次性证书区分「审计产物 ≠ 发布」这个目的，已由 `-source` 版本后缀与独立 artifact 名达成，用换签名来达成的代价是产物直接不可用。**
    **修法**：删除该步骤的 `rm` + `keytool -genkeypair`，直接使用入库的 keystore；新增产出侧断言——构建后用 apksigner 读 APK 的 `Signer #1 certificate SHA-256 digest`，必须等于固定指纹 `1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd`，否则拒出包并把该指纹写入 provenance。**判据放在产出侧而不是输入侧**：只有产出能证伪「keystore 文件在、构建却用了别的密钥」，同时也挡回「再现场生成一次性证书」那种改法。
    **顺带排除的陷阱**：`keytool -list -v` 的输出**不可作为机器判据**——它随 JVM 语言变化（本机 JDK 24 直接输出德语），且在这份 keystore 上会抛 `IllegalFormatConversionException: d != java.lang.String`（`printX509Cert`/`withWeakConstraint`）。故输入侧只查文件在场，指纹一律从 apksigner 读（输出稳定、不本地化）。
    **复验证据**：正证——用入库 keystore 签出的 APK 经 apksigner 读到的指纹 `1dde9d98…45bcbd` 与断言常量逐字相等；反证——本次 run 36296811274 的产物（一次性证书 `64fa4b7e…`）与旧版产物（`4642e0dc…`）代入同一断言均判红。

203. **签名判据锚定 apksigner 的行标签：新版把它从 `Signer #1` 改成 `V3.0 Signer:`，解析取空后静默判死（2026-09-27，远程 run 36303902361）**：
    **现象**：run 36303902361 在 gradle `BUILD SUCCESSFUL`、APK 已产出之后，于 APK 步骤**静默退出 1**——日志里 `APK=` 之后一行输出都没有，分不清是清单为空、还是工具没解析到。前一轮（36300505103）同样症状。
    **真因**：签名断言用行首锚定的 `sed -n 's/^Signer #1 certificate SHA-256 digest: //p'` 取指纹，而 runner 上的 build-tools `37.0.0` 把签名者标签改成了**按签名方案版本编号**的形式：
    ```
    V3.0 Signer: certificate DN: C=US, O=Android, CN=Android Debug
    V3.0 Signer: certificate SHA-256 digest: 1dde9d98…
    ```
    标签不再是 `#1`，锚定式 sed 恒不命中 ⇒ 取到空串；空串又被 `test -n` / 字符串比较静默吃掉，于是「判据没生效」表现为「命令莫名退出 1」。探针实测定性（run 36311334613 的 PROBE A/B/C）：`--print-certs` 本身就打印 `V3.0 Signer:`，与是否加 `--verbose` 无关——**问题在标签措辞，不在输出流向**。
    **修法**：判据不再依赖任何行的前缀与措辞——抓 stdout+stderr、加 `--verbose`、去掉冒号并转小写后，只要求**期望指纹出现在输出里**；不出现就把 apksigner 原始输出整段打进日志再判红。另加构建前**自证**：用同一把 keystore 签一个探针包再读回来，验证「这条判据本身可用」，使工具/keystore 的问题在 2 分钟内暴露，而不是等 30 分钟打包跑完才在末尾判红（那两轮各烧掉约一小时，且产物被丢弃）。
    **复验证据**：探针 run 36311334613 打出 `V3.0 Signer: certificate SHA-256 digest: 1dde9d98…`（PROBE A/B/C 三种取法）；修后 run 36307651694 全链通过，日志 `签名检查 out/v0.14.2/…apk -> 1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd`；本地用**另一个版本**的 apksigner 独立复核同一 APK，证书 DN `C=US, O=Android, CN=Android Debug`、指纹同为 `1dde9d98…`。

204. **上游退役补丁后，来源链的期望补丁集与适配器锚点没跟上（2026-09-27，远程 run 36311846352）**：
    **现象**：合并上游 0.1.7-rc.2-fx-1（#269）后重跑来源构建，第 14 步 `Apply project patches to the source-built marketplace` 抛 `shared patch runner changed; review the source-build marketplace adapter before updating it`，构建在约 10 分钟处终止。
    **真因**：#269 让 `market-A`、`market-C` 两个市场补丁退役（上游 0.1.7 自己修好了 A 的 waterfall 崩溃；C 的置灰对象被上游 `installCheck` 过滤掉，客户端拿不到不可安装的行），共享执行器 `scripts/patches/apply-patches.mjs` 里 A 的锚点整段消失。来源链适配器 `apply-source-marketplace-patches.mjs` 仍按旧锚点做「源码构建产物专用改写」，锚点断言失败即判红——**这是守卫按设计工作**：它要求人工复核适配器，而不是静默生成一份错的执行器。同一处 workflow 的期望集 `expectedPatches` 也还写着 A、C（适配器过了下一步照样判红）。
    **修法**：按守卫要求复核后——适配器删掉已成死代码的 A 改写，只保留「把生成副本的 HERE 指回 `scripts/patches`」那一处（锚点整体失配不需要适配器兜底：共享执行器对「check 为假且 apply 零改动」本就判红并拒报 ALL OK）；workflow 期望集去掉 A/C，并**加反向断言**「退役补丁不得悄悄回到注册表」，重启退役补丁必须人工复核来源链。
    **为什么记进坑位**：来源链与主链共用同一份补丁执行器，**上游每退役一个补丁都可能同时打断两条链**——主链会自动跟随注册表，来源链却带着自己的期望集与锚点改写，属于「同一事实两处登记」的典型漂移面。
    **复验证据**：本地以 `vendor` 跑适配器（check 档）→ `apply-patches: ALL OK（13/13，changed=0）`、vendor 树零改动；期望集/退役集断言按注册表实跑通过；完整来源构建须由下一次远程 run 验证。

205. **镜像追到上游发布字节后，来源链还在重建旧源码树：市场补丁锚点必然失配（2026-09-27，远程 run 36312684359）**：
    **现象**：修掉期望集之后重跑，第 14 步改为 `[fail] market-D-server: D 插入锚点未命中——apply 函数与 export 绑定都不在场`，构建再次在约 10 分钟处终止。本地以镜像跑 check 档却全绿——**本地验的是镜像，CI 验的是源码重建产物**，两者不是同一个输入。
    **真因**：`vendor/dshmarketplace-plugin/PATCHES.md` 写得很清楚：镜像来自 **npm 发布的 `dshmarketplace-plugin-0.1.7.tgz`**（用户报障「市场从 UI 里消失」，本轮把上游字节整体追到 0.1.7），全部 market-* 补丁也随之按**发布字节**重定锚。而来源链仍钉着组件源码树 `8354d9a0…`（0.1.5），并且还会对该目录跑一次 `npm ci && npm run build` —— 用不同工具链重建出的 minified 字节与发布字节不同，补丁的 check/apply 锚点在它上面全部落空。此前没暴露，是因为适配器里有一段「源码构建专用改写」把 A 的闭合形态差异兜住了；0.1.7 退役 A 时那段改写一并消失，兜底随之失效。
    **修法**：来源链改用**固定 npm 发布产物**作为该组件的输入——`curl` 拉 0.1.7.tgz、`sha256sum --check` 对照钉在 workflow 里的哈希、解包进 `vendor/dshmarketplace-plugin`；**把它从插件源码构建循环里移除**（发布产物自带打包好的 `lib/`，重建只会换掉字节）；provenance 从「上游 commit/tree + 源码文件哈希」改为「发布 tarball URL + 哈希 + 包版本」。这条输入与 Koffi/Sharp/Canvas/Termux 同类：**可信二进制输入，显式披露并钉哈希**，不声称本地源码编译。
    **复验证据**：本地端到端复刻该流程（拉 tarball → `sha256sum --check` OK → 解包 → 按 CI 同一命令打补丁）后，`lib/index.js` 与 `lib/client.js` 与仓库镜像**逐字节一致**（LF 归一后同哈希）；这同时证明了「发布产物 + 注册表补丁 = 镜像」这条等式成立。完整来源构建须由下一次远程 run 验证。

206. **pnpm 布局下引擎补丁只打顶层副本，store 那份未打补丁 ⇒ 引擎 boot 硬崩（2026-09-27，真机 HUAWEI SGT-AL10 实测）**：
    **现象**：来源审计 APK 装机后引擎起不来，`engine.log` 首行 `dsh: host preparation failed: No usable native binding found for node-addon-require-builtin-android-arm64 (auto)`，三种候选（optional 包 / `build/nodeabi/node-v137-android-arm64` / `build/napi/napi-v9-android-arm64`）全落空，`info.txt` 记 `engine_exit: exit=1`。
    **真因**：`node-addon-require-builtin` 上游**不发布 Android 产物**，项目对策是引擎树补丁 `narb-android-N1`（把 `createEntryApi()` 包进 try/catch，回落 `require(moduleId)`，靠壳侧 `--expose-internals` 生效）。但来源链的引擎树是 **pnpm 布局**：同一包在顶层物化目录与 `node_modules/.pnpm/**` store 各有一份**物理文件**，而补丁只按登记表的顶层 target 写入 ⇒ store 副本保持原始字节；运行时按依赖查找解析到的正是 **store 那份**（设备栈路径即 `.pnpm/node-addon-require-builtin@0.1.6/...`）⇒ 加载未打补丁代码 ⇒ boot 硬崩。同批实测 **`pi-toolcall-G2`** 的 store 副本同样未打上——该补丁在设备上等于从未生效（静默功能缺失）。正常（LFS）链没有这个问题：它的引擎树是扁平 npm 布局，不存在 `.pnpm` 副本。
    **为什么 CI 全绿却发得出去**：快照检查器抽验 marker 时只看**顶层 target 那个文件**（恰好是打过补丁的那份），「同一目标的其它物理副本是否也带 marker」这条判据根本不存在。
    **修法**：新增 `scripts/source-build/reconcile-engine-patch-copies.mjs`——构建期把已打补丁那份的字节写全到「同包 + 同包内相对路径」的其余副本；目标找不到、或所有副本都缺 marker 一律判红。接进快照步骤（重打包之前），报告随 artifact 附出。同时给检查器加**副本面判据**「任何物理副本都不得缺 marker」，并在两个 workflow 的早期步骤跑新单测。
    **踩到的两个坑中坑**（都已固化成用例）：① 判据若用「路径结尾相同」匹配，`lib/bin.js` 这类短后缀会把**别的包**的同名文件误判成副本（实测把 `dsh-experimental-webworker-packer/lib/bin.js` 报成未打补丁）；引擎根包自身的文件必须**精确相等**。② 匹配器的「根」在两个调用点必须同一约定（引擎根 = `@deepseek-ai/dsh` 目录本身）——一度出现检查器传引擎根、收敛脚本传 stage root 的错位，导致精确匹配恒落空。
    **复验证据**：以真实快照的引擎树为靶——收敛前核对报 2 个目标各 1 份未打补丁副本（N1 的 872 B store 副本、G2 的 64152 B store 副本），跑收敛脚本后为 **0**，改写副本与已打补丁那份 sha256 逐字节一致；新单测 5 例全绿（含短后缀误报反证、幂等、全缺 marker 判红、目标缺失判红）。

207. **来源审计链的专有门禁不在任何清单里：新增第三条链时漏了「谁跑哪些门禁」这一步（2026-09-27）**：
    **现象**：来源链的 5 个专有门禁——`check-package-lock-roots` / `check-dsh-runtime-dependencies` / `check-android-native-runtime-packages` / `check-dsh-source-snapshot` / `check-dsh-source-snapshot-gate`——既不在 `check-release-gates.mjs` 的声明集合（32 项）、也不在 `build-apk.mjs` 的 `GATE_SCRIPTS`、也不在 `check-gate-skips.mjs` 的链枚举里；全仓只被自己那条 workflow 与 docs 引用。实跑 `node scripts/check-gate-skips.mjs` **仍然 PASSED**——盲区是隐形的。其中 `check-package-lock-roots.mjs` 最脆：单测只 import 纯函数 `checkPackageLockRoot`、不走 CLI 主块，两个 workflow 里的调用点删掉后脚本与单测都还在、三条链全绿，而门禁**从未真跑**。
    **真因**：新增一条构建链时，没把它的门禁登记进「谁跑哪些门禁」这条纪律。而 `check-gate-skips.mjs:78` 的 `CHAINS` **不能简单加第三条**：`executionSites`（:67-77）只认 `.mjs` 的 `gate('x.mjs')` 与 pwsh 的 `node … scripts\check-x.mjs` 两种形态，**没有 YAML 分支**；强行加入会让「声明集合每一项都被本链调用」这条断言对来源链必然判红（它只间接经 `build-apk.mjs` 跑）。同族的两处非递归扫描：`node --check`（`check-release-gates.mjs:251`）只列 `scripts/` 与 `scripts/lib` 两层，`scripts/source-build/` 等 5 个子目录共 **47 个 `.mjs` 从未被解析过**；SKIP 审计（`check-gate-skips.mjs:102`）的 `readdirSync` 同样非递归。
    **修法**：① `check-release-gates.mjs` 新增独立常量 `SOURCE_GATES` 与第三条链位置 `source-chain`（沿用 `ci-apk` 的 `needsApkTree` 模式；**刻意不进 `GATES`**——`ALL_GATES = GATES.map(...)`，进册会要求本地链与云端链也调用它们）；② 同文件 `node --check` 扫描面改为**递归**遍历 `scripts/` 全树；③ `check-gate-skips.mjs` 的 SKIP 审计同样改递归。
    **复验证据**：`PASS source-chain 门禁集 ⊇ 声明集合（5 项）`。判别力反证——把 workflow 里 5 个调用点全删 → 5 个全报；只删 1 个 → 精确报那一个。扫描面 75 → **122 个**、SKIP 审计 37 → **44 个**，两门禁仍 PASSED。
    **未闭合**：`CHAINS` 的反向断言（声明项必须有真实执行点）对第三条链仍无对应实现——本轮用 `source-chain` 位置覆盖了「声明了却没接线」这个主方向，其余待后续把 `executionSites` 扩到 YAML 形态。

208. **判据「空过」：空集恒真、静默 continue、地板值远低于现实（2026-09-27）**：
    **现象**：四处新判据在「输入为空」时恒真，即**因为什么都没找到而判绿**。
    ① `check-package-lock-roots.mjs` 的受检集合是**发现式**的（只收存在 `package-lock.json` 的目录），旧实现无空集守卫：删掉/改名任一锁文件它就静默退 0，打印「一致: N 个目录」。而 `build-apk-source.yml` 的插件循环按 `if [ -f package-lock.json ]` 决定 `npm ci` 还是 `npm install`——**锁一缺就从「严格按锁文件」降级成「重新解析版本区间」，产出不再可复现而全链绿**。（对照：同一 workflow 的 pnpm 侧用的是 `--frozen-lockfile`，锁不符即失败。）
    ② `check-dsh-source-snapshot.mjs` 对 engine 补丁 `if (!marker) continue`：删掉 `marker` 字段、或写成全角括号注释（`replace(/（.*$/, '')` 后为空），该补丁就**同时退出**本判据与 `reconcile-engine-patch-copies.mjs` 的副本收敛（同一过滤条件）——两条路径一起静默跳过，而原注释承诺的「新增补丁自动纳入，无需再手改本文件」随之落空。
    ③ `check-android-native-runtime-packages.mjs` 的 `unreviewed.length` 在清单为空时恒为 0；采集根只有 `node_modules/.pnpm` 一处，且 `filesUnder` 显式跳过符号链接，布局一变（物化后第一方载荷挪到顶层）就会收不到东西。
    ④ `check-dsh-runtime-dependencies.mjs` 的地板值 `packageCount < 200`——实测 316/317，**静默少掉一百多个包也照样判绿**；同一条链上 `materialize-dsh-pnpm-packages.mjs:21` 用的是 `>= 266`。
    **修法**：① 加具名目录断言（`dsh-client-ui-responsive` / `dsh-shell-termux` 不靠发现、是写死在 `packageDirectories` 里的）与空集判红；② 加 markerless 计数并在核验前判红——要么补 `marker`，要么在 registry 显式登记 `overlayCheck:false` 走豁免（豁免有留档，与「忘了写 marker」不是一回事）；③ 加 `nativeInventory.length === 0` 守卫；④ 地板抬到 **266**，与同链 `materialize` 同源。
    **复验证据**：加守卫前先实测确认现状不会误伤（9 个受检目录全有锁、13 个 engine 补丁 marker 全非空、两处原生清单均为 27 项、实际包数 317）。① 正例「一致: 9 个目录」退 0 不变；反证——空集时逐条指名并退 1。全部 6 个 `source-build` 单测保持 PASS。

209. **来源链在解压校验处写 `xz -T0`，违照明文的并行上限铁律而门禁看不见（2026-09-27）**：
    **现象**：`scripts/source-build/check-dsh-source-snapshot.mjs:74` 解压快照做校验时用 `spawn('xz', ['-d', '-T0', '-c', snapshot])`——`-T0` = 吃满全部逻辑核。
    **真因**：`check-build-parallel-cap.mjs` 的受约束清单 `CONSTRAINED` 只有 5 个既有脚本，**来源链一个都不在**；且它的第 1 节只抓 `-T0` 字面量，第 3 节的「写死数字」判据只覆盖 `build-snapshot-013.mjs` 与 `build-apk-013.ps1` 两个文件。于是这条明文铁律（「模拟器优先」，其立项理由正是『构建链原先在压缩/解压处用 `xz -T0`』）在来源链上完全不受约束。本地跑 `run-local-source-chain.mjs`（文档化入口）时会与 MuMu 抢满 16 逻辑核；CI runner 只 4 核，云端反而无害。
    **修法**：改为消费单一常量 `-T${XZ_THREADS}`（从 `scripts/lib/shell.mjs` 导入），并把该文件列入 `CONSTRAINED` 锁住回归。
    **复验证据**：`PASS scripts/source-build/check-dsh-source-snapshot.mjs 无吃满型线程参数（-T0）`；判别力反证——`-T0` 字面量判红、`-T${XZ_THREADS}` 通过；`PARALLEL-CAP SELF-TEST PASSED`。
    **未闭合**：来源链另有两处**有界**的写死线程数（`prepare-termux-bootstrap.py:168` 的 `-T4`、`build-apk-source.yml:673` 的 `-T8`）——不吃满核，但要完全符合「并行度来自单一常量」须改构建命令本身，本轮未动，已在 `CONSTRAINED` 处登记。

210. **来源链不是逐字节可复现：两个独立根因，且「哈希恒漂」会让完整性判据整个失效（2026-09-28，两次远程 run 实测）**：
    **现象**：`3ec3b68` 与 `45bf047` 两次构建——两者**只差 8 个判据文件、一个都不写快照内容**——产出的 APK sha256 却不同（`7aff2320…` vs `99f64ede…`，artifact 相差 459 B）。
    **逐层定位**（这层比"哈希不同"本身重要，因为定位方法要能复用）：229 个 APK 条目 **SHA-256 级比对 → 227 个完全相同**，只有快照本体与其 `.sha256` 随从文件不同；再把两个 `assets/snapshot.tar.xz` 解包、对 35053 个常规文件逐个 sha256 → **264 个不同**。按目录归类后发现 264 里有 **259 个是 `@deepseek-ai/*/package.json`**，且**只差对象键序**（`{"include":…,"loader":…}` 与 `{"loader":…,"include":…}`），内容逐字相同。再往上追：316 个引擎包中 **260 个的 tarball 哈希本身就不同，而 version 全部相同**。
    **两个根因**：
    **① `pnpm pack` 产出的 manifest 键序不稳定**（主因，260/316 个包）。打包点是 `export-dsh-engine.mjs:74`，而该处注释写的意图恰恰是「packed manifests stay exactly as their source commits」——**意图是确定性，结果不是**。键序不确定的具体来源（pnpm 自身还是 harness 构建阶段）未定位到，故修法取「不管根因、在产出侧钉死」。
    **② `dpkg/available` 直接写入整份活上游索引**（次因，1 个文件）。`build-snapshot-013.mjs:586` 把 `indexText`（3000+ 条）整份倒进快照，而 `status`/`status-old` 只写 `needed`（本链实际装的 79 个包）——同一个函数里唯独这一个文件例外。索引由 `prepare-termux-signed-repo.py:84` **活取**（`:87` 只做「与签名 Release 比对」，证明索引是真的，却没证明它是钉版时那一份）。实测两次运行相隔 90 分钟，索引 sha256 已从 `795749e0…` 变为 `2bf37bba…`，连签名的 Release 都换了（`0707fca9…` → `4ec8dc46…`）——上游掉了 `codon`、`ecl` 两个**与本链毫无关系**的包。
    **为什么这条比"哈希不同"严重**：本链的核心主张是可来源审计、可外部复核，而验证闭环是「重跑 → 得到同一哈希 → 于是相信产物来自那份源码」。哈希恒漂 ⇒ 闭环不成立；更隐蔽的是**它把信号也一起淹没**——「两次构建哈希不同」从此不再是信号，那么真正该被发现的问题（比如某次构建静默少了个包，见坑 207-208 同族）就失去了最廉价、最强的兜底判据。**恒亮的警报灯等于没有警报灯。**
    **修法（三段，各自独立可用）**：
    **① 语义归一化**——新增 `scripts/source-build/normalize-snapshot.mjs`：把**表示层**差异（JSON/YAML 映射键序、pnpm 的时间戳字段 `prunedAt` / `lastValidatedTimestamp`）从摘要里剔除，给出稳定的 `normalizedManifestSha256`。三条设计约束缺一不可：**规则封闭**（每条写清"为什么这个差异不可能影响行为"）、**可无依赖复算**（外部人拿产物+脚本即可重算，不引第三方包，故 YAML 自带受限块映射归一化器）、**响亮失败**（遇到不认识的形态一律 throw）。关键边界：`dpkg/available` 那类**真**差异（包数 3003 vs 3001）**刻意不归一化**——把它和键序归入同一句"反正不影响"，就是给静默失败开后门。接入 `check-dsh-source-snapshot.mjs`（并把解包从"只解引擎前缀+canvas"改为全量，与外部复核方看同一份输入）。
    **② `pnpm pack` 之后就地规范化 tarball**（`export-dsh-engine.mjs`，落在 `packed.push` 记录哈希**之前**）：解包 → `canonicalJson` 重排 → 重打包。放在这里而不是产物末端，是因为此处上游尚无任何哈希被记录、也没有签名，规范化后的字节**就是**构建产物本身，此后所有 provenance 描述的都是真正发货的东西；放到末端则要重做 tar/xz、重打 zip、**重新签名**，反而引入三个新的不确定性来源。重打包自身确定用**可移植**手段（不依赖 GNU 专有开关——本机是 bsdtar，用它就要等一小时 CI 才知道对不对）：显式递归排序的条目清单定顺序、`utimesSync` 钉 mtime、不指定属主、gzip 经管道不写名字与时间戳。
    **③ `dpkg/available` 改由 `needed` 生成**（`build-snapshot-013.mjs`）：解析索引时留「包名→原始块」映射，输出 `[...needed].sort()` 的块。按名排序是必须的——索引自身的块顺序不保证稳定，不排序等于把不确定性从"包集合"挪到"块顺序"；`status` 本来就是 `[...needed].sort()`，两者口径遂一致。
    **复验证据（A+B 之前）**：归一化器在两个真实快照上跑——**归一化后仍不同的条目数 = 1，且正是 `usr/var/lib/dpkg/available`**（即设计上刻意不归一化的那条），证明规则清单既够用（263 个表示差异确实都是表示层的）也没越界。11 个单测全绿，含**四条反证**：YAML 序列不得被排序（判红）、时间戳字段缺席不得放过（判红）、**真差异绝不能被归一化吞掉**（多一条依赖/改取值/多一个文件/非 JSON 内容变，四个变体都必须使摘要不同）、**tarball 里的真差异不得被重打包抹平**。
    **复验证据（A+B 之后，同提交 `a0d1534` 并行两次构建）**：逐文件差异从 **264 个降到 3 个**——259 个 `package.json` 键序差异全部消失（B 生效），`dpkg/available` 不再是差异（A 生效）。剩余 3 个是 **pnpm 自己在 deploy 阶段生成的状态文件**（`node_modules/.modules.yaml` 的 `prunedAt`、`node_modules/.pnpm-workspace-state-v1.json` 的 `lastValidatedTimestamp`、引擎根的 `pnpm-workspace.yaml` 键序）——它们不在 B 的射程内（B 规范化的是 `pnpm pack` 产出的 tarball，而这 3 个在其后生成），但**全部已被归一化规则覆盖**。两个 run 各自记录的归一化摘要**逐字相同**（`ca8c7b69ea471824…`），我从两个 APK 各取出快照独立跑归一化器也得到同一值（`6899f4ed3f8ff3ae…`，两次相同）⇒ **语义可复现成立**。未继续追「原始 sha256 相同」：剩下那 3 个是 pnpm 的内部状态文件，运行时 pnpm 可能读它们，改写状态文件的风险大于它买到的收益。
    **⚠️ 同批踩到的坑中坑（坑 183 同型复发，已修）**：归一化最初放在**检查器**里，而检查器看到的是 `.deploy-tmp/.../snapshot.tar.xz`——**注入前**的那份；APK 装的却是 `build-apk.mjs` 经 `inject-all.py` 生成的 `snap-final2.tar.xz`（**注入后**）。两者条目数都不同（CI 记 42443，从 APK 实测 42839，差 396）。后果是**公布的摘要描述的不是发货产物**，外部复核方（只有 APK）根本复算不出来——而「可被外部独立复核」正是这条链的核心主张。`build-apk.mjs:304-320` 那一串既有门禁**全都跑在 `snapIn`（注入后）上**，只有新加的这一处跑在注入前。**修法**：从检查器移除，改由 workflow 新步骤「Snapshot semantic normalization digest」在 `build-apk.mjs` **之后**执行——直接 `unzip -p <APK> assets/snapshot.tar.xz`、解包、归一化，即**与复核方做完全同一件事**，产出 `snapshot-normalization.json` 随 artifact 附出。教训与坑 183 一致：**凡是「公布给外部的产出侧数字」，都必须取自最终产物本身，而不是取自它之前的中途文件。**
    **未闭合（B 的确定性与剩余风险）**：A+B 是否真能让两次构建的**原始** sha256 相同，须由「同一提交并行两次构建」实测；若仍不同，则还有第四类不确定性（例如 `pnpm pack` 之外的时间戳或 harness 构建阶段）。另：`preinstall.json` 的 `targets` 仍只有包名、不带版本，`.deb` 的版本与哈希同样来自活索引——上游抬版本时会静默换包，尚未钉。

211. **来源链 APK 比正常链大 3.1 倍：完整 pnpm deploy 按 Linux 宿主平台拉进了 1.2 GB 的 Linux 原生载荷（2026-09-28）**：
    **现象**：来源审计链产出的 APK **489 MB**，而正常链的正式发布包只有 **158 MB**——同样跑 `assembleDebug`、同一把 keystore、同一个引擎版本，体积差 3.1 倍。
    **逐层定位**（这个方法可复用）：把两边的 `assets/snapshot.tar.xz` 分别取出来、`tar -tvJ` 列清单、**按目录聚合体积**——比总数差分更能指向真凶：
    ```
                         他们        我们
    解压后总计        700.1 MB   2016.8 MB
    usr/lib/node_modules  189.0 MB  1629.4 MB   ← 差异全在这里
    usr/lib/perl5          53.0 MB    53.0 MB   ✓ 逐字节相同
    usr/bin/node           43.2 MB    43.2 MB   ✓
    libicudata.so.78.3     31.6 MB    31.6 MB   ✓
    usr/lib/ruby           29.5 MB    29.6 MB   ✓
    usr/share/vim          25.6 MB    25.4 MB   ✓
    ```
    条目数我们**更少**却**体积更大** ⇒ 差异必在少数巨型文件。再对 `node_modules` 单独聚合，前几名是：`@openai/codex` 的两个 Linux musl 二进制（246.7 + 212.3 MB，另有 `codex-code-mode-host` 66.2 + 60.4 MB）、`claude-agent-sdk-linux-{x64,arm64}`（205.7 + 205.2 MB）、`cua-driver-linux-*-gnu`、`sherpa-onnx-linux-*`、`sharp-libvips-linux-*`……
    **真因**：来源链做的是**完整 `pnpm deploy`**，而 CI 跑在 **Linux** 上 ⇒ pnpm 按**宿主平台**解析 `optionalDependencies`，把 `linux-x64` / `linux-arm64` 的原生载荷一并装进引擎树；**Android 是 bionic**，这些 glibc/musl 二进制在设备上永不加载。正常链没有这个问题：它从**设备基座**出发，基座上本就没有这些 Linux 载荷——所以「正常链有没有」是一条**已被设备验证过**的可靠判据（实测这批包在正常链快照里**一个都没有**）。
    **为什么之前没被发现**：`check-android-native-runtime-packages.mjs` 早就**看见**了它们，但定性是「跨平台部署的**外平台 payload**，不视为 Android 绑定」——**只记录不拦截**；而「快照内每个包都要有来源」这条反向面判据（`check-engine-overlay.mjs` 里有）**在来源链换门禁时没有对应实现**（见坑 200 的未闭合项），于是没有任何判据要求它们离开。**记账 ≠ 防线。**
    **修法**：`snapshot-config/slim.json` 新增 `platformDeadPackages`（21 条，逐条带平台与理由），`build-snapshot-013.mjs` 在 `engineStalePackages` 之后施加。删除面覆盖 pnpm 布局下实测在场的三处：`.pnpm/<enc>@<ver>*`（实体与大文件）、`.pnpm/node_modules/<pkg>`（提升副本）、顶层物化副本。守卫沿用 `engineStalePackages` 的形态：**命中的包若已在 overlay 登记表内即中止**（防把真依赖删掉）。
    **判据的两次修正（本节最该带走的东西）**：本条的判据先后错过两次，都记在这里以免重蹈。
    **第一版：按名字。**「包名里有 `linux` 就删」——错。`@openai/codex` 与 `@vscode/ripgrep-linux-*` 是 **`-musl` 目标的静态 ELF**（实测：无 `PT_INTERP`、`GLIBC_2.*` 与 `libc.so.6` 符号各 0 命中），**Android 内核就是 Linux，静态二进制能跑**；而 `claude`、`libcua_driver_sdk.so`、`libonnxruntime.so`、`libvips-cpp.so`、`koffi.node` 才是有 `INTERP=/lib/ld-linux-aarch64.so.1` / GLIBC 符号的 glibc 件，**确实死**。判据应为**实测 ELF 的 `PT_INTERP` + GLIBC 符号**，不是名字。
    **第二版：按「与作者发布保持一致」。** 也错——**他的发布里同时含退役件与个人插件**：`dsh-attachment-formats`（PDF/Office/OCR 过渡插件，**0.13.7 用户已拍板退役**，注释原话「包体仍在基座快照内，不再装载即等于退役」）连同其 80 个依赖（mammoth/exceljs/pdfjs-dist/tesseract.js/jszip…）躺在基座里；另有 `dsh-code-diff-viewer`、`dsh-find-plugin`（他从市场装的私人插件，见 profile 的 `.package-map.json`）。**「他有我无」不构成缺口，「他有」也不构成依据。**
    **第三版（最终）：判据是「不对称」的，两个方向不能互推。**
    - **删掉「他的发布里也没有」的 ⇒ 安全。** 他的发布是**设备验证过的运行配置**：「没有这些也能跑」是实测结论，比任何静态分析都直接。本条剔除的平台件正属于这一类。ELF 实测（第一版）回答的是「**能不能跑**」，回答不了「**该不该有**」——`@openai/codex` 确实能跑（静态），但删它仍然安全，因为**他的发布里同样没有它而应用照跑**。
    - **补上「他的发布里有」的 ⇒ 不成立。** 他的基座里混着**退役件**与**个人插件**（见第二版），「他有」不构成「我们该有」的依据。
    我此前正是用后一个方向的证据去否定前一个方向，才来回翻。**结论：按「他也没有」做减法是对的（本条全 21 条照删）；按「他有」做加法是错的（那 83 个包不补）。**
    另注：profile 的 `node_modules` 本就是**给后来安装的树外插件**准备的（上游 `profile.ts`：「the hoisted linker gives **out-of-tree plugins** a flat node_modules」；`pnpm-workspace.yaml` 里 `nodeLinker: hoisted`）——故「镜像里没带、用户后续自己装」是**设计内的路径**，不是能力缺失。
    **权威清单仍是最终依据**：某条该不该删，先看 `profile-web.cordis.patch.yml` / `engine-overlay.json` 的装配行与 `slim.json` 的退役记录；产物对比只是线索。本键**分设两处**：`libreoffice-kit-wasm`（145 MB）体积可观但是 **WASM、平台无关**，必须保留；平台件另立 `platformDeadPackages`、逐条写明平台与理由。
    **方法教训（本轮付了两次假警报的代价）**：拿两份产物做「他有我无」对比时，**基座的偶然内容会一直污染结论**——退役件、个人插件、安装残留都在里面。必须先查权威清单再下结论。三次对比里**只有一次是真命中**（`usr/lib/node_modules` 我们 1614 MB vs 他 189 MB）；另两次（`home/.dsh/profiles` 我们小 101 MB、83 个包「只在他们有」）**全是上面那两类**。
    **复验证据（静态）**：用真实快照清单模拟匹配——715 个 store 目录中命中 23 个，**21/21 个包全覆盖**（另两处删除面亦确认在场）。量化：将剔除 **1210.2 MB**（未压缩），快照 2017 MB → 约 807 MB（降 60%）。
    **复验证据（远程 run 36363497221 / 36363504676 实测）**：**精简完全生效**——`归档 snapshot.tar.xz (158.3 MB)`，即 **483.5 MB → 158.3 MB**，与正常链的 153 MB 同量级；快照步骤耗时 **9.8 分钟 → 约 2.3 分钟**。
    **⚠️ 同批被安全网拦下（这正是它该有的行为）**：两条 run 都在 `Build runtime snapshot` 判红 ——
    `@deepseek-ai/dsh-subagent-codex -> @openai/codex: no installed package.json in the deploy tree`。
    定位时**已经看到**这条依赖（「被依赖 1 处，来自 `@deepseek-ai/dsh-subagent-codex`」），但当时判断「它是 musl ELF、Android 上本来就 exec 不了，删与不删功能等价」——**功能判断对，声明仍在**，所以 `check-dsh-runtime-dependencies.mjs` 判红有理。注意它与此前那几个不同：`@openai/codex` 的**包名是中性的**（不像 `-linux-x64` 那样带平台后缀），只是**内容**是 Linux 二进制。
    **修法**：让检查器认识「刻意缺席」——读同一个 `slim.json` 的 `platformDeadPackages`，命中的缺依赖**不计 failure 而单独计数**（`deliberatelyAbsentCount` / `deliberatelyAbsent[]` 进报告）。三条理由：① 该二进制在设备上本来就 exec 不了，删与不删功能等价；② **正常链的设备验证快照里同样没有它**，而正常链跑得好好的；③ 清单与判据自洽——**谁把某条从 `platformDeadPackages` 删掉，这里立刻恢复判红**。「放过不等于静默」：刻意缺席单独计数列进报告，外部复核方看得到。
    **未闭合**：`@deepseek-ai/libreoffice-kit-wasm`（145 MB）**刻意保留**——它是 WASM，「正常链没有」不足以定它的死（正常链的基座是 0.12.5-fx-1 时代抓的，该包可能只是当时还不存在）。要动它必须先做一次真机文档转换验证。另：本批未做真机启动验证，`@openai/codex` 的缺席对 `dsh-subagent-codex` 子智能体的实际表现（报错形态是否可接受）须由设备确认。

212. **来源链漏了聚合门禁的前置：调 `build-apk.mjs` 却不跑 Kotlin 单测，必然死在那条门禁上（2026-09-28，run 36365082160）**：
    **现象**：平台死重剔除修好后，来源链**第一次走到 APK 步**（此前都在快照步骤就断了，正是这一点掩盖了本条），随即判红：
    ```
    CHECK-KOTLIN-TEST-COUNT FAILED：缺 Kotlin 单测结果 …/app/build/test-results/testDebugUnitTest
      先跑 ./gradlew :app:testDebugUnitTest；无 gradle 的环境用 --allow-missing 显式 SKIP。
    ```
    **真因**：`build-apk.mjs` 是各链共用的编排器，会执行聚合门禁集，其中 `check-kotlin-test-count.mjs` **按设计**在没有 gradle 结果时判红（拒绝「一个用例都没跑」冒充通过）。上游 0.14.2-fx-2 的 G.0 ⑤ 修掉了这条结构性脱节——**去掉了 `--allow-missing`**，改为「**调用方必须先产出结果**」。本地链与发布链（`release.yml:193`）都已在 APK 步之前跑 `./gradlew :app:testDebugUnitTest`，**唯独来源链漏了这一步**。
    **为什么此前从未暴露**：来源链的失败点一直停在更早的步骤（凭据、锁文件、市场补丁锚点、平台死重…），**从没走到 APK 步**——**一个晚出现的门禁会被早出现的失败长期遮住**。而这与坑 200 同源：**新链必须逐条满足它所调用的共用编排器的全部前置，而这件事没有任何判据在守**（`check-release-gates` 只断言「声明集合被调用」，不断言「调用的前置已满足」）。
    **修法**：`build-apk-source.yml` 在 APK 步之前补「单元测试门禁前置（`:app:testDebugUnitTest` 全量）」步，与 `release.yml` 同做法；结果目录 `app/build/test-results/testDebugUnitTest` 由后续门禁就地读取并比对基线。
    **复验证据**：同一次 run 里它前面的门禁（`check-snapshot-builder-output`、`check-build-parallel-cap`）均 PASS，说明链路其余部分健康；本步补上后须由下一次远程 run 验证能否走完 APK 步。

213. **归一化摘要要求在**大小写敏感**的文件系统上复算——macOS 上会得到另一个值（2026-09-28）**：
    **现象**：来源链记的归一化摘要（`61687a40…`）与我拿同一个 APK 在 macOS 上复算的值（`0ba6a36c…`）不同，而**文件数（42783）、四条规则的命中数、跳过数（36）三项全部逐项相等**——计数全等、只有摘要不同，指向「某些条目的内容或路径串不同」。
    **排除过程**（留作方法）：① 先确认双方看的是同一份快照——APK 内 `assets/snapshot.sha256` 与我实算一致（`f8b70523…`）；② 换一个解包器（bsdtar → Python `tarfile`）得到**同一个**值，说明不是解包器差异；③ 查 tar 里有无**仅大小写不同**的路径——`tr A-Z a-z | sort | uniq -d` 命中 `usr/share/licenses/` vs `usr/share/LICENSES/`、`usr/lib/perl5/5.42.2/pod/` vs `Pod/`。
    **真因**：**macOS 的 APFS 默认大小写不敏感** ⇒ 上述两组目录在本地被**合并成一个** ⇒ 落在 `LICENSES/` 下的文件被 walk 成 `licenses/…` ⇒ manifest 里的**路径字符串**与 Linux 侧不同 ⇒ 摘要不同。**文件数不变**（合并的是目录、且无文件名冲突），这正是「三项计数全等却摘要不同」的来源。
    **结论与影响**：**链是对的，本地复算是错的**。公布的归一化摘要**确实可被外部复核**，但复算者必须在**大小写敏感的文件系统**上解包——Linux 天然满足；macOS 需挂在大小写敏感的卷上（或直接以容器/Linux 环境复算）。**同一个坑在本会话里咬了两次**（最早那次链侧 vs 我侧的摘要差异也是它）。
    **建议的复算姿势**：在 Linux（或 `--case-sensitive` 卷）上 `unzip -p <APK> assets/snapshot.tar.xz | tar -xJ`，再跑 `normalize-snapshot.mjs`；本仓的 workflow 步骤「Snapshot semantic normalization digest」即为该过程的可执行版本。
214. **两条链的 gradle 调用口径不同 ⇒ 「本地发布链」组装必失败，而开发链全绿**（2026-09-28，本机 + 5556 实测）
    **现象**：`pwsh scripts/build-release.ps1` 走到 APK 步抛 `APK build failed (arm64-v8a)`，而**日志里没有 gradle 报错**
    （该行 `2>$null | Out-Null` 把输出整个丢掉，只剩 exit code）。同一棵工作树、同一份快照，
    `pwsh scripts/build-apk-013.ps1 -Suffix ""` 两个 ABI 都 BUILD SUCCESSFUL。
    **真因**：两条链调用口径不同——
      · 开发链：项目 wrapper、**不带** `--offline`（`.\gradlew :app:assembleDebug --no-daemon -PversionNameSuffix=…`）；
      · 发布链：**系统 gradle**（`D:\tools\gradle-8.10.2`）+ `--offline --rerun-tasks`。
      系统 gradle 的依赖缓存里没有本工程的 AndroidX 产物，离线档下直接判死：
      `No cached version of androidx.webkit:webkit:1.12.1 available for offline mode`（22s 失败；core-ktx / dynamicanimation 等同因，共 7 条）。
    **定位手段（记下来）**：把 gradle 输出丢进 `$null` 的脚本，只能得到「失败」两个字。手动复跑同一条命令并保留输出才拿到真因：
      `cd dsh-mobile-apk; gradle assembleDebug --offline --no-daemon --rerun-tasks`。
    **修法**：`build-release.ps1` 与开发链同口径——`$Gradle` 缺省时改用 `.\gradlew.bat`，命令改为
      `:app:assembleDebug --no-daemon -PversionNameSuffix="$Version"`（去掉 `--offline` 与 `--rerun-tasks`）。
    **复验**：同机 `.\gradlew.bat :app:assembleDebug --no-daemon -PversionNameSuffix=""` → BUILD SUCCESSFUL in 37s；
      随后整条 `build-release.ps1` 组装通过（APK 双 ABI + 快照/插件/清单齐备）。
    **同型提醒**：凡「两条链各写一份调用」的地方，都要问「是不是同一条命令、同一份缓存口径」。
      **开发链绿 ≠ 发布链绿**——这里的差别只有一个 `--offline`。

215. **HTTP 状态不是引擎所有权证明（issue #295）**：本地 3080 上任意服务都可以返回 200、303、401 或 403；若壳侧只看状态码，会在 force/restart/update 路径把外部监听器当成自己的引擎，进而盲杀或反复 spawn。**真因**是健康探测与所有权证明混用。**修法**：`EngineProbe.check().running` 保留健康语义，但破坏性启动/停止/认证恢复必须只接受本壳托管子进程，或当前 generation 的 `engine.log` token 行；旋转日志、未知 generation、精确 origin 之外一律 fail closed。停止后及 spawn 前必须再次确认端口已释放；TOCTOU 抢占只记录一次 `PORT_FOREIGN`，不得用 `pkill -f bin.js` 兜底。

216. **启动轮询的 401 也不能绕过所有权门禁（issue #295）**：WebView 的 main-frame 401 之外，启动线程直接探测到的 401 同样可能来自外部监听器；若直接调用 `EngineAuth.handleUnauthorized`，会清理/刷新壳侧 cookie 并把非本引擎当成认证失败。**修法**：启动轮询复用精确本地 origin + owned-process/current-generation proof + main-frame policy helper，未证明归属时只记录拒绝，不触发认证恢复。

217. **自包含 release checkout 的 runtime asset 门禁不能靠目录猜测（2026-09-29，release run 36589913818）**：**现象**：release workflow 的 checkout 确实包含 `app/src/main/assets/patched/*.js`，快照双 ABI 也构建成功，但严格门禁报告 `/home/runner/work/dsh-mobile-apk/dsh-mobile-apk/dsh-mobile-apk/app/src/main/assets/patched` 不存在，双 ABI 均被拒，因而没有创建 draft Release。**真因**：`check-runtime-assets.mjs` 只用 `ROOT/dsh-mobile-apk` 是否存在来猜协调仓布局；自包含 checkout/本地来源链已通过 `DSH_APK_DIR` 明确传入 APK 根，却被忽略，布局探测把门禁指向 phantom nested path。**修法**：`DSH_APK_DIR` 存在时优先 `resolve()` 使用它，目录猜测只作兼容回退；不放宽 `--require`，不自动生成或绕过 `assets/patched`。**复验证据**：APK 仓 `node scripts/check-runtime-assets.mjs x86_64 --snapshot app/src/main/assets/snapshot.tar.xz --require` 通过（3 资产逐字节同源、2 行为回归）；协调仓 `check-patch-mirror.mjs` 通过。发布链修复后必须重新触发 workflow 并核验 draft Release 资产面。

218. **自包含 release checkout 的 APK 打包路径不能在版本解析后重新硬编码（2026-09-29，release run 36596312313）**：**现象**：修复 `DSH_APK_DIR` 后，`CHECK-RUNTIME-ASSETS PASSED（abi=arm64，核对组合 3，SKIP=0）`，但随后构建阶段把快照写到被覆盖的 nested `$apkDir`；指纹门禁仍在正确 APK 根检查，报告 `SNAPSHOT-FINGERPRINT CHECK FAILED：快照 tar 不在场（app/src/main/assets/snapshot.tar.xz）`，整链在 `build-apk-013.ps1:455` 拒绝。**真因**：脚本开头已按布局把 `$apkDir` 正确解析为协调仓的 `Root\dsh-mobile-apk` 或自包含仓的 `Root`，但版本读取和输出目录计算后又无条件赋值 `$apkDir = Join-Path $Root "dsh-mobile-apk"`；同一脚本同时支持两种布局，却在中段丢弃了前置自检测结果。**修法**：删除覆盖，保留前置解析结果；不改变协调仓布局行为。**复验证据**：`check-patch-mirror.mjs` 与 `check-build-chain-abort.mjs --self-test` 均通过；失败日志中 runtime asset 门禁已通过，下一次 release workflow 必须验证双 ABI 继续通过。

219. **跨平台发布链不能假设 PowerShell 的 `$env:TEMP` 存在（2026-09-29，release run 36599977147）**：**现象**：两处 self-contained APK 根目录修复后，arm64 与 x86_64 均完成 runtime asset 门禁、快照指纹门禁和 `assembleDebug`；导出注入后快照时，`check-snapshot-asset.ps1` 在 `build-apk-013.ps1:485` 报 `Cannot bind argument to parameter 'Path' because it is null`，双 ABI 资产未归集，因而没有创建 draft Release。**真因**：Linux GitHub Actions 的 PowerShell 运行环境未提供 `$env:TEMP`，`Join-Path $env:TEMP ...` 生成 null 临时路径；Windows 本地环境有 TEMP，因此问题此前未暴露。**修法**：用 `[IO.Path]::GetTempPath()` 获取平台运行时临时目录；不降低 APK 内嵌快照与发布快照的一致性门禁。**复验证据**：失败日志显示两 ABI 的 `SNAPSHOT-FINGERPRINT CHECK PASSED` 与 `BUILD SUCCESSFUL`，仅 snapshot asset checker 在临时路径绑定处失败；修复后必须重新触发 workflow 并核验双 ABI 资产、MANIFEST 和 draft Release。



220. **来源链的两处 `git clone` 没有「已存在则复用」守卫，本地复跑必撞（2026-09-29，本地链实测）**：
    **现象**：同一工作区第二次跑 `scripts/source-build/run-local-source-chain.mjs` 时，第 3 步直接报 `fatal: destination path '.deploy-tmp/deepseek-harness' already exists and is not an empty directory`，链在开头就停。
    **真因**：CI 每轮全新检出，`.deploy-tmp/` 恒为空，故 `git clone` 从不失败；而本地复跑时目录还在。**同一类不可重入**此前已修过两处（`bootstrap-extracted` 解包目录、NDK 的 `unzip` 无 `-o`），但 clone 这两处漏了——它们与那两处的区别只是「失败得早且直白」。
    **修法**：两处 clone 加 `if [ ! -d <dir>/.git ]; then ... fi`；保留显式 commit 的 `git fetch --depth=1`、`checkout --detach`、`rev-parse` 断言；detach 前先复位该专用源码树，避免上一轮改过的 tracked 输入提前阻断 checkout。CI 上是无操作。
    **为什么记进坑位**：有了本地链运行器（`run-local-source-chain.mjs`）之后，「链的幂等性」从 CI 的隐含前提变成**本地可观测的判据**；每加一处 `clone`/`unzip`/`tar -x` 到已有目录都要想一遍。判据不是「CI 绿」，而是「同一工作区连跑两次都绿」。

221. **两处大件下载没有「已存在则跳过」守卫：本地每轮白下 ~735 MB（2026-09-29，本地链实测）**：
    **现象**：本地链复跑时，NDK R30 Linux 归档（**704 MB**）与 Termux bootstrap（31 MB）即便已躺在 `.deploy-tmp/source-build/` 里，也每轮重新下载——两条 `curl --output` 无条件覆盖。
    **真因**：与坑 220 同源（CI 每轮全新工作区，下载步骤从未被要求幂等），属「本地跑同一条链」暴露的第二类隐含前提。
    **修法**：两处加「验哈希后跳过」守卫——NDK 先按钉死的 sha1 `--status` 校验，过则跳过下载；bootstrap 从 `prepare-termux-bootstrap.py` 的唯一 SHA-256 常量读取 cache-hit 判据，只有哈希命中才跳过，半包/坏缓存重新下载；该 Python 准备器仍在解包前无条件核验。**跳过不等于放行**：原有的哈希校验无论下载与否都照跑。
    **为什么用「验哈希」而不是「看文件在不在」**：这两个输入都钉了哈希，验过再跳过才既不重下也不放过坏文件；对没有独立校验的下载（如 17 KB 的市场产物）另说。
    **量化**：本地每轮省 ~735 MB；CI 侧无操作。Gradle 侧的一次性成本另计（发行版 + Maven 依赖，之后长期复用）。

222. **Harness 构建步不复位固定 checkout：中途被杀后复跑会在全仓类型检查处假红（2026-09-29，本地链实测）**：
    **现象**：本地链复跑时 Harness 构建步报 `packages/llm/llm-deepseek/src/host.ts(41,10): error TS2345: ... '"loader/volatile-update"' ...`（`llm-pi-ai` 同型），看着像上游源码不兼容。
    **真因**：该步的顺序是「先全仓 `tsc -b tsconfig.host.json` → 再替换五个旧版 Cordis 源码 → 再单独编译旧版包」（坑 187 定的口径）。上一轮若在**替换之后**被杀，工作区就停在替换态；这一轮的全仓检查于是拿**当前**源码去配**旧版** loader，`loader/volatile-update` 之类事件自然不在旧版 `Events` 里 ⇒ 假红。CI 每轮全新检出，所以从未暴露。
    **修法**：取源 detach 前与构建步首都复位专用 checkout（`git checkout -- .` + `git clean -fdq`，不带 `-x`，保留忽略依赖缓存）；构建步同时从本次 `GITHUB_SHA` 恢复权威 overlay 输入，避免上轮停在第一方 pin 已摘除的阶段而无法续跑。清理前验证 realpath 未脱离专用工作区。
    **为什么记进坑位**：与坑 220/221 同族——**「可被杀」是本地跑链的常态**（关机、换盘、手停），因此每个「先改后还原」的步骤都要自带复位；判据仍是「同一工作区连跑两次都绿」。此坑尤其阴：报错文本指向源码不兼容，容易误导人去查上游。

223. **`pnpm deploy` 目标目录非空，本地复跑必判红（2026-09-29，本地链实测）**：
    **现象**：Harness 构建步报 `ERR_PNPM_DEPLOY_DIR_NOT_EMPTY`，指向 `.deploy-tmp/engine-deploy`。
    **真因**：`pnpm deploy --prod <dir>` 要求目标目录为空或不存在；CI 每轮全新工作区故从不暴露，本地复跑时上一轮的部署树还在。
    **修法**：deploy 前验证非空 workspace 与 `.deploy-tmp` 的 realpath，再仅清理引号内的绝对 `engine-deploy` 目标（不清理源码、缓存或 provenance 兄弟目录）。语义上这里需要全新部署树，CI 侧为无操作。
    **同族**：坑 220（clone 无守卫）、221（大件重下）、222（构建步不复位）。四处都是同一个前提——**「工作区干净」是 CI 的隐含条件，不是链的语义**；本地跑链把这四条一次性暴露出来。判据统一为「同一工作区连跑两次都绿」。

224. **本地自组快照但漏 snapshot.sha256 ⇒ 升级装上了、运行时却永远不刷新（2026-09-30，9c2a0c45 实测）**：
    **现象**：换快照重打 APK（vc 43→44）覆盖安装并启动，引擎正常 boot、无任何报错，但
      files/.snapshot-fingerprint 停在旧值、live profile 里该更新的包原样不动——**刷新从未发生**。
    **真因**：EngineManager.bundledFingerprint() 读的是 assets/snapshot.sha256（发布链
      build-release.ps1 生成）；本地 assembleDebug 只校验 snapshot.tar.xz **在场**（缺失才报错），
      不校验 sha256 文件。文件缺席 ⇒ bundledFingerprint() 返回空串 ⇒ snapshotFresh() 走
      「legacy build：不强制重抽取」分支 ⇒ 永远判 fresh。**静默路径**：装机成功 + 引擎正常 = 无任何信号。
    **修法**（本地链）：放快照后必须同步写 app/src/main/assets/snapshot.sha256（内容＝快照
      tar.xz 的 sha256 十六进制小写、无文件名后缀）。写完重打，装机启动即见
      .snapshot-fingerprint 翻转 + 事务跑完（本机 arm64 全程 <3 分钟）。
    **复验**：补 sha256（182e7ec6…）重打 vc44 装机 → 指纹翻转、两份 profile 的
      dsh-client-ui-responsive/lib/client.js 均更新为新产物（316,708B、含 rootGrantState）。
    **上游可报**：assembleDebug 对「有 tar 无 sha256」应显式报错而不是当 legacy 放行——
      这是一条「升级了但升级内容永不生效」的静默失败路径（issue 候选）。

225. **写后回读的回包缺 `ok` ＋ 拒收码不进 CALL_REASON ⇒ 已成功的动作被渲染成「失败：原因未在本版登记」（2026-09-30，用户实测撤销同意）**：
    **现象**：设置页取消勾选「已阅读」提示「撤销同意失败：调用失败原因未在本版登记」——实际状态**已生效**（重查状态可见 consentValid=false、granted=false）。
    **真因**：①`RootGrant.setConsent` 回包只带 state 字段、**没有 `ok:true`**，而页面结算 `settleLinkCall` 只认 `answer?.ok === true`，缺字段一律走失败支；②`setGranted` 的拒收回包只有 `code/guidance`，人话翻译 `describeCallReason` 只读 `reason`，两个码（consent-required / not-root-channel）又不在 `user-copy.ts` 的 `CALL_REASON` 唯一真源里 ⇒ 落 `UNKNOWN_CALL_REASON` 兜底文案。
    **修法**：①`setConsent` 显式 `put("ok", true)`（SharedPreferences.apply 同步写，无失败支）；②`setGranted` 拒收分支同时带 `reason`（= code，code 留给 data-code/grep）；③两码登记进 CALL_REASON 表。回归钉三处：TSX「结算只认 ok===true」「拒收翻译不落兜底」+ Kotlin 源码契约（setConsent 体必须含 put("ok", true)、setGranted 体必须含 put("reason")）。
    **通则**：**凡页面用 settleLinkCall 结算的桥方法，成功回包必须显式带 ok:true；凡可能失败的 reason 码必须同步登记 CALL_REASON**——缺一样就是「静默成功 + 吓人报错」或「未登记兜底」，两者用户都读不出真相。

226. **JavaBridge 线程里创建 WebView/弹窗 ⇒ bridge 回包还能带回异常，但进程随后原生崩溃（闪退）（2026-09-30，用户实测「点免责声明闪退」）**：
    **现象**：设置页点《AI root 权限免责声明》，应用直接闪退（不是弹窗失败，是进程消失）。
    **真因**：`@JavascriptInterface` 方法在 **JavaBridge 线程**被调用；`LocalDocs.open` 在该线程直接 `WebView(activity)` + `AlertDialog.show()`。bridge 回包能带回 `IllegalStateException`（被函数内 catch 抓到、如实回 ok:false），**但 WebView 已在错误线程上被创建**，随后渲染启动 → 原生层崩溃、进程消失（CDP 复现：pid before 有值 → 调 openRootDisclaimer() 回 {"ok":false,"reason":"IllegalStateException"} → 3 秒后 pid 消失）。
    **修法**：整段 UI 组装 marshal 到主线程（`activity.runOnUiThread`），用**短闩（1.5s）**等真实结果——超时回 `ui-thread-timeout`、组装抛错回异常类名，**绝不谎报已打开**；catch 用 `Throwable`（Error 也要拦住，否则又是进程级闪退）；弹窗关闭即 `view.destroy()`（WebView 重量级，不销毁会泄漏）；静态文档 `javaScriptEnabled = false`。
    **判据（源码契约）**：`open()` 体内必须出现 `runOnUiThread`，且 `WebView(activity)` / `AlertDialog.Builder` 的构造**出现在它之后**（LocalDocsTest 钉死）。
    **通则**：**凡从 `@JavascriptInterface` 里碰 UI（WebView/对话框/View/Toast 的创建），先问「这段代码跑在哪个线程」**——`startActivity` 类调用是线程无关的，UI 对象的创建不是。同类桥方法（ExternalLinks 只做 startActivity）不受影响。

227. **root 通道写盘把文件属主变成 root:root ⇒ 应用自己读不回来（2026-09-30，主人点名「Root 属主这种 bug 也得找一找修一修」）**：
    **现象**：root 身份（Shizuku 以 root 启动的 UserService / su）写进应用数据目录的文件与 mkdirs 出的目录，属主是 `0:0`；应用侧对它的写入直接 `Permission denied`（0644 尚可读，可写面全死）⇒ watcher / 插件更新 / 引擎读写连带失败。
    **真因**：全仓**零 chown 处理**（grep 实证）——`ShizukuUserService.writeChunk` 以 uid 0 落盘、su 命令写盘同理，谁都没把属主修回来。
    **修法（两条路径都做）**：①**su 直连（主路，不依赖 Shizuku）**：`RootAccess.repairOwnership`（路径限应用数据目录内 + `find -not -user <uid> -exec chown <uid>:<uid> {} +` + restorecon）+ `execRoot` 原语 + `ShellOps` 在**通道级失败**时回退 su（命令自身 exit≠0 不重跑）；②**Shizuku 通道（AIDL v3）**：`configure(appUid, appDataDir)` 回填身份 + `writeChunk` 写后自愈（含 mkdirs 父目录）+ `repairOwnership` 有界遍历（`lchown` 不跟随符号链接、只归一到已配置的应用 uid、越界拒绝）。③启动期热点路径顶层抽查 + 页面「修复文件属主」按钮；**逐项失败必须计数暴露**（旧版只在成功时累加 ⇒ 全失败也报 ok:true 的静默形态）。
    **复验**：root 种文件/目录（属主 0:0）→ 应用侧写入 Permission denied → 跑修复 → `healed=4`、属主翻回 10241、应用侧写入 OK。
    **Kotlin 坑**：拼 shell 脚本时 `"$P"` 会被当 Kotlin 变量插值（编译期 Unresolved reference）——shell 变量必须写 `\$P`。

228. **UserService 跨应用重启存活 ⇒ 新加的 AIDL 方法「装上了却调不到」（2026-09-30 实测）**：
    **现象**：新版本 APK 装了、代码在、`repairOwnership` 却恒返回 unsupported（configure 静默失败），属主一个没修。
    **真因**：Shizuku 的 UserService 进程**由 Shizuku 管理器持有、跨应用重启存活**；`UserServiceArgs.version(...)` 取自 `BuildConfig.VERSION_CODE`，**versionCode 不变时 Shizuku 不会重建服务** ⇒ 跑的还是旧版 dex，v3 的 transaction 根本不存在。
    **修法**：①加 AIDL 面就**同时 bump versionCode**（让 Shizuku 自动重建）；②已有的出口是设置页「重置链接」（`unbindUserService(remove=true)` 强制移除后重建）；③代码侧一律 `runCatching` + 结构化 `*-unsupported` 回报，**不假装成功**。
    **复验**：vc 44→45 重装后 `configure` 生效、`repairOwnership` 返回真实计数。

229. **原 root 策略只认 su 授权/旧开关，且派发后异常回退会重复命令（0.14.3 源码修订）**：
    **真因**：应用获得 root 与授权 AI 使用 root 是两件事；原始 granted bit 在升级后仍可能为真，当前版本 consent 已失效。将所有 shizuku/root/shell 错误归为可回退又混淆派发前不可用与派发后结果不明。
    **修法**：最后执行点使用有效 RootGrant；新 consent 不复活旧开关；root Shizuku/su 为替代通道。ShellOps 仅精确派发前不可用白名单回退一次，不重跑 root-policy refusal、非零 exit、超时或 Binder 结果不明。v4 configure 加完整 UID/anchor 回读确认，绑定 version 同时编码 protocol，旧服务拒绝派发。
    **证据**：源码与 pure decision/dispatch-count 需求已补；当前维护者新 head 的构建与外部三层验收仍待收口，不沿用作者旧 head。

230. **path 型 chown 与事后 cap 不能界定维护副作用，顶层抽查漏深层启动污染（0.14.3 源码修订）**：
    **真因**：canonical/lstat 与后续路径变更之间存在替换窗口；find 先执行再数结果不能限制已发生变更；uid 归一不证明 SELinux 标签正确。
    **修法**：固定签名 APK helper 与共享 held-FD Android adapter；O_PATH/O_NOFOLLOW pin、访问前预算、深度/deadline、fstat/fchown/fstat 对照、hardlink/foreign/device/special-node 拒绝。protected_hardlinks 不明拒绝，root-origin 可被其它主体写入的 regular 拒绝。维护与本应用受控特权执行用读写栅栏，结果含失败/截断/未验证计数；明确不做 SELinux relabel，不能锁住外部特权 namespace。
    **证据**：fake walker/参数解析夹具已写但未运行；描述符策略与非原子 root 竞态限制见 ROOT-MAINTENANCE.md，待外部验证。

231. **维护放在事务恢复之后/主线程等待，既来不及自愈又可能冻结 UI（0.14.3 源码修订）**：
    **真因**：污染的 marker/stage 可能在 fresh 判定前的恢复期已被读取；同步修复回包把提交任务误报成完成。Service onStartCommand 不适合等待 root/Binder。
    **修法**：Activity/Service 的后台 startup worker 在事务恢复前进入共享 single flight，近同时启动复用5s内结算；caller 最多30s，未知结果仍保持 worker/fence，不重放。UI 请求立即返回，既有 root 状态轮询结算；仅完整计数/flags/remaining 合法才显示完成，部分/未知明确提示。
    **证据**：源码与异步 UI fixtures 已补、尚未执行；外部需验证 Binder 卡住、前后台/关闭、并发栅栏和三层实际体验。

232. **su/Binder本地超时或杀客户端不是特权后代结算，应用重启也不能清UNKNOWN（0.14.3源码修订）**：
    **真因**：root helper/远端RPC可能已写盘，destroyForcibly、pipe close、reader join只描述本地进程/管道；同boot进程重建丢内存标志会重新派发并与旧helper并行。裸读tryLock还可插队公平写者。
    **修法**：UID0真正派发前RootMaintenanceLease同步commit；Context栅栏锁前/锁内读lease，公平零毫秒timed读锁；helper只有完整JSON+确定exit0/2可finish，已确认部分信封仍ok=false。exit/drain/read/cleanup/Binder未知持续隔离新派发、维护、startup；同boot app restart/recreate不清，只有同boot-id/boot-count方案的真boot变化清。无手工清除。
    **证据**：当前源码与RPC wiring fixture在场，未执行；真实boot/late ack/commit失败与副作用反证见 [外部测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>)。不沿用旧head或声称已测安全。

233. **cleanup也能阻塞waiter；不完整capture不可当ready文件（0.14.3源码修订）**：
    **真因**：直接destroy/close可能永久等待，晚到drainer继续写让“已返回partial”变化；发布仍被writer占用的spool会把半文件交后续pull。
    **修法**：ProcIo每个kill/stream-close独立daemon、同一cleanup预算join，短内存锁仅copy immutable partial；ShizukuCaptureIo private .part只在writer/flush/close已终止且全flags完整后rename，失败spoolReady=false/路径空。transfer每chunk在RPC紧前重读实际UID/有效consent，offset仅acknowledged-bytes，unknown不重放。
    **证据**：ProcIoSettlementFixtureTest/ShizukuCaptureSettlementFixtureTest/ShizukuRpcLeaseWiringFixtureTest已写未跑；要补真实后代持管道与部分写入，不把daemon线程或本地kill当远端证明。

234. **陈旧startup finally/Service teardown会抢新flow与wake锁；后台renderer重载可循环（0.14.3源码修订）**：
    **真因**：running/generation分离、等待后不复核、全局wake句柄让旧caller取消新owner；后台冻结不是前台无响应，destroyed WebView不可能靠reload重生。
    **修法**：StartupFlowOwnership单份CAS token/generation；ServiceEpoch每次等待后复查并按owner获取/释放wake锁；销毁只中断caller不杀共享root worker，pending六次[2,4,8,16,30,30]秒后停步。ForegroundPageRecoveryPolicy后台合并、前台一次quiet retry/recreate，holder新Activity重绑，重复崩溃停native error、保留userClosed/userShutdown。
    **证据**：StartupLifecycleOwnershipTest与Foreground政策/接线fixtures在场未运行；需外验晚到副作用、关闭后不复活、后台真实任务不被中断。

235. **迁移后的settings缺席不等于缺用户配置；factory reseed与旧导出路径会抹provider（0.14.3，#304/#305）**：
    **真因**：官方import将legacy YAML改名.imported，活配置在web profile patch；旧升级把缺YAML补空factory seed，旧桥还导出这个假真源。缺/非法内嵌SHA旧legacy fallback又可能把错误包当fresh。
    **修法**：stage保留import marker并抑factory seed；SnapshotUserData选活patch、同格式原子导入/备份、导出共享key警告，只隔离已知旧blank模板。MainActivity接EngineManager，legacy ConfigTransfer不挂；SnapshotFingerprintPolicy严格64hex拒缺/坏metadata，无legacy/degraded旁路。
    **证据**：SnapshotMigrationPolicyTest/SnapshotFingerprintPolicyTest在场未跑；双ABI包与连续升级/rollback假配置外验待交接，不填造产物hash。

236. **浏览器无bridge不代表storage隔离；UI focus不是模型Session/tab（0.14.3源码修订）**：
    **真因**：cookie不按端口隔离，Default共享jar让换loopback端口也可携主cookie；currentWorkspace/activeTab异步漂移会把工具写到邻会话。raw npm pi overlay也会丢官方pnpm补丁，PTC只改host环境仍让child失败。
    **修法**：BrowserHostProfile在load/settings前验证per-session nonDefault并自有worker策略，不支持即拒不回Default；控制捕获Session/tab/modelTab与UI舞台分开，refs/identity/viewport/error均per-tab；官方MIT UI私有复用、真实tab-menu扩展。PTC A1 host/child双文件与pi streaming020六provider exact SHA/context及副本同步入runner；普通snapshot post-apply已统一runner --check复核全部companion/exact verifier，不再只搜主target marker。
    **证据**：源码/fixtures/patch登记在场，未构建/未执行；HTTP/loopback storage隔离、UA/UA-CH、模型跨会话、PTC授权不downgrade待外验。旧资产尺寸/hash不当新测量。

237. **闸门A拒启与闸门B自愈互锁：只有能spawn才会写engine.log，而拒启恰恰不spawn（0.14.3，#309）**：
    **真因**：`liveRuntimeComplete()`在spawn前拒启（且先于force/可用性判定⇒看门狗force也绕不过），而自愈判据`snapshotLinkFailure`读的是**当拍engine.log尾部**——不spawn就永不产生该文件⇒自愈条件恒为假。全仓`refreshSnapshot`调用点只有冷启动一处，拒启路径为零；UI「重试」只`clearRefreshLedger`不删指纹，指纹新鲜时是no-op。于是「live树缺一条条目」这种可自愈状态把用户永久挡在错误页（issue实测36次/47分钟零恢复）。
    **修法**：拒启时先**取证**（缺失项+确诊分级+每项size/mtime，写进boot-fail与诊断包）再**删指纹**，借既有的`if (!snapshotFresh()) refreshSnapshot(...)`冷启动分支走完整重抽取——不新增调用点。触发条件是**双闸门**：预算复用`runtimeTreeHealedThisRun`（每次运行一次，避免重抽取→再失败→再重抽取），且缺失项里至少有一条是「快照自身条目」（`START_RECOVERY_CONFIRMED_ENTRIES`）。
    **为什么`REQUIRED_LIBS`成员刻意不触发自动恢复**：issue原文明确告诫「不要贸然补全该表」——该表只列`usr/bin/node`的8条`DT_NEEDED`，**不含传递依赖**，因此它的命中可能是假阴性（真缺的可能是`libicudata.so.78`那类传递依赖）。自动放宽的代价是每次启动白付一次8-12分钟全量抽取并抹掉现场，比不修更坏；故低置信度条目只记录，用户可在错误页主按钮**显式**重做一次（放行分级、不放行预算）。
    **证据**：`Issue309StartRecoveryTest`13例本轮exit 0（含反证：只有低置信度条目时必须拒绝；注入两处变异后实测2 failed已还原）。真机/模拟器删件冷启动与「只删一个库符号链接」两条外验未做。不改闸门A判据本身，带病的树仍不被spawn。

238. **属主维护「结算过严」把启动挂成「等待属主维护」直到整机重启（2026-10-01 真机截图实锤）**：
    **现象**：已授权 Shizuku（服务端 root）的设备升级 0.14.3 后，每次启动都停在「正在等待属主维护完成…维护结果尚未结算」；重启设备只清一次，下次开机又复现。AI root 开关无关（应用维护不走 AI 门）。
    **真因**：三层叠加——①`ShizukuTransport.repairOwnership` 把 `lease.complete(definitive = verified)` 写死：拿到**完整信封**的部分修复/超预算回执（DSH files 树超 20s 预算很常见）也被判「结果不明」⇒ `markUnknown` 耐久租约；②UNKNOWN 租约无产品出口，仅整机重启（boot-id 变化）可清；③`RootAccess` 的 granted 缓存只升不降，su 已拉不起来时启动自愈仍按旧缓存判「有 root 路」反复撞隔离。
    **修法**：①信封完整（ok 布尔 + checked/healed/failures/unverifiedMutations 非负 + remaining∈{-1,0} + truncated/deadlineExceeded 布尔）⇒ 一律 `finish` 租约，部分修复如实回 `repair-incomplete`/ok=false（对齐 ROOT-MAINTENANCE.md §2 原有承诺）；②`su-exec-failed`（spawn 即失败、零副作用）按「未派发」finish 而非 markUnknown，并在 `execPrivileged` catch 里把 granted 缓存降级 denied；③`autoHealOwnershipDirect` 改用与入口**同源的三态判据**（不可用/探测不完备都不做维护，如实回 `no-root-path` / `root-channel-unknown`），**worker 内不再清算**；④**真机补的第五处（只放 worker 里不够）**：清算必须发生在 `RootOwnershipJobs.start()` **咨询租约之前**、且在**同一临界区内**（`clearWhenNoRootChannel(context, guard)`，guard＝在飞维护复核）——`start()` 的 `outstanding` 短路会绕过 worker 内的任何清算，启动照样挂死。
    **复验**：`OwnershipLeaseSettlementFixtureTest`（21 条源码契约：信封结算/未派发结算/缓存降级/worker 同源判据/入口清算前提/租约锁内 guard/入口临界区/唯一非 owner 出口/派发证据接线/切片边界反证等）＋ `RootChannelDecisionTest`（判据真值表 12 条）。**真机 A/B（小米 14 Pro，vc45 本地变体）**：注入「同 boot 残留租约」+ 撤 root 路（Shizuku 未运行、su 缓存 denied）后重启——修前 345s 无任何 boot-start、引擎 HTTP 000、租约原封不动；修后 **15s HTTP 401、租约被清空**；恢复 root 路（su granted）再启亦 15s 起、租约建完即结算。

239. **契约测试的成员边界取错 ⇒ 防线被删掉仍然绿（2026-10-02 review 指出）**：
    **现象**：新增的 `OwnershipLeaseSettlementFixtureTest` 用 `substringAfter(签名).substringBefore("\n  /**")` 切成员体，断言全绿；review 指出这个右边界是**下一个文档注释**而不是下一个成员声明 ⇒ 切片会跨进隔壁函数（实测 `body("RootAccess","fun execRoot(")` 长 3393，把 `execPrivileged` 的 `fail("su-exec-failed")` 也切了进来）⇒ 把 execRoot 自己新增的拒绝集项删掉，断言照样绿（命中的是隔壁函数里的同名片段）。
    **真因**：`/**` 不是成员边界——**没有文档注释的相邻成员会被整段吞进切片**，而「同名片段在别处也有」正是这类假绿的温床。
    **修法**：先用**扫描器**剔注释（字符串字面量整体保留、行尾 `//` 与块注释剔除），再取**下一个顶层成员声明**作右边界——边界正则覆盖前置注解与修饰符（`public/private/internal/override/suspend/inline/…`）以及 `fun|val|var|object|class|interface|enum class|companion object`（与 `RootGrantTest.kt:128` 同口径）；断言只钉代码，避免文档措辞与隔壁成员把契约测试洗绿。
    **复验**：收紧后同一断言在删除真防线时判红（本 PR 的 `suSpawnFailureIsNeverDispatchedAndSettlesLeaseInsteadOfQuarantine` 用例）。
    **通则**：凡「grep 源码片段」的契约测试，先自问**切片右边界是什么**——按字符数（`{0,900}`）、按文档注释、按空行都是错的；**只认结构**（成员声明 / 花括号配对 / 缩进）。本 PR 最终版已把边界正则扩到注解/修饰符(`suspend`/`inline`/…)与 `fun|val|var|object|class|interface|enum class`，并用**扫描器**剔注释（字符串字面量保留、行尾 `//` 与块注释剔除），另加 `memberBoundaryDoesNotCrossIntoTheNextMember` 反证用例。

240. **Shizuku 服务端 v13.6：`checkSelfPermission()` 恒 denied、`getUid()` 撤权后仍返回 0 ⇒ 用 API **分不清**「已授权」与「授权被撤」（2026-10-02 真机两轮实测）**：
    **现象**：同一台机（Shizuku 服务端在跑、uid 0）做对照——①本应用授权 granted：自检报 **false**（假阴性）；②`pm revoke` 撤权后：`getUid()` 仍返回 **0**（服务端不按该权限校验）。⇒ 依赖单一信号的判据必然在某一侧误判：以自检为准会在**已授权**时误判为「不可用」并清掉隔离租约；以 uid 为准则在**撤权**后仍判「可用」而保留租约（那个场景不会被消掉）。
    **修法（本机取舍；已被坑 241 取代，本节保留为当时的取舍记录）**：判据**保守优先**——uid 读得到就按 uid 判（服务端 root ⇒ AVAILABLE、保留租约）；只有「uid 读不到 + 自检明确未授权」才判 ABSENT；通道**确定消失**（未安装 / 服务端没跑 / 非 root / su 也撤）才清算。要真正区分需要一个**决定性**授权探测（真正尝试 bind/configure 并读回权限码），列为后续项。
    **复验**：`RootChannelDecisionTest` 真值表（含 `readableRootUidIsAvailableEvenWhenSelfCheckSaysDenied`）；真机两轮对照：授权 granted ⇒ 租约保留 ✓；撤权 ⇒ 租约同样保留（限制如实记录，不粉饰）。

241. **通道判据的权限面假阴性被当成「通道不存在」⇒ 误清隔离；且「通道不可用」不等于「旧特权任务已结束」（2026-10-02 review 复审第 1、2 点）**：
    **现象**：两件事一起出现——①本机（Shizuku 服务端 v13.6、服务端以 uid 0 在跑）上，真实存在的 root 通道被判成「不存在」，残留维护租约随之被**自动清掉**，隔离失效；②反向也被判错：租约明明已把特权工作派发出去，只要此刻通道看起来不可用，就被当成「那条工作已经结束」放行清除。
    **真因**：①旧判据把客户端权限面当成通道证据——`status.granted == false` 时**根本没尝试绑定**就直接返回「通道不存在」；而该机 `checkSelfPermission()` 有假阴性、`getUid()` 撤权后仍返回 0（坑 240 已实测），所以这条信号在两侧都会错，结论却是**肯定式**的 ABSENT ⇒ 不可逆处置做在了不可信信号上。②`RootMaintenanceLease` 的 `synchronized` 只覆盖**本进程**，它证明不了外部 su 子进程或 Shizuku UserService 已退出；「通道不可用」判的是**当下**，不能推出「已派发的那次工作已结束」。
    **修法**：①判据改为**真绑定实证**：唯一入口 `ShizukuTransport.probeRootChannel`（原始信号经可注入的 `RootProbeEnv`，生产实现 `SystemRootProbeEnv`）——su 已授权 ⇒ AVAILABLE；ping 明确 false ⇒ 服务端不在；ping 抛异常 ⇒ 不判断；其余**真去绑定 UserService**（`ensureBound(..., requestPermission = false, ignoreGranted = true)`，不弹框、绕过不可靠的客户端权限预检）。纯函数 `decideNoRootChannel` **只认三类证明**（绑上且非 root uid / 未装 Shizuku 且无 su 二进制 / 服务端明确不在或协议明确不支持）⇒ ABSENT；**权限面被拒（`BindOutcome.DENIED`）只算 UNKNOWN**，其余也一律 UNKNOWN 保留隔离。②租约新增**派发证据**：`markDispatched(context, transport)` 与 `dispatched(context)`——su 在 `RootAccess.execPrivileged` 派发前写 `"su"`，Shizuku 在 `RpcLease.beforeRpc` 拿到租约后写 `"shizuku"`（写不进即置结果不明）。自动清算走纯函数 `autoClearAllowed`，四条件缺一不可（通道 ABSENT **且** `dispatched=false` **且** `unknown=false`（租约结果可信）**且** 无在飞维护）——「没有派发证据」≠「证明没有派发」（`markDispatched` 落盘失败只置 `unknown`、`restore()` 恢复别的进程留下的租约也一律置 `unknown`，此时 `dispatched=false` 可能正意味着「证据没落盘」⇒ 一律不清）；同理 `markDispatched` 落盘失败时**两条派发路径都拒绝派发**（`root-lease-evidence-unavailable`）。锁内再复核对 `!RootMaintenanceLease.dispatched(app)` 与 `!RootMaintenanceLease.unknown(app)`；已派发**或状态不可信**的一律只能由用户在明示「终止无法证明」后走 `forceClearMaintenanceLease` 清除（锁外先给话术、**锁内**再复核 `!RootExecutionFence.maintenanceActive`，`guard` 无默认值，不带复核的调用编译期就不可能；清除后如实回 `terminationUnproven = dispatched || leaseUnknown` 并写审计）——**用户确认不等于终止证明**。③审计留痕 `files/lease-clear-probe.log`（有界 8 KiB）每次判定记 `state/serverUid/decisive/forced/dispatched/leaseUnknown/allowed/detail`，`detail` 是原始信号（`installed=… suBinary=… ping=… bind=NOT_ATTEMPTED|BOUND|DENIED|… uid=…`），让「压根没尝试绑定」一眼可见。
    **复验**：`RootChannelDecisionTest` 真值表（含权限面被拒/绑定未发生一律 UNKNOWN 的反证）与 `RootProbeEnv` 注入式离线用例；`OwnershipLeaseSettlementFixtureTest` 覆盖清算前提与派发证据接线。真机/模拟器上「已授权但自检报 denied」的机器不得再清租约、「已派发」租约不得被自动清算，两条外验待补。

242. **入口临界区里做「真绑定探测」会把状态查询挡住最长 15s（2026-10-03，issue #319；#314 复审 D 项；方案与用例来自 PR #322 @Ni-ShuWu）**：
    **现象**：存在残留租约时，`RootOwnershipJobs.start()` 的入口清算（`clearLeaseWhenNoRootChannel` → `probeRootChannel`，真绑定预算 `BIND_TOTAL_MS = 15_000`）会让同一把锁上的 `RootOwnershipJobs.state()`（被 `AndroidBridge.rootAccessState()` / `RootGrant.state()` 频繁轮询）**被挡最长约 15 秒** ⇒ 前台 root 状态查询假死（真机观测到的「t = 15s」）。
    **真因**：锁职能混用——`lock` 同时守「状态字段」与「入口清算（含 binder 往返）」✗ ⇒ 一次 binder 交互把读路径一起堵死。
    **修法（拆锁，且不削弱原子性）**：状态锁 `lock` 只守字段（`state()` 只取它）；新增 `entryLock` 串行化「清算探测 → 复核 → 置 `running`」；`running` 的置位/复位仍落在状态锁内（可见性不丢）；**清算的原子性仍由租约锁内的 `guard` 保证**（探测在哪个锁外执行不影响那一条）。
    **复验**：`OwnershipLeaseSettlementFixtureTest.rootStatusReadIsNotBlockedByTheEntryProbe`（逐块扫描：探测不得落在任何 `synchronized(lock)` 区间内，且 `state()` 不得出现 `entryLock`）＋既有入口临界区顺序用例；全量 Kotlin **999** 例通过。

243. **快照面板修复把布局树当成 DOM 树，测试又省略同一层包装节点（2026-10-03，issue #288）**：
    **现象**：华为 SGT-AL10 的会话顶部灰圆入口打开快照管理，0.14.2/0.14.3 均被会话代码块盖住；0.14.3 已包含抬升补丁仍不生效。
    **真因**：公开 0.14.3 ARM64 APK 的 renderer 给每个 `renderSlot` 常驻包 `div[data-slot]`、`display:contents`。该样式只消除布局盒，**不消除 DOM 节点**；旧 observer 却要求 header 的直接父节点是 `div[data-phase]`，配套 CSS 又用 `div[data-phase] > header`，两处均不匹配。单测手写 header 直接插根节点，省略真实包装层，故同一个错误假设能全绿通过。面板还直接挂在 header actions 内；旧内核的 `container-type:inline-size` 隐含 layout containment，标题行成为 fixed 包含块和堆叠上下文，单纯抬 z-index 仍会留下只有标题行高度的遮罩。
    **修法**：`SnapshotPanelsObserver` 严格认领 `conversation.header` / `conversation.session.header` / `conversation.session.header.actions` 三层插槽，抬升真实 header；仅给承载该面板的直接 titleRow 租赁解除包含的 class（`container-type:normal; contain:none`）。两个 class 按元素共享租约，关闭、移除、重分类和模块重载均释放本实例所有权；不搬 React 节点，不改正文 query container。测试 fixture 使用完整 renderer 包装链，并覆盖重分类、titleRow 替换、diff 与租约恢复。
    **复验证据**：公开 APK 解包确认补丁确实入包；修前真实 wrapper + 旧包含约束模拟下，窄/宽两方向 9/9 控件被盖，正常坐标点击计数 0，直接 DOM `.click()` 却计数 1。修后隔离浏览器六组（现代/旧包含约束模拟/无 container-type × 窄/宽）均验证面板和 diff 可点击、四角遮罩属于面板、完整视口尺寸、缩短视口模拟键盘及关闭后恢复；UI 全量 457 例（其中 snapshot 26 例）、typecheck/build 通过。判别力反证：同一探针在公开 0.14.3 的**原样**入包 bundle 上判红（旧包只有 header 抬升，既无 `dsh-mobile-snapshot-title-row-uncontained`，也没有带 `data-slot` 的代码级选择器），说明「补丁在包里」不能只看 `dsh-mobile-snapshot-header-raised` 这个名字。临时证据在 `.deploy-tmp/issue-288-investigation/`。本轮用户明确选择交付 APK 与离线证据，**没有设备三层验收结论**；旧包含约束模拟不冒充华为内核实测。

244. **模板字面量里的「未知转义」会吞掉反斜杠 ⇒ 页面侧 failedIds 恒空（2026-10-05 真机实锤，已修）**：
    **现象**：客户端插件装配失败后，真机 boot-diag 里的契约行恒为 `failedIds=- / failedCount=0`——页面明明渲染了失败条目 `@dsh-android/dsh-client-bad-probe`，壳侧却点不出任何 id，外科拔除因此永远走不到（只剩整份回滚或如实拒绝）。
    **真因**：`BOOT_WATCHDOG_SCRIPT` 是**模板字面量**；模板体内的单反斜杠 `\s` 属于 JS 的**未知转义**，求值时反斜杠被**丢掉**，页面实收的是 `/s+/g` 与 `/^[@A-Za-z0-9][@A-Za-z0-9._/-]*$/` 这类退化正则。于是 id 归一化变成「把 s 折叠成空格」，判定形状变成「不许出现字母 s」——`@dsh-android/dsh-client-bad-probe` 被改写成 `@dh-android/dh-client-bad-probe`，`ID_SHAPE` 全不匹配，候选集空 ⇒ `failedIds=-`。**这一族还有前科**：同一模板里单反斜杠 `\n` 曾在模块求值时变成真换行，把字符串字面量劈成两行、注入脚本整块 SyntaxError（`dsh-host-web-compat/lib/index.js:113-116` 已记）。
    **更关键的一层（为什么单测全绿而真机红）**：原有 `watchdogBody()` 用手写的解码表把源码文本「解一层转义」，而手写表对**未知转义**的处理是**保留**反斜杠，JS 模板求值却是**丢掉**——即测试复现的字节比页面实际收到的更宽容，测的根本不是页面拿到的那份脚本。任何靠手写表复现模板求值的测试都有同一个盲区。
    **修法**：① 源码内一律写双反斜杠（`\\s` 等），让求值后页面拿到 `\s`；② 测试改用 `new Function(模板串片段 + '; return BOOT_WATCHDOG_SCRIPT')` 让**引擎自己的语义**求值取页面真实字节（`dsh-host-web-compat/scripts/boot-watchdog.test.mjs:25-37`），不再维护手写解码表。
    **复验证据**：真机 boot-diag 行 `failedIds=@dsh-android/dsh-client-bad-probe / failedCount=1`（修前为 `-` / `0`）；页面侧回归用例 `dsh-host-web-compat/scripts/boot-watchdog.test.mjs:845-863`（从 DOM 读出真实 id，取到空数组即转义退化）；负向对照：把任一处改回单反斜杠 ⇒ 3 条测试判红。设备侧三层判据见 `scripts/verify-client-plugin-fail-recovery.mjs` 判据 1、5。

245. **publishReady 旧判据把「失败页」当「已就绪」⇒ stall 诊断永不触发 + 重试预算被每拍清零（2026-10-05 设备实测，已修）**：
    **现象**：客户端插件失败后页面停在上游 "Failed to load plugins"，而壳侧同时看到两条互相矛盾的证据——① 块L 的 shell-stall 诊断（页面 40s 未就绪）**从不出现**；② 页面的 `[dsh-boot-ready]` 早在约 500ms 就发了。设备实测（`boot-diag.log`）：`page-ready` 的 `waitedMs` 仅 **1122~1371ms**，而真首帧远晚于此。
    **真因**：上游 `BootPage` **构造即在 `#root` 下挂 `[data-dsh-boot]`**，而旧的 `rendered()` 只判「`#root` 有子节点」（`dsh-host-web-compat/lib/index.js:146-155`）⇒ 启动页/失败页都满足。于是 `publishReady()` 在启动页在场时就发了就绪行。两个连带后果：① 壳侧 L-1 把该 epoch 标成「已就绪」并**停止** stall 计时 ⇒ 40s 浮层诊断实际永不触发（双重静音）；② `pageRecovery.pageReady()` 每次被调用都**清零 `loadErrorRetryUsed`** ⇒ 重试预算形同不存在。
    **修法**：就绪判据改为 `rendered() && !bootPagePresent()`，其中 `bootPagePresent()` = `#root` 内仍有 `[data-dsh-boot]`（`dsh-host-web-compat/lib/index.js:286-292`，调用点 `:335`）。`pendingBoot()` 保留（`if(rendered())return false` 仍成立），所以失败页**刻意不**触发 40s 浮层——失败页有自己的出口：契约行 → 壳侧回引导页。
    **副作用（壳侧据此复核 stall 计时窗口）**：健康启动的 ready 时间点从约 500ms **后移**到真首帧之后，壳侧 stall 计时窗口不再被过早的 ready 提前终止。
    **壳侧配套约束（同一个真因的直接推论）**：正因为旧 ready 会被反复发出并**清零重试预算**，壳侧**不得复用 `enginePageFailed` + `claimLoadErrorRetry()`** 来处理这条失败（两者叠加会形成重载环：失败页 → 重试预算被清零 → 又能自动重载 → 又失败）。故客户端插件失败走**独立的 `clientPluginTreeFailed` latch**（`EngineStartFlow.kt:301`、`:317`），并在 `showWeb()`（`MainActivity.kt:252`）、`engineMonitorRunnable`（`EngineStartFlow.kt:52`）、`freezeRunnable`（`EngineStartFlow.kt:118`）三处让路——坏页面不再被前台监控或冻结看门狗弹回。
    **复验证据**：页面侧正反用例（失败页发 fail 行且不发 ready / 健康渲染发 ready 且不发 fail / 失败页不得被判 pending）在 `dsh-host-web-compat/scripts/boot-watchdog.test.mjs:552-790`；设备侧判据 3、4、6 见 `scripts/verify-client-plugin-fail-recovery.mjs`（引导页可见 dump + 文档导航次数 == 1 的有界性反证 + 健康启动回归）。

246. **`gh workflow run -f` 不展开 @file ⇒ 发布说明资产变成字面路径（2026-10-05 发 0.14.4 实锤）**：
    **现象**：用 `gh workflow run release -R kelai141/dsh-mobile-apk -f version=0.14.4 -f notes=@release/v0.14.4/notes.md` 派发 0.14.4 发布，**发布链成功、12 件资产齐全、CI 全绿**，但产出的 notes.md 资产与 Release body 的内容是 **26 字节的字面字符串** `@release/v0.14.4/notes.md`，而不是 **7767 字节**的发布说明正文。对照 v0.14.3 的 notes 正文以 `# v0.14.3 发布说明 …` 开头，可知**不是历史惯例，是本轮引入的回归**。
    **真因**：`gh` 的 `-f/--raw-field` 与 `-F/--field` **语义不同**——`-F` 会展开 `@file`（gh 的 @ 语法），`-f` 是 **raw**，把值**原样当字符串**传递、**不展开** `@`。`gh workflow run --help` 明文写着这一条（`-F, --field … respecting @ syntax` vs `-f, --raw-field …`；gh 版本 2.101.0），但按既有命令字面照抄就会踩中。**为什么危险**：所有自动门禁全绿——发布链 exit 0、资产数量与大小正常、签名断言通过、MANIFEST 生成成功、双 ABI 快照与 APK 都在——**没有任何一条门禁校验「notes 资产的内容是否像一份发布说明」**，属「门禁全绿但产物是坏的」形态，只能靠发布后人工核对资产内容发现。
    **修法**：改用 `gh workflow run … -F notes=@release/v<版本>/notes.md`（`-F` 才展开 @file）；并在发布后**下载 notes.md 资产核对首行**是否为 `# v<版本> 发布说明`。**建议（只登记，未开 issue）**：① 把「下载 notes.md 资产并核对首行」列入**发布后动作清单**——发布链自身不校验 notes 内容，这是当前唯一防线；② 可另立 issue 提出「发布链加一条 notes 非空/首行断言」的门禁改进（开不开由 Lead/用户决定）。
    **复验证据**：已**删除坏 draft**，改用 `-F` 重派（run **37281961398**），核对 notes 资产为 **7767 字节正文**（Lead 已执行）；本条待核结论以该次 run 的资产首行为准。



247. **WebView provider 包版本不等于 Chromium 版本，语法门诊断会假报不兼容（2026-10-05 源码核实，#312 关联）**：
    **现象**：华为 `com.huawei.webview` 的 provider `versionName` 可为 `14.0.0.370`，旧诊断直接解析首段 `14` 并与 Chromium 94 比较，于是 `syntax_floor_ok=false`；这个字段没有测到实际 JS 引擎版本，升级后「重新连接中」消失也不能证明厂商版本 15 就等于 Chromium 115。
    **修法**：provider 包名/版本单独记录；Chromium 版本从实际 WebView User-Agent 的 `Chrome/<四段版本>` 读取。读不到时 `syntax_floor_ok=unknown`，不要把 provider 版本当 Chromium 版本。UA-CH 元数据也不得用 vendor package version 伪造。
    **回归判据**：`WebViewShimTest.chromiumVersionComesFromTheEngineUserAgentNotVendorPackageVersion` 覆盖 Huawei 风格 provider 版本、实际 Chrome token 与 94 以下/以上/未知三态；还需在 MuMu 与报告设备验证 UA 版本和真实渲染表现，测试未跑前不宣称 #312 已解决。

248. **snapshot 工厂清单以外的未知 DSH_HOME 同名项会被事务替换（2026-10-05 源码核实）**：
    **现象**：`SnapshotTransaction.swap()` 虽然按 `preservedNames` 保护已知数据、对 `profiles` 做专门合并，但其它 staged `.dsh/<name>` 一律进入 `replaceEntry()`。未来工厂快照新增一个与用户未知项同名的文件/目录，就会覆盖用户数据；live-only 未碰巧冲突的未知项则自然幸存，旧测试因此没覆盖此形态。
    **修法**：对已存在且不在当前工厂直系项清单内的路径采用保留语义；stage 有而 live 无仍 seed-if-absent。工厂资产新增直系项须核实归属并同步 `SnapshotUserData.factorySnapshotNames`，不能通过扩大通用覆盖面实现升级。
    **回归判据**：`SnapshotTransactionTest.preservesUnknownDshDataOnFactoryCollisionAndSeedsMissingEntries` 同时构造未知同名冲突与缺项 seed；还需跑事务全套 Kotlin 用例与覆盖升级设备验收。
249. **`android_vdisplay_input` 回执 schema 必须覆盖 `callVdOp` 成功字段（0.14.4 本地用户反馈）**：
    **现象**：tap 等输入动作已由设备执行，工具结果却因 `additionalProperties: false` 拒绝；失败样本在 `issue存图/阅后即焚.txt`，属于本地反馈回归，不据此声称存在对应 GitHub issue。
    **真因**：`android_vdisplay_create`、`android_vdisplay_destroy` 与 `android_vdisplay_input` 共用 `callVdOp`，它成功时始终附加 `state`；输入工具 schema 漏声明 `state`。壳侧 `vdInput` 正常回执同时有 `verb`、`screenId`、`displayId`，都必须在严格 schema 中逐一声明，不能开放额外属性。
    **修法与回归**：schema 保持 `additionalProperties: false`，逐字段覆盖正常和失败形态；工具测试检查正常回执的 `state/verb/screenId/displayId` 与 schema 一致，并检查本地拒绝及控制通道异常也通过各自 schema。检查 web/headless profile 注入共用镜像插件 lib，避免旧副本掩盖修复。

250. **启动期逐批 activation 让 cold-boot compose 次数超过预算（0.14.4 MuMu 实测，0.14.5 修复待设备复验）**：
    **现象**：`check-boot-budget.mjs --require-real` 测到 C3 `compose calls=8`，真实 `[perf] compose` 行的 records 从 0 逐批增至 68；不是探针重复计数，也不是多实例。
    **真因**：同一个 `ClientModuleRegistry` 在 loader 逐批 activation 后多次 `flush.changed → compose`。上游 `dsh/` 是只读 checkout，不能直接改。
    **修法**：engine `combo-probe-P1` 在现有 `loader.await()` settle 屏障前暂存启动期 dirty Fiber，保留构造期同 shape/rev 的空 graph，并在 Web connection ready continuation 前发布完整 graph；启动期最多两次 compose（既有 rows 的同步 flush + settle flush），settle 后 add/remove/HMR 保持即时语义。TOTAL 每次 compose 同步输出同一监视器的累计值；phase 诊断用四阶段 allowlist Map 聚合，首条 phase 记录后固定 250ms 收口，分别报告 wall time、observations 与 forwarded callbacks；壳 `LogCollector` 暂存 LISTEN 前真实 TOTAL，LISTEN 行关联该值，未知仍为 -1。
    **回归**：`scripts/patches/tests/combo-probe-p1.test.mjs` 覆盖空图、构造期 0 次 compose、settle 前多批合并、ready 顺序、settle 后运行期与 HMR；需在集成 0.14.5 APK 上再跑 C1-C6 真机门禁，不能把夹具通过写作设备通过。

251. **冷启动门禁读取过早的 event-loop 快照（2026-10-05 实机日志核对，解析器已改为取末条）**：
    **现象**：MuMu 0.14.5 的真实日志先输出 `loopP99Ms=-1 loopSamples=0`，后续 debounce 收口再输出 `245.1/20`；解析器分开用 `.exec()` 取首个值，于是 C4 误判成探针零样本，漏掉真实的超预算读数。更早的解析器还曾因拒绝负数而把首条哨兵误报为字段缺失。
    **修法**：只从完整 `[perf] TOTAL` 行中成对读取 `loopP99Ms` 与 `loopSamples`，并使用最后一条；负哨兵仍要明确判 FAIL，末条 `245.1/20` 则因 p99 超过 100ms 预算而判 FAIL。不得改预算或把结果降级为 SKIP。
    **回归**：`node scripts/check-boot-budget.mjs --self-test` 覆盖首条 `-1/0`、末条 `245.1/20`、末条仍为 `-1/0` 三种情况。补丁改变后从当前 registry 重建对应 ABI 快照，再构建 APK、覆盖安装并重新采集日志；旧设备日志和旧 snapshot stage 不能证明新快照行为。

252. **Safe Mode 将备份路径与 realpath 后的 autoDir 作词法比较，导致 symlink 仓库无法恢复（2026-10-05 回归修复）**：
    **现象**：`autoDir`/`DSH_UNDO_ROOT` 指向目录 symlink 时，Safe Mode `on` 能创建状态和备份，但 `off` 将保存的 symlink 路径目录与 realpath 后的根目录直接比较，恢复被拒绝。
    **修法**：先 realpath 备份的父目录，与 autoDir 的 realpath 比较；要求叶文件是普通文件且不是 symlink，再返回根目录下规范化后的文件路径。父目录别名可用，备份本身的 symlink 与越界目录仍拒绝。
    **复验证据**：`node --test vendor/dsh-undo-savepoint/test/safe-mode-transaction.test.mjs` 与 `node --test scripts/patches/tests/safe-mode-transaction.test.mjs` 各覆盖 symlink on→off 恢复和伪造越界备份拒绝；两份源码、测试和补丁模板需保持 APK 子仓逐字节镜像。


253. **复用旧 snapshot 会让 APK 缺少当前 engine 探针，源码门禁通过仍不能证明产物新鲜（2026-10-06 独立产物核验）**：
    **现象**：0.14.5 菜单修复 APK 与设备指纹一致，但解包和设备中的 `dsh-client-modules/lib/index.js` 均没有新 phase 探针；C4 仍为 308.3ms/22 samples，FAIL。
    **真因**：`build-apk.mjs --snapshot` 复用原始快照，只执行后续 vendor 补丁与插件注入，不重新应用 engine 补丁；旧门禁检查当前源码和 profile，漏检归档中的实际模块。
    **修法**：engine 补丁变更后重新执行 `build-snapshot-013.mjs`。度量门禁读取快照实际模块并检查 phase allowlist、Map、固定窗口、记录函数和输出字段；旧 P1、缺目标、坏 tar 与缺输出均拒绝。
    **复验证据**：双仓微型 tar CLI 回归通过；旧原始快照严格检查 exit 1，当前源重建快照严格检查 exit 0。最终 APK 和设备的新探针验收仍须独立完成，mtime、版本号与快照指纹一致不能替代探针内容检查。


254. **Android 模型菜单未登记返回层，系统 Back 会结束 Activity（2026-10-06 模拟器复现）**：
    **现象**：模型选择菜单已不透明，但竖屏 MuMu 16416 用真实 `KEYCODE_BACK` 后直接回到 Launcher；WebView target 同时销毁。
    **真因**：上游 ModelSelect 的菜单通过 React portal 挂在 body，既无 slash/@ 菜单的 `data-trigger-menu`，也不是附件菜单。原 BackStackSignal 漏掉这一层，壳侧在无其他返回层时结束 Activity。复用普通菜单的 pointerdown 关闭路径也不成立：ModelSelect 使用 mousedown 外部关闭及自己的 Escape 分层逻辑。
    **修法**：只识别 ComposerPopupGuard 为展开且 aria-controls 关联的 Android ModelSelect 加的 `data-dsh-android-model-menu`，登记 `model-menu`。返回时向真实 portal 发送可取消并冒泡的 Escape，让上游先退模型子列表、再关根菜单并恢复焦点。上游 preventDefault 会让 dispatchEvent 返回 false，这表示事件已处理，不能解释为返回未消费。
    **复验证据**：新增单测覆盖标记晚到、preventDefault 仍消费、子列表逐级返回、宽屏不依赖窄屏标记、其他菜单不误认领。responsive 全量 463/463、tsc/build 通过；src/tests/lib 已 robocopy 镜像，双仓镜像门禁 SKIP=0。MuMu 16416 热推后真实 ADB tap/Back 验证根菜单关闭、子列表先退一级再关闭、MainActivity 保持前台、模型未变；CDP 确认层信号与不透明背景及关闭后的标记清理，整页 39/39 通过。证据 `.deploy-tmp/refactor/0.14.5-phase-device/portrait-back-menu-*.json/.png` 和 `verify-webview-menu-back-portrait.log`。横屏返回测试及最终入包验收仍待完成；热推不代表修复已进入当前 APK。


255. **把 compose 时长当作 C4 根因会漏掉 Loader 扫描和自动补给投影（2026-10-06 MuMu 实测）**：
    **现象**：compose仅数毫秒，C3已收敛为2，但真实C4仍反复超过100ms。
    **真因**：client/typert每个dirty名称重新遍历Loader；nearestPackage与resolveMeta复读同一manifest；本方模型能力初次投影、离线目录解析和最终fresh签名在同一事件循环turn堆叠。constructor首TOTAL样本为0，deferred末尾同步TOTAL尚未采到该flush阻塞，故phase wall time本身不是C4 p99。
    **修法与证据**：同步flush临时索引、当前manifest复用及自动pass分段yield；同步错误回调后重建索引、异步typert完成后live复验、CAS与最新签名重读保留。定量计时、五轮真预算和最终APK边界统一见 `RUNTIME-PATCHES.md` §7.6，不把SKIP或诊断profile当作绿。
256. **不能把 `actions/checkout@v4` 的 LFS 下载推断成历史全量，也不能用对象清单估算 runner 流量（2026-10-07 复核官方实现）**：
    **旧结论撤回**：`lfs: true` 并不等价于 `git lfs fetch --all`。checkout v4 的 `git-source-provider.ts` 调用 `lfsFetch(checkoutInfo.startPoint || ref)`；`git-command-manager.ts` 执行 `git lfs fetch origin <ref>`。`fetch-depth: 0` 扩展普通 Git 历史，不会把此命令改成拉取全部历史 LFS 对象。`git lfs ls-files --all` 可列出历史 pointer，但不能证明 CI 实际下载了对应对象或其流量。
    **修法**：CI checkout 使用 `lfs: false`，快照 job 只按 ABI `git lfs pull --include="base/base-usr-<abi>.tar.xz,base/base-dsh.tar.xz"`，并以 pointer 文件哈希为缓存键；不消费底座归档的 release job 不拉 LFS。这样减少的是无用 ABI 与重复 job 的下载次数；具体节省量以 runner 网络日志核实，不能沿用旧文档按历史对象大小估算的数字。
    **证据**：[checkout v4 git-command-manager.ts](https://github.com/actions/checkout/blob/v4/src/git-command-manager.ts#L352-L357)、[git-source-provider.ts](https://github.com/actions/checkout/blob/v4/src/git-source-provider.ts#L186-L193)。
    **验证边界**：本地 workflow/YAML 与本地守卫测试不等于 GitHub runner 流量测量；真实 runner 下载量尚未以日志量化。

257. **自动失败恢复必须隔离插件，不能从用户 patch 物理摘除原块（0.14.5 SafeMode D4）**：
    **真因**：`PluginMounts.pull` 过去删除命中条目的整个 insert 子块，会丢掉用户配置和未知字段；恢复能力把“本次不加载”误做成“永久删除配置”。
    **修法**：自动路径唯一命中后保留原块和所有字段，在顶层追加同 id/name 的 Cordis `disabled: true` override；歧义、无 id 或非 insert 命中一律不写。既有重启流程负责应用状态，用户可通过恢复 patch/编辑禁用位重新启用。
    **判红证据**：`PluginMountsTest` 覆盖原文前缀/自定义字段保留、追加禁用、重复调用幂等、顶层覆盖与重复 id 拒绝；需要 APK fresh JVM suite 验证。
258. **Safe Mode 不能用 publisher namespace 或包名代替本版本装配身份（0.14.5 D5）**：
    **真因**：用户可以自行装配 `@deepseek-ai/*` 官方包，甚至创建与产品同名但不同 loader id 的条目。仅按前缀/名字保护，会把用户条目误判成 Hard；Kotlin、vendor core、generated engine snippets 与 emergency CLI 也曾出现策略漂移。
    **修法**：构建期 `build-hard-manifest.mjs` 从最终注入 snapshot tar 抽取 schema 2 exact `{id,name}` identities，并单独记录来自打包 profile 的 `profileEntries` 子集；APK asset 的 fingerprint 绑定该 tar SHA-256，避免把 manifest 自身计入 tar 形成 hash 循环。online sidecar 由验证过的 stage `usr` 中 dsh-base/web-app patch 加当前 APK `profileEntries` 生成；完整归档出现 `home/` 时必须有可解析的 factory profile，并将其 exact identities 合并，home 整体缺席才允许 usr-only fallback。Stage HOME 仅作为经过 archive SHA 验证的 factory 输入，永不替换 live HOME；live HOME、live patch 与 prior sidecar profile identities 都不建立新归属。marker/.online-snapshot 必须授权 archive/base 双 fingerprint；SafeMode、UndoGate、vendor、CLI 都只按 exact pair 判断。缺失、损坏、未知/不兼容 marker、swap 中断或 fingerprint 不匹配时回执归属无法核实，不修改用户数据。
    **判红证据**：`build-hard-manifest.test.mjs` 覆盖 exact identity、profile source subset 与缺 id 判红；`safe-mode-policy.yml` golden fixture 区分同名不同 id；Node transaction fixture 检查缺 manifest 时 patch 原文不变；S1 门禁 fixture 先构造带旧宽松谓词的 marker，再断言 `--check` 红、`--apply` 修到 exact pair 后转绿。
259. **Soft mount digest 不能由单次探活或 Service 重入确认 Stable（0.14.5 Soft lifecycle）**：
    **真因**：一次 HTTP 200、watchdog healthy 或 service epoch 都不等于插件组合跨冷启动可用；直接写 last-healthy 会把一次启动观察误当回归基线。
    **修法**：Soft manifest 先记 Candidate；同一 patch digest 必须在两次 `EngineManager.startEngine` 实际 spawn（`lastStartAttemptAt` 只在成功 spawn 后赋值）上分别通过 authenticated `pluginInventory/list`、每个 Hard identity 在 inventory 中存在、当前 enabled 主 Loader 与 enabled preset fibers 为 `active`、`session/list` 与 `session/modelCatalog` 结构检查，且两次在 30 秒至 7 天窗口内，才写 Stable。合法 disabled Hard row 只要求可见，不要求 active。探活限制每次 spawn 一次、失败后至少 60 秒再试。`modelCatalog` 仅证明 API 和目录结构可读；不发真实模型请求，不能据此声称每个 provider 已完成执行验证。缺少 roster/能力证据时保持 Candidate。
    **判红证据**：`PluginMountsTest` 固定同 spawn 不得 promote、两次不同 spawn 才 promote、digest/window 改变重置候选；`EngineProbeTest` 固定缺失 Hard identity、pending enabled preset、session 或 modelCatalog 缺失/异常时不通过，并接受合法 disabled Hard row。此前执行记录为 fresh JVM 1104 tests / 0 failures / 2 skips（2026-10-07 11:16+08:00）；本轮新增/改动尚未由该旧结果验证，需由 update agent 统一 fresh rerun。

260. **交付前的"夹具随版"门禁会因 registry 文本变化而变红——它比对的是全文 SHA，不是语义（0.14.5）**：
    **现象**：`node scripts/check-release-gates.mjs --run` 在 `check-patch-fixtures.mjs` 中止组装，报
    「夹具捕获登记身份/补丁集与当前合同不符：必须从本代真实构建产物重新捕获」；但 `engine`、`sourceCommit`、
    `overlaySha256`、34 个夹具目录与 18 个 provenance tarball 的哈希**全部对得上真实产物**。
    **真因**：`fixtures/manifest.json` 的 `capture.registrySha256` 记录的是 `scripts/patches/registry.json`
    的**整文件 SHA-256**。本轮把 S1/S2 两条补丁的 `summary` 与 `marker` 从"前缀白名单"口径改成"exact
    {id,name} 权属"口径，registry 文本一变，摘要就与记录不符。而 `registry.json` 同时是**镜像面**文件
    （`check-patch-mirror.mjs` 的 MIRROR_FILES 逐字节比对），两仓必须同步改文本 ⇒ 两侧摘要一起过期。
    **为什么不是"重新捕获夹具"**：该报错文案会把人引向重跑一次捕获，但夹具本身是**上游包原样文件**
    （`inputKind: published-tarball`，34 个目录没有一个与 S1/S2 的 vendor 补丁相关）。真正过期的只有这一枚
    摘要。重跑捕获反而会在没有新上游产物时制造不可复核的夹具。
    **修法**：先逐项复核其余捕获字段确实是新的（`sourceCommit` 对齐 `contract.baseline` 0.2.0-rc.2、
    `overlaySha256` 等于当前 `scripts/snapshot-config/engine-overlay.json`、18 个 tarball 的 SHA-256
    逐个等于 `.deploy-tmp/engine-overlay/<name>.tgz` 实算值），**确认夹具文件本身没动**之后，才把
    `capture.registrySha256` 重写为当前 `registry.json` 的实算 SHA；两仓 manifest 逐字节同步。
    **判红证据**：改前 `check-patch-fixtures.mjs` exit 1；改后两仓均 `PATCH-FIXTURES CHECK PASSED
    （夹具代 0.2.0-rc.2）`，且 `check-patch-mirror.mjs` 仍 SKIP=0。**不要把这一步当成"改门禁放行"**——
    摘要不是判据放宽，是记录刷新；一旦有夹具**文件**真变了，`meta.fileSha256` 会独立判红。

261. **补丁镜像门禁把两份"整文件比字节"的补丁测试也镜像了——里面的相对路径必须布局无关（0.14.5）**：
    **现象**：`check-release-gates.mjs --run` 报 `CHECK-PATCH-TEST-MANIFEST FAILED：出现未声明的补丁回归失败（1 项）`，点名
    `scripts/patches/tests/safe-mode-policy.test.mjs`；协调仓跑同一文件 6/6 全绿，APK 仓跑却是 `tests 1 / pass 0 / fail 1`。
    **真因**：该文件是**双仓逐字节镜像**（`check-patch-mirror.mjs` 按递归 tests/ 比对），但它用写死的三段相对路径同时指两仓：
    `join(HERE, '../../../dsh-mobile-apk/vendor/...')` 与 `join(HERE, '../../../vendor/...')`。协调仓两处都在 ⇒ `length === 2`；
    APK 仓只有后者在（它自己就是 APK 仓，上面没有第二个 `dsh-mobile-apk/`）⇒ `length === 1` ⇒ 加载期 `throw`。
    **后果比"少一个断言"更糟**：模块顶层抛出会让**整个文件**被判失败，于是 APK 侧那一份 vendor 实现**一条都没跑**——
    镜像门禁看得见文件在、看得见字节一致，唯独看不见它其实什么都没验证。
    **修法**：改成从 `HERE` **向上逐层探测**（6 层内找 `vendor/...` 与 `dsh-mobile-apk/vendor/...`，去重），
    找不到任何实现在场才判红；找到两份时额外比对**内容一致**（把"两仓必须同源"变成可判红断言，而不是假设）。
    S1 陈旧 marker 用例里的同款写死路径也一并改为用探测到的 `vendorCores[0]`。
    **判红证据**：修前 APK 侧 `fail 1`、协调仓 `pass 6`；修后**两仓均 `pass 6 / fail 0`**，且镜像仍逐字节一致。
    **通用教训**：双仓镜像的测试里，凡是 `../../../` 这种**依赖自己在第几层**的路径都是定时炸弹——
    写测试时先问"同一份文件放到另一个仓的同一相对位置，这条路径还指得对吗"。

262. **GitHub Actions 残余清理：artifact 是「按 run 分桶 + 有保留期」，cache 是「按 key 分代」，两者判据完全不同（0.14.5）**：
    **实测存量**（清理前）：50 个 artifacts / 13.52 GB；62 个 caches / 1344 MB；42 个 release / 19.6 GB assets。
    **判据（不要混用）**：
    - **artifact**：与**某一次 workflow run** 绑定。同一个 run 里各 job 的产物天然同寿；
      重新发布同一版本会再产一份 ⇒ 判据是「这个 run 的结论有没有被同版本的后一次成功 run 取代」，不是「文件多老」。
      保留期由仓库设置决定（本仓 `actions_retention_days` 为 null ⇒ 用 GitHub 默认；实测三个月前的 0.12.x
      artifacts **仍是 `expired=false`**，所以「等它自己过期」在这个仓不成立）。
    - **cache**：与 **key** 绑定，不是与 run 绑定。Gradle 的 `setup-gradle@v4` 会为每个 commit 生成一组
      `gradle-transforms-v1-<hash>` / `gradle-home-v1|...|<sha>` 键；**同一个 key 只有一份**，新 run 命中即复用。
      但 **content-keyed 的三种 key 必须留下**：`gradle-wrapper-zips-v1-<hash>`、
      `gradle-generated-gradle-jars-v1-<hash>`、`gradle-dependencies-v1-<hash>` —— 它们的 hash 来自**文件内容**
      而非 commit，跨 commit 长期复用，删掉等于让下一次 CI 重新下载（本仓实测这三条共 **336 MB**）。
    **删除动作**：`gh api --method DELETE repos/<owner>/<repo>/actions/artifacts/<id>`、
    `gh cache delete <id> -R <repo>`、`gh api --method DELETE repos/<owner>/<repo>/releases/<id>`。
    实测有约 5% 的请求瞬时失败（`DEL FAIL`），**必须重试收口**，不要当成"已被引用/不可删"。
    **workflow 本身删不掉**：REST 的 `DELETE /repos/{o}/{r}/actions/workflows/{id}` **不存在**（实测 404）。
    线上残留已删文件的 workflow 只能 `gh workflow disable`（状态变 `disabled_manually`）；
    **要真正从 Actions 列表消失，必须删掉该 workflow 文件本身那次 commit 之前的版本**——
    换句话说：workflow 条目由**默认分支上是否还有该文件**决定，本地 `git rm` 只有 push 后才生效。
    ⇒ 本轮 `build-snapshot.yml` 已本地删除但未推送，线上 `Snapshot Build` 仍在列表里，只能先 disable。
    **判红/证据**：清理前后 raw JSON 快照（`.deploy-tmp/actions-cleanup/*.json`）；
    终态 13 artifacts / 1.74 GB（-87%）、2 caches / 4.84 MB、42 releases（0 draft）；
    删除全程未触碰任何 release asset（`v0.14.4` 仍 12 assets / 586 MB）。

263. **同一个 PowerShell 脚本里，`ConvertFrom-Json` 的字段是 DateTime，`[string]` 一转就变成美式格式——判据和动作会对不上（0.14.5，本轮自伤）**：
    **现象**：清 cache 时我先用**计划脚本**算出「保留 13 个 / 删除 49 个」，再用**执行脚本**动手；
    执行完打印 `DELETE 62 caches / 1,344 MB`，与计划的 49 个不符，我却在当时当成"计划过时"没深究。
    **真因**：两个脚本用了**不同的比较方式**：
    - 计划脚本：`$_.createdAt -ge '2026-10-04'`（`$_.createdAt` 仍是 **DateTime**，PS 把右侧字符串强转成 DateTime ⇒ 比较正确）；
    - 执行脚本：`$created = [string]$x.createdAt; if ($created -lt '2026-10-04')` ——
      `[string]` 把 DateTime 渲染成 `10/05/2026 09:12:27`（**美式 M/d/yyyy**），
      再与 `'2026-10-04'` 做**字符串**比较 ⇒ `'1' -lt '2'` 恒真 ⇒ **62 个全部判为"太老"**。
    **结果**：计划保留的 13 个（约 223 MB）被实际删掉，只剩 2 个删除请求恰好失败的（4.84 MB）。
    **影响**：Gradle cache 是**构建脚手架**，不含任何仓库内容；下次 CI 重新拉取即可自愈（代价是一次构建变慢）。
    所有 release / artifact / 源码**未受影响**（`v0.14.4` 仍 12 assets / 586 MB，42 个 release 完好）。
    **通用教训（比这次损失值钱）**：
    ① **同一批操作的计划与实际必须共用同一个比较函数**，不要一个用对象比较、一个用字符串比较；
    ② `ConvertFrom-Json` 的日期字段**默认就是 DateTime**，要字符串比较就显式 `.ToString('yyyy-MM-dd')`；
    ③ **执行输出与计划不一致时必须当场停手查**——我这次看到了 `62 ≠ 49` 却继续，这正是本仓反复出现的
       「输出看起来正常，但它证明的事情是假的」同一形态，只不过这次是我自己造的。


264. **#341：bounds 去重必须与覆盖层 TTL 租约配对（0.14.5-fx-1）**：旧客户端静止时不发相同bounds，原生4000ms后主动INVISIBLE，DOM/加载仍正常。可见挂载每1000ms续租，隐藏/卸载即停止；普通Mutation去重不能重置续租截止时间。不能删TTL，否则幽灵覆盖层回归；也不能把Surface日志当单一根因。回归新增客户端9例与原生TTL/前台契约，真实绘制留第三阶段。

265. **#340：宽屏顶部避让的高度盒必须一起修**：上游frame是height:100%与grid-template-rows:100%；只加top padding会使底部溢出。宽屏frame用border-box/minmax(0,1fr)消费动态inset一次；absolute fullscreen面板在rightbarCol内，不能再加第二层top padding。手机#135消费位置保留。

266. **#342：端口错误不能被恢复流程抢走**：PORT_FOREIGN必须带拒绝码到屏上，禁止自动undo/retry/属主提示和外部HTTP探活顶掉诊断页；显式重试的新启动owner期间监控也不得抢呈现。私有目录诊断需errno及私有目录访问拒绝双证据，公共文件授权和exec拒绝不能据此误报。

267. **fx2 来源链只构建 committed HEAD**：隔离目录不是当前 dirty 工作树的备份，也不包含未提交修改。输出保留供复查，不复制回原仓；续跑必须验证相同 source/commit，不能复用未知非空目录。独立浅检出可能保留 LFS pointer，必须走 sources 链重建，不能拿它冒充本地现成 base 构建。

268. **fx2 通知延后必须先提交后消费**：入队/清结失败都不能清掉耐久条目，来源偏移提交失败保留重放。pending 八条/五分钟、结算哈希三十二条/五分钟是有界语义，不是全局 exactly-once。未知/损坏 journal 不自动清空，须保留证据并排查格式或存储失败。

269. **WSL 启动 Windows Gradle 必须确认真实进程**：本次 PowerShell 调 gradlew.bat 曾空返回但后台 runner 未结束，重复启动导致同一 app/build 编译竞争。用命令行、父 PID 和创建时间核实归属，只处理本任务 runner；单一 Java wrapper、非增量、in-process 编译完成自检。禁止把锁竞争误判为源码缺陷，禁止批量终止用户既有进程或清缓存。

270. **#0.14.6-A7：插件内的兜底轮询要整体移除，不是改成只读**：旧实现每 120s 写一行 `tick: signature=`（设备实测 2400 行 / 380 KB，同期 `runAutoPass: routes=[]` 零产出）。只把写改只读仍保留常驻定时路径与唤醒。修法：删除全部 `setTimeout` / `setInterval`，改纯事件驱动（`settings/document-updated`）+ 启动期一次性首读基线。判据须两层：源码断言（可执行代码无周期/延迟定时器；排除注释，`setImmediate` 的合法单次用途要白名单）+ 运行期断言（观察窗内周期 tick **增量**为零）。日志不随快照重置，**不能判总量为零**；零增长必须附**存活证明**（进程在 + 同期日志仍在写），否则「进程死了所以没写」会被误判为通过。

271. **#0.14.6-A6：`ctx.get(name)` 是 strict 语义，可选依赖必须用 `ctx.inject`**：装配顺序上本插件行早于 `webserver` 行，`apply()` 里裸读 `ctx.get('webServer')` 只返回已激活（state 2）的实现，恒为 undefined，手动补齐路由在 **web profile** 上也从未注册（设备实测 6 次「webServer 缺席」）。两种相反错误都要避开：写进静态 `inject` 会让 `apply()` 整个被挡（headless 无 webServer，插件全失效）；apply 时裸读又读太早。正解 `ctx.inject(['webServer'], cb)`（可选、依赖到位才跑），静态 `inject` 只留真实必需项。**夹具必须忠实实现 cordis 语义**（服务表 + strict get + 延迟回调），且 provide 与 apply 的**顺序要与真实拓扑一致**（apply 先、provide 后）——夹具若让 get 恒返回假对象或顺序反了，「永不注册」这类缺陷恒不可见（本轮 E2E 假绿即此因）。

272. **#0.14.6-D1：快照门禁的前向闭包必须递归，并加「判据是否空转」元防线**：got 14.6.6 本体在场、12 个传递依赖全缺，旧门禁只查一层，414 条断言全绿而设备 ERR_MODULE_NOT_FOUND（dsh-otel failed to import、session-telemetry-otel pending）。改递归 BFS 并输出完整引用链：改造前 PASSED 但设备正崩 / 改造后 FAILED 13 / 补全后缺口 0、传递可达 433。**元防线**：传递可达数必须大于挂载点数量，否则判「判据疑似空转」——空转比判红更危险。补闭包不要用注册表粗解析推断，要用真实 npm install --package-lock-only 取准（@types/* 也可能是 normal dependency）。

273. **#0.14.6-C：发布资产命名历史翻转过，识别层必须是候选清单**：`-arm64-v8a`（v0.14.1 至 v0.14.2-fx-2）与 `-arm64`（v0.14.0、v0.14.2-fx-3 起含当前 latest）两个口径都真实存在。只认其一会使 arm64 设备对当前 latest **恒判「没有 arm64 资产」**，而包就在那里。修法：候选清单按发布链口径优先 + 兼容历史口径；失败原因按类别如实区分（真实缺失 / 限流 / 网络 / 解析 / ABI 识别 / 镜像数据异常），不再把任何失败都说成「没有 arm64 版本」。**测试必须绑定发布链产物名**（读 .github/workflows/release.yml 与脚本 --artifact-name）——旧测试注释写着脚本名、断言却写 -arm64-v8a，把错误约定锁死，是长期未发现的直接原因。

274. **#0.14.6-交付身份：版本号不升会让更新链恒判 UpToDate**：候选若沿用上一个已发布 tag 作 versionName（本轮 0.14.5-fx-2 / vc49 与线上同名同码），isNewer(tag, currentVersion()) 对任何设备恒 false，**应用内更新永远送不出去**，即「修好更新检测却发不出去」。发版候选必须 versionName/versionCode 双升。连带坑：门禁测试里硬编码的「反例版本号」（如用 0.14.6 断言不等）会在版本抬到该值后**静默失效**（期望抛错却相等通过，本轮被全链门禁正确拦下）——反例版本须用恒不可能相等的值（如 9.9.9）。

275. **#0.14.6-验收：升级安装会触发内嵌快照刷新，装机后首次启动不能立即验收**：install -r 替换 assets/snapshot.tar.xz 后新指纹不等于旧指纹，冷启动走 refreshSnapshot 触发 8-12 分钟重抽取，期间引导页停在 Extracting/Updating 相位，**任何设备套件都会假失败**（本轮 D3 第一轮因此如实记 INCONCLUSIVE）。收敛判据三条同时成立：.snapshot-transaction 消失 + .snapshot-fingerprint 翻转 + 引擎进程出现；**只看「stage 不再增长」不算**（可能只是卡住）。**装了包但从未冷启动**同样表现为「指纹未翻转、依赖仍缺」（本轮 emulator-5558），不要误判成「刷新失败」或「修复失效」；查 boot-fail.log 的 vcode= 可区分历史与本次。状态文件在 files/ 下，不在 files/home/.dsh/（后者是引擎 DSH_HOME）。

276. **#0.14.6-取证：验证手法本身会制造假结果（本轮四例）**：① input swipe 起点落在 ScrollView bounds 之外，根本没滚动，得到「控件不存在」的**假 FAIL**（先读 bounds）；② 用 topResumedActivity 判 chooser 得**假 FAIL**（resolver 是 translucent，须用 logcat 的 ChooserActivity START + Displayed）；③ 整页扫「已就绪」把常驻状态芯片（运行时已就绪 / 存储已授权，任何相位都在）当成相位文案，是**假红**，须只扫相位文案区；④ 按正则取「第一个含按钮文案的节点」会取到同名描述性 TextView（真按钮在文档顺序后面），点击落空却记 PASS，是**假绿**（假绿比假红危险）。只接受 clickable=true 且 enabled=true 的节点，取不到即 INCONCLUSIVE、绝不猜坐标；属性正则要加词边界（否则 clickable 会命中 long-clickable 里的子串）。tap 前必须重新 dump 取界，不得沿用上次坐标。

277. **#0.14.6-安全：验收手法本身也受被验主张约束**：声明「诊断包必须脱敏、凭据不得落盘到包外」时，为做对照把设备上含真 token 的原文拉进工作区**就违反了同一主张**。正确口径：**在设备内比对**（设备端算出「源是否含真值」「包内是否含真值」两个布尔），只把布尔与 sha256 拉回本地，明文从不离开设备。测「脱敏生效」的**决定性对照**不是「扫不到敏感词」（那可能本来就没有），而是「源有真值 + 包内被打码」的同行同字段对照（本轮实测：设备 ?token=P2CQF0Wx 与包内 ?token=***）。另：跨设备对照只能证明「脱敏生效」，要证「同一份源到同一份包」必须同设备闭环。

278. **#0.14.6-D2：客户端插件按 combo 整批物化，一个成员取不到会连累全批**：buildCombo 把一批 rows 合成一个 plugins/??id1/client.js,id2/client.js,...&rev= URL，rev 由**全部成员**一起算；arrive() 里 combo 是整批物化的最小单位，整批取不到则整批 fiber 为 undefined，全部记 failed，启动页把**全部同批成员**渲染成 failedItem。于是被点名的条目往往**不是坏的**，只是与真凶同批（本轮点名的 job/terminal-controller 即如此，实测同批 57-58 条、成员含二者、**不含 otel**）。两类失败要分开：**传输/取得失败**（整批连带）与**工厂执行抛错**（只有自己）。诊断性缺陷（D5 候选）：失败面丢掉了「同批」这一事实，会把 57 个受害者并列报成「装配失败」，下一位开发者逐条排查这些插件**方向完全错**。

279. **#0.14.6-取证：`uiautomator dump` 在引导页必失败，且 `dump; cat` 的失败是静默的（会读到旧文件）**：现象——`uiautomator dump <file>; cat <file>` 在 dump 失败时**不报错**，`cat` 读到**上一次的旧文件**，产出「看似正常但过期」的读数；本轮实例的铁证是 XML mtime = 12:56 而读取时刻 = 15:12（**陈旧 2 小时 16 分**），且该 XML 的 `text` 属性**全为空串**（本来就是个无效文件），据此曾报出 PASS=7。实测判据（同脚本同写法）：**WebView 健康态 `FILE_GENERATED size=64528`（可 dump）；引导页任意相位（busy 与非 busy 均由截图确认）`dump_exit=139 / [ERROR: could not get idle state.] / FILE_NOT_GENERATED`（不可 dump）**。
    **已核实范围（可写结论）**：① 「WebView 健康态可 dump / 引导页不可 dump」有实测支撑；② 该失败**与相位无关**（非 busy 的 Closed 相位同样 `FILE_NOT_GENERATED`，判别实验在 `rm -f` 后执行，**排除了陈旧文件伪影**）；③ 与「`guideView` 可见」**强相关**。
    **真因未定位（显式标注，不得臆造）**：`progressBar.isIndeterminate = true` 虽为**无条件**设置（`GuidePageRenderer.kt:459`；`:631` 另一处同），但它在**非 busy 相位下 `visibility = View.GONE`**（`:455`），且 `setStatusPulse` 的无限脉冲（`repeatCount = ValueAnimator.INFINITE`，`:671`）受 `:471 setStatusPulse(busy)` **门控**、非 busy 时被 `cancel()`（`:677`）——**故「无限动画 ⇒ dump 失败」只覆盖 busy 相位，解释不了非 busy 也失败**。此归因曾被提出（Lead）并在两轮复核中被否证，**不得写入当真因**。已排查排除的候选：`ShimmerTextView`（自带 `INFINITE`，但**全仓零引用**）、`OverlayPanel.kt:644`、`OverlayHalo.kt:163`（均受 `animationsOn()`/`DsUi.animationsEnabled` 门控且在别的窗口）、`GuideChrome.kt`（**无任何 Animator**，仅两处 `stateListAnimator = null`）、`DsUi` 按压缩放（仅触摸时启动）、`OverlayService` 悬浮窗（非默认在场）。仍未排除的候选：Activity 级 Handler **持续自我重投**（`EngineStartFlow.kt:56`/`:70`/`:108` 每 3s、`:521` 每 5s、`:546` 每 10s）——但它**在 WebView 健康态同样在跑**，故**单独不能解释两态差异**。
    **修法（两条，适用范围不同，勿混写）**：① **安全读取＝普适硬规范**——任何 `dump; cat` 型读数都必须：先 `rm -f` 目标文件 → `uiautomator dump` → **校验目标文件已新生**（mtime ≥ 调用开始时间）→ 任一不满足即**抛错**，**绝不返回可能陈旧的内容**（tester 已实现 `lib-safe-dump.mjs`，含「未生成/陈旧/为空」三条反例锁）；② **引导页一律改用 `screencap` 截图 + 真实 `input tap` 取证**——这是**保守选择**，**不是**「已证引导页全不可 dump」的真因结论（真因仍未定位）。
    **为什么不能用 exit code 判断（务必记）**：两侧 exit code **同为 139**（WebView 成功侧 `FILE_GENERATED` 也是 139：其 segfault 发生在**文件写完之后的退出阶段**）⇒ **exit code 完全没有判别力**。「按 exit code 判成败」是本坑最隐蔽的陷阱。
    **附带**：`dumpsys activity top` **不可替代** —— 实测读不到控件文案。污染面可精确定位：**凡能在 WebView 拿到非空内容的读数，本身就证明 dump 成功** ，故污染面**精确落在「引导页」读数上**（A9/A6/entry-healthy/SSOT 设置页侧不受影响）。

280. **#0.14.6-方法论：结论的量词必须与证据的覆盖面相等（本轮两次同族失误的判据化）**：规则两条并列——① **引用行号正确 ≠ 结论正确；采信结论前必须独立走一遍推理链**；② **结论的量词必须与证据的覆盖面相等**（自查问句：**「我的证据能支撑到这个量词吗？」**）。规则②是规则①的可操作自检点：它指出要检查什么，而不只是要做一件事。**两个真实例证（均属量词越界，而非「没复核」）**：① 把「`startUpdateCheck` 无任何**调用点**」（证据只覆盖调用点）写成「**全仓零引用**」（结论声称覆盖全部引用）——实际定义仍在 `EngineStartFlow.kt:549`、另有 2 处注释与 3 处测试按该签名切片，误写会诱使后人删掉它并连带判红两个测试；② 把「某相位无动画」（证据只覆盖 busy 门控的 `:459`/`:671` 两处）当成「**该界面无动画**」（见坑 279）。**写法要求**：给结论前先明确证据的覆盖面，再选量词；覆盖面不足以支撑全称时，**如实标注「范围」或「未定位」**——坑位宁可有已知空白，也不能写一个错真因。

281. **#0.14.6-证据保全：删除前必须确认目标「类型与归属」，破坏性操作不得静默指向他人证据目录**：现象——对 `final-acceptance/round2/B-16512` 与 `final-acceptance/round3/B-16512` 执行了 `Remove-Item`，把**他人（dev-share）的证据目录**误当「杂散 1 字节文件」（实测该目录 23 / 31 个文件）。**结果：目录完好**（`IsDir=True`、`files=23/31`、`zeroByte=0`）。**真因（已确证，见下「归因的两次自我推翻」）**：该次删除命令**漏了 `-Recurse`** => 非空目录进入**确认提示** => 执行环境**非交互** => **删除从未执行**。**纯属侥幸**，与目录名含 `-` **无关**（普通名对照同样失败，已排除），**不是任何防护机制起作用**。=> 记法只能是**侥幸未造成损失，不得记为「有防护生效」**。
    **删除卫生（三条）**：① **删除前先确认目标类型与归属** —— `Get-Item -Force` 看 `Attributes` 是否 `Directory`、内容是否属于他人（当事自评：「我这次连它是不是文件都没验，比『没验绝对路径』还低一级」）；② **`final-acceptance/` 下他人前缀目录（`B-*` / `A-*` / `dev-*`）一律不得删**；③ **破坏性操作必须可回滚或先备份**，且 **「我确认过了」不是防护** —— 确认可能基于错误前提。
    **为什么（同族关系）**：本会话已发生过一次**真实的证据损毁** —— 在共享 `app/build/test-results/` 上跑 `--tests` 定向单测**清空了结果目录**，导致全链构建在最后一条门禁**假失败**（`有结果=1` vs `源测试类=112`）。两者同族：**取证实物与构建产物是不可再生资源，任何「清理」动作都可能摧毁证据链，而损坏往往是静默的**（构建只是判红，没人知道是谁清的）。
    **归因的两次自我推翻（本条的元教训）**：① 当事最初归因「命令报错救了它」—— 独立复现**不成立**（同样含 `-` 的目录名上 `Remove-Item -Recurse -Force -ErrorAction Stop` 是**删成功**的）；② 中途还曾猜「是不是目录名含 `-` 导致参数解析异常」—— 也被普通名对照**排除**；③ 最终用**变量隔离实测**才确证「漏 `-Recurse` + 非交互 => 从未执行」。=> **听起来合理的因果，在验证前不能写进结论**；且同一条归因被推翻两次，说明「可解释」远不等于「已证实」。
    **同族第二例（更严重：声明跑在证据前面）**：另一次当事声称「已清理 `deltest*`」，但**该命令实际从未执行**。**决定反证**：`deltest` 是**空**目录却仍然存在 —— 空目录**不需要 `-Recurse` 也能删**，故它必然没被下过命令。=> 这是「**未执行却声明已执行**」，比「删错目标」更严重：**完成态是假的，下游会基于它继续推进**（注：该目录在本文归档时已不在场，我无法再复核，故此处以当事的决定反证为准）。
    **修法升级为三步（覆盖上面两例）**：**执行 → 读回 → 再声明**。读回不通过（目标仍在、状态不符、文件未新生）就**不得写完成态**。这与坑 279 的「`dump; cat` 必须校验目标文件是否新生」、坑 281 自身的「删前先验类型」是同一族：**没有读回的动作，等于没有证据**。
    **归档效力（本条价值不在「差点出事」）**：① 它暴露了「目录 vs 文件」这一级的基本确认被跳过；② 它示范了**归因必须被验证** —— 当事的「命令报错救了我」与「目录名含 `-`」两条归因**先后被推翻**，最终靠变量隔离实测才确证是「漏 `-Recurse` + 非交互 = 从未执行」；**未经验证的因果不能当结论**（本轮规范第 1 条），而「可解释」尤其不等于「已证实」**未经验证的因果不能当结论**（本轮规范第 1 条）。

283. **#0.14.7-注入脚本模板串：`$'` 会同时毁掉「外层 String.replace」与「内层模板求值」——症状是整段脚本静默不执行**：
现象——在 `dsh-host-web-compat/lib/index.js` 的 `PICKER_SCRIPT` 模板串里新增判据 `if(k.indexOf('__reactProps$')!==0)continue;`，本意只是写一个字符串字面量；
聚合门禁 `smoke-injections.mjs` 立刻报 **`script #4 parses (9476 bytes) -> Invalid or unexpected token`**。

**真因是两层叠加，缺一不可**：
① 模板串里的插值起始是 `${`，而 **`$'` 本身不是**，故这一步不算插值——但该脚本体最终要经 `String.replace(seed, body)` 注入 HTML，
   而 **`String.replace` 的替换串里 `$'` 是特殊模式（插入「匹配位置之后的全部文本」）**，于是 `'__reactProps$'` 被替换成 `'__reactProps<body></body></html>'`，
   **字符串引号被提前闭合**；
② 报错点因此出现在**离真凶很远**的位置（实测报在解析产物的第 55 行，真凶在源码 596 行附近的语义），
   且**整段脚本（含全部 polyfill）一起失效**——本仓注释已记录过同型事故（`join('')` 时期 `Unexpected token 'if'` 静默杀死整个元素）。

**修法**：
- 模板串里**任何** `$` 都要按「会被当作替换模式/插值」对待；判据字符串**不要以 `$` 紧接引号收尾**（本轮改为 `k.indexOf('__reactProps')!==0`，语义等价、零转义）；
- 确需保留 `$` 时用 `\u0024` 或重新组织字符串拼接。

**复验证据**：修后 `script #4 parses (9457 bytes)`，compat `npm test` exit 0，新增 `scripts/file-click-defer.test.mjs` 7/7 全绿。
**为什么值得记**：这类缺陷**编译期不报、运行时整段静默跳过**，只有「逐段 new Function 解析」的注入门禁能挡住；
这也说明该门禁有**真实判别力**——它当场抓到了实现者自己的错误，**不得绕过门禁去改门禁**（同族见坑 305「门禁自身也是防线」）。

284. **#0.14.7-`visualViewport` 判空只写 `=== null` 会漏掉 `undefined`，并在触摸/键盘路径上抛出「整条适配链静默断掉」的 TypeError**：
现象——设备控制台反复出现 `TypeError: Cannot read properties of undefined (reading 'height')`，栈顶指向 `KeyboardBoundary.apply`（`@dsh-android/dsh-client-ui-responsive`），
而该异常**不断打断 `onViewportChange` 与其后的 settle 复算**；页面其余部分看起来正常，属「界面显示正常、用起来不对」那一类。
真因——`keyboard-boundary.ts` 原写作 `const vv = window.visualViewport` 后 `vv === null ? 0 : Math.round(vv.height)`。
**`window.visualViewport` 在部分宿主上求值为 `undefined`（不是 `null`）**，`=== null` 不拦，直接读 `.height` 即抛。
最小复现（CDP 内验证）：`(()=>{const vv=undefined; return vv===null?0:Math.round(vv.height)})()` -> `THREW: Cannot read properties of undefined (reading 'height')`。
修法——统一用 `window.visualViewport ?? null` 归一化后再判空（同包 `composer-popup-guard.ts`、`top-bar-fold.ts` 早已是双判，**同一仓内三种写法并存本身就是漂移源**）。
复验——新增 2 条用例（`undefined` / `null` 各一：不抛错且不误设 frame 高度），**并做反证**：退回单判 `as VisualViewport | null` 时新用例确定性判红（1 failed | 9 passed），恢复后 10/10 绿。
为什么值得记——① 这属**跨特性副作用**：`KeyboardBoundary` 与手势/弹层钳制共处一条 effect 链，一个未捕获异常会连带影响同链逻辑，排查时极易误判成别的功能坏了；
② **`null` 与 `undefined` 在 JS 里是两个值**，凡按「缺席」判空就必须 `?? null`（或 `== null`）；本仓已有同型正确写法，照抄即可，不要另创第四种。

285. **#0.14.7-「摘要自洽」不等于「能解压」：快照门禁只要不解压，坏资产就能一路进包，直到设备上以解码器异常爆出**：
现象——用户真机（华为 SCA-AL00）在 0.14.5-fx-2 与 0.14.6 上**都**启动失败，logcat 唯一真因是
`org.tukaani.xz.CorruptedInputException: Compressed data is corrupt`（栈：`XZCompressorInputStream.read` -> `TarArchiveInputStream.read` -> `SnapshotExtractor.extract`），
而落盘诊断只有 `boot-fail.log` 的 `error=none(boolean-failure-path) stack=none`——真因只存在于易失的 logcat。
真因（两条互补，缺一都会复发）——
① **运行期没有真因出口**：`EngineManager.extractSnapshotTo` 的 `catch` 只写 `Log.e` 就 `return false`，
异常对象从不挂到 `lastRefreshFailure`；`refreshSnapshotInternal` 里另外两条 `return false`（残留目录挪不开、解压后校验未过）同样只留布尔值。
调用方 `EngineStartFlow` 只能拿到 null ⇒ `boot-fail.log` 落成 `error=none(boolean-failure-path)`。
② **构建期没有解压门禁**：`check-snapshot-fingerprint.mjs` 断言的是 `sha256(assets/snapshot.tar.xz) == assets/snapshot.sha256`，
而**声明值由同一条构建步骤自己写**（`build-apk-engine.mjs` 的 `copyFileSync` + `writeFileSync`），属自证；
`check-snapshot-asset.ps1` 只比对 APK 内嵌与传入的 xz —— **两条都不解压**。于是「摘要自洽但字节流解不开」的资产可以一路进包。
顺带两处同族缺陷：`EngineManager` 为取 `fd.length` 打开 `AssetFileDescriptor` 从不 close（真机 logcat 的 `A resource failed to call close.` 即它）；
`SnapshotExtractor.extract` 的 `tar.close()` 无 try/finally，异常路径上 tar/xz 都不关（而这条正是真机走的那条）。
修法——① 失败路径的真因全部挂 `lastRefreshFailure`（+ 稳定 code：`snapshot-extract-failed` / `snapshot-stage-incomplete` / `snapshot-stage-residue`），
复用既有通道，不另造机制；② **解码之前**加一次流式 SHA-256 预检（`SnapshotBundledAsset.digest`，固定 64KB 缓冲、不整读入内存、不解码），
不一致即 `snapshot-bundled-asset-corrupt` 且 detail 带 `expected=/actual=/bytes=`；③ `use{}` 关 fd、try/finally 关 tar/xz（close 异常走 addSuppressed，不得顶掉真因）；
④ 新增构建期门禁 `scripts/check-snapshot-decode.mjs`：用**与设备同一套** streaming 解码器（`org.tukaani:xz` + `commons-compress`）完整解压一遍，
判据 = 无异常 + 条目数 > 0 + 实读字节数 == 条目声明 size 之和（**结尾完整**）；两条链在 `assemble` 之后、per-ABI 段里真跑，失败即 `Deny-Abi`。
反证（实测，非推断）——把 `assets/snapshot.tar.xz` 复制一份、翻转偏移 97309312 处一个字节，
`node scripts/check-snapshot-decode.mjs --tar <坏文件>` 判红 exit 1 并打出 `CorruptedInputException: Compressed data is corrupt`；
同一脚本对真实资产 exit 0（`entries=49521 bytes=710586232`，38s）。**两条链的接线由 `check-gate-skips.mjs` 的反向断言锁住**（声明了却没人跑即判红）。
为什么值得记——① **门禁的输入必须真正被解码**：只比摘要等于「验证了写摘要的人写的是对的」，对「字节能不能解」零判别力；
② 诊断缺口与门禁缺口是**同形复发**——「只留一个布尔值」让真因不可归因，而这类缺口在真机上一次都复现不了（用户没有 logcat 可用）；
③ 「与设备同一套解码器」是这条门禁的全部价值，版本对不上就是在证明别的解码器，属结构性假绿（脚本对账 `build.gradle.kts` 的声明版本，不一致即判红）。

286. **#0.14.7-拖动侧边栏时「内容不完整」：被平移的是收起态的导轨，不是抽屉 —— 上游只按 `data-sidebar-collapsed` 决定渲染内容还是导轨**：
现象——用户截图：把抽屉往右拖到一半时，屏幕上只出现部分内容（不是完整抽屉），松手后才完整展开。
真因（真机实测，非推断）——上游 `AppFrame` 用 `sidebarCollapsed` 决定侧栏渲染，而 `SidebarRoot` 只在 `!collapsed` 时挂载宽版内容
（收起态只渲染导轨，且 `SidebarRoot` 的 `everWide` / `wide` 还会让内容在收起后卸载）。跟手预览层平移的元素**在拖动期间仍是收起态**，
它平移的是一个**里面没有内容**的盒子 ⇒ 用户看到的就是「拖到一半内容不完整」。
真机读数（emulator-5562 / Android 15 / 600 CSS px，CDP `Input.dispatchTouchEvent` 合成真实触摸）：
收起态 `buttons=6 elems=58 innerHTML=11209B`；旧实现拖动中途（`dragging=true`，`inline=translateX(-58.43%)`，rect `left=-169`）**仍是 6/58/11209**（导轨）；
松手后才变 `19/202/40035`。修复后在同样中途位置直接是 `19/202/40035`。
修法——**同一帧内的顺序**：确认开合意图后 `beginDrag()`（先关 200ms 过渡）→ `ensureOpen()`（提交展开，让上游立刻挂载完整内容）→ 才写内联位移。
顺序反了（先写位移后提交）会先闪一下导轨。回退必须用**真正的收起动作**（新增 `closeLeft`）；
**不要拿 `returnToConversation` 当收起用**——它会顺带 `selectPanel(null)`，语义不同会误伤当前面板选择。
右栏存在**完全同型**的问题：收起态上游 dockkit 的 `renderTab` 因 `visible=false` 根本不执行，实测右栏仅 31 元素 / 3307B，一并按同一顺序修好。
连带必修（不改就会自毁）——提交展开后 `resolveAction` 会把**同一次手势**重判成 `return`（因为 `leftOpen()` 已为真），于是自己把刚提交的展开又收回去；
故 `start.action` 必须在首次确认后**锁定**。
同批修的两处事件守卫——`preventDefault()` 前必须查 `event.cancelable`：真机曾反复刷
`Ignored attempt to cancel a touchmove event with cancelable=false`（17 次 touchmove + 1 次 touchend），
说明原生滚动已接管该次触摸，此时既拦不住也不该拦，必须整条手势作废并**回退已提交的状态**（守卫要排在提交之前，否则会「先提交再复位」）。
反证与验收——单测抽掉 `ensureOpen` → 16 条判红；只看掉 cancelable 守卫 → 2 条判红；两次均还原复跑全绿。
真机三档实测：小幅右拖 80px 松手 → 回收起；大幅右拖 220px 松手 → 保持打开；关闭方向拖动中内容不提前消失。
**中栏不重排的判据**：`grid-template-columns` 计算值全程恒为 `0px 600px 0px`（`mobile-form.css.ts` 用 `!important` 钉死 + 抽屉是 `position:fixed`），
所以「提前提交展开」不会动中栏布局 —— 这条要测**计算值本身**，只测 `getBoundingClientRect` 不足以证明 `!important` 生效。
为什么值得记——① 「跟手动画不对」的直觉答案（去调百分比/缓动）在这里是错的：几何完全正确，**错的是被移动的元素里没有内容**；
② 这类缺陷 DOM 断言看不出来（元素在、坐标也对），只有**按内容形态断言**（元素数 / 内容长度）才能咬住；
③ 把「提交状态」与「画位移」分成两件事并在同一帧内定序，是这类跟手效果的正确形状，任何一侧单独做都会退化成用户看得见的错。

287. **#0.14.7-「同意与 APK versionCode 绑定」= 每次升级静默清掉用户同意（用户反馈「root 免责声明每次更新怎么都会掉」）**：
现象——用户群内反馈：每次更新后 root 免责声明都要重新确认（截图实证「还有root免责声明每次更新怎么都会掉」）。
真因——`RootGrant` 把「已阅读」同意存为 `consentVersionCode`，判据是**必须等于当前 `BuildConfig.VERSION_CODE`**；
于是版本号 +1 必然让 `consentValid()` 变 false，并连带把开关关掉。更糟的是这条被当成**有意设计**写进了类注释
（「同意与 versionCode 绑定 ⇒ 升级后 consentValid() 自然为 false，无需迁移逻辑」）——注释的「无需迁移」正是缺陷本身。
修法——同意改绑**免责声明内容版本** `DISCLAIMER_REVISION`，与 APK 版本号解绑：新键 `consentRevision`，旧键 `consentVersionCode` 降为**只读迁移**。
迁移刻意只用「旧值 > 0」这一个与版本号无关的事实（老用户同意过的事实必须保住，否则「修这个 bug」本身又会清一次同意）。
安全属性**一条都不放松**：未同意仍开不了（fail-closed）；取消勾选仍立即撤销同意并同时关闭开关。
迁移纯逻辑提成 `internal fun migratedConsentRevision(stored, legacy, current)`，JVM 可真值驱动。
复验——真值驱动用例（旧键 {1,42,100,999,MAX} → 等于当前 revision；旧键 {-1,0} → 0；新键不被旧键覆盖；`(0,0)` → 0 即撤销后不复活）；
**变异反证**：把纯函数里 `legacyVersionCode > 0` 的返回改成 0 → 该用例判红（1 failed / BUILD FAILED），回滚后全绿。
**写用例的教训**——初版这条用例写成 `for (legacy in listOf(1,42,100,999)) { assertTrue(legacy > 0) }`，
断言的是**字面量**、从未调用迁移逻辑，是恒真断言，却顶着一个「keeps any consenting user」的名字。独立验收者当场指出。
此类断言比没有用例更危险：它制造「已覆盖」的错觉。**凡用例名声称某行为，就必须真的驱动那段代码**；
提取纯函数是让 Android 依赖重的逻辑可被真值驱动的最省做法。
另一条固化下来的判据——清洁面：`decision`/`isGranted`/`state` 的源码里**不得再出现 `BuildConfig.VERSION_CODE`**（静态契约用例钉死），
否则等价于把旧缺陷改回来。
为什么值得记——① 「绑定版本号」看起来是安全加固（升级后重新确认），实际是**把安全门做成了用户可感知的骚扰**，
结果用户学会无脑点同意，安全意图反被稀释；② 持久化键的语义变更必须同时处理**老数据的迁移方向**，
而迁移的职责是「保住既有的合法状态」，不是「用新规则重判历史」；③ 注释里写「无需迁移」往往是缺陷的自我确认。




288. **#0.14.7-浏览器 controller 同步 require gateway 缺模块：host 激活条件不能代替 browser 依赖供给条件**：
现场在同指纹且无快照事务的冷启动中记录 `require("@deepseek-ai/dsh-api-gateway/client") missed the module table`，
两个 controller 未激活。交接中「web-app 没有 gateway 行，所以补 insert」的推断不成立：web-app 继承 base，base 已有唯一 typert-gateway。
Registry 只读取 fiber 存在的行；构造供给方 fiber 未构造而消费者已构造的时序，真实 Registry fixture 的图确实漏掉 gateway，combo factory 同步 require 失败。
修法：既有 client-registry-scan-C4 增补 G1，仅对未 disabled 的 gateway 及其 typert-registry / client-connection 三个 Loader 行解除 browser 元数据扫描的 host fiber 前提。
保留四个 controller、唯一 host 行、gateway browser 的 inject 依赖，其它 pending 包继续不进图；disabled/移除仍从实时 Loader 集合消失。
反证：gateway-client-source-g1.test.mjs 旧图 factory require 失败、新图四个 controller factory 成功，并验证排序、禁用/恢复和 C4 旧树增量升级幂等。
产物门禁保留C4主marker，并另强制requiredMarkers中的G1；单因素去掉G1注释后整个旧字节产物检查只出现这一项红。build-apk只注入插件，改引擎补丁必须先重建build-snapshot，不能沿用缓存快照。
该机制反证已通过；具体真机哪条 host 激活分支触发漏项仍未证明。最终源码 APK 的升级与冷启动三层验收由版本收口记录承载。

289. **#0.14.7-模型列表高度反馈导致白条与双态抖动**：
用户实操取证884条样本证实：键盘展开后max-height归零、绘制高度只剩8px；视口/触发按钮位置不变时菜单仍在258/284px限高之间交替。
真因：guard把已平移、已限高的菜单bottom重新用于高度上限，同时将topShift加入visibleBottom，混用坐标系；上游scroll定位又读取变化后的offsetHeight。
修法：body portal以aria-controls关联的触发按钮top减8px作锚点，高度直接由锚点、顶栏与真实可视区决定；写限高后测实际高度，再算相对上游位置的绝对平移；可视区不可测仍跳过纵向钳制。
源码反证：恢复“用菜单bottom作锚点”后新用例判红；覆盖现场二周期、白条恢复、IME视口过程及高内容重复测量。设备及最终APK结论见版本收口记录，不以单测冒充通过。
完整AVD补充：模型超过4个才出现二级搜索框，必须点菜单内搜索框唤起真实底部键盘。81模型/inset299px时，SN-1-14内部滚动后上游inline top从325改为88，旧shift=-237未同步重算，最终top=-149。只监听scroll/resize不足：仅对controlled模型portal监听上游top/left/width/height，在MutationObserver微任务中重新定位，忽略自身CSS变量，关闭/卸载取消观察。撤掉定位调用的反证精确重现-149，菜单37用例通过；SN-1-15在AVD同81模型/299px键盘下，内部列表及页面上下原生滚动、搜索清空、重新展开全部通过，连续帧无越界。证据见协调仓final-acceptance/0.14.7/evidence/model-SN15-final/。
只读dsh checkout的旧ModelSelect没有搜索框，不能代替当前APK安装模块；安装产物代码与用户真实操作为该问题的现状证据。

290. **#0.14.7-touchstart才设置touch-action不能挽救当前手势**：
旧task11在touchstart改触点style，浏览器已经决定该序列的默认手势，不能靠随后样式修改取消原生滚动。祖先的touch-action也参与交集，旧“不继承所以祖先无效”解释错误。
修法：手机frame预先生效pan-y pinch-zoom，实际横向溢出容器标记为auto例外，保留代码块/横表原生横滚；纵向达到8px后本序列退出，快甩结算不能绕过方向门控。
手势之外更新横向溢出标记，预览style更新不触发全树尺寸扫描。单测与变异反证见版本收口记录；真实触摸跟手、斜向、原生纵横滚动仍需最终APK三层验收。
依据：W3C Pointer Events 2 touch-action规范（https://www.w3.org/TR/pointerevents2/#the-touch-action-css-property）。


291. **0.14.7追加交互：横滚扫描与菜单边界透传**：SN15语义开合/菜单几何通过不能证明时序与边界。真机22触摸发现列表到边界后背景/IME变化；MuMu独立CPU采样约9秒中全frame refreshSurfaces约2.8秒。只收集变化子树，触点活动期间不量尺寸，释放后增量更新，并先过滤overflow再读宽度；对实际模型.scrollable设置overscroll-behavior-y:none。后台任务绝对定位ul会被折叠顶栏overflow裁切，需按真实aria-label提升fixed并保留React树。会话切换需在capture阶段识别data-row-key/aria-selected，先拦自动focus再等待真正选中后收起；只在bubble阶段处理会漏掉React同步提交。候选707单测通过，设备及新APK结果见协调仓followup证据，未验不写PASS。

292. **团队重启反馈与前台服务ANR**：用户报告启用团队重启失败，AVD记录boot-budget-exceeded与独立的ForegroundService未及时提升/输入分发ANR；系统旧ANR弹窗可以遮住已健康的WebView，因此CDPframe=true不能当真人可用。EngineService.onCreate应先startForeground再偏好/manager初始化，启动请求排队在当前Activity生命周期回调结束后发出，重复请求合并并重查关闭/销毁状态；不改90秒预算来隐藏错误。真实团队任务在MuMu生成2成员/1共享任务/1后台任务并交叉核验1468，证明该场景工具与UI可用，不能覆盖arm64重启失败。候选Kotlin与新包冷启动尚待收口。

293. **0.14.7 启动 CAS 等待者被误判为进程死亡**：SN16 AVD 单独运行第2次冷启动最终页面69条、团队入口与前台服务健康且无应用ANR，却新增process-died-during-boot，t_boot_start/listen均为-1，日志头是正常native fallback。
EngineManager的Process已为companion共享，CAS也只允许一个winner spawn；缺陷是loser在STARTING被占时直接返回true，Activity随即拿进程句柄尚未发布的窗口当DEAD并写失败、触发恢复。STARTING持有期间的pre-spawn修复/环境准备可放大该窗口；不是两manager各持有一个不同Process。
最小修法给Activity独立engineBootMayContinue观察，按STARTING→process→STARTING→process顺序读取，覆盖winner发布Process再释放CAS及一次读取期间完整的CAS acquire/publish/release。watchdog/归属仍用原engineProcessAlive，STARTING不能冒充进程所有权。
两处Activity死亡判据使用新观察；90s预算、真实退出、失败释放及预算终态落盘保留，预算文案同时覆盖尚在准备的请求。
EngineBootContinuationTest用latch驱动真实观察函数：winner持CAS但无进程时loser等待，发布后继续，真实退出或失败释放后停止；另精确冻结第一次process旧读，迫使winner在中间完成publish/clear，再验证最后重读不会误判。单测与最终SN17 APK三层证据由统一收口记录承载，不把最终页面恢复健康改写为原失败通过。

294. **`node --test <目录>` 在 Node 24 上按 CJS 解析并失败：门禁写对了、命令写错了（0.14.7 webpages PR #360 合并后 CI 实锤）**：新增的 `pages` 工作流在「资产名与 URL 拼接门禁」一步直接红，报 `Error: Cannot find module '/home/runner/work/dsh-mobile-apk/dsh-mobile-apk/webpages/tests'` + `code: MODULE_NOT_FOUND`，25 个用例一个都没跑。
   **为什么本地没发现**：开发期在本地跑的是**显式文件路径** `node --test webpages/tests/release-url.test.mjs`（25 项全绿），而提交进工作流的是**目录** `node --test webpages/tests/`。两条命令不同形，本地绿证明不了 CI 绿——**门禁的调用形态本身没有被测过**。
   **真因**：`node --test` 的路径参数在 Node 24 上不展开目录；传目录时该参数被当成 CJS 模块说明符去解析，于是报「找不到模块」而不是「没有测试」。加不加结尾斜杠都一样失败（实测两者 `ℹ fail 1`）。
   **修法**：给 glob 并加引号，让 node 自己展开——`node --test "webpages/tests/*.test.mjs"`。不要把展开交给 shell（`sh` 与 `pwsh` 行为不同，且无匹配时字面量透传会再次变成「找不到模块」）。
   **判据（可判红，两条都实测过）**：① 新形态 `node --test "webpages/tests/*.test.mjs"` 必须 `ℹ tests 25 / pass 25 / fail 0`、exit 0；② 反证——旧形态 `node --test webpages/tests` 必须仍然 `ℹ fail 1`、exit 1。只验 ① 不验 ② 就无法区分「修好了」与「这条断言本来就跑不到」。

295. **发布页架构识别在真机上判"未能识别"、PC 上却正常：只取 architecture 不取 bitness 的浏览器把信号丢光了（0.14.7 webpages 线上反馈 + 本轮实修）**
    **现象**：Android 16 上用夸克浏览器与 H 浏览器打开发布页，均提示"未能识别设备架构"；同一页面在 PC 上能正常识别为 x86_64。
    **真因（两处，都会把真机推给"未知"）**：① 这些 Chromium 系内核的 `navigator.userAgentData.getHighEntropyValues(["architecture","bitness"])` 常**只返回 architecture，bitness 为空**，而旧实现用 `arch === "arm" && bitness === "64"` 才算数，空 bitness 一路落到"无线索"；② reduced UA 不含架构 token 且 `platform` 只有 `"Linux"` 时，旧实现同样判 unknown。PC 端因为 arch=x86 + bitness=64 齐全而正常——**"PC 能认、手机不能认"正是该缺陷的可识别特征**。
    **修法**：① architecture 有值但 bitness 缺失时不再丢弃信号，`arm` -> arm64(`likely`)、`x86` -> x86_64(`likely`)，保留用户的"换另一个架构"出口；② `platform="Linux"` 且无架构线索时按主流机型兜底 arm64(`likely`)（Windows/macOS 不会是 `Linux`，真 Linux 桌面几乎必带 x86_64/aarch64）；③ 补零号规则——**桌面系统一律判 unknown**，见下条。
    **判据（可判红）**：① `{architecture:"arm",bitness:""}` 必须为 arm64/`likely`，而 `{architecture:"arm",bitness:"32"}` 必须仍为 `unsupported`（兜底不得放宽确定性结论）；② `{platform:"Linux",ua:"...Android 16..."}` 必须 arm64/`likely`；③ 反证：`{platform:"FreeBSD",ua:"...(X11; FreeBSD)"}` 仍须 unknown，证明兜底不外溢。

296. **同一发布页把 Windows 访客判成 x86_64 并推模拟器专用包：PC 访客要装的是手机，手机的架构在 PC 上无从得知（0.14.7 本轮发现，与 295 同源）**
    **现象**：Windows Chrome 打开发布页显示"已识别设备架构：x86_64"并给出 x86_64 安装包——而 x86_64 包是给 **MuMu 等模拟器**用的，真机是 arm64。
    **真因**：Windows Chrome 的 UA 含 `Win64; x64`，命中字符串探测的 x86_64 规则。判定逻辑默认"访问者就是要在这台设备上装"，而 PC 访客要装的是**另一台设备（手机）**。
    **修法**：新增零号规则，`platform`/`ua` 命中 `windows nt|win32|win64|macintosh|mac os x|macintel|cros` 一律判 `unknown`，界面改为"请选择设备架构"+两个选项。**关键细节**：MuMu 等模拟器**内部浏览器**是 Android UA，不走这一支，其架构由 `userAgentData` 的 `architecture=x86` 决定 —— 故结构化字段必须**优先于** UA 兜底，否则模拟器会被兜底成 arm64（错）。
    **判据（可判红）**：① `{platform:"Win32",ua:"...Win64; x64..."}` 必须 abi=null/`unknown`；② 即使 `{architecture:"x86",bitness:"64",platform:"Win32"}` 也必须 unknown（那是 PC 的架构，不是手机的）；③ 反证：`{architecture:"x86",bitness:"",platform:"Linux",ua:"...Android..."}` 必须 x86_64（证明模拟器路径未被桌面规则误伤）。

297. **发布页 robots.txt 声明了一个从不存在的 sitemap.xml：站点自己给自己制造坏信号（0.14.7 本轮 SEO 核查发现）**
    **现象**：`/dsh-mobile-apk/robots.txt` 返回 200 且含 `Sitemap: https://kelai141.github.io/dsh-mobile-apk/sitemap.xml`，但该 sitemap 请求 **404**——`build.mjs` 只生成 robots.txt，从未生成 sitemap.xml。
    **真因**：robots 与 sitemap 由两处分别维护（前者硬编码在构建脚本里，后者根本不存在），缺少"声明即产出"的约束。
    **修法**：同一次构建同时产出两者，并加门禁守住"robots 声明的 sitemap 必须由构建产出"。另补 JSON-LD / canonical / OG / robots meta 与四段不依赖 JS 的静态正文。
    **判据**：构建产物必须同时含 `robots.txt` 与 `sitemap.xml`；门禁用例断言 build.mjs 里出现 sitemap 产出与 `Sitemap:` 声明。**注意自证陷阱**：JSON-LD 的 `downloadUrl` 只声明**确有其资产**的 URL——声明一个 404 比不声明更糟（与坑 172 同源的"名字对不对"问题）。
    **宿主限制（如实记，非缺陷）**：`kelai141.github.io/robots.txt` 不存在，项目站**无法**从上层目录声明 sitemap；这是 GitHub Pages 项目站的固有形态，不影响站点自身 robots/sitemap 可访问。
   **教训**：门禁脚本改完，必须**用工作流里逐字一致的那条命令**本地复验一次，而不是用等价的手工命令。这个坑与「门禁必须被门禁测试」同源。

298. **Release-page data must retain its schema across refresh and offline builds (#364-#366).** The API exposes tag_name/published_at, while the persisted seed uses tag/publishedAt and ABI-indexed checksums. Re-normalizing a seed as an API response broke offline builds, and rendering the checksum map as a scalar displayed [object Object]. The build now validates each source representation and preserves valid seed checksums; the app selects the current ABI digest and reports missing values. Publication uses release/published and checks out the default branch, because completion of the APK workflow only creates a draft. Regression coverage executes offline and refresh round-trips, the actual app with ABI switching/missing hashes, and the workflow contract. Node 24: 35 tests passed; a live Chromium session confirmed both real release digests.

299. **TAR EOF does not certify XZ stream integrity (#359).** The decoder probe stopped at TAR end markers, so a long padded archive could hide a corrupt or truncated XZ footer beyond the bytes requested by the TAR reader. Closing either stream does not drain it. The production probe now reads the remaining XZ stream to EOF before reporting success. Runtime self-tests cover valid padding and both footer failures (14 checks); an installed APK's 150,009,840-byte snapshot also decoded successfully with the declared decoder versions. Device WebView regression passed in portrait and landscape; no APK or runtime extraction behavior is changed by this build-time gate correction.

300. **Touch reorder cancellation must settle the upstream owner (#357/#358).** A second finger or touchcancel previously cleared only local flags; an unmatched touchend could still drop on the previous target. Because upstream dragend commits its last hover, cancellation now flushes a source-row drop through upstream's no-op path before dragend. Synthetic phases use ReactDOM flushSync, DataTransfer types satisfy the global file-drop handler, and competing trusted Android HTML drag/context-menu defaults are suppressed while this adapter owns the row. Real AVD testing exposed both global transfer metadata and native drag competition after the initial React tests passed. Regression: 713 UI tests, successful build, real catalog cancellation with unchanged order, a subsequent successful reorder, persisted order after reload, and native ADB reorder. The browser-stage lease handle is typed as a numeric window timer so Node ambient timer declarations do not break compilation. Evidence applies to the hot-pushed runtime, not a final release APK.


301. **线路探针把 403 当成"最快线路"：no-cors 拿到的是不透明响应，读不到状态码（0.14.7 发布页线上故障，本轮实修）**
    **现象**：发布页自动选中 `gh-proxy.com` 作为默认线路并显示最快，但用户点"下载"拿到的是错误页而非 APK。该镜像对 MANIFEST 与 APK **均返回 403**（连测三次稳定复现），其余三条线路 302/200 正常。
    **真因**：探针用 `fetch(url, {mode:'no-cors'})`，而 **no-cors 返回的是不透明响应（`type:'opaque'`、`status:0`），读不到状态码**——403 与 200 在探针眼里完全等价。雪上加霜的是 **403 比 200 回得更快**（实测 284ms vs 605ms），于是死线不仅没被判死，还每次都被排成第一名。探针只测了"有没有响应"，没测"响应是不是可用"。
    **修法**：**判活与测速分离**。判活改用 `<script>` 标签——它对 HTTP 错误状态可靠触发 `onerror`、对 2xx 触发 `onload`，且不受 CORS 限制（CORS 模式实测只有 gh-proxy.com 有 `Access-Control-Allow-Origin`，等于只有死线可读，方向完全相反）。测速仍用 no-cors 但打**真实资产** URL，到响应头即 `abort`。死线按钮置 `disabled` 并显示"不可用"，当前线路被判死时自动换走。
    **判据（可判红）**：① 实测四条线路，`<script>` 对 gh-proxy.com 必须 `error`、其余三条 `loaded`；② **反证**：对不存在的版本（`v0.0.0-nope`）必须**四条全 `error`**，证明判据不是恒判活；③ 受控负控：把判活改回 `no-cors fetch` 必须判红。
    **注意**：`<script>` 判活**会真正加载响应体**，所以靶必须是小文件（MANIFEST 约 1.4 KB）；换成 APK 就是 150 MB。

302. **`redirect:'manual'` 在 `fetch` 下全线抛 TypeError，不能当作探测手段（0.14.7 本轮实测）**
    **现象**：想用 `fetch(url,{mode:'no-cors',redirect:'manual'})` 借 `type:'opaqueredirect'` 区分重定向与 403，结果四条线路**全部立即抛 `TypeError`**（0ms）。
    **真因**：`redirect:'manual'` 与 `no-cors`/`cors` 的组合在 Chromium 下不产出可用的 `opaqueredirect` 响应（本站四条线路均走重定向）。`cors+manual`、`cors+follow` 同理。
    **修法**：不依赖该组合；判活走 `<script>`（见 301）。
    **判据**：同一次实测里 `redirect:'manual'` 的四条线路必须全为 `TypeError`，而 `<script>` 判活能得到"三活一死"的**区分性**结果——这才是可用判据。

303. **`ms=0` 被当成"最快"：未测到速度的线路排序第一（0.14.7 本轮自引入并自测出）**
    **现象**：加了"测速失败回退 `ms:0`"后，未测到速度的线路会被排到所有有效测量**之前**。
    **真因**：排序直接写 `sort((a,b)=>a.ms-b.ms)`，而 `0` 是最小的合法数值，语义上却表示"没有数据"。**另有隐藏的第二处**：`runProbe` 内部写缓存时也在按 raw ms 排序，同样中招。
    **修法**：集中到 `rankBySpeed()`，`ms<=0` 一律映射为 `Number.POSITIVE_INFINITY` 排到最后；调用点（3 处）全部改走它。
    **判据（可判红）**：受控负控——只把**其中一处**改回 raw sort，必须判红。**这条负控抓到过真实的判据缺口**：最初的门禁只断言 `rankBySpeed` 存在，改回 raw sort 后仍全绿；补上"调用点必须走 rankBySpeed"与"全文不得出现 raw ms 排序"才判红。

304. **门禁在带注释的源码上做全文正则匹配，会把自己的说明文字判红（0.14.7 本轮踩中）**
    **现象**：新加的判据断言 `app.js` 里不得出现 `mode:'no-cors'` 的健康检查，结果**永远判红**——因为源码注释里为解释"为什么不用 no-cors"必然写了这个写法。
    **真因**：正则跑在**含注释的全文**上，把文档当代码。
    **修法**：先剥离注释再断言（块注释与行注释），并把断言范围收窄到目标函数体（`probeMirror`）而非全文。
    **判据**：同一条测试里补一条**受控正控**——`measureSpeed` 里**确实应存在** `fetch(`，证明"剥离注释 + 收窄函数体"的匹配逻辑真的能命中代码而不是恒不命中。

305. **极简 DOM 环境会把全部线路误判为不可用：把"未探测"当成"探测失败"（外部 PR #372 的门禁暴露）**
    **现象**：新增的 `<script>` 判活让外部 PR #372 的 DOM shim 用例失败——`document.head` 为 `undefined`，`appendChild` 抛 `TypeError`，四条线路全部被判死。
    **真因**：判活函数假定 `document.head` 存在；失败与"没有探测能力"没有区分，统一落到 `null`（=不可用）。
    **修法**：加 `canProbe()` 能力自检；无能力时返回 `{unprobed:true}`，`runProbe` 见"全部未探测"则**不标死线、不排序、不写缓存**，并让点击兜底直接放行。
    **判据（可判红）**：无 `document.head` 的环境下必须得到 `dead:[]`（而不是四条全死）；受控负控——去掉 `unprobed` 分支必须判红。
    **教训**：探测类代码必须显式区分**三种**状态——可达 / 明确不可达 / **无法判定**。把第三种混进第二种，会把"我不知道"升级成"它坏了"，进而把全部选项禁用。

306. **用 read 的分页结果做整文件重写会静默截断文件（本轮真实事故）**
    **现象**：对 343 KB / 1511 行的 `gotchas.md` 追加条目时，用 `read` 取回的内容拼回整文件再 `write`，文件被截成 51 KB / 144 行，**1570 行历史条目丢失**（`git diff --stat` 显示 1570 deletions）。
    **真因**：`read` 对长文件**分页返回**（默认上限），把当页内容当作全文写回 = 用部分覆盖整体。
    **修法**：长文件一律用**定向编辑**追加（以文末唯一片段作锚点），不要 `read` 全文再 `write`；发现截断立即 `git checkout -- <file>` 复原再重做。
    **判据**：写后必须核对 `git diff --stat` 的删除行数与文件字节数，删除数异常大即已截断。


307. **子仓镜像用 robocopy /MIR 打到有未提交改动的主工作树 = 真实丢数据风险（本次无损失，但属侥幸）**：

现象：改 `dsh-client-ui-responsive` 要镜像到 `dsh-mobile-apk/<同名目录>`（铁律 5）。我直接对 apk 主工作树跑
`robocopy <干净worktree>\src <apk主树>\src /MIR`，而该主工作树有 97 项未提交改动，且我的 worktree 基于 `origin/main`、
**不含**用户那些未跟踪的在途文件。`/MIR` 的语义是「让目标与源完全一致」，会删除目标端独有文件。

真因：`/MIR` 不带「只增不删」语义，而镜像源（干净 worktree）是目标（在途工作树）的**子集**。
本次未丢数据只是因为在途工作此前已同步进 apk 主树、两边内容恰好一致，`/MIR` 成了空操作。

取证（判定「有没有丢」的正确方法，不能只看 mtime）：
- `git -C apk status --porcelain -- <子仓>` 数删除条目（本次 0）；
- 逐个 `git hash-object` 比对「coord 子仓未跟踪文件」与「apk 主树同名文件」（本次 12/12 存在且同内容）；
- 单看 mtime 会误判：robocopy 对内容相同的文件也刷新时间戳（`sidebar-reorder.ts` 即此情形，字节与 `origin/main` 一致）。

正确做法：镜像前先 `git -C apk status --porcelain` 确认目标干净；不干净时改用**只复制改动文件的显式清单**
（本次子仓恰好 5 个文件），或先把目标在途工作提交/存档再 `/MIR`。

308. **不要用 read 得到的文本回写大文件（截断即毁档）**：

现象：为给 `docs/AGENTS/gotchas.md`（当时 1721 行 / 340 KB）追加一条坑，我用 `read` 读全文再 `write` 回写，
结果文件变成 202 行——`read` 的返回有行数与字节上限，超出部分被静默截断，回写等于用截断内容覆盖原档。

真因：`read` 是**有界视图**（offset/limit + 输出上限），不是无损取全文的手段；`write` 则是**全量替换**。
把二者配合使用，等于把「有界读」当成了「无损读」。

正确做法：
- 追加一段文本用 `Add-Content`（不读全文、不回写）；
- 需要精确字节时用 `git cat-file blob <rev>:<path>` 取权威内容，再按目标行尾（本仓该文件是 LF）拼接；
- 大文件改动一律避免「read 全文 → write 全文」这一组合。

本次恢复来源：`origin/main` 的该文件（1792 行，比被毁版本更完整），307/308 条按 LF 追加。

309. **`sh -c` 的尾随重定向会遮住屏幕命令体，动态目标也可能被替换值洗掉（本轮静态审查发现）**

**现象**：范围门旧逻辑只在 `-c` 载荷从首尾被引号完整包住时才递归扫描。`sh -c "screencap -p -d 0 /sdcard/real.png" > /sdcard/out` 的重定向使载荷不再首尾配对，于是命令词与目标屏参数被当作引号文本抹掉；另外，`screencap -p $(printf -- '-d 0')` 只审替换命令、不审输出，real-only 也可能被动态改到虚拟屏。

**真因**：把 shell 参数视为整段字符串而不是词法参数；并把命令替换的执行副作用当成完整语义，忽略其输出仍参与命令词/屏幕目标解析。

**修法**：Kotlin 与 bridge 侧按 shell 规则提取 `-c` 后第一个参数，再扫描载荷；重定向与位置参数不参与载荷提取。若 `$()` / 反引号会影响命令词、解释器载荷或屏幕命令目标，则标记不可解析并 fail-closed；不透明执行器在两档范围都拒绝。展开队列达到上限后若仍有未检查段也拒绝。新增跨语言 fixture，权威源在 `plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json`，壳侧副本由 `node scripts/gen-screen-scope-fixture.mjs` 生成。

**判据**：范围判据必须拒绝真实屏 `-d 0` 的 `sh -c` 重定向形式；合法虚拟屏目标即使带 `-c` 位置参数仍放行；动态输出影响屏幕目标时为 `deny-unparsed`。本轮按仓库要求更新执行地图，并跑代码地图静态门禁；设备层验收仍需按 §2.1 完成。

310. **`workflow_dispatch` 自由文本直接插进 Bash 源码会形成 runner shell 注入面**

**现象**：`.github/workflows/build-apk.yml` 曾把用户控制的 `suffix` 直接以内联表达式写入 shell 命令；特殊字符可改变 runner 实际执行的 Bash 语法。

**真因**：GitHub Actions 表达式插值发生在脚本交给 shell 之前，引用/转义又与 shell 语法耦合；artifact 路径和命令参数也复用了未经约束的输入。

**修法**：先通过环境变量传递输入，再在独立步骤中只接受两个 ABI 常量和总长不超过 32 字符的 `-[A-Za-z0-9][A-Za-z0-9._+-]{0,30}` suffix；后续 shell 命令与 artifact 名只消费校验后的环境值。

**判据**：workflow shell 正文不再直接引用 `inputs.suffix` / `matrix.abi`；无效 ABI 或 suffix 在任何构建步骤前失败。不要把上传文件名当作可执行路径。

311. **特权 shell 危险命令黑名单必须先还原引号与转义，否则 shell 可拼出被拦截的操作**

**现象**：只对原始字符串匹配 `settings put` 会放过 `settings p"ut" ...` 或 `settings p\ut ...`；shell 去掉引号/反斜杠后，实际执行的仍是系统设置写入。`pm gr"ant"` 同样能绕过权限命令判据。

**真因**：黑名单把 shell 源码当成已经拆好的 argv；命令词可以由相邻引号片段拼接，也可以由转义字符还原。

**修法**：bridge 服务面先做有界的引号/转义词法还原，再跑危险操作规则；未闭合引号拒绝。若命令词或危险命令族参数含动态展开，则拒绝无法静态确认的情况。服务面仍在 `controlExec`、`execAdbShell`、`execAdbLine` 复查并记审计。

**判据**：服务面反证必须拒绝普通写法、引号拼词、反斜杠拼词和权限动词拼词；被拒命令不进入控制队列。对应反例已加到 `plugins/dsh-android-bridge/test/screen-scope.test.mjs`，本轮未运行测试套件。

312. **认证 nonce 随未限定目标的输入广播发送，会暴露给同 action 的其他接收方**

**现象**：`android_ui_input` 通过 `am broadcast -a ADB_INPUT_TEXT/ADB_CLEAR_TEXT` 发送携带认证 nonce 的隐式广播。其他应用若注册相同 action 的接收器，可能收到 `auth` extra；取得 nonce 后即可伪造输入广播，在本输入法活跃时向当前输入框注入文本。

**真因**：接收器虽校验了 nonce，但发送方没有限定广播的接收包或组件，认证凭据随可被其他应用匹配的广播一同发送。

**修法**：所有输入/清空广播都显式指定 `com.dsharnessmobile.shell/.AdbKeyboardReceiver` 组件，避免广播解析到其他应用；nonce 校验继续作为接收端防线。Android 的 `Intent.setPackage()` 文档说明包约束会把匹配范围限制在指定应用内；此处用 `am broadcast -n` 进一步限制到单个组件。

**判据**：manage 插件所有 `ADB_INPUT_TEXT` / `ADB_CLEAR_TEXT` 发送点都必须指定壳侧接收组件；不得将 auth nonce 放进未限定目标的广播。静态复核确认发送点已收敛，本轮未运行测试或设备验收。

313. **路径脚本、执行环境改写和 shell 包装可以隐藏实际屏幕操作**

**现象**：先用授权的 `shPush` 写入可执行脚本，再让 `shExec` 执行该路径，原文本扫描看不到脚本中的截图或输入命令。前置重定向、带空白的可执行文件名、相对路径、控制结构、通配符命令名及伪装为 `sh` 的脚本还会遮住真正的命令头；`BASH_ENV`、`LD_PRELOAD` 等执行环境变量又能让普通命令加载额外代码。

**真因**：范围门只检查提交的文本，无法认证磁盘中另一段程序的行为；把命令段开头当作可执行文件位置也不符合 shell 语法。原 `sh -c` 提取还可能匹配普通参数中的诱饵，或漏掉引用/转义的 `-c`，因此载荷不一定对应实际启动方式。

**修法**：两侧先还原静态 shell 参数并去掉重定向落点，再识别实际命令头；受限范围拒绝路径执行、带空白的命令头、PATH/启动文件/加载器环境变量改写、命令名通配符、控制结构和不透明包装。仅保留可递归检查的固定 `env/command sh -c` 与 `/system/bin/sh -c` 形态。这是范围门的保守文本策略，不是完整 shell 沙箱。环境加载行为依据 [Bash 启动文件规则](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html) 与 [Android linker 源码](https://android.googlesource.com/platform/bionic/+/d990f7d7f495430875b023538881c9b7a7e81c23/linker/linker_main.cpp)。

**判据**：静态核对脚本与包装拒绝路径，同时核对普通文件命令、固定 shell 包装和合法虚拟屏截图的放行路径。按用户要求本轮只做编译和静态检查，未新增或运行测试，设备层未验收。

314. **引用参数被抹掉、注释/重定向捐出选项、CLI 别名与选项位置差异都可能误认证显示目标**

**现象**：`input -d "0" tap …` 的引用目标会被旧扫描抹掉；`screencap -p # -d 7` 或 `screencap -p > -d 7` 又会把注释/重定向文件名误当作显示选项。`input touchscreen tap …`、`cmd activity start-activity` 和 `cmd window dump-visible-window-views` 也未进入原命令族。静态路径还显示，`wm size … --display 7` 中的未知选项不能证明命令会作用于显示器 7。

**真因**：引用参数、shell 语法与真实 argv 被混为一层；不同 Android CLI 又共享了过宽的显示参数白名单，未核对参数是否处于该命令实际读取的位置。

**修法**：Kotlin 与 bridge 共用等价的静态参数还原规则，引用单个参数保留值，包含空白的单个数据参数不拆成策略词，注释与重定向文件名不参与认证。显示参数按命令和位置核对；无法确认的紧凑、等号、uniqueId 及不受支持的拼写在受限范围拒绝。补齐 input 源/动词覆盖、`cmd activity` 启动面；多显示器窗口接口与 instrumentation 在受限范围保守拒绝。无显示选择器的全局子命令不得借用启动命令的显示参数。

**依据与判据**：[AOSP InputShellCommand](https://android.googlesource.com/platform/frameworks/base/+/8417c7bb1cbb/services/core/java/com/android/server/input/InputShellCommand.java)、[ActivityManagerShellCommand](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/am/ActivityManagerShellCommand.java)、[WindowManagerShellCommand](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/wm/WindowManagerShellCommand.java) 的真实解析路径；静态逐项核对上述拒绝反例与合法目标对照。插件编译通过；测试与设备验收状态同坑 313。

315. **更新 APK 在共享存储上通过哈希校验后，仍可能在等待授权或安装器读取前被替换**

**现象**：更新包原来下载到 `Documents/dshdata/updates`，校验后把同一 `File` 留给 UI 安装或 `readyToInstall` 授权续继。具有相应共享存储写权限的其他应用可以在这段间隔替换文件；此前的 SHA-256 结果不再证明安装器读到的字节。

**真因**：校验与使用跨越线程、用户授权页和进程边界，文件却仍处于可被其他应用修改的位置。原子下载提交只能保护下载未完成的阶段，不能封闭提交之后的替换窗口。

**修法**：下载、复用校验与等待安装全程使用 `filesDir/apk-updates`；安装入口再次要求 canonical 文件为该私有目录的直接普通 `.apk` 子文件，拒绝旧共享路径和逃出目录的符号链接。FileProvider 只新增该子目录映射，交给安装器的单文件 URI 仅授读权限。数据归属见 `PERSISTENT-DATA.md` 的 APK update artifacts 行。[Android 存储安全说明](https://developer.android.com/privacy-and-security/security-tips#data-storage) 支持用应用私有存储保护待使用文件。

**判据与状态**：静态核对 `ApkUpdateController.downloadAndInstall` → `updatesDir` → 哈希校验 → 安装/授权续继仍指向同一私有文件；`EngineAuth.kt`、`EngineProbe.kt`、`UpdateChecker.kt` 已使用 Kotlin 2.0.21 配合依赖接口占位声明联合编译通过。仅证明源文件编译，完整 Android 工程、测试及设备安装流程未验收。

316. **只校验初始 URL 无法限制认证请求的重定向，手工 Cookie 头也不会自动获得浏览器的域隔离**

**现象**：`DownloadSaver` 虽先检查引擎同源，随后携带引擎 Cookie 的 `HttpURLConnection` 仍使用默认自动重定向；其他认证 HTTP 调用同样依赖该默认行为。初始 URL 合法并不保证后续连接仍在引擎源。`EngineAuth.attach` 本身也未拒绝错误目标。

**真因**：Cookie 是通过 `setRequestProperty` 手工设置的普通头。静态检查 [AOSP HttpEngine 的 followUpRequest](https://android.googlesource.com/platform/external/okhttp/+/ba6e9e9/okhttp/src/main/java/com/squareup/okhttp/internal/http/HttpEngine.java) 可见重定向从原请求复制头，跨源只显式移除 Authorization，不能依赖它清除手工 Cookie；[HttpURLConnection 文档](https://developer.android.com/reference/java/net/HttpURLConnection#setInstanceFollowRedirects(boolean)) 说明默认跟随重定向。本轮未做动态泄露验证。

**修法**：两个 `attach` 入口都在读取 Context/缓存 Cookie 前调用 `confineConnection`，要求精确 `http://127.0.0.1:3080` 源且没有 userinfo，再将 `instanceFollowRedirects` 设为 false。未初始化或无 Cookie 时也执行约束，避免 POST 载荷自动转发。调用方看到原始 3xx 状态，不自动追随。

**判据与状态**：静态核对两个入口的约束顺序与全部认证 HTTP 调用点；编译和未验收范围同坑 315。此修复约束 HTTP 请求目标与重定向，不提供 loopback 端口的进程身份认证。

317. **移除应用内更新必须同时删除原生桥、生命周期续继和旧在线快照调试入口**

**现象**：仅隐藏「检查更新」行仍会留下可调用的桥、等待安装授权的生命周期续继、安装权限以及旧 UPDATE Intent；这些都是仍能触发更新动作的入口。

**真因**：APK 更新跨越设置插件、原生启动页、Activity 生命周期和控制器；旧在线快照下载又有独立调试入口，页面可见性不能代表能力是否已经移除。

**修法**：本分支按用户要求删除两处 UI、双方桥声明与构造接线、更新控制器/校验/下载/安装实现、安装权限和专用 FileProvider 映射；同时删除旧在线快照网络更新类、调试 Intent 与启动方法。APK 覆盖安装后的内嵌快照部署、历史事务恢复与用户数据保留继续由原启动链负责。专用测试退役记录见 `scripts/kotlin-test-baseline.json` 的 `featureRetirements`，其余回归基线要求仍在。坑 315 描述的 APK 更新路径在本分支已整体退役。

**检查状态**：UI 插件编译通过并生成本仓 `lib` 产物（`.deploy-tmp/remove-updater-ui-build.log`）；Kotlin PSI 语法解析通过（`.deploy-tmp/remove-updater-kotlin-syntax.log`）。桥对称、Kotlin 注释、control op、op registry、工具名承诺、Manifest 加固、执行地图静态门禁均通过（`.deploy-tmp/remove-updater-check-*.log`）；XML 解析及原生/前端/生成产物的退役符号扫描通过。完整 Android 编译在 Gradle 配置阶段报 `Type T not present`（`.deploy-tmp/remove-updater-android-compile.log`，环境限制见 known-gaps）。按用户要求未新增或运行测试，未做设备验收，未产出新 APK。

318. **维护文档门禁直接比较 LF 与 CRLF，Windows 检出会被误判为生成区过期**

**现象**：`check-maintenance-docs.mjs` 报依赖声明和活动补丁生成区与源码不一致；运行 `--write` 后通过，但 Git 中没有生成内容的差异。

**真因**：生成器用 `\n` 拼接预期内容，检查器从 Markdown 原始文本截取生成区后直接作字符串比较。Windows 检出的 CRLF 与预期 LF 不等；归一化后两份内容一致。因此 `--write` 的本地通过只改变了行尾，下次 CRLF 检出仍会再次报错。

**修法**：只将实际生成区内的 CRLF 归一为 LF，再与预期内容完整比较。生成区唯一性、边界及逐字符内容要求保持原判据，生成器的写入行为不变；不跳过任何文档或生成字段。

**检查状态**：在保留 CRLF 的实际工作区文档上重跑静态门禁通过；脚本 `node --check` 通过，生成区对应文档的 Git 内容差异为空。日志为 `.deploy-tmp/branch-purpose-check-maintenance-docs.log`。按用户限定只做静态检查，未新增或运行测试、自检或合成负控；这不构成完整门禁回归通过的结论。

319. **启动诊断文件与 logcat 会把页面 launch token 原样落出**

**现象**：启动失败时，页面请求 URL（形如 `/?token=...`）及其异常上下文会进入 `boot-diag.log`；`writeBootFail` 还把原始 Throwable 交给 Android `Log.e`，异常消息和栈可能再次带出 token。私有目录权限只能限制其他应用的访问，不能让日志内容在复制、诊断包或 logcat 采集出口变安全。

**真因**：`EngineAuth.redact` 已用于部分诊断副本，但启动诊断和失败终态各自直接写文件；失败路径还把 Throwable 作为单独参数交给 logcat，由系统绕过字符串脱敏自行格式化。

**修法**：`writeBootDiag` 在组装完整单行后脱敏；boot-fail 与显式健康记录在共享有界追加器落盘前再次脱敏；`writeBootFail` 的 logcat 保留脱敏后的 stage/detail/异常类型摘要，不再传入 Throwable。完整异常栈继续保存在应用私有 `boot-fail.log`，并在文件边界脱敏。调用方仍须避免写入其他凭据；当前 `EngineAuth.redact` 只覆盖 URL query 的 `token=` 值，不是通用秘密扫描器。

**检查状态**：`node scripts/check-code-map.mjs` 与 `node scripts/check-kotlin-comments.mjs` 通过；静态核对 `writeBootDiag`、`writeBootFailTo`、`writeBootFailOkTo` 的落盘路径及 logcat 调用，确认其出口均经过脱敏且失败栈不再作为 Throwable 传给 `Log.e`。Windows Java 24 下编译目标在 Gradle 配置阶段报 `Type T not present`；WSL Java 17 重试因未找到 Android SDK 而退出，均未执行 Kotlin 编译。本轮未新增或运行测试、未做设备验收、未构建 APK；日志内的 token 回归仍需在获准测试后验证。

320. **客户端插件失败的调用方直接写 logcat，会绕过诊断收集器脱敏**

**现象**：即使坑 319 的 `writeBootFail` 已脱敏，页面 `[dsh-boot-failed]` 契约行中的 `/?token=...` 仍可能出现在 logcat。

**真因**：生产链 `MainActivity.onConsoleMessage` → `EngineStartFlow.onClientPluginTreeFailed` 先调用安全的 `writeBootFail`，随后为保留页面现场又直接 `Log.e` 输出 `folded.take(400)`。集中出口的修复无法覆盖调用方另开的输出通道，文件安全与 logcat 泄漏可以同时发生。

**修法**：对契约行先调用 `EngineAuth.redact`，再截断到 400 字符；同一诊断副本供文件 detail 与直接 logcat 使用。原文仍只存入原有内存字段，供 failedIds 解析和恢复编排使用。脱敏能力边界同坑 319，不宣称覆盖其他格式的凭据。

**检查状态**：WSL Java 17、工程 Gradle 8.11.1 与 API 36 下 `:app:compileDebugKotlin --no-daemon --parallel` 成功（`.deploy-tmp/wsl-client-failure-compile.log`，16 个任务中 1 个执行、15 个复用）；输入为 `dad75c2` 加本次 `EngineStartFlow.kt` 修改，该文件 SHA-256 为 `809bbad0272799905e992e6e6d7895614f820012970279092ed843616664eb59`。基线 `dad75c2` 在同环境已先执行全量主源码编译，16 个任务全部执行成功（`.deploy-tmp/wsl-android-compile.log`），因此坑 319 先前的 SDK 编译阻塞已解除。静态核对两个输出均使用 `diagnosticLine`，原文仍写入恢复字段；未新增或运行测试、未做设备验收、未构建 APK。编译环境与可重复命令见 [build-and-env.md](build-and-env.md)。

执行地图、Kotlin 注释与维护文档静态检查通过，日志分别为 `.deploy-tmp/wsl-client-failure-{code-map,kotlin-comments,maintenance}.log`；`git diff --check` 通过。这些是编译和结构证据，不能证明设备 logcat 中的实际脱敏行为。

321. **外部文件导入允许应用私有来源，形成 ContentResolver 权限代用路径**

**现象与触发链**：其他应用可显式向 exported `MainActivity` 发送 VIEW/SEND，指定 `file:///data/user/0/com.dsharnessmobile.shell/files/home/.dsh/.credentials.yaml` 或 `/data/data` 别名；旧 `validate` 的白名单包含整个应用私有根，随后 `ContentResolver.openInputStream` 以壳 UID 读取，`copyIn` 将内容放入 `home/.dsh/workspaces/incoming` 并投递附件草稿。content URI 原先也直接放行，可借用壳对内部 Provider 的访问权。这里确认的是受保护数据跨入工作区的源码路径，不声称攻击者已得到文件或草稿已发送给模型。未类型校验的 EXTRA_STREAM 解包还可能让畸形 Intent 在主线程抛异常。

**真因**：目的文件名净化与工作区归属校验只保护落点，没有证明来源可由外部请求读取；私有目录白名单与调用进程自己的 Provider 权限都不是发件人的授权。仅检查打开前路径也无法保证符号链接被替换后读到的仍是同一文件。风险类别与 [Android ContentResolver 安全说明](https://developer.android.com/privacy-and-security/risks/content-resolver) 一致。

**修法**：content URI 要求 Provider 属于不同 UID，且 `checkUriPermission` 回读系统已授本进程读权限；不能只看 Intent flag。file URI 只允许共享存储的规范化路径，拒绝 authority/query/fragment 和上级跳转；异步拷贝与打开前重复检查。打开后以 `fstat` 确认普通文件，读取持有 FD 的 `/proc/self/fd` 目标并核对共享存储归属，随后用 AutoCloseInputStream 读取同一 FD，不重新打开 URI。目标使用 CREATE_NEW/NOFOLLOW_LINKS，拒绝覆盖已有文件或叶符号链接。EXTRA_STREAM 使用 IntentCompat 的 Uri 类型化读取，解包异常回拒绝提示。

**证据与边界**：源码基线 `c4fb115` 加本次 `FileIncoming.kt` 改动，该文件 SHA-256 为 `ff20b84b87f5c14acdc9b216a835dedbfae6cad94a65f7f7ce8d581c81a9d88e`。WSL Java 17 / Gradle 8.11.1 / API 36 的 `:app:compileDebugKotlin --no-daemon --parallel` 成功（16 个任务，1 个执行、15 个复用），日志 `.deploy-tmp/incoming-security-compile.log`。执行地图、Kotlin 注释、Manifest 加固与维护文档静态检查记录在 `.deploy-tmp/incoming-security-check-*.log`；原生源码与调用关系人工复核，未新增或运行测试、未做设备验证、未构建 APK。系统分享授权、FUSE 路径别名、链接替换和资源关闭的运行时效果尚无本轮证据；无法解析或核对时拒绝导入。此处只限制外部来件来源，不改变出站阅读器/选择器的路径允许面；已有目的目录整体替换等同 UID 行为不在本次来源修复的完整证明范围内。

322. **屏幕范围加固后的旧测试仍要求放行未认证选项**

**现象与真因**：WSL 来源构建首次执行 Kotlin 全量测试，1218 例中 3 例失败；旧用例要求 `screencap --display/--display-id` 和动词后 `input --display=0` 这类未认证拼写/位置被放行，另有命令替换夹具仍期待旧拒绝优先级。相关插件测试还按旧提示文案作字面断言。这些预期未随坑 313/314 的保守选择器认证更新；不应为迎合旧用例重新放宽生产边界。

**修法与证据**：保留有效 `-d` 及已注册目标的正向覆盖，将未认证别名与错误位置放入拒绝用例；两条命令替换夹具仍拒绝，仅将拒绝原因更新为当前两端共同的 deny-unparsed。权威夹具经 `gen-screen-scope-fixture.mjs` 同步到 Kotlin。WSL 全量 Kotlin XML 汇总为 1218 tests / 0 failures / 0 errors / 0 skipped，日志 `.deploy-tmp/source-validation-kotlin-tests.log`；插件屏幕范围 47 例全通过，日志 `.deploy-tmp/source-scope-policy-tests.log`。生产 ShellOps 与 screen-scope 源码未改，测试数未减少；未做设备验证。

323. **来源审计分派漏接已登记的 MiMo 精确 verifier**

**现象**：来源快照的补丁副本收敛在 `unknown engine patch verifier: mimo-thinking-toggle-056` 处停止，最终快照检查也会复用同一缺口。

**真因与修法**：registry 和普通补丁链已登记、使用 MiMo 的双文件 planner，但 `verifyCanonicalEnginePatch` 只分派 Pi streaming 和 PTC。补接同一个 `planMimoThinking`，约束读取路径属于引擎根，继续要求所有 plan 的 before==after；未知 verifier 仍拒绝，不改 planner 的版本、锚点或字节判据。`node --test scripts/source-build/reconcile-engine-patch-copies.test.mjs` 6 例通过，含完整双文件通过、只还原一文件即拒绝、未知 verifier 拒绝的受控反例，日志 `.deploy-tmp/source-reconcile-tests.log`。复用 planner 不是跳过 verifier；实际 APK 的快照判据仍须在最终产物上执行。

324. **认证 Termux 新闭包缺许可矩阵项，且 ICU 包把错误页当作 LICENSE**

**现象与真因**：WSL 来源构建的真实候选在第三方许可门禁被拒，缺 c-ares、libicu、nodejs-lts、resolv-conf 四个包名；旧 LFS 基座的依赖闭包没有这些条目。进一步读取认证包，ICU 78.3 的 LICENSE 为 `404: Not Found`（SHA-256 `d5558cd419c8d46bdc958064cb97f963d1ea793866414c025906ec15033512ed`）。Termux 配方下载源使用 `release-78.3`，取许可却将点改成横线，且 curl 未拒绝错误页；包签名证明字节来源，不证明包内文档正确。

**修法**：只补已核对的四个包名，不为未知包提供通配豁免。保留认证包的 c-ares/Node 版权全文、resolv-conf 的官方 Public Domain 声明，并将 ICU 精确发布标签的完整 Unicode 及第三方 notices 固化到仓库 LICENSES，重生成实际版本 notices。候选中的许可文档替换必须逐成员记录原始/替换哈希，程序载荷沿用已验证的来源构建；全部原始 APK 门禁仍须对最终候选执行。各全文路径与上游 URL 只在 [gpl-compliance.md](gpl-compliance.md) 登记。

**证据与边界**：原门禁先以四条缺项反证失败，补登记后对同一实际已注入快照通过，日志 `.deploy-tmp/source-license-check.log`；许可来源及全文 SHA-256 记录 `.deploy-tmp/source-license-evidence.json`。原 Windows 工作树的固定 Shizuku 许可 CRLF 曾触发精确字节校验失败，只恢复为 Git 中 LF 字节，Git 内容差异为空，判据未改；`.gitattributes` 对 LICENSES 原文禁用行尾转换并保留上游空白，避免再把字节校验输入改写。实际 APK 许可文本、修复后的运行时文档与最终签名结果仍以后续交付报告为准；未做设备验证。

325. **apksigner 默认按清单 minSdk 判 v1，会把在场的 JAR 签名报成 false**

**现象**：独立复核 `bc6637f` 产物时，`apksigner verify --verbose --print-certs <apk>` 打出 `Verified using v1 scheme (JAR signing): false`，而同一 APK 内 `META-INF/CERT.SF` 与 `META-INF/CERT.RSA` 都在场，仓库 `scripts/check-apk-signatures.mjs` 也报 `v1=true`。按前者字面读会得出「三签缺一」的相反结论，进而去重签或改门禁。

**真因**：apksigner 的 verify 默认从 APK 清单取 minSdkVersion（本包 26）。API 24 起 JAR 签名不再是安装必需，兼容性报告于是把 v1 标为 false——那是「不适用」，不是「验签失败」。判据本身没错，是调用方没给验证下限。

**修法**：复核与门禁必须显式传 `--min-sdk-version 18`（`check-apk-signatures.mjs` 的 `VERIFY_MIN_SDK` 常量即此值，注释已写明）；「v1 是否真的在」另用两条独立证据交叉——APK 内 `META-INF/*.SF` + `*.RSA` 在场，以及 `jarsigner -verify -strict` 打出 `jar verified`。

**复验证据**：交付目录 `out/source-audit-bc6637f/`（本机，未入库）的 `verify.log`：同一 APK 在不加下限时 v1=false，加 `--min-sdk-version 18` 后 v1/v2/v3 全 true；`jarsigner -verify -strict` 报 `jar verified`；证书指纹 `1dde9d98…45bcbd` 与记录一致。

326. **宿主 npm 缓存路径在 WSL 里落成 `D:/` 目录，混进插件子仓工作树**

**现象**：WSL 来源链的隔离检出里，插件子仓目录下多出 `dsh-client-ui-responsive/D:/coding/dsh-mobile/.npm-cache/…`、`dsh-shell-termux/D:/coding/dsh-mobile/.npm-cache/…`，`git status` 显示为未跟踪，看起来像构建产物被污染或镜像漂移。

**真因**：宿主 Windows 的 npm 缓存配置（`D:\coding\dsh-mobile\.npm-cache`）经 WSL interop 传进 Linux 侧，npm 把该串当成相对路径，于是 `D:` 成了目录名。它是构建环境残留，不是仓库内容。

**修法**：无需改仓库；这类目录不参与插件注入（注入按 `scripts/plugin-dirs.json` 的 `lib/**` 清单走）。要避免生成，在 WSL 侧显式设 `npm_config_cache=$HOME/.npm`。清理时不要把 `?/D:` 当产物提交。

**复验证据**：`out/source-audit-bc6637f/verify.log` 的 V8 行 `PASS snapshot contains no build-host npm cache or 'D:' stray directories`（对最终 APK 内嵌快照扫描 `.npm-cache` 与 `D:` 计数为 0），以及 `evidence/environment.txt` 里记录的同一份 `git status`。

327. **fork 之后的仓库坐标写死上游：来源报告指错仓库、发布脚本在本 fork 不可用、站点指向上游发布页**

**现象**：三处各自独立暴露，都指向同一个根因。① 来源链产出的 provenance JSON 里 `sourceRepository` 恒为 `https://github.com/kelai141/dsh-mobile-apk`——即使构建发生在本 fork 的提交上；② `node scripts/upload-release.mjs` / `sync-release-notes.mjs` 在本 fork 必然失败：它们写死 `OWNER='kelai141'`、`REPO='dsh-mobile-apk'` 并要求对方仓库的 PAT（前者往对方仓建 release，后者 PATCH 对方仓的 release body）；③ `webpages/` 的 canonical / `og:url` / `og:image` / 发布 API / 下载链接 / `SITE_URL` 全部指向上游 `kelai141.github.io`，其断言测试还把该 URL 写死成期望值。

**真因**：仓库从上游 fork 出来后，坐标只存在于源码字面量里，没有单一解析点。`record-project-components.mjs` 是来源链的组成部分（`build-apk-source.yml` 在输入、输出两处各调一次），因此写死坐标不是「文档瑕疵」，而是**产物来源报告的事实性错误**；以可验证性为宗旨的分支尤其不能接受。

**修法**：坐标全部改为运行时/构建期解析，字面量只留默认值：
- 脚本侧：`DSH_SOURCE_REPOSITORY` / `DSH_REPO_SLUG` > `GITHUB_SERVER_URL`+`GITHUB_REPOSITORY` > `git remote get-url origin`（正则归一为 `https://github.com/<owner>/<repo>`）；三者都取不到即**判红**，不回落任何写死值（`record-project-components.mjs` 的 `resolveSourceRepository`、两个发布脚本的 `resolveRepo`）。
- 站点侧：`webpages/src/assets/release.js` 用 `DSH_REPO_SLUG` / `DSH_SITE_URL` 解析出 `OWNER/REPO/SITE_URL/RELEASES_URL`；`index.html` 改用 `__SITE_URL__` / `__REPO_URL__` / `__RELEASES_URL__` / `__LATEST_RELEASE_URL__` 占位符，由 `tools/build.mjs` 注入，并对任何未替换占位符判红；`app.js` 的手动下载兜底改为引用 `RELEASES_URL`（原先另抄了一份上游 URL）。
- 顺带清掉 `release.js` 里「与 App 侧 UpdateChecker.REPO 一致」的陈旧注释——该常量已随应用内更新移除而消失。

**复验证据**：`node --test scripts/source-build/record-project-components.test.mjs` 8 例（7 通过 / 1 既有 SKIP），其中新增用例断言 env > CI 变量 > git origin 的优先级，并带负控「无来源可解析时必须抛错」；`node --test webpages/tests/*.test.mjs` 39/39 通过（Node 24，与 CI 同版本）；受控负控：把 `__CANONICAL_URL__` 这类未登记占位符塞进模板后 `tools/build.mjs` exit 1 并点名该占位符；真实构建产物的坐标全部为本 fork（`https://snoworwind.github.io/dsh-mobile-apk/`、`https://github.com/snoworwind/dsh-mobile-apk/releases`），残留 `__…__` 计数 0。

**后续（同日，按用户指示）**：目标明确为「本分支事实上独立于 kelai141 且只能从源码构建」后，②涉及的两个手工发布脚本已**整体删除**（零调用者、不在镜像面、无门禁引用），本分支不再保留手工发布面。`webpages/` 的处置与三个镜像面文件（`scripts/build-apk-013.ps1` / `scripts/build-release.ps1` / `scripts/build-snapshot-013.mjs`，单边不可删）见 [known-gaps.md](known-gaps.md) 与宗旨文档的「独立」口径。

328. **`webpages` 测试套件在本分支 HEAD 上就是红的：一处 mock 陈旧、一处断言与刻意实现相反**

**现象**：`node --test webpages/tests/*.test.mjs`（Node 24，CI 同版本）在 HEAD `d7a456f` 上判红两处，且都表现为「构建照跑、结果悄悄变差」。

**真因**（两处独立）：
① `release-delivery.test.mjs` 的 fetch mock 只返回 `{ ok, json/text }`，缺 `status` 与 `url`；而 `build.mjs` 的 `fetchText` 会校验 `res.url` 的 host（拒绝 MANIFEST 被重定向到非 GitHub 官方主机）。`new URL(undefined)` 抛 `Invalid URL`，被上层 catch 成「MANIFEST 不可用」警告——**sha256 被静默丢弃**，页面退化成「到 Releases 自行核对」。
② 同一用例还断言「离线（种子）构建必须保留种子里的 sha256」，而实现是刻意的相反口径（`normalize()` 注释：种子可能来自更早、曾信任第三方镜像的构建，只有 `attachSha256` 能从官方 MANIFEST 写入该字段）。测试断言的是已被移除的宽松行为。

**修法**：mock 补 `status: 200` 与 `url: String(url)`（并加注释说明缺 `url` 会重演静默降级）；离线档断言改为 `{}` 并写明「空哈希是正确结果、页面会提示自行核对」。**不放宽实现**——信任种子哈希会削弱「校验值只来自官方 MANIFEST」这条安全属性。

**复验证据**：修前 `webpages/tests/*` 39 例中 1 例失败（在 HEAD 工作树上另跑一次确认与本轮改动无关），修后 39/39 通过；同一 mock 下手工构建日志由「GitHub 官方 MANIFEST 不可用：Invalid URL」变为「sha256 仅取自 GitHub 官方 MANIFEST，命中 2/2」。
---

## 吸收自上游 `main` 的坑位（2026-10-16，上游尖端 `5fca94f`）

> 下列五条原属上游 `kelai141/dsh-mobile-apk` 的 `main`（提交 `1f60bf3` / `db03c5f` / `438538c` / `659ea9c` / `5fca94f`）。
> 本分支的坑位编号已用到 309–328，且**同名编号的含义与上游不同**（例：本分支 313 = 路径脚本隐藏屏幕操作，上游 313 = 陈旧工作树回退）。
> 按 §5.1「编号递增、不得重编号」的规则在此续编为 329–333，括号内保留**上游原编号**，便于与上游文档逐条对照。

329. **已合入源仓的剪贴板修复必须同步 APK 镜像（上游编号 309，2026-10-15）**：host-web-compat #18 已修复 WebView 异步剪贴板拒绝后静默退出的问题，但 APK 镜像仍是 0.1.13，云端会继续注入旧实现。独立同步 0392ef0 的五个文件及 0.1.14 版本，保留原生 writeText → Android 桥 → execCommand 的回落链；三条均失败时给回执。新增 smoke 同时覆盖旧行为负控、精确文本、无桥回落和全部失败。主题归属变更另外交付，避免混入本镜像 PR。

330. **宽表格只在 hover 后启用横向滚动，会让手机首触点被侧栏接管（上游编号 311，2026-10-15）**：

现象：四列以上 Markdown 表格的说明被挤成高行，横滑时误开右栏。上游 `.md-table-wide` 静止态为 `overflow-x:hidden`，侧栏仲裁只识别 `auto/scroll`，触屏没有鼠标 hover；同时单元格 `30vw` 上限过窄。移动端适配以稳定 hook 常驻 `overflow-x:auto`，表格及其后代预设 `touch-action:auto`，按内容分配列宽，保留 100px 最小内容宽和不超过 240px 的内容上限，不缩字号。普通小表格与桌面宽屏鼠标模式保留上游行为。

验证：`tests/sidebar-gestures.spec.ts` 覆盖旧样式负控、流式插入后首触点不抢手势、表格外侧栏仍能展开。jsdom 不证明原生滚动与布局，必须另附 WebView/CDP、ADB 两方向证据。开发期热推不能代替发版 APK 的最终验收。
331. **0.14.8 安全模式重启「点了没反应、过几分钟又能跑」= 刷新窗口内的启动请求被静默丢弃（上游编号 312，本轮实修，L2）**：

定位报告 §2.3/§2.5 确证缺陷**不在**安全模式本身（SafeMode 零碰指纹），而在刷新窗口内启动请求的**零回执**。三条真因缺一条都解释不全：

① `EngineStartFlow.start()` 抢世代所有权失败时直接 `val token = flowOwnership.begin() ?: return` —— 而工厂刷新在**同一个世代里同步跑**、`finish(token)` 只在启动线程 finally 执行 ⇒ 刷新期间 `begin()` 恒返回 null ⇒ 任何再次进入的启动请求不 spawn、不改相位、不落盘。且 `begin()` 返回 null 的**两种原因**（destroyed / running）被并成同一个 return，「被并发让行」与「生命周期终结」分不清，`destroyed` 时还会白等。

② `refreshSnapshotInternal` 把「另一条事务在飞」记成**自己的失败**（`lastRefreshFailure = IllegalStateException(...)` + 失败账本），而同一堵墙上另两处早已是对的：`startEngine` 返回 true 让行、`invalidateSnapshotFreshness` 返回 false 让行。全仓只此一处口径不一致。后果不止日志难看：纯并发争用会喂出「同一份快照连续失败达阈」，让 `shouldDegradeRefresh` 此后**永久跳过刷新**。

③ 成功面只写 `LogCollector.log`，而采集器受 `DevLogPrefs` 门控、默认关闭 ⇒ 用户诊断包里 0 条安全模式痕迹的直接原因。

修法：`start()`/`restart()` 拿到 null 时按 `destroyed`（不启动、不留痕）/ `running`（`writeBootFail` **进 boot-fail.log** + 有界等待后自动续跑）**分开**处置；`performSafeModeRestart` 在**停旧引擎之前**先判事务——先停会让用户白等 8-12 分钟没有引擎，那正是社区现象本身；事务在场则如实相位 + 等收口（`snapshot-transaction-wait`），收口后再先停后启。成功面补 `stage=safe-mode-restart-started`，与既有四个失败 stage 组成两面对照。`refreshSnapshotInternal` 新增 `lastRefreshDeferred` 与失败语义分开，被让行不进账本。

**判据选择（关键）**：跨进程真源用**事务 journal 文件**（`SnapshotTransaction.readMarker(filesDir) != null`）而不是本 Activity 实例的内存态——MainActivity 未声明 `launchMode`，新实例会绕过 `flowOwnership.running`。

**两处易漏的推论**：① 续跑必须**同时**等「事务收口」与「世代所有权空出来」——只等事务会在所有权还没释放时续跑一次，又撞回同一行，等于把静默丢弃换成忙等；② 等待必须有界，否则刷新卡死时把用户无限挂在中间态。

文案：新增 `snapshotTransactionWaitText` 纯函数，**刻意不属于** `safeModeRestartHint` 取值域（后者是 `SafeModeRestartDecision` 四值枚举的穷尽 when，扩枚举等于把修并发缺陷与改既有判定契约混进一个改动）；放行面旧文案「旧引擎已停」改为不预设（事务在场时旧引擎确实还没停）。D3 判据点名的「已就绪/启动完成」类词一个都不出现。

332. **subagent/循环里做「3 路合并」前，先确认工作树的分叉基线：过期工作树会把已合入的上游改动整体回退（上游编号 313，本轮实修踩到）**：

现象：`git diff 5fdcf62 -- <仅两个源文件>` 显示的工作树内容比 `origin/main` **旧**——工作树缺 PR #373 的自适应探针、#387 的剪贴板镜像。若直接 `git add` 这两个文件提交，PR 会静默**删掉** main 上已经落地的 195 行改动（`git diff --stat origin/main` 显示 `EngineManager.kt | 112 +++----`，其中 80 行是删除），而本地门禁此时还会**假红**（`check-code-map` 报 `react-dom.d.ts` 未被覆盖——该文件在 main 上已被覆盖，只是陈旧工作树里的执行地图还没有对应查点）。

判断与修法：
- 先跑 `git diff --stat <怀疑的基线> origin/main -- <你要改的文件>`：非空即说明工作树落后，**不要**基于它提交。
- 正确姿势是**新开一个 `origin/main` 的 worktree**（`git worktree add <dir> -b <branch> origin/main`），把本次改动作为补丁**3 路合并**过去：`git diff <陈旧基线> -- <我的文件> > my.patch` 然后 `git apply -3 my.patch`。3 路合并会以上游为底、只叠加我的 hunk，冲突时显式停下而不是静默回退。
- 合并后必须自查两条：`git diff <baseline> origin/main` 里的上游特征串仍在场（本次是 `nextListenProbeDelayMs`）；`git diff origin/main -U0` 的删除行**只应**是你有意改的（本次恰好 8 行，逐行可读）。
- 同理：陈旧工作树上的门禁红/绿都不可信，必须在 `origin/main` 的 worktree 上重跑才能作为证据。
- **同一坑的第二次显形（文档侧）**：表格类文档按「第 N 行的位置」插入新行时，锚点若取自陈旧工作树，行会插到目标基线里完全不同的位置。本轮把症状索引的新条目插到了 `3.` 与 `4.` 之间却写着编号 `7.`（序列变成 `1,2,3,7,4,5,6`）。**规则：按位置插入的锚点必须取自目标基线**（用 `git show origin/main:<path>` 或干净 worktree 的读取结果），插入后自查该组序号连续无重号 —— `check-code-map.mjs` 不校验这种编号，门禁绿替代不了自查。

333. **WebView 算法深色会把手动浅色再次压黑（上游编号 310），偏好按钮却仍正确**：

系统深色下选择浅色，CDP 显示 `color-scheme: light`、body 无 `data-ds-dark-theme`、computed background 为白色，但设备截图仍是黑底。原因是 baseline 对引擎 UI 开启了 `algorithmicDarkeningAllowed=true`（旧 provider 为 `FORCE_DARK_AUTO`），与上游主题服务形成二次配色。不能把截图发黑直接归因于设置持久化回滚。引擎页声明 `appOwnsTheme=true`，新旧 provider 都关闭算法改色；系统深浅仍由 ThemeBridge 交给上游主题服务。隔离浏览器保留既有策略。验收要同时比对选中偏好、DOM 状态与真实截图。

同轮还发现 early bridge 在 UI 挂载后继续写 html 的 color-scheme，系统切换会让手动偏好与 UA scheme 分裂。桥现在只在空 root 启动期写底色，挂载后只报告 MQL，由 presenter 独占配色；删除守卫的双模式反证必须判红。

334. **本机跑 Kotlin 单测必红一条：Termux JDK 17 在此文件系统上 `creationTime()` 跟随 mtime（2026-10-16 吸收上游时的环境误红）**

**现象**：吸收上游 `main` 后在本机跑 `dsh-gradle :app:testDebugUnitTest`，1232 例里 1 例判红——`EngineAuthPolicyTest > production extractor reads only current log and rejects unknown generation`，断言消息 `stale current-log content with refreshed mtime is rejected expected null, but was:<current_token_123456789012345678901234567890>`。

**真因**：该用例的前提是「把 mtime 改到未来后，`BasicFileAttributes.creationTime()` 仍返回文件真实创建时刻」。本机 JVM（`~/.dsh/opt/jdk17` 的 OpenJDK 17）在这块文件系统上取不到真实 birthtime，`creationTime()` 直接跟随 mtime。实测探针（单文件源码直跑，`-Djava.io.tmpdir=$HOME/tmp/jprobe`）：

```
created(1st)= 1792117211476   mtime(1st)= 1792117211476
created(2nd)= 1792117271477   mtime(2nd)= 1792117271477   ← 把 mtime 推到 +60s 后创建时刻跟着走
created follows mtime? true
```

于是 `EngineAuth.tokenFromCurrentLog` 的 created 判据在这台机器上与「本代起点」同代，陈旧日志被接受。

**为什么既不是本合并的回归、也不能读成生产结论**：① 相关两个文件与本分支合并前 HEAD **逐字节相同**（`git diff backup/security-hardening-pre-upstream-f5ca94f -- EngineAuth.kt EngineAuthPolicyTest.kt` 为空），且本次吸收的 7 个上游提交没有一个碰 `auth`；② 同一用例在 WSL/ext4（有真实 birthtime）上随 1218 例全绿，见 changelog 的 2026-10-15 条目；③ 本结论只覆盖**本机 Termux JDK 的 JVM 单测环境**——生产运行时走 Android libcore 的 birthtime 路径，本轮**未**取得其行为证据，不得据此推断设备侧判据失效。

**处置**：不修改该用例、不放宽 `EngineAuth` 的判据（那会削弱「刷新 mtime 不能让陈旧内容复活」这条安全断言）；本机按**环境阻塞**如实记账，全量结论写成「1231/1232 通过，1 例为本机文件系统 birthtime 不可得导致的误红」。要在本机拿到全绿，只能换到有真实 birthtime 的文件系统（WSL/ext4）上跑，或改用不依赖 creationTime 的判据设计——后者是独立的安全设计改动，不在本轮吸收范围内。

335. **本机 `spawnSync(process.execPath, …)` 必失败：`process.execPath` 是 `linker64`（裁决所有「派生子 node 进程」的门禁）**

**现象**：`node scripts/check-release-gates.mjs` 报「构建/门禁脚本全部可解析（node --check，171 个）」——**171 个脚本逐个**都「解析失败」，而手工 `node --check scripts/check-code-map.mjs` 却 exit 0。同族现象还有两个：`node --test <file>` 报 `error: expected absolute path: "--test-concurrency=0"`（连一个平凡测试文件都红），vitest 默认 `forks` 池报 `write EPIPE`。

**真因**：本机 node 是 Termux 快照里的 **ELF 共享对象**（`PT_INTERP` 指向 Android 的 `linker64`），于是 Node 自己算出的 `process.execPath` 是 **`/apex/com.android.runtime/bin/linker64`**，不是 node 二进制。任何用 `process.execPath` 派生子 node 进程的代码，实际是拿 linker64 当解释器启动，linker64 把**第一个参数**（`--version` / `-e` / `--check`）当成「要加载的程序」，立刻打印 `error: expected absolute path: "<第一个参数>"`。实测矩阵（同一父 node 进程内）：

```
process.execPath = /apex/com.android.runtime/bin/linker64
spawnSync(execPath, ["--version"])            status=1  error: expected absolute path: "--version"
spawnSync(execPath, ["-e", "console.log(2)"]) status=1  error: expected absolute path: "-e"
spawnSync(execPath, ["--check", <abs>])        status=1  error: expected absolute path: "--check"
spawnSync(execPath, [<abs script>])            status=1  error: "/storage/.../check-code-map.mjs"
spawnSync("node", ["--version"])               status=0  v24.18.0        ← 走 PATH 解析就正常
```

⇒ 与被扫文件的内容、行尾、编码**全都无关**，是解释器路径问题。

**修法（本机绕行，不改仓库）**：需要 node 子进程的套件用 `--pool=threads`（vitest 的 worker_threads 不经 execPath）；`node --test` 改成逐文件直跑（`for f in scripts/*.test.mjs; do node "$f"; done`）；依赖 `spawnSync(process.execPath, …)` 的门禁（`check-release-gates.mjs` 的 node --check 全量扫描即其一）在本机**不可判**——按环境阻塞记账，**不得据此判仓库红**，要拿真结论请在 WSL/Windows 开发机上跑。

**判据**：`node -e 'console.log(process.execPath)'` 打 `linker64` 即命中本坑；打 `.../files/usr/bin/node` 则本坑不适用。

336. **组件来源报告可与源码一起被改写，不能充当自身的信任根**

**现象与真因**：`record-project-components.mjs` 的 `inputs` 在构建前把提交文件哈希写入可写 JSON，`outputs` 原先仅验证报告的提交号，再按报告里的 `inputFiles` 检查工作树。依赖安装或构建期间同时改写源码和报告哈希，或从报告删除被改文件，最终校验仍通过；报告中的仓库/包身份也可被改写。构建后新增源码未再次扫描，Git 忽略的 `src/token*.ts` 还会避开最初的 untracked 检查，但仍属于 TypeScript 的 `include:[src]`。WSL 受控反例在旧实现得到 8 通过、4 失败，失败均为本应拒绝却未抛异常。

**修法**：输入和输出阶段共用 `committedComponent`，直接从指定 Git 提交重算完整路径集合、哈希与包身份；输出阶段先逐项核对输入报告与提交内容、实际来源仓库及三组件集合，再按重算清单检查工作树，不按报告提供的路径读文件。两阶段都拒绝组件内非忽略新增文件、`src` 内包含忽略项的新增文件及相对固定提交的 staged additions。合法 `lib` 构建产物保持允许；依赖准备有意实现的 `package-lock.json` 仍保留提交输入哈希并另记实际锁文件哈希，不能改写原输入身份。

**证据**：`node --test scripts/source-build/*.test.mjs` 包含篡改哈希、删除输入、普通/忽略/staged 源码注入、身份篡改、合法锁文件变化以及真实 outputs CLI 拒绝且不覆盖原报告的负控。日志在 `.deploy-tmp/security-provenance-20261016/`；最终结果以 `all-source-tests.log` 为准。新校验器另对既有 `cb8876a` 的真实 WSL 构建目录复核三组件成功；发现的两处宿主 npm 字面量 `D:/.../.npm-cache` 已原样移至该隔离目录 `.deploy-tmp/provenance-recheck-caches/`，移动清单见 `cache-moves.json`，未放宽未登记输入判据。

**边界**：这修复来源记录的内部一致性，不提供对任意同 UID 恶意构建代码的隔离；若校验器、Git 对象库或构建执行环境本身不可信，仍须独立可信执行与复核。文件在检查之间被修改又恢复、依赖本体行为以及运行时安全不由本检查证明。本轮未改 Android 或运行时源码，未重建 APK、未做设备验证；旧 APK 不标记为包含本轮修复。

337. **快照归一化丢失原字节、特殊字段和条件导出顺序，旧摘要不能证明语义等价**

**现象与真因**：`normalizeSnapshot` 原先把所有文件先解码 UTF-8 再哈希，二进制 `80` 与 `81` 都变成替换字符，摘要相同。`canonicalJson` 用普通对象承接 `__proto__`，触发原型 setter 并丢字段。把所有 JSON 递归排序还会吞掉应用自定义的有序映射差异；同一函数用于 `export-dsh-engine.mjs` 的真实 tarball 重打包时，能将条件导出的 `default` 提前，改变 Node 实际加载的代码。Node 的条件导出明确按键序匹配，见 https://nodejs.org/api/packages.html#conditional-exports 。此外，本机 bsdtar 的 gzip 头带当前秒数，全套回归跨秒时暴露既有重打包不幂等。

**修法与调用链**：无规则文件直接哈希 Buffer；命中规则的文本采用严格 UTF-8 解码，非法编码拒绝。JSON 重建使用无原型对象。通用 JSON 排序退出快照规则，只对 `package.json` 顶层元数据和四个依赖映射排序，保留 `exports`、`imports` 及未知扩展字段内部顺序；打包与摘要共用 `canonicalPackageJson`。tar 输出由 Node zlib 压缩，gzip 时间戳固定零。报告增加 `normalizationVersion: 2`；旧版摘要不能与 v2 比较，也不能继续作为语义等价证明，需从原始快照重新计算；原 APK 字节哈希、签名及提交身份不因本修复改变。

**反证与证据**：把最终专项用例接到旧模块 `bc65a17`，Windows 下 17 例中 9 过、8 失败；新模块 17 例全过。真实 tarball 解包后运行 Node，自引用 exports 与 `#x` imports 在旧重打包后从 `safe` 变成 `other`，新实现保持 `safe`。覆盖二进制碰撞、严格解码、嵌套特殊字段、条件和自定义映射顺序、依赖映射正例、gzip 时间戳、真实 CLI 输出版本及拒绝时不生成报告。命令：`node --test scripts/source-build/normalize-snapshot.test.mjs`；全套为 `node --test scripts/source-build/*.test.mjs`：Windows 58 通过、0 失败、23 项 Linux 用例跳过，WSL 补跑 81 全过、0 跳过。执行地图、维护文档生成块及 `git diff --check` 通过。日志在 `.deploy-tmp/security-normalization-20261016/{negative-old,fixed-tests,all-source-tests,linux-source-tests,code-map,maintenance-docs}.log`。Git fixture 需要允许临时 `.git/config` 写入；沙箱下的权限失败不算测试结果。

**边界**：本轮为构建链内部归一化修复，未构建 APK、未做设备验证；没有把旧包记为包含修复。旧 APK 的归一化证据待重算，最终来源包仍需按风险分档及候选要求验收。该摘要仅覆盖列出的规则与文件内容/链接目标，不提供对恶意构建进程的隔离，也不覆盖所有文件系统元数据。

338. **字节相同不代表可运行：归一化摘要遗漏权限、空目录和特殊条目**

**现象与真因**：继续沿快照复核边界测试，发现 `collectEntries` 只收文件和链接，不记 Unix mode、空目录，遇到 FIFO 等特殊条目直接跳过。WSL 反例中同一个 `run.sh` 从 0755 改为 0644 后，真实执行从输出 `safe` 变为 `EACCES`，旧摘要仍相同；0600/0644 的私有权限差异、创建空工作目录、加入 FIFO 也不改变旧摘要。这属于构建证明的漏检，不是对任意应用控制权限的漏洞结论。

**修法**：文件与目录记 `mode & 07777`，目录本身入摘要而非只遍历子文件；FIFO、socket、设备节点等不支持的类型失败关闭。链接继续只记目标、不跟随；报告保留文件数量并另加 `entryCount`。报告版本升为 `normalizationVersion: 3`，v1/v2 不能与当前版直接比较，必须从原始快照重算。

**证据**：`node --test scripts/source-build/normalize-snapshot.test.mjs` 在 WSL 20/20 通过、0 跳过，Windows 18 通过、2 项 Unix 用例跳过。将新用例接到 `1a93af6` 模块，WSL 16 过、4 失败（含报告版本），证明能捕获旧行为。命令、原始日志在 `.deploy-tmp/security-audit-20261016/normalization-{negative,linux,windows}.log`。L1 构建链内部改动，未构建 APK、未做设备验证；不覆盖属主、ACL、xattr 或恶意进程并发置换，不能据摘要宣称整个运行环境等价。

339. **来源链初建/续跑未封住外部目录与报告叶子链接，宿主写入可越出隔离目录**

**现象与真因**：旧 `prepareSourceWorkspace` 续跑只核对少数顶层目录、拒绝指向原仓的链接，初次检出还漏掉写入根 confinement。`.deploy-tmp/source-build` 或其 `source-build-policy.json` 指向无关外部目录/文件，后续 workflow 的重定向、复制和脚本写入都会跟随；指向尚不存在文件的链接还会被 `existsSync` 当作不存在，漏掉解析。真实 runner 受控负例中外部 sentinel 被从 `keep unrelated policy` 覆盖为 `policy`。

**修法**：`canonicalPath` 使用 lstat/readlink 解析 dangling link 并拒绝循环；初次 checkout 与续跑统一调用 `rejectEscapedWriteRoots`，递归覆盖实际宿主写树，包括报告、插件、三组件、补丁 scripts/vendor 及输出。跟随树内目录别名并按物理目录去重，外逃叶子和嵌套父目录均拒绝。仅具体 bootstrap/快照 staging 子树中的宿主不存在的 Android runtime 前缀可保留，兼容 Termux 原前缀、壳重定位前缀及相对别名；报告树无此豁免。

**证据**：WSL `node --test scripts/source-build/local-source-workspace.test.mjs` 13/13；接到旧模块的完整负控 7 过、6 失败，含真实 runner 写出副作用，修复后执行步骤前拒绝且外部文件不变。现有 `cb8876a` 独立来源缓存只读调用扫描通过，未启动 workflow、未改缓存，防止误伤实际 pnpm/runtime 链接。证据在 `.deploy-tmp/security-audit-20261016/source-{fixed,negative,cache-readonly}.log`。最终来源套件 89/89、0 跳过，见同目录 `all-source-tests.log`。

**边界**：L1 构建编排修复，未构建 APK、未做设备验证；不是通用恶意进程沙箱，不保证检查后并发置换、硬链接、显式外部工具缓存的隔离。新增宿主写树时须同步本扫描与负控。

340. **模型能力探测默认重定向与诊断报告可泄漏请求凭据**

**现象与真因**：`capability-probe.ts` 的被动 GET、主动探测正/负控均默认跟随 fetch 重定向，Anthropic `x-api-key` 和自定义凭据头可到达跨源跳转目标。Gemini 被动探测还把 apiKey 放 `?key=`，完整 URL 被写入 `ProbeReport.fetched/notes`，经工具或手动填充 API 返回。异常与服务端错误正文原样入 reason，也会暴露其回显的凭据；只有模型 id 的 descriptor 分支还会再次记录 endpoint。原字符串追加 `/models` 在 baseURL 有 query 时会把路径拼入 query。

**修法**：所有主动/被动探测 fetch 设置 `redirect: 'error'`；Gemini 改用官方支持的 `x-goog-api-key` 请求头（https://ai.google.dev/api/）。用 URL.pathname 追加 API 路径，保留真实请求 query，诊断 URL 则删除 userinfo/query/hash。对本次请求的凭据头、Bearer token、URL 凭据及其编码形式，在异常、服务端错误和 descriptor notes 出口统一去敏；`apply()` 内将已解析 provider 的诊断配置交给共享出口，discover、manual/auto catch、writer trace 和 logger 均去敏，封住上层原样记录 baseURL 的旁路。判定 reasoning.effort 的证据仍用内存原文，去敏不改变正/负控结论。畸形 Unicode 编码失败保留 raw 去敏，避免诊断自身抛 URIError。需要跳转的提供商应配置最终 endpoint，本插件不再自动跟随。

**证据**：隔离 WSL `npm test` 编译并运行插件完整套件 170/170、0 跳过；旧实现五个专项负控全部失败。真实双 HTTP 服务证明 same/cross-origin 跳转拒绝，目标无凭据请求；覆盖 Anthropic、Gemini、Bearer+custom、无密钥及主动正/负控，普通 200 仍成功。回显 URL/query/header、特殊编码、畸形 Unicode 与原有 `invalid model` 诊断回归通过。真实 `apply()` → 注册工具 execute → discover 在临时 DSH_HOME 落盘，日志与工具结果均无 raw/encoded 凭据。源码/测试输入与本仓逐字节一致，编译 JS 已同步核对；测试生成的最小 catalog JSON 已移出本仓 lib，防止误热推，正式目录快照仍由来源链 `gen-model-catalog.mjs` 从对应引擎生成。证据在 `.deploy-tmp/security-credentials-20261016/{test,negative-test,negative-build,restored-build}.log`、`final-copy-parity.log` 和 `source-output-sha256.txt`。

**验收边界**：这是凭据出口与 runtime 行为修复，代码层与宿主真实 HTTP 反证已完成；即时 CDP/ADB 用户层因设备不可用而阻塞，不计通过。WSL `adb devices -l` 为空，Windows 16416/16384 端口未开放，原始前提见 `.deploy-tmp/security-audit-20261016/device-preflight.log`。未构建 APK、未热推、未做设备验证，不具备候选验收结论。待设备上线，按 `hot-push.mjs --plugin plugins/dsh-model-capability` 开发验收并补两方向真实自主任务；最终 APK 仍须来源链重建并重验。诊断去敏覆盖本次已知请求凭据，不宣称能发现任意未知秘密。

341. **危险 ADB 写操作检查漏掉 settings 全局参数与 reset（2026-10-16）**

**现象与前提**：会话已有 `danger-full-access` 与设备 shell 权限、但危险操作开关关闭时，`settings --user 0 put secure accessibility_enabled 1` 仍可进入特权控制队列。`cmd settings`、绝对路径和 namespace `reset` 同样存在漏检。它违反危险写操作必须再获许可的边界，不是无鉴权远程执行。

**真因**：`looksDangerousAdb` 的匹配只接受紧随 settings 的 put/delete；Android CLI 允许动词前出现 `--user <id|current>`，且 reset 也是写操作。语法以 AOSP SettingsService 为准；原有 shell 归一化不负责补齐缺失的 CLI 语法。

**修法**：在已有静态命令归一化后，识别动词前的 `--user` 参数与 put/delete/reset。保留 get/list 只读请求；动态载荷仍沿用已有拒绝规则。三个公开入口 `execAdbShell`、`execAdbLine`、`controlExec(shExec)` 均由同一执行前校验约束。源码与生成 `lib/index.js` 同步。

**证据与边界**：bridge 全套 158/158、0 跳过，新增用例逐条验证恶意写操作不入生产 ControlQueue、合法读取仍入队；临时恢复旧检查时专项负控失败。日志 `.deploy-tmp/security-high-20261016/bridge-all.log`、`bridge-old-policy-negative.log`。最初混用 Windows/Linux esbuild 导致完整构建失败；隔离 Linux 同版依赖、保留完整仓库 fixture 布局后，`npm run build` 与 `npm test` 内再次完整构建均成功，输入与全部 lib 已逐字节同步核对，见 `bridge-full-build.log`。这是原有危险操作防线的定点修复，不把文本黑名单宣称为任意 shell 沙箱。ADB 当前无设备、MuMu 两端口未开放，前提见 `device-preflight.log`；未热推、未构建 APK、未做设备验证，CDP/ADB 即时层仍阻塞；进入候选前必须补验。

342. **主 WebView 的不可信 HTML 子帧可直接调用完整原生桥（2026-10-16）**

**现象与前提**：主 WebView 将 AndroidBridge 和 BackGateBridge 直接通过 `addJavascriptInterface` 注入；Android 将对象暴露给所有 frame，不受 iframe 的 opaque origin 限制。当前固定引擎提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 的 `HtmlBody.tsx` 在用户开启交互预览后以 `sandbox="allow-scripts"` 加载 blob HTML，bootstrap 使用 document.write 执行文件内容。恶意预览脚本因而可以调用 `setScreenScope`、`getPickToken` 等业务桥，突破预览隔离。这是需要开启交互预览并打开恶意 HTML 的高风险调用链；未声称已在真实设备重现。

**真因**：原生桥没有 frame 身份或调用能力认证；顶层导航的 `shouldOverrideUrlLoading` 不能阻止已加载子帧调用注入对象。官方边界见 [Android 原生桥风险说明](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)。

**修法**：MainFrameBridge 成为唯一直接注入主 WebView 的 transport，仅暴露 invoke。每 WebView 随机生成 256-bit nonce，仅在精确引擎 origin 的顶层 JS 闭包安装同步 facade；认证在 JSON 解析和反射分派前完成，只能调用已注册并带注解的业务方法，严格检查实参数量/类型。nonce 不写入 DOM、全局属性或公开函数源码。AndroidX document-start 优先，旧 provider 采用页面生命周期求值回退，执行时仍复查实际 origin/top；桥迟到通过 ready 事件刷新 useShellState。renderer 丢失或 Activity 销毁撤销 transport。同步返回、null、void 与方法重载保持兼容；源码与 UI lib 同步。

**边界**：真正同源子帧可以按浏览器 SOP 调用父页面的 facade，nonce 不是同源 XSS 沙箱。交互预览必须保持 opaque sandbox，不能添加 allow-same-origin。主引擎顶层与本机调试器仍是受信面。

**持续回归**：bootstrap 测试已接入 PR Gate 和来源链 workflow（本地 runner 同样读取这份 workflow）；来源链 Node 回归命令本机实际运行 118/118、0 跳过，见 `source-workflow-regressions.log`，不等于远端 CI 已执行。最终输入/生成文件摘要在 `final-input-sha256.txt`。

**证据**：WSL Java 17/Android SDK 的 `:app:testDebugUnitTest` 全量 1240/1240、0 跳过（含新增 MainFrameBridgeTest 8 项）；直接调用生产 AndroidBridge 验证错误 nonce 不能写屏幕范围或读取 picker token，正确 nonce 保留功能。临时禁用 constant-time nonce 比较时 8 项中 2 项失败，恢复源文件后重跑全量成功。`node --test scripts/tests/main-frame-bridge.test.mjs` 从生产 Kotlin 提取实际 bootstrap，7/7，覆盖 opaque/同源 child 不安装 facade、不可信顶层、同步值/重载、公开函数不泄 nonce、重复注入、导航后 origin 复查；VM 不等于 Android frame 验收。UI `npm run build` 成功，Node 22 同源码/测试副本完整套件 711/711、0 跳过；副本按真实仓库布局提供 vendor 输入。Windows Node 26 下原套件因 localStorage undefined 失败，原始日志保留，未弱化或跳过断言。桥对称、代码地图、Kotlin 注释、Manifest、安全 IO 与 Kotlin 数量门禁均通过。

**证据入口与未验范围**：`.deploy-tmp/security-high-20261016/` 下 `kotlin-all.log`、`native-negative.log`、`frame-js-tests.log`、`ui-build.log`、`ui-all-tests.log`（Windows 原始失败）、`ui-all-tests-node22-final.log`、`ui-source-parity.txt` 与 `check-*.log`。当前 ADB 无设备、MuMu 16416/16384 无监听，见 `device-preflight.log`。按 AGENTS §4.2/§2.1，本改动即时 CDP/ADB 两层仍阻塞，**未做设备验证**、未构建新 APK，不具备候选验收结论。原生改动不能热推代验；后续只能从已提交 HEAD 经来源链构建，装机补做恶意 opaque 预览拒绝、可信顶层正常设置/返回与生命周期恢复的真实自主任务，并覆盖竖横屏及发布前 arm64。

343. **包管理危险写操作可经 `cmd package` 别名与 `pm clear` 绕过（2026-10-16）**

**现象与前提**：已有 `danger-full-access` 会话、ADB 特权通道和 `all` 屏幕范围时，危险操作开关关闭仍允许 `cmd package grant/revoke/install/uninstall` 与 `pm clear <package>` 入队；clear 可抹掉目标应用用户数据。测试替身证明服务端把这些原样派发为 `shExec`，未对设备执行。

**真因**：过滤器识别了部分 `pm` 动词，也有独立且更窄的 `cmd package` 匹配；漏了两个命令入口同义且有破坏性的动词。Android AOSP `pm` 脚本把参数直接转交 `cmd package`，见 [AOSP pm wrapper](https://android.googlesource.com/platform/frameworks/base/+/61e5ff785d23/cmds/pm/pm)。

**修法**：`pm` 和 `cmd package` 统一使用同一组拒绝动词，并覆盖用户选项、权限变更、安装/卸载、清数据、禁用/隐藏/挂起及其它 `set-*` 写面；`list`、`path` 等查询仍可用。共同执行点保留原会话与危险检查。

**证据与边界**：真实生产 `AndroidPrivilegeService.execAdbShell → ControlQueue` 反例验证见 `.deploy-tmp/security-high-20261016/bridge-cmd-package-probe.log` 与 `bridge-pm-clear-probe.log`（不含设备执行）；新回归通过三个公开服务入口确认拒绝在入队前发生，并确认只读查询继续工作。shell 命令静态策略仍不是完整命令解释器沙箱。

344. **子帧导航被提升为主页面，并可混淆原生会话下载路由（2026-10-16）**

**现象与前提**：主 WebView 的 URL 拦截器未区分 main frame 与子 frame；子帧请求引擎同源 URL 时，壳会主动在同一个 WebView `loadUrl`，把导航提升到原生桥已授权的 top document。另 `isSessionExport` 用整个 URL 的 `contains` 判路由，查询串或 fragment 含 `/api/session.export` 的 `/api/file` 也会被作为会话导出。此时 DownloadSaver 经 `HttpURLConnection` 附带引擎 Cookie，绕过浏览器端的 Host/Origin 检查并将响应写入用户下载区。交互式恶意 HTML 预览是触发前提；反例确认的是路由/predicate 逻辑，未声称在真实 WebView 复现。

**修法**：除 blob/data/about 预览文档外，子帧导航不再接管 top WebView 或打开外部应用；仅 main-frame 且带真实 gesture 的 GET 可触发会话导出。谓词现在逐段解析 URL，只接受精确引擎 origin 和完整 `/api/session.export` path；下载回调及保存函数再次校验同一白名单，其他 API 不经壳侧 Cookie 代理。

**证据与边界**：Kotlin JVM 用例覆盖查询、fragment、path 前后缀、方法、端口和 userinfo；壳侧单测验证实际纯判据。设备暂不可用，Android WebView 的子 frame 导航回调与真实下载行为仍待 CDP/ADB 核验，不把静态谓词反例当设备利用证明。

345. **快照探针门禁未沿 pnpm 目录软链读取归档成员（2026-10-16）**

**现象与真因**：ARM64 快照暂存树中 `dsh-client-modules/lib/index.js` 存在且带完整 phase 探针，但 `check-perf-instrumentation.mjs` 报目标成员缺席。pnpm 将包目录放在 `.pnpm`，scope 下路径是目录软链；GNU tar 按软链后的文件别名单独 `-xf` 时只提取别名项，不会跟随软链解出 `.pnpm` 中的真实文件，检查器因此读到缺席。另在 Windows 检出后运行 CLI 回归时，上游锚点夹具被 `core.autocrlf` 改成 CRLF，导致同一夹具无法命中补丁锚点。

**修法**：检查器在当前快照暂存根内解析请求路径的真实文件位置，并从归档读取该规范成员；解析目标必须留在暂存根内，读到的仍是归档字节。为保持补丁夹具与上游字节一致，在 `.gitattributes` 中对该生成夹具禁用行尾转换。回归夹具同时包含软链和 `.pnpm` 实文件，另保留旧 P1、缺成员和坏 tar 负控。

**证据与边界**：WSL `node scripts/check-perf-instrumentation.test.mjs` 全部通过；`--self-test` 与 `check-code-map.mjs` 通过。修复版检查器对实际 ARM64 `snapshot.tar.xz` 检查 3/3 成员通过，两个出厂 profile 的 bundles 均为 2、死键为空。该问题是构建门禁误报，不代表应用快照缺包；设备验证尚未执行。

346. **云端默认构建入口仍分流到旧 LFS 链，来源证据隐藏目录被默认排除（2026-10-17）**

**现象与真因**：`build-apk.yml` 默认 `source_audit=false`，实际执行旧底座构建，文档却说已复用来源链；`build-apk-source.yml` 虽列举 `.deploy-tmp` 内来源证明，upload-artifact 默认排除隐藏文件，可能只收到 APK 而缺证据。

**修法**：主入口仅无条件调用同提交的来源工作流，删除已无效的 ABI/suffix/审计开关；保留来源链现有 ARM64 能力。上传只对现有精确证据清单启用隐藏文件，未扩大为整个临时目录。使用说明见 build-and-env.md 的 GitHub Actions 来源构建入口。

**验证与边界**：入口 YAML 回归包含旧构建 job 注入与条件调用负控；既有来源链 Bash 回归继续覆盖插件失败即停止。该 L1 改动未做设备验证，不宣称双 ABI、发布或设备验收已完成；云端执行结果以本次 Actions 记录为准。

本轮实际验证：WSL 来源链 Node 测试 91/91、Python 测试 3/3 通过，执行地图检查通过。推送 `0bc7264` 后 dispatch 返回 HTTP 422 `Actions has been disabled for this repository`；GitHub Actions 页面明确显示 fork 因使用规模暂停，需维护者重新启用。仓库权限 API 的 enabled=true 和 workflow enable 均未解除该限制，故未启动云端构建、未产出本轮 APK。

347. **来源证明测试夹具继承 CI 仓库身份导致云端预检立即失败（2026-10-17）**

**现象与真因**：Actions run `38935337988` 在来源链预检中 120 项测试通过 119 项；夹具期望 `fixture/fork`，实际拿到 `snoworwind/dsh-mobile-apk`。来源解析按 DSH_SOURCE_REPOSITORY、GitHub 环境、git origin 优先级工作，测试仅配置临时 origin，未隔离 runner 自带的 GITHUB_REPOSITORY；本地没有该变量所以未复现。

**修法与证据**：仅在同步测试夹具生命周期设置并恢复 DSH_SOURCE_REPOSITORY，子 CLI 一并继承夹具身份；生产来源解析和拒绝伪造的判据不变。新增外层覆盖恢复用例；用 GITHUB_REPOSITORY=snoworwind/dsh-mobile-apk 与 GITHUB_SERVER_URL=https://github.com 执行与云端相同的完整 Node 预检，保留伪造输入、错误仓库与缺失 origin 的负控。日志在 `.deploy-tmp/actions-source-ci-env/`。本 L1 测试修复未做设备验证。

348. **来源链 artifact 转为 Release 资产必须保留隐藏证据与同 run 身份（2026-10-17）**

**问题与原因**：草稿发布若只匹配 APK 或跨 run 下载，可能发布与源码提交不对应的包；来源证明位于 `.deploy-tmp`，仅复制可见文件又会丢失复核资料。

**实现**：新增手动来源草稿工作流，仅接收 `security/hardening`，构建继续复用来源链。只读准备阶段按源码工作流上传清单逐项验证证据存在，核对仓库、提交、APK 数量/ARM64 名称及哈希；证据压缩保留相对路径。独立写权限 job 不检出源码，只复核资产哈希并以 `--draft --prerelease --target <同提交>` 创建草稿。run/attempt 参与标签，重跑不覆盖既有资产。公开前设备验收责任见 RELEASE.md §5。

**证据与边界**：WSL Python 8/8 与来源 Node 93/93 通过；生产发布 shell 用 gh 记录替身确认 draft/prerelease/target 参数，篡改 APK 后在调用 gh 前失败。缺证据、错仓库/提交/分支负控均拒绝。actionlint 1.7.12 校验三个来源工作流通过；维护文档与执行地图检查通过。未做设备验证，测试没有创建真实 Release，首次云端草稿仍需以运行结果确认。

349. **预发布来源证据目录通配符在 Linux runner 判缺失（2026-10-17）**

**现象与真因**：草稿流程 build job 在来源链 Python 预检处报 `missing evidence: scripts/patches/tests/fixtures/*-0.2.0-rc.2/**`，来源 APK 尚未开始构建。校验器用 `pathlib.Path.glob` 解释 Actions 上传清单的递归目录模式，但它对中间通配符目录与 `**` 的组合未按 Actions 的目录内容语义匹配。

**修法**：改为 Python `glob.glob(..., recursive=True)`，并仍要求匹配项至少包含一个实际文件；固定文件证据逐项检查不变。WSL Linux 与 Actions 同命令的 Python 8/8、Node 93/93 通过，涵盖缺证据拒绝和成功打包全项隐藏证据。首次 run 38937039856 失败无 APK/Release；修复后的首次重跑仍以 Actions 验证为准。

350. **loopback URL 精确匹配仍无法认证 3080 端口的监听进程，探活可能泄露会话 Cookie（2026-10-17，源码修复见坑 352，设备待验）**

**触发条件**：其他 Android 应用先在本机 `127.0.0.1:3080` 监听，而 DSH 引擎尚未启动或暂时退出；随后壳侧触发 `EngineProbe.check()`。Android 官方安全清单明确指出，localhost 端口可被设备上的其他应用访问，不应单独用于敏感 IPC。

**现象与根因**：`EngineProbe.check()` 在识别监听者身份前调用 `EngineAuth.attach(conn)`，向精确 loopback URL 发送已保存的会话 Cookie。`EngineAuth.confineConnection()` 只校验请求 URL 并关闭重定向，不能证明该端口由壳侧引擎持有；因此伪造监听者可直接收到 Cookie。已记录的重定向防护（坑 316）仅阻止初始连接之后的跨源转发，不能阻止连接到伪造的初始监听者。

**修复方向**：认证凭据与敏感请求载荷只在壳侧能证明当前引擎进程归属后发送；逐一审查探活、Cookie 刷新、RPC、通知与控制队列的请求路径。仅凭 HTTP 状态码、当前 generation 的旧 token 行或精确 loopback URL 不足以证明监听进程身份；需另找可在真实调用链上核验的归属凭证。

**证据与边界**：源码调用顺序确认于 `EngineProbe.check()` → `EngineAuth.attach()` → Cookie header 设置；静态确认，无设备动态利用复现。严重性按跨应用会话凭据泄露评为高。Android 指导：[Security checklist — localhost ports](https://developer.android.com/privacy-and-security/security-tips?authuser=1&hl=en)。修复与设备复验完成前不得将此项视为已关闭。

351. **云端来源构建继承 Termux 子仓 Windows npm cache（2026-10-17）**

**现象与真因**：来源链构建快照、APK 和单测均完成；末尾 `record-project-components.mjs outputs` 报 `untracked component inputs`，路径为 `dsh-shell-termux/D:/coding/dsh-mobile/.npm-cache/...`。根因是被提交的 `dsh-shell-termux/.npmrc` 固定 Windows 开发机缓存路径；Linux npm 把该相对解释后的目录写入源码组件树，污染生产输入，正确触发来源证明拒绝。

**修法**：来源 workflow 在任何预检/依赖步骤前创建 `$RUNNER_TEMP/dsh-npm-cache` 并通过 `$GITHUB_ENV` 设置 `npm_config_cache`，覆盖仓内 `.npmrc`，缓存不再进入组件树。保留来源证明门禁，不忽略污染目录。入口回归检查覆盖覆盖设置位置；WSL Linux 实跑来源 Node/Python 测试。失败 run 38935633493 因来源输入污染无可用 artifact；旧提交运行不能代替修复后重跑。

352. **敏感引擎流量不能靠发送前的端口探针认证，必须持续持有 TCP 绑定并核验实际后端连接（2026-10-17，设备待验）**

**现象与真因**：坑 350 中的初始监听者冒充影响 Cookie 探活、token 交换、RPC、通知与 mux，也影响携带控制令牌/结果的 ControlPoller 和文件来件投递。即使添加一次“子进程活着”或 challenge 预检，后续新连接仍可在检查后被抢占；WebView 的持久 Cookie 也不会受原生 attach 单点保护。

**修法**：壳进程 `EngineTransport` 在凭据出口和页面导航前先独占绑定 loopback 3080，直到整个壳进程结束都不关闭此 listener；引擎仅通过 APK 内 preload 改绑应用私有 Unix socket。转发器在同一条已建立的 LocalSocket 上读 SO_PEERCRED，确认 app UID 后才转发任何 HTTP/WS 字节。端口绑定失败时 attach、token exchange、mux、控制队列、文件投递和首次 WebView 导航拒绝；重试成功可从空页面恢复。启动、停机和 watchdog 的 portReachable 查后端而非 relay 自身，防永久假活。连接与线程有界，双向共享活动时间防流式响应因上传半边空闲被截断；mux 每次退出关闭连接，控制/来件不跟随重定向。引擎重启只替换后端 socket，不释放凭据所用 TCP 端口。

**信任边界**：验证的是应用 UID 安全主体；同 UID 的任意恶意插件本来就可读取凭据，不由此 transport 隔离。上游源码不改，preload 从最终 APK assets 加载，因此必须来源链构建新 APK，热推不能代验。

**代码证据**：WSL Linux 的 `node --test scripts/tests/engine-private-transport.test.mjs` 通过 2/2，覆盖伪造 TCP 监听者零凭据、私有 HTTP/token/Cookie、WebSocket upgrade、公开 address 保持与无关 HTTP 端口不受影响；已接入 PR Gate 和来源链预检。新增 Kotlin 拒绝用例与 `EngineTransportInstrumentedTest`（fresh process 的抢占负控 + 正常私有转发）。本机完整命令、日志和最终结果见 `.deploy-tmp/security-350/`；此目录仅供本机复核，不代替可分发 APK。

**设备边界**：ADB devices 为空，连接 `127.0.0.1:16416`、`127.0.0.1:16384` 均返回 connection refused，真机未在线。**未做设备验证**，未执行 instrumentation、CDP 或 ADB 自主任务；源码修复不等于漏洞已完成三层关闭，来源链新包和双方向设备证据仍待补齐。

本轮实际编译与测试：WSL Java 17 执行 `:app:testDebugUnitTest :app:compileDebugAndroidTestKotlin` 成功；最终 XML 为 113 类、1244 项，失败/错误/跳过均为 0，包含新增 3 条生产入口拒绝反证；instrumentation 仅编译，未执行。日志 `.deploy-tmp/security-350/gradle-final.log`。单测数量基线仅提升总数并登记新类，保留既有 featureRetirements；本机 buildDirectory 重定向到 WSL 私有缓存，仓内旧 app/build XML 不可作为当前证据。

353. **主题里的 navigationBarColor 就是「底部栏没有沉浸」的那条色带（issue #392，本轮实修）**：

现象：屏幕最底部有一条色带，与应用底栏不衔接，用户报「没有做 edge-to-edge」。

真因：壳侧其实**已经**做了 `WindowCompat.setDecorFitsSystemWindows(false)`（内容确实铺到了物理底边），
但四份 `res/values*/themes.xml` 把 `android:navigationBarColor` 钉成 `@color/ds_bg`——夜色下是纯黑
`#000000`，而页面画布是 `#151517`。系统于是在最底那段涂自己的颜色。

**判据口径（本条踩过坑，务必照后面写）**：截图本身**不足以定案**。主题里
`android:windowBackground` 也是 `@color/ds_bg`，夜色同为 `#000000`，所以「最底一段纯黑且竖直
恒定」在两种假设下都成立：①系统导航条涂色；②页面没画到那一段、露出窗口底色。
本轮一度直接用截图推出「⇒ 是系统涂的条」，属过度推断，且把「截图 54px」与「模拟器 inset 63px」
并列却没给截图设备与 density，不可复算——该判据已作废。

**定案只能靠设备层 A/B（同设备、同入口，只换 APK）**。本轮实测（模拟器 Medium_Phone，
1080x2400，**420dpi**，**手势条**形态即 `navigation_mode=0` 且 overlay 为 `navbar.gestural`，
导航条 inset `frame=[0,2337][1080,2400]` 高 63px，夜色模式）：

- 改前：y2337-2399（恰为 inset 区间）三列采样恒 `(0,0,0)`；其上 y2336 是 `(10,10,11)`。
- 改后：同一区间变为 `(10,10,11)`，与页面画布一致。

这条 A/B 顺带解掉了上面的二义性：若页面本就没画到该段，改透明后那里只会露出窗口底色
`(0,0,0)`；实际变成页面画布色 `(10,10,11)` ⇒ 页面本就铺到物理底边，原色带确系系统涂的。

修法：导航条透明（`@android:color/transparent`）+ Android 10+ 关 `window.isNavigationBarContrastEnforced`
（不关的话手势条背后仍会被系统叠一层 scrim，透出来的仍不是页面色）。避让仍由壳侧下发的
`--dsh-android-system-bottom` 承担，两者互不替代。

验证口径：改四份主题任一份回 `@color/ds_bg`，`ImmersiveBottomBarContractTest` 必红（阴性对照）。
**不要**只改 values-night——四份变体（values / values-v27 / values-night / values-night-v27）都要改，
少一份就会在对应 ROM 上照旧露色带。

CDP 层交叉读数（同设备）：页面 `visualViewport.height=914.29`、`innerHeight=914`，
而 2400 / 2.625 = 914.3 ⇒ 布局视口已铺满到物理底边；`--dsh-android-system-bottom=32px`
仍正常下发。这三条与设备层像素读数互证：页面铺到底，且壳侧仍在给避让量。

354. **把「官方管理器包名」当成 Shizuku 能力的唯一事实 = 把分支实现（Stellar 等）判成「未检测到」（源码实证 + 用户报告）**：

现象：用户装的是 Shizuku 的深度定制分支 Stellar（管理器包 `roro.stellar.manager`，内置 Shizuku 兼容层），
Stellar 在跑、兼容层正常，本应用却在设置页与工具面一律报 `shizuku-absent`「未检测到 Shizuku」，
虚拟屏与特权 shell 全不可用；换成官方 Shizuku 立刻可用。用户口径：「只认 Shizuku，不认分支」。

真因：`ShizukuTransport.installed()` 用 `getPackageInfo("moe.shizuku.privileged.api")` 当事实判定，
且 `status()` 在 `installed == false` 时**先短路返回** `shizuku-absent`——同一函数第 196 行已经算出来的
`Shizuku.pingBinder()`（唯一能证明服务真的在跑的面）根本没机会被读到；`kickBind()`/`ensureBound()` 的守卫
同样按 `installed` 早退，连后台补绑都不会发生。而 Shizuku 分支实现经兼容层提供同一套 API
（pingBinder/getVersion/getUid/checkSelfPermission/requestPermission/addUserService），只是**不安装那个包名的 APK**；
`Shizuku.requestPermission()` 走 binder（api 13.1.5 `Shizuku.java`），binder 由服务端经
`moe.shizuku.api.action.BINDER_RECEIVED` 投递给客户端的 `ShizukuProvider`——两步都不依赖官方包名。

修法（0.14.8）：**能力门只看 `Shizuku.pingBinder()`（binder 连上即可用）**，包名彻底退出判据；
包名表（`ExternalLinks.SHIZUKU_MANAGER_PACKAGES`：官方 + `roro.stellar.manager`）只剩两个用途——
「把用户送到哪个管理器」（`openShizukuManager` 逐包尝试拉起）与「没连上时分流
`shizuku-absent` / `shizuku-not-running` 文案」。`ShizukuProbe` 同源。

判据（可判红）：`ExternalLinksTest.installedProbeUsesTheSharedManagerTableAndBinder`——
把判据改回官方包名裸查询、或删掉 binder 面，用例必红。

教训：**「某个包名装没装」是引导事实，不是能力事实**。能力判据要落在协议面（binder / 兼容 API 可达）上，
否则每来一个兼容实现或分支都要在代码里再登记一次，而登记永远滞后于分支的出现。

355. **Cordis 动态插件「拿到 fiber」不等于插件已经启用，失败的部分服务必须回收（Linux 宿主反证）**：

现象：只执行 `ctx.plugin(module, config)` 就报告 runtime 安装成功，会把等待依赖的 PENDING fiber 或异步初始化失败的 fiber 当成可用环境；初始化中途提供的服务也可能残留。

真因：Cordis `plugin()` 返回可等待的 fiber，调用本身只创建生命周期实例。`.await()`/thenable 完成后仍须确认 `FiberState.ACTIVE`，稳定的 PENDING 不代表已经执行插件。Context 本身也没有 `dispose()`，清理入口是所属 fiber 的 disposer。

修法：Linux pluginHost 等待真实 fiber 激活，拒绝非 ACTIVE；失败时 dispose 已创建的 fiber，显式卸载及宿主卸载同样等待 disposer。目录以 `DSH_FILES_DIR` 为根做 realpath 校验，不把外部发行资产或 `$HOME/.dsh` 当作在场事实。bootstrap/runtime 是我们自己的实验性内部插件，随应用放入内置（hard）插件目录但**默认不启用（存在 ≠ 启用）**；未启用（无 `linuxBootstrap` 服务）时 API 503 且设置入口不注册。

**0.15.0 追加（同一个坑的第二形态：把 fiber 包成普通对象会丢可等待性）**：`install` 要交出 bootstrap 要求的 `{manager}`，就得读激活作用域里的 `linuxRuntimeManager`，于是宿主把 fiber 适配成 `{state, dispose, get}` 的普通对象——普通对象**不可 await**，`await activation` 立刻返回，`state` 还在 PENDING，健康的异步 `apply()` 被误判成「did not become active」。修法：适配器保留 `ready`（承载 fiber 自身的 thenable 结算）并在 ACTIVE 判定前 await；`state` 用 getter 保持实时。适配器 `cordisScope` 由模块导出，`src/index.ts` 与单测共用同一份，避免「宿主能读到服务、测试读不到」的两侧漂移。

复验证据：`plugins/dsh-android-linux-env/test/linux-environment.test.mjs` 用真实 Cordis 跑异步服务提供/卸载，另注入启动异常和缺依赖反证，断言失败不能留下部分服务；在场用例覆盖平铺/版本化布局、越级目录名、外逃符号链接，以及「先激活 → 手工移除 → 在场转 false 且 install 失败关闭、运行中 scope 不被写回」这条不复活链。`install` 无 manager 时报 bootstrap 原文错误、`rollback` 释放作用域、以及「只有 install/uninstall 齐全才算 manager」各有用例。`settings.section` 的归属反证：`dsh-client-ui-slots` 对 list 槽重复 id 抛错，故壳侧同名分区已于 0.15.0 撤回（见 modules.md），未启用时无入口。

356. **引擎侧（Node/Cordis）没有反向通道调用壳侧 Kotlin —— 「让宿主提供原语」必须走客户端或新队列（Linux 资产 IO 实证）**：

现象：设计「引擎侧 bootstrap 需要宿主做下载/解包」时，直觉是「插件直接调 Kotlin 桥方法」。实际结构不支持这个方向：壳侧是**客户端**，长轮询引擎的 `/api/android/ui/pending`（`ControlPoller.kt:48` `BASE = http://127.0.0.1:3080`、`:101-113` 取 `{reqId,op,args}` 执行、`:138` 回投 `/api/android/ui/result`），路由由引擎侧 `registerControlRoutes` 注册（`plugins/dsh-android-bridge/src/control-queue.ts:345-369`）。`app/src/main` 全树**没有** `ServerSocket`/`HttpServer`，唯一直连是 WebView 的 `@JavascriptInterface`。

真因：那条队列**就是设备控制队列**，其策略要求 `danger-full-access`（`control-policy.ts:68`，`:84-87` 以「会话档位为 X，设备控制面要求 danger-full-access」拒绝）。把 Linux 资产下载挂上去 = 「装 Linux 必须先开设备控制档」，与用户「Linux 不是沙箱、不要只靠 danger-full-access」的要求相悖；而 `dsh-android-bridge` 对外只 `provide('androidPrivilege')`（`index.ts:1608`），没有任何「入队」可给第三方插件用。

修法：字节获取走**客户端触发**（页面 `@JavascriptInterface` → 宿主下载/校验/解包），不新增引擎→壳能力、不动镜像面的 `ControlProtocolV2.SUPPORTED_OPS` / `ControlOp`。另一条路（新增一条**非门禁**的资产队列）会引入一个「任何能访问引擎 localhost 的东西都可调用」的新特权原语，得不偿失。

复验证据：`app/src/test/java/com/dsharnessmobile/shell/LinuxAssetIOTest.kt`、`LinuxAssetPrepareTest.kt`（16 例）：来源面（http/非白名单主机/跨仓/latest 非版本化/带 query/多一段路径全部判红）、落点面（绝对路径/`..`/NUL）、摘要与字节数各自的负控、穿越与符号链接逃逸的「不得落地」断言、解压炸弹（条目数/单文件）判红、以及环境不在场/来源不合规时**在起线程之前**拒绝（连网络都不触达）。

357. **会话标题跑马灯的 scroll 会误取消长按拖动**：

现象：长标题会话长按后没有蓝色侧开接收区，短标题却能触发。CDP 事件轨迹显示，手指静止时标题后代连续发送 scroll，400ms 长按尚未达成就被清掉。

真因：侧栏拖动在 document capture 上把所有 scroll 都当成列表滚动。标题 hover 跑马灯也会横向滚动，其事件经同一路径到达，造成误取消。

修法：只在源行祖先容器实际滚动时取消待激活长按；忽略源行及后代的标题滚动。侧开落点先捕获会话身份，再结算排序，避免排序收尾重建节点后丢失打开动作。退出及卸载清除蓝区和动效计时器。

复验证据：`dsh-client-ui-responsive/tests/conversation-dock.spec.ts` 同时覆盖标题滚动不取消、祖先滚动取消、排序收尾移除源节点仍准确打开、提前删除源节点不打开。设备轨迹与热推结论见本轮 PR。

358. **旧 WebView 将自定义协议 URL 当作无 host 路径，子代理原生侧开被拒**：

现象：`new URL('dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=continuable')` 在设备上给出空 hostname，pathname 带 `//subagentchat/`；原生 `subagentchat` 类型据此拒绝有效地址。模拟器上的普通侧开按钮也可复现。

修法：新增对话拖动入口使用自身的 conversation 资源格式，以明确前缀、编码后的路径和 URLSearchParams 解析直接父子地址，不依赖自定义协议的 hostname。子代理身份来自运行时目录，完整核对弹窗行序、层级和标签；身份不一致则不打开。保留原生子代理提供方，避免修改全局 URL 或服务方法。

触摸还须在长按前对会话与子代理行禁止原生文字选择及 HTML drag，否则 WebView 先发 touchcancel，JS 的 dragstart 拦截会来不及。只在 coarse pointer 下禁用这些原生行为，桌面鼠标原有排序不受影响。

复验证据：`dsh-client-ui-responsive/tests/conversation-dock.spec.ts` 覆盖同名条目、目录漂移、父子路由与引用隔离；设备证据与运行树哈希见本轮 PR。


359. **原生管理页不可把配置脱敏结果当完整替换文档**：`settings/describe` 会省略敏感值；把这份 user 对象交给 `settings/replace` 会重建可编辑配置并丢失未回填字段。原生页面改用 `settings/mutate` 按字段合并保存，携带 `expectedRevision`；密码框留空不提交。插件启停的 `ChangeResult.application=failed` 也不保证磁盘未变，必须重新读取状态。停用前后比较完整运行清单，发现其他 active 插件失活则补偿目标状态并核验恢复。测试见 `PluginManagementRepositoryTest.kt`，设备范围见本轮开发报告。

360. **插件库存 ID 与 Hard 清单 ID 不在同一层**：真实 `pluginManager/listPlugins` 返回 `include:<profile id>`，受保护条目可能没有 `patchId`；Hard manifest 保存配置 ID。直接比较库存 entryId 会漏掉过滤。本轮设备返回 197 个条目，按当前清单映射后命中 192 个 Hard 条目。仓储按 exact moduleName 加 profile ID（可信 patchId 或根 include 路径）匹配，启停入口也独立复核；禁止只在 UI 按名称或目录过滤。回归测试包含没有 patchId 的真实树前缀反证。

361. **齿轮点击矩形波纹与切页端点跳位**：通用 `DsUi.ripple` 只复制 cornerRadius，传 oval 时 mask 仍是矩形；原生管理齿轮改用独立 oval mask，并只旋转 RotateDrawable。原切页按目的页交换两个加权内容区，动画端点又根据进度隐藏目标内容区，导致同一帧无 View 占满剩余高度，底部操作区跳到顶部。两页改为单个稳定加权 FrameLayout 内切换，操作区不参与内容切换测量。构建与回归证据见 `.deploy-tmp/management-ui/gradle-gear-fix.log` 及同目录 `gear-fix-*.png`。
362. **引擎的 V8 堆此前无人管理：没人设过上限，它只由设备物理内存推导——小内存设备可能推出连 boot 都撑不住的值（本轮实修，L3）**：

现象：社区反馈「因为 Node 进程的 JavaScript 堆太小而导致引擎启动失败」。反馈者未提供诊断包（自行修完后才说），故**没有第一手现场**。

真因（源码级确证，非猜测）：全链路**没有任何一处为引擎设定 V8 老生代上限**——
① 引擎 argv（`EngineManager.startWithArgs` 的 `val args = arrayOf(nodeBin…, "--expose-internals", dshBin…, "web", …)`）没有堆标志；
② `shellEnv()` 注入的 20 余个变量里没有 `NODE_OPTIONS`；
③ profile（`scripts/profile-web.cordis.patch.yml`）也没有。
于是 `heap_size_limit` 完全由 V8 按物理内存推导。**实测口径**（逐档回读 `v8.getHeapStatistics().heap_size_limit`）：
6GB 设备 1120MB / 4GB 设备 1075MB / 3GB 设备 844MB；设 `--max-old-space-size=N` 则恒为 **N+96MB**（512 到 608、256 到 352、2048 到 2144）；
**引擎最小可用堆约 70MB**（64MB 起步在约 21s 内 `FATAL ERROR: Reached heap limit`）。树里那个 `512` 是 **PTC 子进程专用**（patch A1/L1 走 `NODE_OPTIONS`），与引擎本体无关——这正是「看起来有人管、其实没人管」的误导来源。
**未证实**（如实登记）：到底**是谁**在反馈那台设备上把堆压小的，仍无直接证据；候选是未知的显式注入 / 用户自起引擎 / 小内存推导。本修法不依赖该答案——它把「没人管」变成「有下限兜住」。

修法（两个注入点，必须是同一个 clamp 区间 `clamp(总内存/2, 512, 1024)MB`）：
① **壳侧**：`shellEnv()` 注入 `NODE_OPTIONS=--max-old-space-size=<engineHeapMb(deviceTotalRamMb())>`。用 `NODE_OPTIONS` 而不是 argv，因为**argv 会覆盖 NODE_OPTIONS**（实测 argv 2048 + env 512 得 2240），二者表达同一件事必冲突；
② **快照内启动器**：`usr/libexec/dsh-node`（C1 wrapper）在 `NODE_OPTIONS` **未设置**时按设备 `/proc/meminfo` 自适应填同一个区间。为什么必须双源：有些调用方给子进程的是**过滤后的 env**（PTC 只放 6 个名字），壳侧注入到不了那条路径。启动器必须**不覆盖**调用方显式给的值（PTC 的 `maxOldGenerationSizeMb` / 用户自定义优先）。

**诊断面的同型缺陷（本次一并修）**：`describeEngineLogState()` 此前只报 `firstLine`（首个非空行），而真实的堆 FATAL **不是首行**——本轮设备实测捕获的输出里它是**第 6 行**（前面是 4 行 GC 统计 + 空行）。
后果：一次堆 OOM 在 `boot-fail.log` 里显示成一句无害的开场白，真因彻底不可见（与「兜底码丢真因」同族）。现新增独立 `heapOom=` 字段（与 `firstLine` **并存**，仅在真出现时写）。
判据按「FATAL 级 + 堆语义」而非逐条枚举原句——枚举会随 V8 版本过时：本轮测试**当场抓到**漏了 `MarkCompactCollector: young object promotion failed` 一族（该行不含 `heap` 字样）。
另在 boot-segments 的 `note=boot-start` 行追加 `engineHeapMb=`，让「这次到底给了多大堆」第一次成为可核对事实（此前任何诊断面都取不到）。

判据与门禁：`scripts/check-engine-heap-floor.mjs`（已进 `check-release-gates.mjs` 声明集合，本地链 / 云端链 / apk CI 三处接线，静态接线断言核过）。
它断言：壳侧两常量在场且为正、取值走 clamp 而非裸除法、读不到内存退回下限、启动器真读 meminfo 且除数为 2048（KB 转一半 MB）、**双源上下限逐值相等**、启动器不覆盖已设值、argv 不含堆标志。
`--self-test` = 1 正样本 + **8 条受控负控**（删下限 / 去 clamp / 去自适应 / 上下限分叉 / 除数改坏 / 无条件覆盖 / argv 混标志 / 上限分叉），逐条证明仍会判红。
JVM 边界测试在 `EngineBootInstrumentationTest`（取值与 clamp 边界、退化输入不得逃出下限、标志格式可被 parseInt）；源码扫描接线在 `W3ShellContractTest`（函数写得对但没接进 `shellEnv()` 即判红，防「能力在、入口无」）。

**设备实测证据（本轮）**：模拟器 Android 16 上真实复现并捕获堆 OOM 原文（`--max-old-space-size=64`），该真实多行输出已固化为回归用例 `heapExhaustionIsDetectedOnRealCapturedV8OutputWhereFatalIsNotTheFirstLine`——覆盖「真实 FATAL 不在首行」这一关键形态，而不是只测构造的简写。
启动器算术在设备上用合成 MemTotal 逐档对照 Kotlin 口径，12 档（256MB 到 16GB）**逐值一致、0 处不符**；显式预设 `NODE_OPTIONS` 时启动器确实不覆盖。
**未覆盖（不记通过）**：未在真机（arm64 / Enforcing）验证；未验证「堆下限真的让某台小内存设备从起不来变成起得来」（手头模拟器均 ≥3GB，自然推导值本就高于下限）——该因果只能由反馈设备的复现来确认，本轮给出的是「下限已被显式兜住」与「诊断面能看见堆 OOM」两条。

**2026-10-19 吸收参考仓 #414 后的修正**（源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`）：首轮的 `ENGINE_HEAP_CAP_MB=1024` 恰等于复现 V8 自然推导 `heap_size_limit≈1120MB` 所需的 `--max-old-space-size=1024` 标志值（实测 N→N+96MB）。所以所有 ≥2GB 设备的 `totalRam/2` 都被截成 1024，下限仅在 <1GB 才可能到达；函数表面自适应，真实设备结果却恒为自然上限。原先“堆开成多 GB 会被 lmkd 杀掉”的判断不成立：V8 老生代上限是天花板而非预分配，`lmkd` 按进程真实 RSS 回收；但本仓仍要求设备观察长任务峰值和系统回收，不能以机制说明代替验收。

修法：上限与快照 wrapper 同步提升为 4096，保持 `clamp(totalRam/2, 512, 4096)`；增加 `ENGINE_HEAP_NATURAL_MAX_FLAG_MB=1024` 唯一真源。门禁 F 要求 cap 严格大于自然标志值且区间宽度至少 1024MB；负控覆盖双源一致但都为 1024 的原缺陷形态。`EngineBootInstrumentationTest` 新增 1/2/3/4/6GB 现实档不退化为恒定上限的断言。设备级压力证据仍开放，详见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 与 [known-gaps.md](known-gaps.md)。
**同轮踩到的两个既存问题（都不是本次改动引入，一并如实登记）**：
① `ptc-node-wrapper-c1.test.mjs` 的「带可执行位」判据把 `writeFileSync(...)` 与 `{ mode: 0o755 }` 之间的窗口写死为 400 字符——wrapper 内容一长（本次加了堆下限段）就**假红**。已把窗口放宽到 2000 并补三条锁新行为的判据（未设时才填、自适应 clamp、落在 `exec` 之前）。教训：这类「窗口长度」是恒定量，本质是在断言「实现必须短」，与真正要守的语义（同一个 `writeFileSync` 落了 755）无关。
② `combo-probe-p1.test.mjs` 的「重复 phase 记录聚合到固定阶段行」判据把行数上界**写死成常量 `<= 2`**，实际是在断言「这段洪水必须在 2 个窗口（500ms）内跑完」——而窗口本身是 250ms（`dshMobileComboProbePhaseWindowMs`），16 轮 × 25ms 的 sleep 加上每轮构造的真实开销必然落在多个窗口里（本机实测稳定 3 行：窗口起点 531.6 / 798.4 / 1086.4ms，共约 1.1s）。机器一慢或构造一变重就假红；且**纯净 `origin/main` 上同样判红**（用 detached worktree 复现确认），是 `check-patch-test-manifest.mjs` 的未声明失败来源，会随机卡住本地全链构建。
   修法：断言的应是**被守着的不变量，不是这台机器的速度**。改为按实测耗时算窗口上界（`ceil(elapsedMs/250)+1`）并要求 `行数 < 轮数`——后者才是「聚合」的判据（退化成事件级 push 时 16 轮会产出 16 行）。受控负控已验证：把窗口改成 1ms（等价于每事件一行）时新判据判红（`constructorRows=16 rounds=16`），证明它没有变成恒绿。修后连跑 5 次全部通过（修前 5 次红 3 次）。

364. **Shizuku 的 remove=true 不会清 SDK 连接缓存，超时只清本地记账会反复卡在建链中（2026-10-17）**：授权后一直显示建立通道，重置也可能被旧回调打回未连接。固定依赖 API 13.1.5 的实际字节确认：`unbindUserService(remove=true)` 仅移除远端服务；只有 `remove=false` 才清理应用内的连接集合与缓存。旧实现复用一个 ServiceConnection，后台注册又与主线程回调并发，超时也没有移除远端坏实例。修法：SDK 生命周期统一排入主线程；先注销缓存，再按需移除远端；每次绑定独立回调、latch 与 generation，重置/超时后的迟到回调无效。状态机回归覆盖旧连接、旧断连、旧异常与重复回调；设备与 CI 证据随本次 PR 记录。


365. **自动合并不会发现新文件对本分支退役功能的引用（2026-10-17 上游同步）**：管理中心新文件直接引用 `updateButton`、`apkUpdate`、`GuidePhase.Updating`，Git 自动合并没有代码冲突，但 Kotlin 编译实际失败。根因是上游保留应用内更新，本分支已整体退役。删除新文件中的更新入口和状态引用，保留插件、存储及控制台功能；不能用复活控制器的方式凑编译。编译与测试日志在 `.deploy-tmp/upstream-20261017/kotlin-final.log`，设备未验，范围见 SECURITY-HARDENING.md 本轮复核。

366. **Linux 插件总字节数不能证明代码完整性，错误回执不能释放他人的任务（2026-10-17）**

**现象与真因**：上游 3f86a85 的 bootstrap 复用只比较 unpackedSize、包名和入口；宿主直取路径虽验证归档摘要，实际执行的却是另一棵可写解包树。把 `() => {}` 等长改成 `() => 42`，重新安装仍会激活篡改内容。另外 HTTP 层消费 confirmed 后未传递真实 bootstrap 所需 confirmed/activate，三个操作均 500；Kotlin 在 busy 检查前让无效清单调用 finish，A 有效、B 无效、C 有效时能排入两个 worker，争抢同一暂存目录。

**修法**：每次复制宿主归档、验 SHA-256 与长度、进程内独立 XZ/tar 解码到新 staging，再校验包结构与展开体量后交换；不使用宿主解包树，不复用大小标记。拒绝穿越、重复路径、链接及特殊文件，保留正常文件权限并清除特殊权限位。HTTP 向真实执行端传确认参数。Kotlin 无效请求只返回自身错误，任务代次在锁内领取，成功/异常/调度拒绝只提交自己的结果。vendored 原始来源身份保留，本地安全偏差单列哈希登记，不冒充上游原样。

**代码层证据**（`.deploy-tmp/linux-security-fix/`）：Linux-env 61 项全过，包含真实 USTAR/XZ、等长篡改缓存、篡改宿主树、真实 bootstrap 的 HTTP 安装/重装/卸载、未确认拒绝及不安全归档；旧完整性实现使两条等长反证判红，撤掉确认参数使真实路由用例判红（negative-summary.log、negative-integrity.log、negative-confirmation.log）。WSL Java 17 全量 Kotlin 119 类/1305 项，失败/错误/跳过均为 0；LinuxAssetPrepareTest 从 10 提升到 14，新增无效请求不释放 busy、调度/工作异常收敛及陈旧完成拒绝。日志 kotlin-tests.log。

**边界**：未做设备验证；ADB 无设备，两模拟器均 connection refused（adb.log）。本轮未构建 APK、未执行 CDP/ADB 自主任务，不宣称完成 L2/L3 三层关闭。bootstrap 的注入和页面调用者缺口不因源码修复而关闭；来源链候选还须核对新增依赖及许可资产。此修复不提供对任意同 UID 恶意进程并发替换 staging 的通用沙箱保证。

367. **历史日志文件名不能授权递归删除目录（2026-10-17）**

现象：`/api/android/runtime-cache/execute` 在服务端重新扫描后执行清理，`scanTargets` 对 `engine.log.1..32` 只检查存在性，`measure` 接受目录，执行端再按文件名通过白名单后调用通用 `removeTree`。因此只需日志槽变成目录，目录内任意内容就会被递归删除；扫描后把普通日志换成目录同样可触发。需要具备日志根写权限或出现错误的目录落点，并非已证实外部应用可无权限触发。

修法：扫描与执行都用 lstat 限定普通文件，目录、链接及特殊文件跳过为 `not-regular-file`；默认日志删除只调用 unlink，不调用递归删除器，即使类型检查后变成目录，也只能删除失败，不能下探。真正的编译缓存仍走原目录清理路径。源码与本地忽略的 lib 构建产物已同步，不改变插件声明与版本。

证据：`npm.cmd --prefix plugins/dsh-android-linux-env run build` 通过；WSL `node --test plugins/dsh-android-linux-env/test/*.test.mjs` 63 项通过，日志 `.deploy-tmp/cache-security-wsl-tests.log`。两条新增用例检查目录内容逐字节保留、普通历史日志仍删除；把 HEAD 旧源码经 TypeScript 转译后替换测试导入，运行 `node --test --test-name-pattern="log-looking|execution rechecks" .deploy-tmp/cache-security/negative.test.mjs`，2 项均失败（`.deploy-tmp/cache-security/negative.log`）。执行地图门禁通过。Windows 全套 57 通过、6 项资产安装在目录 rename 报 EPERM，记录于 `.deploy-tmp/cache-security-tests.log`，不能当成全绿；同批在 WSL 全过。

边界：未构建 APK、未做设备验证。当前 PowerShell 找不到 adb，WSL 的 PATH 与常用安装位置也未找到；未执行 CDP/ADB 用户任务。数据删除行为尚未完成设备验收，不能随候选发布。此修复不提供同 UID 恶意进程并发替换缓存树、日志父目录或普通文件内容的通用隔离保证。

368. **本地自定义槽漏登记会在来源构建末段被契约门禁阻断（2026-10-17）**

CI 39011926728（9bf4ed4）在 `check-contract.mjs` 仅报一条失败：`android.dock.conversation` 已注入却未登记。该槽由本地 `conversation-dock.tsx` 的 SlotMap 和父槽 children 声明，为 single/session，不是上游新增槽。只把名称加入 slots 虽能消除该次错误，却不能验证它的声明语义；把它写进 upstreamUniverse 则会伪造上游事实。

修法：登记真实消费名与声明，declarations 可显式指定本地 repo；默认仍检查 upstreamRepo。本地声明文件缺席直接失败，不变成可跳过的上游缺件；增加 scope 漂移、声明文件缺席两条受控负控，上游全集保持不变。

本机验证：旧 `.deploy-tmp/deepseek-harness` 是 0.1.7-rc.2，与固定基线不符，首次全量自检失败，未改该历史树。隔离测试目录复用真实插件源码和构建产物，显式缺席上游树；`node .deploy-tmp/ci-contract-workspace/scripts/check-contract.mjs --self-test` 为 11 例通过、11 例未执行（不计自证），包含本次两条负控和消费面正反例，日志 `.deploy-tmp/ci-contract-isolated-selftest.log`。vdisplay 真实构建及执行地图检查通过。本轮未做设备验证；未改 UI 运行时行为。完整固定上游与来源链结果须以修复提交后的 CI 为准，旧失败日志为 `.deploy-tmp/ci-39011926728-failed.log`。

369. **来件内容校验后异步重开路径可读取被替换的工作区外文件（2026-10-17）**

现象：`/api/android/file-incoming/content` 经 ticket 鉴权后，先 realpath 包含检查和 stat，再发响应头，最后 `createReadStream(path)` 异步打开。持有工作区写权限的进程若在校验与 open 之间替换叶文件或父目录，实际打开对象就不再受先前检查约束。此为有合法 ticket、且能够替换工作区路径条件下的越界读取，不是无鉴权远程入口。

修法：先以 O_NOFOLLOW、O_NONBLOCK 打开文件，用 fstat 拒绝非普通文件；Linux/Android 经 `/proc/self/fd/<fd>` 检查实际持有对象的真实工作区归属，再核对 dev/ino。响应大小取自该 FD，createReadStream 复用该 FD，不再异步按路径重开。处理器在成功、拒绝及响应异常时负责关闭 FD。其他平台使用 canonical 路径与 dev/ino 复核，不能将其证据扩大为 Linux 的 `/proc` 保证。源码与忽略的 lib 产物已重建同步。

证据：插件 TypeScript 构建通过。WSL `node --test plugins/dsh-android-file-open/test/auth.test.mjs` 23 项通过，日志 `.deploy-tmp/incoming-security-tests.log`。真实路由的响应头边界分别替换叶文件和父目录，仍只收到已准入的 ADMITTED 字节；在真实 openSync 之前替换父目录时返回 410，不返回 SECRET!!，成功与拒绝均断言 FD 计数不变。将 0904c52 的旧生产源码转译后替换测试模块导入，同两条读取反例 0 通过、2 失败，实际都收到 SECRET!!，见 `.deploy-tmp/incoming-security/negative.log`；临时旧模块在反证后已从插件 lib 删除，避免进入产物。执行地图与 API 鉴权登记门禁通过。

边界：未构建包含此修复的 APK、未做设备验证。当前 PowerShell 无 adb 命令，ANDROID_HOME/ANDROID_SDK_ROOT 未配置，未执行 CDP/ADB 用户任务；Android SELinux 下 FD 路径可见性、普通下载及前端附件交互仍待验收。新竞态用例在非 Linux 主机显式跳过。此修复不阻止同 UID 进程改写同一已打开 inode 的内容，也不提供对硬链接或工作区根被恶意重新定义的通用隔离保证。

370. **临时文件所有权不能跟随叶链接，也不能授权递归清理或元数据删除（2026-10-17）**

现象：来件 `/clean` 对清单路径做 realpath 后直接递归 rm。真实 POST 投递并记账后，把临时文件换成指向工作区内用户笔记的链接，clean 实际删除笔记；换成目录则连其用户内容一起删除。另外只豁免 basename 为 .sessions 的路径，队列内部文件、.meta.ndjson 和 .pending-notify.ndjson 仍可被清单驱动删除。触发需要合法清理请求及工作区写权限，未证明外部应用可无权限触发。

修法：只 canonical 化工作区根与待删项父目录，要求二者相同；宿主 copyIn 仅创建工作区顶层文件，嵌套项不授权删除。叶项经 lstat 必须为普通文件，排除 .sessions、.meta.ndjson、.pending-notify.ndjson、.tool-temp.ndjson；默认 unlink 而非递归 rm，即使类型检查后被换成目录也只能失败，不能下探。拒绝和失败的清单项保留，正常项仍删除；Android canonical/别名前缀兼容回归继续通过。

证据：TypeScript 构建通过；WSL `node --test plugins/dsh-android-file-open/test/auth.test.mjs` 26 项通过，日志 `.deploy-tmp/incoming-clean-tests.log`。新增用例经真实投递和清理 handler 核验目录内容、链接目标及元数据逐字节保留，同时断言正常临时文件确被删除。以 a7782c9 的旧生产源码转译运行相同三条反例，0 通过、3 失败：目录 note.txt 与链接目标 user-note.txt 均 ENOENT，元数据反例旧实现删除 5 项而应仅 1 项，日志 `.deploy-tmp/incoming-clean-security/negative.log`。反证用旧模块已从 lib 删除；生产源码/lib 已重建同步。执行地图与 API 鉴权登记门禁通过。

边界：未构建 APK、未做设备验证，当前无可用 adb 命令，CDP/ADB 用户任务未执行，不计为设备验收关闭。仅对顶层叶项授权收紧；它不证明清单内容可信，也不提供针对同 UID 进程替换工作区根、写入清单或将普通临时文件换成另一普通 inode 的通用隔离。

371. **草稿发布哈希清单不能遗漏实际上传的资产（2026-10-17）**

现象：写权限任务执行 sha256sum --check SHA256SUMS.txt 后，以 ./*.apk 上传。清单只验证列出的文件；同次下载目录若夹带未列出的额外 APK，校验仍成功，该 APK 仍被上传。类似地，漏掉已有资产的校验行也不会失败。触发需要能影响传入草稿任务的资产集或清单；未证明外部未授权用户能修改同 run artifact，也未实际创建远程草稿。

修法：在哈希检查与 gh 调用前验证整个目录。只允许一个符合来源 ARM64 命名的 APK、provenance.zip、notes.md、SHA256SUMS.txt，拒绝链接和非普通文件；清单限定小写 SHA256 与无目录的文件名，必须覆盖前三个资产各一次。资产集合、清单覆盖与字节校验依次执行，任一失败不调用 gh。它防止独立写权限任务因输入集合异常而上传未校验资产，不保证受控上游同时改写资产与摘要时仍能独立认证来源。

证据：WSL 运行生产 workflow 中原样提取的发布 shell，仅将 gh 换成本地参数记录器。旧 shell 的额外 injected.apk 反例返回 0，拒绝断言失败，见 .deploy-tmp/release-asset-boundary/negative.log。修后 python3 -m unittest discover -s scripts/source-build -p 'test_*.py' -v 为 8 项通过，含正常 draft/prerelease、额外 APK、清单漏项、重复项、外部路径和字节篡改检查；node --test scripts/source-build/cloud-workflow.test.mjs 为 6 项通过，日志分别为同目录 tests.log、workflow.log。

边界：未构建 APK、未做设备验证，未运行云端发布。此次只修改发布资产校验，不修改 Android 或 runtime；不把宿主 shell 证据算作 CDP/ADB 或最终候选验收。起初排查的打包目录自身/祖先链接边界未在此项修复中覆盖，未证明其在全新 CI 工作目录中可被攻击者控制。

372. **主 WebView 的外部导航不能直接变成任意 ACTION_VIEW（2026-10-17）**

现象与根因：主 frame 的非引擎地址直接交给系统，缺少手势与协议约束；脚本导航可拉起其他应用，自定义协议扩大了页面影响面。修法：主 WebView 传入 hasGesture，DownloadSaver 在执行出口复查 HTTP(S)、host、端口、userinfo 和歧义字符，Intent 限 BROWSABLE。Kotlin 策略 3/3 及主/测试源码编译通过；未做设备验证，重定向手势兼容仍待三层验收。完整生产路径、条件与证据见 [本轮审计记录](SECURITY-AUDIT-2026-10-17.md)。

373. **GitHub 发现响应不能先读全文再校验（2026-10-17）**

现象与根因：linux bootstrap 的 release JSON 与 manifest 使用无界全文读取且无响应体超时，异常上游可占用内存及串行队列。修法：流式计算实际解码字节、限制元数据体量、请求含 body 设期限并取消；生产正反证、23 项宿主回归及默认未挂载边界见 [本轮审计记录](SECURITY-AUDIT-2026-10-17.md)。未做设备验证，不把未启用 bootstrap 说成默认可达漏洞。

374. **加密备份解密不能使用可预测的相邻临时文件（2026-10-17）**

现象：导入覆盖并删除相邻文件，预置链接可写穿到其他文件。真因：以输入路径拼接 .dec.tmp 并直接 writeFile，明文落在不受信目录；普通导入还二次打开已经查过的路径。修法：readZip 接受 Buffer，直接解析同一次读取/解密的字节，取消临时明文及二次读取。Linux 5 项通过；旧 core 3 项失败，含真实链接覆盖。证据与首次读取/资源限制边界见 [本轮审计记录](SECURITY-AUDIT-2026-10-17.md)。未做设备验证。

375. **版本标签不能固定 CI 外部代码身份（2026-10-17）**

真因：actions 的 @vN 标签可在本仓审查后重新指向，影响来源构建及持写 token 的发布任务。修法：四个 workflow 固定外部 action 的官方完整 commit，新增固定引用门禁与受控可变 ref 负控并接入生产预检；Node 来源套件 98 项、Python 8 项通过。此项是供应链防护，不是已证实的上游入侵；信任边界与日志见 [本轮审计记录](SECURITY-AUDIT-2026-10-17.md)。未做设备验证。

<!-- 以下 376-392 为 2026-10-17 晚第二轮挖掘的登记项：用户明确要求「先不修，先记到项目文档」。
     因此没有修法、没有新增回归用例；证据等级与未证边界逐条写在
     [第二轮审计](SECURITY-AUDIT-2026-10-17-R2.md) 同名条目里。 -->

376. **「用户拥有」的授权状态本身在 app-uid 可写文件里，模型自带 bash 可直接改写（2026-10-17 登记；后续修复见修复账本）**

现象：屏幕范围（`ScreenScope.kt:52-66` 的 `dsh_screen_scope`/`scope`）、AI root 同意与开关（`RootGrant.kt:63-73/160-185` 的 `dsh_root_grant`）、应用 su 授权态（`RootAccess.kt:55-57` 的 `dsh_root_access`）都是普通 SharedPreferences，无 MAC/签名；唯一执行门 `ShizukuTransport.rootGateRefusal`（`ShizukuTransport.kt:987-995`）只查 `RootGrant.isGranted`。引擎由壳以同一 app uid spawn（`EngineManager.kt:1462`、`:2287-2341`），README:16 明写「能真实执行 bash」，因此模型可写 `$DSH_FILES_DIR/../shared_prefs/*.xml` 伪造 `granted=true`/`consentRevision=1`/`scope=all`。边界：prefs 进程内缓存，需在首次读取前写入或让壳进程重启（`EngineService` 是 START_STICKY）；未做设备验证。详见 [R2 审计 376](SECURITY-AUDIT-2026-10-17-R2.md)。

377. **桥面「用户专属」写方法没有用户在场证明，第三方客户端插件与页面同源（2026-10-17 登记；后续修复见修复账本）**

现象：`setScreenScope`（`AndroidBridge.kt:343-349` → `MainActivity.kt:1208` 直接写 pref）、`setRootConsent`（`:508-518`）、`setRootGranted`（`:497-506`）、`unlockRestrictedSettings`（`:445-447`）都没有前台/焦点校验、没有一次性手势 token；唯一门是 `MainFrameBridge` 的顶层同源判断（`MainFrameBridge.kt:96-119`），而 BRIDGE-API.md:21 自述「不承诺隔离同源任意脚本」。与 380 成链：无确认安装的市场插件，其 client 脚本可在引擎页静默勾同意、开 root 开关、改屏幕范围。未做设备验证。

378. **3080 中继的 32 个槽位无鉴权，本地任意应用可占满并阻断 WebView→引擎（2026-10-17 登记；后续修复见修复账本）**

真因：`EngineTransport.kt:18` 全局 `Semaphore(32)`，`:78` 拿不到槽位就 `client.close()`；TCP 接入没有 uid 校验（350/352 修的是 Unix socket 侧与监听者冒充），单连接 60s 空闲超时还会被任意字节续期（`:101-116`）。本地零权限应用开 32 条连接即可让第 33 条（WebView 自己）被关掉。属可用性缺陷，无提权/泄露；未在设备复现。

379. **通知审批/提问动作可被任意通知监听应用代按（2026-10-17 登记；后续修复见修复账本）**

现象：审批与提问的作答动作是 `PendingIntent`（`NotifyCenter.kt:1155-1166`、`:1231-1249`），任何持有通知访问权限的应用可从 `StatusBarNotification` 取到并 `send`；回复动作刻意 `FLAG_MUTABLE`（`:1191-1203`），可改写 `dsh.reply` 文本代答；`APPROVAL_REQUIRE_UNLOCK = false`（`:88-89`）且未调用 `setAuthenticationRequired`，锁屏亦可触发。`exported=false` 对 PendingIntent 不构成限制。未做设备验证。

380. **市场安装把「是否需要用户确认」交给远端 riskFlags，空标记即无确认安装（2026-10-17 登记；后续修复见修复账本）**

真因：`dshmarketplace-plugin`（`scripts/plugin-dirs.json:17`、`profile-web.cordis.patch.yml:52-53` 默认注入）的 `tools/pre-execute` 钩子只在 `riskFlags.length>0` 时返回 `{kind:"ask"}`，其余落到 `{kind:"allow"}`（`vendor/dshmarketplace-plugin/lib/index.js` 的 `y`/`M`/`b`）；安装执行 `dsh plugin add`，目标支持 `github:<owner>/<repo>`。远端目录因此是唯一判据，模型可在无用户确认下安装任意插件（引擎进程内 app uid 代码执行）。未实际调用市场工具。

381. **Linux 运行时代码的信任锚是第三方仓 latest Release（2026-10-17 登记；后续修复见修复账本）**

真因：默认 `https://github.com/kelai141/dsh-bionilux/releases/latest`（`linux-host-asset-io.ts:167`），壳侧只认该仓资产路径（`LinuxAssetIO.kt:66-74`），bootstrap 从**同一份** `linux-release.json` 取 `sha256` 再校验（`github.js:80-96`、`asset-bundle.js:37-92`）——摘要不是 APK 内固定值也不是独立签名。默认不启用（`environmentVerdict` 要求状态文件在场），启用后即把 app uid 的代码执行权交给该仓发布权限。详见 [R2 审计 381](SECURITY-AUDIT-2026-10-17-R2.md)。

382. **model-capability 的响应体没有字节上限（2026-10-17 登记；后续修复见修复账本）**

真因：`index.ts:743-748`（models.dev，启动期刷新）、`capability-probe.ts:403-409/541-547/579-585` 都是 `await response.text()` 后再解析，没有流式计数；唯一的尺寸门在 `models-dev.ts:333-338`，是读完之后才量。对照坑 373 已把 bootstrap 发现改成有界流式。影响：恶意/异常网关或 models.dev 源可让引擎 OOM；models.dev 在启动期刷新，超大响应会变成启动即崩。未构造大响应测试。

383. **未鉴权的 `GET /api/android/privilege/status` 会触发一次特权控制队列占用（2026-10-17 登记；后续修复见修复账本）**

真因：`plugins/dsh-android-bridge/src/index.ts:1917-1933` 用 `authorizePublicReadOnlyRoute`（401 放行），但 handler 在回包前 `await svc.shizukuChannelProbed()`（`:1930`）→ `controlExec('vdInfo')`（`:701-713`），占的是与模型设备工具共用的单槽队列（`control-queue.ts:141-144`）。登记表 rationale 写「no mutation route」，与实际副作用不符（`scripts/api-route-auth-policy.json`）。每 10s 一次即可让设备工具随机报「已有在途」。可达性依赖 350/352 后的中继仍转发本地连接（源码上是转发的）；未设备压测。

384. **ADBKeyboard 的 auth nonce 未加引号拼进 uid 2000 命令（2026-10-17 登记；后续修复见修复账本）**

真因：`plugins/dsh-android-manage/src/index.ts:44#expect=*%2F` 的 ` --es auth '${nonce}'` 未做引号转义（同函数对 `msg` 做了 `'` 转义，`:2006`/`:2029`）。nonce 正常是纯十六进制，属防御纵深缺口：同 uid 写坏 `adb-keyboard-nonce` 后，`android_ui_input` 的 uid 2000 命令可在单引号处断出。增量能力有限（模型本就有 `android_shell_exec`），但「输入文本」变 shell 应登记。

385. **最终快照与源码没有字节级绑定（2026-10-17 登记；后续修复见修复账本）**

真因：`check-dsh-source-snapshot.mjs:105-120` 只验快照内 `package.json` 的 name/version，再哈希**缓存里的 tarball**，从不比快照内实际运行的 JS 字节；manifest 与 tarball 都由同一次构建生成（`export-dsh-engine.mjs:94-101/106-121`），且都在可写工作区。坑 336 已确立「报告可被构建脚本改写、不可变字段必须从 Git 重建」的原则（`record-project-components.mjs:97-99`），本路径未应用。前置 = 构建期代码执行（被投毒依赖/构建脚本）；未改字节跑门禁。

386. **`preinstall.json` 不从 `$GITHUB_SHA` 重建（2026-10-17 登记；后续修复见修复账本）**

真因：`build-apk-source.yml:189` 用 `git show "$GITHUB_SHA:…engine-overlay.json"` 重建 overlay，而 `:513` 直接从工作树 `cp …preinstall.json`、`:515` 原地改、`:609-611` 用这份「原件」恢复。`preinstall.json` 决定 Termux targets、pnpm standalone 版本、canvas npm 包（`build-snapshot-013.mjs:59/71/727/840-841`），且复制点在所有构建动作之后。构建期改写或本地续跑目录里的改动可让快照装入不在 commit 里的包。未实际篡改。

387. **pnpm standalone 与 canvas 只以同一服务器自声明的 sha512 校验（2026-10-17 登记；后续修复见修复账本）**

真因：`build-snapshot-013.mjs:744-753`（缺 `dist.sha512` 只 warn 跳过）与 `:862-867`；摘要来自同一份元数据响应，不是仓库内固定值；`preinstall.json:7` 的 `npmMirrors` 含 `registry.npmmirror.com`，npmjs 失败时无条件兜底，workflow 只覆盖 `mirrors`（`:618`）。APK 内 pnpm 与 canvas 是仅有的「无仓库内哈希」运行时字节。未实际切镜像。

388. **`.debs` 缓存命中只比 size（2026-10-17 登记；后续修复见修复账本）**

真因：`build-snapshot-013.mjs:524` 命中条件只有 `existsSync + size 相等`，`:527` 的 sha256 校验被 `continue` 跳过；pnpm/canvas tarball（`:731`/`:849`）连 size 都不比。`DEBPOOL` 在工作区内，本地 `--build-workspace` 续跑会保留。与同仓其它缓存「命中重验」的做法和 `source-chain-rerun.test.mjs:104-123` 的断言相反。CI 全新目录不触发。

389. **Gradle 发行包没有 `distributionSha256Sum`（2026-10-17 登记；后续修复见修复账本）**

真因：`gradle/wrapper/gradle-wrapper.properties:3` 只有 `distributionUrl`，无校验和；APK 由 `build-apk-source.yml:716-717` / `scripts/build-apk.mjs:377-386` 调 `./gradlew`，CI 无缓存，每次全新下载。它是整条 APK 链唯一没有仓库内哈希的下载（NDK/bootstrap/marketplace 都有且命中重验）。services.gradle.org 或其 CDN 被替换时，构建工具本身可被植入且无门禁可见。未实际替换。

390. **隔离浏览器页面的 `document.title` 被当成设备路径（2026-10-17 登记；后续修复见修复账本）**

现象：注入层的捕获 click 监听把任何含 `/` 或 `.` 的 `title` 当路径（`dsh-host-web-compat/lib/index.js:614-626`），而隔离浏览器的网页标题会进入气泡导航按钮的 title（`BrowserHost.kt:993-995` → `sidebar-bubbles.ts:342`，`cloneTitle` 不剥离 title）。恶意页设 `document.title="/storage/emulated/0/Download"` 后，用户点气泡切页会弹出原生「打开方式」选择器，且点击被 `preventDefault+stopPropagation` 吞掉。边界：`PathOpen` 仍校验存在性与允许面，用户仍选应用；不是代码执行。本地假 DOM harness 已复现路径调用，未做设备验证。详见 [R2 审计 390](SECURITY-AUDIT-2026-10-17-R2.md)。

391. **整文档子串哨兵可被插件命名命中，静默跳过整个注入层（2026-10-17 登记；后续修复见修复账本）**

真因：`dsh-host-web-compat/lib/index.js:1114-1116` 用 `html.includes('x-dsh-pick-token')` 决定是否注入 `POLYFILL_SCRIPT`；该串同时是目录选择鉴权头名，而客户端 boot graph（`__DSH_BOOT__`，含插件 id 与 inject 服务名）也被注入 index。任一第三方插件的 client id/inject 键叫 `x-dsh-pick-token`，哨兵每次命中，polyfill、启动看门狗与 `[dsh-boot-*]` 契约行、主题桥、路径桥、剪贴板回退全部静默消失。**HYPOTHESIS**：boot graph 是否序列化进同一份 HTML 未在本仓验证（host-webserver 不在仓内），设备侧一次 curl 即可判定。

392. **`/api/android/open-path` 的会话范围只是建议（2026-10-17 登记；后续修复见修复账本）**

真因：`dsh-host-web-compat/lib/index.js:1228-1230` 绝对路径直通、只判 `existsSync`；`:1261-1270` 缺 session 时跨全部会话 cwd 取首个存在项并标 `guessed:true`，页面 `:717` 不读 `guessed`。路由有 token 门，调用者是引擎页/模型内容：影响是页面获得全设备存在性 oracle 与跨会话文件解析，不越过 `PathOpen` 允许面。未跑反证用例。

坑 376–392 后续实施、回归和未关闭边界统一记录在 [第二轮修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md)。各条原根因及「未跑」描述保留发现时历史。

393. **快照与源码字节对账必须独立重放合法转换，不能把入口文件整体豁免（2026-10-17）**

现象：新增门禁对真实既有快照先报 Cordis bin.js、再报 gateway client.js 不同。真因分别是生产 shebang 重写及 chrome87 转换，而旧 name/version 检查从不核对这些字节。修法：参考树从摘要绑定的源码包恢复，再依次重放登记补丁、生产语法转换及 shebang 脚本；仍逐文件比对，不豁免入口或客户端包。复验证据 `.deploy-tmp/security-r2-existing-snapshot.log`：样本源码包和 pnpm 载荷对账通过，后续既有 narb 副本门禁仍拒绝该旧快照，不把局部通过当候选通过。另发现 Windows autocrlf 改写固定官方 patch 字节，保持原 SHA-256 判据，给该目录加 -text 并恢复 Git 原始 LF。

394. **增加本地 vendor 摘要后，旧负控可能只改到不再参与裁决的上游摘要（2026-10-17）**

现象：bootstrap 加入 src/index.js 本地安全偏差后，--self-test 的摘要负控未产生失败。真因：生产判据优先 LOCAL_PATCHES，但旧负控仍篡改 MANIFEST 的同文件项，测试实际上改了被遮蔽的字段。修法：上游摘要负控改用仍保持上游原样的 src/manifest.js，本地摘要负控继续篡改 LOCAL_PATCHES；保持两种信任来源都能被反证。复验：check-vendored-linux-bootstrap.mjs --self-test 正控与四条负控通过，生产树检查通过。

395. **私有引擎转发不能使用 Android SocketAdaptor 的双向阻塞流（2026-10-18）**

现象：来源 APK 引擎已输出 dsh web 地址，壳侧仍停在引擎启动中。真因：EngineTransport 将认证后的 SocketChannel 改成 blocking，再同时使用 socket 的输入输出流。Android libcore SocketAdaptor.SocketInputStream.read 与 Channels.writeFully 都持有同一个 sc.blockingLock；上传线程在 GET 后等待下一段数据，下载线程即使已收到引擎应答也无法写回 TCP，直到上传读超时，超过启动探活预算。这是壳侧 relay 阻塞，日志中的 native binding fallback 本身不是引擎退出证据。

修法：认证后的 TCP channel 保持 nonblocking，relayChannelInput / relayChannelOutput 分别注册独立 selector，直接 channel.read/write；保留未认证连接限制、relay 凭据、私有 socket 的 SO_PEERCRED UID 校验及 60 秒活动/写入停滞预算。主 WebView、HTTP 探活与 mux 共用修复后的通道。JVM 回归在上传半边保持打开时接收响应，再验证后续上传；设备负控后端延迟 200ms 响应，确保上传已经等待，拒绝旧实现的抢跑假绿。

证据：`.deploy-tmp/engine-relay-fix-gradle.log` 完整 Kotlin 单测和 androidTest 编译成功；EngineTransportPolicyTest 5 项、0 失败。`.deploy-tmp/engine-relay-fix-preload.log` Linux 私有 socket 正例、外部占端口负控及无关 HTTP 服务正例通过（2 项、0 skip）。代码地图与 Kotlin 注释门禁通过。Android 原始实现核对 android14-release 的 SocketAdaptor.java / Channels.java，来源为 android.googlesource.com/platform/libcore。未做设备验证：WSL adb devices 为空，16416/16384 均 Connection refused；CDP、ADB 用户体验层和延迟响应设备负控未执行，不能记为三层验收通过。修复必须由来源链新 APK 装机后补验。

396. **独立检出不能依赖原仓远端，固定哈希输入不能被换行转换（2026-10-18）**

现象：本地来源链的组件 provenance 找不到 origin；Windows 夹具门禁报多处摘要不符；独立根导入后的维护提示报 bad object。真因：隔离检出有意不带远端，但编排器没有冻结原仓身份；Git autocrlf 改写 registry 和夹具；push.before 可能已不在新历史中。修法：统一传 DSH_SOURCE_REPOSITORY，固定字节输入全树 -text，维护输入检测对缺失 base 扫描当前树；预检移除 upstream/main 合并前提。反证：无冻结身份的隔离仓拒绝解析；缺失 base 仍触发维护检查；有效无关 diff 不触发；预检无效 URL/版本/摘要均拒绝。Windows 宿主用例 2 通过、13 个 Linux 专属跳过，夹具恢复 Git 字节后通过；L1 构建链修改未做设备验证，Linux 用例须在 CI/Linux 执行。
补充复验：WSL Linux / Node 24 的隔离构建与维护输入 15 项全过，0 跳过；保留缺失身份和缺失历史负控。

399. **离线 Linux 工厂资产必须有独立来源链，不能把私有 Release 当匿名下载渠道（2026-10-18）**

现象：旧 Linux 发布 API 无资产，空批准 pin 永远拒绝；私有仓的 Release 也不能供手机匿名取件。真因：运行时资产分发与私有项目身份没有收口，单改 URL 不能恢复功能。修法按用户选择先建立只读 ARM64 离线资产来源链：原生 launcher/preload 和插件使用本仓固定原始 Git 字节，Debian/Node 使用真实官方签名/摘要输入，产出本地清单与 provenance，后续随 APK 内置。源码导入摘要、同体积投毒和额外编译输入负控通过；官方 Debian InRelease/Node 归档摘要已在线核实。真实资产 run 39093355168 在许可收集阶段失败（根因及修法见坑 400），未产出归档，不能声称资产构建已由 workflow 验证。当前也未接入产品运行时；未做设备验证，不能把夹具当 Linux 可用性证明。另在导入时直接读原仓 Git blob，避免 Windows autocrlf 改写 JavaScript 原始字节。

400. **Cargo 许可收集不能扫描 metadata 中所有包（2026-10-18）**

现象：ARM64 Linux 资产 run 39093355168 编译完 Bionilux 后，在许可收集阶段因 `r-efi 6.0.0` 没有 LICENSE 文件而失败。真因：collector 遍历 Cargo metadata 的全部 `packages`，其中还包含当前目标未构建的 UEFI 依赖；Cargo 清单包集合不等于 Android ARM64 目标闭包。修法：调用 `cargo metadata --filter-platform aarch64-linux-android`，从 resolve root 只遍历 normal/build 边，忽略 dev 边；收集根目录许可文件及嵌套 LICENSES/LICENCES，并保留相对路径；任何可达包缺少许可仍失败关闭。反证：`test_collect_linux_licenses.py` 覆盖过滤后未达的 r-efi、dev-only 包、normal 依赖缺失许可与实际目标依赖许可。修复后真实 Linux ARM64 资产 run 39103194656 完成并上传 artifact，6 项许可/打包单测通过。
401. **Debian Trixie InRelease 三重签名会被旧 runner keyring 的未知签名正确阻断**：runner 自带 keyring 可验证旧 Bookworm 自动密钥，却不含 Trixie 自动归档 key 与 stable release key；`gpgv` 因此返回非零，尽管其中一个旧 key 的签名有效。不得忽略未知签名或只接受任一签名；从 Debian ftp-master 下载 Trixie 官方公钥，分别验证固定 SHA-256 与 primary fingerprint，再与现有 keyring 合并，供 InRelease 和 debootstrap 共用。真实失败 run 39102854750；修复后 39103194656 完整来源构建通过并上传资产。

402. **Linux runtime 的文件存在不等于可执行健康，子进程结果也必须有界（2026-10-18）**

现象：active 记录只靠文件存在/可执行位判断，伪造或损坏的 launcher、Node ELF 仍可能被报告 healthy；`spawnCommand` 对输出无限拼接，timeout 只发 SIGTERM，忽略信号的进程会一直挂住管理操作。真因：`_healthForRecord` 是静态结构检查，安装在切换 active 前没有实际经过 launcher/rootfs/Node 执行路径；子进程捕获与超时终止没有资源上界。修法：安装暂存目录通过结构检查后，在提交 active 前以 10 秒 deadline 经 Bionilux 从目标 Node 运行 `node --version`，非零、超时或无效版本输出即拒绝并清掉新实例，保留旧 active；stdout/stderr 各最多保留 256 KiB，仍持续排空管道，超时/取消先 TERM 并在 1.5 秒宽限后对进程组 KILL。正反例在 `vendor/dsh-linux-runtime/test/manager.test.mjs`；Windows 本机 18 项中 16 通过、2 个既有/平台专属 skip，Linux 信号负控必须由 CI 执行。**未做设备验证**，不能据宿主模拟器替代 ARM64 包内 launcher/rootfs 实测。

403. **离线 Linux manifest 必须 pin 原始字节，快照资产要和 APK 来源提交绑定（2026-10-18）**

现象：旧空 pin 会让生产 bootstrap 永远拒绝 manifest；以 parse 后 JSON 再 stringify 的摘要会受空白/键顺序影响，且与资产 workflow 生成的原始文件 sidecar 不一致。另一个装配遗漏是构建器只打包 bootstrap 的服务端 `lib/`，客户端设置 bundle 实际缺席。真因：私有 Release 不是手机可匿名访问的资产源，资产链、APK 快照和 bootstrap 信任代码各自为政。修法：同一 APK 来源链从固定源码重新构建唯一 ARM64 资产集，校验 provenance 的源码 commit、原始 `linux-release.json` SHA-256 sidecar、manifest 的仓库/版本 URL 命名空间，以及全部文件摘要和长度；然后将这些文件随快照放在 APK 签名保护下的固定目录。bootstrap 从原始字节 provider 取 manifest 并验证 sidecar；host adapter 仅复制清单允许的内置资产，仍由 bootstrap 复验归档后解包；服务端和客户端 bundle 均在打包前重建。反证覆盖 manifest/sidecar 篡改、资产摘要与长度不符、未暂存时禁止网络下载和设置客户端实际入包。Windows 上系统临时目录的受限句柄不允许 Node 原子 rename；测试临时数据改放 `.deploy-tmp` 工作区并回归通过，不改产品路径语义。当前插件单测 66/66、Linux source self-test 与 bundle self-test 通过；**尚无本次来源 APK 云端全链和设备验收证据**。

404. **独立应用身份、快照前缀和发布证书必须一起迁移（2026-10-18）**

现象：只把桌面标签改成 Pocket Harness 会留下上游 applicationId、Termux 硬编码数据路径、通知 action、adb 验收脚本和下载页资产名；只换 applicationId 又会导致快照内 shebang/RUNPATH 仍指向旧 data directory。固定在仓库的 `android/android` debug keystore 也不适合作为独立发行的可信签名身份。修法：保留 Kotlin `namespace` 以避免改写类/AIDL 兼容面；统一 `applicationId=com.snoworwind.pocketharness`，运行时数据路径使用新包名，用户文案和 adb 组件使用新安装身份 + 原 Kotlin 类全名。来源链只构建 ARM64；发布 variant 从仓库 Secret 注入 PKCS12 私钥，commit 中只存证书 SHA-256 pin，最终 APK 的三种签名方案和证书 pin 必须同时通过。公开 debug keystore 已从仓库移除，debug variant 回到本机 Gradle debug key。下载页不携带基线仓 seed 资产，只有 ARM64 独立发布存在后才展示下载。**75 项定向 Node 回归通过；两个仓库 Secret 已按授权写入，新的来源 APK 与设备侧三层验收仍待完成，未做设备验证**。老 DeepCode 保持并行安装，不自动迁移其私有数据；identity/signing 输入变化后来源构建和安装验收证据必须重做。

405. **跨平台来源摘要要针对 Git 字节而不是自动转换后的工作树（2026-10-18）**

现象：Linux 资产 PR 检查在 `plugins/dsh-linux-bootstrap/build.mjs` 报源摘要不匹配；Windows 本地按工作树哈希生成的 manifest 通过，GitHub Linux checkout 却按不同字节失败。真因：bootstrap 构建脚本和 README 未配置 `-text`，Windows `core.autocrlf` 转换后的 CRLF 字节被写入严格的来源清单，Linux runner 取到仓库里的 LF blob。修法：对清单覆盖的根级 `.mjs` 与 `README.md` 固定 `-text`，摘要统一使用 Git blob 原始字节；与发行包身份无关的 vendored runtime 测试夹具恢复原样，避免破坏来源 pin。`node scripts/source-build/check-linux-sources.mjs` 在当前工作树验证 37 个文件通过；PR CI 需复验 Linux checkout。

406. **进程组强杀回归必须等子进程装好信号处理器（2026-10-18）**

现象：Linux CI 的超时回归期望 `SIGKILL`，偶尔却收到 `SIGTERM`，而 Windows 因 POSIX 限制会跳过此测试。真因：20ms 超时可能先于新 Node 子进程启动；进程组里的子进程在注册 SIGTERM handler 前已被终止，测试并未覆盖 handler 忽略 TERM 后的强杀分支。修法：把测试超时提高到 1000ms，使处理器有时间就绪；在 `linux-source-manifest.json` 更新 vendored 测试摘要并记录该本地测试修补。此改动仅提高测试确定性，不改变运行时的终止期限或产品行为；以 Linux CI 复验该分支。

407. **导入新工厂插件或应用身份后同步更新对应测试锚点（2026-10-18）**

现象：PR Kotlin 单测在新增 `linux-bootstrap` 工厂补丁后，`FactoryProfilePatchTest` 的权威工厂条目计数仍按旧数值；应用身份改为 Pocket Harness 后，`OwnershipRepairCoreTest` 的正例 anchor 仍使用旧 applicationId，入口解析自然拒绝。真因：变更同时新增了一个顶层插件声明并收紧了数据目录可信边界，但测试只更新了邻近的身份断言。修法：工厂结构断言按实际 23 个顶层条目加注释头更新为 24 块；OwnershipRepair 正例用新 applicationId，旧 applicationId 留作拒绝负控。PR Linux CI 首次运行 1310 个 Kotlin 用例时发现三项失败用例、归为两类；修复后以该工作流完整回归确认。

408. **来源 artifact、捕获夹具、生成物和差异注册表需同时更新（2026-10-18）**

现象：新增 Linux provenance 上传项后，发布准备单测缺少对应文件；包名迁移还让捕获记录夹具和生成型 protocol JSON 与来源清单/生成器不符，新增 bootstrap 插件则漏登记退役发布脚本的显式差集。真因：这些门禁各自以工作流上传 globs、捕获哈希、生成器输出和注册表为真源，手改单边不能维持合同。修法：测试搭建阶段按实际上传清单创建 Linux provenance 文件；历史设备证据恢复原字节；protocol 夹具重新由 `gen-protocol-v2-fixture.mjs` 生成；`release-plugin-src-gaps.json` 明确记录 bootstrap 不走退役注入链。验证：发布准备测试需在 Linux/UTF-8 环境运行；patch fixture、protocol v2 与 `check-release-gates.mjs` 已本地通过，PR Linux CI 复验其余环境条件。

409. **源码切片回归须统一换行后再定位函数边界（2026-10-18）**

现象：Windows CRLF 检出在本机与 WSL 同时触发 overlay/file-click 加载期断言失败。真因：测试按 LF 字节查函数尾，尚未执行业务断言。修法：只对被测试源码的内存副本归一化换行，产品字节和安全判据不变。原工作树负例见综合审查 A09；修复后同一 CRLF 工作树重跑两套业务回归，日志 audit-fixes-2026-10-18/test-portability.log。此项仅改测试，未做设备验证。

410. **撤销列表不能把 ISO UTC 字符串裁成无时区本地时间（2026-10-18）**

现象：UTC+8 下快照 id 为 12:00，列表却显示 04:00。真因：replace/slice 只去掉时区标记，没有转换时刻。修法：以 Date 的本地日期分量格式化，损坏时间原样保留；把既有工具执行回归接入依赖准备后的 PR Gate。复验：undo-time.log；旧实现原反例双平台失败，修复后同用例通过。未做设备验证，最终 APK 的展示另验。

411. **runtime 共享任务结束必须唤醒管理等待者并阻止读者插队（2026-10-18）**

现象：最后一个命令结束后 install/uninstall/dispose 可永久等待。真因：releaseShared 只在 exclusive=true 才唤醒，但等待者此时尚未获得独占锁；且新命令不受排队管理者约束。修法：active 归零必唤醒，pendingExclusive 在等待期间阻止新共享任务入场。反证覆盖最后共享者退出、双管理者和排队读者；保留实际 cutover 回归，来源 pin 同步更新。未做设备验证。

412. **runtime 提交后的垃圾清理与观察者异常不能回滚当前实例（2026-10-18）**

现象：active.json 已指向新实例，旧目录删除失败后 catch 却删了新实例。真因：提交、垃圾清理和通知共用回滚域。修法：指针成功写入即退出可回滚域；旧目录清理异常作为 cleanupWarning 返回，事件观察者逐个隔离。反证覆盖旧清理抛错后重启仍健康、坏监听者不阻塞后续监听者、once 语义与提交前指针写失败保持旧实例。来源摘要同步更新，未做设备验证。

413. **复用工作流每层都要传递签名 Secrets（2026-10-18）**

现象：直接来源链可读签名秘密，build-apk 包装入口却在非空断言拒绝。真因：外层 reusable workflow 调用没有 secrets 传递，内层 inherit 不能补回缺失值。修法：普通构建和草稿两条调用都显式 inherit，草稿已有下一层传递保持有效。cloud-workflow.test.mjs 对两个入口分别移除传递，合同必须拒绝；全套自检与受控负例通过。未做设备验证，真实签名仍须 main 来源全链。

414. **来源链的已提交身份不能代替维护分支授权（2026-10-18）**

现象：草稿要求 main，直接来源 workflow 与本地 runner 却接受任意分支 HEAD。真因：隔离检出只绑定 commit，没有绑定维护分支政策。修法：云端第一步检查 github.ref，签名与源码检出前拒绝其他 ref；本地实际执行（含续跑）须 attached main，纯 list/dry-run 可在候选审查。真实临时 Git 的 main/feature/detached 正反例及 shell 的 main/feature/tag/PR/空值反例覆盖。未构建非 main APK，未做设备验证。

415. **离线 Linux 必须用生产全链验证归档格式、包槽与 IO 约定（2026-10-18）**

现象：各层单测绿，实际归档却因 ./ 根条目拒绝；Node/rootfs 链接被插件政策一刀切拒绝，包槽不在宿主根内，runtime 又没有资产 IO。真因：资产正控只接替身宿主/管理器，没串生产消费者。修法：仅接受一次零体积目录根条目；plugin 继续禁链接，runtime 延迟创建内根链接、拒绝链接父目录和逃逸，rootfs 的绝对链接转成根内相对链接；包槽改到 plugins/linux-runtime；runtime 明确适配“写 destination”下载约定并转发 kind。禁网联测使用真实 GNU tar、host、Cordis、bootstrap 和 manager，只有 ARM64 原生执行器为宿主夹具；覆盖安装、工具执行、重装、卸载和路径/链接负控。日志 offline-integration.log、linux-host-io.log；设备仍未验收。

416. **独立 applicationId 不会改写 Kotlin 组件类名（2026-10-18）**

现象：IME/键盘广播把新包名与 .AdbKeyboardService/.Receiver 拼在一起，实际会解析到不存在的新 namespace 类；环境准备还 grep 旧包名，造成启用成功误判或他包误命中。真因：应用身份与类 namespace 的边界混淆。修法：组件写成新 applicationId/原 namespace 全类名，列表按规范化完整 ComponentName 比较，旧包/旧短类/前后缀相似项均拒绝。承接旧 PR #2 独有修复但不引回其整树类重命名。组件和真实 env_prepare 工具反证通过；未做设备验证。

417. **独立重建必须比较实际载荷，且构建 job 不持有正式私钥（2026-10-18）**

现象：单一可写构建目录可同时改包缓存、清单和快照；旧独立证明草稿仍使用过时名称与 debug 签名接口。真因：同一失败域生成与验证自己的证据。修法：两台全新 runner 各用临时证书产出当前 Pocket Harness release 载荷，第三个无生产 Secret 的 job 直接读 APK/快照并比较完整载荷与受控 v3 语义；最后隔离 job 才读取正式 PKCS12，签前 proof 绑定输入 SHA 与 APK 字节，签后重绑输出，草稿准备再次核对。构建证书只用于中间门禁，交付仍固定仓库生产证书 pin。回归包含 JS/DEX/权限/服务文件差异、路径穿越、条件导出顺序、陈旧证明、错误生产证书与签名 CLI 原子覆盖。新 --self-test 与受控负例通过；真实双构建、来源 APK 和设备层未完成前不能记验收关闭。本地来源入口只跑一份构建副本，支持白名单 GITHUB_ENV 传递且明确标记不能交付。

418. **插件 scope 退出须回收自建 manager，但不能让保留 handle 的卸载变成空操作（2026-10-18）**

现象：runtime scope 注销工具后，已运行命令仍可跨越插件替换；简单 dispose 又会让 bootstrap 保存的旧 handle 在 uninstall 时直接返回、残留数据。真因：scope 与 manager 生命周期未绑定，disposed 同时拦了本应允许的清理。修法：scope 异步等待自建 manager.dispose，外部 manager 维持宿主所有权；disposed 继续拒绝执行/安装，但允许幂等卸载。反证覆盖持有命令的 scope 退出、外部 manager 不被误回收、旧 handle 真卸载，以及生产 Cordis 联测中的回收完成；来源 lib/module/test pin 同步。输入变化后取消旧来源 run39112321118，不复用其构建证据；未做设备验证。

419. **bootstrap package-lock 也是逐字节来源输入，必须禁止 autocrlf（2026-10-18）**

现象：分支切换后 package-lock 变成 CRLF，严格来源门禁报摘要不符，而 Git 语义 diff 为空。真因：既有 -text 只登记了 package.json、mjs、src 和 README，漏掉同样被 source manifest 哈希覆盖的 lock。修法：对 bootstrap/package-lock.json 也设 -text；不改变 Git blob、lock 解析或批准摘要。实际临时 Git autocrlf checkout 正控保持摘要，删除该属性的负控必改变摘要且仅换行不同；来源 self-test 在 POSIX 原样通过。

420. **14 GB runner 在 APK gate 重解快照前就会耗尽磁盘（2026-10-18）**

现象：最终 main run 39113529859 的两个 replica 都在 `[build-apk/arm64] 门禁：引擎 overlay 抽验` 处失败；日志先出现 `Free space left: 83 MB`，随后快照检查器在 `cpSync` 到 `/tmp/dsh-source-snapshot-*/reference/...` 时报 `ENOSPC`。真因：快照封包后，runner 仍同时保留 Harness 依赖树、pnpm deploy 树、Linux rootfs/cargo/assets、NDK、Termux webroot、解包 stage、快照归档和 engine-overlay 源包缓存；APK gate 的 overlay 适配器还会再次解包快照并把完整 engine 复制成 reference，峰值超过标准 GitHub 托管 runner 的 14 GB 磁盘。修法：在快照封包与 post-snapshot 检查后、第一次来源快照检查前运行 `scripts/source-build/reclaim-build-disk.mjs --root "$GITHUB_WORKSPACE"`，只删除已不属于后续输入的 `engine-deploy`、`linux-build` 非 provenance 内容、NDK、Termux webroot、bootstrap/node deb 解包树和 Harness ignored 构建产物；保留 `snapshot-013/.../stage`（`check-contract.mjs` 读取）、`engine-overlay` 源包缓存、`source-build` 报告和 `linux-build/provenance`。脚本对每个目标校验真实路径必须位于 `.deploy-tmp` 内，拒绝符号链接目标、已挂载 rootfs 和非目录/文件；清理后可用空间低于 4 GiB 即失败。受控证据：`reclaim-build-disk.mjs --self-test` 的正控、symlink escape、`--check-only` 和空间下限负控通过；`cloud-workflow.test.mjs` 拒绝缺失调用。该失败不是业务门禁判红，不能记作源码修复验收；须以新 main 来源 run 的最终结论替换本条。设备侧仍无在线设备，未做设备验证。

421. **内置插件注入不能用目录名代替 package.json 包名（2026-10-18）**

现象：磁盘回收修复后的 main run 39119416887 已通过快照封包、来源快照检查和 APK 前段门禁，却在注入后的 `check-inject-completeness` 判红：`@dsh-android/linux-bootstrap -> tar 内无该包成员`（web/headless 各一次），但 `inject-all` 的 `[add]` 日志显示它注入了 `@dsh-android/dsh-linux-bootstrap`。真因：`build_dsh_replacements` 用插件目录 basename 当包名；`plugins/dsh-linux-bootstrap` 的真实包名是 `@dsh-android/linux-bootstrap`，而 profile patch 也按真实包名引用。目录名与包名不同时，注入写进了另一个命名空间，产物成员检查才暴露。修法：@dsh-android 注入改为读取 `package.json.name`，只接受单个 `@dsh-android/<name>` 层级，目录名不同时打印审计行；新增 `scripts/source-build/test_inject_all.py` 用 `dsh-linux-bootstrap -> @dsh-android/linux-bootstrap` 正控，拒绝非命名空间和嵌套名。该轮未做设备验证；必须用修复后的 main 来源链重新产出 APK。

422. **Linux 启动依赖缺失与前后端服务混用（2026-10-18）**

    现象：android-linux-env failed to import，bootstrap 等待 linuxPluginHost/linuxBootstrapConfig；安全模式页面仍报 linuxBootstrap pending。真因：插件新增静态 XZ/TAR 导入，但注入器只复制 lib 与包清单，未把第三方依赖带入快照；浏览器插件又把仅存在于引擎 Cordis 的 linuxBootstrap 声明为必需注入。修法：overlay 登记锁文件中的完整解包闭包与许可；浏览器只依赖 slots，通过现有鉴权 HTTP 路由读写，保留 confirmed 确认参数与失败信息。复验：依赖闭包正控及删除 streamx 负控、真实客户端模块激活及 HTTP 503 负控通过；来源与 vendoring 哈希同步。设备三层验收尚未完成，不能据此宣称 APK 已验收。N1/F3 原生绑定提示是既有兼容回退。
423. **原生控制轮询与来件投递漏了 relay 准入头（A01，2026-10-18）**

    现象：控制队列（a11y/browser/vdisplay/shell）与分享来件在真机上整体静默；不是 401，日志里也没有引擎侧拒绝。真因：3080 relay 在把连接转发到应用私有 Unix socket **之前**只检查 HTTP 头（`X-DSH-Relay` 或 `dsh-relay` cookie），而 `ControlPoller.post` 只带 Content-Type、`FileIncoming.deliverOnce` 只带 `X-DSH-Control-Token`；后两者都发生在转发之后，不能替代准入。WebView 的 CookieManager 也不会替原生连接附头。修法：在 `EngineTransport` 增加唯一的 `attachAdmission()`，`EngineAuth.confineConnection` 复用它；控制轮询与来件投递改经 `EngineAuth.attach(context, conn)`（同时保留各自原本的令牌/cookie 鉴权）。复验：relay 三态准入单测 + 两处调用点契约测试；设备上的有/无/错凭据负控必须由来源链新包补做。

424. **屏幕范围授权在原生内存，插件再读旧 XML 会永久误拒（A02，2026-10-18）**

    现象：用户在原生确认 `all`/`real-only` 后，模型仍被判 `virtual-only` 并拒绝真实屏；升级设备长期读旧值。真因：`ScreenScopePrefs` 已迁到进程内 `@Volatile`（同 uid 可写的 prefs 文件不再是授权真源），但 bridge 插件 `currentScreenScope()` 仍读 retired `shared_prefs/dsh_screen_scope.xml`，而原生从不写它。修法：原生在 `vdInfo` 应答的 `data.scope` 和每条控制应答的 `caps.screenScope` 回传当前范围（经 relay+令牌+本进程认证）；插件 `screenScope()` 优先读 caps，`refreshScreenScope()` 在冷启动或「因范围被拒」时经 neverA11y 的 `vdInfo` 补探一次，仍拒绝则维持 fail-closed。插件不再读任何 prefs 文件；`DSH_SCREEN_SCOPE_TEST` 仅测试用。复验：bridge 新增 5 例（retired XML 写 all 仍忽略、caps 撤销、冷启动读回、仍拒绝不放宽、shell 拒绝自愈），全量 164 通过。

425. **`getSentFromUid()` 属于 BroadcastReceiver，不属于 Intent（A03，2026-10-18）**

    现象：IME 活跃时，SDK 34+ 上无 nonce 的标准 `ADB_INPUT_TEXT`/`ADB_CLEAR_TEXT` 广播被误拒；带 nonce 的插件路径正常。真因：旧实现反射 `Intent.getMethod("getSentFromUid")`，该类根本没有此方法，异常被吞成 null，于是 root/adb UID 白名单恒不命中。修法：由 `AdbKeyboardReceiver.onReceive` 在接收器实例上调用平台 API 取发送者 UID，显式传入 `isTrustedSender(context, intent, senderUid)`；身份不可得时仍只认 nonce（fail-closed）。复验：调用点契约测试断言接收器取值、服务签名与旧反射消失；真机 IME 待验。

426. **虚拟屏启动的显式目标被 selected 遮住，且最后派发点不复核范围（A04/A05，2026-10-18）**

    现象：已建 virtual-1 后显式请求不存在/过期的 virtual-2，会在 virtual-1 上启动（静默换屏）；虚拟屏存活、范围切到 real-only 后，直达 carrier 的启动请求仍能写入被排除的屏。真因：`selectedRecord() ?: recordOf(target)` 让 selected 永远优先；两个启动函数解析 display 后直接 `am start`/探针，没有复核 `ScreenScopePrefs`（插件侧拒绝不是最后判据，REAL_ONLY 明确不含 virtual-N）。修法：统一 `targetRecord(target)`（显式优先且不回退，缺省才取 selected）；`launchApp`/`launchSettingsProbe`/`sendBackProbe` 在派发前走 `scopeDenial()`，`launchApp` 在 `am start` 前再读一次（解析组件期间可能被改窄）。复验：调用点契约测试；无效目标不产生屏幕副作用、范围切换时序待设备验。

427. **HTTP 分块逐块 `toString()` 会拆坏中文路径（A06，2026-10-18）**

    现象：分享中文文件名后，JSON 能解析但入队查不到文件；日志里路径出现 `���`。真因：三个 POST handler 对每个 TCP chunk 单独 `buf.toString()` 再拼接，UTF-8 多字节字符跨 chunk 时被替换；body 上限还按 UTF-16 字符数计。修法：改用 `StringDecoder('utf8')` 按流解码并在 `end` flush，上限按累计字节计（16 KiB / 4096 / 2048 语义不变）。复验：把「中」三字节拆成 1+2 两个 data 事件仍得到原路径；三档字节上限各有一条 413；旧实现红。

428. **附件下载无视背压与断连，fd 还可能在销毁路径漏关（A07，2026-10-18）**

    现象：慢客户端下载 200 MiB 附件时，整个文件被排进响应缓冲；断连后源流继续读。真因：`data` 回调无条件 `res.write`，不处理 `false`/`drain`，响应 `close`/`error` 不销毁源流。修法：`write === false` 时 `pause()`、`drain` 后 `resume()`；响应关闭/错误时 `stream.destroy()`；fd 所有权在 `createReadStream({ fd })` 成功后交给流（autoClose 默认 true），自然结束/读错误/断连都由流关闭描述符并等 `'close'` 收尾，`finally` 只在尚未移交时兜底关闭。**别再用 `autoClose:false` 再手工 `closeSync`**：Node 20 的 `destroy()` 会关描述符，close 事件后二次 close 会误关复用的 fd（本机实测 EBADF）。复验：慢消费者峰值 ≤256 KiB；断连/自然结束/读错误/未移交四条路径直接 `fstat` 断言源 fd 已关且 fd 计数回基线；删除 finally 兜底即红。

429. **live 流把字符下标当字节偏移，事件被重复消费（A08，2026-10-18）**

    现象：含中文的 tool_call 之后，同一 tool_result/turn_end 被处理多次，可能错误清除忙态/待答卡。真因：`String.lastIndexOf('\n')` 返回字符下标，却被加到 `RandomAccessFile` 的字节偏移；中文行字符数小于字节数，偏移推进不足，下一次 drain 重读旧尾段（审计用 200 个「中」复现同一结果六次）。修法：在字节缓冲上找最后一个 `0x0A`（UTF-8 多字节序列不含该字节），按实际消费字节推进；只解码已消费前缀。复验：`liveConsumableBytes` 的中文整行/半行/多行用例 + 源码断言；设备 overlay 重放待验。

430. **本地来源链 `--from apk` 漏掉最终复验（A09，2026-10-18）**

    现象：`--from apk` / `--only apk` 续跑看起来成功，但构建后的快照语义归一化与 APK 文件复验没有执行。真因：未映射步骤一律归 `misc`（阶段索引 -1），`from apk` 过滤时被判为「早于 apk」；文件头注释却写「跟随上一阶段」。修法：未映射步骤继承前一个具名阶段（首个具名阶段之前仍 misc）；计划/选择抽成 `planSteps`/`selectPlanned` 纯函数；Kotlin 单测门禁归 apk（`--to snapshot` 不跑它）。复验：`--from/--only apk` 均含最终复验、旧规则负控、真实 CLI dry-run；未跑真实长链。

431. **重打包 tar 默认递归目录，成员重复（A10，2026-10-18）**

    现象：canonical 后 `package/lib/deep/index.js` 在归档里出现三次、`deep` 目录两次，体积与解包工作增长。真因：`sortedEntryList` 已递归枚举目录与文件，却又传给仍递归目录的 `tar -cf`。修法：`tar -cf ... --no-recursion` 显式成员打包，写 gzip 前用 `assertPackedMembers` 校验每个路径恰好一次且集合等于清单。复验：成员唯一/幂等/键序不变；旧递归实现红；未在真实 engine tarball 上跑。

432. **本地来源续跑不绑定工作树源码字节（A11，2026-10-18）**

    现象：在隔离检出的工作树里改写 `app/src/main/probe.kt` 后再 `prepareSourceWorkspace`，仍返回 accepted:true、sameHead:true——「只构建已提交 HEAD」对本地续跑不成立。真因：续跑只验证 marker/HEAD/路径安全，不看已跟踪文件内容或未跟踪源文件。修法：marker schema 2 登记工作树源码字节摘要（已跟踪文件按当前字节、未跟踪且未忽略的文件一并纳入，计数也进摘要）；续跑重算比对；用**有限白名单**放行构建预期写入（`.deploy-tmp/`、`out/`、插件 lockfile、overlay 配置、补丁夹具、marketplace 组件等），白名单不得覆盖 `app/src`/`scripts/source-build`。旧 schema 目录须重建。复验：改写/新增源文件拒绝、恢复后可续跑、白名单路径可变化；未跑真实长链。

433. **下载页按旧命名推导资产，接不上来源草稿（A12，2026-10-18）**

    现象：来源草稿的真实资产 `pocket-harness-v0.14.7-source-arm64.apk` 传入 `pickAsset` 返回 null；页面仍找 `MANIFEST.txt`，而草稿提供 `SHA256SUMS.txt`，tag 是 `hardening-source-*`。真因：`pickAsset` 只由 tag 推导普通命名，`build.mjs` 固定取 MANIFEST。修法：从 `release-source-draft.yml` 与 `prepare-source-release.py` 提取唯一合同（tag 前缀、来源 APK 形态、SHA256SUMS 格式），`pickAsset` 普通命名优先、来源命名兜底且限 arm64；`build.mjs` 按合同取校验文件并注入 `sha256`/`checksumFile`/`checksumUrl`；页面不再把来源资产叫「历史资产名」，校验链接指向实际文件。复验：webpages 45 项（含来源草稿构建与页面渲染、旧命名兼容、负例）；Pages 仍手动部署，未上线验证。

434. **Windows CRLF 检出让 Safe Mode 补丁升级自验必红（A13，2026-10-18）**

    现象：Git 索引是 LF、Windows 工作树按 CRLF 检出时，升级旧 S2/S4 的两个测试失败，runner 安全拒绝写出。真因：runner 原样插入 `undo-safe-transaction-snippet.mjs`，而事务段自验显式拒绝 CR。修法：载入该 snippet 时只把 CRLF 规范为 LF（`\r\n → \n`），裸 CR 不吞、自验不放宽。复验：CRLF 检出升级成功且事务段无 CR；注入裸 CR 的负例仍 exit 1、报「施加后自验失败」且不写回；旧 runner 红。Windows 实机工作树待复验。

435. **mobile-owned 路由门禁的存在性断言没剥注释（A14，2026-10-18）**

    现象：受保护 `/api` 路由的 guard 被注释后，`check-api-route-auth.mjs` 仍 PASS。真因：该文件上游段已用 `stripSourceComments()` 且带自检，但扫本仓 28 条路由的 mobile-owned 段仍对原始文本做注册表达式、endpoint、guard、公开响应 marker 四条裸 `includes`。修法：新增 `sourceIncludes()`（先剥注释再 includes），四条断言与注册块扫描统一使用；`--self-test` 增 mobile-owned active/comment-only/missing 三态与注释注册负例。复验：自检三态成立；本机 28 路由 PASS（上游树缺席 SKIP=1）；`--require` 需上游 checkout。

436. **Linux 插件依赖只放进引擎树，profile 路径解析不到，整条 Linux 环境起不来（2026-10-19）**

    现象：设备上「Linux环境」面板一直报错/停在读取中，`linux_bash` 与 Linux 安装不可用；`engine.log` 出现 `android-linux-env … Cannot find package 'xz-decompress'`，随后 `linux-bootstrap … pending (waiting for services: linuxBootstrapConfig, linuxPluginHost)`。真因：`dsh-android-linux-env/lib/linux-host-asset-io.js` 静态 import `xz-decompress`/`tar-stream`，但 `inject-all.py` 只把 `lib/**` 与 `package.json` 注入到 `home/.dsh/profiles/*/node_modules/@dsh-android/<pkg>`；187246a 的修复只把这两个包登记进 `engine-overlay.json` 的 `vendorTop`，落点是 `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/`。Node 从 profile 包目录向上解析时**不会**回落到引擎树，引擎的 interception 也只覆盖安装闭包/挂载 bundle 闭包，故 import 在 `apply` 之前就失败；路由、`linuxPluginHost`、`linuxBootstrapConfig` 全部缺席。门禁假绿的原因是 `check-inject-completeness` 只查相对 import、`linux-plugin-dependencies.test.mjs` 只查 overlay 登记「包在快照某处」。修法：注入器读取每个 `@dsh-android` 包的 `dependencies`（跳过 `@dsh-android/*`、`@deepseek-ai/*`、`file:`/`link:`/`workspace:`），把运行时闭包平铺复制到该包自己的 `node_modules/` 下；注入器的 `match_dsh_android` 与补缺/修剪逻辑接受 `node_modules/**`。门禁新增 C1「运行时依赖闭包」与 C2「bare import 从注入路径可解析」（client bundle 与 React 等 WebView external 显式排除），并把这些成员一起解压检查。复验：`scripts/source-build/test_inject_all.py` 5 项通过（含删除传递依赖必失败）；`check-inject-completeness` 在正控快照上 26 包 × 2 profile 通过；删掉注入树里的 `xz-decompress` 后，C1/C2 对 web/headless 各判红（4 项 FAIL），证明门禁能抓住本缺陷。**未做设备验证**：需来源链新 APK 的 engine.log 无 `did not activate`，并通过面板安装/`linux_bash` 三层验收。

437. **浏览器把 profile 支持当成可用前提，无 MULTI_PROFILE 的设备整块不可用（2026-10-19）**

    现象：设备 WebView provider 不支持 `MULTI_PROFILE` 时，浏览器面板只显示 `browser-profile-unsupported`，地址栏、PC/手机身份、分辨率与全部 `browser_*` 工具都不可用；根因是 `BrowserHost.ensureViewFor` 在构造任何 WebView 之前就按该 feature 拒绝，`available` 又被算成 `supported && profileError.isEmpty()`，所以前端预留的 `available=true/profileAvailable=false` 降级分支永远走不到。修法（用户显式选择的口径）：保留隔离 profile 为优先路径；新增**用户显式**兼容模式（面板按钮 → `browserHostCommand` 的 `compat` 动作 → SharedPreferences `dsh_browser/compatibility`）。兼容模式新建普通无桥 WebView，使用进程级 Default CookieManager，`profileIsolation=shared`、`profileAvailable=false`、`available=true`；UI 明示“与应用共享 Cookie，仅建议可信站点”，并可关闭。安全边界：兼容模式不获得 `isolatedProfile=true`，因此 loopback（含引擎 3080）仍被 `BrowserHostNavigationPolicy` 拒绝；不挂 `androidBridge`；不调用 `clearCookieAndWebStorageData`（共享 jar 不清）。代价：浏览器 cookie/storage 与引擎共享，且会话间不再隔离；这是用户明确接受的降级，不是静默失败。验证：`BrowserHostCommandWiringTest` 新增显式门/共享 jar 归属断言；Kotlin 1320+ 全量单测通过；`browser-tab.spec.tsx` 7 项（含启用/关闭兼容与共享提示）、`native-browser-adapter.spec.ts` 7 项通过。**未做设备验证**：需真机确认 compat 动作、面板提示、第三站点导航与 `browser_*` 工具。

438. **Linux bootstrap 把审批摘要放在 Symbol 里、卸载又假设 manager 还活着，重启后 reinstall/uninstall 必失败（2026-10-19）**

    现象：装过一次 Linux 环境后，引擎重启再点「重新安装」恒报 `Release manifest is not approved by the source-pinned trust policy`；点「卸载」恒报 `The installed runtime plugin did not provide a runtime manager`。真因：`SOURCE_MANIFEST_SHA256` 是对象 Symbol，`state.pinnedManifest` 落盘 JSON 时丢失；重启后 `reinstall` 用 `validateManifestShape(state.pinnedManifest)` 重建，`requireApprovedManifest` 拿不到摘要。`uninstall` 在 `manager === null` 时构造 `{service: pluginHost.service}`，而 `LinuxPluginHost` 根本没有 `service` 成员，`resolveManager` 必然找不到 manager。修法：state 新增并校验 `pinnedManifestSha256`（64 hex，旧 state 缺失为 null），安装成功时落盘；`reinstall` 把它写回 Symbol，`requireApprovedManifest` 只在「已安装且摘要与持久化值相等」时认可 pinned 副本，其他路径仍走宿主实时审批。`uninstall` 在 manager 为空时先用持久化 `pluginDirectory` 调 `pluginHost.install({entry:'lib/index.js', config, enable:false})` 重新激活，再从返回的 hostResult 取 manager 并调用其 `uninstall()`。复验：`plugins/dsh-android-linux-env/test/linux-host-asset-io.test.mjs` 新增「同一 filesDir 建第二个 bootstrap 实例」的重启用例，19/19 通过；不修改 state schema 版本，旧 state 兼容。**未做设备验证**。

439. **来源构建注入器重复写入新包目录，双构建比对拒绝（2026-10-19）**

    现象：Actions 39147156896 的两次 ARM64 构建完成，verify-arm64 却报 `duplicate or excessive snapshot entries`。失败主 APK 实测 53022 个成员、52978 个唯一路径，44 个重复路径均为新注入包目录。真因：`inject-all.py` 整包追加先手写 base/lib 两个目录却未登记 `seen_dirs`，随后 `ensure_parent_dirs` 再写同一路径；输入已有空包目录也会重复。修法：整包追加统一调用带登记的 `ensure_parent_dirs`，保持读取器的重复成员拒绝与数量上限不变。复验：新增新包/仅目录包两种回归夹具，旧实现两例均红（22 成员对 18 唯一路径），修复后 Python 6 项通过；Linux 比对器自检 4 项通过，执行地图门禁通过。失败产物清点脚本与下载产物位于本地 `.deploy-tmp/ci-snapshot-fix/`。未做设备验证；本轮只改构建归档目录去重，最终候选仍须按发布规范补验。

440. **安装身份与 namespace 分离后，脚本仍推导类名并误认旧应用（2026-10-19）**

    现象：热推、性能、通知、客户端故障恢复及状态同步五个脚本以新包名加 `/.MainActivity` 启动不存在的类；屏幕矩阵按 namespace 子串把旧应用当本应用；软链别名正则仍认旧包。真因：未分别核对安装身份、类名及转义正则。修法：启动改完整 Kotlin 类名，热推与故障恢复启动错误时中止；两套无障碍验收共用精确 Bound services 组件匹配，读取完整 dumpsys；软链别名改新 applicationId，其他绝对链保留规则不变。复验：身份、矩阵与签名定向 35 项通过；旧 HEAD 受控负控失败，日志 `.deploy-tmp/package-identity-fix/negative-control.log`；设备套件既有自检通过。未做设备验证、未构建 APK；未改 Kotlin、Manifest、插件或快照事务策略。设备判据的真实 dumpsys、并装及横竖屏验收仍待在线 ARM64 设备，不宣称三层通过。

441. **namespace 全迁移不能只改 package：AIDL 缓存与组件简写同时改变（2026-10-19）**

    现象：只替换 Kotlin package 会留下旧目录/门禁锚点、Root 入口和插件组件；即使编译通过，Shizuku 旧 descriptor 缓存与系统同包简写仍可能使设备链路断开。真因：安装身份、类名、Binder descriptor 和系统持久组件各自演进。修法：四组源码目录与所有调用/定位引用同步迁移；Shizuku 协议升至 5；IME/无障碍同时认新完整名与简写、拒绝旧类。身份回归新增目录/声明一致性、旧路径/旧 AIDL 反例及服务缓存失效约束。前后完整检查、环境纠正与设备未验收边界见 NAMESPACE-MIGRATION-2026-10-19.md，不以宿主通过代替升级安装验收。

442. **引擎换版不能只换版本号：包管理器和构建图也会变（2026-10-19）**

    现象：0.2.1 已改 pnpm 11.28.5 和官方分步 builder；旧 Corepack 在 VM 内加载 pnpm 失败，Node 22 native TS loader 拒绝 tsdown.config.ts，旧 recursive bundle 因实际循环依赖被新版 pnpm 拒绝。真因：原来源链把旧脚本结构与工具版本当成长期不变量。修法：固定 Corepack，Node 24 带匹配头文件；使用官方 native/Host libraries/Client compiler/Client bundle/Web 阶段，不改根 manifest。复验：官方源码全 blob 核对，345 包实际源码构建导出；来源 Node 129 与 Python 21 项通过，缺 compiler/旧包管理器/旧 builder 负控判红。完整记录见 ENGINE-UPGRADE-2026-10-19.md；未做设备验证。

443. **PTC 新增持久 worker 后，只重锚一次执行会留下第二条 Android 失败路径（2026-10-19）**

    现象：0.2.1 的一次执行已适配，但 PersistentKernel 自己解析 executable、构造 argv 并 spawn；它和 persistent-process.js 都不经过旧 A1 双目标。真因：把包入口当成单一执行路径，并遗漏新增 companion。修法：A1 改为三产物完整 plan，持久路径同样执行可信 linker 前缀、宿主 heap 与原生白名单；两 child 清模型环境；每条 enforcing argv 与精确 spawn 数同时验证。复验：15 项真实构建产物行为/反证，含受限 confine 拒绝、取消、秘密清理、缺 companion 和第三 spawn；24/24 补丁真实命中。设备为空，未声称 Android 运行通过。

444. **bootstrap 依赖升级遗漏来源字节登记，独立资产 CI 正确拒绝（2026-10-19）**

    现象：引擎升级 PR 的 Linux validate 在 package.json 摘要处失败。真因：bootstrap 的 Cordis 与真实 lock 已更新，linux-source-manifest 的 additionalSources/files 两份受审映射仍绑定旧字节；仅重建 lib 不会同步来源登记。修法：对这两个已审查的依赖输入同步实际 SHA，localPatches 明记 0.2.1/Cordis 变更原因，保持原始 upstreamSha256、源仓提交与拒绝判据不变。复验：check-linux-sources --self-test 的完整源码正控、同体积投毒/额外输入及行尾负控均通过；失败 run 39221768021 保留，不以重封原上游 hash 洗绿。未做设备验证。

445. **移除上游 manifest 改写时仍须保留来源回执（2026-10-19）**

    现象：新版直接使用官方构建脚本，上传清单仍要求 harness-root-package.json.original。真因：删除旧 manifest 改写块时连带删除了原始输入复制，缺件会令来源归集拒绝。修法：编译前只读复制原始 manifest 并登记 SHA256，不修改上游或放松缺件判据；发现后请求取消来源 run 39222638056，但 run 已因 Sharp 旧版本校验失败；修正合入 main 后重跑。复验：cloud-workflow 正控和缺回执负控通过；未做设备验证。

446. **原生审计版本必须跟随实际来源闭包逐项审查（2026-10-19）**

    现象：来源 run 39222638056 在 node-pty 交叉编译后拒绝 sharp@0.35.5。真因：旧审计固定 0.35.3，本轮部署还新增 builtin Linux 0.1.9；不能用版本通配洗绿。修法：按实际 manifest/loader 核对，仅登记 Sharp 本体/Linux 0.35.5 和 builtin 0.1.9，保留 WASM 0.35.3 与原 ELF/闭包/未知家族拒绝。复验：精确路径正控、新版本与错架构负控通过；实际来源构建需修正后的 main 重跑。ADB 空列表、ABI 未知，CDP/用户层未验收。

447. **A1 计划三文件、apply-patches 只写两文件：canonical verifier 判 incomplete（2026-10-19）**

    现象：build-apk-source run 39225525469 的两条 ARM64 步骤 24 都报 `Error: incomplete canonical engine patch: ptc-android-native-A1`（`scripts/source-build/reconcile-engine-patch-copies.mjs:94`）。真因：0.2.1-rc.2 的 A1 `planPatch` 已扩为 `lib/index.js`、`lib/process.js`、`lib/persistent-process.js` 三文件，`apply-patches.mjs` 的 PTC `additionalFiles` 仍只列前两文件；`apply` 虽把第三文件缓存进 `IMPL_state`，`saveImpl` 只落 primary + `additionalFiles`，于是 persistent companion 从未写回，verifier 检完整文件集时判红。修法：PTC `additionalFiles` 补 `lib/persistent-process.js`；`check` 同时加载并校验 persistent 的 marker、清环境与幂等；回归新增真实 `apply-patches` 三文件写回用例（先施加 `ptc-argv-L1` 前置）。复验：修复前该用例在 `lib/persistent-process.js must be patched` 处红，修复后 16/16 通过；`reconcile-engine-patch-copies` 6 项、`check-patch-mirror`、`check-maintenance-docs` 均通过；未做设备验证，需重跑来源链到 `sign-arm64`。

448. **共享 engine 脚本抽取后，回归必须跟随实际执行入口（2026-10-19）**

    现象：PR #48 的来源回归五项失败。真因：测试仍从 workflow 已移走的内联步骤提取 shell，未覆盖新共享脚本。修法：官方构建顺序、组件来源及重跑清理测试读取 build-engine.sh 的实际字节，保留缺编译器、缺回执、错包管理器、符号链接逃逸等负控。复验：WSL Linux 三套 41/41，通过且无 skip；未做设备验证；完整来源链另行验证。

449. **异步写回收敛测试不能以固定 timer 代表完成（2026-10-19）**

    现象：来源 run 39243648972 两路在 T1-⑥ 报零次写回，本地同样并行模式 194/194 通过。测试真因：40ms timer 到期不保证 MessageChannel 首读基线及 setImmediate 写回检查点已执行，旧判据把未完成与不收敛混为一谈；云端失败的具体调度顺序未留证。修法：先限时等待实际 describe 与首次 mutate，再保留三轮等待及精确一次写回断言，不更改插件实现、不重试失败测试。复验：Linux 全套 195/195，新增缺写回负控必超时拒绝；受控 preload 延迟 MessageChannel 180ms，旧用例 exit 1（mutates=0/describes=0）、新用例 exit 0（mutates=1/describes=4），注入器见 plugins/dsh-model-capability/test/fixtures/delay-message-channel.mjs，命令为 node --import ./test/fixtures/delay-message-channel.mjs --test --test-name-pattern="T1-⑥" test/t1-poll-cost.test.mjs；完整来源链仍需验证，未做设备验证。

450. **pi-ai 类型索引不是模型 wire id，旧夹具掩盖来源快照回归（2026-10-19）**

    现象：来源 run 39251430586 在增加实际写回等待后仍超时。真因：pi-ai 1.1.0 将目录 key 改为 chat:<id>，gen-model-catalog 仍以 key 建表而非读取条目 raw.id；真实快照缺少用户保存的原始 id，本地旧夹具却包含它。坑 449 的 timer 竞态属独立问题，并非这次云端失败的充分解释。修法：优先采用声明 id，旧式无类型 key 保持原样；类型 key 缺声明或非法 id 失败关闭，不猜测去前缀；完整目录测试逐组验证歧义，不把历史冲突组数当协议。复验：实际固定 pi-ai 包旧生成器下 T1-⑤/⑥ 均红；新生成器及真实全目录全套复验随 PR 记录，未做设备验证；需最终 main 来源链到签名。

451. **engine base 双副本比对会被 pnpm 生成文件的顺序与内嵌绝对路径打红（2026-10-19）**

    现象：PR #51 在本机用两份独立工作区跑真实 engine 构建（均 exit 0），plan 得到同一 key、capture 均成功，但 compare 失败；强制对齐 buildRun 后两份 treeSha256 仍不同，70476 条里 4 条不同（engine-deploy/package.json、engine-deploy/pnpm-workspace.yaml、reports 两份），tree 还记录了部署文件中的绝对路径 file:///workspace/...（package.json 344 处、pnpm-lock.yaml 3349 处、pnpm-workspace.yaml 1 处）。真因：capture 只对 REPORTS 里的 .json 做 rebase 与 canonicalJson 落盘，pnpm 直接写出的部署文件未归一化，依赖表、build-allowlist 与 runtime closure 回执的顺序随 pnpm 写入顺序变化，file:// 路径又绑定工作区绝对路径。旧夹具用 fixture 文本代替真实产物，所以单测全绿掩盖了这条。修复与当前证据见坑 457；绝对路径仍保持原字节，必须由新 main 的真实 compare 证明同一 runner 路径可复用，若差异仍出现则继续窄化修复。真实 materialize 尚未验证。未做设备验证；详见 ENGINE-BASE-2026-10-19.md。
452. **收窄 CI 分层时，Kotlin 对 scripts/ 的隐式读取是唯一会静默漏检的依赖（2026-10-20）**

    现象：PR Gate 对每次 push 都跑全套（24 个静态步骤 + Kotlin 编译），一个只改 workflow 的 PR 也要付约 7 分钟 Kotlin 编译。初步判断「workflow 不影响 Kotlin」是对的，但直接按目录一刀切会漏：`app/src/test` 实际 `File()` 读取 5 个 scripts 路径（`scripts/build-snapshot-013.mjs`、`scripts/patches/apply-patches.mjs`、`scripts/patches/data/undo-safe-filter-helper-snippet.mjs`、`scripts/patches/tests/fixtures/safe-mode-policy.yml`、`scripts/profile-web.cordis.patch.yml`），其中 `scripts/patches/**` 由 engine 规则覆盖、其余由 app 规则覆盖，所以只有 `.github/**`、`scripts/ci/**`、通用 `scripts/source-build/**` 可以安全地不置 `apk`。真因：这些依赖是**间接**的（测试读文件），编译通过与否看不出来，一旦漏判就是「改了脚本但 Kotlin 门禁没跑」的静默降级。修法：分类器只对上述三棵树去掉 `apk`，同时补一条不变量用例——扫描 `app/src/test` 与 `app/src/main` 的 `File("...")` 字面量，命中 `.github/`、`scripts/source-build/`、`scripts/ci/` 即判红，逼分类器跟着改。复验：`node --test scripts/ci/classify-changes.test.mjs` 13/13；把 `build` 重新置回 `apk` 的受控负控令该用例判红，恢复即绿。未做设备验证。

453. **本地门禁把步骤清单复制一份就会立刻漂移（2026-10-20）**

    现象：要把 PR 门禁搬到本地跑，最自然的写法是新建一份「本地要跑的检查」清单。真因：PR Gate 的 23 个静态步骤与 3 个 Kotlin 步骤会随 workflow 演进；两份清单一旦分叉，本地全绿而远端门禁早已增删，合并判据就变成假的——与坑 448「回归必须跟随实际执行入口」同形。修法有意反其道：`scripts/ci/local-gate.mjs` **不维护清单**，直接解析 `.github/workflows/pr-gate.yml` 的 `run:` 块，按 `docs-hygiene/static/compile` 三个 job 的既有条件挑选；只用一个小型行式读取器（不引 YAML 依赖），并由 `local-gate.test.mjs` 把 2/25/28 三个计数与 compile 的三步名钉死，格式一变就红。另：Android build-tools 的 Linux 包只有 x86-64，gate 镜像必须是 amd64，arm64 容器里 `aidl` 直接跑不起来（会报 Mach-O 或 exec format），这是选架构而非选速度的理由。复验：本地 gate 步骤数与 PyYAML 解析逐条一致（仅差 block scalar 尾部换行），`node --test scripts/ci/local-gate.test.mjs` 5/5；去掉某 job 的 `PR_GATE_MODE` 开关的受控负控令结构用例判红。未做设备验证。

454. **本地门禁不能假设「本地」就是这台 mac（2026-10-20）**

    现象：第一版本地门禁只在本机验证通过，实际依赖三处宿主特性——`docker run -v` 的 POSIX 路径、`date +%s%3N` 的 GNU 扩展、以及 bash 的 `mapfile`。真因：Windows 的盘符路径与含空格路径在 `-v` 下会错位，BSD/macOS 与 Termux 的 `date` 不认 `%N`，macOS 自带 bash 是 3.2 没有 `mapfile`；Android/Termux 则根本没有容器运行时。修法：`--mode auto|container|native`，容器可达优先，否则回退 native；挂载改 `--mount`；计时改 `node -p Date.now()`；native 模式加前置判据（bash >= 4、node >= 22.15、GNU tar、python3、Kotlin 需 JDK 与 SDK），缺件直接失败关闭并列出清单，Kotlin 必须显式 `--no-kotlin` 才跳过。复验：本机 native 实跑 21/25，四条失败全部归因为宿主缺口（bash 3.2 无 mapfile、node 20 无 zstdCompressSync、bsdtar 拒 `--sort=name`），补预检后同一宿主直接给出三条可执行提示；容器模式仍 25/25。未做设备验证。

455. **公开仓库前才发现：两个子仓 `.npmrc` 把开发机缓存路径钉进了仓库（2026-10-20）**

    现象：为转公开做历史审计时，`git ls-files | grep npmrc` 命中 `dsh-client-ui-responsive/.npmrc` 与 `dsh-shell-termux/.npmrc`，内容都是 `cache=D:/coding/dsh-mobile/.npm-cache`。真因：这两个文件在基线导入时被一并提交，把当时开发机的绝对路径固化进仓库；Linux 构建把该串当相对路径，于是在子仓下写出 `D:/coding/...` 目录并污染组件来源（坑 351 的根因）。它们同时是公开仓库里的个人信息残留。修法：删除两个文件、在 `.gitignore` 增加 `dsh-*/.npmrc` 防复发；顺带把 `scripts/deploy-embedded.ps1` 的两个硬编码（设备序列号、`D:\coding\dsh-mobile` 根目录）改为 `ADB_SERIAL` 与 `$PSScriptRoot` 父目录，并把文档里的真机序列号替换为 `<arm64-serial>`。复验：`git grep` 在 `.md/.ps1/.json` 中已无该序列号；`check-code-map` PASSED；本地门禁对同一 HEAD 树通过。未做设备验证（未改运行时行为）。

456. **`required_pull_request_reviews: null` 等于关闭「必须走 PR」，状态检查拦不住直接推送（2026-10-20）**

    现象：为公开仓启用 `main` 分支保护后，按预期配置了 4 项必需状态检查、`enforce_admins=true`、禁止强推与删除，随后一次直接 `git push origin <branch>:main` **成功**，探针提交落进 main。真因：GitHub 分支保护里「必须走 PR」由 `required_pull_request_reviews` 是否存在决定，传 `null` 是**关闭**该项而非「要求 PR 但不要审批」；而 `required_status_checks` 只对 PR 施加约束，对直接推送不生效，`enforce_admins` 与 `allow_force_pushes=false` 都不能替代 PR 要求。所以「4 项必检 + 管理员受限」看起来很强，实际仍允许直推。修法：显式传 `required_pull_request_reviews: {required_approving_review_count: 0, ...}`（单人仓无法自我批准，审批数必须为 0）。复验：修后同一路径 push 返回 `remote: - Changes must be made through a pull request. / ! [remote rejected] HEAD -> main (protected branch hook declined)`；误入提交经 PR #57 回滚（未用强推），main 树 hash 与回滚前一致；docs-only 探针 PR 的 `mergeStateStatus=CLEAN`，证明 skipped 的必检项不阻塞合并。未做设备验证（远端配置变更）。

457. **双构建 compare 必须收敛已证实的顺序差异，不能放宽树相等判据（2026-10-20）**

    现象：run 39354019902 的 resolve 和两个 replica 成功，compare 因真实输出树差异判红。真因：pnpm 在 `engine-deploy/package.json`、`engine-deploy/pnpm-workspace.yaml` 输出无序映射键序不稳定；runtime checker 按文件系统枚举顺序产出 2435 条回执，并写入 injection 与 policy reports。修法：PR #61 的 capture 仅规范两个根映射（保留条件导出顺序；YAML 序列/未知形态仍判红），依赖扫描及 resolved/failure/absence 回执稳定排序；完整逐文件 tree compare 保持硬判据，未排除文件、未改写绝对路径。复验：本机失败证据的两份 metadata 规范化相等、两份 2435 条回执排序相等；Linux local-gate 28/28、code-map、hosted PR 测试通过。main run 39357008785 的两个 build/capture、完整 compare 与 cache 上传成功，candidate `engine-v1-941e395d…7a28` 的 manifest SHA 为 `3fcc7aa6…9674053`，tree SHA 为 `fa2fe4fd…7d92600`。真实 candidate 在 Linux gate 容器 materialize exit 0，post-copy dependency check 345/2435 通过，marketplace adapter 补丁后两个 lib 文件与 main 同字节。未做设备验证；draft source workflow 尚待 lock 合入后运行。

458. **macOS `/var/folders` 别名会令真实 base materialize 的链接边界误报（2026-10-20）**

    现象：用真实 candidate 在 macOS 原生执行 `engine-base.mjs materialize`，`indexTree` 把 pnpm `.pnpm/.../zod` 链接报成 escaped/broken。真因：系统 `tmpdir()` 返回 `/var/folders/...`，`realpathSync(link)` 返回 `/private/var/folders/...`；路径边界判据比较的是物理目标与未 canonicalize 的词法顶层路径，因此对合法内部 symlink 误报。归档本身经 base-archive 安全解包通过，链接目标存在且在 `engine-deploy` 内。修法/操作：来源构建的受支持验证环境是固定 Linux gate / hosted runner；在该 Linux 语义下跑真实 materialize，**不要**为了本机路径别名削弱逃逸判据。复验：run 39357008785 candidate 在 `pocket-harness-gate:24.04` Linux amd64 临时 main clone materialize exit 0；345 packages / 2435 links 及 marketplace patch parity 通过。未做设备验证。

459. **engine base cache key 相同但 restore 仍 miss：缓存路径参与 cache version（2026-10-20）**

    现象：build-base run 39357008785 已成功保存 `base-engine-engine-v1-941e395d…-3fcc7aa6…`（main，约 680 MB），来源草稿 run 39359395963 的 `Resolve engine base key and lock` 得到相同 key，但 `Restore trusted engine base` 输出 `Cache not found`，随后正确在 `Fail closed when a trusted engine base is unavailable` 停止。真因：`build-base.yml` 保存路径为 `.deploy-tmp/base-cache`，`build-apk-source.yml` 恢复路径为 `.deploy-tmp/engine-base-cache`；GitHub Actions cache version 除 key 外还绑定 path 与压缩工具，因此相同 key 不代表相同 cache version。修法：PR #63 统一两条 workflow 的保存、恢复和 `materialize` 路径为 `.deploy-tmp/base-cache`；`engine-base-workflow.test.mjs` 跨文件断言真实执行路径一致，并用错配路径作受控负控。复验：PR #63 合并后 run 39360009635 的 primary/reference 均实际 cache hit、`materialize` 成功；该 run 后续暴露的上游 source identity 问题见坑 460。首次失败在 Release 创建前终止；本次未做设备验证。

460. **materialize 缓存剥离嵌套 `.git` 后，Git HEAD 误解析到主仓（2026-10-20）**

    现象：run 39360009635 的两路 ARM64 replica 均 restore 并 materialize 已验证的 engine base，随后 `prepare-termux-bootstrap.py` 报 `bootstrap assembly requires the official 0.2.1-rc.2 source`。真因：engine-base 把 Harness 源文件树和受校验的 source reports 放入 base，但不保留嵌套 `.git`；在 `.deploy-tmp/deepseek-harness` 执行 `git rev-parse HEAD` 会向父目录找到 Pocket Harness 主仓，于是把项目提交误当官方 Harness commit。输出 provenance 也使用相同错误的父仓 HEAD。修法：用 cache tree receipt 覆盖的 `harness-vendor-lock-reconciliation.json` 作为唯一上游 commit 证明；有嵌套 `.git` 时还必须要求 Git HEAD 与证明一致，无 `.git` 的 materialized tree 不做父仓 Git 回退；bootstrap manifest 与最终 component provenance 共用该已核验 commit，并核对 `scripts/contract.json`。复验：新增 Python 正控（无 `.git` 的 materialized tree）和缺失/错误证明、Git HEAD 不一致、symlink 证明负控；云端双构建仍待修复后重跑。首次草稿 run 未通过装配，未创建 Release；本次未做设备验证。

461. **命中可信 engine-base 缓存时，snapshot 仍须加载来源构建的有效 overlay（2026-10-20）**

    现象：run 39361687578 的 primary/reference 都通过 cache restore、materialize、Termux base 组装和 Linux 资产门禁，但 runtime snapshot 内 `pi-toolcall` 行为测试因 `@earendil-works/pi-ai` 导入 `partial-json` 时 `ERR_MODULE_NOT_FOUND` 判红；双构建、正式签名和 Release job 均被跳过。真因：无缓存来源路径运行 `build-engine.sh`，它在同一工作区把 `scripts/snapshot-config/engine-overlay.json` 改为来源构建的有效 overlay，其中以 `source-build-policy.json` 记录并加入 `partial-json@0.1.7`、摘除将由源码注入的第一方包；缓存命中则跳过该脚本，但 snapshot builder 仍读取仓库 checkout 的原始 overlay，故漏掉该运行时闭包项。修法：新增 `restore-effective-engine-overlay.mjs`，先将原始 overlay 字节 SHA 与 source-only pin receipt 对上，再逐项核对第一方摘除清单、注入回执、vendorTop 及其他 metadata；全部一致后才原子替换 snapshot 配置并写 restoration receipt。workflow 在快照构建前执行，并先留存未经后续 keepUnpublished/policy 清理改写的 effective overlay 与 policy 输入快照；restore receipt 随这两份快照进入三阶段 APK artifact，外部可按回执哈希复算。有效性漂移或 symlink 均失败关闭，不放宽 runtime dependency 或 compare 判据。复验：对之前 materialize 的真实 trusted cache report 执行 helper，恢复后的 overlay 含 `partial-json@0.1.7`；helper 六项正反例、本地 self-test 与 workflow 顺序/缺步骤负控通过。run 39361687578 在这项修复合并前按预期失败且未创建 Release；本次不做设备验证，后续必须从 main 重跑完整来源草稿链。

462. **可信 base 的 Harness 源树没有嵌套 `.git`，磁盘回收不能向父仓运行 `git clean`（2026-10-20）**

    现象：run 39366032147 的两路副本都通过 trusted base restore/materialize、runtime dependency/native 检查和快照封包，随后在磁盘回收时报 `warning: failed to remove ./: Invalid argument`、`git clean failed in .../.deploy-tmp/deepseek-harness`；双构建比较、签名和 Release job 均未开始。真因：engine-base materialization 按设计剥离嵌套 `.git`，但回收器仍在该目录调用 `git -C ... clean`；Git 向上发现工作区根部的 Pocket Harness `.git`，把缓存源树误当成主仓子路径清理。修法：snapshot 归档封存后，删除经真实 `.deploy-tmp` 边界验证的完整临时 Harness 树；用 `lstat` 拒绝普通与悬空符号链接树根，Node 递归移除内层链接本身而不跟随目标。回归自测构造外层 Git 仓库、无 `.git` 的缓存树和指向外部的内层链接，断言缓存树被移除、父仓跟踪文件和外部目标原样保留；另以悬空链接负控确认失败原因明确。复验：修复 PR 的本地与 CI 证据待记录；新 main 来源草稿链必须重新通过双构建、比较、独立签名与 artifact provenance。未做设备验证；本次草稿按用户要求不做设备验证。

463. **engine cache 不能携带旧的项目组件 provenance 输入报告（2026-10-20）**

    补证坑 462：PR #66 的 hosted PR Gate 与最终提交 local-gate 均通过，local-gate 25/25；run 39369467235 两路均通过修复后的磁盘回收。现象：两路完整 Kotlin 单测与 `build-apk.mjs` 也通过；APK 步骤随后在 `record-project-components.mjs outputs` 报 `.deploy-tmp/source-build/project-component-provenance.json` 不存在，compare/sign/Release 跳过。真因：该输入报告绑定 Pocket Harness `GITHUB_SHA`，正确地不在只按 engine 输入寻址的 engine-base `REPORTS` 内；cache hit 跳过 `build-engine.sh` 后，也跳过了原本由其生成本次报告的调用。修法：trusted-base materialize 后、来源构建分支之前，只在 cache hit 下调用 `record-project-components.mjs inputs`，以本次主仓 Git commit 和已提交组件文件重新冻结报告；保持报告不进入 engine cache，APK 后的 `outputs` 继续核对实际 lib 产物和输入报告。复验：workflow contract 正控/缺步骤与无 cache-hit 条件负控通过；PR #67 合并后的 main run 39374235296 在提交 `9ebe0fc1589a070cb2ee12417f27d89236f7153a` 上两路均通过 cache-hit 输入报告刷新、Kotlin 单测、APK 构建、独立 payload 比对与隔离签名，证据预检和 Draft + prerelease 创建成功。下载资产哈希、provenance 中项目输入与当前 commit、APK 内 `dsh-client-ui-responsive` 的 web/headless 生成输出与 provenance 均复核一致。未做设备验证；公开前仍须 ARM64 真机三层验收。

464. **ADBKeyboard 命令成功不能证明编辑成功，回读不一致后重放会重复或扩大用户输入（2026-10-20）**

    现象：ADB shell 的广播命令返回成功时，旧 manage 路径可能把它当作输入法已处理；clear-only 不读取最终字段；clear 与 input 的输出混在同一变量；回读不一致时自动清空并再次输入。真因：`AdbKeyboardService` 忽略 `InputConnection` 的 Boolean 结果，`handle` 只凭 IME 实例与 action 返回已处理；广播默认结果码不能区分服务未就绪、无连接或编辑失败；单次回读也没有足够目标身份来证明重放安全。修法：服务返回 typed status，clear 仅在完整且不超过 16,384 字符的快照上选择全字段并提交空文本；Receiver 保留原授权检查，只为有序广播回写每次结果；manage 分开解析 clear/input、未知旧壳回执按同屏回读兼容，并移除不一致后的清空重放；所有临时切换在 finally 中回读当前 IME 后尝试恢复，不覆盖用户主动切换。复验：WSL JDK 17/SDK 下 `:app:testDebugUnitTest` 1330/1330 通过；manage TypeScript 编译、插件全套 102/102、ADBKeyboard 专项 41/41、`check-code-map`、`check-bridge-symmetry`、`check-kotlin-comments` 通过。首次 Kotlin 全量运行暴露一个测试替身可返回超限长度、而 clear 事务本身信任适配器已限长的缺口；现由事务层再次执行 0..16,384 校验，定向与全量测试复过。Windows npm 使用了 Linux esbuild 原生包时不能构建 client，改在 WSL Linux Node 22 构建后成功；WSL Gradle 需显式设置仓库记录的 ANDROID_HOME/ANDROID_SDK_ROOT。按用户要求本轮不构建 APK、不做 CDP/ADB；A 仍为未关闭的 L2 事项。

465. **Cordis 插件不能读取未声明的 `ctx.filesDir`（2026-10-20）**

    现象：Huawei Mate 80 Pro Max（SGT-AL10，Android 16 / API 36，arm64-v8a）安装修复前 APK SHA-256 `862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf` 后，Linux 状态接口返回 503，当前会话没有 `linux_bash`。应用日志记录 `linux-bootstrap` 在 `apply()` 中报 `cannot get property "filesDir" without inject`，`ctx.provide('linuxBootstrap', service)` 未执行；assets 已在 APK 展开目录，runtime 尚未安装。真因：Cordis context 只允许读取声明并注入的服务；bootstrap 的 `inject` 仅含 `linuxPluginHost` 和 `linuxBootstrapConfig`，访问 `ctx.filesDir` 会立即抛错，JS 不会继续求值 `process.env.DSH_FILES_DIR` 回退。修法：`apply()` 从显式配置、已注入 `linuxBootstrapConfig.dataDir` 与 `DSH_FILES_DIR` 求出 dataDir，不读取 `ctx.filesDir`；新增真实 `Context.plugin()` + 实际 `apply()` 回归测试，并保持只激活服务、不自动安装或启用 Linux。复验：定向 Cordis 用例、Linux env 69 项（3 项 Windows 平台跳过）、vendor manifest、code-map、PR #77 CI 全部门禁以及来源 run 39424480383 的两路 ARM64 构建 / APK 规范化比对 / 签名与 SHA-256 校验通过；已创建 draft prerelease `hardening-source-f37eaafe887c-39424480383-1`，新 APK SHA-256 `a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`。修复后 APK 尚未设备复验；Bionilux、loader、guest ELF 映射、noexec 与 SELinux 均未测。

466. **Linux rootfs 硬链接只规范化源路径会误拒；Android 应用域拒绝 `link(2)` 还需独占复制兜底（2026-10-21）**

    现象：Huawei ARM64 实机点击安装 Linux 环境，解出 node 与 backend 后，在 rootfs 唯一硬链接处报 `Archive hard link must target an extracted regular file`，HTTP 500。真因：解包根来自 `resolve(destination)`（`/data/user/0/...` 词法别名），硬链接源经过 `realpath()`（`/data/data/...` 物理路径），单侧规范化使合法源恒被前缀检查拒绝；该判定发生在调用 `link(2)` 之前。修法：确认目标是新建空的普通目录后规范化根，复核规范化前后仍为同一目录且空目录，规范化失败则拒绝；源仍须是根内的普通文件。随后仅对明确的平台 link 拒绝 errno 使用 `copyFile(..., COPYFILE_EXCL)`，恢复源 mode；`ENOENT`、`EEXIST` 等未知/语义错误不回退。复验：别名根硬链接正控、越界硬链接/符号链接/符号链接目标目录负控，以及受控 `EACCES` 复制与未知错误负控通过；`check-code-map` 通过。**未做设备验证**：当前环境没有 ADB；完整离线集成测试受 macOS BSD tar 与仓库 GNU tar 参数差异阻断，ARM64 安装及之后的 rootfs 准备/健康检查仍待验证。

467. **快照覆盖前的用户文件保全失败必须中止事务（2026-10-21）**

    现象：快照合并会覆盖现存 `package.json` / `cordis.patch.yml` 等用户文件；旧保全逻辑吞掉读取、比较或复制异常后仍继续覆盖，保全副本的复制损坏也可能在提交后才被发现。真因：备份是覆盖前数据安全的前置条件，却被当作尽力而为的旁路；同时空间预算没有计入新增保留副本。修法：流式比较源/目标，内容不同才复制；逐字节与长度回读验证、同步并发布 `.pre-*` 副本；任一步失败则 fail closed，且把副本字节数纳入交换前空间断言。复验：复制异常、同长度损坏复制、成功备份和空间预算的 `SnapshotTransactionTest` 定向用例通过；未做设备验证（当前环境无 ADB）。参考上游 `bbae1ca`（2026-10-19）、`238791b`（空间反证）。

468. **事务残留回收必须用写入位置和名称证明归属（2026-10-21）**

    现象：将任意文件名包含 `.failed-` 的用户目录按旧事务残留清理，可能删除用户创建的目录；按顶层宽泛前缀扫描也会误认普通目录。真因：名称子串不构成事务所有权证明。修法：枚举只覆盖事务真实写点，并要求精确槽位名加正时间戳（例如 `usr.failed-<ts>`、`files/home/.dsh/profiles.failed-<ts>`）；stage orphan 另用精确顶层前缀。复验：已知失败残留清理、用户 `report.failed-123` / 相似前缀保留及扫描用例通过；未做设备验证（当前环境无 ADB）。参考上游 `20fda3b`、`90499e3`。

469. **配置文件替换失败不能回退到直接截断目标（2026-10-21）**

    现象：快照事务发布 profile `package.json` 或 patch 时，原子替换失败后若 `writeText` 直接写目标，磁盘故障或进程中断会截断已有用户配置。真因：用非原子覆盖兜底破坏了临时文件发布的保全性质。修法：同目录临时文件完整写入并同步后只做替换移动；移动失败时原目标字节不变，保留可诊断证据并令事务失败，不打开 live 文件截断。复验：注入发布失败后旧字节逐字节保留且事务失败的 `SnapshotTransactionTest` 用例通过；未做设备验证（当前环境无 ADB）。参考上游 `a4c44d7`、`2719d1f`。

470. **注入后鉴权门禁必须把 marker 绑定到各自归档成员（2026-10-21）**

    现象：`tar -xOf archive pathA pathB` 把多个成员内容串接到 stdout，随后对每个成员都搜索该整段输出；只要 A 含 marker，缺少鉴权的 B 也能判绿。真因：断言没有保留成员与内容的对应关系。修法：在一次流式归档扫描中按成员名分别取文本，拒绝重复项、非普通文件和超限成员，再对每个文件独立验证 marker。复验：`node scripts/check-api-route-auth.mjs --self-test` 含“B 缺 marker、A 带 B 的 marker”受控负控，并覆盖成员缺失、重复与链接；通过。来源链正式快照因无可用设备不影响 L1 门禁证据；完整 snapshot 输入的集成读取需在来源构建中复验。参考上游 `8edfdb8`。

471. **来件清理不能把未知引用当作空队列，待发清单必须串行原子发布（2026-10-21）**

    现象：pending ledger 或 `.sessions` 读失败曾返回空列表，task-removed/TTL 清理可删掉仍待投递或待 claim 的文件；并发 enqueue 与 flush 的整文件写回也可丢掉新条目。另有时序问题：先增加 activeDeliveries 再调用 TTL sweep，sweep 因“投递在途”跳过，导致每次来件都绕过 TTL。真因：缺失与不可读共用空值、ledger 写者与删除者无共同所有权锁、清扫与 reservation 顺序倒置。修法：空 ledger/不存在 queue 才是空列表；已有索引无法完整解析返回 null 并使整轮清理让路；cleanup、TTL 与 ledger read-modify-write 共用锁；先清扫、同锁预留投递窗口；完整 ledger 写入并 fsync 同目录临时文件后替换 live 文件。复验：`FileIncomingCleanupTest` 覆盖未知 schema、损坏索引、读取失败、保留引用、TTL 过期/目录跳过、清扫预留顺序、ledger 写入失败保留旧字节和临时文件回收。未做设备验证（当前环境无 ADB）。参考上游 `e5330fe`、`fc93163`。

472. **rc.2 来件草稿导航由 uiWorkspace 持有，不是 sessions.open（2026-10-21）**

    现象：来件 consumer 可拿到新建 sessionId，但调用 rc.2 `sessions.open()` 没有把 WebView 导航到草稿，后续 composer scope 不出现、claim 不应发生。真因：`sessions` 服务保留身份/查 scope，页面导航属于 `uiWorkspace`。修法：通过 `incoming-runtime.ts` 适配器统一 `connectWorkspace` 与 `openSession`，并保持 claim 在导航目标 scope 可用之后。复验：`incoming-runtime.spec.ts` 断言 Sessions 面没有 `open`、导航通过 `uiWorkspace.openSession`，且仅在目标 scope 出现后执行 claim/附件挂载；插件 753/753 通过。`npm run typecheck` 仍被未改动的 `conversation-dock.tsx:137-138` 类型错误阻断，设备/CDP 未做。参考上游 `5a6761b`。

473. **profile 自愈必须先完成唯一备份，再原子替换 live（2026-10-21）**

    现象：旧 profile repair 在 `.pre-<version>.bak` 已存在时不保存本轮当前内容；备份写失败也继续覆盖 live；临时 rename 失败后直接 `target.writeText` 截断 YAML。真因：备份路径固定且失败被忽略，原子发布失败被当作可降级的普通写入。修法：每次修复先把 live 原始字节写入独立临时文件、flush/fsync 并逐字节校验，再发布到唯一 `.pre-<version>-<random>.bak`；replacement 同样写入并同步 sibling 临时文件，只有原语发布成功才算修复；任一步失败保留 live 原字节并将启动标记留待重试。复验：`SnapshotFsTest` 覆盖两次唯一备份、备份发布失败、live 发布失败与字节保全；`FactoryProfilePatchTest` 锁定 EngineManager 调用安全原语、不再直接写 live。未做设备验证（当前环境无 ADB）。参考上游 `c1d5a29`。

474. **冷启动必须等引擎 HTTP 与首个有效页面提交后再交接 WebView（2026-10-21）**

    现象：用户截图依次出现本地 `ERR_EMPTY_RESPONSE`、空白窗口和 Harness「Loading plugins…」。真因：`configureWebView()` 只检查 `EngineTransport.ownsPort()`（本地 relay 已绑定），就提前导航；引擎进程存在也曾直接走 `showWeb()`，没有证明 HTTP 已响应。与此同时 WebView 与 `GuideChrome` 初始都为 `GONE`，透明根容器短暂露出浅色 window background；引擎就绪后又在页面提交首帧前隐藏引导页。修法：根容器同步使用 `ds_bg` 并首帧显示原生启动页；EngineStartFlow 对「进程已归属但 HTTP 未就绪」使用有界等待；仅 HTTP 响应后设置 `engineHttpReady` 并开始首次导航；首个引擎页面提交前保留启动页，且不把 WebView 的传输错误页当作有效首帧。复验：Kotlin 单测 1355/1355 通过，`node scripts/check-code-map.mjs` 与 `git diff --check` 通过；当前 ADB 列表为空，CDP / ADB 用户体验验证未做。

475. **离线 Linux 安装仍会在 rootfs 准备时因 Termux `find` 动态链接失败（2026-10-21）**

    现象：更新日志确认 APK 内置的 backend、rootfs、Node 与插件资产复制、SHA-256 校验和解包均成功，安装全程离线；`prepare-rootfs.sh` 调用 `$PREFIX/bin/find` 时返回 `Permission denied`。同一日志的正反实验证明：保留宿主 `LD_LIBRARY_PATH=$DSH_FILES_DIR/usr/lib` 时成功，过滤后找不到 `libandroid-support.so`。真因：runtime manager 的宿主环境规则丢弃该路径，Termux `find` ELF 的旧 `DT_RUNPATH` 指向不可用的 `/data/data/com.termux/...`。修法：manager 只从应用 `DSH_FILES_DIR/usr/lib`（或明确 Termux prefix）校验并传递宿主库目录；Bionilux 首次进入 guest 时剔除宿主值，但允许 guest 为自身子进程设置值；rootfs 错误带稳定码，bootstrap 持久化详情并向页面返回脱敏摘要。复验：runtime manager 28/28；新增 route 与跨 bootstrap 重启错误状态用例通过；source manifest 37 文件、bootstrap vendored source、code-map 通过。未做设备验证；Linux-env 全套在本机 71/78（其余为 `/var` 别名、ESM fixture 解析和 BSD tar 选项环境失败）；Bionilux Rust 回归因离线缓存缺 `clap` 未编译。故不宣称 Linux 环境已恢复。

476. **Android 宿主 `spawn` 必须携带 termux-exec，exit 0 也不证明 GNU 工具执行成功（2026-10-21）**

    现象：第二份实机日志显示资产和插件 SHA 已变、`LD_LIBRARY_PATH` 已补，但 `prepare-rootfs.sh` 仍在 `find` 报 `Permission denied`；用户给出的矩阵确认只有完整 shim 环境才执行到 GNU findutils 4.11.0。仅传 `TERMUX_APP__DATA_DIR` 会 exit 0，却实际调用 toybox `find`。真因：壳侧 `EngineManager.shellEnv()` 已设置 `LD_PRELOAD`、`TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1`、`TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`、`TERMUX__PREFIX` 和 `TERMUX_APP__DATA_DIR`；runtime manager 的白名单重建环境时仍全部丢弃，Android 不允许直接 exec app-private ELF。Bionilux 也未清理新增宿主变量，且 shebang overrides 在清理后应用。修法：`hostExecutionEnvironment()` 从 `DSH_FILES_DIR/usr` 派生并校验 preload/库目录、固定 Termux PATH 与完整拦截变量；rootfs 前识别 GNU `find`/`sed`/`wc`，toybox 假成功即以 `linux-host-toolchain-unavailable` 失败；Bionilux 对 guest overrides 再执行宿主变量清理并强制保留 glibc preload、过滤 termux-exec preload。错误提示改指 `files/linux-environment/linux-bootstrap-state.json` 的 `lastError`；Linux release/bootstrap/runtime 版本升至 0.5.1。复验：manager 30/30；route 错误文案定向用例 1/1；code-map、37 文件 Linux source hash、自检与 bootstrap vendored 自检通过；Rustfmt 与插件 TypeScript build 通过。Rust tests 未能编译（本机缺 `clap` 缓存且 crates.io DNS 不可达）；本机完整 Linux-env/Python 资产套件仍有既知 macOS `/var` 别名、ESM fixture、非 GNU tar 环境失败。未做实机测试，不能据此宣称恢复。

477. **GNU 工具版本行可能以绝对 `argv[0]` 开头，Android DNS 必须跟随当前默认网络（2026-10-22）**

    现象：`sed --version` exit 0 且正文含 `sed (GNU sed) 4.10`，但宿主预检仍报 `linux-host-toolchain-unavailable`；预检通过后，rootfs 也没有 `/etc/resolv.conf`，guest 的 `apt update` 无法解析域名。真因：termux-exec linker 把 `argv[0]` 改成 app-private ELF 的绝对路径，`^sed` 误判真正的 GNU sed；`_prepareRootfs` 没有把 Android DNS 传给已有 `prepare-rootfs.sh --dns`，虽 Bionilux 有 `BIONILUX_DNS_SERVERS` 通道，壳侧从未提供当前 resolver，且 preload 只解析 IPv4。修法：三个 GNU 正则允许可选路径前缀；`LinuxDnsServers` 读取并跟踪 Android 默认网络 DNS，通过原子替换写私有状态文件，写入前核对回调仍属于当前默认网络，runtime 在 rootfs 准备与每次 guest spawn 时重新读取；Bionilux resolver 支持 IPv4/IPv6。Android API 28+ 的 Private DNS 活跃时遵守系统要求，不向明文 resolver 发查询，而是清空旧 rootfs nameserver 并 fail-closed；状态更新失败时删除旧 resolver 文件并记录错误，防止静默沿用前一网络地址。当前 guest 暂不支持 Private DNS 网络解析。runtime、Linux 资产版本升至 0.5.2。复核状态与设备边界见 [2026-10-22 修复记录](../linux-env-findings/REMEDIATION-HOST-TOOLS-DNS-2026-10-22.md)。

478. **targetSdk 29+ 不能直接执行 app 私有目录 ELF，glibc loader 不能交给 Bionic linker64（2026-10-22）**

    现象：同 APK 解出的 Bionilux 能 `--print-config`，但一旦运行 Debian ELF 就在 `execve(rootfs/lib/ld-linux-aarch64.so.1)` 报 EACCES；用 `/system/bin/linker64` 包 glibc loader 又报 `Could not find a PHDR`。直接从 app 私有目录执行 toybox 也失败。真因：Android 对 targetSdk 29+ 的 app 私有可写目录禁止直接 exec；Termux 的 linker64 代理只适用于 Bionic ELF，Debian glibc loader 的 PHDR 布局不能被 Bionic linker 装载。降 targetSdk 会放宽整个应用的执行安全策略，与项目基线不符。修法：来源链把同一构建的 Bionilux launcher 和 rootfs glibc loader 放进 APK `jniLibs/arm64-v8a`；legacy packaging 让 PackageManager 安装到 `nativeLibraryDir`；manager 区分 host Termux 子进程与 Bionilux 执行环境，先 probe native launcher，再以 `BIONILUX_LOADER` 指定同源 loader；安装后的 Node `--version` smoke 证明 guest ELF 动态装载前不交换 active。rootfs 将 `libc6:arm64` 与 `libc-bin:arm64` 设为 apt hold，版本随 provenance 留证，常规 apt 不会把 loader 与 guest glibc 拆开；强制绕过 hold 仍可能造成不匹配。最终 APK checker 对照两份 `.so` 的成员、压缩/提取条件、大小与 SHA-256，拒绝 strip 或改写。受控 hard-link copy fallback 仅对普通文件生效；O_NOFOLLOW 加设备/inode 复核抵御源路径替换，Linux 资产 workflow 增加跨文件系统集成用例并等待 CI。复验：runtime manager 33/33；Linux native ELF checker 自检和 APK payload checker 的篡改、未提取与非普通文件负控通过；本轮尚无真实 APK CI 或设备证据。未解决前不降低 targetSdk、不宣称 Linux 已恢复；nativeLibraryDir exec、guest 映射、多级子进程与 dpkg 实机仍需 ARM64 验收。详见 [执行入口修复记录](../linux-env-findings/REMEDIATION-ANDROID-EXEC-2026-10-22.md)。

479. **APK 新输入必须跨过来源链磁盘回收点（2026-10-22）**

    现象：APK 组装新增依赖 `.deploy-tmp/linux-build/native-libs`，但来源链在快照封包后运行 `reclaim-build-disk.mjs`，该工具原先删除 `linux-build` 下除 provenance 外的所有内容，后续组装会因 native launcher/loader 缺失而中止。真因：磁盘回收清单按旧消费者边界把整个 Linux 构建目录都视为 snapshot-only，未随 APK 新输入更新。修法：清理时明确保留 `native-libs` 与 provenance；self-test 构造并断言 native launcher 穿过清理点；Linux asset workflow 的 path filter 显式包含新增 preload 集成测试文件。复验：`reclaim-build-disk.mjs --self-test` 与来源链相关 workflow 用例通过；没有设备验证。引用：本轮 Linux nativeLibraryDir APK 接入。

480. **BSD `stat` 的 `%Lp` 会丢掉 sticky bit，rootfs 自检误拒绝模式正确的 `/tmp`（2026-10-22）**

    现象：在 macOS 上运行 `prepare-rootfs.sh --verify`，Debian rootfs 的 `/tmp` 实为 `1777`，却被报告模式错误；GNU/Linux 上同一检查通过。真因：BSD `stat -f %Lp` 输出 `777`，不包含 sticky bit。修法：BSD fallback 改读 `%p`，剥去目录文件类型位后再比较权限；GNU stat 路径保持不变。复验：rootfs prepare/verify Python 测试在 macOS 通过，并覆盖 sticky bit 缺失的负控；Linux CI 仍须复核。

481. **删除 rootfs 前必须检查其全部后代挂载点（2026-10-22）**

    现象：rootfs 重试清理只检查 `/dev`、`/proc` 两个预期挂载点；若上次运行在其他深层目录留下 bind mount，递归删除会进入仍挂载的树并可能删错数据。真因：固定点检查把「预期挂载清理」误当成「目标目录无任何 mount」。修法：从 `/proc/self/mountinfo` 解码转义路径，按路径祖先关系检查 rootfs 本身及全部后代；mountinfo 不可读或格式异常一律拒绝删除。复验：纯函数用例覆盖 rootfs 本身、深层挂载、空格转义、相似前缀和损坏输入；未做 Android/PRoot 设备验证。

482. **PRoot 许可 provenance 检查必须自身有可执行测试**

    现象：Linux backend 第三方许可检查遍历 provenance 指定的 license 文件时调用 `lstatSync` 与 `relative`，但模块未导入这两个符号；旧测试只运行快照 dpkg 许可路径，不带 PRoot provenance，因此此发布路径会在构建期触发 `ReferenceError`。修法：显式导入文件与路径原语，增加完整 PRoot provenance 正控和 license 符号链接负控，并把测试纳入 Linux assets PR workflow。复验：`node --test scripts/check-third-party.test.mjs`；设备验证不适用。

483. **硬链接降级复制必须原子发布，且复制上限要约束实时字节数**

    现象：TermFold 兼容层原先直接以 `O_EXCL` 创建最终目标后再拷贝；普通错误会 unlink，但 guest 进程若在写入期间被杀，半文件会留在目标名下，使 dpkg 重试撞 `EEXIST`。源文件若在复制期间增长，初始 `st_size` 上限也不能限制实际写入量。修法：副本改写入同目录隐藏临时文件，按累计读取字节执行 1 GiB 上限，源 inode/元数据复核及权限/时间戳完成后 fsync，再以 `renameat2(RENAME_NOREPLACE)` 发布；普通失败清理临时文件，进程中断至多留下不占目标名的隐藏残片。复验：Linux preload 集成测试覆盖成功发布、写入失败清理及复制中 SIGKILL 后最终目标仍不存在；设备/PRoot 侧 renameat2 与 dpkg 重试待 ARM64 验收。

484. **APK native payload 核验要拒绝符号链接输入，并把生成资产的脚本带入来源证明**

    现象：APK 核验脚本先对 native library 根目录调用 `realpath`，会把符号链接静默规范化；Linux 资产 provenance 包也未包含生成签名 Termux 软件包闭包所需的引导、索引验证脚本和回归测试，拿到该包无法完整复查构建步骤。来源归档原先还把 bootstrap 插件整个目录归档；该步骤在 `npm ci` 后执行，可能混入未审阅且不由来源清单固定的 `node_modules`。真因：校验信任了路径规范化后的目标，来源归档清单覆盖不足且将运行目录当作源码目录。修法：核验 provenance、native root 与 ARM64 子目录必须为普通文件/目录；来源证明包明确纳入 Termux bootstrap、签名索引验证、后端组装、ELF/APK 核验、许可矩阵及关联测试；bootstrap 只归档明确的插件源码、元数据和测试路径，不含安装依赖目录。Linux 资产 workflow 的路径过滤同时覆盖构建链实际读取的预装清单、shell helper、Termux bootstrap、profile seeder、许可矩阵和发布来源 workflow。复验：APK 核验 self-test 加入符号链接 native root/ABI 负控；来源归档内容和 Linux asset workflow 过滤仍待验证。

485. **PRoot guest 不能绑定整个宿主 `/proc`**

    现象：runtime 将 Android 宿主 `/proc` 整棵映射进 guest，而引擎父进程环境含 `DSH_PICK_TOKEN`、`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`。在允许同 UID 进程读取的设备策略下，guest 可尝试从 `/proc/<pid>/environ` 或 `/proc/<pid>/root` 越过显式 workspace bind，接触引擎环境或 app 私有路径；本轮只有源码证据，未在设备上证明特定 ROM 的访问结果。真因：把 PRoot 的 `-b /proc` 当作普通 Linux 功能补齐，忽略了它是宿主路径映射，不会创建隔离 procfs。修法：移除 guest 的宿主 `/proc` bind，并在 runtime 命令构造回归中断言它缺席；兼容 preload 的 `/proc/self/fd/N` 分支从已有 fd 复制，不要求 guest 能浏览宿主 procfs。明确记录依赖 guest procfs 的程序可能不完整；PRoot 内部为翻译被跟踪文件描述符仍使用宿主 procfs。复验：`node --test vendor/dsh-linux-runtime/test/*.test.mjs` 31/31、Linux 来源哈希与 code-map 通过；未做 APK、云端 CI 或设备验收。

486. **Termux provenance 必须与生成脚本的输出目录一致**

    现象：Linux 资产专用 workflow 将 `TERMUX_PROVENANCE` 指向 `webroot/termux-packages-provenance.json`，但签名仓库准备脚本把文件写在 `webroot.parent`；PR 检查通过后，手动资产构建会在 PRoot 包组装阶段因 provenance 缺失而失败。真因：workflow 输入路径与生成脚本输出路径分开维护，没有跨文件契约检查。修法：workflow 与 APK 来源链都把 provenance 指向 webroot 的同级目录；`linux-assets-workflow.test.mjs` 对两个 workflow 的 webroot/provenance 关系加正向断言，并以嵌套进 webroot 的旧路径做负控。复验：本地 workflow 契约测试与 YAML 解析通过；未触发 CI、资产构建或设备测试。

487. **Termux 包版本锁与可重复构建锁是两个层次**

    现象：Termux stable 会随上游发布推进；签名和 `.deb` 摘要能证明某轮输入可信，却不能保证同一提交跨时间取得相同包。真因：把签名认证、固定 recipe、每轮包版本选择和跨时间 artifact 归档混为一种锁。修法：recipe 固定在不可变 commit 并校验文件 SHA；每轮验签并记录精确包闭包，APK 两路 builder 共享本轮 artifact；跨时间复现仍需另建不可变包归档。复验：PR #105 实现与远端构建结论待回填，见坑 506。

488. **Android 原生执行目录应由显式路径识别，不依赖系统环境标记**

    现象：壳侧总会注入 `DSH_LINUX_NATIVE_LIBRARY_DIR`，但 runtime 曾只在 `ANDROID_ROOT` 存在时选择 APK nativeLibraryDir；若系统启动环境缺少该标记，就会回退执行 app 私有目录中的 PRoot，撞回 Android 的 ELF exec 限制。真因：执行目录能力通过显式配置传入，平台判断却依赖另一份可缺失的隐式环境变量。修法：`ANDROID_ROOT` 或显式 native library 路径任一存在即按 Android 路径处理；native 路径不完整时在下载/安装前失败关闭。复验：runtime 回归用例删除 `ANDROID_ROOT` 后仍断言使用 APK 原生目录与当前 DNS；未做 APK/设备验证。

489. **Linux 资产 CI 不得依赖本地忽略的插件 `lib/` 产物**

    现象：PR 检查在开发机通过，但干净 runner 编译 `dsh-android-linux-env` 时找不到 `@dsh-android/dsh-android-bridge` 与 `dsh-shell-termux` 声明。真因：这些 `file:` 依赖的 `lib/` 被 `.gitignore` 排除，开发机残留构建物掩盖了 workflow 未构建依赖源码的缺口。修法：Linux assets workflow 按源代码分别 `npm ci`、`npm run build` 生成 shell-termux 与 bridge 产物，再编译 linux-env；路径过滤同时覆盖这两个上游输入。复验：PR #90 的干净 runner 暴露失败；需以修复提交后的 GitHub Actions `build-linux-assets / validate` 全绿确认。

490. **Termux 签名索引里的 foreign-architecture 依赖分支应被跳过**

    现象：解析有效的 Debian 依赖 `arch-native [aarch64] | arch-other [amd64]` 时，构建器把 `amd64` 当成未知语法并中止。真因：把目标架构白名单误用作整个 signed Packages 索引的语法白名单；其他架构的有效替代项在目标 AArch64 构建中应不适用，而非损坏。修法：校验架构 token 的语法，再按 AArch64/arm64 目标语义筛除 foreign 分支，并覆盖否定条件与 `linux-any`；未知语法仍 fail closed。复验：纯解析用例无需 `dpkg` 即覆盖 foreign、否定和 Linux wildcard；完整依赖闭包由 Linux CI 验证。

491. **兼容层故障注入夹具必须先通过文件大小上限检查**

    现象：Linux CI 的硬链接复制失败/中断用例立即返回 `EFBIG`，没有进入注入的写入错误或进程停止路径。真因：测试文件大于该测试库设置的 1 MiB 复制上限，预检提前拒绝，故障注入断言实际没有覆盖原子发布中断。修法：夹具保持大于注入阈值、同时低于复制上限；另为变更 provenance 的测试设置与 signed index 不同的版本。复验：PR #90 首轮 CI 失败已定位；需以修复提交后的 Linux preload 回归全绿确认。

492. **Termux signed Packages 索引可合法包含同包的多个版本**

    现象：来源链已成功验证官方 `InRelease` 与 `Packages.gz` 签名摘要，却在读取 `buf` 条目时因重复包名退出；实时索引同时含 `1.75.0` 与 `1.74.0-1`。真因：把 Debian/Termux 索引的多版本记录误判成签名索引损坏，未应用 apt 的版本候选选择。修法：限定 AArch64/`all` 记录，按 `dpkg --compare-versions` 选最高版本，同版本优先 native AArch64；同版本同架构重复项仍 fail closed。复验：新增多版本、架构无关同版本和冲突重复候选用例；PR #90 草稿构建首轮实测暴露，follow-up Linux CI 与来源构建需重验。

493. **Debian epoch 冒号只应在签名包文件名中放行**

    现象：PR #91 的 Linux CI 已验证签名与多版本选择后，来源构建在有效路径 `pool/main/c/ca-certificates/ca-certificates_1:2026.10.20-1_all.deb` 被“unsafe”拒绝。真因：路径防护把目录分隔与遍历风险和 Debian 版本 epoch 共用的 `:` 混为一谈。修法：只接受 `pool/main/` 下安全字符组成的相对目录和 `.deb` 文件名；允许 `:` 出现在最终文件名中，目录、URL 查询/片段、绝对路径和 `..` 仍拒绝。复验：PR #92 Linux CI 的 epoch 正例及路径负例通过；来源运行 39739105595 证明下载器路径校验已通过，但暴露 backend 有独立索引解析器，见 #494。

494. **signed Termux 多版本索引的每个消费者都必须选同一候选**

    现象：来源运行 39739105595 已通过验签、最高版本选择、epoch 路径检查与 Termux base 组装，随后在 PRoot backend 报 `duplicate package stanza in signed Termux index: buf`。真因：`prepare-proot-backend.py` 另有一份索引解析器仍假设每个包名只有一个 stanza，并重复维护一套更严格的包路径检查。修法：两端共用 `termux_signed_packages.py` 的 Debian 版本排序和安全路径校验；backend 继续将 provenance 与所选最高版本逐字段精确比较，禁止回退到较旧的有效签名版本。复验：PR #93 Linux CI 的 54 项源码测试和 Linux 资产验证均通过，来源运行 39742450604 已越过索引处理后暴露新的通用许可证链接问题，见 #495。

495. **Termux 通用许可证链接必须只从已校验的共享目录解析**

    现象：草稿构建运行 39742450604 的 primary 与 reference 都通过签名索引和 Termux base 组装，在构建 PRoot 资产时 `copy_copyright()` 对 `share/doc/libtalloc/copyright` 调用严格解析，因目标 `/usr/share/LICENSES` 未随单个 `.deb` 解出而报 `FileNotFoundError`。真因：Termux 将通用许可证文本集中放在 `share/LICENSES`，各包的版权文件用相对链接引用；当前构建按包隔离解包，未安装完整依赖树。修法：只将规范化后仍位于包内 `share/LICENSES` 的缺失目标映射到经过校验、非符号链接且位于官方 bootstrap 内的 `share/LICENSES`；将复制结果记录为 official bootstrap 来源，并拒绝绝对/越界、其他缺失目标和缺失共享许可证。复验：PR #94 Linux CI 与完整签名资产运行 39745151541 均通过；产物 provenance 记录 libtalloc 和 PRoot 分别来源于官方 bootstrap 的 `GPL-3.0.txt`、`GPL-2.0.txt`，libtalloc 许可证 35,149 字节的 SHA-256 为 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`，并与后端 tar 和 provenance 副本一致；本地共享链接正例、包路径逃逸负例、缺失共享文件负例与 bootstrap 目录链接负例通过。未做设备测试。

496. **Termux PRoot 版本探针必须识别其 ASCII 横幅中的裸版本号（2026-10-22）**

    现象：用户设备中的 APK-native PRoot 正常启动、退出码为 0，并输出带 `5.1.107.98` 的 Termux ASCII 横幅；Linux 安装仍在下载与解包之前报 `linux-host-exec-assets-unavailable`。真因：runtime 两处安装探针只查找字面文本 `PRoot v<version>`，将受信 APK 资产实际采用的横幅格式误判成版本不匹配。修法：校验输出中完整且与 release manifest 精确一致的四段版本 token，允许有无 `v` 前缀，并保留超时、非零退出码及错误版本的拒绝。复验：`node --test vendor/dsh-linux-runtime/test/manager.test.mjs` 33/33；新增实际 ASCII 横幅正例与 exit 0 错版本负控；Linux source manifest 摘要更新。未构建 APK、未做设备复验。

497. **Android Shell 的受限档位没有真实围栏时必须在 spawn 前拒绝（2026-10-22）**

    现象：`dsh-shell-termux` 曾将 `sandboxPolicy.mode`、工作区与共享目录写入环境变量后直接运行 `bash -c`；`read-only` 和 `workspace-write` 因而仍能访问 app UID 可达路径，返回的 `enforcement: partial` 没有执行门作用。真因：把诊断标签及 Android app-domain 边界当成了任意 Shell 命令的路径围栏。修法：`resolve()` 捕获每次调用的策略，`execute()` 在 bash 探测与 spawn 前拒绝无真实围栏的受限档位；`danger-full-access` 必须由本次会话显式选择，并如实标记 app-domain 部分边界。修正快照装配注释与插件文档，增加受控回归和 PR Gate。复验：`dsh-shell-termux/npm test` 4/4、`node scripts/check-code-map.mjs` 与维护文档门禁通过；**未构建 APK、未做 CDP/ADB 设备验证**，真实路径围栏与秘密隔离仍是缺口。

498. **能力组撤销与解锁必须等待持久状态写入成功**

    现象：`relock()` 先从内存集合删除授权，再调用吞掉异常的 `store.write()` 并报告成功；旧授权文件在写/rename 失败时仍在，重启会重新解锁。首次解锁写入失败也会先 dispose 当前锁，错误地承诺跨重启生效。真因：存储 API 不返回成功状态，调用方把“尝试写”当成“已原子提交”。修法：`UnlockStore.write()` 返回布尔结果；解锁先将新全集原子落盘，成功后才更新内存并释放锁；失败则保持锁定并回 `ok:false`。撤销即使落盘失败仍立即锁住当前 agent，但返回失败且明确提示旧授权可能在重启后恢复。复验：授权/撤销写失败、rename 失败及模拟重启用例通过；bridge `npm test` 167/167，完整 bridge 测试目录 173/173，**未做 APK/设备验收**。

499. **浏览器权限档必须落到统一执行闸（2026-10-22）**

    现象：`BROWSER_TOOL_CONTRACTS` 将网页操作标成 `approval`、身份切换标成 `confirm`、截图标成 `full-access`，但 `tools.ts` 的逐工具 `gate()` 恒返回允许，契约没有任何执行效力。真因：为避免把浏览器误当 ADB/无障碍设备控制而复用 `gateFor()`，实现把“不要套设备控制档位”错误扩展成“浏览器完全不做逐项授权”。修法：`index.ts` 在 `tools/pre-execute` 按契约向审批服务请求本次许可，身份切换必须连续两次 `allowed-once`；审批拒绝、取消、服务缺席/异常均不执行工具体；`tools.guard` 在所有可扩展 listener 后单调拒绝无批准记录的调用。截图单独校验当前会话的 `sandboxPolicy.overrideOf(session)` 和 `resolve({session})` 都是显式 `danger-full-access`，部署默认不够；运行时没有 monotonic guard 时，所有非只读浏览器工具在 pre-execute fail-closed。复验：`plugins/dsh-android-browser/npm test` 23/23，覆盖拒绝/允许、双重确认、guard、默认档不放行、服务缺席及无 guard 负控；**未构建 APK、未做 CDP/ADB 设备验证**。

500. **会话导出 DownloadListener 没有可验证的用户手势（2026-10-22）**

    现象：主 frame 导航按 `request.hasGesture()` 拦截 `/api/session.export`，但 WebView `DownloadListener` 不提供手势或 frame 来源，旧回调仍会直接进入 `DownloadSaver`，由壳附加引擎 Cookie 并保存会话 ZIP。真因：把精确 URL 校验误当成用户意图证明；该回调签名无法证明触发来源。修法：`DownloadSaver.downloadToDownloads` 必须接收并复核手势布尔值，只有 `shouldOverrideUrlLoading` 传来的真实手势可启动请求；`DownloadListener` 命中精确导出端点只记录拒绝，不调用下载器。复验：`EngineAuthPolicyTest` 覆盖精确 endpoint + 有/无手势、错误路径与非 GET；**未构建 APK、未做 CDP/ADB 设备验证**，真实 WebView 回调顺序与普通用户导出流程仍待设备复现。

501. **已删除 Session 会因轮询集合自引用而保留 BrowserHost（2026-10-22）**

    现象：会话从官方列表删除后，原生 BrowserHost WebView 与工作区仍由 Activity 持有；`NativeBrowserPlacement` 的轮询集合把 `workspaces.keys()` 再并回会话集合，所以旧键永不自然退出。真因：客户端把“曾访问过”误当成“仍存活”，而 `browserClose` 只关闭当前工作区、HMR dispose 又刻意保留原生页面。修法：仅对曾出现在官方会话列表、随后连续三轮缺席的 Session 进入退休态；关闭它遗留的 Sidebar occurrence，再通过精确 Session 的 `workspaceClose` 销毁全部 WebView 并请求 `ProfileStore.deleteProfile` 删除隔离 profile；失败保持退休态并重试。显式 shared compatibility 不清全局 Cookie jar；ProfileStore 可能异步完成磁盘清理，不承诺立即擦除。复验：Kotlin `BrowserHostCommandWiringTest` 与 TypeScript `tsc` 通过；临时 Node 回归覆盖跨会话、短暂缺席与清理重试。Vitest 未能启动（本机缺 `@esbuild/darwin-arm64`），tsdown 还缺可选 peer `unrun`；**未构建 APK、未做 CDP/ADB 设备验证**。

502. **Termux 签名成功还不足以固定 Linux 来源输入（2026-10-22）**

    现象：同一 Pocket Harness 提交重跑时，Termux `stable` 可以发布新索引并改变依赖闭包，`termux-packages/master` recipe 也会变化。真因：把本轮输入可验签误当成同一提交未来必然取得同一滚动输入。修法：recipe 使用固定 commit 和文件 SHA-256；InRelease 保持为每轮经过 bootstrap keyring 验证的输入，记录摘要与包闭包到 provenance，同一来源 workflow 的双路构建消费同一快照。每轮包输入可因上游发布而变化，跨时间复现需要另行归档这些输入。复验：由后续滚动仓库故障及修复记录见坑 506；Linux 来源 runner 执行真实签名与包验证。

503. **Auto Review 高风险拒绝必须绕过用户审批并由单调守卫收口（2026-10-23）**

    现象：项目把 Auto Review 设为默认后，上游实现允许一般 reviewer 拒绝进入用户审批，且原生工具之外的 PTC `run_code` 外层源码不经审查；reviewer 插件卸载时还会把活跃会话切到 `danger-full-access`。真因：上游按通用审批策略处理所有拒绝、把 PTC 外层视作传输层，并以全权限作为生命周期回退；这不符合本项目 Android 执行边界和用户对 high 风险的硬拒绝决定。修法：profile 显式挂载固定版 Auto reviewer；检查 Auto 为权限可用但在 reviewer 缺席时逐工具 fail-closed；审查 `run_code` 外层及原有内层调用；high 结论在 `tools/pre-execute` 直接拒绝，不调用 `next()` 或读取用户可覆盖审批策略，并将当前 exec 记入 `WeakMap`，以 `ctx.tools.guard` 在后续 hook 后再次拒绝；medium 拒绝保留逐次用户确认；reviewer 退出时回退到 Android shell fail-closed 的 `workspace-write`。风险提示说明 Auto 使用应用 UID、无路径级沙箱、模型可能误分类，且切换当前会话权限档位会停用 Auto。复验：Node 24 下 `node --test scripts/patches/tests/permission-auto-review-default.test.mjs` 3/3；`node scripts/check-patch-test-manifest.mjs` 31 个文件、72/72；`node scripts/check-patch-fixtures.mjs` 与 `--self-test`、`node scripts/check-code-map.mjs` 通过。测试覆盖三个固定 0.2.1-rc.2 npm 包、语法/幂等、high 无审批路径与 guard、medium ask、low allow、PTC 外层审查、runner 集成及保留 marker 但删 guard 的负控。环境无 `adb` 可执行文件；**未构建 APK、未做 CDP/ADB 设备验证**。

504. **新增 Cordis profile 顶层项后要更新真实工厂结构断言（2026-10-23）**

    现象：PR #103 中 Auto Review 已编译，但 Kotlin `FactoryProfilePatchTest.realFactoryFileSelfMergeIsByteIdentical` 与 `realFactoryMissingSiblingIsRestoredIntoItsOwnGroup` 仍按旧 profile 的 24 个块断言，导致 1359 个单测中 2 个失败。真因：这两个测试同时锁定 profile 的逐字节合并行为和顶层块数量；新增 `permission` 与 reviewer `insert` 各增加一个顶层块，数量断言没有随产品配置更新。修法：把结构基线更新为 26 个块（25 个顶层条目加注释头块），继续单独断言 `shell-termux` 与 `host-web-compat` 的组内关系。复验：本地 `./gradlew :app:testDebugUnitTest --tests 'com.snoworwind.pocketharness.FactoryProfilePatchTest' --no-daemon --stacktrace` 通过；PR #103 修复后的远端 Kotlin 门禁待重跑。

505. **Workspace Write 名称不等于 Android 全工具路径隔离（2026-10-23）**

    现象：用户可能把 `workspace-write` /「工作区内修改」理解成所有工具都被限制在工作区；Android 当前没有覆盖全部原生工具和插件的路径级文件系统沙箱。Termux Shell 对该档位会在启动 bash 前失败关闭，而其他工具按各自实现访问应用 UID 可达资源。真因：上游档位名称表达通用权限语义，不能证明 Android 每个执行器都提供路径围栏。修法：当前会话选择器、新会话默认设置和 `/permission` 命令在切换到该档位前弹出需勾选确认的有限性说明；选中后保留说明，并准确标出 Termux Shell 的失败关闭行为、其他工具的实现差异和 app UID 边界。复验：`scripts/patches/tests/workspace-write-boundary-warning.test.mjs` 覆盖三入口、双语文案、runner 顺序、幂等、语法和损坏锚点不写入；未构建 APK、未做 CDP/ADB 设备验证。

506. **滚动 Termux stable 摘要不能作为提交级固定输入（2026-10-23）**

    现象：PR #102 固定的 Termux InRelease SHA-256 为 `317788…22f3f`；其后的两次来源草稿 CI 都在 `gpgv` 报告官方 Termux 签名有效后，于 pin 比较处失败。run 39809445254 的两路观测到摘要 `6b20f388…ce71d87`、签名时间 2026-10-22 13:30 UTC；run 39820055985 的两路观测到摘要 `04cb4d94…dbd1549`、签名时间 16:31 UTC。真因：仓内 pin 指向较早的 `stable` 发布，官方滚动索引在来源构建前已推进；正确验签的当前输入也会被过期摘要拒绝，双路构建各自取数还会遇到不同发布时点。修法：删除提交级 `termuxInReleaseSha256`；单独的 `termux-package-inputs` job 每轮固定 bootstrap、验签当前 InRelease、校验签名 Packages.gz 与所有目标 `.deb`，再上传带本轮 provenance 的快照；两路 ARM64 job 依赖该 job 并下载同一个 run/attempt artifact。recipe commit/hash 锁与签名、内容摘要校验均保留。复验：Python 用例确认 InRelease 摘要只记录为本轮 provenance；workflow 契约测试检查单次解析、job 依赖、同名 artifact 和禁止 replica 独立抓取，并带受控负控。PR #105 的本地/远端复验结果待补记；本机没有 `gpg/gpgv`，实际签名、包闭包和 ARM64 构建须由 Linux runner 完成；本轮未构建 APK、未做设备验证。

507. **GitHub Actions artifact 路径不能直接携带 Debian epoch 冒号**

    现象：main run 39825699738 的 Termux 签名包预检已验证 82 个包，上传同轮快照时被 `actions/upload-artifact` 拒绝：`ca-certificates_1:2026.10.20-1_all.deb` 路径含不支持的 `:`。真因：Debian epoch 冒号是合法包文件名的一部分，但 Actions artifact 为跨平台文件系统安全会拒绝该字符；这不是签名仓库或包下载错误。修法：预检 job 将已验签的 webroot 与 provenance 原样打成一个 tar 文件上传，artifact 自身只含无冒号归档名；两路构建下载后用 Python `tarfile` 的 `data` filter 解包，并显式拒绝绝对/越界路径、链接、重复项和非预期根目录，保留 Packages 索引、包文件名及摘要。复验：`cloud-workflow.test.mjs` 检查归档上传/解包契约并以旧目录上传和移除安全 filter 为负控；完整证据以修复后的 main 来源 workflow 成功运行补记。未做设备验证。

508. **多文件引擎补丁必须按每个 target 的真实 marker 对账**

    现象：main run 39883817637 的 reference 在 `reconcile-engine-patch-copies.mjs` 因 AR1 多文件目标误用同一个 registry marker 失败；按 target 修正后，run 39887264665 又在 UI companion 的 `dsh-mobile auto review default confirmation (AR1)` 检查失败，而前置 `apply-patches --apply` / `--check` 均为 26/26。真因：AR1 三个 target 各有不同判据；UI marker 是解释性注释，`build-snapshot-013.mjs` 后续以 esbuild 降级浏览器 `lib/client.js` 时会移除注释；同一转换面还有 WW1、B1、J1、H1、F6 的客户端补丁标记。修法：对账器按每个确切 target 使用补丁 marker 或转换后仍保留的行为锚点；所有浏览器 `lib/client.js` 目标必须显式登记锚点，未登记即 fail closed。复验：`node --test scripts/source-build/reconcile-engine-patch-copies.test.mjs` 7/7，覆盖转换后 marker/行为锚点与负控；用六个真实版本化补丁夹具执行 `apply-patches --apply` 后再以实际 esbuild chrome87 transform 检查，6/6 锚点通过；`node scripts/check-code-map.mjs` 通过。PR #107 修正 target marker 后，PR #108 增加转换后行为锚点；main run [39890983431](https://github.com/snoworwind/pocket-harness/actions/runs/39890983431) 中 primary 与 reference 均通过快照、Kotlin 单测及 ARM64 APK 构建，独立比对、签名、prepare 与 draft release 全部成功。未做设备验证。

509. **Debian 离线 rootfs 不含 `/dev/shm` 挂载点**

    现象：用户从 APK 离线安装 Linux 环境时，资产校验和解包已完成，但 runtime 在健康探测前报告 `linux-rootfs-prepare-failed: rootfs directory is missing: /dev/shm`。真因：构建产出的 Debian base rootfs 合法地省略 `/dev/shm`（它通常由 init 创建）；runtime 却把它与归档必有的 `/dev` 等目录并列检查，安装永远在探测前失败。每次命令本来就把 app 私有 shm 绑定到 guest `/dev/shm`。修法：runtime 0.6.1 先验证 rootfs `/dev` 是真实目录，再创建缺失的 `dev/shm` bind 目标并复核它是目录；Linux runtime/bootstrap 与 manifest 版本同步升至 0.6.1，使已安装的 0.6.0 能发现新离线资产。复验：`node --test vendor/dsh-linux-runtime/test/manager.test.mjs` 34/34，回归夹具不再伪造 `dev/shm`，并检查 PRoot 收到 app-private bind；Linux source manifest 与 code-map 检查通过。云端 run [39899439859](https://github.com/snoworwind/pocket-harness/actions/runs/39899439859) 的 primary/reference ARM64 来源构建、APK 字节比对、签名和草稿预发布均成功，标签为 [`hardening-source-511b7e38e237-39899439859-1`](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-511b7e38e237-39899439859-1)。**未做 ARM64 设备验收**。

510. **Android PRoot seccomp 偶发静默退出，login Bash 又覆盖共享 Node PATH**

    现象：Linux 设置页报「Linux 环境操作失败」，`linux-bootstrap-state.json` 记录 `PRoot guest smoke probe failed (exit 182): `；相同资产与参数在目标 HarmonyOS / Android 16 / Linux 6.6.98 上还可复现 exit 127，stderr 为 `node: command not found`。真因有两项：Android 上 PRoot seccomp 加速路径会在 guest 输出前静默退出 182；即使设 `PROOT_NO_SECCOMP=1`，smoke probe 的 `/bin/bash -lc` 仍会读 Debian `/etc/profile`，root uid 的 profile 把 PATH 重置为系统目录，而 glibc Node 只在绑定的共享 Node 目录中。`linux_bash` 同样用 login Bash，因此两处都受 PATH 覆写影响。修法：Android PRoot 启动环境一致设置 `PROOT_NO_SECCOMP=1`，安装探针与 `linux_bash` 都改用 `/bin/bash -c`；探针失败时将 host/guest cwd、guest 和 PRoot 环境摘要、stdout 与 stderr（各最多 4096 字符）写入原始 `lastError`。版本从已合入的 0.6.1 提升到 0.6.2，使新 APK 可识别更新后的离线 runtime。复验：`node --test vendor/dsh-linux-runtime/test/manager.test.mjs` 35/35；`node scripts/check-vendored-linux-bootstrap.mjs --self-test` 正控及 4 条负控通过；`node scripts/source-build/check-linux-sources.mjs` 校验 30 个来源文件，`node scripts/check-code-map.mjs` 通过。跨层 `offline-install-integration.test.mjs` 因工作树未安装 `tar-stream`，在 import 阶段中止。**新 APK 与 ARM64 设备验收尚未完成**，不能据此宣称安装已恢复。

511. **滚动 Termux stable 的 PRoot 版本必须同步推进来源锁（2026-10-23）**

    现象：PR #113 的 `draft_release=true` run 39922474317 中，primary 与 reference 均在 `Build source-owned offline ARM64 Linux assets` 报 `Termux proot version is not reviewed: '5.1.107.99'`，未生成 APK 或草稿 Release。真因：Termux stable 是滚动签名仓库，官方仓库通过 recipe commit `5b90c229de8e674a890d723b100cfcc5d6054ea5` 将 proot 更新到 5.1.107.99，而 `linux-inputs.json`、`linux-backend-packages.json` 与 `vendor/linux-proot/SOURCE.json` 仍锁在 5.1.107.98。fail-closed 行为正确，旧 pin 已失效。修法：审核 Termux recipe 中的 PRoot source URL/SHA-256，并独立复核归档字节；同步更新版本、recipe commit/file hash、source hash、包 fixture、runtime banner 测试和 `linux-source-manifest.json`，保留精确版本拒绝。依赖 recipe 在新 commit 下字节未变，继续使用原摘要。复验：recipe hash 与 GitHub source archive SHA 均核对；PR Linux 资产门禁与后续来源草稿待 follow-up 提交验证。**该更新尚未做 ARM64 设备验收**。

512. **审批决策耐久队列可被同 UID 运行时伪造「用户已批准」（R3-01，2026-10-24 登记）**

    现象：`NotifyDecisionQueue` 的落盘文件 `filesDir/notify-decisions.ndjson` 在 filesDir 根，而引擎 home 在 `filesDir/home`——被提示注入驱动的模型 bash（同 app UID、无路径级沙箱，与坑 376/503 口径一致）可直接追加任意行。`parse()`（NotifyDecisionQueue.kt:132-146）只验 requestId 非空，任何行都成为一条决策；`flush()`（:297-354）把 `outcomeJson` 原样 POST 给引擎 `$events/result`。真因：该文件按「投递耐久性」设计、未按「授权数据」对待，违反 ScreenScope.kt:53 的既有纪律（不得从同 UID 可写文件恢复授权）；坑 376 修了 prefs 三键，本文件是同族残留面。攻击链：模型写伪造 pending 行（eventId 是它自己发出的待审批请求）→ 重启自身网关使 NotifyBridge 掉线重连 → ready 帧 flush → 伪造 `allowed-once` 被引擎当作用户批准。修法（已落地，PR 通知决策队列完整性绑定）：serialize 每行附 HMAC-SHA256（canonical 串定序拼接、mac 字段承载；密钥 Android Keystore 非导出，Keystore 不可用回退进程内临时密钥——跨进程死亡持久行按验签失败丢弃，方向 fail-closed）；parse 对缺签、验签失败与 requestId 形状不符的行一律丢弃。复验：新增伪造行（旧格式无 mac）/空 mac/篡改 outcome、state、eventId/异钥签发/非 hex requestId 五组反证与序列化往返全部通过；:app 全量单测 1364 例 0 失败；check-kotlin-comments/check-code-map 通过。升级一次性丢弃旧无签行：表现为引擎侧审批超时、用户重新作答。**设备链路（通知动作→落盘→flush→引擎）未做设备验证**，进入发版候选前须补三层验收。

513. **安全模式 prompt / 401 兜底把未脱敏日志尾巴（含引擎启动令牌）写入系统剪贴板（R3-02，2026-10-24 登记）**

    现象：`buildSafeModePrompt`（SafeMode.kt:685-708）把 `logTail` 逐字拼进 prompt，`SafeMode.copyToClipboard` 直写系统剪贴板；两条调用链（GuidePageRenderer.kt:489-512 的安全模式按钮、MainActivity.kt:1461-1468 的 401 兜底）的 logTail 都来自 `readFailureContext`/`PluginMounts.readEngineLogTail` 原文。engine.log 含 `dsh web: ...?token=`（EngineAuth.kt:51），违反 #184「令牌行不得进入外发文本」——该纪律只覆盖了 copyGuideLog/tailEngineLog，漏了这两条外发出口。真因：脱敏只挂在个别出口而非 prompt 构造咽喉。修法（已落地）：`buildSafeModePrompt` 在构造咽喉统一 `EngineAuth.redact`，两条剪贴板出口（安全模式按钮 / 401 兜底）同时收口。复验：SafeModeTest 新增「令牌行必须打码、非敏感行保留」反证通过；壳侧批全量单测通过。**未做设备验证。**

514. **调试日志日文件出口只脱敏令牌、不过 LogSanitizer（R3-03，2026-10-24 登记）**

    现象：`LogCollector.appendToDayFile`（LogCollector.kt:1025-1034）只过 `EngineAuth.redact`（仅 `?token=` 形态）就把全部采集内容（logcat 自进程 + engine.log 尾巴，含命令与模型对话）写入共享存储 `Documents/dshdata/log/dsh-<date>.log`；对照 LogShare 打包出口对同内容全条目 `LogSanitizer.sanitizeOrNull` fail-closed。用户对话中粘贴的 `sk-` 密钥/Cookie/PEM 明文沉淀在共享存储，持存储权限的应用可离线收割。真因：LogSanitizer（0.14.6）落地晚于日文件出口，未回灌；两个出口口径双标。修法（已落地）：`appendToDayFile` 改过 `LogSanitizer.sanitizeOrNull`（其内部已复用 EngineAuth.redact），失败 fail-closed 丢段并走 logcat 留痕计数。复验：LogSanitizerTest 既有七类正反例覆盖 + 壳侧批全量单测通过。**未做设备验证。**

515. **VdisplayController.create 资源上限 TOCTOU，并发可突破 MAX_VIRTUAL_DISPLAYS=1（R3-04，2026-10-24 登记）**

    现象：`create()` 先锁外快照 `records.size`（VdisplayController.kt:364），再 `ShizukuTransport.ensureBound`（binder 往返拉大窗口），锁内创建块（:385）不重查——`:371` 的上限检查用的是陈旧快照（死代码）。三条真实并发入口：控制队列线程（ControlPoller.kt:67）、WebView JavaBridge 线程（MainActivity.kt:1340）、binder 线程（DeviceControlService.kt:669）。真因：上限判定与资源创建分属两个临界区。后果是特权资源（VirtualDisplay+ImageReader+HandlerThread）上限被绕过，非范围绕过。修法（已落地）：查空 + 上限 + 创建合并进同一 `synchronized(lock)` 临界区、锁内重查，竞态窗口由代码结构消除。复验：编译与全量单测通过。**设备侧三入口并发未做设备验证。**

516. **引擎 overlay 第三方闭包 sha512 取自同信道元数据且缓存命中免复核（R3-05，2026-10-24 登记）**

    现象：`build-snapshot-013.mjs` 的 `overlayTgz`（:218-239）对 `engine-overlay.json` 登记的约 100 个第三方包（commander/got/undici/openai/@anthropic-ai/sdk/@modelcontextprotocol/* 等）只钉 `(name, version)`；sha512 来自与字节同一 fetch 的 registry 元数据且可缺席；本地缓存 `.deploy-tmp/engine-overlay/*.tgz` 命中零校验。对照同文件 pnpm/canvas 走 `PREINSTALL.npmIntegrity` 源控 pin 且缓存命中复验、deb 走签名 webroot。真因：钉哈希基建已存在但未覆盖 overlay 路径。registry 级妥协（维护者账号/同版本重发）即可把任意代码送进引擎树进 APK。修法：每包 sha512 pin + 下载与缓存命中两条路都 `verifyPinnedNpm` + sha512 必需 + 解包后 name/version 复核。**登记，未修复；修复需逐包生成 pin（需 registry 访问）。**

517. **门禁接线断言是子串匹配，注释留名即可假绿（R3-06，2026-10-24 登记）**

    现象：`check-release-gates.mjs` 对 ci-apk/source-chain 两类 POSITION 的接线断言用 `text.includes(gateName)`（:311/499/306），而 `pr-gate.yml:125` 的**注释**本就含门禁名——把 run 行删掉、名字留在注释里，`check-release-gates` 与 `check-gate-skips`（executionSites 只审两条构建链的 gate() 调用点，:78）双双 PASS，CI 从此不跑该门禁。真因：workflow 文件没有可执行行级断言。修法（已落地）：workflow 文件（ci-coord/ci-apk/source-chain 三类 POSITION）的接线断言改为**可执行行**判定（剥注释行后仍须含门禁名）；聚合器与 build-release.ps1 的 `--run --require` 断言同步收紧。复验：`check-release-gates` 全绿；受控负控——把 pr-gate.yml 的 11 条 run 行注释、门禁名留注释，修复前 PASS、修复后 FAIL（未接线清单如实列出），恢复后 PASS。check-gate-skips 的严格档传播断言从抽查一项改为全白名单 7 项一致。

518. **check-api-route-auth 只认字面量 kind，动态 kind 注册可逃逸路由清单（R3-07，2026-10-24 登记）**

    现象：路由发现把 `kind: 'exact'|'prefix'` 字面量当候选门槛（check-api-route-auth.mjs:70-78），`kind: COND ? 'exact' : 'prefix'` 形态的 `register({...})` 整条丢弃；unlistedSources 与字面量反向断言只遍历 discovered（:198-220），新文件里只有动态 kind 注册时整个文件不进判据。恶意 PR 可在 mobile-owned 插件加无鉴权路由且门禁全绿，与文件头「cannot hide a route」自述矛盾；self-test 无动态 kind 反例。修法（已落地）：有 `path:`（字面量或简写）但缺 kind 字面量的 `register({...})` 也计为候选（kind 记 `<unparsed-kind>`，fail-closed 允许误报红）；self-test 新增动态 kind 反例。复验：`check-api-route-auth --self-test` 全过（28 路由 / 11 注册计数不变——现库无动态 kind 注册，无误报红）。

519. **check-browser-syntax-floor 的 esbuild sha512 条件性校验且镜像仓内可控（R3-08，2026-10-24 登记）**

    现象：`extractNpmTgz` 在 `dist.sha512` 缺席时**不校验**直接解包（check-browser-syntax-floor.mjs:185-200），随后在门禁进程内 spawnSync 执行 esbuild 二进制（:210-214）；镜像清单来自仓内 `preinstall.json` 的 npmMirrors（:144-147）。镜像被劫持 + 元数据省略 sha512 → 恶意二进制在构建链执行。真因：把「registry 给了才校验」当默认，而非「无 pin 即拒」。修法（已落地）：sha512/integrity 缺席即 throw（与 lib/pinned-npm.mjs「缺 pin 即拒」同纪律），镜像劫持无法通过省略元数据绕过校验。复验：`check-browser-syntax-floor --self-test` 六向自证全绿；语法检查通过。

520. **linux_bash 工具无会话档位门且不受渐进披露掩蔽（R3-09，2026-10-24 登记）**

    现象：`vendor/dsh-linux-runtime/lib/index.js` 的 `registerLinuxBash` execute 直连 `manager.execute`（:56-112/126-168），全链无 `gateFor`/`sandboxPolicy.resolve`；`DEVICE_TOOL_GROUPS` 三个掩蔽组均不含 linux_bash。read-only 档位会话的模型调 `android_shell_exec` 会被档位门拒绝，换 `linux_bash` 畅通，可直接读写应用私有目录（PRoot guest 即 app UID）——会话档位语义被旁路。真因：runtime 插件由 bootstrap 独立装配，未接入 bridge 的服务面档位门与 capability-gate。修法：注入与 android 家族同源的档位门 + 纳入掩蔽组。**登记，未修复。**

521. **兼容模式未装 ServiceWorkerClient，SW 上下文请求绕过回环拦截（R3-10，2026-10-24 登记）**

    现象：`BrowserSharedFallback.attach`（:31-35）只配 CookieManager，不装 ServiceWorkerClient；隔离路径专门装了（BrowserHostProfile.kt:101-119）。兼容模式 WebView 里站点注册 SW 后，SW 内 fetch/WebSocket 不经过 WebViewClient，可达回环任意端口。既有防线（引擎 cookie SameSite=Lax + /api browser-trust fence）压制了对 3080 引擎面的实际收益；残余是非 /api 端点与回环其他本地服务。`BrowserSharedFallback` 类注释「Loopback is still denied」对 SW 上下文不成立。修法：兼容模式激活时装窄门 SW client（仅放行 127.0.0.1:3080 精确 origin）。**登记，未修复。**

522. **遗留 build-snapshot-arm64.mjs 零校验下载且索引名未消毒（R3-11，2026-10-24 登记）**

    现象：`scripts/build-snapshot-arm64.mjs` 下载 deb 后直接 writeFileSync 无任何哈希/签名校验（:44-58），`tar -xf` 命令串与文件路径直接拼远端 index 的包名（:70/75，无字符集约束）。全仓 grep 确认不被来源链/workflow/门禁调用（唯一引用 EXECUTION-MAP.md），属链下遗留，但名字暗示「正式的 arm64 快照构建」，一旦执行可命令注入开发机、写出工作区外。修法（已落地）：脚本删除（git rm），EXECUTION-MAP 全域文件清单摘除对应行。复验：`check-code-map` 通过（锚点无残留）。

523. **--npm-mirror 把 corepack/pnpm 执行体也交给镜像（R3-12，2026-10-24 登记）**

    现象：`run-local-source-chain.mjs` 的 `npmMirror`（:278-305）把 `COREPACK_NPM_REGISTRY` 也指向镜像，`build-engine.sh` 里 `npm install -g corepack` 与 `corepack pnpm install` 的执行体 integrity 都来自同一镜像；文件头「镜像不改字节」声明只对 lockfile 校验的依赖 tarball 成立。恶意镜像可投递恶意 pnpm → 构建机 RCE。opt-in 面（CI 不设）。修法：corepack 通道不走镜像或钉 integrity 预下载。**登记，未修复。**

524. **隔离浏览器允许 LAN 私有地址且不防 DNS rebinding（R3-13，2026-10-24 登记为已接受取舍）**

    现象：`BrowserHostNavigationPolicy.verdictForIpv4`（:200-211）只拒 0.x 与 link-local，RFC1918 直接放行；注释自认「literal-host policy, not a DNS firewall」。用户批准的域名可被解析到内网地址，模型经 browser_snapshot 读内网内容。这是移动端内网调试的有意取舍（loopback 与 3080 已封死）。处置：登记为已接受；后续可加「解析到私有段时回执警示」或设置开关，本轮不改准入语义。

525. **relay 准入令牌非常量时间比较（R3-14，2026-10-24 登记）**

    现象：`EngineTransport.admissionAuthorized`（:37-43）用字符串 `==` 逐字符短路比较 admission token（header 与 cookie 两分支）。本机任意 app 可连 127.0.0.1:3080 以关闭时机差异测时逐前缀猜测。实际增量有限（引擎 /api 全部还需签名 cookie 401 围栏），但修复成本一行。修法（已落地）：两分支改 `MessageDigest.isEqual` 常量时间比较。复验：EngineTransportPolicyTest 既有正反例（含前缀/后缀变体）通过。

526. **MuxClient 分片消息无总量上限；ControlPoller 错误体整读（R3-15，2026-10-24 登记）**

    现象：`MuxClient` 的 MAX_FRAME 只约束单帧，continuation 帧对 textBuf 无界追加（:153-185）；`ControlPoller.post` 对 errorStream `readText()` 整读后才 take(200)（:212）。失控/被攻陷引擎（同 UID）可把壳进程 OOM。违反 ProcIo.kt:21「一切子进程输出必须 readBounded」纪律。修法（已落地）：continuation 累计超 MAX_FRAME 即断开重连；ControlPoller 错误体改有界读。复验：编译与全量单测通过。

527. **LinuxAssetIO 来源白名单未钉端口（R3-16，2026-10-24 登记）**

    现象：`urlVerdict`/`hopVerdict`（LinuxAssetIO.kt:91-120）只查 host 白名单与路径前缀，不查 `url.port == 443`，`https://github.com:8443/...` 可过。现实不可达（HTTPS 主机名校验），纵深补齐。修法（已落地）：urlVerdict/hopVerdict 钉死 443。复验：LinuxAssetIOTest 新增非 443 正反两端负控通过。

528. **ConsoleActivity 特权 consoleBridge WebView 无导航来源锁定（R3-17，2026-10-24 登记）**

    现象：ConsoleActivity 的 WebView 只覆写 onPageFinished（:104-112），无 `shouldOverrideUrlLoading`——一旦页面发生任何导航，持有 bash stdin 桥（consoleBridge）的接口会继续暴露给新 origin。当前 console.html 无链接化输出、Activity 未导出，无触发路径；属回归面。修法（已落地）：ConsoleActivity 加 `shouldOverrideUrlLoading`，非 `file:///android_asset/console.html` 导航一律拒绝。复验：编译通过。**设备侧触发路径未验（当前页面本无链接）。**

529. **MainActivity dsh.notify.session extra 无形态校验（R3-18，2026-10-24 登记）**

    现象：`consumeNotifyRoute` 读 `getStringExtra("dsh.notify.session")` 无校验直达页面 JS 路由（MainActivity.kt:604-638）；经 jsString 编码无注入面，影响≈恶意应用代发一次会话打开请求。修法（已落地）：session extra 加 `[A-Za-z0-9_.\-:]{1,128}` 形态白名单。复验：编译与全量单测通过。

530. **ShellOps/RootAccess timeoutMs 无上界钳制（R3-19，2026-10-24 登记）**

    现象：`args.optInt("timeoutMs", 20_000)` 直接透传 `runShell`/`execRoot`（ShellOps.kt:139-143/156），模型可传超大/负值长期占用串行特权 shell 通道。同仓 VdisplayController.input 有 `coerceIn(1, 20_000)` 先例。修法（已落地）：`timeoutMs` coerceIn(1_000, 120_000)，su 回退共用同一钳制值。复验：编译与全量单测通过。

531. **build-snapshot-013.mjs 对 Termux 索引字段不消毒（R3-20，2026-10-24 登记）**

    现象：包名直入 `join(DEBPOOL, n + '.deb')` 与 wsl shell 串（:524/553/562）；postinst 提取的 altlink 路径 `join(U, relPath)` 可被 `../` 逃出 stage、target 仅前缀检查不拒 `NEW_PREFIX/../..`（:566-576）。同仓 `termux_signed_packages.py` 对同一数据源有严格 `safe_termux_package_filename`，快照构建器自己零校验。来源链内有验签 webroot 前置 + 设备侧 SnapshotExtractor 兜底，纵深缺口。修法：复用同款包名/路径判据。**登记，未修复。**

532. **check-mcp-client-deps 严格档未被聚合入口传播（R3-21，2026-10-24 登记）**

    现象：支持 `--require` 的 check-mcp-client-deps 不在 `check-release-gates.mjs:620` 的 STRICT 传播白名单；gate-skips-declared.json 的申报理由却写「发布链以 --require 强制齐全」——申报与接线漂移。实际可达性被前置 check-snapshot-secrets 收敛，降级 low。修法（已落地）：`check-mcp-client-deps.mjs` 加入聚合入口 STRICT 传播白名单；check-gate-skips 的传播断言改为全白名单一致断言。复验：两个门禁 self-test/全跑通过。

533. **snapshot-server.mjs 无鉴权监听 0.0.0.0（R3-22，2026-10-24 登记）**

    现象：`createServer(...).listen(8899)`（:26）把内嵌引擎快照完整 tar 分发到所有网卡、无 token。修法（已落地）：`listen(PORT, '127.0.0.1')`。复验：`node --check` 通过（脚本无单测；行为变更一行）。

534. **三处脚本 sh()/execSync 字符串内插 CLI 路径可 shell 注入（R3-23，2026-10-24 登记）**

    现象：`check-third-party.mjs:147/196`（tar -tvf）、`check-engine-overlay.mjs:230`（JSON.stringify 包路径不转义 `$`/反引号）、`pi-catalog-diff.mjs:66`——路径来自 CLI 参数或构建链，无远程可达性，本地自伤面。修法（已落地）：lib/shell.mjs 新增 `shellQuote`（POSIX 单引号）；check-third-party 两处 tar 内插改用它，check-engine-overlay 的 python 调用参数全部 shellQuote，pi-catalog-diff 改 execFileSync argv 形态。复验：`node --check` 全过；check-third-party 直跑出用法（参数面无变化）。

535. **桥审计与 .live.ndjson 可携带命令内联凭据（R3-24，2026-10-24 登记）**

    现象：`writeAudit` 记录完整 `args.command`（plugins/dsh-android-bridge/src/index.ts:148-162）、`.live.ndjson` 记 args 前 240 字符（:1833），不做脱敏——模型在 shell 命令中内联的 API key 明文落 files/audit/ 与悬浮球实时流（同 UID 本机文件）。对照 model-capability 已建立 diagnosticText 全量 redact 先例。修法（已落地）：桥插件新增 `maskCredentialShapes`（厂商密钥/Bearer/敏感键值/PEM 四类形状，口径与壳侧 LogSanitizer 一致：宁可多打码）；`writeAudit` 在 JSON.stringify **之前**递归掩码字符串值（转义后掩码会打坏 JSON 结构——实现时实测纠正），`.live.ndjson` 的 tool_call args 先掩码再截断。复验：插件新增 audit-redact 单测 5 组（真实形态样本 + stringify 后仍为合法 JSON + 不过度打码），插件套件 172/172 通过。**未做设备验证（本机文件出口，无设备行为面）。**

536. **undo-savepoint 导出加密固定 salt（R3-25，2026-10-24 登记）**

    现象：`ENC_SALT = 'dsh-undo-savepoint/export/v1'` 固定（vendor/dsh-undo-savepoint/lib/core.mjs:2805-2825），同一密码跨所有导出派生同一密钥，可离线预计算字典。AES-256-GCM 本身正确。修法：随机 per-file salt 入导出头 + 版本字段区分旧格式。**登记，未修复。**

537. **杂项加固批（R3-26/27/28/29/30/31/32/33/34/35/36/37，2026-10-24 登记）**

    一次登记十二项 low：浏览器「外部打开」对持久化恢复地址跳过协议白名单复验（BrowserBody.tsx:59,73,99-101，**已改为同过 parseBrowserAddress 复验，不过白名单按钮禁用**）；shell-termux fence 漏 dshEnv 通道（src/index.ts:141-150/200，受信调用方面，**已在 spec 层重盖 fence 三键并同步 WeakMap 键**）；host-web-compat 字符串替换注入遇 `$&` 序列会被替换语义改写（lib/index.js:1118-1120/960，**两处已改函数替换**）；AdbKeyboardService 注释描述的「当前输入法校验」不存在（:22-26 vs :113-121，已按实现现状更正注释与 Manifest 引用）；SafeMode.newId 用 java.util.Random（:548-550，已改 SecureRandom）；check-patch-test-manifest 白名单缺 stale 方向（:104，**已加 staleKnownFails 纯函数 + self-test 正反证 + 真实档 WARN**）；check-tool-name-promises 只扫 plugins/*/src（:63-84，**已在文首如实登记扫描面边界**）；NDK 以 SHA-1 钉定（build-apk-source.yml:496-505）；auto-approve.mjs 无条件自动批准无确认 gate（**已加 DSH_AUTO_APPROVE_CONFIRM=1 显式确认门，缺省 exit 2**）；pr-gate 敏感信息扫描模式窄（pr-gate.yml:73-79，**已扩模式族 sk-ant-/gho_/github_pat_/AIza/xai-/PEM/webhook 与目录 release/final-acceptance/webpages/notes.md；测试文件排除——脱敏器单测必须内置字面假密钥夹具**）；托管 PR Gate 可被单个仓库变量休眠且 skipped 满足 required checks（**已加 gate-sentinel 恒跑 job：PR_GATE_MODE != on 即红，恢复须显式编辑**）；FileProvider external_shared 全盘映射无门禁断言（**已在 check-manifest-hardening 加调用方 allowlist 封口：getUriForFile 调用方 ⊆ {FileIncoming, LogShare, PathOpen}；负控实测移出 allowlist 即 FAIL**）。各项修法与状态见 [R3 修复账本](SECURITY-REMEDIATION-2026-10-24-R3.md)。**登记，未修复。**

538. **整文件重写后必须 diff 核对全文（auto-approve 截断事故，R3 自审，2026-10-24）**

    现象：给 `scripts/auto-approve.mjs` 加确认门时用脚本整文件重写，新内容只写到 `const BASE = ...` 一行，其后 WebSocket 连接、respond、心跳逻辑全部丢失；`node --check` 语法合法，守卫行为验证（缺省 exit 2）又在截断点**之前**执行——两道检查全绿，截断随 PR #119 合入 main，由本轮改动自查发现。真因：重写脚本构造了「头 + 首行」却没把原文件剩余内容拼回，而两道验证恰好都只覆盖保留段，形成假绿组合。修法：恢复全文（守卫头 + 原逻辑原样保留），验证升级为关键符号在场断言（respond/onmessage/setInterval）。教训（入坑理由）：凡整文件重写，提交前必须 `git diff` 逐行核对——语法绿不等于内容全；行为验证要覆盖到文件**尾部**的代码。

539. **跨平台脚本的引号语义必须按 shell 分流（cmd.exe 不认 POSIX 单引号，R3 自审，2026-10-24）**

    现象：坑 534 修复把 `check-engine-overlay.mjs` 的 python 调用参数全部改 `shellQuote`（POSIX 单引号）；win32 下 `execSync` 走 cmd.exe，单引号被当**字面量**传给 python，全部路径参数带引号失效。真因：引号是 shell 语义而非字符串语法——同一份内插在 `/bin/sh` 与 `cmd.exe` 下合法形态不同；R3-23 只按 POSIX 威胁模型改写，漏看该脚本存在 win32 分支（`process.platform === 'win32' ? 'python' : 'python3'`）。修法：`q = win32 ? JSON.stringify : shellQuote` 平台分流；POSIX 侧用含空格/单引号/`$(…)`/反引号的路径合成用例证明 python argv 精确还原（实测 EXACT）。

540. **PEM 截断块的两个分块方向只堵了一个（坑 514 自审续，2026-10-24 复审发现）**

    现象：坑 514 的修复（orphan BEGIN 连同后续行文掩到文本末尾）只覆盖「前半段先到」的 chunk；`readEngineLog` 按 `MAX_ENGINE_CHUNK` 切 `engine.log`，若块被切在「后半段先到」的边界——本 chunk 只有「密钥材料后半 + END」而无 BEGIN——完整块正则不匹配、orphan BEGIN 不在场，密钥材料原样落进共享存储日文件。真因：截断是**两个方向**的（头截断/尾截断），修复时只推演了 BEGIN 一侧；fail-closed 的声明（宁可掩掉普通内容不让材料裸露）在尾方向失守。修法：`redactPrivateKeyBlocks` 补 ORPHAN_END 分支——END 无 BEGIN 时密钥材料从本 chunk 哪行开始不可知，从文本开头掩到 END 为止；同 chunk 两个方向叠加（上块尾 + 下块头）先掩尾再掩头，幂等性不变。复验：LogSanitizerTest 新增尾方向与双方向叠加两组反证（旧实现对尾方向用例必红），`testDebugUnitTest` 全绿。

541. **Console 来源锁定只对 scheme+path 匹配，漏 authority（坑 528 自审续，2026-10-24 复审发现）**

    现象：坑 528 给 ConsoleActivity 补的 `shouldOverrideUrlLoading` 判据是 `scheme == "file" && path == "/android_asset/console.html"`——`file://<任意host>/android_asset/console.html` 也放行，带 host 的 file URL 绕过路径钉死。真因：与主 WebView 的来源纪律不对称——`isEngineOrigin` 钉 scheme+host+port+`rawUserInfo == null`，而 console 侧只钉了 scheme+path；注释声称「与主 WebView 的来源纪律对称」但缺 authority 面。修法：判据补 `host.isNullOrEmpty() && userInfo == null`（file 资产 URL 的 authority 恒为空）。复验：`testDebugUnitTest` 编译与全量单测绿；宿主侧 `file://host/...` 导航现被拒（shouldOverrideUrlLoading 返回 true）。**未做设备验证**（改动为防御纵深收紧，合法初始 loadUrl 不经该回调，页内无链接；进发版候选前须按 §2.1 补三层）。

542. **yml 接线断言剥了整行注释，行尾内联注释仍可伪接线（坑 517 自审续，2026-10-24 复审发现）**

    现象：坑 517 的修复只剥 `^\s*#` 整行注释；`run: node a.mjs # check-x.mjs` 这类门禁名只活在**行尾注释**的形态仍被子串匹配计为接线。真因：yml 注释有两种形态（整行/行尾），修复时只对照实测样本（整行）收窄，没按 yml 语义枚举完。修法：`check-release-gates.mjs` 的 effectiveText 先 `replace(/\s#.*$/, '')` 剥行尾注释（yml 语义要求 ` #` 前有空白，不会误伤无空格的 `a#b` 字面量）再滤整行注释。复验：受控负控（node -e 合成「行尾注释门禁名/整行注释门禁名/可执行行门禁名」三形态）证明只有可执行行计入；改后 `check-release-gates.mjs` 与 `check-gate-skips.mjs` 全绿——即现网 yml 的门禁接线全部真实落在可执行行，无一处依赖注释形态。

543. **合并冲突标记合进了 main，而门禁的冲突检查面只有代码文件（2026-10-24 复审发现）**

    现象：`docs/AGENTS/SECURITY-REMEDIATION-2026-10-24-R3.md:44-51` 带着 `<<<<<<< HEAD`/`=======`/`>>>>>>> origin/main` 三段标记合入 main（引入者 4efd96a「merge main: union fixed-item markers in gotchas 537 and R3 ledger」——手工合并账本时只 union 了 gotchas 537，账本一侧的冲突没解完就提交），此后 5 个 PR 的 CI 全绿放行。真因：pr-gate 的冲突标记检查只扫 `app/src .github` 的 `*.kt/java/xml/html/js/yml/yaml`——docs/ 与 scripts/ 不在扫描面，`*.md/*.mjs` 等扩展名也不在；「检查存在」不等于「检查覆盖全部会被人读/会被工具消费的内容」。修法：账本按 union 语义解冲突（两侧条目都保留，与该 merge commit 的意图一致）+ 计划表去掉合并残留的重复行；pr-gate 冲突检查扫描面扩为 `app/src scripts .github docs` × `kt/java/xml/html/js/mjs/ts/tsx/css/json/yml/yaml/md/ps1`（`=======` 单行不扫：markdown 分隔线误报率高，两个锚点足以判定）。复验：新 grep 在修复后的树上 exit 1（无标记）；受控负控（临时目录放 `<<<<<<< HEAD`/`>>>>>>> origin/main` 的 .md）命中两条。

544. **通知决策 HMAC 的 canonical 裸管道拼接可被字段重切（坑 512 复审续，2026-10-24 复审二轮发现）**

    现象：canonical() 把九个字段用 `|` 直接拼接签名；字段值本身含 `|` 时（free-text 作答回显进 outcome 一类），同一字节串存在多重合法切分——同 UID 攻击者拿一条**合法签名行**可构造出 canonical 字节完全相同的另一条 Decision（字段重切后照常验签通过），MAC「绑定到这一条决策」的承诺失守。真因：坑 512 修复按「字段定序」设计签名，但定序不等于定界——分隔符出现在值域内时边界歧义；现实可达性被 requestId 16 位 hex、ts 13 位数字等形状约束压到接近零，属实现缺陷 + 实际利用面极窄。修法（已落地）：canonical 升 v2，每字段带 `len:` 长度前缀让切分唯一；v1 行验签失败按 fail-closed 丢弃（与升级丢行语义一致，本轮未发布无存量行）。复验：新反证「字段含竖线时不同决策不得同串」（v1 拼接下两条 Decision 同串、v2 必须不同，旧实现该用例必红）+ 含竖线字段 serialize→parse 往返精确；`testDebugUnitTest` 1372 例 0 失败。

545. **生产 HMAC sign 只对「密钥缺席」回退，「在场但失效」的 Keystore 密钥让决策静默丢失（坑 512 自审续，2026-10-24 复审二轮发现）**

    现象：ProductionIntegrity.sign 的回退条件是 `keystoreKey() ?: ephemeralKey`——只覆盖 getKey 返回 null 的形态；master-key 回滚/安全硬件复位后的失效密钥句柄仍在，Mac.init/doFinal 抛异常直接穿出 serialize，enqueue 的 catch 返回 false 而 NotifyActionReceiver 不检查返回值：用户决策无声消失，无重试无可见提示，与类头「Keystore 不可用时决策仍即时签名与投递」的自述矛盾。真因：「不可用」被窄化为「拿不到句柄」，Keystore 故障的真实形态还有「句柄在、用不了」；JVM 单测只覆盖 null 路径（AndroidKeyStore 在 JVM 天然缺席）掩盖了这一档。修法（已落地）：signWithFallback——主密钥**任何**签名失败都落临时密钥，两把都失败才返回 null（与「放弃持久化」语义可区分）。复验：JVM 直测用 **null 编码 Key** 构造 init 必抛路径（注意：SunJCE 对「算法名不匹配」的 SecretKeySpec 照常 init，首版负控用 DES 标签密钥测了个假阴性，改 null 编码后跨 JDK 确定失败）；两断言（在场失效→临时密钥结果逐字节相等 / null→同）全过，`testDebugUnitTest` 1372 例 0 失败。

546. **安全模式剪贴板 prompt 只掩令牌一类，六类凭据形状直达系统剪贴板（坑 513 复审续，2026-10-24 复审二轮发现）**

    现象：坑 513 修复让 buildSafeModePrompt 的 logTail 只过 EngineAuth.redact（token= 一类），而**更少暴露**的日文件出口（坑 514）同日已升级 LogSanitizer 全七类——同一份 engine.log 内容两个出口双标：Authorization: Bearer / sk- 密钥 / 环境变量导出 / PEM 块可随尾巴进系统剪贴板（任意获焦应用可读、设计用途就是粘给外部渠道）；engine.log 会回显模型命令与配置内容，是真实可达面。真因：坑 513 按审计条目字面（#184「令牌行不得进入外发文本」）收窄出口，未对齐同日坑 514 已确立的全量口径——「构造咽喉处统一脱敏」的教训没有跨条目复用。修法（已落地）：logTail 统一过 LogSanitizer.sanitizeOrNull（七类），脱敏失败按 fail-closed 纪律不附带尾巴并给可见说明（不冒充「未取到」），绝不回退原文。复验：SafeModeTest 新反证（Bearer/sk-/环境变量/PEM 四形态同场，明文全部缺席、非敏感行保留），`testDebugUnitTest` 全绿。**未做设备验证**（纯字符串构造，无设备行为面）。

547. **yml 接线断言的行尾注释剥离不匹配 CRLF 检出，伪接线在 Windows 上复活（坑 542 复审续，2026-10-24 复审二轮发现）**

    现象：坑 542 的 `\s#.*$` 行尾注释剥离在 CRLF 行尾整行不命中——JS 正则 `$` 不带 m 标志只匹配串尾、`.` 不跨 `\r`，行尾残留的 `\r` 让模式无法匹配；Git for Windows 默认 autocrlf=true 的检出上，「门禁名只活在行尾注释」的伪接线再次判绿，坑 517/542 修掉的假绿按平台复活（本仓 PR Gate 跑 ubuntu 检出 LF，故线上未踩中——这是给本地 Windows 跑门禁的人埋的雷）。真因：坑 542 的负控样本用 LF 字符串合成，「换行形态」维度不在用例矩阵；同一文件 :441 已有 `.replace(/\r\n/g, '\n')` 归一先例，两处判据没共享。修法（已落地）：effectiveText 计算前先做同款 CRLF 归一。复验：受控负控三态——LF 行尾伪接线 FAIL（坑 542 判据保留）、CRLF 行尾伪接线 FAIL（新判据，旧实现该用例必绿）、恢复后全绿。附注（fail-closed 方向的已知误报）：`\s#.*$` 会把 yml 引号字符串内的 ` #` 也剥掉（如 `run: echo "# x" && node a.mjs` 失去后半）——判绿变判红方向，符合「允许误报红、不允许漏报绿」的声明，登记在此防后人「修注释」时反向放松。

548. **pr-gate 两道 grep 扫描把 exit>1 当「无命中」放行，另有扫描面四处潜伏缺口（R3 复审二轮，2026-10-24）**

    现象：敏感信息扫描与冲突标记扫描都用 `if grep …; then exit 1; fi`——grep 退出码 0=命中/1=干净/**>1=出错**（路径缺席等），`if` 把一切非零当「无命中」：同一 PR 删掉一个被扫目录并植入真实密钥时步骤打印「无敏感信息」放行（`2>/dev/null` 连出错原因都吞掉）。账本声称「grep 无 fail-open 风险」只验证了「今天路径都在 git 内」，没验证「路径缺席时判据怎么走」。同轮发现的四处潜伏缺口：sk-/xai- 模式无左边界（`task-management-infrastructure`/`risk-analysis` 一类英文连字符词假红）；测试排除用整类通配（`*Test.kt` 排除全部 Kotlin 测试——真实密钥粘进任意测试文件即成盲区）；冲突标记扩展名缺 .py/.sh/.txt/.patch/.svg（scripts/source-build 32 个 .py 是与门禁同权重的执行面）；check-manifest-hardening 的 FileProvider allowlist 按裸文件名匹配（任意子包再造 PathOpen.kt 白嫖 allowlist）且读文件失败时 `null.includes` 直接 TypeError 崩溃（红被吞成 crash）。修法（已落地）：两道扫描改三态退出码判定（0=命中红 / 1=干净 / >1=扫描出错红，stderr 可见）；sk-/xai- 加 `(^|[^A-Za-z0-9_-])` 左边界；排除面收窄为具名夹具文件（LogSanitizerTest/LogShareTest/SafeModeTest/e2e-provider-ui-security.test.ps1，SafeModeTest 因坑 546 新夹具入列）；扩展名补齐；manifest allowlist 改**包相对路径**键控 + 读失败按门禁红处理。复验：本机四组验证——新模式全树干净（exit 1）、`task-management-infrastructure` 不再命中、真实形态密钥仍命中、「路径缺席+真钥」合成场景 exit 2 被新判定判红（旧 `if grep` 形态实测放行）；manifest 门禁负控（临时子包 PathOpen.kt）判红 exit 1、恢复后 PASS。

549. **桥侧凭据掩码的键值规则漏掉 JSON 引号键形态，「口径与壳侧一致」声明失守（R3 全量复审轮，2026-10-24）**

    现象：`maskCredentialShapes` 的敏感键值规则只在裸键上匹配（`password=x` / `token:"x"` / `token="x"`），键名带引号的 JSON 形态整族漏掩——`curl --data '{"password":"hunter2secret"}'` 原样落 audit.ndjson；`password: "my secret phrase"`（引号串值含空格）同样漏掩（裸 token 字符集 `[^\s"'\\,;&]` 不吃空格）。而代码注释与修复账本均声称「口径与壳侧 LogSanitizer 一致」，壳侧 SENSITIVE_KV 的 `["']?…["']?` 早已覆盖引号键、`"[^"]*"` 覆盖含空格引号串值（LogSanitizerTest 的 `{"token":"…"}` 夹具钉住该形态）——两轮复审只验了「规则序与幂等」「KV 字符串替换保引号」，没拿壳侧已覆盖的形态族做差集。真因：掩码口径一致性的验证停留在「同一批样本在两侧都过」，缺一条「壳侧夹具形态在桥侧逐条复跑」的对账；writeAudit 的 maskDeep 递归到 args.command 看到的是原始命令串，模型内联 JSON 载荷恰是最常见形态，漏掩面正落在持久化审计文件上。修法（已落地）：键值规则拆两条——引号串值整段处理（`(["'])(?:(?!\3)[^\\]|\\.)*\3` 支持含空格与转义引号，引号原样保留）+ 裸 token 兜底；键清单与壳侧 SENSITIVE_KV 逐项对齐（补 id_token/credentials）。复验：audit-redact 新增三组反证（引号键 JSON 三形态明文全缺席、含空格引号串值、既有形态回归）+ 幂等用例，bridge `npm test` 175/175（原 172 + 新 3）。残余面（如实登记，双方共有）：JSON **转义**形态（`\"password\":\"x\"`，`String(d.arguments)` 产生的文本）键与冒号间被反斜杠隔开，桥侧与壳侧规则都不掩——只影响瞬态 .live.ndjson 显示路径（持久化审计路径掩的是解析后的原始值，已覆盖），厂商密钥/Bearer 形态在该路径仍被各自规则掩住；登记待独立 PR（与 known-gaps 的 LogSanitizer 分块残余同族）。

550. **看门狗把压缩后的签名当强证据，历史端口错误可放行破坏性恢复（上游 `dsh-mobile-apk` #570/#586，2026-10-26 吸收）**

    现象：`planTick` 的强证据门收到 `logSignature`，但 `logSignatureOf` 仅识别插件树失败和 `UncaughtException`，`EADDRINUSE` 被压成 `null`；若直接改为传原始日志，又会让最近一次 HEALTHY 之前留下的端口冲突持续放行强杀/回滚。真因：分类签名是有损摘要，不能用于要求具体错误原文的权限判定；日志又是跨探活累积的，未划定健康边界。修法：把原文尾部传入强证据门；记录最近 HEALTHY 时 `engine.log` 字节长度，强证据扫描从该水位之后开始，日志变短时按轮转重置水位；异常签名限定为准确的 `UncaughtException`。复验：`WatchdogLadderTest.onlyStrongLogEvidenceJustifiesDestructiveRecovery` 覆盖原文 EADDRINUSE、健康水位过滤、轮转和准确异常形态；`./gradlew :app:testDebugUnitTest --no-daemon` 及 `node scripts/check-kotlin-test-count.mjs --self-test` 通过。设备层状态：尚未完成 ADB 用户体验验收。

551. **远端文件缩短后分块拉取可能以 EOF 成功返回不完整副本（上游 `dsh-mobile-apk` #573，本仓复核并修复，2026-10-26）**

    现象：`ShizukuUserService.readChunk` 把所有 `offset >= file.length()` 都编码为空数组；`ShizukuTransport.pullFileInternal` 把空数组作为正常 EOF。若远端文件在传输中缩短到当前偏移之前，本地只落盘前缀却返回 `ok=true`；负 offset 也会被当成从文件头读取。真因：读块 RPC 把“精确 EOF”和“偏移越界/状态已变化”混为同一种空结果。修法：在打开后的文件描述符上读取长度；仅 `offset == length` 返回空块，负值和 `offset > length` 返回失败/null，保持 AIDL 结构不变。复验：`ShizukuRpcLeaseWiringFixtureTest.readChunkRejectsNegativeAndBeyondEofOffsetsButKeepsExactEof` 覆盖有效边界、越界、精确 EOF 及生产调用约束；完整 Kotlin 单测与计数门禁通过。设备层状态：按用户要求暂缓实际设备验证。

552. **通知启动补投和前台切换在主线程同步提交 journal/Binder，tick 检查异常会断掉后续补投（上游 `dsh-mobile-apk` #570/#588，2026-10-26）**

    现象：`NotifyStore.start` 可由 `EngineService.onCreate` / 通知动作 receiver 的主线程触发，并同步 drain 最多 256 KiB 积压；`NotifySuppressQueue.restore`、关闭前台抑制及离开前台时的 `flush` 会同步提交 journal、逐条调用通知 Binder；tick 的前台状态检查若抛异常，Handler 回调提前结束，队列有积压却不再续拍。真因：生产调用路径从生命周期/设置线程直接进入含磁盘提交与系统通知调用的整批工作，且 tick 只保护调度、未保护后台执行体。修法：启动 drain 与 flush 放到单线程 daemon executor；Handler 只调度，前台判定/flush 在 executor 执行；tick 任一检查失败时记录探针并重排下一拍，持久 journal 与既有 at-least-once 结算语义不变。复验：`NotificationContractTest.通知启动消费与补投不得占用主线程且tick异常后续拍` 锁定接线与续拍；完整 Kotlin 单测、测试计数门禁、CI 通过。设备层状态：按用户要求暂缓实际设备验证。

553. **系统通知渠道删除后缓存继续指向失效 ID，探针超限轮转清空唯一日志（上游 `dsh-mobile-apk` #578，2026-10-26）**

    现象：`NotifyCenter.channelFor` 曾直接复用进程缓存或 `channel.<category>` prefs 映射；用户删除系统渠道后，壳仍返回不存在的 ID，投递无法自愈。全部渠道被用户降级时写入的空字符串也会被缓存，之后即使系统状态变化仍持续返回静默降级。与此同时，`NotifyProbe.log` 超过 128KB 会用空字符串覆盖文件，正好在长时间停摆、最需要保留证据时销毁整段历史。真因：本地映射被误当作系统渠道仍存在的事实；探针把有界存储错误实现成清空，而非保留最近一代。修法：缓存和 prefs 命中都复查 `getNotificationChannel`，空/失效映射或系统查询失败时回到 `resolveChannel`；探针将上一代轮转为 `notify-responder.log.1`，删除旧上一代失败时不覆盖唯一当前日志。复验：`NotifyCenterChannelTest` 覆盖系统渠道可用判定和恢复分支接线；`NotificationContractTest` 覆盖轮转契约与超限文件完整保留；全量 Kotlin 单测 1378 项、测试计数与执行地图门禁通过。设备层状态：按用户要求暂缓实际设备验证。

554. **同一通知事件内相同选项文字会让多个问题按钮共用 PendingIntent（上游 `dsh-mobile-apk` #570，2026-10-26）**

    现象：多问通知可以为每个问题生成相同文案的选项按钮，但动作 PendingIntent 的 requestCode 原来只由 `eventId`、动作和选项决定；Android 的 PendingIntent 身份不包含 extras，`FLAG_UPDATE_CURRENT` 会把先前按钮的 questionId 更新成后一个问题，点击任一按钮都可能答到错误的问题。真因：代码把 questionId 放进 Intent extras，却遗漏在 PendingIntent 的稳定身份键中。修法：将 questionId 纳入 `actionPendingKey`，其他动作没有 questionId 时保留原键形态。复验：`NotificationContractTest.同事件同选项的不同问句使用不同PendingIntent身份` 断言稳定键与 requestCode 均不同，并锁定 actionPending 调用该 helper；完整 Kotlin 单测、计数及执行地图门禁通过。设备层状态：按用户要求暂缓实际设备验证。

555. **FileProvider 门禁只登记调用文件名，漏查实际路径资源与文件内第二个调用（上游 `dsh-mobile-apk` #585，2026-10-26）**

    现象：旧门禁只检查 `getUriForFile` 出现在哪些文件，允许文件里增加第二次调用仍判绿；也没有从 Manifest 的 `FILE_PROVIDER_PATHS` 实际引用追到资源并核对 XML 映射。若路径属性用 `&#46;` 表示根点号，原始文本匹配也可能把宽映射误当成另一条路径；递归解码则会把字面 `&amp;#46;` 再变宽。真因：判据停留在调用者集合和未解释的 XML 属性字符串，没有锁定调用次数、资源引用和一次实体解析后的映射语义。修法：按 Manifest 的 `@xml` 引用读取 FileProvider paths 资源，XML 属性只解码一次；按 `(tag,name,path)` 精确登记所有宽/窄映射，核对同名资源的 qualifier/source-set 覆盖，并对 `app/src` 相对生产 Kotlin 文件逐一锁定调用次数。运行时 FileProvider 白名单和路径边界未变。复验：`node scripts/check-manifest-hardening.mjs --self-test` 覆盖已登记正控、编码点号、双重编码不递归、额外宽映射、重复调用及越 source-set 调用；临时合成树的第二次 `PathOpen.kt` 调用和 `debug/res/xml/file_paths.xml` 宽化均判红。PR Gate 先跑自检再跑真实树检查。L1 门禁改动，未做设备验证。

556. **控制台启动占用主线程，Activity 销毁后仍可能接收过期进程/WebView 回调（上游 `dsh-mobile-apk` #580，2026-10-26）**

    现象：`ConsoleActivity.onStart()` 同步调用 `ConsoleSession.start()`，后者检查快照 bash、构造 shell 环境并执行 `ProcessBuilder.start()`；慢存储或进程拉起会卡住 Activity 主线程。改为异步后，如果 `restart()`/`destroy()` 与进程创建并发，过期启动仍可能把进程写回当前会话；reader 和 `Handler` 中已排队的输出/状态也可能在 `WebView.destroy()` 后继续执行。真因：会话生命周期没有统一的代次所有权，Activity 回调队列也没有销毁态闸门。修法：start 只提交到私有单线程 daemon worker；进程发布与 restart/destroy 在锁内检查 generation，过期进程立即销毁；回调在同一状态锁下核对代次并投递；Activity 用原子状态快照、生命周期复查和统一 `postUi` 守住 WebView，并在 teardown 先标记销毁、清空 Handler 队列，再销毁会话与 WebView。复验：`GuideAndConsoleBatch6Test` 控制台生命周期回归 25 项；完整 `:app:testDebugUnitTest` 1382 项通过；`check-kotlin-test-count.mjs` 自检与真实结果、`check-code-map.mjs` 自检与真实地图、`check-kotlin-comments.mjs`、`git diff --check` 通过。未做设备验证（按用户要求暂缓）。

557. **控制台小段输出等到换行/4096 字符才到页面，CRLF 被重复折行（上游 `dsh-mobile-apk` #580，2026-10-26）**

    现象：旧 reader 按字符读取，只在换行或累计 4096 字符时调用 WebView；无换行的短提示/提示符会一直滞留，长输出又会按大量小片段重复跨进程调用 `evaluateJavascript`。每个 `\r\n` 还被无状态地各自改成换行，造成双倍行距。真因：输出以“行/字符数”为交付单位，没有字节上限和独立闲置 deadline；行尾归一没有保留跨读取边界的 CR 状态。修法：用 `InputStreamReader` 缓冲读取，按 UTF-8 code point 聚合至 16 KiB 上限；独立 50ms daemon deadline 推送短输出，EOF/销毁时先 flush 尾块再报告退出；跨读取保留 CR 状态，CRLF 只输出一个 LF，裸 CR 仍折行，bell 继续忽略。复验：`ConsoleOutputBatcherTest` 覆盖 UTF-8 字节边界、无换行 idle flush 和 close 尾块恰好一次；`GuideAndConsoleBatch6Test` 锁定 reader 接线及 CRLF 判据；完整 Kotlin 单测 1386 项及代码地图/测试计数门禁通过。未做设备验证（按用户要求暂缓）。

558. **侧栏横向溢出观察器测试用固定 70ms 等待，慢调度环境仍会竞态（上游 `dsh-mobile-apk` #587，2026-10-26）**

    现象：侧栏测试先固定睡 70ms，再断言由 50ms `setTimeout` 调度的溢出刷新已完成；机器繁忙、后台节流或 CI 调度延迟超过 20ms 时，定时回调可能仍未运行，测试假失败。真因：测试把预期延迟当成完成证明，而不是等待被测条件。修法：统一轮询目标 DOM 判据（每 10ms）并设 2s 上限，超时信息点明等待条件；覆盖新滚动容器识别、resize/字体变化清除标记及松手后的样式扫描，不改产品定时逻辑。复验：`sidebar-gestures.spec.ts` 70/70 通过；`dsh-client-ui-responsive` 完整 Vitest 52 个文件、757/757 通过。首次本地回归暴露最后一项应等到 style 与尺寸扫描均发生，等待条件已收紧后重跑全绿。

559. **Termux stable 的签名 PRoot 包版本领先于审查锁，来源构建按预期 fail-closed（2026-10-26）**

    现象：来源 run [40288221965](https://github.com/snoworwind/pocket-harness/actions/runs/40288221965) 中 primary 与 reference 均在 `Build source-owned offline ARM64 Linux assets` 报 `Termux proot version is not reviewed: '5.1.107.101'`；APK 快照、构建后验证、签名与 Release 步骤被跳过。真因：该 run 的 Termux stable 签名包快照已包含 PRoot `5.1.107.101`，而提交 `21982f74915fbda9facac1b97333d5af1b03eb82` 的仓内精确版本锁仍是 `5.1.107.99`；验签预检成功，两路 builder 使用同一快照，故是滚动仓库前进触发的审查保护，不是签名或 runner 故障。修法：先独立复核 `.101` 的不可变 Termux recipe、源归档 SHA-256、签名 deb 摘要与依赖闭包，再按 [构建输入台账](build-and-env.md) 同步版本/来源锁、夹具及 manifest；保留精确版本拒绝，不接受仅放宽断言。复验：该 run 的 PRoot 组装前 Linux 源码测试 62 项通过；两路均在相同版本断言处停止。修复候选按 Termux recipe commit `d6a36549b20eadb7723015eb3423e753ea125567` 同步 `linux-inputs.json`、`linux-backend-packages.json`、`vendor/linux-proot/SOURCE.json`、`linux-source-manifest.json` 与运行时版本夹具；源码归档与 recipe 文件摘要均独立复算，且依赖 recipe 未变。复验：PR #146（合并提交 `c04a1726ace75ef86d80077fa6a0abf078bd0879`）更新锁后，main 的 `draft_release=true` run [40303543476](https://github.com/snoworwind/pocket-harness/actions/runs/40303543476) 中 primary/reference ARM64 构建、全量 Kotlin 单测、APK 实物比对、签名、资产校验和草稿预发布全部成功，证明 `.101` 锁通过完整来源链。草稿标签 [`hardening-source-c04a1726ace7-40303543476-1`](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-c04a1726ace7-40303543476-1) 包含 `pocket-harness-v0.14.8-source-arm64.apk`（SHA-256 `be2df3d8888c92d009a8ce1bef6f1e5587e6c092a04df41f5b7eabd8b78136ef`）；草稿未公开。按用户要求未做设备验收，公开发布前仍需完成目标 ROM 设备验收。

560. **补丁测试的 ESM 语法预检依赖 Node 自动识别，Node 20 与 Node 24 结果不一致（2026-10-27）**

    现象：`.mjs` 测试用 `node --check` 检查 `.js` 补丁源码时，Node 24 的语法检测可能把未声明模块类型的文件按 ESM 解析，而 Node 20 将它当 CommonJS；同一源文件因此出现平台相关的预检结果。真因：预检依赖 Node 版本的语法自动检测和夹具目录的 `package.json` 上溯规则，没有显式固定模块语法。修法：对 ESM 补丁文件显式传入 `--input-type=module --check`；需要按包语义检查的夹具则在临时目录带上对应 `package.json`。复验：补丁测试清单在 macOS Node 20 与 OrbStack Node 24 均为 77/77。

561. **Android 来源构建跳过上游 official client profile，Web 标题和侧栏品牌退回本地默认值（2026-10-27）**

    现象：Web UI 标题显示“DSH 本地构建”，官方侧栏品牌插件也不启用；Android 图标名称仍是 Pocket Harness。真因：上游 `AppFrame` 的标题只读取 `DSH_CLIENT_TITLE`，缺省回退到 `brand.localBuild`；`ui-brand-official` 仅在 `DSH_CLIENT_BUILD_PROFILE=official` 时注册品牌槽位。上游 `scripts/build.ts --profile official` 会为所有 artifact 阶段构造提交短哈希、版本、profile 和标题，但 Android 来源脚本为省去 Desktop 阶段直接调用子编译器，没有传递该环境。修法：在直接构建前清除继承的 `DSH_CLIENT_*` 与 profile selector，再从固定 Harness checkout 导出上游 official profile 的四个公开值；构建后检查 `ui-layout` client bundle、官方品牌槽位和 `apps/web/dist/index.html` 的 title。复验：`node --test scripts/source-build/cloud-workflow.test.mjs` 20 项通过、1 项 Linux-only skip；受控负控覆盖错误 profile/title、缺少 commit/version 和移除每个产物断言。最终来源 APK 尚未重建，因此设备侧显示仍待 Android main 来源链及设备验收确认。

562. **升级 Linux bootstrap peer metadata 后未同步来源摘要清单，PR Linux 验证按预期拒绝（2026-10-27）**

    现象：PR #148 的 `build-linux-assets` 在 `check-linux-sources.mjs --self-test` 的仓库实体验证阶段报 `Linux source digest mismatch: plugins/dsh-linux-bootstrap/package-lock.json`。真因：Harness RC3 升级同步了 bootstrap 的 `package.json` 与 lockfile peer 版本，但 `linux-source-manifest.json` 的双份字节摘要仍指向 RC2；单测通过只证明负控有效，不代表仓库输入摘要已更新。修法：逐字节确认两文件只改变 client-settings peer 元数据，重算并同步 manifest 的 additional-source 与全局文件摘要，并更新对应 local-patch 理由；不放宽或跳过来源校验。复验：待 CI 对 PR #148 重跑 `build-linux-assets` 验证。

563. **控制队列取活不能证明无障碍服务在线（2026-10-28，原始记录恢复）**

    现象：残留的 `a11yEnabled=true` 与新鲜队列取活会让引擎报告无障碍可用，即使服务已经解绑。真因：控制队列由前台引擎服务独立承载，无障碍缺席时也会轮询。修法：只接受启用标记和 20 秒内的独立心跳，拒绝未来时间戳；轮询状态单独展示。复验：OrbStack Linux Node 24 桥插件 176 项通过，含队列新鲜而服务心跳陈旧及未来时间戳反例。当前无在线设备，CDP 与 ADB 层未验收。原始记录曾在添加坑 564 时被误删；后续回归另见坑 578。

564. **引擎来源锁的 overlay 输入未固定检出字节（2026-10-28）**

    现象：启用 `core.autocrlf=true` 的检出会将 `engine-overlay.json` 的 LF 改为 CRLF，即使 JSON 语义不变。真因：引擎组件键按文件原始字节散列该输入，而该路径未声明检出字节属性。修法：对该文件设置 `-text`，保持 Git 对象中的原始字节，不更改内容或放宽来源锁。复验：`base-lock.test.mjs` 在隔离 Git 仓模拟 autocrlf 检出，验证属性在场时字节一致、删除该属性后字节不同；两臂均通过。未做设备验证，此改动不改变设备运行代码。

571. **受审样式、屏幕夹具与 undo 源在 autocrlf 检出时发生字节漂移（2026-10-28）**

    现象：启用 autocrlf 后，上游来源样式和 fixture 的 LF 被改为 CRLF；含混合行尾的 undo 源也不再保留原始字节。真因：三条路径没有 Git 检出字节属性，而样式有来源摘要、fixture 有跨语言规范化副本、undo 源用于精确上下文补丁。修法：这三项设置 `-text`，不改源码内容。复验：macOS 与 OrbStack 的隔离 Git 检出正控通过，分别移除每个属性的负控均观察到字节变化；样式源码摘要与登记值一致。未做设备验证，改动只影响检出字节。

572. **来源快照旧 profile 身份检查未接线且自包含布局找不到 applicationId（2026-10-28）**

    现象：旧 `ci-verify-snapshot.py` 在本仓根目录布局读取 applicationId 得到空值，且来源构建路径没有调用它；插件成员检查不能证明 web/headless 的 profile patch 与应用私有路径一致。真因：旧检查器寻找协调仓布局，而当前来源链已独立且使用 pnpm，不能直接恢复旧链作为交付入口。修法：在本仓来源 APK 的最终注入快照上接入独立流式 profile 身份检查，核对真实 appId、四个路径、profile 原始字节及负控，避免套入旧链不适用的 npm 假设。复验：初版自检一正七负、OrbStack 接线测试和既有来源 APK 内嵌快照通过；后续发现并修复的归档路径绕过见坑 573。最终新来源 APK未重建，不作为发版通过。

573. **最终快照 profile 身份门禁先规范化 tar 路径，别名可绕过精确路径检查（2026-10-28）**

    现象：成员名 `home/.dsh/profiles/web/../web/cordis.patch.yml` 经 `normpath` 后成为期望的 web 路径，原检查器会把带路径别名的条目当成规范条目；绝对路径别名或 profile 父目录 symlink 也可能在解包时改变落点；同时删掉 `headless-bad` 后仍可能判通过。真因：先归一化再比对丢失归档原始路径身份；只检查叶子文件而不检查祖先条目，且必需集合漏掉明确声明的负控。修法：拒绝绝对、点段/父段及非规范归档路径；检查 profile 路径祖先均为目录而非链接；把 `headless-bad` 纳入必需集合，并要求其内容不同于权威 patch；路径配置只接受顶层键。复验：profile 自检一正十四负覆盖绝对/点段/父段别名、祖先链接、顶层路径、超大条目及负控缺失，通过；整合后的 OrbStack 本地 PR 门禁 29/29 通过（tree `168bd5794dff`），含 Kotlin 编译/单测。首轮唯一红项是本地 workflow 步骤数断言仍按旧计数，已更新至 26 个静态步骤并由 13 项回归通过；更新后 GitHub CI 待复跑。设备验证按用户本轮指示暂缓，不代表验收通过。

574. **来源依赖检查只验包存在，漏掉精确版本错配（2026-10-28）**

    现象：同名旧版包位于实际解析路径时，依赖在场检查仍判通过。真因：检查只解析路径、不比较直接精确版本；不能仅凭目录存在证明 pnpm 装配正确。修法：核对第一方直接依赖及必需 peer 的精确版本，仅对六个已审 Android Koffi `3.1.1 → 3.2.1` 消费者记录明确覆盖；范围和第三方传递闭包仍未由此判据覆盖。复验：OrbStack 的 engine-base 测试 8/8，包含错版和覆盖负控；模拟器现有来源包只读检查 347 个包、2173 条直接依赖通过。新门禁尚未对最终来源 APK 完成三层验收，不能当成发版通过。

575. **安全模式过滤插件时吞掉 insert 组后的顶层注释（2026-10-28）**

    现象：第三方 insert 子条目被移除时，其后列零注释可能一起消失。真因：组结束只识别顶层列表项，列零注释被错误归入被删除条目；过滤、回执和条目读取均有同一边界。修法：三处一致地以任意列零非空行结束 insert 组，保留顶层内容。复验：OrbStack Linux 的 SafeModeTest 38/38 通过，含真实过滤与回执反例；设备三层尚未完成，不得作为发版通过。

576. **事务 journal 目标类型和失败回退未守住恢复权威（2026-10-28）**

    现象：journal 路径若被目录或链接占据，或替换失败，旧逻辑可能走直写目标的回退。真因：rename 失败不代表目标不存在，直接写会截断已有恢复记录；类型未检查也可能触及意外路径。修法：拒绝非普通目标和临时路径，先同步临时文件，再替换；失败抛结构化错误并保留旧 journal，不直写。复验：OrbStack Linux 的 SnapshotTransactionTest 62/62 通过，含目标目录、符号链接和受控发布失败反例；设备三层待完成，不得标记发版通过。

577. **旧配置归一化忽略备份失败并可能截断 live（2026-10-28）**

    现象：备份路径已存在或备份写入失败时仍继续改写 profile；rename 失败还会直接写目标。真因：固定备份名被当成有效备份，且写入失败被吞掉；直接写入可能在中断或磁盘满时留下半份配置。修法：复用 `SnapshotFs.replaceWithVerifiedBackup`，核对本次原文字节、创建并同步唯一备份，再原子发布；任一失败保留原目标并在下次启动重试。复验：OrbStack Linux 的 `FactoryProfilePatchTest` 36 项和 `SnapshotFsTest` 11 项通过，包含备份与发布失败反例；设备三层尚未完成，不能作为发版通过。

578. **控制队列取活不能证明无障碍服务在线（2026-10-28）**

    现象：残留的 `a11yEnabled=true` 与新鲜队列取活会让引擎报告无障碍可用，即使服务已经解绑。真因：控制队列由前台引擎服务独立承载，无障碍缺席也会轮询。修法：只接受启用标记和 20 秒内的独立心跳，拒绝未来时间戳；轮询状态单独展示。复验：OrbStack Linux Node 24 桥插件 176 项通过，含队列新鲜而服务心跳陈旧及未来时间戳反例。当前无在线设备，CDP 与 ADB 层未验收。历史坑 46 的队列判据已被本条取代。

579. **rc.3 客户端在旧 WebView 缺少数组内建时无法渲染（2026-10-28）**

    现象：旧 WebView 缺少 `toSorted` 或 `findLast` 等方法时，客户端模型列表、会话和定时任务调用会抛错。真因：rc.3 固定源码在这些客户端路径使用较新的数组内建，语法降级不提供运行时方法。修法：在既有 head 注入中仅补缺失的 `toSorted`、`findLast`、`findLastIndex`，不覆盖原生方法，属性不可枚举；现有 `at` 与 `replaceAll` 的缺失补丁也改成不可枚举，避免污染 `for...in`。复验：OrbStack Linux 插件测试与注入冒烟通过，包含稀疏数组、泛型、异常和原生保留反例；旧 WebView 设备复现及 CDP/ADB 三层尚未完成。

580. **设置返回焦点仍指向被隐藏的当前一级行（2026-10-28）**

    现象：从「关于」等设置分区返回首页后，DOM 仍保留该行的 `aria-current`，但产品或裁剪状态可能已将其隐藏；对隐藏按钮调用 `focus()` 不会移动真实焦点，键盘和辅助技术用户落在不可见位置。真因：返回焦点只检查 `disabled`，把 `aria-current` 当作可见性证明；上游当前分区状态与当前可聚焦行并非同一个事实。修法：若活动行被禁用、隐藏、惰性祖先覆盖或计算样式不可见，则回退到首条可见导航按钮，不改写上游 `aria-current`。复验：Node 24 下客户端插件全套 758/758、构建、执行地图和维护文档检查通过；未做设备验证。

581. **WebView 验收探针只认中文导致本地化假红或假绿（2026-10-28）**

    现象：设备 UI 切换为英文时，「设置」「手机控制」「重置链接」和附件按钮选择器可能找不到真实控件；退役入口若只用中文查询，英文入口复活却会漏检。真因：live probe 把展示语言误当稳定 DOM 身份。修法：直接 Settings 优先，其次以账号菜单 accessible name 打开菜单，再回退文字 More；所有中英文标签使用完整匹配，并将来源字符串探针抽成自检可读取的真源码。缺入口、仅有侧栏 More 导航、控件隐藏/禁用和退役入口复活都必须有反证。复验：OrbStack Node 24 下 `verify-webview-015.mjs --self-test` 20/20、PR Gate/local-gate 回归 32/32、执行地图与维护文档门禁通过；未做设备 CDP/ADB 验收，jsdom 自检不替代设备层。

582. **`sh -c --` 的选项终结符遮住真实屏命令（2026-10-28）**

    现象：`virtual-only` 范围下，`sh -c -- 'screencap -p …'` 会被判为无屏幕操作而放行；合法 `input -d7`/`screencap -d7` 又会误拒。真因：`-c` 后的第一个 `--` 是 shell 选项终结符，旧解析器却把它当成脚本；短选项 `-d` 的粘连值也未按 Android CLI 语法解析。修法：只在识别 `-c` 的独立 `--` 参数后继续解析脚本；目标屏识别同时接受 `-d 7` 与 `-d7`，拒绝把 `-d=7` 当作目标 7；同步 Kotlin 与 bridge 实现，并用跨语言 fixture 固定真实屏拒绝、已注册虚拟屏放行及嵌套反例。复验：OrbStack Node 24 bridge 插件 178/178、`ShellOpsScreenCommandFixtureTest` 通过；设备三层按用户本轮指示未做，不能作为发版通过。

583. **快照指纹发布失败不能销毁旧提交点（2026-10-28）**

    现象：快照树事务已经提交时，指纹临时文件重命名失败会先删掉旧 `.snapshot-fingerprint`，再尝试直接写目标；第二步失败会让已提交树失去唯一耐久身份，下一次启动无法安全判新旧。真因：指纹发布绕开事务层已有的同步临时文件与原子替换协议，并把替换失败误当成可安全直写。修法：统一走 `SnapshotTransaction.writeTextAtomic`；发布失败保留旧指纹并留下可发现的错误证据，不直接截断目标。复验：`SnapshotFingerprintPolicyTest.failedFingerprintCommitPublicationPreservesThePreviousCommitPoint` 和 `SnapshotTransactionTest` 通过，另有结构检查禁止 `EngineManager` 删除或直写指纹目标；设备三层按用户本轮指示未做，不能作为发版通过。

584. **浏览器截图私有缓存不自动回收，压缩失败仍可能留下无效文件（2026-10-28）**

    现象：BrowserHost 将 `browser-shot-*.png` 写进引擎可读的 `files/home/tmp/dsh-tmp`，但该目录不受 Android cache 回收；多轮截图会持续占用应用私有磁盘。`Bitmap.compress` 还返回 Boolean，忽略 `false` 会把空/残缺文件当成功结果返回。真因：截图按临时文件使用，却落在持久 `files/` 路径；实现既没有生命周期上限，也没有校验编码结果。修法：新增 `ShotCachePolicy`，仅清理本功能命名的 PNG，按 1 小时 TTL、32 张和 128 MiB 限制；发布后保留本次回执文件并核对限额，压缩失败、超限或缓存无法核实时删除新文件且不给成功路径。同步 browser_screenshot 工具说明，准确描述本地清理策略。复验：`ShotCachePolicyTest` 覆盖 TTL、数量/字节上限、旧图优先、保留本次新图、超大拒绝、异名文件与目录保护及 BrowserHost 接线；Kotlin 单测/编译与 browser 插件构建通过。未做设备验证。

585. **虚拟屏空闲计时只从创建时起算，操作未续期且写入与回收不同步（2026-10-28）**

    现象：空闲回收按 `Record.lastUsedAt` 判定，但活动中的虚拟屏在创建 10 分钟后仍可能被回收；回收线程与时间戳更新还会并发访问 `records` 中同一记录。真因：`touch()` 原本只有定义，没有任何调用点；它也未持有 `reclaimIdle()` 使用的 `lock`。修法：让选择、viewer 绑定、跨屏输入/拉起和已有屏幂等创建续期；`touch()` 与注册表/回收统一使用 `lock`，避免判旧后与续期交错。复验：`VdisplayTouchLockTest` 检查 monitor 锁争用及各操作接线，Kotlin 测试通过。设备侧虚拟屏矩阵按用户本轮指示未做，不能作为设备验收或发版通过。

586. **快照解压把每个条目大小计入总量两次（2026-10-28）**

    现象：`SnapshotExtractor` 在读条目前与完成后都把同一 `entry.size` 加到 `done`，使 8 GiB 总量上限约在真实 4 GiB 处触发，进度也约翻倍。真因：上限累计与进度累计误用了两次独立加法。修法：在条目开始处只累计一次声明大小，后续进度读取同一累计值。复验：两条各 600,000 字节、限制 1,500,000 字节的反证用例在旧实现下会误拒，修复后成功并报告 1,200,000 字节。设备验证按本轮决定未做。

587. **Android 12 到 15 的全局动作表提前宣传 API 36 动作（2026-10-28）**

    现象：API 31–35 且 ROM 不返回 `getSystemActions()` 时，`menu` 与 `mediaPlayPause` 被目录按旧的 minSdk=31 宣传为可用，调用却会被系统拒绝。真因：目录把两个 API 36 才引入的动作登记成 API 31。修法：两项最低版本改为 36；测试同时覆盖 API 35 拒绝、API 36 放行，以及系统动作列表有值/为空两种路径。复验：`GlobalActionCatalogTest` 通过。设备验证按本轮决定未做。

588. **插件测试子进程继承 production NODE_ENV，React act 测试出现假红（2026-10-28）**

    现象：在父进程设置 `NODE_ENV=production` 时，插件测试子进程也进入 production 模式，React 禁用测试用的 `act()`，使本来与被测功能无关的测试报错。真因：`spawnSync` 默认继承父进程环境，门禁没有为测试运行时固定环境。修法：插件测试调用统一合并父环境和调用点附加值，再最后强制 `NODE_ENV=test`；WSL 子进程也显式设置该值。复验：`check-plugin-tests.mjs --self-test` 覆盖 production、只传 `NODE_OPTIONS`、无额外环境三种形态并确认 PATH 保留；移除强制值的受控负控在 production 父进程下按预期失败。当前 macOS 工作树的完整插件门禁还受未构建 `lib`/未安装依赖及 `/private/var` 与 `/var` 路径别名影响，需以准备完成的 CI 复核全套插件。

589. **shell 短选项簇中的安全载荷曾被屏幕范围解析器保守拒绝（2026-10-28）**

    现象：`sh -lc 'echo hi'`、`sh -o errexit -c 'echo hi'` 等常见包装被判 `deny-unparsed`，尽管这类命令可通过识别最终的 `c` 选项安全展开。对真实屏命令仍是拒绝，因此本地复核未确认范围绕过。真因：JS 与 Kotlin 两份载荷正则只覆盖分开的 `-c`，没有按 shell 的短选项簇和 `-o/+o` 前置选项识别载荷。修法：两侧同步识别原有受信入口 `sh` / `/system/bin/sh` 的末尾含 `c` 的短选项簇，再递归检查脚本；`bash`、`su` 和任意路径同名程序继续 fail-closed，不扩充信任边界。复验：S-13a–S-13m 跨语言夹具、bridge 插件全套测试、Kotlin `ShellOpsScreenCommandFixtureTest` 与两侧受控负控通过；源码和桥协议、执行地图已同步。设备验证按用户本轮指示未做；不得据此宣称设备验收或进入发版候选。

590. **门禁接线审计曾把声明/字符串提及误当成真实调用（2026-10-28）**

    现象：门禁覆盖反向断言复用宽松的文件名搜索；新增 gate 只写进 `GATE_SCRIPTS` 声明数组而未接入构建链，名字仍会命中并假绿。SKIP 扫描也可能把注释或字符串中的文字当作实际发射点。真因：名字出现与代码执行是不同事实，原扫描器没有区分声明、注释、字符串和调用点。修法：Node 侧识别真实 `gate('file.mjs')` 调用并递归扫描模板 `${...}` 表达式；PowerShell 侧只识别行首 `node ... scripts/check-*.mjs`；SKIP 只统计代码语句中的 `console.log/error` 字符串字面量。普通模式自动先静默自测，另提供 `--self-test`。复验：24 项自测与完整门禁通过（36 项声明、61 个脚本）；把执行点扫描受控替换回宽松名字搜索后，自测按预期失败。无设备验证适用，本改动为 L1 门禁脚本。

591. **协议产物 freshness 用目录最大时间戳，可能被无关输出掩盖（2026-10-28）**

    现象：`check-protocol-v2.mjs` 原先比较 `src/` 最新 `.ts` 与 `lib/` 最新 `.js`；只要无关的 `lib/ui-tree.js` 更新，即使 `src/protocol-v2.ts` 更新且 `lib/protocol-v2.js` 缺失或陈旧，整目录比较仍可能判新鲜。真因：生成产物的新鲜度是逐源对应关系，目录间全局最大时间戳不能证明任何特定模块已重建。修法：逐个顶层 `src/foo.ts` 配对 `lib/foo.js`；缺失或源码时间较新时仍调用原有临时重建/逐字节仲裁，缺失产物使仲裁不可确定并 fail-closed；没有对应源码的 orphan 输出不参与。复验：5 项 `--self-test`、Node 24 下真实跨语言 fixture 与协议往返门禁（10 项测试）通过；恢复全局最大时间戳算法的受控负控在「无关新输出掩盖陈旧配对」用例失败。此为 L1 门禁改动，无设备验证适用。

592. **遥测服务存在传递依赖版本错配，第一方直接依赖在场仍不足以证明能加载（2026-10-28）**

    现象：上游固定的 `dsh-otel@0.2.1-rc.3`（[上游 #656](https://github.com/kelai141/dsh-mobile-apk/pull/656)）声明 OpenTelemetry SDK 精确版本，但旧快照继承的根副本为 0.220.x；服务启动时报缺少 `LogsExporterMetricsHelper`，遥测服务未激活。真因：此前本仓来源检查只核第一方包的直接依赖/peer，既不递归读取第三方包自己的 `dependencies`，也无法判定嵌套副本遮蔽了根副本。修法：给两个已启用遥测消费者登记独立 nested SDK 包版本；来源闭包检查从消费者实际目录按 Node 查找顺序递归解析包，检查缺失与精确版本并输出完整引用链，许可证表同步登记。复验：受控夹具让根 `core@2.11.0` 正确、消费者实际优先命中的 nested `core@2.9.0`，门禁报告完整路径并失败；将 nested 版本改为 2.11.0 后通过，另核对 9 个消费者局部 pin 与 Apache-2.0 登记。来源构建需在合并后的 main 再跑以检验真实归档；设备验证按用户指示未做，不构成发版验收。

593. **协议 V2 数字字段按整数语义消费，但解码器曾只检查有限数（2026-10-28）**

    现象：浮点 `p` 写入 `Int32Array` 会截断成另一行句柄，浮点符号表索引会静默读成空字符串，浮点 `f` 会经位运算改变标志；`gen`、`rot`、屏幕尺寸和 bounds 也可能带小数。真因：`isIntArray` 只检查 `Number.isFinite`，而调用点把这些数字当整数使用。修法：元数据和所有数值列统一以 `Number.isInteger` 拒绝非整数，并分别校验数组元素类型与长度，避免报错原因误导调用方。复验：V2 测试逐一向 `gen/rot/scr/d/p/f/c/k/r/w/t/s/b/o` 注入小数，均须失败关闭；合法跨语言往返与桥对称门禁通过。此改动依协议/用户输入风险分类；本轮未做设备验证。

594. **设备坐标、滚动量或截图尺寸未知时不能用 0 代替（2026-10-28）**

    现象：旧壳侧不回归一化点击落点时，工具仍回 `x=0,y=0`；`web_dump` 把缺席的 `scrollY` 显示为 0；截图把缺席的物理分辨率输出为 0，分别会被误读为左上角、页面已到顶和坐标换算锚点。真因：把 `?? 0` 的缺省值放进事实字段，混淆「确实为零」与「没有数据」。修法：点击坐标和截图尺寸成对且有限时才输出；未知/非有限滚动量与视口尺寸显示 `?`；截图顶层物理尺寸与 `image` 附件像素尺寸分开。复验：manage 插件新增未知、半缺、非有限与真值反向用例；设备验证按用户指示未做，PR 明确保留该限制。

595. **文件接收源失效后队列记录未收敛（2026-10-28）**

    现象：来件入队后源文件被清理或替换成目录，浏览器为新建空会话后 claim 返回 410，但 `.sessions` 记录仍保留；后续轮询/重试反复命中同一失效项，可能不断留下空会话。真因：claim 的两条不可交付分支只返回错误，没有同步删除「可交付字节仍存在」这一队列事实。修法：source 不存在或不再是普通文件时，先按队列文件名删除对应记录，再返回原有 410；无效 session 仍在 source 检查前拒绝且保留队列。复验：插件回归覆盖缺失源和原路径被目录替换两种 410，并确认队列列表收敛为空；设备验证按用户要求未做，PR 明确保留该限制。

596. **把普通参数中的运行时展开一律拒绝，误拦截安全 shell 命令（2026-10-29）**

    现象：受限屏幕范围下，`echo "$(date)"`、`sh -c 'echo $(date)'`、`x=$(cat /tmp/f); echo $x` 仅在普通参数中使用运行时值也被判 `deny-unparsed`。真因：解析器把「展开会生成命令名或脚本」与「展开只生成参数值」混为一类，既误拒常见命令，又没有准确表达命令身份的风险边界；仅看命令词是否以 `$` 开头还会漏掉 `scr$CMD`、`scr$(...)` 这类拼接形式。修法：按 shell 词位识别命令词任意位置的动态展开（含前置赋值）及拼入 `sh -c` 脚本的替换，并对 `eval`/`trap` 载荷 fail-closed；普通参数和已完整脚本后的 argv 替换允许保留，但仍递归解析其中执行的命令，并按外层命令的屏幕范围判据检查。可选 `--` 后仍精确识别脚本载荷；壳侧 Kotlin 与插件侧同步实现，由权威 fixture 双向覆盖 S-12a–S-12t。复验：bridge 完整测试 179 项（含屏幕范围测试 57 项）、夹具生成/同步检查、`ShellOpsScreenCommandFixtureTest`、桥对称与代码地图门禁通过；设备验证按用户要求跳过，本改动未达到发布验收条件。

597. **无障碍状态缺少来源区分，会把未知/陈旧诊断成已关闭（2026-10-29）**

    现象：壳侧 SharedPreferences 没有 `a11yEnabled` 键、文件不可读或心跳过期时，状态工具仍显示「未开启」，调用方无法区分用户明确关闭与服务状态未知；能力查询异常也会被折成 `a11y: false`。真因：解析器把缺失布尔值默认为 false，诊断只保留 `heartbeat/off` 两态。修法：区分 `heartbeat/disabled/stale/unknown`，只让非未来且 20 秒内的独立无障碍心跳开放路由；保留带符号心跳年龄，未来时间戳继续 fail-closed。能力与路由诊断只对明确 disabled 输出 `available:false`，未知/陈旧提示调用方按实际结构化结果选备用路径。复验：bridge 全套测试、状态登记、桥对称和代码地图通过；本地完整工具输出 schema 门禁因引擎校验器缺席记为 `SKIP=1`，需由 PR Gate 强制运行；设备验证按用户要求未做，本改动尚不构成发布验收。

598. **包装器和替代 CLI 可藏住真实屏访问，畸形 -d 也可能回落默认屏（上游 #785/#788，2026-10-29）**

    现象：受限范围的 raw shell 门只识别既有命令族；`dumpsys activity` 可输出 View Hierarchy/bounds，`sendevent`/`getevent` 可读写默认输入设备，`cmd display` 可操作没有本仓身份认证的显示目标。包装器后的 shell/脚本解释器也可能通过 stdin 或文件运行；selector 解析若不先识别屏幕命令，还会把普通 `echo -d=7`、`ls -dx` 参数误当作目标屏凭据。`input` 的裸单词匹配还会把 `/dev/input` 这类文件路径误识别成 input CLI。

    真因：引擎与壳侧命令族表都漏了这些替代访问面；脚本扫描器只检查段首解释器，无法遍历可识别包装器后的命令；屏幕命令中的 `-d=7` 不符合受支持的数值参数格式，却被错误地等同于“没有目标参数”。修法：两侧同步加入 `dumpsys activity`、`sendevent`、`getevent`、`cmd display` 的无可认证目标家族；对包装器链后的 shell、su、文件路径和不透明解释器 fail-closed，普通 `nice echo/getprop` 仍保留可用；只在已识别的屏幕命令中拒绝畸形 `-d=...`/`-dx`，普通 `echo -d=7` 与 `ls -dx` 保持可用；input 词面要求有 argv。`cmd window` 继续按多显示器窗口接口拒绝，`wm user-rotation` 由既有 `wm-unscoped` 拦截，不采用上游放宽语义。

    复验：插件 screen-scope 测试与 `ShellOpsScreenCommandFixtureTest` 共读新增反例，涵盖 `nice sh/su/awk`、`taskset 0xff sh`、`env -S`、命令族拒绝、畸形屏幕 selector、普通 `-d` 参数正控及 `/dev/input` 路径正控。设备验证按用户要求未做，不能作为发版验收。

599. **三条高影响登记门禁曾无判据级反证测试（上游 #761/#762/#765，2026-10-29）**

    现象：控制 op 六面登记、模型工具 wire 预算与补丁 registry↔IMPLS 自洽都接入 PR Gate，但各自核心断言没有独立反证；阈值、差集或树内闭合逻辑一旦被误删，真实仓库仍可能因当前数据恰好一致而绿。真因：这些门禁直接读取生产树与生产基线，缺少可隔离的 fixture 根，因此无法稳定构造正例和受控漂移。修法：为控制 op 门禁加入临时 shell/plugin 根、`--ledger` 与既有 `--gaps` 注入口；工具预算门禁增加仅供测试的 `--root`，基线跟随临时树；补丁自洽门禁只加本树 `--root`，不恢复已移除的跨仓 peer 语义。三个 `.test.mjs` 覆盖合法树通过、关键差异失败、明确豁免/更新行为、坏台账 fail-closed 等，并接入 PR Gate。复验：每个测试文件均独立跑通，且至少一个受控负控对预期判据返回非零；设备验证不适用（L1 门禁改动）。

600. **截图数量上限只在写入前清理且枚举失败被吞掉（上游 #749，2026-10-29）**

    现象：`dsh-shot-*` 数量上限仅在新截图写入前执行；已有 20 个文件时本轮截图会短暂发布为第 21 个，且 `readdir/stat` 异常被吞掉后仍返回路径。ADB pull 失败时也可能留下部分本地文件。真因：清理函数把目录枚举当作尽力而为，而发布前没有对含本次产物的最终集合再核算；因此失败时既不能证明上限，也不会阻止新文件继续可读。修法：新增独立 `tmp-cache.ts`，截图完整落地后按 mtime 清理旧项并优先保留本次截图；目录清单缺失/枚举、stat、旧项删除失败时，删除本次产物并拒绝发布路径；ADB 失败与未落地路径清理部分文件。非截图 XML/detail 缓存路径不改变。复验：Manage 插件全量 Node 24 测试含缓存清理正例、null/throw 枚举负例、stat 与删除负例；本轮设备验证按用户要求未做，截图体验仍须在发布验收中确认。

601. **执行地图锚点只检查文件与行号，源码移动后仍可能静默指错（上游 #718/#781/#789，2026-10-29）**

    现象：`path:line` 仍落在文件有效范围内，但该行内容已因插入/重排变成另一段代码；旧门禁只看行数，因此排查地图可静默指向错误调用点。刷新旧基线若不约束引用计数，也可能把新增或移动坐标悄悄登记成旧锚点。真因：锚点判据没有读取源码内容，也没有固定历史坐标的引用数量。

    修法：检查器读取目标行内容；旧引用用 `scripts/check-code-map-anchor-baseline.json` 保存行快照和引用数，新/移动引用必须写 `#expect=<URI 编码片段>`。刷新拒绝未标注的新坐标或旧坐标新增引用；耦合证据原有文件存在和行号范围检查保留。CI 先跑检查器自检再跑正式门禁。

    复验：自检覆盖内容匹配/错配、损坏 URI、源码漂移、新坐标、移到已登记坐标、耦合证据内容与越界；正式门禁和受保护刷新负控通过。此为 L1 门禁改动，不需设备验收。

602. **检出字节负控用 LF 字符串删属性，CRLF 台账会让负控失效（2026-10-29）**

    现象：`checkout-reviewed-bytes.test.mjs` 读入 `.gitattributes` 后用字面 `" -text\n"` 删除受测规则；在 `.gitattributes` 以 CRLF 检出的工作树上，替换不命中，所谓去属性负控实际仍带属性。真因：负控假定了宿主工作树的行尾格式，和它要覆盖的 autocrlf 风险相冲突。修法：按行尾无关的行列表精确删除唯一规则，并在隔离 Git 仓中分别使用 LF、CRLF 台账验证。复验：`node --test scripts/source-build/checkout-reviewed-bytes.test.mjs` 通过；每个目标文件在两种台账行尾下均有正控和去属性负控。
603. **配置导出提示称不含密钥，但活动 profile 会原样复制（2026-10-29）**

    现象：设置页称导出不含 API 密钥；实际导出源是活动 profile patch，壳侧会原样复制并已返回“可能包含供应商密钥”的提示，但页面既丢弃该提示，也把文件名写死为 `settings.yaml`。真因：文案依据旧配置文件形态，未跟随迁移后的 profile 导出实现，且桥回执中的安全提示未被展示。修法：明确说明导出可能含供应商 API 密钥，展示壳侧返回的提示和实际路径。复验：新增 DevSection UI 回归核对实际路径和警告文本；PR Gate 将执行组件测试。本轮未完成 Android UI 三层设备验收，不能作为发版验收。

604. **主动 reasoning probe 档位数组缺少上限，重复值会放大请求（2026-10-29）**

    现象：主动 reasoning probe 接受任意长档位数组并逐项请求；相同有效档位重复出现时会重复向供应商请求。真因：工具 schema 的参数 DSL 不支持 `maxItems`，而插件运行时最初信任上游调用方且未做去重，导致模型或 schema 外调用能放大请求扇出。

    修法：插件自身拒绝超过六项的数组；请求前只保留唯一、已知且非 `off` 的档位，并在归一化结果为空时直接返回，不能继续发送负控请求；工具描述同步告知最多六项，运行时检查作为权威限制。

    复验：新增重复档位只触发一轮请求，超长列表在任何供应商请求（含负控）之前拒绝；`node scripts/check-code-map.mjs` 通过。PR Gate run `40851258072` 的插件单测、静态门禁与源码回归、Kotlin 编译和其余检查全部通过；PR #184 于 2026-10-29 以 merge commit `9e4198baf7c27782b54caf8b5a01601fd2d9b3aa` 合入。未做设备验证；此为插件逻辑改动，不是发版设备验收证据。

605. **real-only raw shell 门漏检运行时生成的命令词（2026-10-29）**

    现象：`cmd=screencap; $cmd -d <registered-display> -p ...` 的第二段命令名由 shell 变量展开决定；`real-only` 仅按静态命令词匹配屏幕命令族，因此引擎侧和 Kotlin 执行点都可能把该段当作非屏幕命令放行。`input` 与 `scr$CMD` 前缀拼接也具有同类风险。

    真因：动态命令词拒绝已接入 `virtual-only` 的 `screenCommandVerdict`，但 `realScreenAdbCommandDenied` 与 `ShellOps.realOnlyScreenCommandAllowed` 是独立判据，循环内未调用同一 `isRuntimeCommandName` 检查。

    修法：两侧 `real-only` 循环在静态家族分类前复用 `isRuntimeCommandName`；把前置赋值后的 `$cmd`、`input` 与静态前缀拼接反例加入插件与 Kotlin 回归测试。普通参数位置的运行时展开仍按原规则处理。

    复验：插件构建及 `npm test` 全量 184 项通过；`ShellOpsScreenCommandFixtureTest` Kotlin 单测、`check-bridge-symmetry.mjs`、`check-code-map.mjs`（含 `--self-test`）通过。ADB 当前无连接设备；现有 Pixel_Android16 AVD 配置是 API 36 `default/arm64-v8a`，不符合协议要求的 Google APIs 镜像；来源 APK 链只允许 `main`，不能从 PR 分支产出含本改动的 APK。因此设备层验收未做，不能作为设备验收或发版证据。

606. **Undo 导入只校验 manifest 身份仍会残留拒绝条目的 blob 或读取目录外文件（2026-10-30）**

    现象：ID 不匹配的快照会被拒绝，但旧顺序先把 ZIP 中所有 blob 写入共享库；伪造 manifest 还可用 `../` 哈希让 `readBlob` 读取 blob 目录之外的文件。真因：导入先产生 blob 副作用，且 blob 路径只检查 ZIP 条目名，没有约束 manifest 内的哈希引用与内容寻址关系。

    修法：先验证 manifest ID、嵌套 blob 哈希格式和 blob 内容 SHA-1；只把通过校验且被有效快照引用的 blob 写入。`readBlob` / `writeBlob` 对哈希格式再次 fail-closed。

    复验：`import-plaintext.test.mjs` 覆盖拒绝快照不留 blob、`../` 哈希不能越界、内容与文件名哈希不匹配时不导入；与消息撤销 beforeHash 清理回归一并通过。

607. **自动快照清理未把消息撤销 blob 纳入引用集合（2026-10-29）**

    现象：自动 prune 只从快照清单收集 blob 哈希，却会删除仍由消息批次 `beforeHash` 引用的内容；之后执行消息撤销会报告 before 内容缺失。真因：自动清理使用独立且较窄的引用逻辑，绕过同时覆盖快照与消息操作的公共收集器。修法：快照删除后重新收集当前引用，并与 `undoCompact` 共用 `collectReferencedBlobs`。复验：新增消息 beforeHash 被自动 prune 保留的回归用例；由 PR Gate 执行。
