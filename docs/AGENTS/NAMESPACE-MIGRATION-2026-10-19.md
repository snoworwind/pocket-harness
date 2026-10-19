# Kotlin namespace 迁移

按用户要求，将 Kotlin namespace、生产/单测/androidTest/AIDL 源码目录和类名引用从 `com.dsharnessmobile.shell` 迁至 `com.snoworwind.pocketharness`。applicationId、签名策略和应用数据目录不变，不迁移旧 DeepCode 数据。

## 实现与升级边界

- 同步门禁的 Kotlin 查找路径、桥对称基线、状态登记表、模块和执行地图，插件 IME/receiver 常量、Root app_process 入口与全部开发/验收组件名。
- Shizuku AIDL descriptor 随包名变化；协议由 4 升到 5，UserServiceArgs.version 仍绑定协议版本，要求管理器淘汰旧 descriptor 的缓存服务。AIDL transaction 编号不变。
- Android 同包组件可能以 `包名/.Service` 简写回传；无障碍与 IME 判据同时接受新完整名/简写，拒绝旧应用及旧类名。
- 现有 Pocket Harness 的应用身份与数据根不变，但系统保存的无障碍、IME 组件名会变化。升级后可能需要重新启用无障碍并选择输入法；不得自动放宽授权。此行为尚无设备证据。
- 旧包名仅保留在历史审计/截图事实、协议录制夹具和明确的拒绝旧身份反例中，不作为生产组件、类、路径或门禁源码定位。

## 迁移前完整检查

基线提交 `27227941e07728a168bca8a27af913eee0d27f78`。Windows PowerShell、WSL OpenJDK 17、Android SDK 36、Node 24.21.0；完整命令清单在本地 `.deploy-tmp/namespace-migration/check-all.sh`，输出逐项保存在 `before/`。

首次检查保存在 `before-initial/`：CRLF 检出使两个源码替换负控未命中，陈旧插件 lib 导致三个插件单元失败。将 Git 规范化内容不变的检出换行为 LF，按各包 build 脚本重建插件，再以同一命令集复验；未放宽判据或加入失败豁免。bootstrap 使用 Windows esbuild，其余 TypeScript 包使用现有可用工具。

- Kotlin：122 个测试类、1321 项，失败/错误/跳过均为 0；计数门禁通过。
- androidTest：`compileDebugAndroidTestKotlin --offline --no-daemon` 编译通过。
- Node：脚本、来源链与补丁全量 278 项通过，无跳过。
- Python：来源链全量回归通过。
- 插件/子仓：11 个测试单元通过，SKIP=0，含 UI 751 项。
- 聚合发布段：32/32 项执行通过，SKIP=21（快照、上游树或设备原始输入缺席的已声明项，不算产物验证）。代码地图、维护文档与两套绑定/屏幕自检通过。

## 迁移后完整检查

重建 manage 插件并执行 `:app:clean` 后，从干净 Android 输出运行同一套检查及 androidTest 编译。结果逐项保存在本地 `after/`：

| 检查 | 迁移前 | 迁移后 |
|---|---|---|
| Kotlin 全量与计数门禁 | 1321 项通过，0 失败/错误/跳过 | 1321 项通过，0 失败/错误/跳过；报告类名全部属于新 namespace |
| androidTest 编译 | 通过 | 通过 |
| Node 全量 | 278 项通过 | 280 项通过，增加目录/声明一致性及 AIDL 缓存失效约束 |
| Python 来源链回归 | 21 项通过 | 21 项通过 |
| 插件/子仓 | 11 单元通过，SKIP=0 | 11 单元通过，SKIP=0 |
| 聚合发布段 | 32/32，SKIP=21 | 32/32，SKIP=21；未新增跳过或豁免 |
| 代码地图、维护文档、绑定/屏幕自检 | 通过 | 通过 |

重新生成的 Manifest 中全部十个本应用组件、provider authority、BuildConfig、AIDL descriptor 和 instrumentation target 已核对；编译后的 runtime classes.jar 包含新 Root/服务/Stub，旧 namespace 类条目为零（`after/generated-identity.json`）。生产 Kotlin/AIDL、组件常量及门禁源码定位未残留旧 namespace；历史夹具和拒绝反例不改写。旧 HEAD 的真实源码树运行新目录/声明回归按预期失败（`after/legacy-tree-negative.log`），另有旧声明/仅移动目录/旧 IME/旧绑定反例。

本轮源输入摘要为 `ceb05a3307efa4a2096a933644ca6ebab85df93ad8c79ea47e99cc86d1794df7`，逐文件 SHA-256 清单在 `after/input-hashes.json`，测试后已核对内容未漂移；摘要范围为 app/src、插件和 scripts 的可交付输入及 app/build.gradle.kts，不含本地生成物。未修改签名或 APK 构建来源策略。

## 设备与产物边界

迁移前实际查询 WSL SDK 的 `adb devices -l` 为空。未运行设备三层验收、横竖屏、自主任务、覆盖升级、真实 IME/无障碍重新绑定或 Shizuku 重连；未构建 APK。源码检查、Manifest/AIDL 生成和编译通过不能替代这些证据；未验收，不得作为发版候选通过。
