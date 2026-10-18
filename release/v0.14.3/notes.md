# v0.14.3 发布说明

> 追上游 `dsh-v0.2.0-rc.2`（commit `639ed015397290b3745d163aafe02ffee4aa3f84`）的 Android 壳侧适配版本。
> 本版走 GitHub Action 发布链（workflow_dispatch 传 version + notes，CI 完成重建快照 -> 双 ABI 打包 -> 门禁 -> draft Release）。

**升级说明**：versionCode 44 -> **45**，versionName `0.14.2-fx-3` -> `0.14.3`。可直接覆盖安装，无需卸载。

## 验收状态（**先读这一节**）

**本版设备三层验收未完成。** 把「已做」和「未做」分清楚，不要混为一谈：

| 层面 | 状态 |
|---|---|
| 构建链内置门禁（开发方已跑） | PASS：双 ABI 全链 exit 0，49 条门禁 PASSED / 0 FAILED |
| Kotlin 单测（开发方已跑） | PASS：**965 项 / 0 失败**（含 #309 新增 19 例 + 10 处变异反证） |
| 组件单测（开发方已跑） | PASS：33 文件 / 446 项 |
| GitHub PR 必需检查 | PASS：Kotlin 编译门禁 + 冲突标记/敏感信息扫描 |
| **代码层设备验收** | **未完成** |
| **CDP 层设备验收** | **有已知失败**，见下 |
| **ADB 用户层验收（含真实模型编排任务）** | **未完成** |

外部测试（2026-10-01，两台 MuMu x86_64）**明确判定「未验收」**，已知失败项如实列出：

- `verify-webview-015` 横屏：活跃会话下「在文件中打开」入口缺失（竖屏 39/39 通过，横屏 38/39）
- `verify-browser-host`：`profileAvailable=false`、`profileReason=browser-profile-unsupported`（设备 WebView 不支持 `MULTI_PROFILE`）=> **浏览器 profile 隔离面在本机不可用**
- `verify-browser-panel`：profile 不可用后开页失败，并触发 Node 侧 Windows `UV_HANDLE_CLOSING` assertion
- `verify-vdisplay-float`：verifier 把 setter 返回值 `false` 误判为失败并提前退出（疑似测试契约问题，非产品缺陷）
- Shizuku 无运行服务 => 虚拟屏、`verify-vdisplay-viewer` 与屏幕范围矩阵未跑（INCONCLUSIVE）
- root 系列 R1–R10、I 系列设备回归、B2–B4、PTC 运行时行为、arm64 真机补测均**未运行**

> 因此本版按「**预发布质量、待设备验证**」对待：功能与修复有代码层证据，但**没有**通过三层设备验收。
> 报告全文见协调仓 `docs/0.14.3-TEST-REPORT-2026-10-01.md`，逐项待办见 `docs/0.14.3-TESTER-CHECKLIST.md`。

## 一、本版主线：追上游 0.2.0-rc.2

- `contract.baseline` 抬到 `0.2.0-rc.2`，`docs/UPSTREAM-CONTRACT.md` 同批改口；槽位登记表补两条本轮新消费的座位
  `sidebar.right.pane.tab.title`（keyed/session）与 `sidebar.right.tab.menu.item`（list/session），均由源码实测 kind/scope 钉死
- **工厂件结构变更**：上游新增 `desktop-product-telemetry` / `product-analytics` 两行，按 Android 面**显式 disable**（桌面遥测分析非 Android 服务）；
  顶层条目 20 -> 22（+1 注释头 = 23），`FactoryProfilePatchTest` 两处硬编码期望值随之更正并写明依据
- **本轮修掉的会崩缺口**：上游 `otel` 是 enabled 基础服务，其 `lib/index.js` 顶部静态 `import 'got'`，而旧快照不含 `got`
  => boot 期 `ERR_MODULE_NOT_FOUND`。登记 `got@14.6.6` 并重建双 ABI 快照
- **门禁实修 3 处**：`check-engine-overlay` 的包根推导在 `usr/lib/...` 树上恒命中索引 3（退化成 `usr/package.json` 假红）、发现式目标按 dict 取值而实传 list（扫描整体崩）；
  `check-patch-mirror` 的 `walk()` 只走一层 => `fixtures/` 下 31 个目录从未参与比对

## 二、issue #309：运行时树残缺时无任何恢复路径（闸门 A/B 互锁）

**缺陷**：闸门 A（`liveRuntimeComplete()`，spawn 之前，位置先于 `force`/可用性判定 => 看门狗 force 也绕不过）拒启 => 不 spawn
=> `engine.log` 永不产生 => 闸门 B 的自愈判据（读当拍 `engine.log` 尾部找 `CANNOT LINK`）**恒为假** => 自愈结构性不可达。
且 `refreshSnapshot` 全仓只有冷启动一个调用点，拒启路径为零；UI「重试」只清账本不删指纹（指纹新鲜时是 no-op）。issue 实测 **36 次 / 47 分钟零恢复**。

**修法**：拒启路径改为「先取证 -> 写损坏标记 -> 删指纹 -> 清账本 -> **结论落盘** -> 落诊断镜像」，
借既有的冷启动分支 `if (!snapshotFresh()) refreshSnapshot(...)` 走完整重抽取（**不新增调用点**）。三处克制：

1. **不改闸门 A 判据**：带病的树仍然不被 spawn；
2. **预算**复用 `runtimeTreeHealedThisRun`（每次 app 运行一次），且为**单次 CAS** => 无「重抽取 -> 再失败 -> 再重抽取」死循环；
   删指纹失败时**退回预算**（否则自动与手动两条出口会同时失效，比修之前更糟）；
3. **证据分级**：只有**快照自身条目**缺失（`bin/node`、`dsh/lib/bin.js`、`profiles/web`）才自动触发；
   `REQUIRED_LIBS` 成员**只记录不自动触发** —— 该表不含传递依赖、命中可能是假阴性，issue 原文亦告诫「不要贸然补全该表」。

**用户显式出口**：错误页主按钮（Error 相位 =「安全模式启动」）在上一次拒启确为 live 残缺时强制重做一次，
放行分级但**不放行预算**；该调用**离开 UI 线程**执行（恢复含诊断镜像与 logcat 抽取，留在 UI 线程是真实 ANR 路径）。

**取证面**：`start_refusal_code` / `start_refusal_confirmed` / `start_refusal_evidence`（逐项 `size=`/`mtime=`）进 `boot-fail.log` 与诊断包；
拒启文案按 issue 建议 5 改写，不再承诺一个不存在的动作。

**残留缺口（本轮未修，已登记 `known-gaps.md`）**：`EngineService.kt:281/:319` 的看门狗路径直接调 `startEngine()`，不经拒启分支
=> 纯服务自愈路径仍无恢复出口。需把恢复动作的 Activity 依赖下沉，属独立改动面。

## 三、root 授权面与属主自愈（PR #308，社区贡献 @cmyfqwq）

失败关闭的 AI root 授权面：有效 versionCode consent、无未知命令重放、held-FD core/helper、v4 configuration、
Context 公平 fence、耐久 `RootMaintenanceLease`、per-lease honest pending。移除「打开 Root 管理器」入口并修正授权框口径。
详见 `known-gaps.md` 的 root 行与其外部待验项。

## 四、官方浏览器 UI 复用与隔离

vendored 官方 0.2.0-rc.2 UI + 自有 native adapter；`BrowserHostProfile` 在 load/settings 前验证 per-session nonDefault，
不支持即拒不回 Default；真实 tab-menu；捕获 Session/tab 与 model/UI 焦点分离。
**注意**：本机 MuMu 的 WebView 不支持 `MULTI_PROFILE`，该隔离面在本地**未验证通过**（见上）。

## 五、PTC / 补丁 / 组件测试环境

- registry 接入 PTC A1 与官方 pi-ai 0.87.1 六 provider streaming 补丁
- 组件测试环境补 `clsx`/`zustand`/`immer`/`simple-icons` 与 `vitest.config.ts` 的 `server.deps.inline`（引擎包经 Vite 走 bare `.module.css` 导入）
- issue #288 快照面板观察者；补丁夹具同步到 0.2.0-rc.2 并让镜像门禁**递归**比对 `tests/`

## 六、构建与产物

- 双 ABI 快照源：arm64 162,854,368 B `d81ee2ac…`；x86_64 160,382,696 B `209fc4df…`（构建链注入补丁与组件产物后内嵌哈希按 ABI 不同，见 `MANIFEST.txt`）
- 本地预演产物（本发布前的开发方构建，供对照）：arm64 `703f9aa3…`、x86_64 `797f29ce…`
- **本 Release 的最终产物哈希以 `MANIFEST.txt` 与各资产为准**（CI 从源重建，与本地预演**不保证**逐字节相同）

## 七、破坏性变更

无已知破坏性变更。versionCode 单调递增，可直接覆盖安装。

## 八、合规

第三方许可与 GPL 源码要约见随包 `assets/licenses/THIRD_PARTY_NOTICES.md` 与仓库 `LICENSES/`。


