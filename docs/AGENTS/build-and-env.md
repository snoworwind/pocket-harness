# build-and-env.md — 构建与验证命令 + 环境流程

## 0.2.1 引擎来源链

目标、工具链、实际构建输入和环境错误见 [升级记录](ENGINE-UPGRADE-2026-10-19.md)。源码阶段用官方 native → Host libraries → Client compiler → Client workspace bundle → Web 顺序；根 workspace bundle 已覆盖 package-local 配置，不能再追加旧 recursive bundle（新版 pnpm 拒绝实际循环依赖）。固定 Corepack 0.36.0；本地 Node 24 必须带匹配开发头文件。APK 仍仅由 main 的隔离来源链产出。

## 双构建比对拒绝重复成员（2026-10-19）

`verify-arm64` 在 `read-apk-snapshot.py` 报 `duplicate or excessive snapshot entries` 时，先分别清点 tar 成员数与重复路径，不要放宽读取器。已确认的注入器重复目录原因与修法见 [坑 439](gotchas.md)；回归命令为 `python -m unittest discover -s scripts/source-build -p test_inject_all.py`，比对器自检为 `node scripts/source-build/compare-independent-builds.mjs --self-test`（Linux）。

## ARM64 Linux 离线资产来源（2026-10-18）

`build-linux-assets.yml` 是只读、无秘密的独立资产检查链，不构建 APK、不创建 Release；手动 `gh workflow run build-linux-assets.yml --repo snoworwind/pocket-harness --ref main`。APK 来源 workflow 另在同一来源提交中重跑该资产构建，并把经过验证的资产嵌入 Termux 快照，不依赖短期 Actions artifact。Bionilux 与运行时插件源码已导入 `vendor/bionilux` / `vendor/dsh-linux-runtime`；实际打包的 bootstrap 输入也登记于 `linux-source-manifest.json` 的独立来源提交与摘要。`check-linux-sources.mjs --self-test` 校验 vendor 文件及 bootstrap 实际打包文件的字节摘要、记录的本地文档偏差，以及同体积投毒/额外编译输入负控。Debian 13 自动签名密钥与 stable key 从 ftp-master 官方地址下载，分别按 SHA-256 和 primary fingerprint 固定，再与 runner 现有 keyring 合并；禁止因 runner keyring 旧而忽略未知签名。

构建计划使用固定 Rust、官方 NDK、官方 Node ARM64 SHA-256、Debian 固定快照 InRelease SHA-256 与官方签名；下载参数在 linux-inputs.json。Cargo 许可清单只收集 `aarch64-linux-android` 过滤后，从当前 crate 根沿 normal/build 边可达的包；dev 依赖和其他目标不纳入。Debian dpkg 包版本/源包版本与 deb 摘要、源码归档计划随 provenance 提供。归档内计划保留 Debian copyright、Node LICENSE 及原生依赖许可清单；对外分发前仍需按 GPL 合规详档核对对应源码资产，不能只凭构建成功宣布发行合规。

真实 ARM64 工厂资产 run [39103194656](https://github.com/snoworwind/pocket-harness/actions/runs/39103194656) 已完整构建并上传资产与 provenance；此前 `r-efi` 全量扫描和 runner 缺 Debian Trixie keyring 的两次失败分别由目标闭包遍历和官方公钥指纹验证修复。约 59 MB、7 天保留的 artifact 仅供独立检查；APK 来源链在自身运行中重建资产，随后校验来源 commit、manifest 原始字节 sidecar、资产 SHA-256/长度和固定 GitHub namespace，再嵌入快照。当前等待本次改动的云端 APK 来源链证明；设备验收按用户决定集中后做。

## 独立检出与固定字节（2026-10-18）

本地来源链在原仓解析来源坐标，冻结为 `DSH_SOURCE_REPOSITORY` 传入所有隔离阶段；隔离检出保持无远端。预检只验证 workflow 固定输入及树内合同，不要求配置或合并 upstream。registry 与补丁夹具全树用 `-text` 保留固定哈希字节，不能重封哈希来容忍 Windows 换行转换。维护文档提示在 push base 不可达时扫描当前受跟踪输入，仍保持提示 job。

验证入口：`node scripts/source-build/preflight-source-chain.mjs --self-test`（真实输入与三个负控）、`node --test scripts/source-build/local-source-workspace.test.mjs scripts/tests/maintenance-inputs.test.mjs`（来源冻结与缺失 base 负控）、`node scripts/check-patch-fixtures.mjs`。本项属 L1，未做设备验证；Linux 专属用例在 Linux/CI 补跑。

第二轮来源链加固：preinstall 从审计 Git 提交重建；pnpm/Canvas 固定官方 SHA-512，缓存每次解包前重验；deb 复用同时验签名索引 SHA-256 与体积；Gradle 固定发行 SHA-256；最终快照与源码包重放补丁后的实际载荷逐字节比较。自检与受控负控入口 `node --test scripts/source-build/security-r2.test.mjs`，来源 workflow 与预检均执行。完整新来源链及设备验收边界见 [修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md)。

本地运行最新 workflow 还需提供 CI 环境别名：RUNNER_TEMP 指向本轮专用临时目录，GITHUB_ENV 指向该目录内的环境文件，并显式设置 npm_config_cache 为其中 dsh-npm-cache（本地运行器不消费 GITHUB_ENV 更新）。隔离检出没有 origin，须从原工作树的 resolveSourceRepository 导出 DSH_SOURCE_REPOSITORY，不得写成另一个仓库坐标。缺项会分别在缓存初始化或组件来源记录处明确失败；不应跳过这些步骤续跑。

工作流外部 action 使用完整 commit SHA；更新时核对官方仓库 tag 对应提交，再跑 `node scripts/source-build/check-workflow-action-pins.mjs --self-test` 和来源套件。PR/来源预检实际执行固定引用扫描，禁止退回可变标签或分支；这不固定 action 自身下载的所有依赖。安全回归命令及本轮证据见 [SECURITY-AUDIT-2026-10-17.md](SECURITY-AUDIT-2026-10-17.md)。

契约门禁同时登记上游与本地 UI 槽位：`clientSlots.slots` 包含实际消费的槽名，`declarations` 默认从 `upstreamRepo` 读声明，本地声明显式填写 `repo`，不加入 `upstreamUniverse`。新增本地槽仍须校验 kind/scope 与文件在场，不能通过跳过声明检查放行。CI 39011926728 的阻断与修复见 gotchas 坑 368；自检命令为 `node scripts/check-contract.mjs --self-test`，必须配套固定版本上游树与插件 lib。

引擎私有通信专项：Linux/WSL 执行 `node --test scripts/tests/engine-private-transport.test.mjs`，真实 Unix socket 正反证已接入 PR Gate 与来源构建预检；Windows 的核心 Unix 用例明确 skip，不能据其绿代替 Linux 证据。设备负控 `EngineTransportInstrumentedTest` 须来源链新包且 fresh process，详见 emulator-test-protocol.md；本次源码及本机证据见 gotchas 坑 352；Android SocketAdaptor 阻塞锁导致启动探活超时的后续修复及未验边界见坑 395。

归一化证据当前采用 `normalizationVersion: 3`。v1/v2 摘要分别遗漏内容或文件系统权限/目录等信息，不能与当前版比较；需从原始快照重算。来源链 tarball 重打包与快照摘要共用保留条件导出顺序的规则，专项命令及反证见 [gotchas.md](gotchas.md) 坑 337、338。此修复未重建 APK、未做设备验证，历史 APK 的签名/字节哈希与源码身份事实保留；权限复核须在支持 Unix mode 的文件系统执行，Windows 测试不能代替。

维护文档生成区按内容比较，兼容 Windows CRLF 检出；换行归一化只用于比较，生成区完整性和内容要求不变。根因与检查范围见 [gotchas.md](gotchas.md) 坑 318。

## 安全加固分支的 WSL 编译环境（2026-10-15）

WSL Ubuntu 使用 Java 17.0.20.1、工程 wrapper Gradle 8.11.1；Linux SDK 安装在 `$HOME/.local/share/android-sdk`，含 command-line tools 22.0、`platforms;android-36` revision 2 与 `build-tools;35.0.0`。命令行工具来自 [Android 官方下载页](https://developer.android.com/studio#command-tools)，下载包 `commandlinetools-linux-15859902_latest.zip` 的 SHA-256 已核对为 `4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583`。安装后删除下载包及解压暂存目录，SDK 与依赖缓存保留供后续编译。

```bash
cd /mnt/d/forGithub/pocket-harness
export ANDROID_HOME="$HOME/.local/share/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain \
  --no-daemon --parallel --console=plain :app:compileDebugKotlin
```

直接调用 wrapper JAR 可避免 Windows CRLF 检出的 `gradlew` 在 Linux 报 `/bin/sh^M`，无需改写受版本控制的脚本。本轮实际编译另用临时 Gradle init 将 build 与 project cache 放在 WSL 的 `$HOME/.cache/dsh-mobile-apk-build`，减少 D 盘临时占用；任务与编译输入不变。初次完整编译基线为 `dad75c2`，16 个任务全部执行并成功，日志 `.deploy-tmp/wsl-android-compile.log`；客户端失败日志补修后的输入及结果见 [gotchas.md](gotchas.md) 坑 320。AGP 对 SDK XML 版本的兼容警告及 Kotlin 编译警告保留在原始日志，不计为零警告构建。仅编译主源码，不执行测试、不打包 APK。

## 应用内更新功能退役（2026-10-15）

用户明确要求在加固分支移除应用内更新。对应专用测试随实现退役，混合测试类只移除更新用例；Kotlin 数量基线的定点调整及原因登记于 `scripts/kotlin-test-baseline.json` 的 `featureRetirements`。数量门禁算法未改。本轮按用户限定只编译和静态检查，未运行测试；UI 自包含副本需重新生成 `lib` 产物。

## fx2 本地来源链

来源链的签名 Termux 仓库闭包会引入新的包名，构建时须按实际 dpkg status 补齐许可矩阵，不能降低未知包阻断。2026-10-15 的缺项与 ICU 上游许可错误页已登记 [gpl-compliance.md](gpl-compliance.md) 和坑 324；许可资产、矩阵与 notices 改动后可复用未变化的已注入程序快照，并用 `build-apk.mjs --skip-inject --snapshot <已核对候选>` 重新跑全部实际快照门禁、生成 APK 与许可 assets。必须记录缓存来源、程序输入未变化的差异核对、许可成员转换与最终产物哈希，不把 `--skip-inject` 当成跳过门禁。

2026-10-15 WSL 来源构建暴露两处执行前提：首次 `--no-checkout` 的上游仓尚无 index，`git checkout -- .` 会报 pathspec；仅在来源链的独立上游检出显式 `checkout --detach` 到 workflow 固定 commit 后才可续跑。pnpm 顶层包为目录链接时，原始归档的逐成员物理路径读取无法读取链接下成员；需执行 workflow 本来就规定的 reconcile/materialize/repack，再重跑原始 perf/profile 门禁及来源快照检查，不能把首次失败当通过。每次恢复都须记录命令与操作块哈希，来源输入和门禁判据不变。MiMo verifier 分派的修复与反例见 [gotchas.md](gotchas.md) 坑 323；本次最终证据以后续 APK 交付报告为准。

`node scripts/source-build/run-local-source-chain.mjs --list` / `--dry-run` 只读 committed HEAD 的 workflow；实际执行在原仓之外的独立浅检出。未提交源码不参与构建。用 `--build-workspace /tmp/dsh-build --from <阶段>` 指定可复核的续跑目录，必须属于同一 source/commit；输出留在该目录，不自动回写 base。隔离检出禁用 LFS smudge，sources 阶段负责重建 base，不能跳过缺失的实际输入。

初次检出与续跑均递归检查宿主写树的目录和文件链接，包括 dangling link；只允许树内别名及具体 staging 子树的 Android runtime 前缀。新增宿主写树须同步 `local-source-workspace.mjs` 与负控。现有来源缓存的只读兼容扫描及真实 runner 外部文件负控见 [gotchas.md](gotchas.md) 坑 339；此检查不等于恶意构建进程沙箱。

三项目组件的来源证明改为本次 APK commit、原目录、包身份、逐文件 SHA-256 与真实输出 SHA-256；不再用独立 host 仓旧 pin 与当前 APK 副本硬比。目录、tgz 以及独立仓入口不变。完整外部消费者迁移仍待确认。

组件来源证明在输入、输出阶段均从固定 Git 提交独立重建清单；可写报告不能作为最终输入哈希的信任根。新增源码、报告篡改、合法锁文件变化与实际 CLI 负控的复核命令和边界见 [gotchas.md](gotchas.md) 坑 336。宿主 npm 配置若在组件目录生成未登记缓存，须移至构建目录的专用缓存区并留移动证据，不加入源码白名单。

开发期按 AGENTS §2.2 选择测试，文档生成块用 `node scripts/check-maintenance-docs.mjs --write` 更新，再不带参数检查；该维护提示不替代功能门禁。当前产品只发布 ARM64；最终完整验收与发布资格仍由 ARM64 来源链、设备三层及覆盖升级证据决定。

来源链产物的复核面固定在交付目录：APK 一份，加 `verify-source-apk.sh`、`SHA256SUMS.txt`、内嵌快照的归一化摘要，以及 workflow 上传清单同款的 `evidence/`。`bc6637f` 的 arm64 产物按此复核通过：APK 内 `assets/snapshot.tar.xz` 与打包门禁实际校验的那份快照逐字节相同（同一 SHA-256），解包重跑 `normalize-snapshot.mjs` 得到的语义摘要与链条记录一致，内嵌引擎为固定的 0.2.0-rc.2；「未取 LFS」的判据是隔离检出里 `base/*.tar.xz` 仍为 133 字节指针、APK 内无基座归档载荷，运行时由已验签的 Termux 仓库包组装。复核三签时必须显式 `--min-sdk-version 18`（默认按清单 minSdk 26 会把在场的 v1 报成 false，见 [gotchas.md](gotchas.md) 坑 325）；宿主 npm 缓存路径会在 WSL 内落成 `D:/` 目录，不参与注入（坑 326）。字节级可复现不成立，判据是语义归一化摘要；该产物未做设备验收。

> grep 用法：`grep -n "门禁\|Fast\|abi" docs/AGENTS/build-and-env.md`。
>
> **当前维护线入口**：维护与安全政策见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md)，阶段记录见 [changelog-archive.md](changelog-archive.md)。本页只维护构建、验证和环境事实。

## 2. 构建与验证命令

```bash
# 云端源码构建，明确指定维护线：
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
# Linux / WSL 本地同链，当前仅 ARM64，构建已提交 HEAD：
node scripts/source-build/run-local-source-chain.mjs
# 插件冒烟（不生成 APK）：
node scripts/smoke-bridge.mjs
```

当前来源链调用快照/打包脚本作为内部步骤；不得绕过来源链直接用这些脚本生成 APK。详细入口与产物说明见文末。

> **多线程/并行优先铁律（2026-09-08 用户定例，改任何构建脚本都适用）**：编译、构建、打包、归档、解压**一律使用多线程脚本**，不得用单线程等价命令替代——目的就是省掉一切可以省掉的构建时间。现行落点：
> - 快照归档 `tar -c ... | xz -T8 -6`（默认 8 线程，由 `DSH_CPU_THREADS` 覆写）（多线程压缩；裸 `tar -cJf` 单线程 ≈380s vs 多线程 `xz` ≈48s，2c 实测）；
> - 快照/基座解压 `xz -dT8 | tar -x`（与构建线程上限一致）（多线程解压，替代 `tar -xJf` 的单线程解码）；
> - 注入链单 pass（`inject-all.py`，压缩次数 ×4→×1）+ dev 循环 `-Fast`（单 ABI + `DSH_INJECT_PRESET=1`）；
> - gradle `org.gradle.parallel=true` / `caching` / `configuration-cache`（`gradle.properties`）；
> - 门禁脚本能用流式并行就用（Python 侧 `tarfile` 单遍流式，勿反复解压同一归档）。
> 新增构建步骤若只能单线程，必须在脚本注释里写明原因（例：9p 写带宽是瓶颈，并行无收益）。

**门禁（历史本地链说明，当前以来源链实际调用为准）**：聚合入口 `scripts/check-release-gates.mjs`（`--list` 现数，不维护数量；接进本地链 / 云端 `build-apk.mjs` / 两仓 CI / 发布链 `build-release.ps1`，发布链 `--run --require` 要求 SKIP=0）。内容 = vendor 统一补丁（`scripts/patches/apply-patches.mjs`：活动 vendor 项由 registry.json 驱动，完整清单见 RUNTIME-PATCHES.md §6.1；market-A/C 已退役，undo S1/S2 在活动清单内，勿加 Select-First）→ 快照单 pass 注入（`inject-all.py`，补齐 + 修剪双向对齐）→ 注入产物完整性（`check-inject-completeness.mjs`）→ 挂载集（`check-patch-mounts.mjs`）→ 机密（`check-snapshot-secrets.mjs`）→ 第三方合规（`check-third-party.mjs`）→ 路由鉴权（`check-api-route-auth.mjs`）→ 工具 schema / 控制 op / 状态登记 / 桥对称 / 门禁 SKIP / 性能插桩 / Kotlin 注释 / 构建链中止 / strip no-op → 运行时资产（`check-runtime-assets.mjs`）→ 快照指纹（`check-snapshot-fingerprint.mjs`）→ elf-check → 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

`check-api-route-auth.mjs --snapshot <tar.xz>` 需要 Python 3.9+ 的 `tarfile`，流式读取固定的注入成员，并逐文件核对授权 marker；不能把 tar 多成员合并输出后对每个文件重复搜索同一段文本，否则一个包内的 marker 会掩盖另一个包缺失鉴权。

**内嵌快照可解压门禁（0.14.7 / task-9）**：`scripts/check-snapshot-decode.mjs`——用**与设备同一套** streaming 解码器（`org.tukaani:xz` + `commons-compress`，版本对账 `app/build.gradle.kts` 的声明值，不一致即判红）把 `assets/snapshot.tar.xz` 完整解压一遍，判据 = 无异常 + 条目数 > 0 + 实读字节数 == 条目声明 size 之和。**为什么需要它**：`check-snapshot-fingerprint.mjs` 断言的是 `sha256(tar) == snapshot.sha256`，而声明值由同一条构建步骤自己写（自证）；`check-snapshot-asset.ps1` 只比对 APK 内嵌与传入的 xz —— 两条都**不解压**，于是「摘要自洽但字节流解不开」的资产能一路打包进 APK，直到用户真机上以 `CorruptedInputException` 爆出（见坑 285）。**执行点**：本地链 `build-apk-013.ps1` 在 `assemble` 之后 per-ABI 段，云端 `build-apk.mjs` 在组装后均对本次实际资产严格解码；PR CI 无生产快照，运行 `--self-test-runtime` 生成合成小归档，并用同一 Java streaming probe 验证有效输入通过、截断/字节翻转被拒，另独立自测 SHA-256 指纹门禁正反例。这些合成输入只证明门禁判别力，**不代表最终 APK 的快照已通过解码**。正式构建链仍须对实际资产运行 `--require`，无 Java、jar 或快照时拒绝继续。普通 `--self-test` 保留为不依赖 Java/Gradle 缓存的纯判据自测。**证据边界**：既往真实资产实测曾报告 `entries=49521 bytes=710586232`，这不是本次 PR CI 或最终候选包的验证结果；新版本的运行时合成自测由 CI 独立报告。

**维护文档对账**：Gradle 版本/依赖与活动补丁清单由 `node scripts/check-maintenance-docs.mjs --write` 生成；改声明或 registry 后更新生成区并运行不带 `--write` 的检查。该检查属于维护一致性检查，可按输入路径在 PR 中显示结果，不作为 APK 功能与数据安全门禁的替代。

**Release 快照契约（该链已退役，2026-10-15）**：原 `.github/workflows/release.yml` 始终先构建本次运行的 arm64/x86_64 快照，release job 依赖 snapshot job 成功，再下载同一 run 的快照与 lock provenance（曾移除无快照来源的 `skip_snapshot_rebuild` 调试输入；失败后可用重跑失败 job 复用同一 run 的 artifact；不得用另一 commit 的快照填充发布输入）。**该 workflow 已按用户决定整体删除**：旧公开发布链不再使用，新来源草稿入口见 RELEASE.md §5，只允许来源链构建，见 [RELEASE.md](../RELEASE.md) §5、[AGENTS.md](../../AGENTS.md) §4 铁律 9 与 [known-gaps.md](known-gaps.md)。此段只作历史契约留档——若将来要恢复发布能力，必须在来源链上重建，**不得复活这条本地/协调仓链**。

**CI 插件复用**：`pr-gate.yml` 按 `scripts/plugin-dirs.json` 准备依赖和构建产物；来源链按同一清单构建带 build script 的包。`build-apk.yml` 默认调用来源构建；选择 `draft_release` 时经草稿工作流调用同一来源链，不存在旧 LFS 构建分流或 ABI 矩阵。

**历史 Release 模型目录跨 job 交接（该链已退役）**：快照 job 的生成 `lib/catalog-snapshot.json` 未跟随归档 artifact 上传，后续干净 checkout 不能依赖它。Release job 从实际输入 arm64 快照提取 pi-ai package metadata 与 `dist/providers/data`，运行 `gen-model-catalog.mjs` 后再注入。目录的 `engineRootHint` 使用快照内相对路径，避免将 runner 的本地绝对路径写进发布内容；本地正式构建仍由快照生成器生成同源目录。

**最终签名与资产身份**：来源链从仓库 Secrets 解码独立 PKCS12 发布密钥到忽略目录，Gradle 只在发布 variant 读取该文件和密码；密钥不进入 Git、APK、provenance 或 Actions artifact。上传前 `check-apk-signatures.mjs` 检查 v1/v2/v3，并对照提交的 `keystore/pocket-harness-cert-sha256.txt` 指纹。debug variant 使用本机 Gradle debug key，不能覆盖安装发布 APK。来源链的签名预检在构建前验证 Secret 可用，最终 gate 验证实际 APK；草稿任务只搬运已校验的本次构建资产。

草稿写权限任务在校验哈希前，要求目录恰有一个符合来源 ARM64 命名的 APK、provenance.zip、notes.md 和 SHA256SUMS.txt，全部为非链接普通文件；清单必须恰好覆盖前三项各一次，拒绝额外资产、漏项、重复项及含目录的路径。真实发布 shell 的正反例与边界见 [gotchas.md 坑 371](gotchas.md)。

**冷启动预算读数**：`scripts/check-boot-budget.mjs --self-test` 是门禁自身的廉价回归；设备门禁 `--require-real` 必须消费安装包启动后采集的日志。C1 比较的是壳侧首次成功 HTTP 探测观测时刻与 TCP LISTEN 探测观测时刻，两者来自不同轮询（HTTP 启动轮询约 1s；TCP 探测每 500ms），差值包含探针采样量化和调度延迟；C1 超限不能单独归因于同步 compose，需与 C2 和 P1 phase 对读，4000ms 门槛仍按原值判定。event-loop 可能先输出 `loopP99Ms=-1 loopSamples=0`，再在 debounce 收口后输出最终采样；C4 必须从最后一条完整 `[perf] TOTAL` 成对读取两字段，不能把早期哨兵当最终结果。末条哨兵判 FAIL，末条有效样本则按样本数和预算判定。若补丁源改变，先从当前源码重建对应 ABI 快照，再构建/安装并重新采集日志；旧设备日志只能描述产生它的旧安装包，不能证明新快照行为。详见坑 251。

**C4 换尺（2026-10-06）**：C4 的 `loopP99Ms` 原先取自 `perf_hooks` 的 event-loop-delay monitor，而它对「与 `enable()` 同 tick 内开始的同步块」**结构性失明**（设备上一段 2.0s 启动阻塞被读成 11ms；本机 95/500/1500/2000ms 各档一律读成约 11ms）。现改为 P1 **自建、arming 时锚定墙钟基线**的采样器，换尺前后读数不可比。权威预算及样本见 `scripts/check-boot-budget.mjs`：先前单机 n=8 的 3400ms 已被两台 MuMu x86_64、分别串行采样 n=24 的 **7200ms** 取代；完整样本最大值 6260.6ms，单机小样本遗漏了尾部。该阈值是回归哨兵；C1/C4 超限须与 P1 phase、C2 及设备调度共同排查，不能通过只重复成功结果抹去失败。阈值来自模拟器，**真机 arm64 未测**，发布前须补同口径采样。

**本地发布链（`build-release.ps1`）的 gradle 调用必须与开发链同口径（0.14.2-fx-2 修）**：发布链原用**系统 gradle**
+ `--offline --rerun-tasks`，而开发链（`build-apk-013.ps1`）用项目 wrapper 且不带 `--offline` —— 系统 gradle 的依赖缓存里
没有本工程的 AndroidX 产物，离线档下 arm64-v8a/x86_64 组装**必失败**（`No cached version of androidx.webkit:webkit:1.12.1
available for offline mode`，22s 即 break），且该行把 gradle 输出重定向进 `$null`，日志里只剩一句 `APK build failed (…)`。
现统一走项目 wrapper。`build-release.ps1 -Version 0.14.5` 的参数是最终版本名，因此传给 Gradle 的 `versionNameSuffix` 为空；测试构建可显式用 `-VersionSuffix "-preview"`（最终目录/包名为 `0.14.5-preview`），或传完整标签 `-Version "0.14.5-preview"`。脚本基于 Gradle 中的 `0.14.5` 派生后缀，拒绝不匹配的完整版本，避免把 `0.14.5` 再拼到自身后面；派生逻辑由 `scripts/resolve-version-suffix.mjs` 与 Node 回归用例覆盖。Gradle调用示例：`.\gradlew.bat :app:assembleDebug --no-daemon "-PversionNameSuffix=$VersionSuffix"`。**改任何一条链的调用前先问：另一条链是不是这条命令**（详档见坑 194）。

**快照构建入口已收敛为单一链（0.14.5，删除已死的并行 workflow）**：apk 仓原有的 `.github/workflows/build-snapshot.yml`
已删除，连同只服务它的 `docs/ci-snapshot-build.md` 与 `scripts/upload-snapshot-input.mjs`。四路证据：
① 它的输入是 draft release tag `snapshot-input` 的资产，由 `upload-snapshot-input.mjs` 上传，而**全仓没有任何 workflow 调用该上传脚本**（输入源在 CI 里无人维护）；
② 它的触发 `push: branches: ['release/*']` 指向 v0.12.4/v0.12.5 时代的分支——当时只有 `release.yml` 建 draft Release、此后不再创建 `release/*` 分支，该触发已死（`release.yml` 本身也已于 2026-10-15 退役，见本节上方的 Release 快照契约留档）；
③ 功能被 `build-apk.yml` 覆盖且后者更完整——它只走 `inject-snapshot.py` 的**三包注入**，不做引擎 overlay / 引擎补丁 / 语法降级（EXECUTION-MAP 曾自记「仍带坑 63 语义」）；
④ 它**绕过**共享终端组装引擎 `build-apk-engine.mjs`，直接调 Gradle `:app:assembleDebug`。
⇒ 属 §14「测试和 Release 使用不同构建逻辑」「重复而没有新增信息的过度防御」。当时的结论是「快照构建只有两条活链：`build-apk.yml`（自包含，源重建）与 `release.yml`（发布，Build Once → 同 artifact 提升）」；**2026-10-15 后 `release.yml` 也已退役**，当前构建链为 `build-apk.yml` / 它复用的 `build-apk-source.yml`（来源链，当前 arm64）与本地来源链 `scripts/source-build/run-local-source-chain.mjs`。
**本分支只允许来源链构建（AGENTS §4 铁律 9）；将来若需要快照专用产物，走来源链，不要再新建第三条发布链。**
**底座来源**：当前来源链 checkout 使用 `lfs: false`，不拉取 `base/*.tar.xz`；Termux 基座由固定 bootstrap 与官方验签仓库包组装。旧 LFS 缓存/按 ABI 拉取路径已从云端入口删除。
旧版文档把 `lfs: true` 说成 `git lfs fetch --all` 并据历史对象估算下载量，此结论已于 2026-10-07 撤回：checkout v4 实际执行 `git lfs fetch origin <ref>`，普通 Git 的 `fetch-depth: 0` 不证明历史 LFS 全量下载。依据：[官方 command manager](https://github.com/actions/checkout/blob/v4/src/git-command-manager.ts#L352-L357)、[官方调用点](https://github.com/actions/checkout/blob/v4/src/git-source-provider.ts#L186-L193)。当前优化减少无用 ABI 与重复 job 的下载；实际流量收益应以 runner 日志核实。
**云端构建**：两个手动入口共享来源链，具体命令和能力范围统一见文末「GitHub Actions 来源构建入口」。`DSH_APK_DIR=$GITHUB_WORKSPACE` 指向本仓库，不依赖协调仓。

`build-apk.yml` 仅接收 `draft_release` 布尔选项，不接收 `abi`、`suffix` 或 `source_audit`；来源链的目标和后缀由工作流固定。

**CI 权限与正式发布**：构建/PR workflow 的 `GITHUB_TOKEN` 明确只读，checkout 禁止持久化凭据。原 `release.yml` 的快照构建、APK 构建、测试和签名核验均在只读 job 完成、上传 `release-v<version>` artifact，再由独立 `publish` job 只下载同一 artifact 创建 draft Release / 上传资产，写权限仅授予该 job、发布阶段不重新构建或重签资产——**该链已按用户决定整体退役（当时决定不出 Release；2026-10-17 新来源草稿政策见 RELEASE.md §5）**；这条权限纪律仍然适用：任何将来在来源链上重建的发布面，都必须沿用「只读构建 + 独立写权限提升 job + 不重构建不重签」。PR 与来源构建 workflow 的源码 Node 测试使用 `node --test scripts/source-build/*.test.mjs`，新增测试自动进入该测试集。

**APK 三方案签名核验**：最终 APK 必须通过 `scripts/check-apk-signatures.mjs`，并断言 JAR/v1、APK v2、APK v3 均为 true。核验命令显式传 `apksigner verify --min-sdk-version 18`：APK 的 `minSdk=26`，而默认核验会按 26 判断老系统兼容性，可能把只供旧系统使用的 v1 SHA-256 签名报告为 false；API 18 起支持此 v1 摘要算法。此参数只选择核验兼容性下限，不改 APK 内容或签名。仍要求 apksigner 返回码为 0，并保留原始输出、scheme 判定与退出码。

**APK 根目录传递约定**：云端 workflow 与本地来源链都显式传 `DSH_APK_DIR`；`check-runtime-assets.mjs` 必须优先使用该绝对根目录，不能仅凭 `ROOT/dsh-mobile-apk` 猜测协调仓布局。`--require` 仍严格要求该根下 `app/src/main/assets/patched`、快照和 registry 在场；缺件不得 SKIP 或自动生成。 `build-apk-013.ps1` 同样保留前置布局自检测得到的 `$apkDir`，不得在版本解析后重新硬编码 `Root\dsh-mobile-apk`。 发布链临时文件也不得假设 `$env:TEMP` 在所有 PowerShell runner 上存在；跨平台脚本使用 `[IO.Path]::GetTempPath()`。

**来源审计构建（ARM64）**：固定官方目标身份见 `scripts/contract.json` 与 [升级记录](ENGINE-UPGRADE-2026-10-19.md)。不启用 LFS、不读旧 base 快照；第一方由固定源码构建并记录 manifest/commit/hash。Desktop Electron 不属 Android CLI 闭包；使用官方独立编译步骤，无需重写根 manifest。Termux bootstrap 固定 SHA、InRelease 验签及逐 deb 哈希仍执行，native 输入继续分别披露。

**同工作区复跑**：两处源码 clone 可复用，但固定 commit 的 fetch/detach/assert 仍执行；bootstrap 与 NDK 只在固定哈希命中时复用，损坏/半包重下，解包前校验不省略。Harness 阶段从本次 `GITHUB_SHA` 恢复权威 overlay，先复位专用源码 checkout（保留 ignored 依赖），deploy 只清理验证过的专用目标。`source-chain-rerun.test.mjs` 使用本 workflow 的实际守卫和本地假输入覆盖 cache-hit/miss、下载中断、坏字节拒绝解包、依赖保留与清理边界；CI 与本地预检均调用。来源链两次完整运行的证据不得由局部守卫测试代替。

**14 GB runner 的磁盘回收**：标准 GitHub 托管 runner 只有 14 GB 磁盘；来源链封包时同时保留 Harness 依赖树、pnpm deploy 树、Linux rootfs/cargo、NDK、Termux 仓库缓存、解包 stage 和快照归档。2026-10-18 的最终 main run 39113529859 在两个 replica 上都到过 `Free space left: 83 MB`，随后快照检查器把 engine 复制成 reference 时 `ENOSPC`，两 job 同点失败。现在在快照封包与 post-snapshot 检查之后、第一次 `check-dsh-source-snapshot.mjs` 之前运行 `scripts/source-build/reclaim-build-disk.mjs --root "$GITHUB_WORKSPACE"`：只删除封包后不再作为输入的 `engine-deploy`、`linux-build` 非 provenance 产物、NDK、Termux webroot、bootstrap/node deb 解包树和整棵临时 Harness 源树；保留 stage（`check-contract.mjs` 读运行时版本）、`engine-overlay` 源包缓存、`source-build` 报告和 `linux-build/provenance` 上传面。Harness 源树在 snapshot 封包后不再被后续门禁读取；可信 base materialization 刻意不含嵌套 `.git`，因此不能在该路径调用 `git clean`（Git 会向上发现 Pocket Harness 父仓）。每个删除目标先校验真实路径在 `.deploy-tmp` 内，拒绝符号链接目标和已挂载 rootfs；递归删除不跟随树内链接。清理后要求至少 4 GiB 可用空间，否则当场失败而不是等到 ENOSPC。`reclaim-build-disk.mjs --self-test` 覆盖正控、无嵌套 `.git` 时的父仓隔离、树内符号链接不跟随、symlink escape、`--check-only` 与空间下限负控；`cloud-workflow.test.mjs` 另拒绝缺失调用。该修复只清理封包后已失效的临时来源树，不改变快照、签名或 APK 判据；必须用新的 main run 取得最终证据。

**内置插件包名来源**：`inject-all.py` 的 @dsh-android 注入必须以 `package.json.name` 为键，不能用插件目录 basename。`plugins/dsh-linux-bootstrap` 的真实包名是 `@dsh-android/linux-bootstrap`，目录名与包名不同；按目录名注入会写到 `@dsh-android/dsh-linux-bootstrap`，而 profile patch 引用真实包名，产物会在 `check-inject-completeness` 判红（run 39119416887 实测）。回归入口 `scripts/source-build/test_inject_all.py`，覆盖目录名/包名不同的正控和非命名空间、嵌套包名负控。该修正不改变插件目录布局或 profile patch。

**trusted engine-base 命中后的项目组件 provenance**：engine-base 只缓存 Harness 引擎输入，不缓存 `.deploy-tmp/source-build/project-component-provenance.json`，因为它绑定的是 Pocket Harness 当前提交而非 engine cache key。cache hit 会跳过 `build-engine.sh`，所以 `build-apk-source.yml` 在 materialize 后按当前 checkout 的 `GITHUB_SHA` 重新运行 `record-project-components.mjs inputs`；APK build 后的 `outputs` 再从当前 Git commit 和实际 `lib/` 输出复核，输入报告不得从其他 engine-base run 复用。workflow contract test 覆盖 cache-hit 条件、步骤顺序、报告路径和“报告不进入 engine cache”约束。

**来源预检**：`node scripts/source-build/preflight-source-chain.mjs` 当前验证独立仓固定输入和树内合同，不要求 upstream remote 或合并其他仓。先跑 `--self-test` 的真实输入/受控负控；真实预检还校验市场发布字节与补丁、来源单测及地图。缓存缺件时 `--no-network` 明确失败，不伪造通过。

来源流程的 marketplace 用**固定 npm 发布产物**：`curl` 拉 `dshmarketplace-plugin-0.1.7.tgz` → `sha256sum --check` 对照钉在 workflow 里的哈希 → 解包进 `vendor/dshmarketplace-plugin`（**不再从其 `src/` 重建**，也不参与插件源码构建循环）。理由：仓库镜像与全部 market-* 补丁都按发布字节定义（`vendor/dshmarketplace-plugin/PATCHES.md`），重建会用不同工具链产出不同字节并把补丁锚空（0.1.5 时代就是这样，见坑 205；此前靠适配器里一段源码构建专用改写兜着，已随 0.1.7 退役）。随后运行 `node scripts/source-build/apply-source-marketplace-patches.mjs vendor --apply`：这一步**不修改共享补丁器**，适配器只把生成副本的 `HERE` 指回 `scripts/patches`，然后按原参数执行；共享 runner、生成 runner、registry、适配器自身及补丁后产物的哈希写入 `marketplace-patch-adapter.json`。锚点整体失配不需要适配器兜底——共享执行器对「check 为假且 apply 零改动」本就判红并拒报 ALL OK。已登记的移动端补丁（包括 `/api/dshmarketplace/*` 鉴权）先施加到解包产物，随后 API 路由门禁才能检查最终注入文件。artifact 的 `marketplace-source-provenance.json` 记录发布 tarball URL 与哈希、包版本、补丁 registry/实现哈希及补丁后 lib 哈希。

Harness 与 vendor 源码均跟随当前官方目标；`prepare-harness-vendor-overrides` 审计源码而不覆盖为旧 Cordis。`reconcile-harness-vendor-lock` 按目标 pin 核实实际 lock；工作区链接仍禁止递归 copytree 跟随复制。

来源构建还会从本仓九个带 `package-lock.json` 的插件/组件目录执行 `npm ci`。`check-package-lock-roots.mjs` 在 PR 与来源构建的早期步骤核对各目录 `package.json` 与锁文件根声明中的名称、版本及四类依赖，发现镜像后的旧声明就立即报错，避免完成 Harness 和 Termux 构建后才在插件安装阶段失败（坑 196）。锁文件更新后还应对受影响目录运行 `npm ci --dry-run --ignore-scripts --no-audit --no-fund`，因为根声明一致不能证明整份依赖图有效。

`check-android-native-runtime-packages.mjs` 对部署树中的 `.node` / `.node.wasm` 逐文件计数、取哈希，并只接受已审计包族。固定 Harness 当前依赖图还带入 trycua、ubjs、sherpa-onnx 与 node-addon-require-builtin 的 Linux GNU 原生文件；它们作为跨平台部署的外平台 payload 记录，不视为 Android 绑定。新增版本、不同架构路径或未知包族继续拒绝；匹配用例在 PR 与来源构建入口运行（坑 197）。

快照构建器沿用boot-pending标签调用当前dsh-app-boot的auditStartupEntries回归，required pending/failed致命、optional第三方告警；该构建内置检查不是本轮外部验收。当前验收证据见协调仓重构台账；该内置检查不替代设备三层验收。

`check-dsh-source-snapshot.mjs` 的内置预设载体断言与权威门禁 `check-engine-overlay.mjs` 的 CARRIERS 同源，清单在 `scripts/source-build/preset-carriers.mjs`：载体是 `agent-preset/skills/` 与 `web-app/presets/`（0.1.7 把 `dsh-agent-presets` 拆成 agent-preset + agent-preset-registry 后的新形态），判据是目录在场且递归文件数 ≥ 1。`preset-carriers.test.mjs` 读权威源文本双向比对两侧载体集合——权威源重锚而本侧没跟上的话，判红落在秒级的 PR 门禁上，而不是四十分钟后的云端构建（坑 200）。

来源链在构建期会把 `@deepseek-ai/*` 从 `scripts/snapshot-config/engine-overlay.json` 摘除（否则快照构建器会按登记表回拉上游发布版 tarball，整目录覆盖已注入的源码产物），摘除清单记进 `source-build-policy.json`；APK 步骤先由 `scripts/source-build/restore-overlay-pins.mjs` 把这份清单并回去，再跑门禁集——`check-contract.mjs` 第 7 节正是按它定运行时版本、并判 profile 里引擎包 insert 行是否与运行时同版（该门禁在拿不到 semver 时 SKIP，旧链因此从未真判过）。还原记录进策略 provenance，退出 trap 覆盖回原文件（坑 201）。

**设备验证链路**（产品验收使用 ARM64 Android 设备；MuMu x86_64 竖屏 `127.0.0.1:16416`、横屏 `127.0.0.1:16384` 不能安装产品 APK）：
- 安装：`adb -s <serial> install -r -t out\v<版本>\pocket-harness-v<版本>-arm64.apk`（发布包使用固定 Pocket Harness 签名；**指纹变更触发 refreshSnapshot 全量重解压（真机 ≈2-4 分钟，勿在解压中杀进程——中途杀进程看门狗会拿半解压运行时拉引擎，见坑 37）**）。
- 引擎探活：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`。
- WebView 调试：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `forward tcp:29225 localabstract:webview_devtools_remote_<pid>`（**每次重启 pid 变**）→ CDP ws 连接后 Runtime.evaluate 驱动（例子脚本见 `.deploy-tmp/cdp-*.mjs`；断言注意 input placeholder 不在 innerText 里）。
- 远程 RPC（测试面）：POST `/api/<method>`，body 必须全信封 `{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}`；`session.prompt` 拒绝 live 会话（被 UI 打开的）——直接 API 测代理需先用 session.create 建全新会话。
- **构建前核对 ABI（见坑 18）**：产品仅有 ARM64 APK，必须安装到 ARM64 Android 设备；MuMu x86_64 仅可用于不涉及产品安装的通用脚本开发，不能作为本产品的设备验收环境。

## 3. 历史本地链与环境记录（已退役；勿用于生成 APK）

> 本节保留历史环境实测与旧脚本细节，便于排查既有证据。当前只允许使用 AGENTS.md §2 的 ARM64 源码来源链；旧本地/协调仓脚本不得产出、归集或发布 APK。

### 3.1 环境矩阵（先对号入座）

| 组合 | 快照构建（node scripts\build-snapshot-013.mjs） | 打包/门禁（pwsh scripts\build-apk-013.ps1） | 设备验证 |
|---|---|---|---|
| Windows + WSL | **必须在 WSL 跑**（Termux 源/依赖闭包需 Linux；见 3.4） | PowerShell 直跑 | ADB 真机 或 MuMu |
| Windows 无 WSL | **不可本地构建快照**（跳过 3.2 步 2，用已发布快照/CI 产物） | 可 | MuMu（debug 包默认 x86_64 快照可用） |
| Linux / macOS | 直接跑（无 WSL 层，路径用 `/`） | 直接跑 | ADB 真机（arm64 需匹配快照） |
| 无真机 | — | — | MuMu x86_64 竖屏 `127.0.0.1:16416` / 横屏 `127.0.0.1:16384`（装 x86_64 包） |
| 有真机 arm64 | — | — | vivo V2425A（**必须装 arm64 快照包**，坑 18） |

### 3.2 新环境起步流程（克隆 → 首包 → 装机验证）

1. **取代码**：clone 协调仓库（主分支 `main`）；壳子仓库 `dsh-mobile-apk/` 是**独立 git**（主分支亦 `main`），按需 clone/关联；上游 `dsh/` 只读。
2. **构建快照**（仅 Windows 需 WSL）：`node scripts\build-snapshot-013.mjs <arm64|x86_64>`——Termux 源装配 + TARGETS 预装 + pnpm + 权威 cordis patch 覆盖 + 瘦身 + 归档（产物 snapshot.tar.xz + snapshot.sha256）。
3. **一键打包**：`pwsh -File scripts\build-apk-013.ps1 -Suffix ""` → `out\v<版本>\pocket-harness-v<ver>-<abi>.apk`；门禁失败会中断并提示（清单见第 2 节）。
4. **ABI 核对（坑 18）**：`aapt dump badging <apk>` 看 native-code，或解快照 tar 读 `usr/bin/node` 的 ELF e_machine（**62=x86_64，183=arm64**）——与目标设备一致再装。
5. **装机**：真机 `adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore，坑 10）；模拟器 `adb -s 127.0.0.1:16416 install -r -t ...-x86_64.apk`。**首装/指纹变 → refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器 ~8 分钟），勿杀进程（坑 37）**。
6. **验证**：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`；WebView CDP 与 RPC 信封写法见第 2 节。
7. **插件依赖（门禁真检的前提，2026-09-22 补）**：聚合门禁会**真加载**插件构建产物（`check-tool-output-schema` 动态 import 每个插件入口、`check-protocol-v2` 跑 manage 的 lib 产物），故这些目录本机必须有 `node_modules`：
   - `plugins/dsh-android-*/`（`manage` 的 `@deepseek-ai/dsh-tools` 同时是引擎校验器来源，缺席时该门禁整体 SKIP）；
   - `dsh-shell-termux/`（`plugins/dsh-android-linux-env/lib/index.js` → `@dsh-android/dsh-shell-termux` → 四个 peer 依赖 `@deepseek-ai/dsh-bash-local` / `dsh-shell` / `dsh-subprocess` / `dsh-sandbox`，具体版本以本包 `package.json` 为准。**这一个目录没装，聚合链会在第 6 条门禁处中止，后面 20 多条一条都不跑**）。
   装法（registry 已配 `registry.npmmirror.com`，各目录 `npm install` 即可）：

   ```powershell
   # 协调仓根与 dsh-mobile-apk/ 两棵树各自独立，都要装
   Get-ChildItem plugins -Directory | ForEach-Object { Push-Location $_.FullName; npm install; Pop-Location }
   Push-Location dsh-shell-termux; npm install; Pop-Location
   ```

   未装时的行为是**如实 SKIP 并计数**（`SKIP(#n) 宿主缺 peer 依赖：…`），`--require`（本地链/发布链）下判红——不允许用 SKIP 冒充绿。

### 3.3 改动流程规范（改哪个仓库、改完必做三件事）

| 改动面 | 落点 | 约束 |
|---|---|---|
| 壳层（桥/服务/看门狗/快照/权限） | 壳内 `app/src/main/java/com/snoworwind/pocketharness/` | 提交在壳子仓库独立 git |
| 快照内容 / assets | 壳内 `app/src/main/assets/` | `snapshot.tar.xz` + `snapshot.sha256` **必须成对换**（坑 18） |
| 构建链 / 门禁 | 协调根 `scripts/` | 改后跑完整门禁；命令变更须同步本文档 |
| 安卓能力插件 | 协调根 `plugins/dsh-android-*` | `npm run build` 通过；重装配须「权威 patch 覆盖 + 冷启动」（坑 19） |
| UI 注入层 | 协调根 `dsh-client-ui-responsive/` | `npm test && npm run build` |
| 执行器 / 页面兼容 | `dsh-shell-termux/`、`dsh-host-web-compat/` | 装配进快照 |
| 上游引擎 | 协调根 `dsh/` | **禁改**（只读参考）；一律以补丁/插件/壳侧适配（vendor/ + PATCHES.md） |

**每次改动关闭前必做三件事**：
1. **文档同步**：本文件描述失真处当场更新 + 文末「更新记录表」登记（时间/版本/内容/更新者）。
2. **GPL 合规**：新增依赖登记 `scripts/third-party-licenses.json` + `THIRD_PARTY_NOTICES.md`（80 组件矩阵）；copyleft 全文三形态在场（快照 `usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`）；`check-third-party.mjs` 不过即拒打包（第 7 节）。
3. **PR 规范**（pr-guidelines）：标题 `<type>: <描述>`（`fix:`/`feat:`/`docs:`/`chore:` 等，type 与主标签一致）；每个 PR 1-3 个标签；破坏性变更 type 后加 `!`。
- **禁用 emoji**：提交信息、PR 标题/描述、文档一律不使用 emoji（以文字描述代替，如「机密」而非锁形 Emoji）。存量文档中的 emoji 随触碰逐步清除。

### 3.4 环境差异点速查（踩坑对照）

| 差异点 | 现象 / 规则 | 出处 |
|---|---|---|
| Windows Node 26 与 UI 测试 | Vitest 2/jsdom 的 localStorage 在当前 Node 26.5.0 worker 中为 undefined；不要删用例或用 storage mock 掩盖。使用本机来源链的 Node 22.22.1、相同输入和完整兄弟 vendor 布局复核可全部通过；保存失败与复核日志，隔离包目录内不要挂整个 vendor（会误收集 Node test 文件） | 坑 342 |
| WSL（Windows 特有） | 快照构建必须在 WSL（tar 解压/符号链接/relocate 需 Linux 语义）；Windows 直读 WSL 9p 文件 = EACCES，校验走 `wsl tar -tvf` 视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤 | 坑 6 |
| ADB 真机特有步骤 | Pocket Harness 发布 APK 用同一独立证书才能覆盖升级；本地 debug 包签名不同。配对走真实 `adb pair`、码值只进 argv（第 4 节 AdbState.kt）；CDP 每次重启 pid 变 | 坑 10/14、第 2/4 节 |
| run-as 限制 | run-as 裸环境无 termux-exec 钩子 → `not executable: 64-bit ELF` / `CANNOT LINK` 是**假错误**；验证快照内二进制须带全套引擎 env（`LD_PRELOAD` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`） | 坑 22 |
| PowerShell 转义 | 双引号内 `$var` 本地展开（引号地狱）；二进制经 `adb exec-out`/push 传输 | 坑 8 |
| ABI 匹配 | debug 包默认 x86_64 快照，装 arm64 真机必崩；构建/安装前核对（3.2 步 4） | 坑 18 |
| 工作树行尾噪声 | `git status` 的 ` M` 与 `check-patch-mirror` 的「仅行尾差异」WARN 常来自 autocrlf（一侧检出为 CRLF），**不是**内容漂移。先逐字节复核（`cmp a b` / `git diff --ignore-cr-at-eol`）再决定要不要动文件，别按噪声改内容 | 铁律 5/6 |

## 更新记录表

| 日期 | 版本 | 内容 | 更新者 |
|---|---|---|---|
| 2026-10-05 | 0.14.5 | 标明当前重构真值入口和 APK 版本码；记录三签门禁与 release 版本后缀解析规则。 | Codex |
| 2026-10-05 | 0.14.5 | 补充冷启动预算日志的来源要求与 `loopP99Ms=-1` 哨兵判定；详见坑 251。 | Codex |


### engine 补丁变更后的快照重建（2026-10-06）

`build-apk.mjs --snapshot <tar>` 复用输入快照，后续插件注入不重新应用 engine 补丁。修改 engine 补丁后必须先运行 `build-snapshot-013.mjs <abi>`，再构建 APK。`check-perf-instrumentation.mjs --require --snapshot <tar> --abi <abi>` 现在读取归档实际 P1 模块并拒绝缺 phase 的旧版本。版本号、文件时间及 APK/设备快照指纹一致只能证明所用产物一致，不能证明它包含当前补丁。装机后仍需核对实际 phase 日志并重新执行真实冷启动门禁。

## Android SDK 许可资产

`third-party-licenses.json` 除 dpkg 矩阵还登记 Shizuku api/provider/aidl/shared 13.1.5（官方固定版本 POM 的 MIT 许可）。`check-third-party.mjs` 校验实际 Gradle 版本与固定 MIT 文本 SHA256；本地和 portable 构建门禁从实际快照生成 notices，再将 `LICENSES/*.txt` 和 notices 复制到 `assets/licenses/`。缺文本、改文本、未登记版本或无法核实依赖必须拒打包；PR 与本地入口跑 `check-third-party.test.mjs`。最终包另需检查两个 ABI 的实际 assets，源码门禁不替代它。

## GitHub Actions 来源构建入口（2026-10-17）

本仓的 `build-apk` 与 `build-apk-source` 都运行同一条 ARM64 来源链，不再提供旧 LFS 底座构建选项。手动运行时必须选 `main`；历史 `security/hardening` 只作为迁移来源记录。CLI：

```bash
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
```

成功后从该次 Actions 的 Artifacts 下载 `pocket-harness-arm64-source-<commit>`，内含 APK、SHA-256 和列举的来源证明文件；上传显式包含隐藏目录内的证据，且不上传整个临时目录。当前仅 ARM64、版本后缀固定 `-source`，不支持 x86_64 或双 ABI，草稿发布见 [RELEASE.md §5](../RELEASE.md)。云端任务上限 180 分钟，沿用来源链全部测试与产物门禁。入口回归为 `node --test scripts/source-build/cloud-workflow.test.mjs`，含旧链与条件分流的受控负控。该 L1 入口改动未做设备验证，云端成功也不等于设备验收通过。

来源链预检的 provenance 夹具必须隔离 CI 仓库环境，复验时带 `GITHUB_REPOSITORY` 与 `GITHUB_SERVER_URL` 跑工作流同一组 Node 测试；否则本地通过不足以覆盖云端身份优先级。根因及修复见 gotchas.md 坑 347。

**2026-10-17 云端核验快照**：Actions 已由用户重新启用。`81dc50c` 的 [源码构建 38935633493](https://github.com/snoworwind/dsh-mobile-apk/actions/runs/38935633493) 已通过原失败的输入预检、签名工具预检与固定来源检出，记录时正在编译 Harness；尚未取得最终 APK/上传成功结论。后续状态以该运行页面为准。旧禁用与夹具故障分别见坑 346、347。

**云端 npm 缓存隔离**：来源工作流在依赖预检前覆盖 npm 缓存到 `$RUNNER_TEMP/dsh-npm-cache`，否则 `dsh-shell-termux/.npmrc` 的 Windows 绝对路径会被 Linux npm 落入组件树，并在 provenance 输出复核时报未跟踪输入。根因及反证见 gotchas.md 坑 350。


Linux bootstrap 本地安全分叉（2026-10-18）：`check-vendored-linux-bootstrap.mjs` 保留 MANIFEST 的上游摘要，用 LOCAL_PATCHES 单列 `src/asset-bundle.js`、`src/index.js` 与 README 的本地摘要，并要求与 `package.json.dshVendor.localPatches` 一致；新增的 package-lock / build scripts / client bundler 作为本仓来源输入独立钉哈希。不能把本地修改改记为上游原样。运行 `node scripts/check-vendored-linux-bootstrap.mjs --self-test` 验证漂移拒绝；构建客户端新增的 `esbuild` 依赖见 DEPENDENCIES.md。

来源签名调用链：build-apk 的 source-build/source-draft 均显式 secrets: inherit，草稿 build 再传给 build-apk-source；只读 token 与写 Release job 的权限边界不变。回归见 cloud-workflow.test.mjs 的逐边删除传递负控。

来源链分支授权：实际 APK 构建只允许 main。云端第一步检查 github.ref；本地包括 --from/--only/续跑都要求当前 attached main，--list/--dry-run 不构建可用于候选审查。

离线 Linux 资产兼容验收：npm test（plugins/dsh-android-linux-env）包含生产 host/bootstrap/runtime 的禁网联测和真实 GNU tar 根条目、链接负控；需 POSIX tar/xz。该测试只替代原生 ARM64 执行器，不能作为最终 APK 或设备验收。

## 签名前独立双构建

当前云端来源链：两个 build-arm64 replica 从同一提交、全新 runner 各自构建，只有临时签名证书；verify-arm64 不执行产物，只比较实际 APK 条目、hard manifest 与 v3 快照语义；sign-arm64 等验证通过后才读取正式 PKCS12 Secret，使用固定生产证书 pin 验证三签并更新 APK 摘要；最终来源 artifact 才允许进入草稿准备。本地 run-local-source-chain 仅跑 build replica，GITHUB_ENV 的四个白名单构建变量在步骤间传递，临时签名 APK 明确禁止交付。自测入口 compare-independent-builds.mjs --self-test 与 sign-source-artifacts.mjs --self-test。共用上游或 runner 环境失陷仍是信任边界；真实双构建结果必须单独取得。

bootstrap 的 package-lock.json 与 package.json 一样属于逐字节来源输入，.gitattributes 禁止 autocrlf；check-linux-sources --self-test 用实际 Git checkout 和删除属性负控证明这一点，不能按本机 CRLF 字节重封批准摘要。

### Linux 插件启动依赖（2026-10-18）

插件注入只携带 lib、package.json 与其**自身**的运行时依赖闭包 `node_modules/**`（不再只登记 engine-overlay.json 的 vendorTop——那只落在引擎树，profile 路径解析不到；见坑 436）。`inject-all.py` 从每个插件 `package.json.dependencies` 收集传递闭包并平铺复制到该包内，`check-inject-completeness.mjs` 的 C1/C2 从注入后 tar 校验闭包与 bare import 可达性。回归命令：`python3 -m unittest scripts/source-build/test_inject_all.py` + `node scripts/check-inject-completeness.mjs <注入后 tar>`；overlay 登记与许可清单仍须保留。浏览器 bootstrap 只注入 slots，通过既有鉴权 HTTP 路由调用引擎服务；不得跨进程注入 linuxBootstrap。

包名迁移后的开发与验收脚本以 `com.snoworwind.pocketharness/com.snoworwind.pocketharness.MainActivity` 启动，不能从 applicationId 推导类名。回归入口 `node --test scripts/tests/android-identity.test.mjs scripts/verify-screen-scope-matrix.test.mjs` 已接入 PR Gate。软链别名和绑定判据的迁移根因见 gotchas 坑 440。

引擎 0.2.1-rc.2 来源链原生登记：Sharp 本体/Linux payload 固定 0.35.5，Android 仍使用已核对 loader 的 @img/sharp-wasm32 0.35.3；node-addon-require-builtin Linux payload 增补精确 0.1.9，不接受任意新版本。原始根 manifest 在编译前只读复制，归集缺件仍阻断。失败与复验记录见 ENGINE-UPGRADE-2026-10-19.md。

## PR Gate 变更分类（2026-10-19，2026-10-20 收紧口径）

`scripts/ci/classify-changes.mjs` 按 changed paths 输出 `engine/termux/linux/plugins/app/build/gates/apk/docs_only/full`。PR Gate 的 `changes` job 用它决定跑哪些 job。

分层口径（公开仓、改动一律走 PR、`main` 已启用分支保护；合并提交的树已被同一 HEAD 的 PR run 验证过）：

- `apk=true` 才跑 Kotlin 编译。**`apk` 的含义是「该改动可能改变 Kotlin 测试观察到的内容」，不是「碰到了构建系统」**：`.github/**`、`scripts/ci/**`、通用 `scripts/source-build/**` 只置 `build`，不再置 `apk`。这条收窄由 `classify-changes.test.mjs` 的不变量用例守住——Kotlin 源码一旦 `File()` 读取这三棵树，测试立即判红，逼分类器同步改回。
- `docs_only=true` 时跳过整个 `static` job（24 步全是代码/构建契约，文档改动不可能改变它们）；冲突标记与敏感信息扫描独立成 `docs-hygiene` job 始终运行，且把扫描面扩到 `docs` 与 `.github`。
- **未知路径、空 diff 仍 fail-safe 到 `full`**，宁可多跑不误跳过；`static` 用 `if: always() && ...`，分类 job 失败（输出为空）时仍按全量跑。Kotlin 编译同样只在分类**明确为 `false`** 时跳过（`always() && apk != 'false'`），分类失败时照跑而不是静默跳过。
- 触发面只有 `pull_request`：删掉了 `push: branches: [main]`，合并提交不再把同一棵树重验一遍（直接 push main 已被铁律 4 禁止）。并发组 `pr-gate-<PR号>` 开启 `cancel-in-progress`，连续 push 不再叠加跑完。

分类器单测 `node --test scripts/ci/classify-changes.test.mjs`（含「Kotlin 不读 workflow/source-build」不变量）。

## 本地门禁（2026-10-20，CI 的快速自查与离线回退）

`node scripts/ci/local-gate.mjs` 在本地复现 CI 的同一套检查，CI 可用时用于推送前自查，配额或网络不可用时即合并判据：**步骤不另维护清单，直接读 `.github/workflows/pr-gate.yml`**，按同一套 job 条件（`docs-hygiene` 恒跑、`static` 除文档改动、`compile` 仅 `apk`）在 gate 镜像里执行同样的 `run:` 块。workflow 增删门禁时本地自动跟随；`local-gate.test.mjs` 用计数钉住这个契约。

- `--mode auto|container|native`（默认 auto：容器运行时可达就用容器，否则回退 native）。三种宿主的能力矩阵：

  | 宿主 | 推荐 | 能跑 Kotlin | 说明 |
  |---|---|---|---|
  | macOS / Linux / Windows + Docker | `container` | 是 | 钉住的 Linux 环境，与 CI 同构 |
  | Windows（无 Docker） | `native` | 否 | 需 Git Bash（bash 5）、node >= 22.15、GNU tar；Kotlin 必须显式 `--no-kotlin` |
  | Android / Termux | `native` | 否 | 无容器运行时；同上，Kotlin 必须显式跳过 |
  | macOS 原生 | 不推荐 | 否 | 系统 bash 3.2 无 `mapfile`、node 20 无 `zstdCompressSync`、bsdtar 不认 `--sort=name`；预检会直接拒绝并给出清单 |

- 镜像 `scripts/ci/gate-image/Dockerfile`（tag `pocket-harness-gate:24.04`）钉 node 24.21.0 / python 3.12.15 / JDK 17 / Android SDK 36，首次运行构建约 2.5GB。**必须 linux/amd64**：Google 的 Linux build-tools 只有 x86-64，arm64 镜像里 `aidl` 跑不了；Apple Silicon 上走 Rosetta，与 CI 的 x64 runner 一致。
- 容器挂载用 `--mount` 而非 `-v`：Windows 的盘符路径与含空格路径只有前者可靠。步骤计时用 `node -p Date.now()` 而非 `date +%s%3N`（BSD 与 Termux 的 date 不支持 `%N`）。
- **native 模式缺件即失败关闭**：选中 Kotlin 而宿主没有 JDK / Android SDK 时不会静默跳过，必须显式 `--no-kotlin`；证据里记 `mode` / `platform` / `kotlinIncluded`，PR 可据此标注未覆盖的层。
- 工作树必须干净（证据绑定 HEAD 树），否则 exit 2；`--allow-dirty` 可覆盖但会在证据里记 `dirty: true`。
- 证据落 `.deploy-tmp/local-gate/<tree12>.json` 与同名 `.log`：commit、tree、base、分类结果、逐步骤 rc/耗时、工具链钉值、verdict。`--dry-run` 只列将跑的步骤。
- 镜像内的 `/workspace/local.properties` 以只读挂载覆盖为 `sdk.dir=/opt/android-sdk`，宿主的 macOS SDK 路径不会漏进容器，仓库文件也不被改写。
- Gradle 与 pnpm 缓存用命名卷 `pocket-harness-gate-gradle` / `pocket-harness-gate-pnpm` 复用，热跑显著快于冷跑。

**CI 开关**：`pr-gate.yml` 的每个 job 都带 `vars.PR_GATE_MODE == 'on'`，仓库变量当前为 `on`（2026-10-20 起）。变量未设置时全部 job 跳过、PR 上只显示 skipped，可在配额或故障期间临时静默而不产生红色噪声。

## 分支保护与合并策略（2026-10-20）

仓库已公开，`main` 的分支保护在远端启用；本文只记录口径，不改远端设置。

| 项 | 值 | 说明 |
|---|---|---|
| 必须走 PR | 是 | 直接 push 返回 `protected branch hook declined` |
| 必需审批 | 0 | 单人仓，无法自我批准 |
| 必需状态检查 | 变更范围分类 / 冲突标记与敏感信息扫描 / 静态门禁与源码回归 / Kotlin 编译门禁 | docs-only PR 的两个 job 为 skipped，实测不阻塞合并（`mergeStateStatus=CLEAN`） |
| 分支必须最新 | 是 | 合并前需与 `main` 同步 |
| 管理员同样受限 | 是 | 紧急情况用 `gh api -X DELETE .../branches/main/protection` 临时解除 |
| 强推 / 删除分支 | 禁止 | 与铁律 10 一致 |
| 合并方式 | 仅 merge commit | squash/rebase 已关闭，与铁律 11 一致 |

> 2026-10-20 实测教训：API 里 `required_pull_request_reviews: null` 等于**关闭**「必须走 PR」，而状态检查只约束 PR、不拦直接推送。首次配置正是这样漏掉 PR 要求，一次直接 push 落到 `main`，随后用回滚 PR 纠正。见 gotchas 坑 456。

## Engine 构建复用（2026-10-19）

engine 的 checkout/upstream/overlay/patches/build/deploy 步骤集中到 `scripts/source-build/build-engine.sh`；APK 来源链与本地来源链执行同一脚本（本地链按 `run:` 原样跑，不再依赖被跳过的 `uses:` 步骤）。后续 `build-base` 直接复用该脚本与产物，不另写第二套 engine 构建。

### pi-ai 目录身份（2026-10-19）

`gen-model-catalog.mjs` 读取厂商条目声明的 `id`，不能把 pi-ai 1.1 的 `chat:<id>` 索引当成模型 id。构建后用真实生成目录跑插件测试；最小夹具不能代替这一层。根因及负控见 `gotchas.md` 坑 450。

## Engine base 复用（2026-10-19）

`build-base.yml` 只跑 engine：`engine-base.mjs plan` 固定 key、`build-engine.sh` 构建、双 replica 各自 `capture`，`compare` 对实际输出树逐文件比对后才发 `base-lock.candidate.json` 并写 cache。`build-apk-source.yml` 用同一 key 恢复；命中则 `materialize`，未命中且锁可信时失败关闭，无锁时才从源码构建。`base-lock.json` 是仓内信任根；base 不含 APK、签名密钥或项目插件产物。

两条 workflow 的 cache `path` 必须逐字相同：`build-base.yml` 保存 `.deploy-tmp/base-cache`，来源链也必须从该路径 restore 并执行 `materialize`。Actions cache version 包含缓存路径和压缩工具；cache key 相同但路径不同仍会 miss。回归由 `node scripts/source-build/engine-base.mjs --self-test` 与 `node --test scripts/source-build/engine-base-workflow.test.mjs` 覆盖，后者含跨 workflow 路径错配负控。

实跑状态：PR #51、#61、#62、#63、#64 已合并；main `4e14d68` 上 build-base run 39357008785 的独立双构建、完整 tree compare、cache 保存成功，锁 key 为 `engine-v1-941e395d…7a28`。真实候选在 Linux gate 容器通过 `materialize` 与 345 packages / 2435 links 检查。run 39360009635 的两路 replica 均实际 cache hit 且 `materialize` 通过；PR #64 用受树回执保护的 `harness-vendor-lock-reconciliation.json` 固定上游 Harness 来源身份，修复缓存源码没有嵌套 `.git` 时 Git 向上误读 Pocket Harness HEAD 的问题。main run 39361687578 又证明 Termux base 与离线 Linux 资产都能通过，但两个副本在 runtime snapshot 的 `pi-toolcall` 行为门禁因缺少 `partial-json` 同步失败，Release job 按依赖关系跳过，没有创建草稿。根因是 cache hit 跳过 `build-engine.sh` 后 snapshot builder 仍读取仓库原始 overlay；修复由 `restore-effective-engine-overlay.mjs` 对原始 overlay 哈希、源码注入清单与 vendor pin 回执逐项核验，再在 snapshot 前恢复有效 overlay；恢复前的 effective overlay 与 policy 均保留独立输入快照，连同回执显式进入 APK provenance，哈希可从交付证据复算。PR #65 的 overlay 恢复、PR #66 的安全目录回收、PR #67 的当前提交组件 provenance 刷新均已在 main 来源链 run 39374235296（提交 `9ebe0fc1589a070cb2ee12417f27d89236f7153a`）通过实测：primary/reference 完整构建成功，独立 APK payload 比对、隔离生产签名、证据 prepare 和 Draft + prerelease 创建均成功。下载后复核资产 SHA-256、APK 与 provenance ZIP 完整性、APK 内快照摘要、独立重建证明、上游 Harness pin、overlay restoration 哈希与签名证书 pin 均一致；本候选按用户要求未做设备验证，公开前仍须补 ARM64 真机三层验收。详见 [ENGINE-BASE-2026-10-19.md](ENGINE-BASE-2026-10-19.md)、[坑 459](gotchas.md)、[坑 460](gotchas.md)、[坑 461](gotchas.md)、[坑 462](gotchas.md) 与 [坑 463](gotchas.md)。
