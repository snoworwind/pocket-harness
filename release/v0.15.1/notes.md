# Pocket Harness v0.15.1

> 草稿（2026-11-10）：版本线提升到 0.15.1（versionCode 58），引擎仍为 DeepSeek Harness `0.2.2-rc.1`，无引擎升级。
> 本版修复侧栏终端的两个问题：zsh 的启动报错与「退格变空格」（Termux 前缀重定位未覆盖 zsh/ncurses 的编译期搜索路径），以及九键条把每次终端回显变成全文档查询/强制样式计算造成的输入卡顿。
> 发布 run、APK SHA-256 与设备层结论在草稿构建完成后补记。

## 安装与升级

- 双 ABI：`pocket-harness-v0.15.1-source-arm64.apk`（真机）与 `pocket-harness-v0.15.1-source-x86_64.apk`（模拟器开发 QA）；真机只能用 ARM64 包。
- 应用版本 0.15.1（versionCode 58）；覆盖安装保留应用数据，可从 0.15.0 直接升级。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖两个 APK、`provenance.zip` 与 `notes.md`）。
- APK 使用 Pocket Harness 独立签名身份；来源证明在 `provenance.zip` 下按 ABI 分目录。

## 更新内容

- 侧栏终端环境修复：`shellEnv()` 现在注入重定位后的 `PREFIX`、`TERMINFO` 与 `FPATH`。
  - zsh 首次提示符的三行 `add-zsh-hook`/`add-zle-hook-widget: function definition file not found` 消失；
  - zsh 退格恢复真实擦除（此前因缺 terminfo `cub1` 只写空格、光标不回退）；
  - 同一 shell 里的 `vim`/`less`/`htop` 等 ncurses 程序一并恢复正常；
  - 注入只在快照目录真实存在时发生，绝不猜路径。
- 九键条性能修复：观察者改为按 mutation record 过滤 + 每帧合并；键条只操作自己绑定的终端根；留白值未变化时不再写 CSS 变量。此前 xterm 每次回显都会触发全文档查询、强制样式计算与终端子树样式失效，是侧栏输入延迟的主放大器。
- 版本线提升到 0.15.1 / versionCode 58。

## 未包含

- xterm.js 6.0.0 在 Android IME 下的字符重复/合成回放缺陷仍属上游（xtermjs/xterm.js #3600 / #4447 / #6060），本版不改变该行为。

## 验证范围与限制

- 代码层：新增 `RelocatedTermuxEnvTest`（真实目录树 / 不编造路径 / prefix 缺席）与 `W3ShellContractTest` 的注入契约；键条新增三条 jsdom 性能回归（深层重绘不触发全文档查询、留白未变不重写、无关新增不扫描且新根仍挂键条）。
- 设备层：未执行。本说明不声明 CDP/ADB 层通过；正式发布前按 §2.1 补验或将豁免写入 Release。
