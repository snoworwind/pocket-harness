# 安全审计流程与材料归档

本项目的安全审计、漏洞研究与渗透测试方案使用 Cloudflare 的 `security-audit` skill。原始仓库：[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)。如需安装，按该仓库说明运行：

```bash
npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit
```

运行时使用名称为 `security-audit` 的 skill。不要把 skill 的副本当作本仓维护的实现；每轮审计应在记录中注明 skill 版本或上游 commit、被审源码 commit、工作区是否干净、审计范围、profile 与执行边界。每轮开始时读取当前安装目录内的完整 `SKILL.md` 及其引用的阶段文档；本页只规定本项目的选择与归档口径，不缩减上游要求。

## 选择审计模式

- 安全问题咨询、聚焦检查、发现项分诊或方法讨论使用 guidance mode，只执行与问题相关的部分，不自动启动全仓流程或生成完整审计产物。
- 用户明确要求代码库审计、渗透测试、全面/端到端审查或审计报告时使用 full audit mode，按 skill 的六个阶段完整执行。不得把单轮或局部检查描述成全仓覆盖。

## Full audit 阶段

1. **Reconnaissance**：梳理架构、信任边界、输入面、本地构建路径和历史审计；建立确定性的 coverage ledger。
2. **Coverage-led hunting**：按 ledger 分配隔离的 hunter；每轮后用 coverage critic 检查覆盖缺口。
3. **Candidate validation**：将每个候选交给独立的新 verifier，尝试证伪并确认边界、影响和最小有效修复。
4. **Structured output**：以 `findings.json` 保存 `confirmed`、`needs_validation` 和 `rejected` 记录，并通过 skill 提供的 findings 与 coverage validators。
5. **Independent record verification**：由独立 verifier 复核最终记录中的源码路径和证据，发现实质变化时重新验证。
6. **Target-neutral reporting**：从最终结构化记录与 coverage ledger 生成 `REPORT.md`、`FINDINGS-DETAIL.md` 和 `NEEDS-VALIDATION.md`。

遵守 skill 对 prior runs、coverage、profile、预算和终态的要求。`needs_validation` 必须写出具体缺失事实，不赋严重级别；没有可证明的跨边界影响时，不按 checklist 缺项报告漏洞。

## 执行与证据边界

- 源码检查默认只读。只有能提供 skill 要求的 OS 强制沙箱时，才运行目标控制的构建、测试、进程、浏览器、模拟器、fuzzer 或 fixture；沙箱须禁外网、使用显式安全环境变量白名单、限制资源，并将写入限制在专属 scratch。无法满足时不执行目标代码，记录精确的 `needs_validation` 阻塞与安全验证方案。
- 不探测生产端点、外部服务、共享基础设施或他人数据。使用虚构主体、合成数据和 dummy secrets；只做确认缺陷所需的最小本地验证。
- 证据需绑定源码 commit、触发条件、源码调用链、验证命令和实际结果，并明确未覆盖部分。不得把静态检查写成运行时验证，也不得把环境事实缺失猜成安全或不安全。
- 共享审计文件仅由主审维护；代理各用独立 scratch。按 skill 规定验证产物后，才可将最小、无秘密且可复核的审计材料留存。

## 归档位置

每次审计在 `docs/AGENTS/` 下新建 `SECURITY-AUDIT-<短哈希>/run-<N>/`，其中 `<短哈希>` 是被审查提交完整 SHA 的前 7 位，`<N>` 是该提交目录下下一个未使用的轮次序号；必须以被审查提交为准，不得使用当前分支 HEAD 或审计结束时的提交。每份报告正文都要明确记录**审查日期**与**被审查提交完整 SHA**。`run-metadata.json` 也必须记录完整 source ref、审计日期与范围。

同一源提交的多轮或不同范围审计共用短哈希目录，并为每轮新建 `run-<N>/`，不得覆盖已有记录。完整审计按 skill 的产物清单保存 `run-metadata.json`、`architecture.md`、`coverage-ledger.json`、`findings.json`、三个报告及必要的 validator 结果。

仓库根 `.gitignore` 忽略 `docs/AGENTS/SECURITY-AUDIT-*/`，以满足 skill 对用户指定仓内输出目录的条件。full audit 启动前须用 `git check-ignore` 确认整个新目录受忽略规则保护；scratch 按 skill 的隔离要求管理。validators 通过并经主审复核后，才显式提交用户要求归档的最终材料；绝不提交 scratch、未验证候选或秘密。

仅归档经验证的最终材料，不归档 agent scratch、原始环境变量、凭据、令牌、用户数据或未经核验的目标进程输出。既有平铺审计与修复记录保留原路径，除明确迁移任务外；后续审计在对应短哈希目录中按轮次新增文件或子目录，不覆盖历史记录。
