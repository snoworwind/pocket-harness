# 原生终端替换侧栏终端：方案与决策（2026-11-10）

> 目标：把右侧栏的 Web/xterm 终端替换为**可热装卸插件 + 壳侧原生终端视图**，VT 核心使用成熟开源实现，触摸滚动/IME/选区/缩放走 Android 原生路径。
> 本文只记录已核实的事实与决策，实施按 §6 里程碑推进；**不在本机构建**（一律走来源链 CI）。

## 1. 已核实事实

| 事实 | 结论 |
|---|---|
| 现用终端 | 上游 `@deepseek-ai/dsh-client-ui-sidebar-terminal` + xterm.js 6.0.0（WebView 内） |
| xterm 移动端能力 | 只有 `wheel` 滚动监听，无 touch→scroll 映射；`.xterm-screen` 覆盖 `.xterm-viewport`，手指滑动不滚动 |
| ConnectBot 当前实现 | `org.connectbot:termlib` 0.3.14（Maven Central），Apache-2.0，Compose 组件，VT 核心为 libvterm（MIT），含滚动/缩放/选区/IME/inline image |
| termlib 工具链 | 0.2.x–0.3.14 均以 **Kotlin 2.3/2.4 + Compose BOM 2026.09** 构建；本应用为 Kotlin 2.0.21 / AGP 8.8.2 / Gradle 8.11.1 → **无法直接依赖**（Kotlin 元数据不兼容） |
| ConnectBot v1.9.x VT | `de.mud.terminal.vt320`，**GPL-2.0+**（JTA），不能用；同版本 `TerminalView.java` 是 Apache-2.0 |
| libvterm | MIT；Neovim 等使用；可独立编译，无 Kotlin/Compose 依赖 |
| NDK | 来源链已下载并钉定 Google NDK r30（`build-apk-source.yml` SHA1 `5107f898…`），当前 app 模块未启用 native 构建 |

## 2. 决策

1. **VT 核心 = libvterm（MIT）**，以 NDK/CMake 编入 app 模块；JNI 桥参考 termlib 的 Apache-2.0 思路自行实现（不引入 GPL 代码）。
2. **视图 = 自研原生 View**（Canvas 渲染 Cell + `InputConnection` + 触摸滚动/长按选择/双指缩放），不引入 Compose，不做全应用工具链升级。
3. **PTY 仍归引擎**（`dsh-api-terminal-controller`）：插件持有终端会话，壳侧原生视图只做渲染与输入，字节经桥转发；保持权限/审计/会话语义不变。
4. **插件可热装卸**：客户端插件注册右侧栏 tab 并申请/定位/隐藏原生视图；`dispose` 时释放。原生 View 随 APK（壳侧能力），插件可热更。
5. **替换而非共存**：`ui-sidebar-terminal` 在 profile 中禁用（contract `upstreamDisabled: true`），新插件成为唯一侧栏终端；模型侧 `terminal` 工具与 controller 不动。

## 3. 架构

```text
[WebView 页面]
  dsh-android-terminal (client 插件, 可热装卸)
    - 右侧栏 tab 注册 + 工具栏
    - 通过 @deepseek-ai/dsh-api-terminal-controller 建/attach 引擎终端
    - <-> androidBridge.termView*（受信桥）
[壳侧]
  TerminalViewHost (FrameLayout overlay, 仿 VdisplayHost)
    - bounds/可见性/焦点/热卸回收
    - 持有 TerminalView (libvterm + Canvas)
[引擎]
  dsh-api-terminal-controller -> node-pty -> bash/zsh
```

## 4. 桥协议草案（六面登记）

- `termViewOpen(configJson) -> json`：申请视图（字体/主题/滚动行数）
- `termViewBounds(boundsJson) -> json`：CSS 像素矩形 + 可见性 + 视口
- `termViewVisible(bool) -> json`
- `termViewInput(base64Bytes) -> json`：视图按键/粘贴 → 插件 → PTY
- `termViewOutput(base64Bytes) -> json`：PTY 输出 → 插件 → 视图（分批、有界）
- `termViewResize(cols, rows) -> json`：视图尺寸变化同步 PTY
- `termViewFocus() / termViewClose() -> json`
- 视图 → 插件的事件（键盘/选择/滚动）走 `termViewEmit` 或复用现有 bridge event 通道

约束：输入输出只走受信桥；不接受页面传入路径/命令；视图不持有会话凭据。

## 5. 生命周期

- 插件安装/启用 → 注册 tab；打开 tab → `termViewOpen` + 创建终端；关闭 tab → `termViewClose` + 关闭终端。
- 插件禁用/卸载 → `dispose` 必须同步关闭视图、释放 IME 焦点（不能出现悬空原生层）。
- 页面刷新 → 插件重连引擎终端（保留会话），重新 open 视图并从快照恢复。
- 侧栏收起/分屏/旋转/键盘 → `termViewBounds` 跟随；视图自身处理 IME inset。
- 视图未启用时零副作用。

## 6. 里程碑

- **M1 构建闭环**：app 增加 CMake + libvterm + JNI；最小 `TerminalViewHost` + `TerminalView`（文本/光标/滚动）；桥 six-face；CI 双 ABI 出包。
- **M2 可用闭环**：IME/键盘、触摸滚动惯性、选区复制、双指缩放、主题/字号；插件 tab + 引擎终端字节打通；临时开关默认关闭，可回退。
- **M3 替换**：禁用 `ui-sidebar-terminal`，插件默认启用；热装卸清理、分屏/旋转/键盘验收；移除九键条与键盘 shim。
- **M4 收尾**：许可证台账（libvterm MIT、JNI 自研）、文档（ARCHITECTURE/modules/BRIDGE-API/gotchas）、设备三层验收。

## 7. 验收（设备层）

热装/热卸无残留、IME 弹出视图收缩、手指滚动与惯性、tmux/vim 全屏、选区复制、旋转/分屏、进程退出、页面刷新恢复；ARM64 真机 + 官方 AVD。

## 8. 构建纪律

- 本机只做代码与文档；编译/测试一律走来源链 CI（ARM64/x86_64），不在设备上跑 Gradle。
- 许可证：libvterm MIT 全文与 NOTICE 必须进 `LICENSES/`、`THIRD_PARTY_NOTICES.md`、`scripts/third-party-licenses.json`，并随 APK `assets/licenses/` 分发。

## 9. 实施进度与打包路径（2026-11-10 更新）

已落地：
- libvterm（MIT）vendored + JNI/CMake；Kotlin `TerminalNative`/`TerminalView`/`TerminalViewHost`。
- `termViewOpen/Bounds/Visible/Output/Focus/Close` 桥与 `MainActivity` 生命周期接线（仅侧栏用户终端）。
- 来源链预编译：`scripts/source-build/build-terminal-native.mjs`（NDK r30，per-ABI .so），
  `-PterminalNativeLibraryDir` 以 jniLibs 注入；PR 单测作业不依赖 NDK。

打包路径核实（重要）：
- 本仓 `plugins/*` 的客户端产物**不是由 APK 来源链安装**的；`home/.dsh/profiles/web/node_modules/@dsh-android/*`
  随基座快照提供（base 构建），APK workflow 只做校验/哈希。新增独立插件包需要同步基座构建。
- 因此第一版可设备验证的实现放在**已在包内、可热推**的 `dsh-client-ui-responsive` 客户端插件里注册
  `terminal-native` 右侧栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`），body 驱动 `termView*`
  并复用 controller 的 `webTerminals` 会话；待体验稳定后再决定是否抽成独立可安装包（届时补 base 构建接线）。

下一步（M2）：
- ui-responsive 内注册原生终端 tab；body 负责 bounds 上报、`termViewOpen/Close`、帧输出（base64）、
  `__dshTermInput`/`__dshTermResize` 回写 `webTerminals` 模型。
- 与上游 `ui-sidebar-terminal` 并存验证后再禁用上游；`sb_pushline` 滚动回看与触摸滚动随后补。
