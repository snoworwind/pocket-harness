# Engine base 复用：实现、实跑证据与收口状态（2026-10-19）

本文件记录 `build-base.yml` / `engine-base.mjs` 这套 engine base 复用机制在 PR #51（head `7ca0cae`）上的实现边界、PR #51 合并后的首次云端双构建结果，以及 `base-lock.json` 的收口步骤与当前证据。

当前状态：PR #51 与顺序确定性修复 PR #61 已合并。main commit `7fe0597` 的 run 39357008785 中 resolve、两个独立 build、完整 tree compare 与 cache 保存全部成功；候选 key 为 `engine-v1-941e395d…7a28`。真实候选已在临时 main clone 的 Linux gate 容器中通过 `materialize`，且 materialized runtime dependency 检查通过。当前独立 lock PR 正在提交该候选；它合入后再由来源草稿 workflow 验证真实 cache restore → materialize → ARM64 source build。未做设备验证，不能当作设备验收或公开发布依据。

---

## 1. 机制与判据

| 步骤 | 入口 | 判据 |
|---|---|---|
| plan | `engine-base.mjs plan` | 只允许已提交的 main、engine 输入无未提交改动；固定工具链后算出 `engine-v1-<hash>` key |
| build | `build-engine.sh` | 与 APK 来源链共用同一脚本，不另写第二套 |
| capture | `engine-base.mjs capture` | 校验 run/replica 身份与 plan 未漂移；只允许白名单内的构建期改动；复制后仅规范化 `engine-deploy/package.json` 与 `engine-deploy/pnpm-workspace.yaml` 的无序映射，再产出 tree receipt + tar.zst |
| compare | `engine-base.mjs compare` | 两份 manifest 必须同源、同 run、同 key；**实际输出树逐文件（sha256）一致**才写候选 lock |
| materialize | `engine-base.mjs materialize` | 先从 `base-lock.json` 验 key 与 manifest，再解包并与 tree receipt 逐条比对，最后落到工作区 |

设计意图是对的：base 不含 APK、签名密钥或项目插件产物；锁可信但缓存缺失时失败关闭。

依赖闭包回执在 `check-dsh-runtime-dependencies.mjs` 出口按 `(importer, dependency)` 排序；`first-party-deploy-injection.json` 和被其并入的 `source-build-policy.json` 因此不受文件系统枚举顺序影响。JSON canonicalizer 保留 `exports` / `imports` 的条件顺序；YAML canonicalizer 遇到序列或未识别形态即失败，不扩大归一化范围。

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

### 2.3 main 云端双构建（run 39354019902）

2026-10-20 的首次云端 run 39354019902 在 `2bcea5a` 上完成 resolve 及 primary/reference 构建；compare 以 `engine-base: independent engine output trees differ` 失败。它没有 candidate/cache，不能用于 `materialize` 或生成锁。

### 2.4 修复后 main 云端双构建与真实 materialize

run 39357008785 绑定 main commit `7fe0597ec1ed05ccf90b8de8418e104fea3e6b61`，resolve 18s、primary 9m59s、reference 6m21s；四个 job 均成功。compare 保留逐文件 tree 判据并通过，随后才写 cache 和上传唯一 canonical artifact `base-engine-engine-v1-941e395d4f7afbc62d77adf94e62837a640b0bd2e797aaee9c77604cee1b7a28`（679,533,164 bytes）。candidate manifest 的 SHA-256 为 `3fcc7aa697acd794956d9a05a5a1fb6257523d27c514547ca84faff6d9674053`，`independentRebuildMatched=true`，两 replica 的 tree SHA-256 同为 `fa2fe4fd3d7b8a7ac6d37220fe0869b6812855875c6abcaa8e8eb9ac07d92600`。`base-lock.mjs --verify` 与在临时 main clone 上的 `--check` 均通过。

真实 artifact 在 `pocket-harness-gate:24.04` Linux amd64 容器中运行 `engine-base.mjs materialize`，exit 0；随后 runtime checker 检到 345 packages / 2435 required links。再运行来源链固定 marketplace patch adapter，marketplace 5 项补丁成功应用、总登记 16/16 通过，materialized `lib/client.js` 与 `lib/index.js` 与 main 完全同字节。该 clone 的 marketplace 源码重置是 materialize 的设计步骤；后续来源 workflow 按固定 tarball 再施加补丁。

---

## 3. 未决问题（合并前必须处理）

### 3.1 `engine-toolchain.json` 的 Java 钉值不存在

**已修复（2026-10-20）**：钉值改为真实存在的 `17.0.20+8`，两条 workflow 的 setup-java 输入同步；并为来源链加了「无 `base-lock.json` 时跳过 plan」守卫，避免在无可恢复 base 时因工具链漂移打断 APK 构建。build-base run 39354019902 的 plan 成功，实际确认该修复已生效。原因记录如下。

`java: "17.0.20+1"` 不是 Temurin 的可用标识：Adoptium 的 API 对 `jdk-17.0.20+1` 返回 404，GitHub Releases 实际只有 `jdk-17.0.20+8`，其 `java.runtime.version` 为 `17.0.20+8`。`toolchain()` 对非 local 模式做全等比较，因此 `plan` 在任何满足本策略的 runner 上都会以 `runtime does not match fixed engine toolchain policy` 失败。

复验：runs 39354019902 与 39357008785 的 `plan` 均在固定 runner 上通过；新 run 的两条 build 也验证了 setup-java 与 toolchain 完全相符。

### 3.2 `buildRun` 让本地复跑结构性不可用

`plan` 把 `GITHUB_RUN_ID`（本地为 `local-<时间戳>`）写进 `plan.buildRun`，`capture` 再把它固定进 manifest；`compare` 要求两份 manifest 的 `buildRun` 相同且等于 plan 的 run。本地没有共享的 `GITHUB_RUN_ID`，所以任何本地双构建都停在 `replica source identity mismatch`——PR 描述的「用本机两份真实产物生成候选 lock」这条路径无法执行，而 CI 因两个 job 共享 `run_id` 不会暴露。

处理方向：提供显式 run 标识入口（如 `--run-id`），或让 `compare` 只要求两份 manifest 同属一个 run、不要求等于外层 plan 的 run。

### 3.3 `capture` 未归一化 pnpm 生成文件

`engine-base.mjs` 的路径 rebase 只覆盖 `REPORTS` 中除两个 overlay 文件以外的 `.json`（`rebase()` 调用点在同一文件）。`engine-deploy` 内的生成文件既不 rebase 也不稳定序列化：

- 绝对路径 `file:///workspace/...`：`package.json` 344 处、`pnpm-lock.yaml` 3349 处、`pnpm-workspace.yaml` 1 处；
- 顺序：依赖表、build-allowlist 与 runtime closure 记录按 pnpm 写入顺序落盘。

后果有两层：同路径双副本也可能因顺序不同而比较失败（§2.2 实测）；路径一变（另一构建目录、恢复后重跑、缓存跨 run 复用）内嵌路径就会与锁里的树不一致，`materialize` 的逐条比对必然失败。

PR #61 已按收窄方案修复：capture 仅对根 `package.json` 使用既有受限 JSON canonicalizer，对根 `pnpm-workspace.yaml` 使用严格块映射 canonicalizer；runtime dependency report 在生成端排序。YAML 序列/未知形态仍判红，缺依赖仍判红；没有文件从 tree 排除。run 39357008785 的两个 hosted replica 跨 runner 逐文件 compare 成功。报告及部署文件中的绝对 `file://` 路径保持原字节；本次固定 GitHub workspace 环境下相同，若未来不相同，完整 compare 仍会失败。跨目录本地双构建另受 §3.2 的 run identity 限制。

### 3.4 真实 `materialize` 已验证；来源链复用待候选构建确认

使用 run 39357008785 的真实 artifact 与 candidate lock，在 main commit `7fe0597` 的隔离 clone 中，固定 Linux gate image 的 `materialize` exit 0；`checkPayload` 在写工作区前核对 manifest 输出哈希、解包并逐项比较完整 tree receipt。materialized runtime checker 为 345 packages / 2435 links；marketplace patch adapter 与主线产物字节一致。最后一步是 lock PR 合并后运行 draft source workflow，让正式来源链通过真实 cache restore 和 materialize 再继续 ARM64 双构建。该 release draft 按用户要求不做设备验证，并会明确标记。

### 3.5 云端 checks 状态

PR #61 的 hosted PR checks 已通过；本地 Linux full local-gate 为 28/28，`check-code-map` 和 maintenance docs 均通过。run 39357008785 的 resolve/build/compare/cache/upload 四 job 全成功。剩余 release source build 尚未运行。

### 3.6 发布衔接顺序

candidate 与 cache 已由 run 39357008785 写入；当前 lock PR 将候选提交为仓内 trust root。合入后 `build-apk-source.yml` 会严格按 key/manifest 复用该 cache，缺 cache 失败关闭；本次草稿 release 的 source workflow 是 lock 合并后的集成复验。

---

## 4. 复验入口

已取得并仍须保留的复验证据：

1. Linux local-gate 28/28、PR #61 hosted static job；`engine-base.test.mjs` 的实际归档 compare 与缺依赖负控通过；`check-code-map`、maintenance docs 通过；
2. main run 39357008785 的两个独立 build/capture、完整 tree compare 与 cache/artifact upload 成功，candidate 标记 `independentRebuildMatched: true`；
3. 真实 candidate 在 Linux gate 容器 materialize 成功，post-materialize dependency closure 与 marketplace patch-byte parity 通过；
4. lock PR 合入后，draft source workflow 必须成功完成 cache restore → materialize → ARM64 source build。按用户要求该 draft 不做设备验证，notes 必须明确标注。

本文件记录的是实现边界与未决项，不构成任何验收结论；设备与发布链状态以 `docs/AGENTS/known-gaps.md` 与 `SECURITY-HARDENING.md` 为准。
