# DSH Linux 环境调查 · 文档索引

> 更新时间：2026-10-20
> 本轮状态：**提出恢复方案并纠正文档；未实施，未做设备验证。**
> 当前方案与源码更正：[RECOVERY-PROPOSAL-2026-10-20.md](RECOVERY-PROPOSAL-2026-10-20.md)；历史实机与保留决策：[LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md)。

## 阅读顺序

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 1 | [ORIGINAL-REPORT-2026-10-19.md](ORIGINAL-REPORT-2026-10-19.md) | 实机 agent 原始报告：5 个问题、调用链、证据 | 原始证据；部分归因已被后续修正 |
| 2 | [ORIGINAL-PATCHES-2026-10-19.md](ORIGINAL-PATCHES-2026-10-19.md) | 原始修复建议（4 个补丁） | 参考；W5/`BIONILUX_LOADER` 部分已失效 |
| 3 | [INVESTIGATION-2026-10-19-pocketharness.md](INVESTIGATION-2026-10-19-pocketharness.md) | 本仓源码复核、①②③④、本机复现、附录 B/C | 过程记录 |
| 4 | [REMEDIATION-PLAN-2026-10-19.md](REMEDIATION-PLAN-2026-10-19.md) | 修复计划 WP-1..7、WP-CI、W3-lite/W2/QEMU/JIT 评估 | 计划；**未执行** |
| 5 | [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md) | 历史汇总：两轮实机、可用性判定、保留决策、移除成本 | 归因与路线以 10-20 更正为准 |
| 6 | [RECOVERY-PROPOSAL-2026-10-20.md](RECOVERY-PROPOSAL-2026-10-20.md) | 当前源码复核、APK 原生执行入口方案、分阶段验收与备选 | 方案，未实施 |

## 三句话结论

1. **未恢复可用**：安装链仍有激活、解包和准备缺陷；旧实机观察到 glibc loader 直接执行失败，但尚不足以把真实文件挂载的 noexec 确定为唯一原因。
2. **不是 bionilux 的 bug**：bionilux 是 bionic launcher + glibc preload，走的是“运行真 glibc”，不是 glibc→bionic 转换层；它必然依赖 `execve(glibc loader)`。
3. **恢复路线已提出**：先验证 APK 原生目录的 launcher + 匹配 loader，再修安装链。10-19 的“不再投入实现”是当轮保留决策；10-20 已按用户要求重启方案研究，尚未实施或验收。

## 当前保留的已知缺陷

- ① `ctx.filesDir` 未修：`linux-bootstrap` 每轮 boot 激活崩溃，Linux 路由 503。
- ② 解包根未规范化：别名根下硬链接校验必失败。
- ③ 硬链接未加复制兜底：设备策略拒绝 `link(2)`。
- ④ 宿主准备脚本依赖 app 私有 ELF：noexec 下 `find` EACCES。
- ⑤ app 私有 glibc loader 直接执行受限；noexec 与 SELinux 等因素需按实际进程和文件重新取证。
- ⑦ 失败不落盘、错误码/文案泛化。
- 设计漂移：profile 默认插入 `linux-bootstrap`，与 D-014“不进入 profile/默认不启用”矛盾。

## 恢复工作的第一道门

不要从“修 ① 一行”开始。先做：

1. 核对当前来源 APK 与资产同一性；当前源码已有 `BIONILUX_LOADER`，旧二进制观察不能覆盖它；
2. 在真实 app 进程内核对文件所属挂载、直接执行与可执行映射；
3. 同时验证 APK 原生目录中的 launcher 和 loader，以及多级子进程；
4. 主线不成立时按证据评估 PRoot 或显式授权的 Shizuku 后端。

详见 [当前方案](RECOVERY-PROPOSAL-2026-10-20.md) §3–§6。

## 备注

- 本目录是项目内维护的记录；原始外部 findings 副本不随本仓更正同步。
- 10-20 只修改文档，不改变运行时行为。
- 本目录已接入 `AGENTS.md` §3 与 `docs/AGENTS/known-gaps.md` 的导航；两处各加一行指针。


