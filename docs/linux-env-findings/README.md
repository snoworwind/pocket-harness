# DSH Linux 环境调查 · 文档索引

> 更新时间：2026-10-19
> 本轮状态：**不移除功能，不修改代码；只新增本目录的调查与决策记录。**
> 权威记录：[LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md)

## 阅读顺序

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 1 | [ORIGINAL-REPORT-2026-10-19.md](ORIGINAL-REPORT-2026-10-19.md) | 实机 agent 原始报告：5 个问题、调用链、证据 | 原始证据；部分归因已被后续修正 |
| 2 | [ORIGINAL-PATCHES-2026-10-19.md](ORIGINAL-PATCHES-2026-10-19.md) | 原始修复建议（4 个补丁） | 参考；W5/`BIONILUX_LOADER` 部分已失效 |
| 3 | [INVESTIGATION-2026-10-19-pocketharness.md](INVESTIGATION-2026-10-19-pocketharness.md) | 本仓源码复核、①②③④、本机复现、附录 B/C | 过程记录 |
| 4 | [REMEDIATION-PLAN-2026-10-19.md](REMEDIATION-PLAN-2026-10-19.md) | 修复计划 WP-1..7、WP-CI、W3-lite/W2/QEMU/JIT 评估 | 计划；**未执行** |
| 5 | [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](LINUX-ENV-COMPLETE-RECORD-2026-10-19.md) | **最终汇总**：两轮实机、真因、可用性判定、保留决策、移除成本、路线决策门 | **权威** |

## 三句话结论

1. **不可用**：插件能加载、bionilux 能启动，但本 ROM 的 `/data/data` 是 `tmpfs noexec`，glibc loader 无法被内核 exec；W5（外部 loader）已实测失败。
2. **不是 bionilux 的 bug**：bionilux 是 bionic launcher + glibc preload，走的是“运行真 glibc”，不是 glibc→bionic 转换层；它必然依赖 `execve(glibc loader)`。
3. **本轮不移除**：移除涉及构建链、来源资产、插件/厂商、Kotlin 桥、工作流、门禁、测试与文档（审计约 100 个一手文件）；设备不在线，删除风险高于收益。保留为实验性、不宣称可用、不再投入实现。

## 当前保留的已知缺陷

- ① `ctx.filesDir` 未修：`linux-bootstrap` 每轮 boot 激活崩溃，Linux 路由 503。
- ② 解包根未规范化：别名根下硬链接校验必失败。
- ③ 硬链接未加复制兜底：设备策略拒绝 `link(2)`。
- ④ 宿主准备脚本依赖 app 私有 ELF：noexec 下 `find` EACCES。
- ⑤ noexec + glibc loader：运行时结构性阻塞。
- ⑦ 失败不落盘、错误码/文案泛化。
- 设计漂移：profile 默认插入 `linux-bootstrap`，与 D-014“不进入 profile/默认不启用”矛盾。

## 将来重启时的第一道门

不要从“修 ① 一行”开始。先做：

1. W3-lite-A：APK native lib 的 mode/SELinux 是否允许 exec；
2. W2a：`memfd+fexecve` 能否加载 glibc loader；
3. `/data/local/tmp` 对 app 的 read/traverse/exec；
4. Shizuku 是否可用（W3）；
5. QEMU linux-user 的 `node --version` 与 apt/dpkg 路径语义（仅 PoC）。

详见总记录 §10。

## 备注

- 本目录是项目内的权威副本；原始工作副本保留在外部 findings 目录（不在仓内），内容相同，链接已改为本目录相对路径。
- 本轮只新增文档，不改任何代码；`git status` 只应出现 `docs/linux-env-findings/`、`AGENTS.md` 与 `docs/AGENTS/known-gaps.md` 的文档指针。
- 本目录已接入 `AGENTS.md` §3 与 `docs/AGENTS/known-gaps.md` 的导航；两处各加一行指针。


