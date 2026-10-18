# 第二轮安全发现修复记录

基线 `0571fd2`，分支 `security/hardening`。用户本轮要求修复坑 376–392；[原审计](SECURITY-AUDIT-2026-10-17-R2.md) 保留发现时事实。源码实现、宿主测试与设备验收分别记账，不能据代码修改宣布验收关闭。

## 实现与兼容变化

| 坑位 | 修复与判据 | 边界 |
|---|---|---|
| 376 | ScreenScopePrefs、RootGrant、RootAccess 不再从磁盘恢复授权，使用壳进程内存；冷启动回到 virtual-only、root 无同意、su 未检测 | 重启需重新授权。不是同 uid 任意代码执行的技术沙箱；直接 su、进程注入等仍取决于平台与 Root 管理器隔离 |
| 377 | 敏感桥开启须原生确认及 Android 系统锁屏凭据认证；未接线、取消、超时、非前台、未设凭据均拒绝 | 撤销直接生效。网页不能提供系统认证结果；完整设备流程待验 |
| 378 | 中继占用 32 个流槽位前验证进程随机 relay cookie/header；单 selector 限 128 个未认证连接、16 KiB 头、绝对 2 秒截止，到顶淘汰最老未认证连接 | 原生 HTTP、mux、WebView 接凭据；通用本机网络洪泛不在可用性保证内。40 个未认证连接的 instrumentation 负控已加入，未执行 |
| 379 | 通知动作只持不可变 getActivity；原生确认并认证系统凭据后签发内存一次性许可，receiver 消费许可，旧广播 PendingIntent 不能直接应答 | 回复在原生界面输入；无凭据请打开应用作答。通知监听应用只能请求确认界面，不能直接批复 |
| 380 | market-install-approval-R2 补丁要求每次模型安装都 ask；身份缺失、目录缺项、网络/钩子错误 deny，不回落 allow | riskFlags 仅展示。执行器与 vendor 同步，沿用引擎审批通道 |
| 381 | bootstrap 发现、安装、重装都强制批准清单验证；宿主固定清单摘要作为批准策略 | **功能阻塞**：原 latest API 只读查询返回 404，没有可批准真实清单，源码 pin 列表为空，安装失败关闭。不能声称 Linux 功能恢复；取得可审查资产后须源码评审加入摘要 |
| 382 | 四处 response.text 改为有界流读取；使用固定上限缓冲，不保留逐块对象列表；目录默认 8 MiB、主动探测 1 MiB；models.dev 30 秒 deadline、禁止 redirect | 解码字节超限取消 reader，旧缓存可沿用。text-only 注入离线适配器仅供宿主夹具，生产 fetch 使用流 |
| 383 | public privilege/status 只读缓存，移除 shizukuChannelProbed，不占控制队列 | 初次无事实保持 unknown，刷新由受鉴权控制路径负责 |
| 384 | nonce 限 1–64 位十六进制再拼入单引号参数 | 对应 BigInteger(256) 非定长输出；引号、换行、命令替换不能进入命令 |
| 385 | 从摘要绑定源码 tarball 重建参考包，独立重放登记补丁，核对快照 JS/JSON/WASM/native 载荷及解析入口，并检查 pnpm 实体副本与受限链接 | 校验器、源码导出清单、Git 对象库和构建环境仍须可信；不能抵抗能重写检查器的任意构建代码。**曾尝试把源码包 payload 摘要钉进 Git 并在云端强制，验证失败后撤回**（见下节）：构建产物跨环境不可复现，payload pin 目前无法满足；「缓存 + 清单 + 快照同时篡改」仍是未关闭缺口 |
| 386 | workflow 初始输入及快照配置准备时从 GITHUB_SHA 重建 preinstall，再生成受控有效配置 | 续跑目录中的 preinstall 不再是权威 |
| 387 | pnpm/Canvas 用源码固定 SHA-512，npm 仅用官方 registry | 固定值从官方端点核对；缺 pin、下载失败、摘要不符拒绝 |
| 388 | deb 缓存复用同时验签名索引 SHA-256 与 size；坏缓存先移除，下载失败阻断；pnpm/Canvas 每次解包前复验 pin | 存在性与同体积不再作为内容证据 |
| 389 | Gradle 8.11.1 固定官方 distributionSha256Sum | 旧本机 Gradle 缓存仍属受信构建环境 |
| 390 | native 文件点击仅识别显式 data-dsh-file-path，不从 title 推断路径 | 工具行会话路径分支保留；旧未标记标题按钮交给上游处理 |
| 391 | 不再以 HTML 的 x-dsh-pick-token 子串决定整层注入；static fallback 纳入语法校验 | 真实 tapIndex 变换反证子串不能抑制脚本；原可利用性 HYPOTHESIS 不追认成设备利用复现 |
| 392 | 路径要求有效 session，realpath 后限所属 cwd；拒绝跨会话猜解、绝对路径及链接外逃 | 缺 session 旧调用显式失败，不再提供全盘存在性查询 |

## 验证账本

本机日志前缀 `.deploy-tmp/security-r2-`。沙箱本机联网和临时目录 rename 失败的用例在正常本地环境原样重跑，未改测试放过失败。

日志为本机证据，不是远端已可取得的 CI 资产。源码/命令可由本分支复跑；本轮没有新的云端来源构建 run，也没有发布结论。

- model-capability 最终全量 175 项通过，含流上限与 32 MiB 堆预算下大量微块正反证：`security-r2-model-final.log`；三份 npm 官方归档实际下载流的 SHA-512 均与源码 pin 相符，记录 `security-r2-official-pins.json`。
- manage 82 项通过：`security-r2-manage-tests.log`。
- bridge 159 项通过：`security-r2-bridge-tests.log`；linux-env POSIX 全量 64 项通过：`security-r2-linux-posix.log`。Windows 最后一轮业务断言通过但清理临时目录出现 ENOTEMPTY，原始失败保留 `security-r2-linux-final.log`，不把该轮写为通过；POSIX 复核未改用例。
- host-web-compat Linux 59 项与真实注入 smoke 通过：`security-r2-host-linux.log`，含真实路径链接外逃负控；Windows 同链接用例明确 skip，不据 Windows 代替 POSIX 证据。
- UI 自包含副本已重建；用户提示翻译回归 17 项通过：`security-r2-ui-build.log`、`security-r2-ui-copy.log`，新原生认证拒绝码不再落入未登记原因兜底。
- 来源链、主帧桥及真实 Unix socket 宿主回归 113 项通过：`security-r2-source-full.log`，含同体积毒化 deb/npm、篡改 JS/入口、空 riskFlags/目录失败、public status 不排队、恶意 nonce 等负控。
- Kotlin 全量在最终提交重跑通过：120 类 / 1309 项，失败、错误、跳过均为 0（`:app:testDebugUnitTest`，3m14s，WSL Java 17 + SDK 36）；设备负控源码编译通过，未执行 instrumentation。日志 `security-r2-gradle-rerun.log`，计数 `security-r2-kotlin-rerun-summary.json`；同轮更早的 `security-r2-gradle-final.log` / `security-r2-kotlin-summary.json` 保留为第二次证据。
- 桥对称、API 路由鉴权、Manifest、Kotlin 注释、补丁 id 自洽、vendor 补丁在场、执行地图、维护文档、Linux vendor 摘要检查通过；执行地图及 Linux vendor 的自检/负控通过。各日志按上述本机前缀保存。
- 新字节门禁实际检查旧来源快照：319 个源码包及 pnpm 物理载荷对账通过，随后既有 narb-android-N1 副本门禁拒绝旧产物，完整命令 exit 1。见 `security-r2-existing-snapshot.log`；这不是新候选来源链通过，旧产物不得用于本轮交付。
- **云端来源链实测（2026-10-18 00:00 前后）**：[run 39047619605](https://github.com/snoworwind/dsh-mobile-apk/actions/runs/39047619605)（`build-apk` 的 `draft_release=true`，HEAD `df5e295`）第 1–19 步全部通过（包含 17 项修复后的 Harness/插件/Termux/快照前置步骤），第 20 步「Build runtime snapshot from verified inputs」在**来源包 payload pin** 处失败：`@deepseek-ai/dsh-api-gateway: immutable source payload pin mismatch`。这是 pin 判据不可满足，不是构建或 17 项修复的失败；草稿未创建。随后撤回该判据（revert `5472ce9`，提交 `c37f354`），原因与证据见下节。该 run 的日志是「17 项修复能走完快照前全部构建」的云端证据，但不等于快照/APK/设备通过。
- **云端草稿成功（2026-10-18 01:13）**：[run 39050643684](https://github.com/snoworwind/dsh-mobile-apk/actions/runs/39050643684)（HEAD `bb8176a`，撤回 pin 后的最终源码）四个 job 全过：`branch → build-arm64 → prepare → draft`。创建 Release `hardening-source-bb8176a9ca99-39050643684-1`，**isDraft=true、isPrerelease=true**，target 提交 `bb8176a9ca99…`；资产恰为 4 个：`dsh-mobile-apk-v0.14.7-source-arm64.apk`（161,215,810 B）、`provenance.zip`（2,837,504 B）、`SHA256SUMS.txt`、`notes.md`。本机重新下载 APK 与 provenance 并按 SHA256SUMS 复算：APK `63b5dedc34eb…`、provenance `04581f9b5c92…` 均一致；provenance.zip 内含 source-build-manifest、component/project provenance、gradle/apk 摘要等预期证据。草稿说明明确标注「Device validation has NOT been performed」。该 Release 未公开，仍需设备三层验收后才能发布。
- **未做设备验证**：本机 adb 可执行，设备列表为空；16416、16384 两个模拟器连接拒绝。没有 CDP、ADB 自主真实任务、双方向截图或真机证据。L2/L3 验收仍阻塞，不能作为发布候选。
- 已由云端来源链生成 ARM64 APK 并进入**草稿** Release（见上条），未公开；设备层未验，旧 APK、热推与宿主单测不能代替。
- 已实际启动本地完整来源链（来源输入 `0f917ed`，隔离目录 `/tmp/dsh-source-chain-tbcbnf`）；先后暴露本地缺 GitHub runner 环境变量、隔离检出无 origin 两个环境前提，补齐值均来自本轮任务目录和原工作树实际仓库坐标，不改校验规则。执行到第 12/19 步（node-pty/NDK 交叉编译的 704 MB 下载）因会话中断停止，未进入快照与 APK 步骤；该目录保留用于取证（下节的字节对账就来自它）。本地链不是候选产物的来源，云端 run 39047619605 才是本轮流水线的权威证据。
- 本轮解压参考树在 finally 清理。工作区清理脚本在本仓及已知相邻入口均不存在，未臆造全树删除命令；旧缓存未删除，仅保留本轮日志、编译产物和测试依赖。

## 385：来源包 payload pin 的尝试、云端失败与撤回（2026-10-18）

**尝试**：把 319 个 Harness 源码包构建产物的 payload SHA-256 固定进 Git（`engine-source-payload-pins.json`），检查器用 `readCommittedFile` 按 commit/tree/blob 对象哈希读取 pin，再与缓存 tarball 解出的 payload 比对；同时绑定客户端 CSS 路径适配器的 SHA-256，避免静默更换路径策略。目标是堵住「缓存 + `source-build-manifest.json` + 快照三者一起被构建期代码改写」这条 385 剩余缺口。

**云端结果**：run 39047619605 在第 20 步失败，`@deepseek-ai/dsh-api-gateway: immutable source payload pin mismatch`。该包是检查器遍历到的第一个不一致项。

**根因（有字节证据，不是猜测）**：
1. **pin 的生成口径与校验口径不同**。生成脚本为了兼容「CSS-only 重建后 tarball 落后于源码树」，把非 `package.json` 的 payload 文件从源码树刷新后再算摘要（`refreshed`）；而检查器从**打包 tarball** 解出后算摘要（`tarball`）。在保留的本地构建树里逐包复算：319 包中 **69 包**两者不同；`@deepseek-ai/dsh-api-gateway` 的 `tarball=89e4993a…`、`refreshed=pin=c185fd06…`。也就是说，即使云端完全不篡改，这个 pin 也必然对不上 tarball。
2. **构建产物本身跨环境不可复现**。同一个包（同一 Harness commit `639ed…`）的 `lib/client.js` 三方摘要不同：云端 `ed0960e` 快照 `10412c68…`、本地重建树（已装同一适配器）`c185fd06…`、本地打包 tarball `89e4993a…`；把构建根路径归一化后仍不同（包的模块包装/内容排布有结构差异，不只是绝对路径）。因此即便改成「只从 tarball 算 payload」，也无法保证下一次云端构建得到同一摘要。
3. 保留树里的客户端 tsdown 配置与**已提交适配器**的 `planClientPaths()` 输出逐字节一致，排除了「本地用了另一版适配器」这一解释；差异出在打包/编译产物的可复现性，而非适配器选择。

**决定**：撤回该判据（`git revert 5472ce9`，提交 `c37f354`），恢复 7e7922d 的「参考树 vs 快照逐包 payload 比对 + manifest/commit 校验」；17 项修复与其余提交不受影响。**不**保留一个当前流水线无法满足的强制门禁，也不把失败 run 说成通过。

**未关闭的 385 剩余缺口**：能改写构建期输入的代码仍可同时改写缓存 tarball、manifest 与快照，使比对自洽。关闭它需要先做到**构建输出可复现**（至少 `lib/client.js` 级别的稳定字节），再谈把摘要钉进 Git；在那之前，任何 payload pin 都只会制造假失败或假安心。复现命令与三方摘要见本节；保留树路径 `/tmp/dsh-source-chain-tbcbnf` 仅本机取证，不作为证据资产。

## 必须补齐

设备恢复后从同一最终源码构建 APK，先跑 screen-scope matrix，再逐个跑对应 CDP 套件；由模型按目标自主编排授权拒绝/确认、通知作答、路径及浏览器切页任务，留存双方向 ADB 操作和截图。验证 relay 在首次加载、Cookie 清理、引擎重启、mux 重连的续接；系统凭据取消、超时、后台/锁屏、旋转、进程重启均不得复活旧授权；伪造 prefs、同源 setter、旧通知 PendingIntent 不得直接授权。

来源链侧还需：用撤回后的最终源码重跑 `build-apk`（`draft_release=true`）取得草稿；若后续要重启 385 的 pin 工作，先完成构建可复现性（含 `lib/client.js`）并给出两次独立云端构建同摘要的证据，再提交 pin 与负控。

主要复跑命令：

```text
npm --prefix plugins/dsh-model-capability test
npm --prefix plugins/dsh-android-bridge test
npm --prefix plugins/dsh-android-manage test
npm --prefix plugins/dsh-android-linux-env test
node --test plugins/dsh-android-linux-env/test/*.test.mjs
npm --prefix dsh-host-web-compat test
node --test scripts/source-build/*.test.mjs scripts/tests/main-frame-bridge.test.mjs scripts/tests/engine-private-transport.test.mjs
node scripts/check-vendored-linux-bootstrap.mjs --self-test
node scripts/check-code-map.mjs --self-test
```

Kotlin 在既有 WSL Java 17 / Android SDK 环境使用 wrapper JAR 执行 `:app:testDebugUnitTest :app:compileDebugAndroidTestKotlin`；设备与源码链入口沿用 build-and-env.md。本轮未新增依赖或版本升级，插件 lib 均按仓库构建脚本重建，gitignored 产物不强行纳入源码提交。

## 必须补齐

设备恢复后从同一最终源码构建 APK，先跑 screen-scope matrix，再逐个跑对应 CDP 套件；由模型按目标自主编排授权拒绝/确认、通知作答、路径及浏览器切页任务，留存双方向 ADB 操作和截图。验证 relay 在首次加载、Cookie 清理、引擎重启、mux 重连的续接；系统凭据取消、超时、后台/锁屏、旋转、进程重启均不得复活旧授权；伪造 prefs、同源 setter、旧通知 PendingIntent 不得直接授权。
