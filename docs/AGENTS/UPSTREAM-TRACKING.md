# 参考上游更新跟踪

本仓独立维护；`kelai141/dsh-mobile-apk` 是参考来源，不是构建依赖或镜像权威。按问题选择性移植，每个逻辑改动独立 PR，保留出处，重新审查本仓安全约束并按风险分档验证。上游发布和测试不代替本仓验收。

## 检查规则

- 建议每周及准备发版时检查；本文件不创建定时任务。
- 后续从上次检查游标查看新增提交，并复查暂缓项的触发条件。游标表示已检查范围，不表示已吸收。
- 每项记录本仓判断、处置和证据链接；实现后追加对应 PR 与验证结论，不把静态判断写成设备通过。
- 引擎升级单独处理依赖、补丁、插件 peer、槽位契约和夹具；不得只换版本号。应用身份、签名、来源链与插件能力边界继续以本仓规则为准。

## 2026-10-19 首次检查

| 项 | 记录 |
|---|---|
| 参考仓库 | https://github.com/kelai141/dsh-mobile-apk |
| 检查游标（main） | `18439f1b8cb96f7d4d9b8508bdb02aa2695143a3`，提交时间 2026-10-18 21:00:09 +0800 |
| 本仓对照提交 | `aa33edf0560e84b0717eaa52e5dc56eac141cb09` |
| 检查范围 | main 最近 30 条提交列表、重点提交说明/文件范围和相关本仓实现；非全仓逐行差异审计 |
| 最新公开 Release | [v0.14.8](https://github.com/kelai141/dsh-mobile-apk/releases/tag/v0.14.8)；发布说明中的验证缺口未视作通过 |
| 方法与边界 | GitHub 页面与只读 API、本地源码检索；未移植代码、未构建、未做设备验证 |

以下优先级是后续建议，不代表已启动实施或已承诺发版。

| 优先级 | 上游更新 | 本仓静态判断 | 处置与重新评估条件 |
|---|---|---|---|
| 已吸收（2026-10-19） | [#414 堆上限 1024→4096](https://github.com/kelai141/dsh-mobile-apk/pull/414)，源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`，上游合并提交 `f2df6fa0d2a3b70f171f2a28ed3f020dcad5997a` | 双源上限提升至 4096MB；并修复 1024 上限等于 V8 自然上限标志造成的自适应退化，新增自然标志真源及防退化门禁 | JVM 机型档断言、wrapper 反例和 11 条门禁负控已同步；设备内存压力未验，见 [SECURITY-HARDENING.md](SECURITY-HARDENING.md) 与 [known-gaps.md](known-gaps.md) |
| P1 | [#420 ADB 键盘投递与来源校验](https://github.com/kelai141/dsh-mobile-apk/pull/420) | manage 已显式指定接收组件；`AdbKeyboardReceiver.kt` 已在接收器上调用 `getSentFromUid()`。接收器仍无处理结果码回传 | 只评估剩余回执、绑定重试与接收器分工；适配本仓 namespace、鉴权和失败语义，防双提交与假成功 |
| P1 | [#403 虚拟屏比例与弹层遮挡](https://github.com/kelai141/dsh-mobile-apk/pull/403) | 本仓未检出上游新增的 `data-dsh-popover-open` 信号；这不单独证明设备必现遮挡 | 建议先复现，再定点移植布局/原生层可见性修复；与同 PR 的引擎升级拆分评估 |
| P2 | [#416 离线插件管理与启动即时反馈](https://github.com/kelai141/dsh-mobile-apk/pull/416) | `EngineStartFlow.kt` 中 Starting 反馈仍位于探测之后；`PluginManagementPage.kt` 未检出离线管理实现 | 建议独立实现；复核 soft/hard 边界、配置原子写入及回读，避免破坏本仓恢复与授权策略 |
| 已实施，最终候选待验 | [#403 引擎 0.2.1-rc.2](https://github.com/kelai141/dsh-mobile-apk/pull/403)、[#408 模型能力设置](https://github.com/kelai141/dsh-mobile-apk/pull/408) | 官方目标独立源码构建，重核来源链、PTC 两路、peer/槽位/路由与真实夹具；模型能力插件保留 | 本仓实现与证据统一见 [升级记录](ENGINE-UPGRADE-2026-10-19.md)；未引入同 PR 的虚拟屏 UI 修复，未借用参考设备结论 |
| 可选 | [#411 双工作区与紧凑控制窗](https://github.com/kelai141/dsh-mobile-apk/pull/411)、[#412 抽屉常驻挂载](https://github.com/kelai141/dsh-mobile-apk/pull/412)、[#415 悬浮球隐藏召回](https://github.com/kelai141/dsh-mobile-apk/pull/415) | 属于交互扩展；本轮只核查部分变更范围，未逐项完整审计 | 暂缓，明确产品需求后评估；重点看常驻挂载内存、召回条命中区域、横竖屏和 overlay 生命周期 |
| 暂不移植 | [#418 原生启动失败修复助手](https://github.com/kelai141/dsh-mobile-apk/pull/418) | 新增 RepairTools 等壳侧模型工具与文件写入/命令能力，偏离本仓“AI 可见能力全部来自插件”的边界 | 保留启动失败恢复需求；只有经过本仓架构与安全审查、形成符合插件边界的方案后再评估实现 |
| 已有相关实现 | [#383 Shizuku 分支兼容](https://github.com/kelai141/dsh-mobile-apk/pull/383)、[#402 重置后重建](https://github.com/kelai141/dsh-mobile-apk/pull/402)、[#393 导航栏透明](https://github.com/kelai141/dsh-mobile-apk/pull/393) | ExternalLinks 已含 Stellar；ShizukuTransport 已先注销连接缓存再移除服务；WebUiChrome 已关闭导航栏对比度叠加 | 不重复移植；只确认相关代码存在，未声明与上游完整等价或已做本轮设备验证 |

本次没有把上游应用更新、旧签名、双 ABI 发布、协调仓镜像规则作为待吸收能力；这些面以本仓现行政策为准。后续实现 PR 应回填本表，未解决项继续保留。

## 2026-10-19 吸收记录

本轮经 GitHub API 核对 #414 已合并：源提交 `15d83fa74ceae282e3abc02d94256c271d3bb4d4`，上游合并提交 `f2df6fa0d2a3b70f171f2a28ed3f020dcad5997a`。此前检查游标 `18439f1b8cb96f7d4d9b8508bdb02aa2695143a3` 仍是上游 `main` 当前尖端，故不前移。吸收不只提升上限：原上限 1024 恰等于重现 V8 自然 1120MB 堆上限的标志值，导致常见设备 `totalRam/2` 恒被截断；本仓新增自然标志真源、cap/区间宽度门禁、双源同为 1024 的反证，以及现实内存档 JVM 断言。设备内存压力仍待设备复核。
