# known-gaps.md — 当前缺口与验收入口

> 本分支宗旨及当前验证边界见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md)。源码有改动不等于新包已验收。
> 应用身份迁移与 ARM64 离线资产修复仍待云端来源 APK 全链；设备侧实测按用户决定暂缓并统一验收。发版须另行获得用户授权。

- Pocket Harness 独立身份与签名改造已完成代码实现：`applicationId=com.snoworwind.pocketharness`、仅 ARM64 下载与产物、独立 PKCS12 证书 pin。已按用户授权设置 `POCKET_SIGNING_KEYSTORE_BASE64` 与 `POCKET_SIGNING_KEYSTORE_PASSWORD` 仓库 Secrets；仍须运行云端来源 APK 全链。设备侧三层验收按用户安排暂缓，未做设备验证，不得作为发行候选。
- 最终 main HEAD `d4aa9fc` 的来源双构建 run [39113529859](https://github.com/snoworwind/pocket-harness/actions/runs/39113529859) 因标准 14 GB runner 在 APK gate 前耗尽磁盘而失败（`Free space left: 83 MB`，随后 `ENOSPC`）。磁盘回收修复合并后，`d19e8c3` 的 run [39119416887](https://github.com/snoworwind/pocket-harness/actions/runs/39119416887) 已通过该处和来源快照检查，但在注入后暴露内置 bootstrap 的包名/目录名错位；已按 `package.json.name` 修正并补 `test_inject_all.py`。Linux 来源套件与 Python 套件通过；尚未取得修复后的新 main run 或设备证据，不能记为通过。详见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md) 与 [坑 420、421](gotchas.md)。

## 当前入口

- 2026-10-19：Android `dsh-shell-termux` 的 `workspace-write`/`read-only` **没有路径级执行边界**；bash 以 app UID 直接运行，`spec.sandboxPolicy` 未被读取，`enforcement: partial` 不阻断、不触发审批、也不进入模型面。这是“模型可通过 bash 访问其他文件夹”的直接根因。详见 [dsh-shell-termux 沙箱边界审计](SHELL-TERMUX-SANDBOX-AUDIT-2026-10-19.md)。**未修复、未构建 APK、未做设备验证。**

- 2026-10-18 在 main `187246a` 上的分区复审发现原生 relay 准入遗漏、屏幕范围内存/旧 XML 断链、路由门禁注释假绿，以及文件/虚拟屏/来源续跑等问题，见 [项目分区复审](PROJECT-AUDIT-2026-10-18.md)。**A01–A14 已在源码层修复**，实现、宿主反例与新增测试见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md) 的「项目分区复审 A01–A14」一节。本轮未重建 APK、未做设备验证（无在线 ARM64 设备与 Android SDK）；L2/L3 面进入发版候选前仍须来源链新包的三层验收。与下方此前综合审查的 A01–A10 是不同编号集合。

- 2026-10-18 综合审查的问题现按用户授权修复，当前进度见 [修复账本](AUDIT-REMEDIATION-2026-10-18.md)；[原审查报告](COMPREHENSIVE-AUDIT-2026-10-18.md) 保留发现时事实。实现、宿主反例与设备证据分别记账；**未做设备验证**。

- 第二轮 376–392 已进入源码修复；以 [修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md) 为当前状态。设备实测按用户决定暂缓，基本修复完成后统一执行；期间保留 **未做设备验证** 状态，不能据此发布。

- 2026-10-19：浏览器在无 `MULTI_PROFILE` 的设备上不再整块拒绝。用户显式启用兼容模式后使用进程级 Default cookie jar（`profileIsolation=shared`，loopback 仍拒，UI 明示共享），以可用性换隔离；每会话隔离与“不回 Default”的旧口径只对显式兼容模式例外。**未做设备验证**，需真机验证面板提示、第三站点导航与 `browser_*`。详见 [坑 437](gotchas.md)。
- 2026-10-19：Linux 环境在设备上不可用的直接根因已定位并修复（源码层）——`@dsh-android/dsh-android-linux-env` 的 `xz-decompress`/`tar-stream` 原先只在引擎树，profile 路径解析不到，插件 import 失败导致路由与 bootstrap 服务全缺席。注入器现把运行时依赖闭包复制进插件自己的 `node_modules/`，`check-inject-completeness` 新增 C1/C2 可达性判据与负控；详见 [坑 436](gotchas.md)。**未做设备验证**，仍需来源链新 APK 的 engine.log 与面板/`linux_bash` 验收。同一轮修复了引擎重启后 reinstall/uninstall 必失败（持久化 pinned manifest 摘要、卸载时重新激活取 manager，见 [坑 438](gotchas.md)）。
- Linux ARM64 离线资产链现已接入 APK 来源 workflow：同一提交从源码构建资产、校验来源 commit / 清单 sidecar / 每个资产摘要和长度，再嵌入 ARM64 Termux 快照；离线 bootstrap 已注册、编译客户端 bundle，并由 `linux-env` 提供已签名快照内资产和原始清单摘要。runtime manager 另有 Node 启动探测、有限输出与超时终止。当前本地单测和自检通过，仍待来源 APK 云端全链证明生成资产与 APK 同提交、APK 产物门禁成功；设备验收按用户要求暂缓，基本工作完成后统一进行。未经来源链及设备验收不得宣称 Linux 功能可发布。


- 本轮安全团队审计修复四类边界，见 [SECURITY-AUDIT-2026-10-17.md](SECURITY-AUDIT-2026-10-17.md) 与坑 372–375。**未做设备验证**：WSL ADB 无设备且两个模拟器端口拒绝连接；没有本轮来源 APK/CDP/ADB 自主任务证据。L2/L3 三层仍阻塞验收及发布；普通 web 重定向的手势兼容需设备复核。宿主回归不得代替这项缺口。

- 包管理器别名/清数据漏检与子帧特权下载路由已按源码边界收紧，见 [gotchas.md](gotchas.md) 坑 343、344。代码及服务队列反证完成；**未做设备验证**。尤其是 `shouldOverrideUrlLoading` 的 WebView 子 frame/真实 gesture 事实，须等设备在线后核验，不能用 JVM 判据替代。

- 主 WebView 子帧越权的源码修复与代码层反证已完成，见 [gotchas.md](gotchas.md) 坑 342。**未做设备验证**，不能声称恶意 HTML 的 Android 设备攻击复现/修复验收已完成；原生壳改动须来源链新包，不能热推代验。真实同源页面仍属受信面，预览 sandbox 必须继续保持 opaque。

- settings 危险写操作的选项/reset 漏检已修，见 [gotchas.md](gotchas.md) 坑 341。代码层真实控制队列正反证通过；无在线设备，**未做设备验证**，即时 CDP/ADB 层仍阻塞，不构成候选验收。

- 模型能力探测凭据出口已修源码与生成 lib，宿主真实 HTTP 回归通过；CDP/ADB 即时验收因无在线设备阻塞，**未做设备验证**，不能记为运行时验收完成。入口、兼容变化与证据见 [gotchas.md](gotchas.md) 坑 340；最终来源包不得在未补验时作为候选交付。

- 旧快照的归一化证据需重算：v1 吞二进制及 JSON 有序映射差异，v2 未计权限/空目录，不能继续作为语义等价证明；当前报告带 `normalizationVersion: 3`，见 [gotchas.md](gotchas.md) 坑 337、338。未重建 APK、未做设备验证，旧包不包含此次修复。

- 本分支从 [安全加固宗旨](SECURITY-HARDENING.md) 与下方安全加固缺口进入；协调仓 `docs/REFACTOR-2026-10-05.md` 保留为历史计划与事实账入口。仓库地图见 [AGENTS.md](../../AGENTS.md)。
- 恢复与用户数据：[PERSISTENT-DATA.md](PERSISTENT-DATA.md)；协调仓 `docs/RECOVERY-ARCH-0.14.5.md`。当前实现以源码和冻结后的证据为准。
- 三层验收：[emulator-test-protocol.md](emulator-test-protocol.md)。旧包、热推或仅静态审计不能代替最终双 ABI 包的代码/CDP/ADB 用户层验收。

## 安全加固分支（2026-10-15）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| 本批修复验收范围 | 用户要求仅编译和静态检查；输入广播、raw shell 范围门与认证 HTTP 加固见坑 312–316；应用内更新已按用户要求整体移除，见坑 317；启动诊断 token 出口脱敏见坑 319、320 | WSL 完整 Kotlin 主源码编译通过；未新增或运行测试，未做 CDP/ADB 验收；不记功能验收通过，不具备发布结论；分支维护方式见宗旨文档 |
| Android 工程编译环境 | WSL 已安装独立 Linux Android SDK，Java 17 下 `:app:compileDebugKotlin` 成功；Windows Java 24 的 Gradle 配置失败仍是该环境的限制，未改工程版本规避 | SDK 路径、重复命令及证据入口见 [build-and-env.md](build-and-env.md) 的 WSL 编译小节；编译器仍有弃用 API 与可空接收者等警告，编译成功不等于运行时验收 |
| WSL 来源 APK 构建 | 已从已提交源码（`bc6637f`）在隔离检出内产出 arm64 APK，并通过 14 项独立复核（三签含 v1、证书指纹、内嵌快照哈希与语义归一化摘要、引擎 0.2.0-rc.2、LFS 独立性、四份许可全文、无构建机残留）；重建过程中暴露的前提与修正：无 index 的上游检出需显式初始化固定 commit、pnpm 包物化必须先于按物理路径读取的归档门禁、MiMo verifier 分派缺口已修，见坑 323 | 复核面与命令见 [build-and-env.md](build-and-env.md) 来源审计小节；字节级可复现不成立，判据是语义归一化摘要；测试预期修正及全量结果见坑 322，**该产物未做设备验收、未发布**，不构成发布结论 |
| 外部文件导入来源 | 私有 file URI 与同 UID Provider 的权限代用路径已在源码关闭；外部 content URI 要求系统已授读权限，file URI 限共享存储并检查实际 FD；畸形分享参数被安全拒绝，见坑 321 | WSL 主源码编译及静态检查通过；未做设备验证。正常带授权的系统分享、私有 URI 拒绝、链接替换与 FD 关闭均待设备回归；不提供 URI 读授权的旧文件管理器需改用系统分享/打开入口，系统不能解析的 Provider 或 FD 路径失败关闭 |
| raw shell 策略边界 | 范围门检查提交文本中的静态命令与显示选择器，不具备完整 shell 沙箱的能力 | 不应将文本扫描视作任意可执行程序行为的安全证明；本批只收紧已定位的绕过路径，运行时效果仍待验收 |
| 组件来源证明的信任边界 | 可写输入报告篡改及额外编译源码的漏检已修，见坑 336；输出检查从固定 Git 提交独立重建身份 | 校验器、Git 对象库及执行环境仍须可信；没有隔离任意同 UID 构建代码，也不证明检查间临时改写后恢复的输入。仅构建证明脚本改动，未重建 APK、未做设备验证 |
| **发布链与「APK 只能从源码构建」冲突（已按用户决定收口）** | 按铁律 9，本分支任何 APK 必须由来源链产出。原 `release.yml` 走「`base/*.tar.xz` LFS 底座 + runner 内 `scripts/build-apk-013.ps1`」，属非来源链路径，**已于 2026-10-15 按用户决定整体删除**（当时决定不出 Release；2026-10-17 新来源草稿政策见 RELEASE.md §5）。跨树镜像约束已退役；`build-apk-013.ps1` / `build-release.ps1` 禁止作为入口，`build-snapshot-013.mjs` 仍是来源链内部步骤，不构成对协调仓的依赖 | 新来源草稿入口已按用户决定加入（当前仅 ARM64，资产集 + provenance + 只读构建/独立写权限提升）；**不得复活 `release.yml` 那条链** |
| **仓库坐标写死上游（已修）** | 实测：`record-project-components.mjs` 把 provenance 的 `sourceRepository` 写死 `github.com/kelai141/dsh-mobile-apk`（而来源链会调用它两次）；`upload-release.mjs` / `sync-release-notes.mjs` 写死 `OWNER/REPO` 并需对方 PAT；`webpages/` 的 canonical/og/发布 API/下载链接全指向上游 | 已改为运行时解析（`DSH_*` 环境变量 > CI 变量 > `git origin`，取不到即判红）与构建期占位符注入，默认指向本 fork；站点测试同步改为按解析值断言。**两个手工发布脚本已按用户指示删除**（零调用者、非来源链路径）。证据与根因见坑 327 |
| **跨树镜像纪律退役（永久分叉，已记账）** | 按用户决定移除跨树镜像层：`check-patch-mirror.mjs` 只保留 registry↔IMPLS 自洽（`--peer` / `--require-peer` / `DSH_MIRROR_PEER` 显式拒绝，exit 2），`check-release-gates.mjs` 的「两树同版」断言删除，AGENTS §4.6 改为「树内副本即权威」。受影响文件：`scripts/check-patch-mirror.mjs`、`scripts/check-release-gates.mjs`、`scripts/build-apk.mjs`（注释） | 这些文件自此与协调仓永久分叉，将来若引入上游改动必冲突；**代价不是依赖而是合并成本**。原跨树防线（防「云端快照静默缺引擎补丁」）在本分支不再适用：不存在第二棵树，交付只由本仓自洽面 + 补丁回归 + fixtures 代对齐保障 |
| **补丁夹具 capture 重封（vendor-only registry 变更）** | `1dac77f` 新增 vendor 补丁 `market-install-approval-R2` 后未重跑 `probe-engine-anchors --fixtures`；PR Gate 的 `check-patch-fixtures` 比较完整 registry 哈希，在 `main` 首次运行即判红。CI 失败明细只报 capture 身份不符，未报任何 fixture 文件 hash 不符，说明 engine 夹具字节仍与 capture 一致 | 已将 `manifest.capture.registrySha256` 重封为当前 registry 哈希 `671699cb51c447204f45fcdca6529ae57f9d9e4d1a97dc047c8a2407fe0def9e`；engine / sourceCommit / 文件哈希未改。补丁夹具的真实重捕获仍应在下一次有 engine 产物的构建中执行，届时覆盖本行 |
| **来源链草稿发布** | 用户于 2026-10-17 允许手动来源构建成功后自动创建 ARM64 预发布草稿；旧 LFS 发布链仍禁用 | 具体政策见 [RELEASE.md §5](../RELEASE.md)；自动公开未启用，候选设备验收仍须补齐 |

## 吸收上游 `main`（2026-10-16，上游尖端 `5fca94f`）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| 吸收范围与冲突口径 | 上游 `main` 的 7 个提交（剪贴板回退镜像 0.1.14 / WebView 算法改色 / 手机端宽表格 / 终端卡片 / 刷新窗口启动请求 P1 / 文档与赞助码）已并入本分支。冲突按本分支口径解决：坑位续编 329–333（上游 309/311/312/313/310）、执行地图锚点按合并后行号重取、Kotlin 单测基线 1232、上游 `UpdateManager` 行不复活 | 逐项安全审查与结论见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 的 2026-10-16 复核轮次；**未做设备验证** |
| 代码层证据（本机） | Kotlin `:app:testDebugUnitTest` 编译通过、1232 例中 1231 通过；`dsh-host-web-compat` 三份 `node:test` + `smoke-injections` 18 项通过；`dsh-client-ui-responsive` 全量 vitest 48 文件 709 通过 / 1 跳过（0 失败），且运行副本的 `src`/`tests` 与合并树逐字节相同 | 编译与单测证据**不覆盖运行时行为**；唯一红例是本机文件系统 birthtime 不可得造成的环境误红，见坑 334（不改用例、不放宽 `EngineAuth` 判据） |
| **设备验收（缺）** | 本轮吸收含 **L2 面**（快照事务窗口内的启动/等待、boot-fail 新 stage）与 **L3 面**（主题算法改色、宽表格、终端卡片）：CDP 层与 ADB 用户层**一层都没做**。本分支禁止本地链出 APK（铁律 9），本机没有可安装的来源链产物 | 按铁律 2 的「不可省的两条」，这些改动的设备结论为空，**进入发版候选前必须补验**；补验条件 = 来源链出包 + 模拟器竖横两向 + arm64 真机补充 |
| 本机跑套件的环境坑 | `process.execPath` 在本机是 `/apex/com.android.runtime/bin/linker64`（node 是经 linker 启动的 ELF 共享对象），凡是用它派生子 node 进程的东西必失败：`node --test` 报 `expected absolute path: "--test-concurrency=0"`、vitest 默认 `forks` 池报 `EPIPE`、`check-release-gates.mjs` 的「171 个脚本全部可解析」整项判红（手工 `node --check <单文件>` 却 exit 0）；另 `pnpm install` 在 sdcard（FUSE）上因 symlink/rename 失败（`ERR_PNPM_ENOSYS` / `ERR_PNPM_ENOENT`） | 绕行：逐文件直跑、`--pool=threads`、装到 `$HOME` 或 `--node-linker=hoisted --package-import-method=copy`。属环境限制而非仓库缺陷，**不得据此判仓库红**；根因、实测矩阵与判据见坑 335，pnpm 见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 该轮证据段 |
| 上游锚点漂移（已知缺口的现实样本） | 上游写进执行地图的 `EngineStartFlow.kt:700`、`EngineManager.kt:207`、`EngineManager.kt:813、1344-1369` 在本分支合并后全部指错位置，而 `check-code-map.mjs` 仍 `exit 0`（它只验「行号 ∈ [1, 文件行数]」） | 本轮按实际行号手工重取；再次印证下方「锚点只验行号存在性、不验语义」那条缺口——门禁绿不等于锚点对，改代码后必须自查锚点语义 |

## 本轮仍需收口

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| **本机 3080 伪造监听者凭据泄露（高风险，源码已修、设备待验）** | 壳进程持续持有 TCP 端口，转发仅连应用私有 Unix socket 并验证已连接对端 app UID；覆盖探活、refresh、RPC、通知、mux、控制队列、来件与 WebView。根因见 [坑 350，修复及证据见坑 352](gotchas.md) | 宿主 HTTP/WS 正反证已通过；**未做设备验证**（ADB 为空，两个模拟器拒绝连接）。须来源链新包执行 fresh-process 伪造监听者 instrumentation 负控，再补 CDP/ADB 自主任务与双方向验收；补验前不得将此项记为完整关闭 |
| Hard / Soft 插件状态 | 可信 factory identity、四态与真实冷启动健康正在实施；live 用户 patch 不能成为 Hard 来源 | 冻结后统一测试；Disabled 官方条目不能阻止健康；隔离不丢源码/config；退出 Safe Mode 恢复用户配置 |
| 历史 ONLINE 事务与健康 | 本分支已删除新在线更新入口，保留旧 journal、usr-only 交换与 probation/commit/rollback 的恢复兼容 | 最终新包验证历史中断恢复不改用户 HOME；仅 HTTP 活着不得提前提交；失败后可恢复 |
| 回撤节流纪元 | `.undo-auto-done` schema 2 仅抑制相同安装指纹 + 回滚前失败 patch digest，成功回滚后原子写入；身份变化重开观察窗，旧数字时间戳在有效期内保守抑制并记诊断；显式用户重启在确认本壳子进程停止后清 marker，自动重试不清。纯逻辑与源码接线测试已补，仍待本批 Gradle fresh 验证 | 同一失败配置防循环，新安装/新配置不继承旧事件；marker 写入只发生在成功整份恢复后 |
| 许可证 | Shizuku api/provider/aidl/shared 13.1.5 官方 POM 均为 MIT；已补固定许可文本、矩阵、notices 生成及版本/文本反例 | 最终 APK assets/licenses 内含 MIT 全文与 SDK notices；当前源码门禁通过不等于实包已确认 |
| MiMo 与配置保留 | 旧基线真实 wire on/off 成功；虚拟屏目标达成但旧任务 13 次工具调用超出事先 10 次限制，整例未通过 | 新正式包自主任务预先约定可行预算并按真实事件计数；保留既有配置/会话/凭据 |
| UI / 范围 / 通知 / 浏览器 | 有旧版和阶段证据；最终当前树尚未完成三层回归 | 两个模拟器横竖屏、透明度、拒绝面、文件选择、后台任务和旧会话均按同一产物复验 |
| 真机 | MuMu x86_64 是开发首验；arm64 真机是发布前补充 | 华为 WebView identity/安装反馈不能以模拟器替代真机证据 |
| Actions 列表与维护线 | 2026-10-17 API 清单仍含 active 的 `release`，因默认分支仍为 `main`；本仓已删除该文件。旧 `Snapshot Build` / `ADB runtime patch` 已不在该次清单中 | 本仓仅使用显式 `--ref main` 的来源构建入口；Actions 列表中可见历史/其他分支工作流不等于本仓允许运行 |
| `check-code-map.mjs` 锚点只验行号存在性、不验语义 | 锚点判定只校验「行号 ∈ [1, 文件行数]」（`scripts/check-code-map.mjs:235-242`），**不校验该行内容是否仍是文档声称的符号**。源码前移后地图会**静默漂移**而门禁仍 `exit 0`。实测（2026-10-11，只读探针）：1633 个锚点中带可提取预期符号者 **667 个（40.8%）**，可判读的 495 个里约 **53%（263 个）已漂移**；手工抽查 4 例 **4/4 真漂移** —— `AndroidBridge.kt` 的 `jsString` 文档写 `:423`（现 `:675`）、`BrowserHost.kt` 的 `onMain` 写 `:187`（现 `:386`）、`UpdateManager.kt:69` 写 `renameTo`（该行现为 `IllegalStateException`）、`SnapshotFs.kt:83` 写 `move`（现 `:74`） | 已裁定**本轮不改门禁**（两条理由：① 它是发布链门禁，改它需自证，而本轮已多次代码改动 + 第三次出包，风险叠加；② **未调参就启用比不加更坏** —— 会训练人忽略门禁）。**建议实现方向**：① 文档侧先给锚点补预期符号（纯文档、零门禁风险），把可校验覆盖率从 40.8% 往上提；② 门禁侧再加「`line ± WINDOW` 内出现预期符号」的校验 + **反例自检**（「符号移走能被发现」与「符号在窗口内不得判红」），WINDOW 按基线调参至误报为 0 再启用。**注意**：朴素窗口校验误报率高（59.2% 的锚点提取不到预期符号；裸文件名锚点如 `MainActivity.kt:815` 按仓内约定相对 `app/src/main/java/com/snoworwind/pocketharness/`），**不要在未调参时直接启用** |

## 0.14.7 已知限制（本轮如实登记，非缺陷隐瞒）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| R2 长按拖动：拖到列表边缘不自动滚动 | `sidebar-reorder.ts` 在拖动期间 `preventDefault` 拦原生滚动（否则手指下列表滚动会让命中行漂移、插入位置乱跳）。Spec §2.2 有「拖到列表边缘自动滚动」一句，本轮**未实现**。 | 已裁定本轮不做（需滚动容器 + rAF 边缘推进，属独立增量）。**用户可见影响：长列表远端目标需分两次拖动**。建议 0.14.8 独立项。 |
| R2 驱动上游 DnD 依赖合成事件 | 触摸屏无原生 drag 触发路径，故用合成 `dragstart/dragover/drop/dragend` 驱动上游 `Rows.tsx` / `WorkspaceBrowser.tsx` 的既有 handler。合成事件 `isTrusted=false`。 | 已核实上游当前**不校验** `isTrusted`。**若上游将来加该校验，本方案会静默失效** —— 届时需改为上游原生触摸拖放或请求上游提供触摸入口。 |
| #348 键盘遮挡：本机无法给出真机键盘证据 | 成因已修（弹层高度钳制纳入 `visualViewport` 底边，见 `composer-popup-guard.ts`）；本机可复现缺口（合成视口关系下溢出 196/96px 归零）。但本机仅有搜狗输入法、`mInputShown` 恒 false，真实键盘弹出态不可得。 | 记「**成因已修 + 待真机键盘复验**」，**不记 PASS**。票据所述澎湃 OS / Android 17 触发条件本机不可覆盖。 |
| Android 16/17 与澎湃 OS 专有行为 | 本机为 Android 15（MuMu x86_64）。`keyboard-boundary.ts` 注释记录的「Android 16 edge-to-edge 上 adjustResize 不缩布局视口」无法在本机复现验证。 | 本机**不可覆盖**，未计入通过项，需真机补充。 |
| R2 跨 account 重排未覆盖 | 上游 `sessionDragOrder` 按 `activeDrag.accountKey` 分组；本机仅有 1 个工作区行、无两个 account 各自的会话。 | 本机数据不具备，标**未覆盖**（不是通过）。已验证的是「跨组落点不改变顺序」（R2-5b）。 |
| 键盘判据在本机语义不稳定 | `mInputShown` 在 CDP 复验读到 false、ADB 探针读到 true；且新建会话后上游聚焦新 composer 本身会弹键盘，属标准 UX。 | 测试侧**只记录键盘数值、不作 FAIL 依据**（避免把正常 UX 写成缺陷）。#349 的「不弹键盘」半条同样待真机复验。 |
| `visualViewport` 判空曾漏 undefined（本轮已修） | `keyboard-boundary.ts` 原按 `vv === null` 判空，漏掉 `visualViewport` 求值为 `undefined` 的宿主，读 `.height` 抛 TypeError 并打断视口复算链。 | 已修为 `window.visualViewport ?? null` 并补 2 条回归用例（含反证）。记入 gotchas 284。 |

## Linux 内部插件的待接入边界（2026-10-16）

本仓交付实验性、默认不启用的宿主服务/API 与条件设置入口。bootstrap 与 runtime 是**我们自己的实验性内部插件**：按用户口径应随应用放入**内置（hard）插件目录**，但**默认不启用（存在不等于启用）**；应用更新或插件新版本发布都不得启用插件，也不得重新启用用户停用的插件。

现状与缺口（如实登记）：bootstrap 源码 vendored 于 `plugins/dsh-linux-bootstrap/`（`@dsh-android/linux-bootstrap` 0.5.0，源 `kelai141/dsh-bionilux@3f86a85` `packages/linux-bootstrap`）。它现在已进入 `scripts/plugin-dirs.json`、`scripts/contract.json` 与 profile 插件挂载；来源链先编译 `lib/index.js` 和 `lib/client.js`，再同运行时、Bionilux、Debian ARM64 rootfs、glibc Node 一起嵌入快照的 `usr/share/pocket-harness/linux-assets`。插件服务由 `linux-env` 以函数配置注入 APK 签名保护下的快照资产、原始 manifest SHA-256 sidecar 和应用版本。配置只提供资产和信任校验；运行时仍默认禁用，安装/激活必须用户明确确认。工厂资产 workflow 的 59 MB artifact 仅保留为独立检查产物，APK 来源 workflow 会对当前提交重新构建，避免依赖短期 artifact。

漂移由 `scripts/check-vendored-linux-bootstrap.mjs` 守（`--self-test` 含 1 正控 + 3 负控）：断言 vendored 文件集 == 上游包去掉 `test/` 加本仓两个文件、9 个上游一致文件的 EOL 归一秒摘要、以及三条刻意偏差（`exports` 指 `./lib`、保留 `build` 脚本、去掉 `test` 脚本、`private:true`）。它**不进** `check-release-gates.mjs` 的 `GATES`（进册即要求本地链与云端链同时接线，而那是镜像面文件），故以文档化命令 + 自检形式提供。

`kelai141/dsh-bionilux` 的内部 bootstrap 需被启用后提供 `linuxBootstrap` 服务、调用 `linuxPluginHost`（含 `isInjected` 在场查询）后再激活；构造/下载/解包由 bootstrap 拥有，运行时 manager 装配由宿主从激活作用域读出并交回（`install` 返回 `{manager, rollback?}`）。**未覆盖**：runtime 插件本体仍未 vendored（按设计只来自 Release），因此 `linuxPluginHost.install` 与 manager 交接只由单测（真实 Cordis + 受控 manager）覆盖，**没有**跑过真实 Release 产物。

设备验收尚未执行：没有在 Android 上验收离线 manifest/资产读取、Linux 安装、更新、重装、卸载或工具执行。本轮先完成基本代码、自检与来源 APK 构建；随后统一执行设备侧验收。这些内部插件保持默认不启用，APK 更新不得自行启用它们；真实用户流程仍需设备验收。

**2026-10-19 真机调查更正**：已有一轮真机证据（vivo V2425A / Android 16），结论是**当前实现不可用**：本 ROM 的 `/data/data` 是 `tmpfs noexec`，glibc loader 无法被内核 `execve`；W5（外部 loader）已实测失败，bionilux 本身不是 glibc→bionic 转换层。插件可加载但运行时不能启动，安装链也未闭环。本轮决定**暂不移除**该功能（移除涉及构建链、来源资产、插件/厂商、Kotlin 桥、工作流、门禁与文档，设备不在线时风险高），保留为实验性、不宣称可用、不再投入实现。完整证据、真因、保留决策与将来重启的路线门见 [`docs/linux-env-findings/README.md`](../linux-env-findings/README.md)。

### 0.15.0 追加：宿主侧准备与来源内离线接线（设备验收待做）

已落地并有反证：`LinuxAssetIO`（来源面/落点面/摘要+体量/解包面判据，复用 `SnapshotExtractor` 与 `SnapshotBundledAsset`）与 `LinuxAssetPrepare`（客户端触发入口，`@JavascriptInterface` `linuxAssetPrepare`/`linuxAssetPrepareStatus`）。五条负控（穿越、符号链接逃逸、炸弹、摘要不符、字节数不符）在 Kotlin 侧各有真实用例，且失败一律不发布产物。

**接入与验收边界**：壳侧 `LinuxAssetPrepare` 的网络准备面继续保留原有职责；离线 Linux bootstrap 使用另一条受 APK 签名保护的内置资产路径，不回退到网络下载。离线构建接线、自检与插件单测已经落地，来源 APK 云端全链与 Android 设备验收仍未完成，不能记为端到端已验收。

**工具链边界**：APK workflow 的 Linux 交叉编译宿主工具由 Ubuntu runner 的 apt 仓库提供，目前未按每个 deb 固定版本与 SHA-256；NDK 官方 Linux 包只有 SHA-1 发布摘要可用，provenance 会披露该事实。离线 bundle 的用户侧信任锚仍是 APK 签名保护的原始 manifest 字节与 sidecar，逐项匹配内嵌资产的 SHA-256 和长度。主机工具链可复现性还需后续提高，不能把 source commit 相同直接等同于 bit-for-bit 可复现。

## 历史事项不自动关闭

旧登记的浏览器自动落位、看门狗恢复入口、API<30 截图回落、多 ROM 限制、动效、滚动条、低置信度依赖判据等，保留当时证据。应按当前源码逐项分类为已改、仍存在或仅特定设备待验；不得把旧“未修”直接当当前事实，也不得把归档当完成。

完整原文在 [历史缺口登记](../archive/known-gaps-pre-0.14.5-2026-10-07.md)。当时版本结论、授权和停止点均不覆盖当前本轮要求。

## 原生管理中心（2026-10-16）

当前上游插件管理 API 不提供静态依赖图。壳侧在停用前确认操作，比较操作前后完整运行清单并尝试恢复造成失活的变更；这是运行状态检查，不等同于静态依赖分析。只读/不可寻址条目保留展示并禁用开关。插件详情复用运行时暴露的配置 Schema；未激活或未提供可编辑 Schema 的插件明确说明原因。高级配置为合并保存，删除 JSON 字段不代表重置。


## 2026-10-17 上游同步验收边界

上游 `e3e728b` 已同步到安全分支工作树；本轮 **未做设备验证**，模拟器两端口拒绝连接且无在线真机。管理中心、气泡导航、Shizuku 及新增 Linux 桥的 CDP/ADB 层均未关闭；本轮没有来源链新 APK，不得沿用上游设备截图作为本分支验收。源码检查和本机测试证据见 SECURITY-HARDENING.md 同日复核。


2026-10-17 Linux 安全修复仍 **未做设备验证**：源码反证与 Kotlin 编译/单测通过不能替代来源链 APK、CDP 和 ADB 自主任务；bootstrap 未进入注入集、页面尚无准备桥调用者的集成缺口不变，详见上述 Linux 待接入边界。

## 2026-10-17 晚第二轮发现时记录（历史，修复状态见当前入口）

第二轮挖掘（基线 `2fbcc7f`）登记 17 项新发现，**全部未修复、未做设备验证、未新增回归用例**。详档 [SECURITY-AUDIT-2026-10-17-R2.md](SECURITY-AUDIT-2026-10-17-R2.md)，坑位 376-392。它们是当前**已知且未关闭**的风险，任何人不得据「已登记」把它当作已处理：

| 类别 | 坑位 | 未关闭事实 | 关闭所需的证据 |
|---|---|---|---|
| 壳侧授权 | 376、377 | 用户拥有的屏幕范围 / AI root 同意与开关，状态在 app-uid 可写 prefs，桥写方法也无用户在场证明；模型自带 bash 或同源页面脚本可改写 | 设备上证明「模型无法自授权」，或改为壳外不可写/用户在场证明后三层验收 |
| 可用性 | 378、383 | 3080 中继 32 槽可被本地零权限应用占满；未鉴权 `privilege/status` 会占单槽控制队列 | 设备压测 + 中继/路由改造后的回归 |
| 跨应用信任 | 379 | 任何通知监听应用可代按审批/代答提问（含锁屏，回复 PendingIntent 可变） | 明确接受该委托面，或改成解锁/前台/应用内确认并设备验收 |
| 模型面 | 380 | 市场安装是否需用户确认由远端 riskFlags 决定，空标记即无确认安装 | 安装闸门改为本地判据（或用户确认）并负控 |
| 供应链 | 381、385、386、387、388、389 | Linux runtime 信任锚在第三方 Release；快照无字节绑定；preinstall 不按 commit 重建；pnpm/canvas 只信自声明摘要；.debs 只比 size；Gradle 无校验和 | 逐项改为「从固定 commit/固定哈希重建」，并各配一条受控负控；不构建 APK 不算关闭 |
| 前端注入层 | 390、391、392 | 隔离浏览器标题被当设备路径；整文档子串哨兵可被杀；open-path 会话范围只是建议 | 设备上复现 + 判据改造 + 三层验收（391 还差「boot graph 是否在 HTML」一步） |
| 命令构造 | 384 | nonce 未引号转义拼进 uid 2000 命令 | 转义或改 argv 传参，并补负控 |

与既有条目的关系：381 是「Linux 待接入边界」里「runtime 只来自 Release」的**安全侧补充**（原条目只登记集成缺口，未登记信任锚）；385/386 与坑 336 同族但**不是同一路径**（336 只覆盖项目组件报告，未覆盖引擎快照与 preinstall）；387/388/389 属来源链从未登记过的下载/缓存缺口。本轮没有改变 336/339/350/352/373/375 的既有结论。

## 参考仓库更新（2026-10-19，#414 堆上限）

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| **高内存设备的引擎堆压力（代码已吸收，设备待验）** | 壳侧与快照 wrapper 将上限从 1024 提至 4096MB，仍取设备总内存一半并保留 512MB 下限；1/2/3/4/6/8/16GB JVM 档断言及自然上限退化反例已补，但未测真实 Android 运行时的 RSS、并行应用压力或长任务峰值 | 来源链 ARM64 包上覆盖低、中、高内存设备的启动与长任务，观察进程峰值、系统回收及前后台切换；当前不得据源码断言所有设备都受益或可发布。详见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 2026-10-19 轮次 |

## 引擎 0.2.1-rc.2 候选（2026-10-19）

源码适配、真实构建产物及代码验证已实施，最终 main 来源双构建与设备证据按 [升级记录](ENGINE-UPGRADE-2026-10-19.md) 收口。ADB 实际为空，目标 ARM64 设备 ABI 不可读；CDP、ADB 自主任务、横竖屏与覆盖升级未验收。旧 runtime-capture 退为历史，不移植参考仓的设备结论；模型能力插件暂保留至替代设置能力实际验收。

## Engine base 复用未决项（2026-10-19，PR #51）

机制本身与门禁已落地（PR Gate 25 步、Kotlin 122/122 类 / 1322 用例通过），但真实产物链路尚未闭环。详见 [ENGINE-BASE-2026-10-19.md](ENGINE-BASE-2026-10-19.md) 与坑 451。

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| Java 钉值 | `engine-toolchain.json` 写 `17.0.20+1`，Temurin 无此标识（实际 `17.0.20+8`），全等比较使 plan 在合规 runner 上也必红 | 改为真实标识或前缀匹配，并在 runner 上跑通 plan |
| 本地复跑 | `buildRun` 来自 `GITHUB_RUN_ID` 且被 compare 要求两端相等，本地双构建必停在 `replica source identity mismatch` | 提供显式 run 标识或用「同 run 内副本」语义比较 |
| 生成文件归一化 | `engine-deploy` 三件套未 rebase、未定序，内嵌 `file://` 绝对路径 344/3349/1 处 | 归一化与定序后计入 tree，或登记为已知非确定性并写进锁 schema |
| materialize | 尚未在真实 base 上验证（compare 从未产出可信 base） | 用真实候选 lock 跑 materialize 并继续一次 engine 复用构建 |
| 云端 checks | runner 未分配（job `steps: []`，main 同形态），计费/配额问题 | 恢复后由 CI 复跑确认 |
