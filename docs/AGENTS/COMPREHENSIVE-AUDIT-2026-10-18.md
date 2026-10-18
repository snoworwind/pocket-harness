# 综合问题审查（2026-10-18，只登记）

本轮按用户要求检查问题并记录，**不修复实现**。审查基线为 `1171d70cb8b1e43a9541bdb6f407807200a4427f`，来自待合并的 `codex/bundle-arm64-linux-runtime`（PR #8），不是已经合入 `main` 的版本。以下路径、行号和结论均对应此基线；后续修复须重新验证。

## 范围与判读

覆盖来源构建与草稿发布工作流、来源证明和门禁、离线 Linux 资产打包/解包/激活/运行时事务、插件及 UI 宿主回归；抽查 Android Manifest、EngineAuth、原生通知确认、启动与快照恢复的既有边界。源码检查和宿主反例不等于设备验收，也不构成无漏洞保证。

本轮仅修改本报告与缺口入口。产品源码、构建配置、测试均未修复，插件 lib 未重建；Kotlin 检查生成了测试构建产物，审计探针及日志留在 `.deploy-tmp/audit-2026-10-18/`。未构建 APK、未发布、**未做设备验证**。当前 PowerShell 的 PATH 无 adb；本轮未取得 CDP/ADB、自主真实任务、双方向截图或真机证据。

P1 表示主要功能阻断或可能损坏安装状态，应在该功能交付前修复；P2 表示行为错误、验证可移植性或策略缺口。状态分为“宿主已复现”和“源码确认、外部效果未实测”。编号为本报告局部编号，不占用 gotchas 的历史编号。

## 发现清单

| 编号 | 优先级 | 问题 | 证据状态 |
|---|---|---|---|
| A01 | P1 | 来源链归档的 `./` 根目录条目被生产解包器拒绝 | Windows/WSL 同反例复现 |
| A02 | P1 | Node/Debian 归档保留链接，生产解包器禁止全部链接 | 合成合法链接复现；真实全量资产尚未解包 |
| A03 | P1 | bootstrap 发布槽位不在宿主允许的插件根目录 | Windows/WSL 真实宿主适配器复现 |
| A04 | P1 | runtime 未收到离线资产 IO，且两侧下载适配器签名不一致 | 配置截获复现；签名由源码确认 |
| A05 | P1 | ExecutionGate 最后一个共享使用者退出不唤醒管理等待者 | Windows/WSL 纯逻辑复现 |
| A06 | P1 | 激活记录写入后的清理异常会删除已激活的新实例 | Windows/WSL 管理器受控故障复现 |
| A07 | P1 | build-apk 包装工作流没有传递发行签名 Secrets | 源码确认；未触发远端构建 |
| A08 | P2 | undo_list 将 UTC 时间直接展示为无时区本地时间 | Windows/WSL 既有业务回归复现 |
| A09 | P2 | 函数体切片测试依赖 LF，CRLF 检出产生结构性误红 | 双环境失败；LF/HEAD 字节对照确认 |
| A10 | P2 | 非草稿来源构建入口没有落实 main 分支限制 | 源码确认；未在非 main 上构建 APK |

### A01：来源归档根目录条目与解包器不兼容

- 位置：`scripts/source-build/package-linux-assets.py:56-58`、`scripts/source-build/build-linux-assets.sh` 的 rootfs 归档段；`plugins/dsh-android-linux-env/src/linux-host-asset-io.ts:124-133`。
- 原因：打包器使用 `tar ... -C <目录> .`，GNU tar 会写入 `./` 目录成员。解包器先去掉 `./` 和尾斜杠，再调用拒绝空路径的 `resolveInside`，并拒绝 `target === root`。正常根成员被当作路径逃逸拒绝。
- 反例：在审计临时目录放一个普通文件，用生产同形命令 `tar -cJf <archive> -C <input> .` 打包，再调用 `createHostAssetIO({filesDir}).extractArchive(archive, freshDestination)`；返回 `Unsafe or duplicate archive path`。Windows 与 WSL 均一致。
- 影响：离线 runtime 插件包本身就无法完成解包，尚未走到宿主激活。校验摘要正确也无法避免。
- 后续验收：直接以真实 packager 的输出驱动生产解包器；允许的根条目必须严格限定为零大小目录，仍需拒绝越界和重复文件。本轮未改规则。

### A02：资产需要的链接与解包政策冲突

- 位置：`scripts/source-build/package-linux-assets.py:51-52` 的 `symlinks=True`；`scripts/source-build/build-linux-assets.sh` 的 Debian rootfs tar；`linux-host-asset-io.ts:129`。
- 原因：Node 的 bin/npm 等链接被有意保留；Debian rootfs 由普通 tar 保留文件系统链接。通用解包器只接受 file/directory，拒绝 symlink/hardlink，不区分 plugin 与 node/rootfs。
- 反例：单成员 `bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js` 的 xz tar，不含 A01 的根条目，返回 `Archive links and special entries are forbidden`。这证明链接拒绝独立存在。
- 影响：即使解决 A01，当前解包器也不兼容 runtime 资产格式。不能仅为通过安装而全局放开链接；plugin 包与 rootfs 的需求不同。
- 边界：本轮未下载或生成完整 ARM64 Node/Debian 资产，未证明真实安装首先在哪个链接失败；真实成员顺序、总大小、文件数与单文件上限仍待逐一对账。

### A03：安装目录与允许激活目录不同

- 位置：`linux-host-asset-io.ts:278`；`plugins/dsh-android-linux-env/src/index.ts:351-353`；`plugins/dsh-android-linux-env/src/linux-environment.ts:190-198`。
- 原因：默认 `stagingDirectory` 为 `<filesDir>/linux-environment/staging/runtime-plugin`，bootstrap 将可执行包发布到其 `<sha256>` 子目录；真实 pluginHost 的根却为 `<filesDir>/linux-environment/plugins`，并要求 realpath 后位于此根内。
- 反例：使用生产 `createLinuxBootstrapConfig` 计算槽位，创建最小 `lib/index.js`，再用生产 `createLinuxPluginHost` 和生产同形 root 安装。宿主返回 `Runtime plugin is not present in the injection directory; add it explicitly before installing`，没有到达 activate。
- 影响：即使归档已解包，也无法启用 runtime。若 plugins 根目录尚未创建，还会更早拒绝。
- 测试盲区：当前资产 IO 正控用 `makePluginHost()` 替身；该替身接收任意目录，未覆盖真实根目录约束。

### A04：离线 IO 没有传给 runtime，补接时还存在签名差异

- 位置：`plugins/dsh-linux-bootstrap/src/index.js:150-152,168,301-308,356`；`vendor/dsh-linux-runtime/lib/index.js:127-134`；`vendor/dsh-linux-runtime/modules/manager.js:630-641`；`linux-host-asset-io.ts:176`。
- 原因：bootstrap 自己持有 downloadAsset/extractArchive，但生成 runtime 配置时只展开默认空的 `runtimePluginConfig`，随后附 dataDir/cacheDir/arch/manifest/runtimeId。生产 host config 没有提供 runtimePluginConfig，pluginHost 原样转交配置。runtime `apply` 因而取不到 downloadAsset、extractArchive 或 linuxAssetIO。
- 反例：以现有 genuine 归档夹具运行真实 bootstrap，在 pluginHost.install 截获输入配置，三个字段的 typeof 均为 `undefined`。Windows/WSL 一致。
- 影响：默认管理器落入 fetch 下载；资产 URL 在当前离线方案中只是私有仓库的不透明标识，不保证可匿名下载；即使取得字节，管理器的安全 extractor 仍缺席，安装会拒绝。
- 第二层不匹配：manager 调用 `downloadAsset(asset, destinationPath)`，要求回调把内容写到此文件并随后 verifyFile；host IO 的接口返回已有 archive 路径，不把文件写到第二个字符串参数。简单传同一个函数还不能完成接线。
- 后续验收：真实 host + bootstrap + runtime manager 的同一链路应在禁网下完成 Node/backend/rootfs 安装，明确适配返回路径和写文件两种约定；替身 manager 的 install 成功不足为证。

### A05：共享锁退出后管理操作永久等待

- 位置：`vendor/dsh-linux-runtime/modules/manager.js:108-130,613-614,950-976`。
- 原因：`acquireExclusive` 在 active > 0 时等待 `_wake()`；`releaseShared` 却仅在 `active === 0 && exclusive` 时唤醒。独占等待者获锁前 exclusive 必为 false，因此最后一个共享任务退出后没有唤醒。
- 最小复现：

```js
const gate = new ExecutionGate()
await gate.acquireShared()
let acquired = false
gate.acquireExclusive().then(() => { acquired = true })
gate.releaseShared()
await new Promise(resolve => setTimeout(resolve, 50))
// active=0, exclusive=false, waiters=1, acquired=false
```

- 影响：等待活动任务退出的 install/uninstall/dispose 有死锁条件；等待中的管理者也未阻止新的共享任务进入，有管理操作饥饿的可能。
- 边界：已证锁原语错误，不声称每次 `_exclusive` 都挂死；它会先 `_stopChildren()`，是否刚好在 acquire 前退出取决于调用时序。须补覆盖真实 execute 与管理操作竞争的反例。

### A06：事务提交后的异常清理破坏已激活实例

- 位置：`vendor/dsh-linux-runtime/modules/manager.js:861-878`；观察者通知在 `:596`。
- 原因：`_writeActive(record)` 成功后仍处于同一个 try。旧实例清理或后续通知抛错，catch 无条件按 finalPublished 删除新实例，却不恢复旧 active.json。
- 反例：使用现有 manager.test.mjs 的真实资产/runner 夹具先 install 成功，再仅将 `_removePreviousInstance` 设为抛出受控清理异常，执行 reinstall。结果 `active.json` 已变为新 id、该 id 的实例目录不存在、旧目录仍在，status 为 unhealthy，原因为 backend executable 缺失。
- 影响：磁盘/权限等旧目录清理失败可将一次已经成功切换的安装变成不可用状态。`events.emit('change')` 的监听器异常也位于同一失败域，需一起审查。
- 后续验收：区分提交前回滚与提交后清理失败；对旧目录删除、观察者抛错、状态写入失败分别注入故障并重启回读。本轮只注入旧目录清理异常，不把其他分支列为已复现。

### A07：包装 workflow 未传递签名 Secrets

- 位置：`.github/workflows/build-apk.yml` 的 source-build/source-draft jobs；`.github/workflows/build-apk-source.yml:67-68` 及签名非空断言；`.github/workflows/release-source-draft.yml:24-28`。
- 原因：build-apk 的两个 reusable workflow 调用都没有 secrets 映射或 `secrets: inherit`。被调来源链读取 `POCKET_SIGNING_KEYSTORE_BASE64` / PASSWORD；仓库 Secrets 不会通过一个未声明传递的调用层自动继承。draft 内层虽然 inherit，外层仍未收到。
- 影响：直接调来源 workflow 与经 build-apk 包装入口的行为不同；包装入口会在签名前置处拒绝，无法生成草稿。源码确认，未使用真实密钥、未触发云端构建或改动 Secrets。
- 后续验收：直接来源、包装非草稿、包装草稿三条入口分别验证秘密传递；只验证 YAML 中出现 Secret 名称不能证明逐层接线。

### A08：undo_list 时间与快照 id 差一个时区

- 位置：`vendor/dsh-undo-savepoint/lib/index.js:436`；`vendor/dsh-undo-savepoint/test/undo-scan-and-time.test.mjs:148-181`。
- 原因：显示时间仅对 ISO UTC 字符串 replace T 并 slice，没有做本地时区转换；快照 id 采用本地时间。
- 反例：原样执行既有测试，固定 Asia/Shanghai；id `20260919-120038-ab12` 对应 `2026-09-19T04:00:38.000Z`，列表显示 `04:00:38`，期望 `12:00:38`。Windows 与 WSL 均失败。
- 影响：用户按时间选择回撤点容易混淆。不是时区环境误红；测试已经显式指定时区，生产格式化代码也确实未转换。
- 边界：结论覆盖当前 vendored 源码和宿主工具输出，未复核最终快照中的实际展示。本轮未找到此用例在 Actions 的调用点；PR Gate 仅显式跑 undo 的 import-plaintext 用例。

### A09：测试对 CRLF 字节敏感

- 位置：`scripts/check-engine-overlay.test.mjs:9-14`；`dsh-host-web-compat/scripts/file-click-defer.test.mjs:16-24`。
- 原因：读取源码/生成文件后直接用 `\n  }\n`、`\n}\n` 寻找函数尾部；没有统一 CRLF。当前 core.autocrlf=true，index 为 LF，工作树为 CRLF。
- 反例：overlay 测试在 Windows 和 WSL 访问同一工作树都在加载期失败，未执行任何业务断言；读取同一内容只归一化换行后 mapEnd 从 -1 变成 7700，与 `git show HEAD:...` 一致。file-click 测试同样报“hasUpstreamHandler 必须能被完整取出”。
- 影响：Windows/WSL 本地验证会被换行误红阻断，不应通过放宽业务断言处理；不能据此声称引擎 overlay 或文件点击的产品行为已坏。
- 边界：file-click 当前 lib 本身为 CRLF，尚未原样复跑完整 LF 净检出；本轮只证明其切片前提与文件字节冲突，不宣布该套业务断言通过。

### A10：main 来源构建政策只在草稿路径落实

- 位置：AGENTS §4.9；`.github/workflows/release-source-draft.yml:17-21`；`.github/workflows/build-apk-source.yml:1-15`；`scripts/source-build/local-source-workspace.mjs` 的 sourceCommit。
- 原因：草稿有 refs/heads/main 的显式 guard；直接 workflow_dispatch/workflow_call 的来源构建没有同等约束，本地入口只解析任意 HEAD 的 commit。隔离检出证明“已提交”，不证明“属于允许的维护线”。
- 影响：有构建权限的操作者可在非 main 上启动 APK 来源链，与仓库写明的 main 限制不一致。属于政策接线缺口，不是未授权用户可签名的证明。
- 边界：本轮没有在候选分支构建 APK，也没有触发远端负控。是否需要允许开发候选，须由用户另行决定；本轮不改现行政策或实现。

## 执行证据与环境限制

日志目录统一为 `.deploy-tmp/audit-2026-10-18/`，日志不提交到 Git，不包含签名私钥/凭据。临时探针 `probe.mjs` 从基线 manager.test.mjs 复用夹具，`cleanup-probe.mjs` 为其生成的审计辅助文件；二者都不是产品修复或新增正式测试。

| 检查 | 本轮结果 | 日志/解释 |
|---|---|---|
| 13 项静态门禁 | 全部 exit 0 | check-release-gates / code-map / bridge-symmetry / api-route-auth / manifest-hardening / bounded-io / control-ops / op-registry-parity / tool-name-promises / engine-heap-floor / patch-fixtures / maintenance-docs / vendored-linux-bootstrap，各有同名日志 |
| 来源 Python 回归 | 14 项通过 | `python-linux.log`，WSL Python3；含资产 packager 与来源草稿准备，夹具通过不覆盖 A01–A04 |
| Linux source 自检 | exit 0 | `linux-source-self-test.log`，含受控篡改拒绝；来源字节正确不证明运行时可安装 |
| Node 脚本/来源/私有 transport/vendor 回归 | 221 项，219 通过、2 失败、0 skip | `node-regressions-linux.log`；两红为 A08 和 A09 的 overlay 测试；Node v22.22.1 |
| Windows 同批回归 | 221 项，185 通过、4 失败、32 skip | `node-regressions-host.log`；A08/A09 之外含 Windows symlink 权限问题，不能替代 Linux 结果 |
| 插件总入口 | 失败，未记全绿 | `plugin-tests-linux.log`；bridge 165/browser 34/file-open 26/linux-env 66/manage 92/bootstrap 10/UI 748 通过；其余见下文 |
| 最小跨层反例 | 预期缺陷均复现 | `probe.log` / `probe-linux.log`；最终 Linux 探针 exit 0 表示探针完成，不表示产品通过 |
| Kotlin 全量离线单测 | 120 类 / 1310 项通过，failure/error/skip 均为 0 | `kotlin-linux.log`、`kotlin-counts.json`；耗时 5m37s，WSL Java 17.0.20.1，Android SDK 36；计数门禁另在 `kotlin-count-gate.log` exit 0，未打 APK |
| CDP/ADB/ARM64 来源 APK | 未执行、未验收 | 不以宿主测试代替三层 |

可重复的主命令（从仓库根执行；Linux 命令在 WSL 运行）：

```sh
node --test scripts/source-build/*.test.mjs scripts/tests/*.test.mjs scripts/*.test.mjs vendor/dsh-linux-runtime/test/*.test.mjs vendor/dsh-undo-savepoint/test/*.test.mjs
python3 -m unittest discover -s scripts/source-build -p 'test_*.py' -v
node scripts/check-plugin-tests.mjs
node scripts/source-build/check-linux-sources.mjs --self-test
java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain :app:testDebugUnitTest --offline --no-daemon --console=plain
```

插件总入口的三类红单独判读：vdisplay 的三份 keybar 用例在 WSL Node 22 报 `ERR_UNKNOWN_FILE_EXTENSION .ts`，Windows Node 26 的 vdisplay 91 项通过，属运行器差异，不能直接判产品故障；model-capability 的本地 ignored lib 仍含 `com.pocketharness.shell`，而已提交 src 已是 `com.snoworwind.pocketharness`，属未重建产物，不登记为当前源码包名缺陷；host-web-compat 为 A09。用户要求不修复，本轮没有为追绿重建 lib。

Windows 沙箱初跑的本地 HTTP EACCES、临时 Git 配置拒写、symlink EPERM 等原始失败保留在 node-regressions.log/plugin-tests.log；随后原样宿主和 WSL 复核，未删测试或修改判据。没有把第一次红当成通过，也没有把权限错误当成漏洞。

## 遗留边界与后续顺序

既有修复项的设备缺口仍按 [known-gaps.md](known-gaps.md) 和 [第二轮修复账本](SECURITY-REMEDIATION-2026-10-17-R2.md) 保留，不将旧记录重新包装为本轮新漏洞。Android 授权、通知 PendingIntent、relay、文件导入、快照恢复本轮主要为源码抽查和宿主既有回归；没有取得系统凭据取消/旋转/后台、锁屏、WebView 手势/子帧、真实 Unix socket/SELinux、历史中断恢复或用户数据升级保留的设备新证据。

后续优先串通 A01–A04 的真实离线安装链，再处理 A05–A06 并发与事务反例；签名包装入口 A07 应独立收口。A08–A10 分别处理行为、测试字节兼容与构建政策。各项保持“未修复”，修复时仍须原子 PR、相应风险档证据及最终来源 APK/设备验收；本报告不能作为发布放行依据。
