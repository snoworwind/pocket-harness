# DSH Linux 环境调查 · 文档索引

> 更新时间：2026-10-21
> 本轮状态：**更新后的 2026-10-21 实机日志确认所有 Linux 资产来自 APK 内置目录、安装全程离线；失败仍发生于 rootfs 预处理，宿主子进程缺少 `LD_LIBRARY_PATH` 令 Termux `find` 无法加载 `libandroid-support.so`。源码修复已实现并进行代码级验证；本轮按用户要求未做实机测试，不能宣称 Linux 环境已恢复。** 详见 [修复计划](REMEDIATION-PLAN-LD-LIBRARY-PATH-2026-10-21.md)；Bionilux/glibc 执行入口另属未验收门槛。
> 当前方案与源码更正：[RECOVERY-PROPOSAL-2026-10-20.md](RECOVERY-PROPOSAL-2026-10-20.md)；历史实机与保留决策：[LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md)。

## 阅读顺序

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 1 | [ORIGINAL-REPORT-2026-10-19.md](ORIGINAL-REPORT-2026-10-19.md) | 实机 agent 原始报告：5 个问题、调用链、证据 | 原始证据；部分归因已被后续修正 |
| 2 | [ORIGINAL-PATCHES-2026-10-19.md](ORIGINAL-PATCHES-2026-10-19.md) | 原始修复建议（4 个补丁） | 参考；W5/`BIONILUX_LOADER` 部分已失效 |
| 3 | [INVESTIGATION-2026-10-19-pocketharness.md](INVESTIGATION-2026-10-19-pocketharness.md) | 本仓源码复核、①②③④、本机复现、附录 B/C | 过程记录 |
| 4 | [REMEDIATION-PLAN-2026-10-19.md](REMEDIATION-PLAN-2026-10-19.md) | 修复计划 WP-1..7、WP-CI、W3-lite/W2/QEMU/JIT 评估 | WP-3/WP-4 已在当前分支实现；设备未验；其他项仍为计划 |
| 5 | [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md) | 历史汇总：两轮实机、可用性判定、保留决策、移除成本 | 归因与路线以 10-20 更正为准 |
| 6 | [RECOVERY-PROPOSAL-2026-10-20.md](RECOVERY-PROPOSAL-2026-10-20.md) | 当前源码复核、APK 原生执行入口方案、分阶段验收与备选 | 激活缺陷已合入并出草稿；执行入口方案待设备验证 |
| 7 | [REMEDIATION-PLAN-LD-LIBRARY-PATH-2026-10-21.md](REMEDIATION-PLAN-LD-LIBRARY-PATH-2026-10-21.md) | 21 日安装日志的 `LD_LIBRARY_PATH` 根因、源码修复与验收门槛 | 源码已修；设备验证待做 |

## 三句话结论

1. **尚未实机确认恢复**：更新后的日志证明 APK 内置资产复制、摘要校验和解包成功，安装不联网；`prepare-rootfs.sh` 的 `find` 因宿主子进程缺少 `LD_LIBRARY_PATH` 无法加载 `libandroid-support.so`。源码已为宿主工具和 launcher 传入应用 Termux 库目录，并让 Bionilux 从 guest 环境剔除该变量；本轮未做实机测试。bootstrap `ctx.filesDir` 激活故障已由 PR #77 修复，后续 Bionilux/glibc 执行入口仍未验收。
2. **不是 bionilux 的 bug**：bionilux 是 bionic launcher + glibc preload，走的是“运行真 glibc”，不是 glibc→bionic 转换层；它必然依赖 `execve(glibc loader)`。
3. **恢复路线分阶段推进**：先让 bootstrap 正常提供状态服务；新 APK 上确认后，再验证 APK 原生目录的 launcher + 匹配 loader 和 guest 多级执行。10-19 的“不再投入实现”是当轮保留决策；10-20 已按用户要求重启方案研究，执行通路仍未验收。

## 当前保留的已知缺陷

- ① `ctx.filesDir` 激活故障：PR #77 已合入并由真实 Cordis `apply()` 回归及双构建验证；新草稿 APK SHA-256 为 `a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`，尚未在设备上复验。SHA-256 为 `862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf` 的修复前 APK 仍包含故障。
- ②/③ 硬链接问题的源码修复已在当前分支实现：解包根规范化并复核目录身份；平台明确拒绝 `link(2)` 时独占复制并保留 mode。定向测试通过，ARM64 实机未验。
- ④ **本次实机确认；源码已修、设备待验**宿主准备脚本子进程丢失 `LD_LIBRARY_PATH`，Termux `find` 找不到 `libandroid-support.so`，shell 将动态链接失败呈现为 EACCES/`Permission denied`；不把这次错误归因于 noexec。
- ⑤ app 私有 glibc loader 的直接执行/可执行映射仍是独立未决问题；noexec 与 SELinux 归因需按实际进程和文件重新取证。
- ⑦ **源码已修、设备待验**安装失败不落盘、HTTP 500 错误码/文案泛化。
- 设计漂移：profile 默认插入 `linux-bootstrap`，与 D-014“不进入 profile/默认不启用”矛盾。

## 恢复工作的下一道门

bootstrap 激活修复已依据此前设备日志合入；10-21 子进程环境缺失的源码修复已实现。本轮未做设备验证。下一步由最终 ARM64 来源 APK 在目标设备确认 rootfs 预处理越过 `find` 且 smoke probe 成功，再继续执行入口探针：

1. 核对当前来源 APK 与资产同一性；当前源码已有 `BIONILUX_LOADER`，旧二进制观察不能覆盖它；
2. 在真实 app 进程内核对文件所属挂载、直接执行与可执行映射；
3. 同时验证 APK 原生目录中的 launcher 和 loader，以及多级子进程；
4. 主线不成立时按证据评估 PRoot 或显式授权的 Shizuku 后端。

详见 [当前方案](RECOVERY-PROPOSAL-2026-10-20.md) §3–§6。

## 备注

- 本目录是项目内维护的记录；原始外部 findings 副本不随本仓更正同步。
- PR #77 已改变 bootstrap 激活行为并生成未公开草稿；修复后设备验证与 Linux 执行链探针仍待完成。
- 本目录已接入 `AGENTS.md` §3 与 `docs/AGENTS/known-gaps.md` 的导航；两处各加一行指针。


