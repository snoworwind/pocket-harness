# Pocket Harness 安全审查续审交接

本目录保存 2026-10-25 对 Pocket Harness 的 deep 全仓安全审查。审查基线为 `main` 提交 `b5a583be458c8ed10a914f4486932b15af7c7182`。这是一轮**未完成的部分审查**，不得表述成全仓通过或无漏洞。

## 当前结论

- 严格预算 80/80 次 agent 调用已用完，`run-metadata.json` 的状态为 `incomplete`，原因是 `validation_budget_exhausted`。
- 0 条 confirmed；17 条 `needs_validation` 记录经过最终记录复核；6 条 Phase 5 复核要求实质性改动，因此未写入 `findings.json`，仍保留为 coverage-ledger 中的 candidate。
- 覆盖账本：24 covered、20 candidate、4 blocked、3 deferred。一个 candidate 单元可能含多个指纹。
- 第 7 轮最终 coverage critic 仍返回 `stop:false`，发现 runtime-cache cleanup 执行生命周期缺口；预算不够再安排 hunter 和 critic。
- 必需的 OS-enforced sandbox 不可用，所以没有运行目标代码、测试、构建、Android 设备或模拟器验证。17 条记录都不是已确认漏洞，且没有严重性等级。

## 文件入口

- [run-1/REPORT.md](run-1/REPORT.md)：总报告、范围、预算、覆盖和未决状态。
- [run-1/NEEDS-VALIDATION.md](run-1/NEEDS-VALIDATION.md)：17 条最终复核保留的待验证线索，以及 6 条未复核候选的指纹与撤下原因。
- [run-1/FINDINGS-DETAIL.md](run-1/FINDINGS-DETAIL.md)：confirmed 结果（本轮为 0）。
- [run-1/findings.json](run-1/findings.json)：17 条最终保留的 needs_validation 结构化记录。
- [run-1/coverage-ledger.json](run-1/coverage-ledger.json)：51 个覆盖单元、审查路径、候选、阻塞与 deferred 记录。
- [run-1/run-metadata.json](run-1/run-metadata.json)：基线、scope、调用预算、critic 轮次和最终未决项。
- [run-1/architecture.md](run-1/architecture.md)：审查时的架构摘要。
- [run-1/phase5-records/](run-1/phase5-records/)：最终记录复核之前的 23 条候选记录输入。复核者返回的 6 份实质性修订在下文摘要中；修订 JSON 未单独落盘，后续 verifier 应基于原始记录与下列源事实重新构造并复核。

## 6 条待重新复核候选

以下原始记录仍可在 `run-1/phase5-records/` 找到。新一轮需用新增的独立 verifier 重新检查源代码，并产出完整的更正记录；不要直接把旧记录恢复到 `findings.json`。

1. **`EngineManager:shared-diagnostics-incomplete-redaction`（p5_01）**：`mirrorDiagnosticsToShared` 在 Documents 可写时使用共享目录，失败时回退到应用私有目录；共享 engine-log 副本只过 `EngineAuth.redact`，daily-log sink 使用更广的 `LogSanitizer` 规则。入口和读者暴露都要按实际目录条件限定。需要验证引擎是否输出额外密钥形态，以及共享路径和读者是否实际存在。
2. **`LogCollector:secret-redaction-chunk-boundary`（p5_03）**：源追踪应区分每次最多 256 KiB 的 engine.log 读取与按 tick 脱敏、写入 daily log 的过程。建议的合成夹具总长 786432 字节：三段各 262144 字节，第一段开头放 dummy PEM BEGIN，第二段全放无分隔符标记，第三段末尾放 dummy END；只观察合成输出。仍需确认实际引擎是否能生成足够长 PEM，以及部署是否落共享存储。
3. **`RootAccess:root-grant-revocation-dispatch-window`（p5_04）**：真实模型入口应从 `DeviceControlService.kt:678` 的 `shExec` 分发追到 `ShellOps.kt:159` 和 `RootAccess.kt:247` 的 su 启动；区分应用 AI RootGrant/同意与 Root 管理器授予 su 的授权。源显示撤销状态未共用命令 fence，但没有观测到检查到进程启动之间的并发撤销。
4. **`android-client-failure:console-provenance`（p5_06）**：应核对 console callback 缺少 source/frame 身份校验后，是否可经 `EngineStartFlow` 候选选择、`UndoGate` 恢复路径，最终写入插件隔离/quarantine patch。关键阻塞是支持的 WebView 是否把不可信预览子 frame 的 console message 交给该 callback；恢复状态门也必须保留在描述中。
5. **`android-saf:unbound-primary-document-id`（p5_08）**：不可信 provider URI 在 `ConfigTransfer.kt:94` SAF 结果 callback 进入，line 115 交给 `AndroidBridge.resolvePickedPath`；候选主路径在 `AndroidBridge.kt:660`。复核要判断 URI authority 是否绑定到 provider 返回的 `primary:<path>` ID，并检查 host/runtime 根目录限制。局部夹具应让测试 provider 返回一个与所选 provider 节点无关的 dummy primary path，而不只是测试 `.`。
6. **`undo.export.plaintext-encryption-staging`（p5_18）**：复核者提出可用 JSON 密码对象 `{"toString":1}` 触发 `String(password)` 转换异常；源中 ZIP 已写入最终路径后才转换/加密，catch 不删除它。需要在合规 sandbox 使用临时 `DSH_HOME`、合成 snapshot 和 dummy marker 验证残留；目录实际读者、同步/备份行为与真实敏感内容仍未知。

这些摘要描述的是需复核的源路径与验证建议，不是已验证的漏洞结论。特别是本轮没有合规 sandbox，不要在用户数据或生产目录上尝试夹具。

## 建议续审步骤

1. 从新的 run ID 开始，先确认源提交是否变化。若变化，重新核对每条来源路径；若未变化，也按 security-audit skill 的 prior `needs_validation` 规则建立当前 planned 单元并做新的 Phase 3 源复核，不能直接把旧记录当作当前证据。
2. 为上面 6 个 material replacement 分配新的独立最终 verifier；若源复核改变 root cause 或影响，先重新走候选验证，不要跳过阶段。
3. 为 `Runtime cache cleanup execution` 覆盖缺口安排 hunter，并保留 post-wave critic 和 distinct final-clean critic。同步检查两个 deferred 单元：root ownership/maintenance lease、engine-base reusable cache。
4. 为所有需要本地执行的线索准备 security-audit skill 要求的 OS-enforced sandbox（无外网、空 allowlist 环境、只读 target/toolchain、scratch-only 写入、明确资源上限）。Android/WebView、设备转移等平台事实另需隔离测试设备或 owner-observed 证据。
5. 续审前为新增候选、Phase 3 与 Phase 5 verifier、coverage critics 预留足额调用预算。只有全部 ledger candidate 有最终 disposition、coverage critic 达到 clean pass、两个 schema validator 通过后，才可把 run 标成 complete。

本目录是审计证据和交接材料，不是漏洞修复 PR；源码修复应另按项目原子 PR 流程处理。
