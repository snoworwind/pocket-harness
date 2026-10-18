# pocket-harness — 安卓上的随身 Agent 壳

[English README](README.en.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)

> 独立项目，基于 [dsh-mobile-apk](https://github.com/snoworwind/dsh-mobile-apk) 的 `security/hardening` 分支提交 `cb1c315` 建立；运行时仍使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。基线与未迁移标识见 [项目基线](docs/AGENTS/BASELINE.md)。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓壳：WebView UI 覆盖
**内嵌 Termux 运行时快照**（解压即跑，无需 Termux app）、SAF 目录桥、保活前台服务、引擎看门狗、
内嵌快照部署与恢复。一个 APK 装完即用：完整的 dsh web agent，且能真实执行 bash。

> **本项目宗旨：最大程度提高安全性和可验证性。** 范围、实施原则、已接受风险与证据要求见 [安全加固分支宗旨](docs/AGENTS/SECURITY-HARDENING.md)。

当前使用独立应用名 `Pocket Harness`（口袋终端图标）、包名 `com.pocketharness.shell`、
源码版本与 versionCode 见 [构建声明](app/build.gradle.kts)，后缀由构建属性决定；引擎 `@deepseek-ai/dsh` 0.2.0-rc.2（本地开发候选，**未发布**）。应用名、applicationId 与 APK 产物前缀的迁移边界见 [项目基线](docs/AGENTS/BASELINE.md)。

> **插件市场适配警示**：内置市场牵涉大量第三方插件，**绝大多数插件在手机端不一定可用、大概率有 bug**
> （移动端与桌面端在 WebView 内核/文件系统/权限模型/运行环境差异大）；移动端适配是长期工程，
> beta 阶段以「可用性验证与反馈」为主，暂不建议当作生产依赖。
> 插件报错请到 [issues](https://github.com/snoworwind/pocket-harness/issues) 反馈（附机型/版本/复现步骤）。

## 功能

### 运行时与生命周期

- **内嵌运行时**：xz 快照内置 node + git + bash + coreutils + dsh + 插件 + pnpm + python/perl/ruby；
  首启解压 2-4 分钟（`refreshSnapshot`），引擎监听 `127.0.0.1:3080`；完全离线。
- **手动升级应用**：本项目已移除应用内检查、下载和安装更新；升级时自行下载对应 ABI 的新版 APK 并覆盖安装。
- **内嵌快照部署与恢复**：随 APK 提供运行时；需要刷新时先解压到 staging、校验后事务换入。
  保留中断恢复和历史在线事务恢复，保护会话、附件、设置、凭据与工作区。
- **保活**：前台服务 + 5 秒看门狗（自动重拉挂死引擎）+ 3 秒 UI 轮询 + 崩溃自动回退闸门（UndoGate）。
- **内置控制台**：独立 bash 交互终端（`assets/console.html`），引擎未运行也可排查。

### AI 浏览器（隔离 WebView 工作台）

- 右侧栏独立工作台，**与主 UI 完全隔离**的第二个 WebView；AI 可开页签、多网页同时管理，
  人打开即可查看多个页签——**UI 是给人看的，AI 走工具直接读信息**。
- **分辨率 = CSS 视口**（document-start 注入 `width=<cssW>` + 物理矩形等比 letterbox），
  `window.innerWidth` 精确等于请求值；**PC / 手机身份**可切换（UA-CH 能力门，WebView 110 degraded 如实上报）。
- 侧栏收起时视口**不再塌成 0x0**（可见性用 `INVISIBLE` 而非 `GONE`，保留布局 + 按上次舞台尺寸给非退化矩形）。
- `browser_snapshot` 渲染每行 ref（不再只报计数，模型拿得到可点目标）。
- 滚动避让、Edge 式错误页、关闭即销毁、失败渲染兜底。

### 虚拟屏（独立屏幕运行第三方 App）

- 经 **Shizuku 特权通道**创建虚拟屏，第三方 App 在独立屏幕运行，**不挤占用户前台**；
  单实例上限 1 块，序号复用（`virtual-1` 恒为「没有屏时新建」的号）。
- **跨屏拉起唯一可行路径**：壳侧 Shizuku UserService 的 `am start --display <id> -n <component>`
  （固定 argv，先 `cmd package resolve-activity`）；其余三条路实测均不成立
  （`monkey --display` 无此选项 / shell `am start` 不稳 / 进程内 `setLaunchDisplayId` 被 `SafeActivityOptions` 拒）。
  模型侧用法：`android_app_launch { pkg, screenId: "virtual-N" }`。
- **坐标输入**：虚拟屏上用绝对 `x/y` + `screenId`（经 `input -d <displayId>`，真实屏不受影响）；
  归一化 `nx/ny` 在虚拟屏上**明确拒绝**（分母歧义会静默点到真屏）。
- **截图认屏**：`android_screenshot { screenId }` 的**两条通道都**落到目标 displayId，
  并把分辨率锚点换成该屏自身像素（此前 ADB 回落路径忽略 `screenId`，抓的是真实屏）。
- 等比适配（按内容宽高比 letterbox 居中，不拉伸）、空闲 10 分钟自动回收、
  设置页「手机控制」含强制销毁（三连点确认）。

### 手机控制（无障碍 + Shizuku 双通道）

- **无障碍通道**：语义树 / ref 动作 / 虚拟屏语义树；**Shizuku 特权通道**：uid 2000 执行系统命令
  （`screencap`/`uiautomator`/`dumpsys`/`input` 等只读与输入类；系统配置写面一律拒绝）。
- **ref 寻址**：dump 时保留节点句柄，重定位不再重走 `childPath`；建树时钉住窗口 id
  （焦点变化不再换树）；UI 缓存 TTL 10 分钟。
- **screenId 三件套**：`screenId`/`displayId`/`scope` 逐条回填；`guard()` 异步解析别名
  （虚拟屏别名 → 动态 displayId 必须问壳侧注册表，同步面做不到）。
- **设置页「手机控制」**：Shizuku 状态与引导、屏幕开放范围、虚拟屏档位、浮窗开关、无障碍入口、强制销毁。

### 附件与文件

- **回形针上拉菜单**（DSH 原生视觉）：点回形针出「上传附件 / 上传图片」两项，
  **单击即出**（不再需要点两下）；两项分别走**系统文件选择器**与**系统相册**
  （显式图片类型分流到 `PickMultipleVisualMedia`，API 33+ 系统照片选择器）。
- **文件直达会话**：「使用其他应用打开 / 分享」→ 自动跳转本应用 → 强制新建临时工作区会话处理文件；
  临时工作区 7 天 TTL 自动清理。
- **SAF 桥**：`pickDirectory` 把所选目录映射为真实路径。

## 下载 / 安装

新仓库尚未公开发布 APK。最终 ARM64 来源产物使用独立私有签名，不能覆盖升级旧 DeepCode；两者可并排安装，数据需用户显式导出/导入。产物文件名暂沿用 `dsh-mobile-apk-v<版本>-arm64.apk`。

```sh
adb install -r -t <apk>    # 同签名覆盖安装
```

**ABI 必须与设备匹配。** ABI 不匹配会导致引擎启动即崩——node ELF `EM_X86_64` vs `EM_AARCH64`。
真机选 arm64 包，模拟器选 x86_64 包。

> **覆盖安装后请等待首次解压完成**（快照指纹翻转），期间勿强杀应用。

## 构建

本项目只允许来源链构建，不依赖协调仓，也不读取旧 LFS 底座归档。当前支持 ARM64，可手动选择构建成功后自动创建预发布草稿，见发布政策。

```bash
# GitHub Actions：构建 main 的当前提交
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
# Linux / WSL：在本仓执行，仅构建已提交 HEAD，自动创建隔离检出
node scripts/source-build/run-local-source-chain.mjs
```

云端完成后下载同次运行的 APK 与来源证明 artifact。本地环境、产物范围与检查命令见 [构建详档](docs/AGENTS/build-and-env.md#github-actions-来源构建入口2026-10-17)；交付边界见 [发布政策](docs/RELEASE.md#5-来源链预发布草稿2026-10-17-按用户决定)。构建通过不等于设备验收通过。

## 桥协议 v1（`window.androidBridge`）

壳侧 **51 个 `@JavascriptInterface` 方法**；页面按 `androidBridge.version` 做特性检测，
故 APK 与 dsh 版本解耦。

**同步返回**

| 方法 | 说明 |
|---|---|
| `version` | 应用版本号，feature-detect 用 |
| `getSystemDark` | 系统深色模式（绕过部分厂商 WebView `matchMedia` 失效，首帧主题用） |
| `checkEngine` | 探测 `127.0.0.1:3080`；JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | 是否已授予「所有文件访问」权限 |
| `getPickToken` | 目录选择桥的一次性会话 token（引擎侧 pick 端点校验） |
| `copyText` | 写入系统剪贴板（WebView `clipboard.writeText` 被拒时的回退） |
| `getDevLogEnabled` / `setDevLogEnabled` | dev 日志开关事实（拒绝乐观置位） |
| `getImmersiveMode` / `setImmersiveMode` | 沉浸式状态栏（壳侧权威值） |
| `getOverlayEnabled` / `setOverlayEnabled` | 悬浮层开关 |
| `getScreenScope` / `setScreenScope` | 屏幕开放范围（virtual-only / real-only / all） |
| `getVdisplayScale` / `setVdisplayScale` | 虚拟屏分辨率档位 |
| `getVdisplayFloatEnabled` / `setVdisplayFloatEnabled` | 退后台自动浮窗开关 |
| `a11yStatus` | 无障碍控制通道状态 JSON |

**浏览器工作台**

| 方法 | 说明 |
|---|---|
| `browserHostStatus` | 工作台状态 |
| `browserHostShow` | 打开/重开（含零参重载——WebView 桥按实参个数匹配） |
| `browserHostHide` / `browserHostClose` | 隐藏 / 关闭即销毁当前页 |
| `browserHostReload` | 重新加载（内含 `browserHostShow` 语义） |
| `browserHostBounds` / `browserHostViewport` | 舞台几何 / 分辨率（CSS 视口） |
| `browserHostIdentity` | 身份档切换（PC / 手机），载荷 `{profile, ua}` |

**虚拟屏**

| 方法 | 说明 |
|---|---|
| `vdisplayStatus` / `vdisplayCreate` / `vdisplayDestroy` | 状态 / 创建（幂等）/ 销毁 |
| `vdisplaySelect` | 选择呈现目标（仅自有虚拟别名可选） |
| `vdisplayBounds` | 侧栏舞台几何下发（原生 CoverView 对位） |
| `forceDestroyVdisplay` | 强制销毁全部虚拟屏（与设置页同口径） |

**命令**

| 方法 | 说明 |
|---|---|
| `pickDirectory` | SAF 目录选择；结果经 `window.__dshBridge.onDirectoryPicked(callbackId, path)` 异步回传 |
| `openPathChooser` | 路径选择（工作区/共享目录） |
| `openNativePath` | 「使用其他应用打开」原生路径 |
| `settingsPath` / `exportSettingsDocument` / `exportConfig` / `importConfig` | 设置文档导入导出 |
| `keepScreenOn` / `showNotification` | 屏幕常亮 / 通知测试通道 |
| `requestAllFilesAccess` | 打开系统「所有文件访问」授权页（特殊权限） |
| `openA11ySettings` / `unlockRestrictedSettings` | 无障碍设置页 / Android 13+ 一键解锁受限设置 |
| `restartEngine` / `shutdownToGuide` / `reloadWebUI` / `openConsole` | 引擎与 UI 生命周期 |
| `incomingWorkspacePath` | 来件会话工作区路径 |

## 工具面（模型可见能力）

**AI 可见的能力全部来自插件**，壳侧不直接注册工具。当前 45 个工具，按能力组渐进披露
（先 `android_capabilities` 解锁，之后工具才出现在列表里）：

- **phone**（14）：`android_ui_dump` / `android_ui_click` / `android_ui_input` / `android_ui_scroll` /
  `android_ui_tree` / `android_ui_detail` / `android_ui_global` / `android_screenshot` /
  `android_screen_list` / `android_app_launch` / `android_device_info` / `android_act_input` /
  `android_web_dump` / `android_env_prepare`
- **browser**（19）：`browser_open` / `browser_snapshot` / `browser_click` / `browser_type` / …（17 个）
- **virtual-display**（3）：`android_vdisplay_create` / `android_vdisplay_destroy` / `android_vdisplay_status`
- 另有 bridge（4）、model-capability（2）、linux-env（2）、file-open（1）

**跨屏用法**：任何带 `screenId` 的工具传 `"virtual-N"` 即在虚拟屏上执行
（`android_screen_list` 列出当前别名与范围）；缺省 `real` 表示真实屏。

## 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | WebView + 引擎探测 |
| `POST_NOTIFICATIONS` | 通知通道（API 33+ 运行时请求） |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | 保活前台服务 |
| `MANAGE_EXTERNAL_STORAGE` | 「所有文件访问」（外部工作区要求；特殊权限，用户手动授予） |

SAF 目录/图片选择无需权限。虚拟屏与特权 shell 需用户安装、启动并授权 **Shizuku**。

## 版本历史

完整版本历史见 [`docs/AGENTS/changelog-archive.md`](docs/AGENTS/changelog-archive.md)（倒序，最新在最上）。
开发地图与坑位库见 [`AGENTS.md`](AGENTS.md) 与 [`docs/AGENTS/gotchas.md`](docs/AGENTS/gotchas.md)。

## License

MIT。第三方组件按各自许可（见依赖声明）。GPL 合规：copyleft 全文三形态在场——快照
`usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`。

## 致谢

本项目基于 dsh-mobile-apk 的既有工作。感谢原项目社区成员的反馈与贡献：cdwlll（环境问题反馈）、
haitunlang（MIUI12 兼容）、TACONailoong（老 WebView 兼容方案）、X-SCI-TECH（PR 贡献）、
Yangerwei（文件竞态反馈）、gr12-cmd（armv7l 需求）、cmyfqwq（覆盖安装兼容反馈）。

开发维护规范见 [`AGENTS.md`](AGENTS.md)（开发地图）。
