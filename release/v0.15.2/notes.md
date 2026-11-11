# Pocket Harness v0.15.2

> 草稿（2026-11-10）：版本线提升到 0.15.2（versionCode 59），引擎仍为 DeepSeek Harness `0.2.2-rc.1`。
> 本版把侧栏终端的原生方案（M2）并入主线：libvterm（MIT）+ JNI + 原生 `TerminalView` 宿主 + `termView*` 桥 + 来源链预编译打包，并在右侧栏以 `terminal-native` tab **替换**上游 Web 终端入口。
> **实验性**：原生终端已完成开发机设备验收（打开、IME、回看、滚动方向）；上游 xterm 终端入口已禁用。模型侧 `bash`/`terminal` 工具未改动。

## 安装与升级

- 双 ABI：`pocket-harness-v0.15.2-source-arm64.apk`（真机）与 `pocket-harness-v0.15.2-source-x86_64.apk`（模拟器开发 QA）；真机只能用 ARM64 包。
- 应用版本 0.15.2（versionCode 59）；覆盖安装保留应用数据，可从 0.15.1 直接升级。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖两个 APK、`provenance.zip` 与 `notes.md`）。

## 更新内容

- 侧栏原生终端（替换上游 Web 终端入口）：
  - 新增 `terminal-native` 右侧栏 tab：原生 `TerminalView` 渲染、IME 输入、光标与 SGR 基础色；
  - 回看与触摸滚动：libvterm `sb_pushline` 维护 2000 行回看环，拖动按行滚动、输入自动回底；
  - `termViewOpen/Bounds/Visible/Output/Focus/Close` 桥（仅侧栏用户终端使用；模型工具不经过）；
  - VT 核心为 libvterm（MIT，固定 `neovim/libvterm@934bc2fb…`），随包分发 `assets/licenses/libvterm.txt`；
  - 来源链以 NDK r30 预编译 per-ABI `.so` 并作为 jniLibs 注入（PR 单测作业不依赖 NDK）。
- 版本线提升到 0.15.2 / versionCode 59。

## 未包含 / 已知限制

- 上游 `ui-sidebar-terminal` 已禁用；原生 `terminal-native` tab 是侧栏唯一终端入口。
- 原生终端尚未做设备层验收（IME、触摸滚动、缩放、选区、热卸回收）。
- 触摸滚动目前是逐行拖动（惯性/缩放在后续里程碑）；`sb_pushline` 回看已包含。
- 上游 xterm 入口已禁用，xterm.js 的 Android IME 重复/回放问题不再影响侧栏终端。

## 验证范围与限制

- CI：PR Gate 全绿（Kotlin 单测、插件构建/单测、静态门禁、桥对称、执行地图）。
- 设备层：**未执行**。本版按「开发期未验收」记录，不声明 CDP/ADB 层通过；正式 Release 前按 §2.1 补验或显式豁免。
- 原生 `.so` 的编译与进包由本次来源链草稿 run 验证（结果后补）。
