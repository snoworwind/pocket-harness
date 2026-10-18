# 安全审计第二轮：未修复新发现登记（2026-10-17 晚）

用户后续已要求修复，当前实施与证据见 [修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md)。本文件保留发现时结论，以下「未修复」对应原审计轮次。

本轮按用户要求**只挖掘、只登记，不修复**。基线与上一轮同为 `2fbcc7f`（`git log -1` = `2fbcc7f docs: bind security evidence to source build run`，`security/hardening` 工作树无改动）。上一轮的四项修复与证据见 [SECURITY-AUDIT-2026-10-17.md](SECURITY-AUDIT-2026-10-17.md)；本轮登记的是此前 375 条坑位与那份审计**没有覆盖**的新问题，逐条附去重检索证据。

**结论性质**：以下 17 项全部是**源码级静态审查**结论（其中 390 另有本地假 DOM harness 复现，391 标 HYPOTHESIS）。**没有构建 APK、没有连接设备、没有跑 CDP/ADB、没有做设备利用复现，也没有修改任何代码**。因此它们既不是「已确认可利用」，也不是「已验收关闭」；其中若干项的最终可利用性依赖设备侧时序（例如 SharedPreferences 的进程内缓存）或构建环境（CI 全新目录 vs 本地续跑目录），条目里逐项标注。

审查方式：主 agent 负责壳侧（Kotlin/Android/通知/中继/桥面），三名子 agent 分区负责引擎插件、前端注入层、来源构建链；每个候选都由主 agent 回到源码逐行复核，子 agent 的推测项（未能定位调用链的）一律降级或剔除，未按「扫描器命中」计数。

---

## 一、发现总表

| # | 坑位 | 标题 | 面 | 严重度（本仓口径） | 置信度 |
|---|---|---|---|---|---|
| 1 | 376 | 用户专属授权状态（屏幕范围 / AI root 同意与开关 / su 授权态）落在 app-uid 可写的 SharedPreferences | 壳侧授权 | 高 | 源码确证；设备时序待验 |
| 2 | 377 | 桥面「用户专属」写方法没有用户在场证明，第三方客户端插件与页面同源 | 壳侧授权 / 插件生态 | 高（与 380 成链） | 源码确证 |
| 3 | 378 | 3080 中继 32 个槽位无鉴权，本地任意应用可占满并阻断 WebView→引擎 | 可用性 | 中 | 源码确证 |
| 4 | 379 | 通知审批/提问动作可被任意通知监听应用代按；回复动作 PendingIntent 可变；审批不要求解锁 | 跨应用信任 | 中 | 源码 + Android API 语义 |
| 5 | 380 | 市场安装工具把「是否需要用户确认」交给远端 riskFlags，空标记即无确认安装任意插件 | 模型面 / 供应链 | 高 | 源码确证 |
| 6 | 381 | Linux 运行时代码的信任锚是第三方仓 latest Release，manifest 与摘要同源 | 供应链 | 中高（默认不启用） | 源码确证 |
| 7 | 382 | model-capability 四个响应体没有字节上限，models.dev 刷新无 deadline 且跟随重定向 | 资源 / 启动 | 中 | 源码确证 |
| 8 | 383 | 未鉴权的 `GET /api/android/privilege/status` 每次触发一次特权控制队列占用 | 插件路由 | 中低 | 源码确证；可达性见条目 |
| 9 | 384 | ADBKeyboard 的 auth nonce 未加引号拼进 uid 2000 命令 | 命令构造 | 低 | 源码确证 |
| 10 | 385 | 最终快照与源码没有字节级绑定：只验 snapshot 内 package.json 的 name/version，比对的是可写缓存 tarball | 来源链 | 高（前置 = 构建期代码执行） | 源码确证 |
| 11 | 386 | `preinstall.json` 不从 `$GITHUB_SHA` 重建（同一步的 `engine-overlay.json` 重建） | 来源链 | 中高（续跑目录更高） | 源码确证 |
| 12 | 387 | pnpm standalone 与 canvas 只以同一服务器自声明的 sha512 校验，且 npmMirrors 无条件兜底第三方镜像 | 来源链 | 中 | 源码确证 |
| 13 | 388 | `.debs` 缓存命中只比 size（跳过 SHA-256），pnpm/canvas tarball 只按存在性复用 | 来源链 | 中低（CI 全新目录不受影响） | 源码确证 |
| 14 | 389 | Gradle 发行包没有 `distributionSha256Sum`，是 APK 链唯一未钉的下载 | 来源链 | 中 | 源码确证 |
| 15 | 390 | 隔离浏览器里任意网页的 `document.title` 被注入层当成设备路径：一次切页点击变成原生 `openPathChooser`，且点击被吞 | 前端注入层 | 中低 | 源码确证 + 本地 harness 复现 |
| 16 | 391 | 整文档子串哨兵 `x-dsh-pick-token` 可被插件命名命中，静默跳过整个注入层（看门狗/主题/剪贴板/桥） | 前端注入层 | 中（fail-silent） | 判据确证；注入点待设备确认 |
| 17 | 392 | `/api/android/open-path` 的会话范围只是建议：绝对路径直通，缺 session 时跨全部会话取首个存在项 | 插件路由 | 低 | 源码确证 |

严重度是本仓「对用户数据/授权边界的实际影响 × 前置条件」的粗分，不是 CVSS；每条都写了未证边界，**不得**把本表当作「已确认攻击成立」。

---

## 二、逐条详情

### 376. 用户专属授权状态落在 app-uid 可写的 SharedPreferences

**现象**：仓库把三类状态称为「用户拥有」，并且在文档与代码注释里明确「模型工具没有 setter」：

- 屏幕范围：`ScreenScopePrefs`（`app/src/main/java/com/dsharnessmobile/shell/ScreenScope.kt:52-66`，prefs 名 `dsh_screen_scope`，键 `scope`）；执行点 `DeviceControlService.realScreenScopeError`（`:731-768`）、`ShellOps.scopeDenied`（`ShellOps.kt:198-243`）、`VdisplayController`（`:614`）都从它读。
- AI root 同意与开关：`RootGrant`（`RootGrant.kt:63-73` 定义 `dsh_root_grant` / `granted` / `consentRevision` / `consentVersionCode`；`:124-128` `isGranted`；`:139-154` `setConsent`；`:160-185` `setGranted`）。唯一执行门是 `ShizukuTransport.rootGateRefusal`（`ShizukuTransport.kt:987-995`）与 `RootAccess.execPrivileged` 的 `requireAiGrant` 分支（`RootAccess.kt:247`）。
- 应用级 su 授权态：`RootAccess`（`RootAccess.kt:55-57` `dsh_root_access` / `state` / `uid`；`:96-99` `isGranted` 读缓存）。

**真因**：这些「门」的状态是普通 SharedPreferences，**没有任何完整性保护**（无 MAC、无签名、不在不可写位置）。而本产品的引擎（Node）由壳进程以**同一 app uid** spawn（`EngineManager.kt:1462` 的 argv、`:2287-2341` 的 `shellEnv`），README 第 16 行明写「完整的 dsh web agent，且能真实执行 bash」。模型自带的 bash 因此可以读写 `/data/data/com.dsharnessmobile.shell/` 下的任何文件，包括 `shared_prefs/dsh_screen_scope.xml`、`dsh_root_grant.xml`、`dsh_root_access.xml`。写入标准 SharedPreferences XML 即可让下一次读取得到伪造值：

```xml
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="scope">all</string>
</map>
```

`RootGrant` 的两键同理（`<boolean name="granted" value="true"/>` + `<int name="consentRevision" value="1"/>`）。`ShizukuTransport` 的 root 门只查 `RootGrant.isGranted`，不查 UI 是否同意过、也不查调用者是谁。

**触发与前置**：

1. 设备上已存在 root 通道（Shizuku 以 root 运行，或应用已被 Root 管理器授权 `su`）——这正是「AI root 权限」开关存在的场景；
2. 模型（被提示注入的 agent）先写 prefs 文件，再调用 `android_shell_exec` / 特权 op；
3. 时序：`ScreenScopePrefs.current` / `RootGrant.isGranted` 只在首次使用该通道时读取，**进程内会缓存**（`context.getSharedPreferences` 单例）。因此「写入 → 首次读取」在冷启动后、用户未打开过设置页（`phone-control.tsx:292/369` 才会读）时成立；若 prefs 已被读入内存，则需要一次壳进程重启——而 `EngineService` 返回 `START_STICKY`（`EngineService.kt:76-78`），模型可以让自己的父进程退出（同 uid `kill`），系统重启服务后重新读盘。两个路径都写在条目里，未在设备上验证哪一个先发生。

**影响**：模型可以**自行**把屏幕范围从 `virtual-only` 改为 `all`（随后无障碍/ADB 通道就能读真实屏），或把 AI root 的免责同意与开关一起置真（随后 uid 0 通道整体放行，`ShizukuTransport.rootGateRefusal` 直接返回 null）。这使「用户拥有的门」在威胁模型「模型不可信」下**不成立**：门只对别的应用有效，对模型自身只是文件写。

**为什么是新发现**：`docs/AGENTS/PERSISTENT-DATA.md:75-98` 把这些 prefs 登记为 app-private 并说明「Do not copy raw preference files into ordinary diagnostics」（只讨论了导出），没有任何一条登记「同 uid 的 agent 可改写门自身」；`grep` `docs/AGENTS/gotchas.md` 对 `dsh_root_grant` / `dsh_screen_scope` / `shared_prefs` 安全语义的命中为 0（仅有通知 offset 等使用记录）。

**本轮未证**：设备上的缓存时序、以及是否需要重启壳进程；没有写 PoC 文件，也没有跑 `adb`。

---

### 377. 桥面「用户专属」写方法没有用户在场证明，第三方客户端插件与页面同源

**现象**：`window.androidBridge` 暴露了四个直接改用户安全决策的方法：

- `setScreenScope(scope)`（`AndroidBridge.kt:343-349`）→ `MainActivity.kt:1208` 直接 `ScreenScopePrefs.set`；
- `setRootConsent(on)`（`AndroidBridge.kt:508-518`）→ 勾选免责声明；
- `setRootGranted(on)`（`AndroidBridge.kt:497-506`）→ 在通道为 root 时打开 AI root 开关；
- `unlockRestrictedSettings()`（`AndroidBridge.kt:445-447`）→ 经 Shizuku 执行 `appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow`。

这些方法都没有「这是用户手点的」证据：没有 `Activity` 前台/焦点校验、没有一次性用户手势 token、没有把「设置页可见」当条件。唯一的门是 `MainFrameBridge` 安装 facade 时的两条判断（`window === window.top` 且 `location.origin === http://127.0.0.1:3080`，`MainFrameBridge.kt:96-119`），而 BRIDGE-API 自己写明「该机制**不承诺**隔离同源任意脚本或可信顶层 XSS」（`docs/AGENTS/BRIDGE-API.md:21`）。

**真因**：引擎页是可信 UI，但同一个页面里还运行着**第三方客户端插件**（市场安装、profile 注入）与模型可影响的页面内容。任何在顶层同源执行的脚本都能在用户不知情时调用上述四个方法。把它们和 380 连起来就是一条不需要 XSS 的链：模型被注入 → 无确认安装一个「无风险标记」的市场插件 → 重启后该插件的 client 脚本在引擎页执行 → `setRootConsent(true)` + `setRootGranted(true)`（通道为 root 时）/ `setScreenScope('all')` → 用户从未点过任何按钮。

**影响**：与 376 相同的授权面，但入口从「写文件」变成「页面调用」，且不需要模型有 bash——只需要它能装一个插件（或页面出现任何同源脚本注入）。

**为什么是新发现**：桥文档只声明了「不隔离同源脚本」，没有把它与「这些方法本身是用户专属写面」的冲突登记；坑位里检索 `setScreenScope` / `setRootConsent` 只有功能与显示记录，没有「同源脚本可自授权」条目。

**本轮未证**：没有实际安装插件、没有在页面注入脚本验证；`unlockRestrictedSettings` 需要 Shizuku 就绪，未验证其实际命令路径（`ShizukuTransport` 侧只做了静态阅读）。

---

### 378. 3080 中继的 32 个槽位无鉴权，本地任意应用可占满

**现象**：壳进程为整个生命周期持有 `127.0.0.1:3080`（`EngineTransport.kt:20-34`），把 TCP 连接转发到应用私有 Unix socket，并在连接上校验对端 uid（`:46-59`，这是 350/352 的修复）。但 **TCP 侧的接入没有 uid 校验**，只有全局并发上限：

```kotlin
private val slots = Semaphore(32)            // :18
...
val client = try { server.accept() } ...
if (!slots.tryAcquire()) { client.close(); continue }   // :78
```

单个连接在 60s 无数据时超时（`:82`），但 `copyActive` 在超时前只要还有任意字节就续期（`:101-116`）。因此本地任意应用（无需任何权限）打开 32 条到 `127.0.0.1:3080` 的连接、每条偶尔发一个字节，就能让第 33 条连接被立即关闭——包括 WebView 自己的连接。

**影响**：应用自己的 WebView 连不上引擎，表现为错误页/白屏；引擎侧的 UI 轮询、通知 mux 也走同一端口。攻击者释放后自动恢复，但可以长期维持。这是纯可用性问题（不泄露数据、不提权），但触发门槛极低且没有速率限制、没有按 uid 配额。

**为什么是新发现**：350/352 记录的是「监听者冒充」与「向未知 listener 发凭据」，修复后**没有**再审查「中继本身成了新的无鉴权资源入口」；坑位检索 `Semaphore(32)` / `engine-private-relay` / 3080 拒绝服务均为 0。

**本轮未证**：没有在设备上复现 32 连接占满；未测量 WebView 的重连行为。

---

### 379. 通知审批/提问动作可被任意通知监听应用代按

**现象**：审批与提问的作答按钮是通知动作，动作 PendingIntent 指向 `NotifyActionReceiver`（`exported=false`，靠显式 Intent 防外部构造）。但：

- 审批动作 PendingIntent 为 `FLAG_IMMUTABLE`（`NotifyCenter.kt:1231-1249`），这不妨碍任何拿到该 `PendingIntent` 对象的应用**原样 send**；
- 回复动作刻意使用 `FLAG_MUTABLE`（`:1191-1203`、`:1155-1166`），以便 RemoteInput 注入 ClipData，因此持有者还能改写 `dsh.reply` 的文本；
- `APPROVAL_REQUIRE_UNLOCK = false`（`:88-89`，注释承认「真机 keyguard 行为未确证，先不阻塞开发循环」），动作未调用 `setAuthenticationRequired(true)`（`:1243-1246`）。

任何持有通知访问权限（`NotificationListenerService`，普通用户可在设置里授予，常见于「通知历史/清理」类应用）的应用，都能从 `StatusBarNotification.getNotification().actions[].actionIntent` 取得这些 PendingIntent，并以本应用身份触发——`exported=false` 对 PendingIntent 不构成限制（这正是 PendingIntent 的设计）。它还能用 `RemoteInput.addResultsToIntent` 伪造回复文本，代用户回答自由文本问题。

**影响**：通知监听应用可以代用户**批准工具执行**（审批 outcome 是闭集 `allowed-once` / `rejected`），在锁屏状态下也可（未设认证要求），并可代答提问。与 376/377 不同，这条不需要模型配合；它把「用户点通知」这一动作的授权面交给了第三方应用。审批是否覆盖高危工具取决于引擎的审批策略：如果某些工具要靠审批才放行，那么这就是一条旁路。

**为什么是新发现**：坑位检索 `FLAG_MUTABLE` / 通知监听 / 「代答」只有 UI 与投递记录，没有跨应用委托面；`NotifyCenter` 的注释把「不是他人代答」写成文案提示，而不是安全判据。

**本轮未证**：没有真实通知监听应用复现；`APPROVAL_REQUIRE_UNLOCK` 的锁屏行为本身也被源码注释标为未确证。

---

### 380. 市场安装工具把「是否需要用户确认」交给远端 riskFlags

**现象**：`dshmarketplace-plugin`（默认注入，`scripts/plugin-dirs.json:17`、`scripts/profile-web.cordis.patch.yml:52-53`）注册了两个模型工具：`dshmarketplace_search` 与 `dshmarketplace_install`。安装工具执行的是 `dsh plugin --profile <p> add <target>`（`vendor/dshmarketplace-plugin/lib/index.js` 的 `f()`；target 来自市场条目的 `install.cmd`，正则允许 `github:<owner>/<repo>[#ref]` 与 npm 包名）。

唯一的用户确认点在 `tools/pre-execute` 钩子：

```js
function y(t){return Array.isArray(t.riskFlags)&&t.riskFlags.length>0}
async function M(t,r){ ... let a=((await r({q:e,limit:5}))?.results??[]).find(i=>i?.fullName===e);
  if(!(!a||!y(a))) return {kind:"ask", ...} }          // 只有 riskFlags 非空才 ask
function b(t=c){return async(r,n)=>{ let e=()=>...{kind:"allow"}, s; try{s=await M(r,t)}catch{s=void 0}; return s??e() }}
```

即：工具不是安装工具、查不到条目、或**条目没有风险标记** → 返回 undefined → 落到 `{kind:"allow"}`。工具描述自己也写着「Detection is heuristic; an empty list would not have meant the plugin was safe.」（这是上游 0.1.7 的原话，本仓只打了 U2 路由鉴权等补丁，未改该判据，见 `vendor/dshmarketplace-plugin/PATCHES.md`）。

**影响**：远端目录（dshmarketplace.dev）及其风险标记是唯一判据。一个无风险标记的条目可以由模型在**没有任何用户确认**的情况下安装；`dsh plugin add` 会执行包安装（允许 `github:` 任意仓库），插件随后在引擎进程内以 app uid 运行，可读全部用户数据、调用桥与特权通道。提示注入（恶意网页/会话内容）→ 模型安装 → 代码执行，这条链不需要用户点任何按钮。

**为什么是新发现**：坑位里 marketplace 相关条目全是装配/构建/补丁锚点（坑 19、830-831、1083-1092），没有「安装确认判据由远端决定」这一条；`grep docs/AGENTS/gotchas.md` 对 `riskFlags` / `pre-execute` 为 0。

**本轮未证**：没有实际调用市场工具（无网络、无设备）；未验证 `dsh plugin add` 是否在安装时执行包的 lifecycle 脚本（这决定「安装即执行」还是「重启后执行」，两者都不改变结论）。

---

### 381. Linux 运行时代码的信任锚是第三方仓 latest Release

**现象**：Linux 环境的 runtime 插件不随 APK 分发，由 bootstrap 从 GitHub Release 下载：

- 默认 release 地址写死为 `https://github.com/kelai141/dsh-bionilux/releases/latest`（`plugins/dsh-android-linux-env/src/linux-host-asset-io.ts:167`）；
- 壳侧只接受该仓的 `releases/download/<tag>/<asset>` 形态（`LinuxAssetIO.kt:66-74` 的 `ALLOWED_HOSTS` 与 `REQUIRED_PATH_PREFIX`）；
- bootstrap 拉 `releases/latest` 的 `linux-release.json`，从**同一份 manifest** 里取 `sha256`，再下载并校验（`plugins/dsh-linux-bootstrap/src/github.js:80-96`、`src/asset-bundle.js:37-92`）。

**真因**：清单与摘要同源——摘要不是 APK 内固定值、也不是独立签名，而是由该第三方仓的发布者随二进制一起提供的。仓的发布权限（或账号被接管）就等于「向所有启用 Linux 环境的用户下发任意 JS」的权利。下载后的代码在引擎进程内以 app uid 运行；`known-gaps.md:76-92` 已登记「runtime 本体只来自 Release、未 vendored、未跑过真实 Release 产物」，但没有把「信任锚在第三方仓」写成安全缺口。

**影响**：启用 Linux 环境的用户，其应用沙箱内的代码执行权取决于 `kelai141/dsh-bionilux` 的发布权限。默认不启用（`environmentVerdict` 要求根目录 + `linux-bootstrap-state.json` 在场），所以是「用户显式启用后的供应链风险」，不是默认可达。

**为什么是新发现**：`grep` `docs/AGENTS/*.md` 对 `dsh-bionilux` 只有镜像/来源记录与「默认不启用」；坑位 366 修的是「大小不能证明完整性」，没有触及「摘要由同一可写方给出」。

**本轮未证**：没有启用 Linux 环境、没有跑真实 Release；`minMobileVersion` 等版本闸门只做了静态阅读。

---

### 382. model-capability 的响应体没有字节上限

**现象**：四处出站 HTTP 直接 `await response.text()` 后再解析，没有在流上计数：

- `plugins/dsh-model-capability/src/index.ts:743-748`：`fetchImpl(MODELS_DEV_URL, …)` → `JSON.parse(await response.text())`；该刷新在启动时触发（`:1399` `refreshModelsDevOnStartup()`），缓存过期/缺失时每次启动都跑；
- `plugins/dsh-model-capability/src/capability-probe.ts:403-409`（被动发现 `getJson()`）、`:541-547`、`:579-585`（reasoning 探测）：同样先 `text()` 再解析（这些点有 `redirect:'error'` 与超时，但没有体量上限）；
- 唯一的尺寸门在 `plugins/dsh-model-capability/src/models-dev.ts:333-338`，是**读完之后**才 `JSON.stringify` 量字节并拒写——对内存占用已经来不及。

对照：同日修复的 `plugins/dsh-linux-bootstrap/src/github.js:10-61` 已改成流式累计 + 超限抛错（坑 373）；本处没有跟进。

**影响**：被用户配置的「OpenAI 兼容」网关、或 models.dev 源/CDN 返回超大响应/无限流时，引擎（V8 堆有上限，坑 362）会 OOM 崩溃；models.dev 刷新发生在启动期，持久化的超大响应会变成启动即崩的循环。被动发现路径还会把伪造的能力值写进 `settings.yaml`（次要完整性问题）。没有凭据发往 models.dev（只有 accept 头），所以不是凭据外泄。

**为什么是新发现**：坑位对 `models.dev` 的三处命中只讲来源梯与**落盘前**的尺寸上限；`capability-probe` 只被坑 340 覆盖（凭据出口/重定向）；`response.text` 在坑位里 0 命中。

**本轮未证**：没有构造大响应测试；OOM 阈值是推断。

---

### 383. 未鉴权的 `privilege/status` 会触发一次特权控制队列占用

**现象**：`/api/android/privilege/status` 被登记为 `access: "public"`（`scripts/api-route-auth-policy.json`，rationale 明写「contains no … mutation route」），handler 使用 `authorizePublicReadOnlyRoute`（`plugins/dsh-android-bridge/src/index.ts:1917-1925`）。但在返回之前它执行：

```js
await svc.shizukuChannelProbed()   // :1930
```

`shizukuChannelProbed()`（`:701-713`）在 10s TTL 外会 `await this.controlExec('vdInfo', {}, 4000)`——把一条 `vdInfo` 投进与所有模型设备工具共用的**单槽**控制队列（`control-queue.ts:141-144`：`if (this.pending) return {ok:false,error:'已有在途…'}`）。

**影响**：任何能连到引擎 HTTP 面的调用者（本地应用经 3080 中继、伪造 `Host: 127.0.0.1:3080` 即可过 public 栅栏；或页面/同 uid 代码）每 10 秒发一次 GET，就能让控制队列最多 4 秒处于占用，模型侧的 `android_ui_*` / `android_screenshot` 等工具随机返回「已有在途」。这是「只读路由」里的副作用，与登记表理由不一致。

**为什么是新发现**：坑位对 `shizukuChannelProbed` 的两处命中只讲三态 caps 探测机制；`privilege/status`、`publicRouteRejected` 在坑位与上一轮审计里 0 命中。`check-api-route-auth.mjs` 只校验登记标记，不校验「public 路由无副作用」。

**本轮未证**：没有在设备上压测；public 栅栏在真实引擎的 `connection.requestRejection` 下是否对裸 TCP 客户端返回 403，取决于上游 Host/Origin 语义（`authorizePublicReadOnlyRoute` 只在 403 时拒绝，401 放行），这一点需要设备事实确认。

---

### 384. ADBKeyboard 的 auth nonce 未加引号拼进 uid 2000 命令

**现象**：`plugins/dsh-android-manage/src/index.ts:43-52`

```ts
const nonce = readFileSync(join(base, 'adb-keyboard-nonce'), 'utf8').trim()
return nonce ? ` --es auth '${nonce}'` : ''
```

`msg` 参数做了 `'` 转义（`:2006`、`:2029`），`authArg` 没有。nonce 正常由 `AdbKeyboardService.ensureNonce` 用 `BigInteger(256, SecureRandom()).toString(16)` 生成（纯十六进制，无引号），所以这是**防御纵深缺口**：同 uid 能把该文件内容改成 `x'; id; echo '` 的一方（模型自己的 bash、或写得进 `$DSH_FILES_DIR` 的插件），可以让下一次 `android_ui_input` 的 uid 2000 命令在单引号处断出并追加命令。

**影响**：把「输入文本」工具变成 uid 2000 的命令执行。由于 `looksDangerousAdb` 仍作用于拼接后的整条命令，且模型本身已有 `android_shell_exec`（uid 2000）能力，实际增量能力有限；但「文本工具静默变成 shell」是应当登记的类型缺陷，且 nonce 文件一旦被写坏，正常输入路径也会一起坏掉（可用性）。

**为什么是新发现**：坑 183 记录的是 nonce **泄漏**与隐式广播目标，不涉及 shell 引号；`adb-keyboard-nonce` / `authArg` 在坑位里 0 命中。

**本轮未证**：没有设备实测；实际可达性依赖「同 uid 写 nonce」这一前置。

---

### 385. 最终快照与源码没有字节级绑定

**现象**：`check-dsh-source-snapshot.mjs` 从 `snapshot.tar.xz` 解出包目录后，逐包检查的是：

1. `package.json` 的 `name` / `version` 等于 manifest（`:113-116`）；
2. 缓存目录里那个 **tarball** 的 sha256 等于 manifest（`:117-120`）——注意它哈希的是 `packageCache` 里的 `.tgz`，**不是快照里实际要运行的 JS 字节**。

而 manifest 与缓存 tarball 都由同一次构建生成：`export-dsh-engine.mjs:94-101` 在 `pnpm pack` 后计算 sha256 并写进 `source-build-manifest.json`（`:106-121`）。两者都在 `.deploy-tmp/` 这类**构建期可写**的工作区里。

**真因**：这正是坑 336 已确立、但只应用到 `record-project-components.mjs` 的原则——「报告可被依赖/构建脚本改写，不可变字段必须从 Git 重建」（该文件 `:97-99` 有原文注释）。快照主载荷没有这条：它信任同一次构建写下的 manifest 与 tarball 哈希，且从不把快照内文件与 tarball 比。构建期能跑代码的一方（被投毒的传递依赖、插件的 postinstall/`npm run build`）可以在打包前改写源码目录、在打包后改写 tarball 与 manifest，使校验仍绿；最终 APK 里运行的 JS 与固定 commit 之间只有「metadata 声称」这一层。

**影响**：来源构建的产物身份（`sourceBuild.provenance`、归一化摘要、`source-engine-snapshot-check.json`）描述的是构建自报的字节，不是独立可复核的字节。发布出去的引擎内部包可以被替换而不被任何门禁发现。

**为什么是新发现**：坑位里 `source-build-manifest` 0 命中；`export-dsh-engine` 的 3 处命中都是坑 210 的可复现性/键序，与信任无关。336 只修了项目组件报告，未覆盖引擎快照。

**本轮未证**：没有改字节跑门禁（只做了静态对照）；未验证 CI 里 `.deploy-tmp` 的写入者范围（这决定前置的现实性）。

---

### 386. `preinstall.json` 不从 `$GITHUB_SHA` 重建

**现象**：同一个 workflow 里对两个配置文件的处理**不一致**：

- `engine-overlay.json`：`.github/workflows/build-apk-source.yml:189` 用 `git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > …` 重建，注释写明「Regenerate from the immutable audited project commit, not the previous run artifact」；
- `preinstall.json`：`:513` 直接从**工作树** `cp scripts/snapshot-config/preinstall.json .deploy-tmp/source-build/preinstall.original.json`，`:515` 原地改（追加 `nodejs-lts` / `requiredTargets`），`:609-611` 结束时再用这份「原件」恢复。

`preinstall.json` 决定：Termux 预装包集合（`targets`/`requiredTargets`）、pnpm standalone 版本（`pnpm.version`）、canvas 的 npm 包名与版本（`canvas.pkgs`），见 `scripts/build-snapshot-013.mjs:59/71/727/840-841`。它位于步骤 `:513` 之前的所有构建动作（harness build `:255`、`pnpm install` `:196`、插件 `npm ci`/`npm run build` `:450-452`）之后才被复制。

**影响**：构建期代码可以改写工作树里的 `preinstall.json`（或在上一次构建留下的续跑目录里留下改动），让快照装入不在 commit 里的 npm 包或 Termux 目标；没有任何门禁会把它与 `$GITHUB_SHA` 比对（`check-engine-overlay` 只检查 overlay 清单）。对本地 `--build-workspace` 续跑链（`run-local-source-chain.mjs`）风险更高：续跑目录是保留的，任何能写该目录的过程都能植入。

**为什么是新发现**：坑 210（`gotchas.md:1140` 附近）只讨论 Termux 目标「不带版本、未钉」的版本固定问题，不是该文件的重建来源；`preinstall.json` / `npmMirrors` 在坑位里 0 命中。

**本轮未证**：没有实际篡改构建；CI 是否每次全新 checkout 决定了「构建期改写」还是「续跑目录」是主路径。

---

### 387. pnpm standalone 与 canvas 只以同一服务器自声明的 sha512 校验

**现象**：`scripts/build-snapshot-013.mjs`

- `:728` `const NPM_MIRRORS = PREINSTALL.npmMirrors`（`preinstall.json:7` = `["https://registry.npmjs.org","https://registry.npmmirror.com"]`）；
- `:744-753` 取 `meta.dist.sha512` 校验 pnpm tarball；`meta.dist.sha512` **缺失时不报错**，只 `console.warn('pnpm metadata lacks dist.sha512 — integrity check skipped')`（`:752`）；
- `:862-867` canvas 同形。

摘要来自**同一份元数据响应**，不是仓库内固定值；而镜像列表在 npmjs.org 失败时会**无条件**切到 `registry.npmmirror.com`（`:215`/`:728` 的镜像循环），workflow 只覆盖 `mirrors` 不覆盖 `npmMirrors`（`:618`）。

**影响**：APK 内 `usr/lib/node_modules/pnpm`（后续 `dsh plugin add` 会执行它）与 profile 的 canvas 原生模块，是仅有的「既不随源码树、也没有仓库内固定哈希」的运行时字节。镜像或 CDN 行为异常时，服务端可以同时给出 tarball 与匹配的自声明 sha512，构建无法分辨；这与本仓 `run-local-source-chain.mjs:214-215` 自己写的「镜像只改下载地址、不改字节，pnpm 按锁文件校验」不一致——这里没有锁文件。

**为什么是新发现**：坑 7 记录的是「缺 `dist.sha512` 时降级」这一行为本身，没有记录「摘要与字节同源」与 npmmirror 兜底；`npmMirrors` / `npmmirror` 在坑位里 0 命中。

**本轮未证**：没有实际切换镜像；npmmirror 是否对同一 tarball 给出一致的 sha512 未查。

---

### 388. `.debs` 缓存命中只比 size，跳过 SHA-256

**现象**：`scripts/build-snapshot-013.mjs:518-528`

```js
const file = join(DEBPOOL, n + '.deb')
if (existsSync(file) && statSync(file).size === p.size) { ok++; continue }   // 命中即跳过
...
// p.sha256 校验在命中分支之外
```

`DEBPOOL = join(OUT_DIR, '.debs')`（`:100`）位于工作区/续跑目录内；pnpm（`:731`）与 canvas（`:849`）的 tarball 更是只判 `existsSync`，命中后连 size 都不比。

**影响**：续跑的本地链（`--build-workspace`）或任何能写该目录的过程，可以在缓存里放入「size 相同、内容不同」的 `.deb`，装进快照的 `/usr`；CI 每次全新目录时不触发。这与同仓其它缓存的做法相反（bootstrap、NDK 命中都会重验，`build-apk-source.yml:424-428`、`:546-553`；`source-chain-rerun.test.mjs:104-123` 还断言「只复用已认证命中」），`.debs` 是例外。

**为什么是新发现**：坑位对 `DEBPOOL` / `.debs` 0 命中；`幂等缓存` 0 命中。

**本轮未证**：没有构造 size 相同的替换包；CI 的缓存目录是否跨 run 保留需要看实际 workflow 的 artifact/cache 配置（静态阅读未见缓存 `.debs`，故按「本地续跑为主」记录）。

---

### 389. Gradle 发行包没有 `distributionSha256Sum`

**现象**：`gradle/wrapper/gradle-wrapper.properties:3` 只有

```properties
distributionUrl=https\://services.gradle.org/distributions/gradle-8.11.1-bin.zip
```

没有 `distributionSha256Sum`。APK 由 `build-apk-source.yml:716-717` / `scripts/build-apk.mjs:377-386` 调 `./gradlew` 构建，wrapper 会在每次全新环境下载该 zip（链路无 Gradle 缓存步骤）。

**影响**：Gradle 发行包是整条 APK 链里**唯一**没有仓库内哈希的下载（NDK 有 sha1、bootstrap 有 sha256、marketplace tarball 有 sha256，且命中都重验）。services.gradle.org 或其 CDN 被重定向/投毒时，构建工具本身可被替换，产出「签名正确但内容被植入」的 APK；没有任何门禁能发现。

**为什么是新发现**：坑位与审计文档对 `distributionSha256Sum` / `gradle-8.11.1` / `services.gradle.org` 均 0 命中（坑 262 只讨论 wrapper 缓存键）。

**本轮未证**：没有实际替换发行包；未查本机 `GRADLE_USER_HOME` 的既有缓存是否让本地链绕过下载（CI 是全新环境）。

### 390. 隔离浏览器页面的 `document.title` 被当成设备路径

**现象**：注入到引擎页的 `dsh-host-web-compat` 有一段捕获阶段的全局 click 监听（`dsh-host-web-compat/lib/index.js:614-626`），把**任何元素上含 `/` 或 `.` 的 `title` 属性**当成文件路径：

```js
var path=el.getAttribute&&el.getAttribute('title');
var isFileLike=path&&(path.indexOf('/')>=0||path.indexOf('.')>=0)&&path.length<500;
if(!isFileLike)return;
if(hasUpstreamHandler(el))return;
var consumed=window.__dshOpenPath(path,'view');
if(consumed){e.preventDefault();e.stopPropagation()}
```

而引擎页里确实存在把**远端网页可控字符串**写进 `title` 的路径：隔离浏览器的 `onReceivedTitle` 把网页 `document.title` 写进 `tab.title`（`app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt:993-995`），经 tabs JSON → `native-browser-bridge.ts:96` → 气泡导航的 `row.select.title = row.label.textContent || tab.record.title`（`dsh-client-ui-responsive/src/client/mobile/sidebar-bubbles.ts:342`；`cloneTitle` 在 `:94-103` 只剥离 id/tabindex/aria-controls/data-*，**不剥离 title**）。

**触发**：用户在隔离浏览器打开任意恶意页 → 页面设 `document.title = "/storage/emulated/0/Download"`（设备上必然存在，且在 PathOpen 的外部存储允许面内）→ 用户点侧栏气泡的「切到该标签」图标（target 是 SVG 字形，`while` 循环走到带 title 的 `<button>`）→ 注入层的捕获监听先执行，调用 `window.__dshOpenPath(path,'view')` → `androidBridge.openPathChooser` → `PathOpen.openChooser`（存在性 + 允许面通过）→ 系统「打开方式」选择器弹出，同时这次点击被 `preventDefault + stopPropagation` **吞掉**，切页不生效。

**影响**：不可信 web 内容 → 原生特权 UI（confused deputy）+ 核心导航控件被劫持；可见标签（气泡上的 tab 名）与实际打开的路径**不需要一致**。边界：`PathOpen` 仍做 `exists()` 与 allowlist，用户仍要自己选应用，因此不是代码执行；但页面可以指定任意存在的外部存储文件（例如它刚诱导用户下载的那个），把「打开文件」这一步交给用户完成。

**为什么是新发现**：`isFileLike` / `getAttribute('title')` / `BrowserTitle` / `dsh-bubble-heading` 在坑位与两份审计里 0 命中；`openPathChooser` 的既有文档只写 mention/tool-row 路径（BRIDGE-API.md:166/173），apk #350 的修复只加了 `hasUpstreamHandler` 放行，没有「文件 vs 提示文本」的判别。

**本轮证据**：子 agent 在仓库外（`%TEMP%`）用真实抽取的 `PICKER_SCRIPT` 在假 DOM 上跑了四种点击，`/storage/emulated/0/Download` 的 title 得到 `openPathChooser(path,'view')` 且 `preventDefault: true`；`title="true"` 不触发。**未做设备验证**。

---

### 391. 整文档子串哨兵可被插件命名命中，静默跳过整个注入层

**现象**：`dsh-host-web-compat/lib/index.js:1114-1116`

```js
ctx.webServer.tapIndex((html) =>
  html.includes('x-dsh-pick-token') ? html : html.replace('</head>', POLYFILL_SCRIPT + '</head>')
);
```

这个哨兵本意是「已经注入过就不再注入」（`POLYFILL_SCRIPT` 自身含该字符串）。但 `x-dsh-pick-token` 同时是**目录选择结果路由的鉴权头名**，而它出现的判据是**整份 HTML 子串**：只要服务端返回的 index.html 里因为任何原因含有这串字面量，整个 `POLYFILL_SCRIPT` 就被跳过——里面包含 polyfill、40s 启动看门狗与壳侧解析的 `[dsh-boot-ready]/[dsh-boot-stall]/[dsh-boot-failed]` 契约行、主题桥、`window.__dshBridge`/`__dshOpenPath`/目录选择轮询、以及剪贴板回退。

**可能的注入源**：客户端 boot graph 以全局 `__DSH_BOOT__` 注入 index（`scripts/patches/tests/fixtures/dsh-client-modules-0.2.0-rc.2/lib/index.js:493`，行由 `graphRow(id, rev, fields)` 生成，含 `id` 与 `inject` 服务名）。第三方插件的 client entry `id` 或任一 `inject` 键若叫 `x-dsh-pick-token`，哨兵就会在**每一次** index 响应上命中，注入层整体静默消失。

**影响**：fail-silent 的兼容/诊断层退化——启动看门狗的 stall/ready 契约行不再出现（壳侧的回滚编排依赖它）、剪贴板回退失效、主题桥失效、路径桥失效、旧内核缺 polyfill。没有报错、没有日志、没有壳侧信号。是否可达取决于 boot graph 是否真的被序列化进 tapIndex 拿到的同一份 HTML（host-webserver 不在本仓，**这一步未验证**），因此本条标 HYPOTHESIS。

**为什么是新发现**：`x-dsh-pick-token` 在坑位与两份审计里 0 命中（只作为鉴权机制出现在 EXECUTION-MAP/BRIDGE-API），`STATIC_FALLBACK_SCRIPT`/`assertInjectionsParse` 亦 0 命中。

**最便宜的确认**：设备上用 `curl -s http://127.0.0.1:3080/ | grep -c '__DSH_BOOT__'` 确认 graph 在 HTML 里，然后临时加一个 `inject: { 'x-dsh-pick-token': {} }` 的客户端插件，重载后确认 HTML 出现哨兵字符串且 polyfill 标记消失。

---

### 392. `/api/android/open-path` 的会话范围只是建议

**现象**：`dsh-host-web-compat/lib/index.js:1226-1230` 与 `:1261-1270`

```js
if (rel.startsWith('/')) { return existsSync(rel) ? { abs: rel } : { error: 'not-found', ... } }
...
const abs = resolvePath(cwd, rel)
try { if (existsSync(abs)) return { abs, guessed: true } } catch { ... }
```

绝对路径分支**不做任何工作区/会话约束**，只判存在；无 `sessionId`（或未知 session）时，相对名会在**所有活跃会话的 cwd** 里逐个试，返回第一个存在项并标 `guessed:true`。页面侧 `:717` 只读 `j.abs`，不读 `guessed`。

**影响**：路由是 token 门控的，调用者只能是引擎页/模型内容，所以不是越权读取文件内容；但（a）它给页面一个**全设备存在性 oracle**（`not-found` 与 `{abs}` 的响应体不同，且比 `openPathChooser` 的 `not-exists` 更直接），（b）跨会话解析让「这个路径属于当前会话」的不变量失效，页面可把另一个会话工作区里的文件交给原生选择器。严重度低。

**为什么是新发现**：`guessed` / `resolveSessionPath` 在坑位与两份审计里 0 命中；EXECUTION-MAP 只写了该端点的会话意图，没有这两个旁路。

**本轮未证**：没有跑 `open-path-session.test.mjs` 的反证；`PathOpen` 的允许面仍然兜底。



| 项 | 事实 | 不立条目的理由 |
|---|---|---|
| `materialize-dsh-pnpm-packages.mjs:50` 用 manifest 包名拼写入目标，无 `within()`；兄弟脚本 `inject-dsh-engine-packages.mjs:48-49` 有 | `join()` 会折叠 `..`；但要真正写到树外，目标目录必须已存在且其中的 `package.json` 的 `name` 等于该带 `..` 的字符串（`:51-55` 的身份校验） | 前置「已在树外具备写权限与可伪造 package.json」比结果更强，不构成独立原语；作为 385 的次生现象记录 |
| `dsh-shell-termux/src/index.ts:178-186` 的 env 合并只删 `DSH_*` 三键，不删 `PATH`/`LD_PRELOAD`/`BASH_ENV` | 引擎内调用方目前都传 `env: {}`（`plugins/dsh-android-bridge/src/index.ts:1205`、`:1557`） | 没有找到可达调用链；若将来有插件把外部 env 透传给 `ctx.shell.run`，会变成 bash 启动代码/加载器劫持，登记为后续审查点 |
| `file-open` 所有权清单用换行分隔且逐行 trim（`plugins/dsh-android-file-open/src/index.ts:57-69`），路径含 `\n` 可伪造一条「已创建」记录，`/clean` 会 unlink 它 | 需要同 uid 在 incoming 工作区放一个带换行的文件名；而该攻击者本来就能直接删 | 低危、且不越过任何权限边界；按「记账不变式」缺陷留给 370 的后续轮次 |
| `MainActivity.onJsAlert` 无条件 `result.confirm()`（`MainActivity.kt:1118-1127`） | 页面 `confirm()` 永远为真；引擎页/插件若用 `confirm` 做破坏性确认，不会真正询问 | 未发现产品代码依赖 `confirm` 作为安全门；属 UI 语义问题，不进安全坑位 |
| `STATIC_FALLBACK_SCRIPT` 不在 `assertInjectionsParse` 的断言列表里（`dsh-host-web-compat/lib/index.js:1101-1106` vs `:1122`） | 该脚本含渲染前唯一的可见占位与 `window.onerror` 诊断行；一个语法错误会让白屏场景连兜底都没有 | 无攻击者控制面，是注入层自身门禁的纵深缺口；与 391 同族但不可被命名触发，故不单列 |

---

## 四、覆盖与阴性结果（本轮确实查过、没查出东西的面）

这些是「查了、没有新发现」，不是「安全」的证明：

- **插件路由鉴权**：20 条注册逐条读过（bridge 1 + 控制队列 2、file-open 5、linux-env 2+2+1、linux-environment 7、browser 1、vdisplay 1、model-capability 1）。除两条已登记的 public status 路由外，每个 handler 都在读 body/变更前授权；`/pending`、`/result` 用 body token + 1 MiB 上限。
- **屏幕范围解析**（`plugins/dsh-android-bridge/src/screen-scope.ts` 与壳侧 `ShellOps`）：引号/分段/嵌套、`$()`/反引号/`sh -c` 递归、`-d` 拼写与位置认证、路径执行/glob/env 覆盖/控制结构拒绝、`unparsed` fail-closed。没有构造出可自证的绕过（未 fuzz）。
- **runtime-cache 清理**：白名单 + 执行前 `insideAllowedScope` 复查 + 日志槽非递归 unlink + 一个白名单目录的 lstat 递归删除；未证明穿越/链接/TOCTOU。
- **linux-env 归档解包**：`..`/NUL/绝对路径拒绝、链接与特殊条目禁止、重复路径拒绝、`wx` 创建、声明/解码/条目上限、sha256 路径段。
- **file-incoming `/content` 与 `/claim`**：FD 固定、`O_NOFOLLOW`、`/proc/self/fd` realpath、dev/ino 复核；未发现新问题。
- **bootstrap GitHub 发现**：字节与 deadline 上限、最终 URL host 白名单、版本化资产路径、摘要+体量（坑 373 的修复有效）。
- **workflow 注入面（阴性）**：`pull_request_target` 0 命中、`secrets.` 0 命中；五个 workflow 中所有 `${{ }}` 都落在 `env:`/`name:`/`path:`/`with:`，没有进入 `run:` 体；外部 action 全部 40 位 SHA 固定且 `check-workflow-action-pins.mjs` 判定一致；`permissions` 最小（build 只 `contents: read`，写 token 只在 `release-source-draft` 的 draft job，且不 checkout 不受信字符串）；`gh release create` 参数为常量或经校验。**这是阴性结果，不是「供应链安全」的结论**（385-389 正是供应链其余缺口）。
- **marketplace 客户端 `esc()`**：`webpages` 页面里 release 数据进 DOM 的路径都经过 `esc()`/`textContent`，`scriptJson` 阻断 `</script>`；未发现可用注入。
- **前端注入层与客户端 UI 的注入面（阴性）**：`dsh-client-ui-responsive/src` 里 `postMessage`/`message` 监听 = 0、写 HTML 的 sink（`innerHTML`/`outerHTML`/`insertAdjacentHTML`）= 0；`webpages` 的 `release.js`/`app.js` 远端字符串全部经 `esc()`，下载 href 恒带静态 https 镜像前缀，镜像响应从不执行（无 JSONP/eval/document.write）；`assets/patched` 在本分支已不存在。
- **`dsh-host-web-compat` 的其余面**：目录选择 token 校验、`open-path` 以外的路由、剪贴板回退链、主题桥均只做了 sink 级抽查；**这是本轮覆盖缺口**。

---

## 五、证据等级与未做事项

| 项 | 状态 |
|---|---|
| 代码阅读 | 全部 17 条的根因位置、调用链、前置条件都读过源码；引用的行号以 `2fbcc7f` 工作树为准 |
| 动态验证 | **无**。没有构建 APK，没有 adb 设备（本机无 `adb` 命令），没有 CDP、没有真机 |
| 利用复现 | **无**。所有条目都是「源码可证 + 前置条件」；没有写 PoC、没有改仓库 |
| 测试 | **无新增**。按用户指示本轮不修复，因此没有新增会红的回归用例（避免把未修缺陷塞进 CI 阻断链） |
| 去重 | 每条都跑了 `docs/AGENTS/gotchas.md`（2499 行）与 `SECURITY-AUDIT-2026-10-17.md` 的关键词检索；命中的重复项已剔除或降级 |
| 后续 | 按用户指示，本轮**不修**；修复与三层验收（代码/CDP/ADB）留待用户决定优先级后进行 |

本轮不改变任何既有验收结论：上一轮审计的设备缺口（无设备、无来源链 APK、未做三层）继续有效；本文件也不构成「已发现全部漏洞」的结论。
