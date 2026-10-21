# DSH Linux 环境调查 · 文档索引

> 更新时间：2026-10-21
> 本轮状态：**第二份 2026-10-21 实机日志修正了上一轮的单一归因：`LD_LIBRARY_PATH` 已补，但 runtime manager 仍过滤 termux-exec 执行代理，导致 `find` 仍报 Permission denied；只加 `TERMUX_APP__DATA_DIR` 还会让 toybox 假成功。源码现已补齐经路径校验的宿主变量、GNU 工具身份探测、guest 变量隔离、状态文件诊断指引及 0.5.1 版本标识；本轮按用户要求未做实机测试，不能宣称 Linux 环境已恢复。** 详见 [termux-exec 修复记录](REMEDIATION-TERMUX-EXEC-2026-10-21.md) 与 [上一轮 LD_LIBRARY_PATH 记录](REMEDIATION-PLAN-LD-LIBRARY-PATH-2026-10-21.md)；Bionilux/glibc 执行入口仍是独立未验收门槛。
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
| 8 | [REMEDIATION-TERMUX-EXEC-2026-10-21.md](REMEDIATION-TERMUX-EXEC-2026-10-21.md) | 新日志揭示 termux-exec 环境仍被过滤、toybox 假成功风险及本轮修复 | 源码修复在 PR 分支；设备验证待做 |

## 三句话结论

1. **尚未实机确认恢复**：第二份日志显示 `LD_LIBRARY_PATH` 已在新包中，但 `cleanHostEnvironment()` 继续丢弃 `LD_PRELOAD`、两项 `TERMUX_EXEC__*`、`TERMUX__PREFIX` 与 `TERMUX_APP__DATA_DIR`，所以 `prepare-rootfs.sh` 仍在 `find` 处失败。只增加 `TERMUX_APP__DATA_DIR` 会容许 toybox 输出造成假绿。本轮源码从 `DSH_FILES_DIR/usr` 推导 termux-exec 环境，并先确认 GNU `find`/`sed`/`wc`；Bionilux guest 清理也覆盖 shebang overrides。错误指引现在指向 `files/linux-environment/linux-bootstrap-state.json`，插件与 Linux 资产版本升到 0.5.1。未做实机测试；bootstrap 激活修复、rootfs 准备和后续 Bionilux/glibc 执行仍须在 ARM64 设备分层复验。
2. **不是 bionilux 的 bug**：bionilux 是 bionic launcher + glibc preload，走的是“运行真 glibc”，不是 glibc→bionic 转换层；它必然依赖 `execve(glibc loader)`。
3. **恢复路线分阶段推进**：先让 bootstrap 正常提供状态服务；新 APK 上确认后，再验证 APK 原生目录的 launcher + 匹配 loader 和 guest 多级执行。10-19 的“不再投入实现”是当轮保留决策；10-20 已按用户要求重启方案研究，执行通路仍未验收。

## 当前保留的已知缺陷

- ① `ctx.filesDir` 激活故障：PR #77 已合入并由真实 Cordis `apply()` 回归及双构建验证；新草稿 APK SHA-256 为 `a2d1d85735b98a7168c0c5ea406a542518e5b9c1b82802a6ed0b2860d39d63dd`，尚未在设备上复验。SHA-256 为 `862e17cffc7bb4a5395ae960eec3f364c953ce73f476ac754f69bcd2166cadbf` 的修复前 APK 仍包含故障。
- ②/③ 硬链接问题的源码修复已在当前分支实现：解包根规范化并复核目录身份；平台明确拒绝 `link(2)` 时独占复制并保留 mode。定向测试通过，ARM64 实机未验。
- ④ **两轮日志共同确认；本轮源码修复，设备待验**第一轮缺少 `LD_LIBRARY_PATH`；第二轮虽已补库路径，但宿主子进程环境白名单仍丢失 termux-exec shim 与重写变量，shell 因 Android app-data ELF 执行限制在 GNU `find` 处报 EACCES/`Permission denied`。仅传 `TERMUX_APP__DATA_DIR` 可能静默执行 toybox；修复必须同时保留完整拦截环境并断言 GNU 工具身份。不把该错误误归因于 rootfs 损坏或仅凭 exit 0 判成功。
- ⑤ app 私有 glibc loader 的直接执行/可执行映射仍是独立未决问题；noexec 与 SELinux 归因需按实际进程和文件重新取证。
- ⑦ **源码已修、设备待验**安装失败不落盘、HTTP 500 错误码/文案泛化。
- 设计漂移：profile 默认插入 `linux-bootstrap`，与 D-014“不进入 profile/默认不启用”矛盾。

## 恢复工作的下一道门

bootstrap 激活修复已依据此前设备日志合入；termux-exec 子进程环境修复现位于 PR 分支，本轮未做设备验证。下一步用最终 ARM64 来源 APK 在目标设备确认 GNU `find`/`sed`/`wc` 身份通过、rootfs 准备完成且 Node smoke probe 成功，再继续执行入口探针：

1. 核对当前来源 APK 与资产同一性；当前源码已有 `BIONILUX_LOADER`，旧二进制观察不能覆盖它；
2. 在真实 app 进程内核对文件所属挂载、直接执行与可执行映射；
3. 同时验证 APK 原生目录中的 launcher 和 loader，以及多级子进程；
4. 主线不成立时按证据评估 PRoot 或显式授权的 Shizuku 后端。

详见 [当前方案](RECOVERY-PROPOSAL-2026-10-20.md) §3–§6。

## 备注

- 本目录是项目内维护的记录；原始外部 findings 副本不随本仓更正同步。
- PR #77 已改变 bootstrap 激活行为并生成未公开草稿；修复后设备验证与 Linux 执行链探针仍待完成。
- staging 与旧 hash 插件目录未清理；本轮仅修源码/来源输入和维护文档。
- 本目录已接入 `AGENTS.md` §3 与 `docs/AGENTS/known-gaps.md` 的导航；两处各加一行指针。


