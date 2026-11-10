# Pocket Harness v0.15.1

> 当前发布（2026-11-10）：提交 `bf5a4a047ad3`，来源 run [42660264583](https://github.com/snoworwind/pocket-harness/actions/runs/42660264583)，**ARM64 + x86_64 双 ABI**，Release `hardening-source-bf5a4a047ad3-42660264583-1` 已公开发布并设为 Latest。
> 本版把版本线提升到 0.15.1（versionCode 58），修复侧栏终端的两类故障：zsh 启动三行 autoload 报错与「退格变空格」，以及九键条把每次终端回显变成全文档查询/强制样式计算造成的输入卡顿。引擎仍为 DeepSeek Harness `0.2.2-rc.1`，无引擎升级。
> ARM64 APK SHA-256 `e3df9852d7e768ad9da9d3a301c883a15d06c91d19b78c91b06d5751343e8a0c`，x86_64 为 `b379f73129b679666ce5a7da16409b503103f310ea68ba9f44332bf6d4e32866`。

## 安装与升级

- 双 ABI：`pocket-harness-v0.15.1-source-arm64.apk`（真机）与 `pocket-harness-v0.15.1-source-x86_64.apk`（模拟器开发 QA）；真机只能用 ARM64 包。
- 应用版本 0.15.1（versionCode 58）；覆盖安装保留应用数据，可从 0.15.0 直接升级。
- 安装前核对随包 `SHA256SUMS.txt`（覆盖两个 APK、`provenance.zip` 与 `notes.md`）。
- APK 使用 Pocket Harness 独立签名身份；来源证明在 `provenance.zip` 下按 ABI 分目录。

## 更新内容

- 侧栏终端环境修复：`shellEnv()` 现在注入重定位后的 `PREFIX`、`TERMINFO` 与 `FPATH`。
  - zsh 首次提示符的三行 `add-zsh-hook`/`add-zle-hook-widget: function definition file not found` 消失；
  - zsh 退格恢复真实擦除（此前因缺 terminfo `cub1` 只写空格、光标不回退；缓冲区其实已删，坏的只是显示）；
  - 同一 shell 里的 `vim`/`less`/`htop` 等 ncurses 程序一并恢复正常；
  - 注入只在快照目录真实存在时发生，绝不猜路径；不再需要用户手写 dotfiles。
- 九键条性能修复：观察者改为按 mutation record 过滤 + 每帧合并；键条只操作自己绑定的终端根；留白值未变化时不再写 CSS 变量。此前 xterm 每次回显都会触发全文档查询、强制样式计算与终端子树样式失效，是侧栏输入延迟的主放大器。
- 版本线提升到 0.15.1 / versionCode 58。

## 未包含

- xterm.js 6.0.0 在 Android IME 下的字符重复/合成回放缺陷仍属上游（xtermjs/xterm.js #3600 / #4447 / #6060），本版不改变该行为。

## 验证范围与限制

- CI：来源 run 42660264583 的 prepare、ARM64/x86_64 两个 `termux-package-inputs`、两个 ABI 各自的 primary/reference 构建、`verify-abi`、`sign-abi` 与 `draft` 全部成功；PR [#270](https://github.com/snoworwind/pocket-harness/pull/270) 的 PR Gate 全绿（含 Kotlin 单测 1451 例与插件单测）。
- 代码层：新增 `RelocatedTermuxEnvTest`（真实目录树 / 不编造路径 / prefix 缺席）与 `W3ShellContractTest` 注入契约；键条新增三条 jsdom 性能回归（深层重绘不触发全文档查询、留白未变不重写、无关新增不扫描且新根仍挂键条）。
- 设备层（部分执行，如实记录）：最终 ARM64 APK 已安装并在用——设备引擎 env 为 `DSH_APP_VERSION=0.15.1-source` / versionCode 58，并已注入 `PREFIX`/`TERMINFO`/`FPATH`；用引擎注入的 `.zshenv` 复跑 zsh：三行报错消失、退格恢复 `\b` 擦除、`fpath=19 dup=0 hook=1`；设备上的键条 bundle 已含新观察者逻辑（留白写入带值比较守卫、全文档查询只剩 watcher 一处）。为救急写的临时 dotfiles 已清理（`.bashrc` 还原、`.zshenv` 删除）。
- 设备层（未执行，剩余风险）：CDP verify 套件（`verify-webview-015.mjs` 等）未跑；ADB 用户层截图验收、横屏、冷启动矩阵未做；x86_64 包未做任何设备层验证；键条性能只有代码级证据，未做帧率/输入延迟量化。
- 本版按「部分设备验收 + 已披露豁免」发布，不声明上述未执行层通过。
