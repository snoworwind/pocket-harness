# 构建拆分与复用（2026-10-19）

> 状态：**已复核，按阶段执行**。本文件先固定组件边界、信任根、策略边界与验收判据；具体工作流按 §8 分 PR 落地。
> 关联：`docs/AGENTS/build-and-env.md`、`docs/AGENTS/SECURITY-HARDENING.md`、`docs/AGENTS/RUNTIME-PATCHES.md`、`AGENTS.md` §4.9。
> 目标：把可分离的构建拆成组件，按输入哈希复用；只重建真正变化的组件；发布候选仍从源码全量重建。

---

## 1. 背景

`build-apk-source.yml` 当前是单 job 矩阵，`primary`/`reference` 两个副本每次都完整重跑：

1. checkout 固定 upstream Harness，pnpm install/build/deploy，打补丁和 overlay；
2. Termux bootstrap、签名仓库、`node-pty` 交叉编译、组装 base；
3. Linux assets（Debian rootfs、bionilux、glibc Node）；
4. 快照、Kotlin、APK、双构建比对、签名。

其中 engine、Termux base、Linux assets 只在**上游/补丁/工具链输入变化**时才变，普通 app/插件改动不需要重编。但当前没有 `actions/cache`，也没有组件级 artifact，导致每次全量。

## 2. 复核结论：原方案必须先修正的五点

1. **不能绕过来源链宗旨**：现有文档明确“APK 来源链在自身运行中重建资产，不依赖短期 artifact”（`build-and-env.md` §0.2.1）。复用编译 base 必须显式改变这条口径，并保留发布候选 `no-cache` 全量双构建；不能默认把旧产物当源码。
2. **信任根不能在包里**：如果 manifest 和产物从同一 artifact 下载，篡改产物同时篡改 manifest，哈希校验是循环的。必须有**仓内、经 PR 审查的 `base-lock.json`** 作为信任根，锁定 `key / manifestSha256 / outputs`。
3. **双构建不能名存实亡**：两个 replica 都吃同一 base，engine/Termux 层的独立性就没了。新 key 首次发布必须**双构建并比对**；日常只允许单副本；发布候选 `no-cache` 双构建。
4. **GitHub cache 不是长期库**：cache 10 GB/仓库、7 天不用会淘汰；artifact 30 天。要“手动跑新版、直接拿来用”，需要 cache + artifact + GHCR/Release 之一，且缺件必须能重建。
5. **路径过滤不能误跳过**：未知路径必须 `full=true`；改 engine/patches 时不能只跑 APK；改 app 时不能重编 engine；否则会制造假绿。

## 3. 决定

采用**组件图 + 内容键 + 仓内锁 + 双构建证明**：

- 可复用组件：`engine`、`termux-base`（含 `node-pty` binding）、`linux-assets`；
- 每 commit 重建：`plugins`、`snapshot`、`APK`、`sign`；
- 组件 key 只由输入哈希决定，不使用 `github.sha`；
- 组件发布时生成 `manifest.json`（输入、输出、工具链、来源 run），并写入仓内 `base-lock.json`（经 PR 审查）；
- app 构建只消费 lock 中的 key，restore 后按 lock → manifest → 输出三层校验；
- 新 key 首次双构建；发布候选 `no-cache` 全量双构建；日常单副本。

## 4. 组件图

```text
upstream Harness(固定 commit) + overlay/patches/toolchain
        └─> engine-key      ──> base-engine-<key>.tar.zst + manifest

bootstrap(固定 SHA) + signed repo + preinstall + node-pty + engine lock
        └─> termux-key      ──> base-termux-<key>.tar.zst + manifest

linux-inputs + vendor/bionilux + build scripts
        └─> linux-key       ──> base-linux-<key>.tar.zst + manifest

project plugins/client/web
        └─> plugin-key      ──> plugins-<commit>.tar.zst

engine + termux + linux + plugins + 项目 commit
        └─> snapshot-key    ──> snapshot-<commit>.tar.xz

snapshot + Kotlin/app assets
        └─> APK ──> 隔离签名
```

## 5. 组件与键

| 组件 | 输入键包含 | 复用 | 重建触发 |
|---|---|---|---|
| **engine** | `scripts/contract.json` upstream commit、`engine-overlay.json`、`engine-overlay-licenses.json`、`scripts/patches/**`、engine 构建脚本、Node/pnpm/Python 版本 | 是 | 任一输入变化 |
| **termux-base** | bootstrap SHA、签名仓库/preinstall、`prepare-termux-*.py`、`build-node-pty-android.mjs`、engine lock/版本、NDK/Node | 是 | 任一输入变化 |
| **node-pty binding** | node-pty 版本、Termux headers、NDK | 是 | 版本/headers 变化 |
| **linux-assets** | `linux-inputs.json`、`linux-source-manifest.json`、`vendor/bionilux/**`、`vendor/dsh-linux-runtime/**`、Linux 构建脚本 | 是 | Linux 输入变化；不随 app 改动重建 |
| **plugins** | `plugins/**`、`dsh-shell-termux/**`、client/web 源 | 按 commit | 插件/客户端变化 |
| **snapshot** | 所有 base key + 项目 commit | 否 | 任何下游变化 |
| **APK** | snapshot + `app/**`/Gradle/assets | 否 | app 或 snapshot 变化 |
| **sign** | APK | 否 | 每次出包，隔离 job |

**不缓存**：项目插件、snapshot、APK、签名密钥、最终发布资产。

### 5.1 key 计算

- 只哈希**输入文件内容 + 相对路径**，排序后计算 SHA-256；不哈希 `.git`、`node_modules`、`.deploy-tmp`。
- 必须包含工具链版本（Node/pnpm/Python/JDK/NDK）与 runner 镜像（固定 `ubuntu-24.04`，不用 `ubuntu-latest`）。
- 不使用 `github.sha`；不使用宽泛 `restore-keys`。
- key 前缀带 schema 版本，算法变更即失效。

### 5.2 `base-lock.json`

仓内文件，经 PR 审查，是信任根：

```json
{
  "schema": 1,
  "components": {
    "engine": {
      "key": "engine-v1-<sha256>",
      "manifestSha256": "<sha256>",
      "artifact": "base-engine-<key>.tar.zst",
      "buildRun": 123456789,
      "sourceCommit": "<repo sha>",
      "upstreamCommit": "<upstream sha>"
    },
    "termux": { "key": "...", "manifestSha256": "...", "artifact": "..." },
    "linux": { "key": "...", "manifestSha256": "...", "artifact": "..." }
  }
}
```

- app workflow 只读 lock；不直接相信 artifact 名。
- `check-base-lock` 重算 key；不一致即失败，要求 PR 同步更新 lock。
- 手动构建新 base 后，由 PR 更新 lock；base workflow 不直接 push main。

### 5.3 `manifest.json`

每个 base 产物带 sidecar manifest：

- `schema`、`component`、`key`；
- 输入：repo commit、upstream commit、文件哈希、工具链版本；
- 输出：文件列表、大小、SHA-256；
- 构建：workflow run id、runner 镜像、双构建 replica 结果；
- `cacheHit`/`restoredFrom`（若复用）。

app workflow 校验顺序：**lock → manifest SHA → outputs SHA**。任一不符，失败关闭。

## 6. 工作流

### 6.1 `build-base.yml`（新增，`workflow_call` + `workflow_dispatch`）

输入：

- `component`: `engine|termux|linux|all`
- `ref`: 默认 `main`
- `force`: 忽略 cache，强制重建
- `publish`: `cache|artifact|ghcr`（默认 cache+artifact）

要求：

- 只接受 `refs/heads/main`；
- 新 key 首次运行 `primary`/`reference` 双构建并比对；
- 输出 `base-<component>-<key>.tar.zst` + `manifest.json` + `base-lock.candidate.json`；
- cache 只在 main 写；PR 只读；
- 失败不更新 lock。

### 6.2 `build-apk-source.yml`（改造）

- `resolve` job：读 `base-lock.json`；检查各组件 cache/artifact 是否存在；
- 命中：restore + 校验 lock/manifest/outputs；
- 缺失：默认失败并提示先跑 `build-base.yml`；`allow_rebuild=true` 时才现场构建；
- 日常单副本；`release=true` 时 `no-cache` 双副本全量；
- 最终 provenance 记录每个 base 的 key/run id/manifest SHA。

### 6.3 `pr-gate.yml`（改造）

- 新增 `changes` job：`node scripts/ci/classify-changes.mjs`；
- `compile` 只在 `apk=true` 时跑；
- 静态/敏感信息/冲突检查始终跑；
- 未知路径 `full=true`，宁多跑不误跳过；
- 文档-only PR 跳过 Kotlin/来源链。

### 6.4 `release`

- `no-cache`、双副本、完整来源链、签名、provenance；
- 这是唯一保留“每次每个组件都从源码重建”的路径。

## 7. 安全性/可验证性

必须同时满足：

1. base 只在 `main` 构建；PR 不能写 cache/lock；
2. lock 经 PR 审查，是 manifest/输出的信任根；
3. 精确 key，无 `restore-keys`；key 覆盖全部输入和工具链；
4. 新 key 首次双构建并比对；发布 `no-cache` 双构建；
5. manifest 校验失败即失败关闭，不能静默使用；
6. 每周/每次发布跑一次 `no-cache` 全链，防缓存漂移；
7. 最终 APK 仍只由来源链产出并签名；base 不作为发布物分发；
8. 变更分类未知路径一律全量。

**明确的口径变化**：日常构建允许复用由 `main` 上、同输入 key、双构建验证过的编译 base；发布候选仍 `no-cache` 全量双构建。该口径写入 `SECURITY-HARDENING.md`/`build-and-env.md` 后才生效。

## 8. 阶段

| 阶段 | 内容 | 行为变化 | 验收 |
|---|---|---|---|
| 0 | 本 ADR + 变更分类器 + 组件键/锁骨架 | 无 | 单测 + 负控 |
| 1 | `pr-gate` 接入分类器；文档-only 跳过 compile | 仅 PR 检查 | 分类器正反例 |
| 2 | engine base workflow 试点；lock/manifest；app 消费 engine | 日常复用 engine | 新 key 双构建；app 校验；`no-cache` 回退 |
| 3 | termux-base 试点 | 复用 Termux | 同上 |
| 4 | linux-assets（可选） | 不随 app 重编 | 同上 |
| 5 | 发布 `no-cache` 双构建；文档/证据收口 | 发布路径不变 | 全链 + 设备门禁 |

每阶段一个 PR；不把“拆 workflow + 改 policy + 改 app”混在一个 PR。

## 9. 验收/负控

- 分类器：docs-only 全 false；plugin 变更 `plugins/apk=true`；engine 变更 `engine/apk=true`；未知路径 `full=true`；空 diff `full=true`。
- 组件键：同一输入稳定；改一字节即变；忽略 `.git/node_modules`。
- lock：key 不匹配失败；manifest SHA 不匹配失败；output SHA 不匹配失败；lock 缺失失败。
- cache：命中但哈希错失败关闭；缺件可 `force` 重建；PR 不能写。
- 双构建：新 key 两副本输出不一致即失败；发布 `no-cache` 必跑。
- 设备：本 ADR/Stage 0-1 为 L1，设备不强制；Stage 5 发布候选仍按 §2.1 三层验收。

## 10. 风险

- base 复用削弱“本 run 重编”的证明；用 lock + 双构建 + 发布 no-cache 抵消，但必须如实记录。
- GitHub cache 淘汰/10 GB 上限；缺件要能重建；GHCR 可选。
- 工作流拆分增加维护面；先 engine 试点，再 Termux/Linux。
- Linux assets 可能随功能退役；不要先投入最深。
- `check-base-lock` 若被绕过，信任根失效；必须进 PR Gate/来源链。
