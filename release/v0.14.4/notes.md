# v0.14.4 发布说明

> Android 壳侧修订版。本版主题：**客户端插件装配失败（页面 "Failed to load plugins"）纳入引擎故障与自愈链** —— 页面侧判定终局失败、壳侧落盘并退出到引导页错误相位、后台有界自动回滚，失败时给「安全模式启动」出口。

**升级说明**：versionCode 45 -> **46**，versionName `0.14.3` -> `0.14.4`。可直接覆盖安装，无需卸载。

## 验收状态（**先读这一节**）

把「已做」和「未做」分清楚，不要混为一谈：

| 层面 | 状态 |
|---|---|
| 构建链内置门禁（开发方已跑） | PASS：本地 `-devplug` 档单 ABI 全链 PASS；**双 ABI 由发布链产出** |
| Kotlin 单测（开发方已跑） | PASS：**1063 项 / 0 失败 / 2 skipped / 101 类**；基线 `scripts/kotlin-test-baseline.json` = 1063（apk 仓与协调仓镜像一致） |
| 新增测试类 | PASS：`ClientPluginFailRouteTest` **26** 例、`ClientRollbackGateTest` **24** 例 |
| 页面侧看门狗单测 | PASS：`dsh-host-web-compat/scripts/boot-watchdog.test.mjs` 全绿（含失败页发契约行且不发 ready、健康渲染发 ready 且不发 fail 的正反用例） |
| **代码层设备验收** | **PASS**（MuMu 16416 竖屏：注入客户端坏插件后 45s 内自愈，全程未手动冷启动） |
| **ADB 用户层验收** | **PASS**（同一轮：引导页错误相位可见 + 自动恢复回到正常界面） |
| **CDP 层设备验收** | **未跑**（本轮未执行 CDP 断言） |
| 横屏 16384 设备验收 | **未跑** |
| arm64 真机验收 | **未跑**（发布前补充门禁） |

设备套件 `scripts/verify-client-plugin-fail-recovery.mjs` 的 `--self-test` 已跑绿（**55 例**，离线纯逻辑，不碰 adb）；该套件的设备全链本轮以一次**真实注入实测**代替，判据 1、3、4、5、6 的对应现象均在设备上直接观测到（见下「功能」与「设备层才抓得到的四段缺陷链」）。

> 因此本版按「**代码层 + 设备实测通过、CDP 层与部分设备矩阵未覆盖**」对待：不给「全部通过」的结论，也不给「未验证」的降级结论。

## 一、本版主线：客户端插件装配失败的自愈链

**改造前**：页面出现 "Failed to load plugins" 时，壳侧只落一行 `source=console-error` 诊断，**不做任何动作** —— 用户停在失败页，引擎健康、HTTP 正常，前台监控/冻结看门狗还可能把坏页面反复弹回。

**改造后**（跨页面侧 / 壳侧路由 / 回滚侧三面）：

1. **页面侧**（`dsh-host-web-compat`）：注入层判定终局失败后发布单行契约
   `[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail detail=<折叠k=v> failedIds=<逗号分隔|-> pageSideRuntime=<JSON>`
   （字段序即契约，壳侧按位置解析；失败判据 = 启动页仍在场且容器内有失败投影，发布幂等）。
   同时把 `publishReady()` 判据收紧为 `rendered() && !bootPagePresent()`。
2. **壳侧路由**：控制台路由新增第三分支识别该前缀，落盘 `boot-fail.log` 终态 + `Log.e`。
3. **壳侧失败面**：置独立 latch（`clientPluginTreeFailed`），前台立刻切引导页 **Error 相位**（主按钮本来就是「安全模式启动」），
   非前台挂起待 `onResume` 消费；`showWeb()` / 引擎监控 / 冻结看门狗三处让路，**坏页面不再被弹回**。
4. **自动回滚（有界）**：`UndoGate.onClientPluginTreeFailure` 一次性入口（刻意不复用 ARM->WAIT 观察窗，否则引擎健康时
   每一拍 `disarm()` 会把 arm 文件清掉、EXECUTE 永远到不了）；点名唯一 ⇒ **只拔该条目**（外科），
   点不出名且挂载清单未变 ⇒ **known-good 整份回滚**，两者都不成立 ⇒ **不动作**，如实停在可读错误页。
   一次一轮只自动回滚一次，并受 30 分钟重试窗约束。
5. 恢复动作执行后强制重启引擎并自动重载页面，用户可见地回到正常界面；失败则停在 Error，不再自动重试回滚。

**用户可见结果**：坏插件导致的「页面装不上」从**死页**变成**45 秒内自愈**；修不了的情况（自有插件、清单已变）**如实停在错误页**并提供安全模式出口，不假装能自愈。

## 二、设备层才抓得到的四段缺陷链（本功能的核心价值）

代码层与 CDP 层**均看不见**这四条，只有设备层真实注入坏插件、看屏幕与进程才抓得到 —— 这正是三层验收的价值：

1. **匹配面错**：`failedIds` 是 loader entry 的 **name**（＝包名），不是挂载清单里的 `- id:` 字段；按 id 匹配恒 **0 命中**，条目拔不掉（外科分支永远走不到）。
2. **只 `showWeb` 不 `reload`**：数据修好了，但屏幕停在同一份已渲染的失败页 —— 用户视角「没修好」。
3. **`startEngine` 不带 `force`**：引擎不重启、继续服务旧 manifest，于是 reload 也只会拿回**同一份坏清单**，表现为「回滚了但没变化」。
4. **`reload` 早于引擎 listen**：WebView 先导航、端口尚未监听 ⇒ `ERR_CONNECTION_REFUSED`，界面反而显示「页面加载失败」，把真实原因盖掉。

四条的修法已并入本版；复验同时留了正反证据（注入 → 契约行 → `boot-fail` 终态 → 自动拔除 `pulled plugin=@dsh-android/dsh-client-bad-probe` → 引擎 PID 更换 → 自动重载恢复）。

## 三、一并修掉的两条既有缺陷

- **注入层模板字面量吞反斜杠**：`BOOT_WATCHDOG_SCRIPT` 模板体内的单反斜杠（`\s` 等未知转义）在求值时被**丢掉**，
  页面实收退化正则，把 `@dsh-android/dsh-client-bad-probe` 改写成 `@dh-android/...`，`ID_SHAPE` 全不匹配 ⇒ **`failedIds` 恒为 `"-"`、`failedCount=0`**。
  更关键的一层：原单测用手写解码表复现转义，而手写表对未知转义**保留**反斜杠、JS 模板却**丢掉** —— 测试比引擎宽容，
  于是「单测全绿而真机红」。修法 = 源码写双反斜杠 + 测试改用 `new Function` 求值取页面真实字节。
- **旧 `publishReady()` 把失败页当「已就绪」**：上游 `BootPage` 构造即在 `#root` 下挂 `[data-dsh-boot]`，旧判据只看「`#root` 有子节点」
  ⇒ 约 500ms 就发 `[dsh-boot-ready]`，导致 ① 块L 的 shell-stall 诊断实际**永不触发**、② `pageRecovery.pageReady()` 每次清零 `loadErrorRetryUsed`（重试预算形同不存在）。
  修法 = 判据改为 `rendered() && !bootPagePresent()`；**副作用**：健康启动的 ready 时间点从约 500ms 后移到真首帧之后。

## 四、破坏性变更

无已知破坏性变更。versionCode 单调递增（45 -> 46），可直接覆盖安装。

## 五、合规

第三方许可与 GPL 源码要约见随包 `assets/licenses/THIRD_PARTY_NOTICES.md` 与仓库 `LICENSES/`。

## 六、构建与产物

- 本 Release 的最终产物哈希以 `MANIFEST.txt` 与各资产为准（发布链从源重建）。
- 双 ABI 产物由发布链产出；本版本地只跑了 `-devplug` 档单 ABI 全链。

## 七、已知缺口（如实登记，见 `docs/AGENTS/known-gaps.md`）

- 自有插件（硬清单成员）在浏览器侧装配失败：外科拔除被安全规则拒绝、配置回滚也修不了代码 → 停在错误页 + 安全模式 + 诊断包，不假装能自愈。
- 注入层自身未加载（连契约行都发不出来）时仍只有上游 `console.error` 落 `source=console-error`，不做动作。
- 隔离 `BrowserHost` 页面内的插件失败不在本契约内（本轮只覆盖主 WebView）。
- WebView 内核过旧导致的 polyfill 缺口（坑 61 族）回滚无效，属另一条线。
