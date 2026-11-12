# Pocket Harness v0.15.2

> 2026-11-12 正式版（versionCode 59，返工第二版），引擎仍为 DeepSeek Harness `0.2.2-rc.1`。
> 本版把侧栏用户终端从 Web/xterm 替换为**原生 Android 终端**：VT 由 libvterm（MIT）解析，壳侧原生 `TerminalView` 渲染与输入；上游 `ui-sidebar-terminal` 已禁用。
> 模型侧 `bash`/`terminal` 工具与 `dsh-shell-termux` 未改动。
> 第二版修复首版原生终端的尺寸同步缺陷（PTY 固定 80×24，长输入越界、退格吞掉提示符），版本号与签名不变，可直接覆盖安装。

## 安装与升级

- 双 ABI：`pocket-harness-v0.15.2-source-arm64.apk`（真机）与 `pocket-harness-v0.15.2-source-x86_64.apk`（模拟器开发 QA）；真机只能用 ARM64 包。
- 应用版本 0.15.2（versionCode 59）；覆盖安装保留应用数据，可从 0.15.1 直接升级。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖两个 APK、`provenance.zip` 与 `notes.md`）。

## 更新内容

- **侧栏原生终端**（替换上游 Web 终端入口）：
  - libvterm（MIT，固定 `neovim/libvterm@934bc2fb…`）+ JNI；原生 `TerminalView` Canvas 渲染、光标、基础 SGR 色、宽字符；
  - IME 输入（组合/退格/回车/方向键/Ctrl），不再受 xterm.js 在 Android IME 下的重复/回放问题影响；
  - 回看 2000 行，手指拖动 + 惯性滚动，输入自动回底；
  - 新建时可选 bash/zsh；关闭 tab 会同时关闭宿主 PTY；切走/返回保留终端状态（不再空白）；
  - `termViewOpen/Bounds/Visible/Output/Focus/Close` 桥，仅侧栏用户终端使用；
  - 引导卡跟随浅色/深色主题，横屏窄侧栏下标题不再竖排、shell 选项可换行；
  - 终端颜色把 JNI 的 RGB 正确补成不透明 ARGB，OMZ 彩色提示符/背景可见。
- **原生终端尺寸修复**：`TerminalView` 以视图真实像素推导网格（`terminalGridFor`），在打开、bounds 变化、可见性恢复与 tab 复用时把 cols×rows 回推 PTY；PTY 不再固定 80×24，长输入折行/退格与横竖屏、系统字体变化恢复正常。
- **构建**：来源链以 NDK r30 预编译 per-ABI `.so` 并作为 jniLibs 注入；PR 单测作业不依赖 NDK。
- **许可**：libvterm MIT 文本随 `assets/licenses/libvterm.txt` 分发，并在 `THIRD_PARTY_NOTICES.md` 登记。
- **CI**：engine base 自动构建/自证复用（不再依赖人工 lock），injected snapshot、Linux assets、Gradle、pnpm store 按内容哈希缓存；开发档可用 `fast=true` 降低压缩耗时。

## 已知限制

- 触摸滚动是逐行拖动 + 惯性；暂未提供选区/复制与双指缩放。
- 原生终端不提供上游 xterm 的完整主题映射，当前使用内置 16 色 + 默认前景/背景。
- 设备验收：真机完成终端核心路径人工验收（打开、IME 输入、回看/滚动、返回、tab 切换、关闭后重建），以及引导卡浅色/横屏与 OMZ 彩色提示符复验；第二版另确认竖屏 `stty size` 跟随可见网格、长输入折行与连续退格正常。横屏与系统字体变化走同一 `onSizeChanged`/Activity 重建路径，本次未单独截图取证；未执行完整 §2.1 CDP/ADB 矩阵，按未验收层记录。
- 首次构建仍为冷启动；命中阶段缓存后的耗时会显著下降。

## 验证范围

- CI：PR Gate 全绿；来源构建双副本独立比对 + 生产签名；APK v1/v2/v3 齐全，证书与仓库钉定值一致。
- 设备：真机覆盖安装 0.15.1 后，侧栏原生终端核心路径通过；第二版覆盖安装首版 0.15.2（同签名、同 versionCode）后，终端尺寸同步与会话保留通过；模型侧工具未回归（相关测试在 PR Gate）。
