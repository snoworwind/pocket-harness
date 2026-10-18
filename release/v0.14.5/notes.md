# v0.14.5 发布说明

> Android 壳侧适配版本。本版走 GitHub Action 发布链（workflow_dispatch 传 version + notes，CI 完成重建快照 -> 双 ABI 打包 -> 门禁 -> draft Release）。

**升级说明**：versionCode 46 -> **47**，versionName `0.14.4` -> `0.14.5`。与 0.14.4 同一签名证书，**可直接覆盖安装，无需卸载**，用户数据、会话、工作区、模型配置与插件均保留。

## 验收状态（先读这一节）

本版在 MuMu x86_64 上完成了**最终包的三层设备验收**（代码层 / CDP 层 / ADB 用户层），逐项结果如下；未闭合项如实列在末尾，未写成通过。

| 层面 | 状态 |
|---|---|
| 双 ABI 构建链门禁（官方全开，非 Fast） | PASS：exit 0，`已产出 ABI: [arm64, x86_64] / 被拒 ABI: []` |
| 聚合发布门禁 `--run --require --snapshot-dir` | PASS：31/31，exit 0（SKIP=3，全部具名声明） |
| Kotlin 全量单测 | PASS：1134 项 / 0 失败 / 0 错误 / 2 跳过 |
| 签名 | PASS：两 ABI v1/v2/v3 全 true，证书 `1dde9d98...bcbd`（与 0.14.4 同） |
| 启动与 Hard 组成（四台） | PASS |
| 屏幕范围与通道 P0-P4 | PASS 7 / FAIL 0 / INCONCLUSIVE 0 |
| #335 滑动导航 | PASS 三层（真实 adb 触摸） |
| UI 透明度与实际可用 | PASS（键盘项 INCONCLUSIVE，详见未闭合） |
| MiMo 真实业务 + write 新建文件 | PASS 三层 |
| SafeMode 与 Soft 隔离 | 10 PASS / 1 INCONCLUSIVE |
| 0.14.4 -> 0.14.5 覆盖升级 | PASS：7325 成员逐字节零回归 |
| 浏览器 profile 隔离 | **未闭合**（见下） |
| arm64 真机 | **用户批准豁免**（产物已核验，未实机） |

## 一、本版修掉的关键缺陷

### 1. `write` 工具在应用私有目录**建不了新文件**（长期存在）

`dsh-fs-local` 的原子写用 `link(2)` 做 no-replace 发布，而 Android 应用私有目录恒拒 hardlink（EACCES，且 denial 被 `dontaudit` 静默）⇒ 表现为**只能改、不能建**。
本版补齐回退：在 `EACCES`/`EPERM`/`ENOTSUP`/**`ENOSYS`** 时改用 `O_EXCL` 占位 + `rename` 等价实现 no-replace，**保留 link 的独占语义**（输家仍得 EEXIST 与同一拒绝文案，rename 失败回收占位以防 0 字节残留）；非权限类错误仍走原拒绝路径，不被吞掉。

设备实测：升级后模型可正常新建文件（本轮真实任务中成功创建并主机独立核验）。

### 2. 运行时资产与快照不同源（会导致补丁在设备上被「改回去」）

`assets/patched/*` 是引擎启动时覆盖运行树的预打补丁副本，必须与快照逐字节同源。本版把它与重建后的快照对齐，并让打包链**显式**把当前 ABI 的最终快照传给该门禁（此前会误读旧 tar），另加正反双向断言锁住传参形态。

### 3. 加载第三方坏插件会拖垮启动链（G3 容错）

用户自装的第三方插件加载失败时会被合法隔离并继续启动，不再让整条启动失败。

## 二、新增能力

- **手机形态左右滑动切换侧栏（issue #335）**：内容区起手；左右各留 32px 给系统手势；水平意图门槛 12px、提交门槛 64px；左右两个偏好**互相独立**；输入框、文本选区、横向滚动区、弹层与多指操作均不触发；已展开一侧时同一次手势只关闭当前栏、不切换另一侧。
- **屏幕范围与通道加固**：`real-only` 下禁止虚拟屏输入与针对非物理显示的 raw shell 输入（拦住命令下发前）；`all` / `virtual-only` 下合法操作照常。
- **Hard / Soft 组成与恢复**：工厂 bundle 精确选择并在每次启动协调；Soft 候选需跨两次不同健康启动才转稳定；失败条目**隔离而非删除**；缺 bundle 时保留 Soft / pin / 未知项。
- **SafeMode 恢复面加固**：进入/退出会对 profile / home / package 三份文件做 CAS 事务，退出后逐字节还原。

## 三、覆盖升级

官方 0.14.4（versionCode 46）-> 本版（47）同签名 `install -r` 已验证：**7325 个受保护成员逐字节零回归**（无丢失、无改写、无删除），旧会话、旧 workspace、旧模型选择在升级后**可直接继续使用**（本轮用旧 workspace 完成了一次真实模型任务）。

## 四、未闭合项（如实列出）

### 浏览器 profile 隔离在本环境不可用

隔离浏览能力需 WebView 的 `MULTI_PROFILE`。当前模拟器 provider 为 `com.android.webview 110.0.5481.154.1`（dex 中该特性为 0），因此能力门 fail-closed：不支持时**不会**回落共享 profile、也不会清 cookie 求绿，而是明确报 `browser-profile-unsupported`。需要 WebView M119+ 且开启多进程的设备才能验证隔离本体。

### 自动回滚验收套件需更新故障样本

`verify-auto-undo` 注入的「会抛异常的第三方插件」在本版已**被 G3 容错合法隔离**，引擎保持健康、回滚链从未被要求动作，因此该套件当前测不到回滚路径。这不代表回滚链失效，但**也不等于回滚链已被验证**；需要换一个能真正驱动它的故障源。回滚链的纯逻辑与事务面回归仍全绿。

### 性能：升级后首次启动较慢

覆盖升级后的**第一次**冷启动要重抽取整棵运行时树（160MB 级归档），该轮 C1=4704ms / C4=9846ms 超出预算阈值（4000ms / 7200ms），已如实保留未删；其后连续 5 轮冷启动均达标（C1 865–1747ms）。

### 其他

- 在线更新（ONLINE）端到端在当前产品形态下**结构性不可执行**：没有可配置的 manifest 入口，无产品路径可构造真实事务。
- 16416 实例出现过**间歇**「插件装配失败」（9 次重启命中 2 次，可自愈），触发因素与外部权限变更事件相关，未定性。
- arm64 真机本版**未实机验收**（用户批准豁免）；arm64 产物的 SHA、签名、内嵌快照与归档级补丁一致性均已核验。
- UI 键盘不遮挡一项因**设备输入法自身故障**（声称显示但窗口高度为 0，系统设置中同样复现）无法取证，记 INCONCLUSIVE。

## 五、产物

- `dsh-mobile-apk-v0.14.5-arm64.apk`
- `dsh-mobile-apk-v0.14.5-x86_64.apk`
- 注入后快照 `snapshot-{arm64,x86_64}.tar.xz` 及其 `.sha256`
- 子仓 tgz（`dsh-shell-termux` / `dsh-client-ui-responsive` / `dsh-host-web-compat`）
- `MANIFEST.txt`（逐文件 sha256 与字节数）、`provenance/`（插件 lock 解析）

安装：`adb install -r -t dsh-mobile-apk-v0.14.5-<abi>.apk`（真机请用 arm64 产物）。