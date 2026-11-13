# AGENTS.md — pocket-harness 项目地图

> **本文件是你进入壳侧的入口**：仓库地图 + 去哪查 + 更新协议。不堆历史记录。
> 一切以源码为准；发现文档与源码不一致，**当场改文档**。

---

## 1. 这是什么仓

DeepSeek Harness 的独立安卓应用 **Pocket Harness**（包名与 Kotlin namespace 均为 `com.snoworwind.pocketharness`）。

本项目基于 [dsh-mobile-apk](https://github.com/snoworwind/dsh-mobile-apk) 的 `security/hardening` 分支提交 `cb1c315` 独立建立；应用名、applicationId、发布签名与 APK 产物名已迁移，具体边界见 [项目基线](docs/AGENTS/BASELINE.md)。

**职责边界**：只保留安卓平台权能与桥——前台服务 / 看门狗 / WebView（主 + 隔离 BrowserHost）/ SAF 桥 / 快照解压 / UndoGate / Shizuku 特权 transport 与虚拟屏 / 无障碍与 Shizuku 授权 / 通知中心与通知内应答 / 返回网关 / 审计 / 控制台 / 日志。

**关键约束：AI 可见的能力全部来自插件**，壳侧不直接注册工具。

**运行时**：本实验分支改为内置 Linux 四件套，CI 与边界见 [Linux CI](docs/AGENTS/LINUX-CI.md)；以下为正式版基线：内嵌 Termux 快照（`assets/snapshot.tar.xz` → `files/usr` + `files/home`）；当前正式版 v0.15.2 的来源目标为 **0.2.2-rc.1**（源码固定、Android 适配及验收范围见 [升级记录](docs/AGENTS/ENGINE-UPGRADE-2026-11-06.md) 与 [发布说明](release/v0.15.2/notes.md)），监听 `127.0.0.1:3080`；WebView 加载引擎 Web UI。

**构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。

**兄弟子仓**（本仓内含自包含副本，见 §4 同步铁律）：
`dsh-shell-linux` 0.2.0 · `dsh-client-ui-responsive` 0.3.5 · `dsh-host-web-compat` 0.1.15 · `plugins/`（bridge 0.2.4 / manage 0.3.0 / model-capability 0.2.1 / file-open 0.1.0 / browser 0.1.0 / linux-env 0.1.3 / vdisplay 0.1.0）· `vendor/`（marketplace / undo-savepoint）

**上游** `deepseek-ai/deepseek-harness`（协调仓 `dsh/` 只读 checkout）：**零改动**，一切适配走补丁/插件/壳侧。

**当前状态：以 `docs/AGENTS/changelog-archive.md` 最新一行为准**（本文件不维护版本号，避免双份漂移）。

---

## 2. 怎么建、怎么装、怎么验

```powershell
# 在本仓触发云端来源链（默认 ARM64；`-f abi=x86_64` 构建 x86_64；草稿发布自动构建双 ABI）：
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
# 单独触发 x86_64 来源构建：
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main -f abi=x86_64
# Linux / WSL 本地隔离来源副本，默认 main ARM64；x86 QA 用 --abi x86_64（codex/x86-*），已授权 ARM64 Linux 实验用 --experimental-linux（仅 codex/linux-runtime-experiment）；只构建已提交 HEAD：
node scripts/source-build/run-local-source-chain.mjs
# 本地 x86_64 QA（临时签名，不是正式发布产物）：
node scripts/source-build/run-local-source-chain.mjs --abi x86_64
# 产物与环境详见 docs/AGENTS/build-and-env.md；禁止旧本地/协调仓链出 APK。
# 合并前自查（可选，CI 亦会自动跑；步骤直接取自 pr-gate.yml）
node scripts/ci/local-gate.mjs

# 装机（<serial> 用 adb devices 查；arm64 真机必须用 arm64 产物）
adb -s <serial> install -r -t out\v<版本>\pocket-harness-v<版本>-arm64.apk
```

**设备**：
- 模拟器验收统一使用 Android Studio 的 Google 官方 Android Emulator：Android 16（API 36）Pixel AVD，默认使用 `default/arm64-v8a` 系统映像（SDK 包 `system-images;android-36;default;arm64-v8a`）运行本仓 ARM64 产品 APK。设备创建与 ABI 检查见 `docs/AGENTS/emulator-test-protocol.md`；MuMu 仅保留为历史记录，不作为当前验收设备。
- x86_64 Android 16 AVD 仅供本地开发 QA 使用，可安装显式构建的 x86_64 APK；不能替代正式发布的 ARM64 设备验收。
- ARM64 设备 V2425A `<arm64-serial>`（1260x2800，SDK 36）用于本应用安装验收；当前暂不可用，发布前必须补充门禁。

**验证脚本**（`scripts/`，必须**逐个单独跑**，每个都重建 WebView target）：

| 脚本 | 用途 | 参数约定 |
|---|---|---|
| `verify-webview-015.mjs` | WebView / polyfill / 内联脚本 / 面板 | ws **positional**；`--wide` 横屏 |
| `verify-state-sync.mjs` | 跨层状态同步真源用例集 | **不要传 `--ws`**（会禁用 target 重解析） |
| `verify-browser-host.mjs` | 隔离浏览器视口/PC 身份 | ws **positional** |
| `verify-vdisplay-viewer.mjs` | 虚拟屏 viewer 两阶段契约 | `--ws` |
| `verify-browser-panel.mjs` / `verify-vdisplay-float.mjs` / `verify-engine-log-copy.mjs` | 面板/浮窗/日志 | 见脚本头注释 |

**CDP 调试**：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `adb forward tcp:29225 localabstract:<socket>` → `ws://127.0.0.1:29225/devtools/page/<id>`。

**热推（仅 JS 插件，不含 Kotlin）**：`node scripts/hot-push.mjs --serial <s> --plugin <dir> [--pkg ...] [--restart]`。

**什么时候可以用热推 —— 它是免打包通道，不是绕过验收的通道**：

- **适用**：改动**完全落在快照内 runtime**（`@dsh-android` 插件的 `lib/**`、`client.js`、引擎树 JS）。这类改动的生效链是
  「本地 `npm run build` → 推进设备快照树 → 引擎重读」，与 APK 打包无关；三层结果只覆盖热推后的设备树。最终 APK 须核对同一源码/构建产物并重新装机验收。
- **不适用（必须走来源链出 APK）**：壳侧 Kotlin（`.kt` 要编译进 dex）、签名/权限/清单、assets 与 `snapshot.tar.xz` 本身，
  以及任何**面向发布的最终产物**。改了这些还热推 = 验的是旧壳，属假绿。
- **正式 Release 默认回到三层验收**：开发期热推不要求设备验收；热推只覆盖当时的设备树，正式发布时仍须从最终源码重建 APK 并完成 §2.1，或按 §4 显式记录设备层豁免。
- **发布前必须回全链**：热推产物**不进 APK**。任何要随版本发出去的东西，最后都必须由来源链重出一遍并重验。
- **实修（0.14.2 rc.2）**：此前脚本每个落点恒失败（`cp: …/lib/.: Permission denied`）——`adb push` 在 `/data/local/tmp` 建的目录是
  `0771`（others 可穿越、**不可列目录**），而 `cp -r <stage>/lib/.` 必须列目录；已修为推送后 `chmod -R 755`。
  根因与复现见 `docs/AGENTS/gotchas.md`，遇到 Permission denied 先查那里，不要手工 `cp` 绕。

### 2.1 正式 Release 发布前的三层设备验收（详档 docs/AGENTS/emulator-test-protocol.md）

模拟器、CDP 与 ADB 用户验收默认只在公开发布正式 GitHub Release 前执行。开发 PR、普通合并、热推和未发布版本不要求设备验证，也不因设备不可用而阻塞；PR 仍须按 §4 提供相应代码、静态、单测和门禁证据。正式 Release 默认须针对最终源码构建的 ARM64 APK 完成本节三层；若明确声明不做或部分不做设备验证并在 Release 记录中写明 APK/commit、未执行的 CDP/ADB 层、原因与剩余风险，可省略相应设备层并按未验收发布。该豁免不免除代码、CI、来源构建或签名要求。

1. 三层验收彼此互补：代码层（Kotlin 单测 + 静态门禁 + 本改动反证用例）、CDP 层（对应 verify 脚本，断言状态语义与跨层数据）、ADB 用户体验层（真机操作和截图，证明真人能完成同一件事）。
2. 任一层红都说明系统有问题，必须归入交互逻辑、用户体验、代码缺陷或跨层数据断链之一；不许当噪声或只修单层。CDP 全绿而 ADB 失败说明内部未打通；代码层绿而 CDP 红说明接口与实现脱钩；代码和 CDP 都绿但真人做不到说明交互逻辑错。
3. 发布验收任务必须真实且由模型自主编排：提供目标、约束和成功标准，不提供操作序列；过程须保留工具调用、失败重试和最终汇报。屏幕范围、Shizuku、虚拟屏或通道状态变更先跑 node scripts/verify-screen-scope-matrix.mjs --serial <s>，再补人眼判读。
4. CDP 和 ADB 证据默认不能互相替代：DOM 断言看不到几何、遮挡、焦点和键盘问题；截图也不能证明状态语义。正式发布验收默认两层都通过；若按 §4 豁免，须记录未执行层且不得称其已验收。
5. 发布验收证据落盘：命令清单、每步截图（.deploy-tmp/<round>/ui-NN-*.png）和三层结论；Release 说明或相关 PR 贴结论与路径。若豁免设备层，必须记录未执行层、原因和剩余风险且不得写功能验收通过。
6. ARM64 发布验收默认覆盖两个方向：Google 官方 Android 16（API 36）default/arm64-v8a AVD；同一 ARM64 真机竖屏和横屏各至少一次 tap 级操作与截图。若草稿包含 x86_64 APK，还须在 Android 16 x86_64 AVD 安装对应产物并完成 ABI 门禁及 UI 截图；x86 AVD 不能替代 ARM64 设备验收。几何或布局改动两个设备方向都必须跑。缺设备时不得记 PASS；若按 §4 显式记录设备验收豁免，可带未验收说明发布。
7. 快照刷新期间禁跑发布设备验收；uid-mode appop 残留、prefs 僵尸 a11y 标记或应用被切后台会制造假失败，清理与判据见详档 §3、§8。

---

### 2.2 开发期选择与最终收口

- 开始版本任务时建立 `release/v<版本>/notes.md` 草稿，随实现和证据更新；计划/待验收明确标注。最终对照上一 Release、目标 Commit/Tag、已合并 PR、Issue、CI/设备证据和资产核对，仅保留该版本实际交付内容。发布说明面向用户，先写问题改善，再写安装/升级、限制与验证范围。
- 根据变更输入选择自检；结果记录源码/门禁版本、输入哈希、环境和命令。相关输入、依赖、门禁或环境改变即失效；相关输入不变可复用已有有效证据。成组修正后集中重验；权限、数据事务、签名、桥协议及门禁自身的即时反证不可省。
- 纯 runtime JS 改动开发期优先热推；壳侧、签名、Manifest、APK assets 改动需要 APK。云端来源链按 ABI 选择构建 ARM64 或 x86_64，草稿发布会对两个 ABI 分别双构建、比对并签名；x86_64 的 PRoot Linux 资产与 Canvas native 尚不提供。装机前实际查询 ADB 设备和 `ro.product.cpu.abilist`，设备为空或未知不得推断已兼容或已验收。最终候选从最终源码构建两个 ABI；对应设备验收要求见 §2.1；若显式豁免设备层，按 §4 在 Release 记录中披露且保持未验收状态；热推证据不能代替最终 APK。
- 来源审计入口 `scripts/source-build/run-local-source-chain.mjs` 仅构建已提交 HEAD，在原工作树外的独立检出执行；未提交内容不进入来源链。产物留在隔离目录，续跑显式传 `--build-workspace <同 HEAD 目录>`。不要把来源链的 LFS pointer 当成本地底座归档。
- 权限、用户数据、运行时生效、ABI、签名、快照/APK 产物门禁保持阻断。仅维护说明的生成块漂移由 PR Gate 的提示 job 呈现（`check-maintenance-docs.mjs`，更新用 `--write`），不加入 APK 发布阻断链；`main` 的分支保护已在远端启用（2026-10-20），本文只记录口径，不在此处改远端设置，详见 `docs/AGENTS/build-and-env.md`。

## 3. 去哪查（按需 grep，别通读）

| 要查什么 | 去哪 |
|---|---|
| **项目基线 / 未迁移标识** | `docs/AGENTS/BASELINE.md` |
| **安全审计方法 / 仓库外结果归档** | `docs/AGENTS/SECURITY-AUDIT-PROCESS.md`（Cloudflare `security-audit` skill；审计输出保存到仓库同级的 `../pocket-harness-security-audits/SECURITY-AUDIT-<被审查提交短哈希>/`） |
| **Linux 环境调查 / 保留决策（2026-10-19）** | `docs/linux-env-findings/README.md`（原始报告、源码复核、两轮实机、迁移/保留决策） |
| **构建拆分 / 复用架构（2026-10-19）** | `docs/AGENTS/BUILD-DECOMPOSITION-2026-10-19.md`（2026-10-19 历史设计；`base-lock` 已由内容键 + 自证取代，现行拓扑见 [BUILD-STAGES-DESIGN](docs/AGENTS/BUILD-STAGES-DESIGN.md)） |
| **坑位（历史实锤，权威）** | `docs/AGENTS/gotchas.md`（递增编号，允许空缺；grep 关键词） |
| 模块职责 / 函数位置 | `docs/AGENTS/modules.md` |
| 架构 / 依赖方向 | `docs/AGENTS/ARCHITECTURE.md` |
| 桥方法签名 / 通道语义 | `docs/AGENTS/BRIDGE-API.md` |
| 无障碍 API 与权限面 | `docs/AGENTS/ACCESSIBILITY-API.md` |
| 构建失败 / 门禁 / WSL 环境 | `docs/AGENTS/build-and-env.md` |
| 运行时补丁（`assets/patched`） | `docs/AGENTS/RUNTIME-PATCHES.md` |
| gradle 依赖与升级 | `docs/AGENTS/DEPENDENCIES.md` |
| GPL 合规三形态 | `docs/AGENTS/gpl-compliance.md` |
| 已知缺口 / 待办 | `docs/AGENTS/known-gaps.md` |
| 运行顺序 / 嵌套 / 耦合 / 流程图（排查入口） | `docs/AGENTS/EXECUTION-MAP.md` |
| 模拟器验收规范（代码/CDP/adb 三层 + 真实任务） | `docs/AGENTS/emulator-test-protocol.md` |
| **版本历史（全量）** | `docs/AGENTS/changelog-archive.md` |
| **安全审计流程 / 仓库外归档规则** | `docs/AGENTS/SECURITY-AUDIT-PROCESS.md`（审计产物存于仓库外，不提交到仓库） |
| 安全加固分支宗旨、原则与证据要求 | `docs/AGENTS/SECURITY-HARDENING.md` |
| Hard / Soft / Data 持久化路径、SharedPreferences keys、恢复来源 | `docs/AGENTS/PERSISTENT-DATA.md` |
| **出厂全局指令基线（`~/.dsh/AGENTS.md`）与用户全局约定（`~/.agents/AGENTS.md`）** | `docs/AGENTS/PERSISTENT-DATA.md` 两行归属 + 坑位 662；内容源 `scripts/global-AGENTS.md` |

---

## 4. 铁律（违反即返工）

1. **需求不延期**：有明确需求且未获准延后，本轮必须完成。技术阻塞只能给替代实现 + 记真因，不得以「实验特性 / 下版本」降级。
2. **设备验证只在公开发布正式 Release 前强制**。开发 PR、普通合并、热推和其他未发布版本均不要求 APK、模拟器/CDP 或 ADB 用户验收，也不因没有设备而阻塞；有可用设备时可以提前验证，但提前证据不能替代最终发布验收。
   - **正式 Release 默认门禁**：公开发布 GitHub Release 或正式 APK 前，最终源码构建的 ARM64 APK 默认须完成 §2.1 代码、CDP 与 ADB 验收。
   - **设备验收豁免**：若明确声明不做或部分不做设备验证，并在 Release 记录中写明 APK/commit、未执行的 CDP/ADB 层、原因与剩余风险，可省略相应设备层并按未验收状态发布。不得把未执行层标为 PASS。该豁免仅针对设备层，不免代码测试、CI、来源构建或签名要求。
   - **开发 PR 证据**：所有 PR 按风险档提交代码、静态、单测和门禁证据；L1 门禁或脚本逻辑须有 --self-test 与一条受控负控；L2 安全或判据变更须验证相关代码路径及正向/反向判据；L3 行为变更须运行对应代码与组件回归。上述 PR 证据不要求设备验收。
   PR 描述可说明设备验证尚未执行，但这不是 PR 合并条件；正式 Release 若豁免设备验收，必须在 Release 记录中声明未验收范围与原因。
3. **原子化交付 + 分档验证**：一个 PR = 一个逻辑改动，可独立 revert；禁止把「修 bug + 重构 + 顺手优化」混在一个 PR 里。每个 PR 必须携带风险相符的代码和静态证据：L0 文档/注释 → CI 绿即可；L1 门禁/脚本逻辑 → --self-test + 一条受控负控；L2 安全面/判据 → 相关代码测试、门禁正向与受控负向；L3 UI/UX 与壳侧行为 → 相关单测、组件或集成回归。模拟器、CDP、ADB 设备验收统一只在正式 Release 前按 §2.1 执行。
   统一全量测试（ARM64 全链 + 冷启动矩阵 + 真机补充门禁）在发布准备时执行，作为最终集成验证；不能替代各 PR 的风险相符代码证据。细则见[0.14.8 交付计划](docs/0.14.8-DELIVERY-PLAN-2026-10-14.md) §3。
4. **默认改动走 PR**（仓库自 2026-10-20 起为公开仓：标准托管 runner 免费、`main` 已启用分支保护，直接 push 会被拒绝，合并方式只保留 merge commit）：建分支 → 提交（`<type>: <描述>`）→ 推分支 → 开 PR（1-3 标签）→ CI 绿（必检项与保护配置见 `docs/AGENTS/build-and-env.md`；本地门禁 `node scripts/ci/local-gate.mjs` 可先自查）→ 合并 → 删分支。**禁止直接 push `main`**。本仓以 `main` 为长期维护线，首个提交为基线导入；后续改动按 PR 合入，来源链构建与安全加固规则继续适用，详见 `docs/AGENTS/SECURITY-HARDENING.md`。其他例外仅限不改仓库内容的外部动作（Release 资产、issue 评论与开关、标签）。
5. **子仓副本同步（幽灵缺陷防线）**：改 `dsh-client-ui-responsive` / `dsh-host-web-compat` / `dsh-shell-linux` / `plugins/dsh-android-*` 后，**必须把源码与 `package.json` 同步进本仓同名目录**（本分支树内副本即权威，不存在需要对端的第二棵树）。`plugins/*/lib/` 是 `.gitignore` 明确排除的构建产物；PR Gate 和来源构建在打包前通过锁文件安装依赖并从同步源码重建 `lib/`，不提交生成目录。漏同步源码或清单会让构建注入旧副本，**编译通过但功能缺失**。
   - 只同步**镜像清单内的文件**，切勿对 `scripts/` 等目录整体 `/MIR`——会删掉本仓独有的设备脚本（真实事故）。
6. **跨树权威已收归本仓（2026-10-15，按用户决定）**：原先声明 `scripts/patches/**`、`scripts/check-patch-mirror.mjs`、`scripts/build-apk-013.ps1` 等是「协调仓的逐字节镜像，单边演进即拒；补丁改动先合本仓镜像 PR、再合协调仓权威源 PR」。本分支既然只从源码构建、且不依赖 kelai141 名下任何仓库（见 `docs/AGENTS/SECURITY-HARDENING.md` 的「独立」口径），**跨树镜像层已从门禁中整体移除**——`check-patch-mirror.mjs` 只保留 registry↔IMPLS 自洽面，`check-release-gates.mjs` 的「两树同版」断言已删除（它原先在对端缺席时打印 PASS 却从未比对）。树内副本即权威，这些文件在本分支按本仓评审与门禁正常演进，不需要对端配合。
   - 代价已记账：这些文件自此与协调仓**永久分叉**，将来若引入上游改动，这几处必冲突（见 `docs/AGENTS/known-gaps.md`）。
7. **禁 emoji**：提交信息、PR 标题/描述、文档、标签一律不用。
8. **工作区卫生**：`.deploy-tmp` 需要定期清理，但本仓未包含 `scripts/clean-deploy-tmp.mjs`，当前工作区也没有可核对的协调仓副本。清理脚本属于外部协调工具；只有拿到该工具的仓库与提交后，才能在对应根目录运行其默认 dry-run 或显式 `--apply`。未取得前不得声称已执行清理，也不得用未经审查的递归删除代替。注册的 git worktree 与近 3 天活动目录应按该工具的保留策略处理。
9. **APK 只能从源码构建（正式产物为本仓 `main`；本地实验例外见 §2）**：本仓任何 APK 都**必须**由来源链产出（云端 `build-apk-source.yml`，本地 `node scripts/source-build/run-local-source-chain.mjs`），**禁止**用 `build-apk-013.ps1` / `build-release.ps1` 等本地或协调仓链产出、归集或发布 APK。判据、当前缺口与发布链状态见 `docs/AGENTS/SECURITY-HARDENING.md`。
10. **禁止强制推送**：不得对任何远端分支使用 `git push --force`、`--force-with-lease`、`--force-if-includes`、`--mirror`、`+<ref>` 或任何等价方式改写/删除远端引用。分支一旦推送，只能用追加提交更新；需要修正时提交新 commit，或新建分支/PR。合并后按流程删除已合并分支不在此限，但禁止删除后重建分支来覆盖历史。
11. **Git 历史只追加，不得覆盖或改写**：已推送/共享的提交历史绝对不可改写；本仓默认连本地提交也按只追加处理。禁止使用 `commit --amend`、`rebase`、`reset --hard` 等操作改写历史，禁止改写后继续使用同一分支；禁止 `filter-branch`、`filter-repo`、替换/删除远端 ref 来改写历史（合并后按流程删除已合并分支不在此限）。修正一律新增提交。PR 合并一律使用 merge commit，保留分支提交链；禁止 squash/rebase 合并。`main` 只接受通过 PR 追加的提交。

---

## 5. 更新协议（改完代码必须做，否则文档失真）

> **核心原则：AGENTS.md 只是地图，不承载细节。** 任何细节写进 §5.2 的对应详档。
> 本文件**不设更新记录表**——所有版本记录进 `docs/AGENTS/changelog-archive.md`。

### 5.1 按改动类型对号入座

| 你改了什么 | 必须更新 | 位置 |
|---|---|---|
| **任何**代码/行为改动 | 坑位（若踩过坑或修了坑） | `docs/AGENTS/gotchas.md` **文末追加**，编号递增（允许空缺，**不得重编号**） |
| 版本发布 / 里程碑 | 更新记录（一行摘要，**倒序加在最上方**） | `docs/AGENTS/changelog-archive.md` |
| 新增/删除 `.kt` 文件，或函数职责变化 | 模块地图 | `docs/AGENTS/modules.md` |
| 模块边界、依赖方向变化 | 架构 | `docs/AGENTS/ARCHITECTURE.md` |
| 新增/改签名桥方法、通道语义变化 | 桥协议 | `docs/AGENTS/BRIDGE-API.md`（**同步跑** `scripts/check-bridge-symmetry.mjs`） |
| 无障碍 API 用法、权限面变化 | 无障碍参考 | `docs/AGENTS/ACCESSIBILITY-API.md` |
| 构建链、门禁、WSL 环境差异 | 构建与环境 | `docs/AGENTS/build-and-env.md` + `docs/AGENTS/gotchas.md` |
| 改 `scripts/patches/**` 或 `assets/patched` | 运行时补丁 | `docs/AGENTS/RUNTIME-PATCHES.md` §7.1 登记 + §2 字节数按实测更新 |
| gradle 依赖增删/升级 | 依赖台账 | `docs/AGENTS/DEPENDENCIES.md` |
| **改出厂全局指令基线 `scripts/global-AGENTS.md`** | 归属与迁移（工厂件 vs `~/.agents`） | `docs/AGENTS/PERSISTENT-DATA.md`（Factory/User global instructions 两行）+ 坑位 662；改完跑 `node scripts/check-global-agents.mjs` |
| 发现未实现 / 有意留下的缺口 | 已知缺口 | `docs/AGENTS/known-gaps.md` |
| **代码执行顺序 / 嵌套 / 耦合 / 流程图（排查入口）** | 执行地图对应查点 + 覆盖账本 | `docs/AGENTS/EXECUTION-MAP.md`（改完跑 `node scripts/check-code-map.mjs`） |
| 改设备验收方式 / 新增套件或操作原语 | 模拟器验收规范 | `docs/AGENTS/emulator-test-protocol.md` |
| **本文件 §1-§4 的描述失真** | 就地改**对应行** | 只改那一行，**不要新增章节、不要加历史** |

### 5.2 写作纪律

- **细节不下放 §1-§4**：一行能说清就一行；说不清 → 写进详档，本文件只放**指针**。
- **坑位写「为什么」不只写「怎么做」**：现象 → 真因 → 修法 → 复验证据。无真因的条目等于没写。
- **同一事实只写一处**：其余地方用链接/路径指向它。重复即漂移源。
- **数字不写死**：坑位总数、门禁项数、文件数一律用命令现数（`grep -c '^[0-9]\+\. \*\*' docs/AGENTS/gotchas.md`、`node scripts/check-release-gates.mjs --list`）。
- **改了要跑**：文档改动本身不需要构建；但涉及门禁/桥面/补丁改动时，对应的 `check-*.mjs` 必须跑过再提交。

### 5.3 门禁（哪些是自动挡）

`scripts/check-release-gates.mjs` 是聚合入口（`--list` 现数）。关键几条与文档直接相关：

| 门禁 | 守什么 |
|---|---|
| `check-bridge-symmetry.mjs` | 桥面对称性（改桥方法必跑） |
| `check-api-route-auth.mjs` | 新增 `/api` 路由必须自带鉴权并登记 policy |
| `check-control-ops.mjs` | 控制 op 六面登记一致（新增 op 必须六处同改）；`--self-test` 用临时树覆盖各面漂移、known-gap 和坏台账负控 |
| `check-kotlin-comments.mjs` | Kotlin 嵌套块注释 |
| `check-plugin-tests.mjs` | 每个插件的单测真实跑通（全 skip 判假绿） |
| `check-gate-skips.mjs` | 门禁声明、真实调用点与 SKIP 计数一致；先跑 `--self-test` 判别扫描器边界 |
| `check-protocol-v2.mjs` | 协议 V2 产物往返与体积基线；逐个配对 `src/*.ts` / `lib/*.js`，先跑 `--self-test` |
| `check-dsh-runtime-dependencies.mjs` | 来源构建第一方依赖精确版本与已启用遥测消费者的传递闭包 |
| `check-tool-surface-budget.mjs` | 模型面 wire 预算（新增工具会撞；近义工具优先复用既有 + 参数）；`--self-test` 反证阈值、名字和掩蔽名单判据 |
| `check-patch-mirror.mjs` | 补丁 registry↔IMPLS id 双向闭合（**树内自洽**；`--self-test` 反证缺失/多余 ID；跨树逐字节镜像层已按 §4 铁律 6 移除） |
| `check-code-map.mjs` | 执行地图覆盖完整、源码锚点内容/基线、耦合证据行号、编号一致（改代码后必跑；CI 先跑 `--self-test`） |
| `check-op-registry-parity.mjs` | 引擎与壳侧两份「会读设备屏的 op」清单逐条相同（漂移 = 缺省 virtual-only 下工具大面积不可用） |
| `check-tool-name-promises.mjs` | 指引里承诺的 `android_*` 工具名必须有声明位（防「指引指向一条不存在的路」） |

**设备侧（不进聚合门禁，发布前由操作者按 §2.1 跑）**：

| 套件 | 守什么 |
|---|---|
| `scripts/verify-screen-scope-matrix.mjs` | 屏幕范围/通道/落点的设备级验收：跨面一致性（引擎面 vs 壳侧面 vs 设备事实）+ 拉起落点回读（目标屏必须出现本轮新 ActivityRecord，存量 Activity 不算落点证明）+ 双屏像素对照 + `real-only` 反证。权限档位拦截归环境阻塞；**证据不足判 `INCONCLUSIVE`（exit 2），不得当通过**。 |

---

## 6. 高频雷点（只有三条，全量见 §3 坑位表）

1. **ABI**：debug 包内嵌快照决定 ABI；x86_64 快照装 arm64 真机**必崩**。真机只用 `-arm64.apk`。
2. **快照刷新**：唯一完成标志 = `.snapshot-fingerprint` **翻转** + `.snapshot-transaction` **消失**。刷新期间（8-12 分钟）**禁 force-stop/杀进程**，且**不得跑设备套件**（会是假失败）。
3. **`Select -First N` 会杀掉长任务子进程**——构建/长脚本必须全量重定向日志，不能用 `Select -First`。
