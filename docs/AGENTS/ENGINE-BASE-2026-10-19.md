# Engine base 复用：实现、实跑证据与未决问题（2026-10-19）

本文件记录 `build-base.yml` / `engine-base.mjs` 这套 engine base 复用机制在 PR #51（head `7ca0cae`）上的实现边界、本机真实构建产物的验证结果，以及**尚未解决的问题**。

一句话结论：**PR Gate 与 Kotlin 门禁全绿；engine base 的 plan/capture 在真实产物上可用，但 compare 在真实产物上不通过，materialize 也因此尚未取得可信产物。合并前必须处理本文件 §3 的全部条目。**

---

## 1. 机制与判据

| 步骤 | 入口 | 判据 |
|---|---|---|
| plan | `engine-base.mjs plan` | 只允许已提交的 main、engine 输入无未提交改动；固定工具链后算出 `engine-v1-<hash>` key |
| build | `build-engine.sh` | 与 APK 来源链共用同一脚本，不另写第二套 |
| capture | `engine-base.mjs capture` | 校验 run/replica 身份与 plan 未漂移；只允许白名单内的构建期改动；产出 tree receipt + tar.zst |
| compare | `engine-base.mjs compare` | 两份 manifest 必须同源、同 run、同 key；**实际输出树逐文件（sha256）一致**才写候选 lock |
| materialize | `engine-base.mjs materialize` | 先从 `base-lock.json` 验 key 与 manifest，再解包并与 tree receipt 逐条比对，最后落到工作区 |

设计意图是对的：base 不含 APK、签名密钥或项目插件产物；锁可信但缓存缺失时失败关闭。

---

## 2. 实跑证据（2026-10-19 本机，非 CI）

环境：macOS + OrbStack `ubuntu:24.04` 容器，工具链按 `scripts/source-build/engine-toolchain.json` 钉版本（node 24.21.0 / python 3.12.15 / corepack 0.36.0）；**Java 实为 17.0.20+8**，与策略里的 `17.0.20+1` 不一致，见 §3.1。未在本机构建 APK。

### 2.1 门禁结果

| 项 | 结果 |
|---|---|
| PR Gate 静态 job（25 步，逐条对应 `pr-gate.yml`） | 25/25 rc=0（arm64、x86_64 各跑一遍） |
| 变更分类 | `full=true` / `apk=true`，Kotlin 门禁必须跑 |
| Kotlin `:app:testDebugUnitTest` | BUILD SUCCESSFUL；122/122 个测试类有结果，1322 用例（基线 1320） |
| `check-snapshot-decode --self-test-runtime` | 14/14 PASS |
| 维护文档一致性 | 受影响输入 `changed=false`，与 CI 同样跳过 |
| PR 定向测试 | `base-lock` + `engine-base` + `engine-base-workflow` 14/14；`test_base_archive.py` 2/2 |

### 2.2 engine base 真实产物

两份独立工作区各跑一次 `build-engine.sh`（均 exit 0，1285s / 1288s，上游 `dsh-v0.2.1-rc.2` + 项目 overlay），再依次执行 plan / capture / compare：

- `plan`：两份副本得到**同一 key** `engine-v1-12e277ff…c9`。
- `capture`：两份均 exit 0，tree receipt 各 70476 条；run 身份不一致时被正确拒绝。
- `compare`：**不通过**。强制对齐 `buildRun` 后，两份 `treeSha256` 仍不同（`cb6e798b…` / `5c8c0622…`），70476 条中 4 条不同。

根因分类（均为 pnpm 生成文件的非确定性，不是真正的语义差异）：

| 差异文件 | 差异形式 | 去掉路径归一化后的判定 |
|---|---|---|
| `engine-deploy/pnpm-workspace.yaml` | 8 行顺序不同 | 排序后完全相同 |
| `engine-deploy/package.json` | 348 个依赖顺序 + 尾逗号 | `JSON.parse` 后键集合、取值、root 字段全部相同 |
| `reports/first-party-deploy-injection.json` | 内嵌 2435 条记录顺序 | 集合完全相等（2435/2435） |
| `reports/source-build-policy.json` | 同上（同一段记录被并入） | 集合完全相等 |

证据保留在本机 `.deploy-tmp/verify-pr51-evidence/`（`RESULTS.md`、两份构建日志、差异文件原件、容器定义与各阶段脚本）。该目录不进仓库。

---

## 3. 未决问题（合并前必须处理）

### 3.1 `engine-toolchain.json` 的 Java 钉值不存在

**2026-10-20 已修复**：钉值改为真实存在的 `17.0.20+8`，两条 workflow 的 setup-java 输入同步；并为来源链加了「无 `base-lock.json` 时跳过 plan」守卫，避免在无可恢复 base 时因工具链漂移打断 APK 构建。原文如下。

`java: "17.0.20+1"` 不是 Temurin 的可用标识：Adoptium 的 API 对 `jdk-17.0.20+1` 返回 404，GitHub Releases 实际只有 `jdk-17.0.20+8`，其 `java.runtime.version` 为 `17.0.20+8`。`toolchain()` 对非 local 模式做全等比较，因此 `plan` 在任何满足本策略的 runner 上都会以 `runtime does not match fixed engine toolchain policy` 失败。

处理方向：改成真实存在的标识，或按 `java.runtime.version` 的前缀/主版本匹配，并把选择写进 `build-base.yml` 的 setup-java 输入。

### 3.2 `buildRun` 让本地复跑结构性不可用

`plan` 把 `GITHUB_RUN_ID`（本地为 `local-<时间戳>`）写进 `plan.buildRun`，`capture` 再把它固定进 manifest；`compare` 要求两份 manifest 的 `buildRun` 相同且等于 plan 的 run。本地没有共享的 `GITHUB_RUN_ID`，所以任何本地双构建都停在 `replica source identity mismatch`——PR 描述的「用本机两份真实产物生成候选 lock」这条路径无法执行，而 CI 因两个 job 共享 `run_id` 不会暴露。

处理方向：提供显式 run 标识入口（如 `--run-id`），或让 `compare` 只要求两份 manifest 同属一个 run、不要求等于外层 plan 的 run。

### 3.3 `capture` 未归一化 pnpm 生成文件

`engine-base.mjs` 的路径 rebase 只覆盖 `REPORTS` 中除两个 overlay 文件以外的 `.json`（`rebase()` 调用点在同一文件）。`engine-deploy` 内的生成文件既不 rebase 也不稳定序列化：

- 绝对路径 `file:///workspace/...`：`package.json` 344 处、`pnpm-lock.yaml` 3349 处、`pnpm-workspace.yaml` 1 处；
- 顺序：依赖表、build-allowlist 与 runtime closure 记录按 pnpm 写入顺序落盘。

后果有两层：同路径双副本也可能因顺序不同而比较失败（§2.2 实测）；路径一变（另一构建目录、恢复后重跑、缓存跨 run 复用）内嵌路径就会与锁里的树不一致，`materialize` 的逐条比对必然失败。

处理方向：对这三件套做路径归一化与定序序列化后再计入 tree，或把它们登记为「已知非确定性」并从树哈希中排除（并把该排除写进锁的 schema，避免静默放宽）。

### 3.4 `materialize` 尚未在真实产物上验证

因为 §3.2/§3.3，compare 至今没有产出过可信 base，`materialize` 只跑过单元测试夹具。修完前两条后必须在真实 base 上验证「materialize → build-engine 复用」这条链，否则 base 复用只是纸面承诺。

### 3.5 云端 checks 不可用

PR #51 的 checks 失败形态是 runner 未分配：job 列表全部 `steps: []`（零步骤），`main` 的 `7183386` 同形态失败，而更早的 run 有完整步骤且成功。这是计费/配额问题，换开发机不解决；恢复前「CI 全绿」这一项无法取得。

### 3.6 发布衔接顺序

`base-lock.json` 目前不在仓库里，`build-apk-source.yml` 在无锁时仍从源码构建，因此合并本 PR 不会立刻启用失败关闭。但一旦提交了候选锁，若对应缓存尚未由 `build-base.yml` 写入，构建会按设计失败关闭。发布时须保证「先产出并写入缓存 → 再提交锁」的顺序。

---

## 4. 复验入口

修完上述条目后，至少需要：

1. `node scripts/source-build/engine-base.mjs --self-test`；
2. 两份独立工作区跑 `build-engine.sh` → plan → capture → compare，并确认候选 lock 的 `independentRebuildMatched: true`；
3. 用该候选 lock 跑 `materialize`，再继续一次 engine 构建，确认复用路径可用；
4. 若改动涉及 workflow，`node scripts/source-build/check-workflow-action-pins.mjs --self-test` 与 `engine-base-workflow.test.mjs` 的负控必须仍会红。

本文件记录的是实现边界与未决项，不构成任何验收结论；设备与发布链状态以 `docs/AGENTS/known-gaps.md` 与 `SECURITY-HARDENING.md` 为准。
