# Linux 环境修复计划（可对照执行）

> **历史计划，勿逐条照搬执行。2026-10-20 当前方案见 [RECOVERY-PROPOSAL-2026-10-20.md](RECOVERY-PROPOSAL-2026-10-20.md)。** 当前源码已有外置 loader 接口；noexec 唯一归因、PRoot 排除理由及本文旧 CI 阻塞状态不能直接套用到当前 HEAD。本文保留原工作包与自审历史，路线和实施顺序以新方案为准。

> 依据：[INVESTIGATION-2026-10-19-pocketharness.md](<INVESTIGATION-2026-10-19-pocketharness.md>) 与原报告 [ORIGINAL-REPORT-2026-10-19.md](<ORIGINAL-REPORT-2026-10-19.md>)。
> 性质：**执行计划**，本轮不写代码。每个工作包都可独立开 PR、独立回滚。
> **开工前先读 §10「计划自审」：S1（bootstrap 架构）未定不要开 WP-2；S2（⑤ noexec tmpfs）是本机已确认的主阻塞，WP-6 为 P0；W5 已实测失败，下一步是 W3-lite 或 W2。**
> **本轮决策：暂不移除 Linux 环境；本计划未执行，仅作为将来重启时的参考。** 最终汇总见 [LINUX-ENV-COMPLETE-RECORD-2026-10-19.md](<LINUX-ENV-COMPLETE-RECORD-2026-10-19.md>)。
> 基线：本仓 HEAD `b836d3a`（0.14.8 开发候选），targetSdk 34，minSdk 26，compileSdk 36。

---

## 0. 目标与完成定义

### 0.1 修复目标

> 在 ARM64 真机上，用户点「安装 Linux 环境」后，要么得到一个真正可用的 Debian 环境，要么在动手前就得到明确的「本应用当前不支持」；任何中间状态都不允许伪装成成功。

### 0.2 两条完成线

| 线 | 定义 | 何时采用 |
|---|---|---|
| **A. 功能线** | 安装成功 + `linux_bash` 能跑 Debian 命令 + 重启持久 + 可卸载 | ⑤ 有后端方案（bionilux fake-exec / proot） |
| **B. 保底线** | 安装前能力探测；明确错误码；不解包 60 MB；不写 active；UI 明确不支持 | ⑤ 暂不投入，或方案未落地 |

### 0.3 全局验收判据（A/B 共用，A 全过，B 只过 A5/A6 的「明确失败」分支）

| ID | 判据 | 证明方式 |
|---|---|---|
| A1 | 全新安装成功：`status().installed === true`、`active.json` 产生、`engine.log` 无 `did not activate` | 设备 `run-as` 读文件 + CDP status |
| A2a | `linux_bash` 能跑 `cat /etc/os-release`（Debian 13）、`node --version`（v24.x）、`dpkg -l`（基线包） | 设备真人任务 + 工具输出（**必过**） |
| A2b | `apt-get update` 在已知可用镜像/DNS 下成功 | 条件项；失败记为**环境阻塞**，不计产品红（见 S4） |
| A3 | 引擎/应用重启后仍 active，不重新解包 | 重启前后 active 记录、目录 mtime |
| A4 | 卸载后：无 `active.json`、无 staged/partial instance、旧实例不复活、可再次安装；`instances/` 与 `shared/node` 按设计可保留（`vendor/dsh-linux-runtime/test/manager.test.mjs:495-505`） | `run-as du` + 再次安装 |
| A5 | 任一步失败保留旧 active、清半成品、返回稳定错误码 | 受控负控（人为坏资产/坏脚本） |
| A6 | 三层验收：代码层 + CDP 层 + ADB 用户层，真机竖/横各一次；任务由模型自己编排 | 证据目录 + 截图 |

### 0.4 明确不做

- 不放宽/跳过 `_probeRuntime`（`execute()` 走同一条 exec 路径，只会把失败推迟）。
- 不把 `targetSdk` 降回 28。
- 不把 termux-exec trio 加进全局 `HOST_ENV_ALLOWLIST`（会污染 guest、触发 `PHDR`、破坏 `manager.test.mjs` 的 guest-env 不变量）。
- 不用 `adb shell`（shell 域）的成功证明 app 域可用。
- 不在 Windows/x86_64 模拟器上替代 ARM64 真机验收；不伪造「已验证」。

---

## 1. 前置条件与基线

| 项 | 要求 | 当前状态 |
|---|---|---|
| 设备 | ARM64 V2425A（1260x2800，SDK 36），`adb devices` 可见 | **不可用**（设备门禁标记 BLOCKED） |
| 引擎 | 0.2.1-rc.2（`.deploy-tmp/engine-021rc2`） | 就绪 |
| 构建 | 仅来源链：云端 `build-apk-source.yml` 或本地 `node scripts/source-build/run-local-source-chain.mjs` | 就绪 |
| 分支 | 从 `main` 新建，禁止直接 push `main`；一个 PR 一个逻辑改动 | 待执行 |
| 版本 | 由发版负责人确认；建议独立 `release/v<版本>/notes.md` 草稿，不占用 0.14.8 冻结候选 | 待确认 |
| 设备实验 | 调查报告 §5 的 5 个实验（路径方向、`ln` errno、env 三变量、域对照） | 待设备 |

> 设备离线期间的规则：代码、单测、门禁、Linux CI 可以全部推进；**L2/L3 的设备层不得记为通过**。PR 描述必须显式写「未做设备验证」，发布候选前必须补验（AGENTS §4.2）。

---

## 2. 工作包总表

| ID | 标题 | 类型 | 风险档 | 依赖 | 需 APK/新资产 | 设备层 | 估算 |
|---|---|---|---|---|---|---|---|
| **WP-CI** | **修复 `build-apk-source` 的 PTC companion 漏写（当前出包阻断）** | **fix** | **L1** | **无（独立，先做）** | **否** | **否（CI 验证）** | **S** |
| WP-0 | 决策记录、基线、设备实验排期 | docs | L0 | — | 否 | 部分 | S |
| WP-1 | 失败可观测性：`save()`、稳定错误码、503 分流、前端展示 | fix | L3（UI）+ L1 | WP-0 | 否（JS 热推） | 是 | M |
| WP-2 | ① 激活修复：删 `ctx.filesDir` + 真 Cordis 测试 | fix | L2 | WP-0（建议先 WP-1） | 否（bootstrap JS 热推） | 是 | S |
| WP-3 | ② 解包根规范化：别名根硬链接 | fix | L2 | WP-2（端到端） | 否（宿主 JS 热推） | 是 | S |
| WP-4 | ③ 硬链接复制兜底 | fix | L2 | WP-3 | 否（宿主 JS 热推） | 是 | M |
| WP-5 | ④ 宿主准备改用系统 shell/toybox | fix | L2 | WP-2–4 | **是**（runtime 资产 + APK） | 是 | M |
| **WP-6** | **⑤ 运行时 exec（noexec tmpfs）：归因 → W3-lite/W2/W1/W3/W4（W5 已失败）** | design/fix | L3 | WP-0；归因需设备；实现依赖 WP-5 | **是**（后端/资产） | 是 | **XL** |
| WP-7 | 设备验收脚本、文档收口、来源链 APK、三层验收 | test/docs | L1/L3 | WP-1–6 | 是 | 是 | M |

**里程碑**

| 里程碑 | 内容 | 用户可见结果 |
|---|---|---|
| M1 可诊断 | WP-1 + WP-2 | 503 消失；安装失败能在面板上看到稳定错误码；仍装不成功 |
| M2 到平台边界 | WP-3 + WP-4 + WP-5 | 安装能过 manifest/插件/rootfs/准备脚本，停在 probe；仍不可用 |
| M3 运行时可用 | WP-6 | W3-lite/W2/W1/W3 任一让 A2a 通过；或明确判 W4/不支持并 fail-closed |
| M4 发布 | WP-7 | 来源链 APK + 三层验收 + 发布说明 |

---

## 3. 工作包卡片

### WP-0 · 决策与基线（不写产品代码）

**目标**：把「⑤ 走哪条路」和「本轮发不发布」定下来，避免后面白做。

**动作**

1. 建 `release/v<版本>/notes.md` 草稿，记录：基线 commit、设备状态、目标 A/B、已合并 PR、证据目录。
2. 开一个 decision record（`docs/` 或 PR 描述），在以下三选一：
   - A：bionilux 加 proot 式 fake-exec（ptrace）；
   - B：改 proot 后端（需评估 GPL-2.0 合规，见 `docs/AGENTS/gpl-compliance.md`）；
   - C：能力探测 + 明确不支持（默认，直到 A/B 落地）。
3. 设备可用后，先跑调查报告 §5 的 5 个实验，把结果写进 decision record（尤其 4C 三件套和 5 域对照）。
4. 确认 `check-vendored-linux-bootstrap`、`check-linux-sources`、`linux-source-manifest.json` 的更新责任人。

**完成判据**

- [ ] decision record 合并，A/B/C 明确，含 kill criteria。
- [ ] `release/v<版本>/notes.md` 建立。
- [ ] 设备实验清单与排期写入 notes。

---

### WP-1 · 失败可观测性

**目标**：安装失败后，用户和日志能拿到稳定原因；激活失败与「未启用」不再共用一句文案。

**改动文件**

| 文件 | 改动 |
|---|---|
| `plugins/dsh-linux-bootstrap/src/index.js` | `initialState` 加 `lastErrorCode: null`；`validateStoredState` 归一化；所有 catch 落 `lastErrorCode`；install catch 补 `await save()`；`statusShape` 暴露 `lastErrorCode` |
| `plugins/dsh-android-linux-env/src/linux-environment.ts` | `normalizeLinuxStatus` 加 `errorCode`；路由 catch 回 `{ error, code }`；503 文案拆成「未装配 / 激活失败」两种，并带 `code` |
| `plugins/dsh-linux-bootstrap/client/index.js` | 请求失败时保留 `status.code`；面板显示错误码与下一步提示 |

> 说明：bootstrap 已经有 `LinuxHostAssetError.code`，WP-1 直接透传；manager 的 `_probeRuntime`/`_prepareRootfs` 细粒度 code 放到 WP-5（那一步本来就要重建 runtime 资产），避免 WP-1 被 APK 周期拖住。WP-1 的兜底码是 `linux-install-failed`。

**代码示意**

```js
// bootstrap index.js
function initialState(autoUpdate) {
  return { ..., lastError: null, lastErrorCode: null, ... }
}

// installRuntime catch
state.lastError = safeError(error)
state.lastErrorCode = typeof error?.code === 'string' ? error.code : 'linux-install-failed'
await save().catch(() => undefined)
emit()
throw error
```

```ts
// linux-environment.ts route catch
} catch (error) {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code : 'linux-operation-failed'
  send(res, 500, { error: 'Linux 环境操作失败，请检查环境状态与日志后重试。', code })
}
```

503 文案建议：

```ts
send(res, 503, {
  error: 'Linux bootstrap 服务不可用：内部插件未装配，或已装配但激活失败。先看 engine.log 是否出现 did not activate / without inject。',
  code: 'linux-bootstrap-unavailable',
})
```

**测试（代码层）**

- bootstrap：用临时 `dataDir` + 必然失败的 manifest/asset 调 `install()`；断言 state 文件里 `lastError` 与 `lastErrorCode` 都已落盘（重启后仍在）。
- route：stub `bootstrap.install` 抛 `Object.assign(new Error('x'), { code: 'linux-runtime-probe-failed' })`；断言 500 body 带 `code`。
- 503：`harness(null)` 断言 body 同时有 `code: 'linux-bootstrap-unavailable'` 与新文案；`absent.call('status')` 仍 503。
- client：503/500 两种响应下都能显示错误码（client 单测走 `client-http.test.mjs` 的 `createHttpBootstrap` 路径）。

**门禁**

- `node scripts/check-plugin-tests.mjs`
- `node scripts/check-release-gates.mjs`
- 改了 `linux-environment.ts` 路由响应：`node scripts/check-api-route-auth.mjs`（聚合门禁已含）

**设备验证**

- ① 修复前：安装请求返回 `code: linux-bootstrap-unavailable`，文案不再指向「去启用」。
- ① 修复后：安装失败返回具体 code（rootfs/probe）。
- ADB：`run-as` 读 `linux-bootstrap-state.json`，确认 `lastError`/`lastErrorCode` 存在；重启引擎后仍在。

**完成判据**

- [ ] 失败状态跨重启保留。
- [ ] 500/503 都有稳定 code。
- [ ] 前端显示 code + 下一步。
- [ ] 现有成功路径行为不变（相关单测全绿）。

**回滚**：单 PR revert；新增字段可忽略，无数据迁移。

---

### WP-2 · ① 激活修复（`ctx.filesDir`）

**目标**：bootstrap 在真实 Cordis 下能激活，`linuxBootstrap` 服务在场，503 消失。

**改动文件**

| 文件 | 改动 |
|---|---|
| `plugins/dsh-linux-bootstrap/src/index.js` | 第 589 行删掉 `ctx.filesDir` |
| `plugins/dsh-linux-bootstrap/package.json` | `dshVendor.localPatches["src/index.js"]` 换成新 sha；`dshVendor.deviations` 追加一条 |
| `scripts/check-vendored-linux-bootstrap.mjs` | `LOCAL_PATCHES["src/index.js"]` 换成新 sha |
| `scripts/source-build/linux-source-manifest.json` | `additionalSources[0].files` 与 `files` 两处 `src/index.js` 摘要、`localPatches[".../src/index.js"].reason`；若改 `package.json` 则同步两处摘要与 reason |
| `plugins/dsh-android-linux-env/test/offline-install-integration.test.mjs` | 新增真实 Cordis 激活用例 + 负控 |
| `docs/AGENTS/gotchas.md` | 新增坑位（Cordis 未 inject 属性） |

**代码示意**

```ts
 export function apply(ctx, config = {}) {
   const hostConfig = ctx.linuxBootstrapConfig ?? {}
   const pluginHost = config.pluginHost ?? ctx.linuxPluginHost
-  const filesDir = config.filesDir ?? ctx.filesDir ?? process.env.DSH_FILES_DIR
+  const filesDir = config.filesDir ?? process.env.DSH_FILES_DIR
   const dataDir = config.dataDir ?? hostConfig.dataDir ?? (filesDir ? path.join(filesDir, 'linux-environment') : null)
```

**测试（代码层）**

在 `offline-install-integration.test.mjs` 新增：

```js
test('bootstrap activates under a real Cordis proxy without ctx.filesDir', async () => {
  const app = new Context()
  app.provide('linuxBootstrapConfig', config)      // dataDir + manifestProvider + verifyManifest + linuxAssetIO + appVersionProvider
  app.provide('linuxPluginHost', host)
  const fiber = app.plugin(bootstrapModule, {})
  await fiber
  assert.ok(app.get('linuxBootstrap'))
  await fiber.dispose()
})

test('negative control: reading an undeclared ctx property still throws', async () => {
  const app = new Context()
  const probe = { inject: [], apply(ctx) { void ctx.filesDir } }
  await assert.rejects(async () => { await app.plugin(probe, {}) }, /without inject/)
})
```

负控的作用：如果有人把 `ctx.filesDir` 加回来，第一条会因为激活抛错而红；第二条证明真实 Cordis 的代理确实会抛，而不是测试环境的偶然。

**门禁**

- `node scripts/check-vendored-linux-bootstrap.mjs --self-test`
- `node scripts/source-build/check-linux-sources.mjs --self-test`
- `node scripts/check-plugin-tests.mjs`
- `node scripts/check-code-map.mjs`

**开发期热推**

```powershell
cd plugins/dsh-linux-bootstrap; npm run build
node scripts/hot-push.mjs --serial <s> --plugin plugins/dsh-linux-bootstrap --pkg @dsh-android/linux-bootstrap --restart
```

**设备验证**

- 重启后 `grep -n "did not activate\|without inject" <files>/engine.log` 无命中。
- `GET /api/android/linux-environment/status` 返回 200，`files/linux-environment/` 出现。
- 点安装：预期继续在 ②/③ 失败（这是预期的，不是本 PR 的回归）。

**完成判据**

- [ ] 真实 Cordis 激活测试绿；负控红（修复前）。
- [ ] 设备 engine.log 无激活错误，status 200。
- [ ] `check-vendored` 与 `check-linux-sources` 自检通过。
- [ ] PR 描述标注设备层结果（若设备离线则「未做」）。

**回滚**：revert 后恢复 503；无数据迁移。

---

### WP-3 · ② 解包根规范化（别名根）

**状态（2026-10-21）**：当前分支已实现并通过别名根硬链接正控、越界/符号链接负控；ARM64 设备验证未做。

**目标**：`/data/data/...` 与 `/data/user/0/...` 两种写法下，rootfs 的合法硬链接都能通过归属校验。

**改动文件**

- `plugins/dsh-android-linux-env/src/linux-host-asset-io.ts`（`extractVerifiedArchive` 开头）
- `plugins/dsh-android-linux-env/test/linux-host-asset-io.test.mjs`（新增别名根用例）
- `docs/AGENTS/gotchas.md`（坑 1/67 的第 N 个站点）

**代码示意**

```diff
const lexicalRoot = resolve(destination)
const initialInfo = await lstat(lexicalRoot)
if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink() || (await readdir(lexicalRoot)).length !== 0) {
  throw new Error('Archive destination must be a fresh empty directory')
}
// Android exposes the same directory as /data/data/... and /data/user/0/...;
// normalize the root before comparing it with realpath(entry.source).
// realpath errors fail closed; recheck identity and emptiness after normalization.
const root = await realpath(lexicalRoot)
const [currentInfo, canonicalInfo, currentRoot] = await Promise.all([
  lstat(lexicalRoot), lstat(root), realpath(lexicalRoot),
])
if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink() ||
    !canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
    currentInfo.dev !== initialInfo.dev || currentInfo.ino !== initialInfo.ino ||
    canonicalInfo.dev !== initialInfo.dev || canonicalInfo.ino !== initialInfo.ino ||
    currentRoot !== root || (await readdir(root)).length !== 0) {
  throw new Error('Archive destination must be a fresh empty directory')
}
```

**测试（代码层）**

在 `linux-host-asset-io.test.mjs` 新增：

- 正向：`real/` + 别名 `alias -> real`（POSIX 用 `symlink(dir, alias, 'dir')`；Windows 用 `symlink(dir, alias, 'junction')`）；`filesDir` 走 alias，归档含 `./file` 与 `./copy`（`LNKTYPE`）→ 成功，`ino` 相等。
- 负向：同一别名根下，`hardlinkEntry('escape','../outside/sentinel')` 仍拒绝；`symlinkEntry('escape','../../outside')` 仍拒绝；`extractArchive(good, outside)` 仍报 fresh empty。
- 负向：`destination` 本身是 symlink → 仍拒绝。

**门禁**

- `node scripts/check-plugin-tests.mjs`
- `node scripts/check-code-map.mjs`
- `node scripts/check-release-gates.mjs`

**设备验证**

- 热推 `linux-env` 的 `lib/`，重启，点安装；预期 rootfs 解包越过「hard link must target」错误，进入 `link` 阶段（若 WP-4 未合入，则在此失败，属预期）。
- `run-as` 检查 `staging/<sha>/unpacked/usr/bin/perl` 是否存在。

**完成判据**

- [ ] 别名根正向绿；两条负控仍红。
- [ ] 设备越过 ②（日志不再出现该错误）。
- [ ] 没有放宽任何越界检查。

**回滚**：revert；无数据迁移。

---

### WP-4 · ③ 硬链接复制兜底

**状态（2026-10-21）**：当前分支仅对明确的平台拒绝 errno 走 `COPYFILE_EXCL` 复制，并恢复源 mode；受控 `EACCES` 与未知错误用例通过。ARM64 设备验证未做。

**目标**：`link(2)` 被 app 域/设备策略拒绝时，用内容复制完成解包，且不削弱归属校验。

**改动文件**

- `plugins/dsh-android-linux-env/src/linux-host-asset-io.ts`（新增 `publishHardLink` 导出 + 调用）
- `plugins/dsh-android-linux-env/test/linux-host-asset-io.test.mjs`（新增受控负控）
- `docs/AGENTS/gotchas.md`

**代码示意**

```ts
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'

const HARDLINK_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK'])

export interface HardLinkOps {
  link(source: string, target: string): Promise<void>
  copyFile(source: string, target: string, flags?: number): Promise<void>
  chmod(target: string, mode: number): Promise<void>
}

const DEFAULT_HARDLINK_OPS: HardLinkOps = {
  link: (source, target) => link(source, target),
  copyFile: (source, target, flags) => copyFile(source, target, flags),
  chmod: (target, mode) => chmod(target, mode),
}

/** Publish a verified archive hard-link target, preserving no-replace semantics on Android. */
export async function publishHardLink(
  source: string,
  target: string,
  sourceMode: number,
  ops: HardLinkOps = DEFAULT_HARDLINK_OPS,
): Promise<'link' | 'copy'> {
  try {
    await ops.link(source, target)
    return 'link' as const
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === undefined || !HARDLINK_FALLBACK_CODES.has(code)) throw error
    await ops.copyFile(source, target, fsConstants.COPYFILE_EXCL)
    await ops.chmod(target, sourceMode & 0o777)
    return 'copy' as const
  }
}
```

调用点：

```diff
-    await link(entry.source, entry.target)
+    await publishHardLink(entry.source, entry.target)
```

**测试（代码层）**

直接测 `publishHardLink`（注入 fake ops，不需要真 FS）：

- `link` resolve → 返回 `'link'`，`copyFile` 未被调用。
- `link` reject `EACCES` → 返回 `'copy'`，`copyFile` 带 `COPYFILE_EXCL`，`chmod` 收到 `0o755`（源 mode `0o100755`）。
- `link` reject `ENOENT` → 原样抛出，不复制。
- 集成：别名根 + 硬链接归档 → 解包成功；在支持 link 的主机上 `ino` 相等。

**门禁**

- `node scripts/check-plugin-tests.mjs`
- `node scripts/check-code-map.mjs`（新增导出要更新执行地图）
- `node scripts/check-release-gates.mjs`

**设备验证**

- 热推后点安装；预期 rootfs 解包成功（6328 条目级），进入 `prepare-rootfs.sh`（若 WP-5 未合入，则在此失败，属预期）。
- `run-as` 确认 `rootfs/usr/bin/perl` 与 `perl5.40.1` 都存在且可执行；`perl -v` 后续在 guest 内验证（A2）。

**完成判据**

- [ ] 四类单测（成功/EACCES/未知码/集成）全绿；未知码负控红。
- [ ] 设备 rootfs 解包成功。
- [ ] 复制路径保留 mode，目标不存在时用 `COPYFILE_EXCL`。

**回滚**：revert；已解包的 rootfs 可在下次安装时覆盖（staging 事务）。

---

### WP-5 · ④ 宿主准备改用系统 shell/toybox

**目标**：`prepare-rootfs.sh` 不再依赖 app 私有 ELF（`<prefix>/bin/find` 等），在 app 域可执行。

**根因（2026-10-19 实机更正）**：本 ROM 的 `/data/data` 是 `tmpfs noexec`；`find` 是 app 私有 ELF，`cleanHostEnvironment()` 又剥掉 termux-exec，所以直 exec 被 `MNT_NOEXEC` 拒，而不是 SELinux 独有。系统 shell/toybox 或 Node 侧实现都能避开 app 私有 ELF；**Node 侧仍是首选**（见 §10 S5）。

**方案选择**

| 方案 | 落点 | 是否需 APK | 评价 |
|---|---|---|---|
| **5A'（首选）** | runtime 插件内用 Node 实现 `prepareRootfs`（readdir/lstat/readlink/symlink/unlink） | 是（runtime 资产） | 根除 ④；host 可单测；不依赖 toybox applet |
| **5A（推荐，最终）** | `vendor/dsh-linux-runtime/modules/manager.js` 的 `_prepareRootfs`：优先 `/system/bin/sh`，`PATH=/system/bin:<rest>` | 是（runtime 资产） | 系统 shell + toybox，不依赖 preload，不碰 guest env；需逐 applet 验证 |
| 5B（应急，可热推） | `createLinuxBootstrapConfig().runtimePluginConfig.runCommand`：只对 `spec.file === 'sh'` 走系统 shell/PATH | 否（宿主 JS） | 需要复制 `spawnCommand` 的捕获/终止语义，维护风险；只作过渡 |
| 5C（不推荐） | 改 `HOST_ENV_ALLOWLIST` 加 trio | 是 | 会污染 guest/probe，破坏现有不变量 |

**5A 代码示意**

```js
const SYSTEM_BIN = '/system/bin'

// constructor
this.systemShell = options.systemShell
  ?? (existsSync(path.join(SYSTEM_BIN, 'sh')) ? path.join(SYSTEM_BIN, 'sh') : 'sh')

async _prepareRootfs(instance, signal) {
  const script = path.join(instance.backend, 'scripts', 'prepare-rootfs.sh')
  const env = cleanHostEnvironment()
  if (this.systemShell.startsWith(SYSTEM_BIN)) {
    env.PATH = [SYSTEM_BIN, env.PATH].filter(Boolean).join(path.delimiter)
  }
  const result = normaliseCommandResult(await this._runManaged({
    file: this.systemShell,
    args: [script, '--rootfs', instance.rootfs, '--relative-links'],
    cwd: instance.root,
    env,
    timeout: 120_000,
    signal,
  }))
  if (result.exitCode !== 0) {
    const error = new Error(`prepare-rootfs.sh failed with exit code ${result.exitCode}: ${result.stderr}`.trim())
    error.code = 'linux-runtime-rootfs-prepare-failed'
    throw error
  }
}
```

**测试（代码层）**

- `manager.test.mjs`：先让 `makeManager` 透传 `systemShell`（当前只透传 dataDir/arch/io/runner），再用 `makeManager(fixture, { systemShell: '/system/bin/sh' })`，让 fake runner 捕获 prepare 步骤的 spec；断言 `spec.file === '/system/bin/sh'` 且 `spec.env.PATH` 以 `/system/bin` 开头。
- 负控：`systemShell: 'sh'` 时 PATH 不被改写（保持现有 Linux 行为）。
- 现有 `manager.test.mjs:508-521` 的 guest env 不变量继续绿（证明没有把 trio 塞进 guest）。
- 同时给 `_probeRuntime` 的失败 Error 加 `.code = 'linux-runtime-probe-failed'`，并断言；这样 WP-1 的 `lastErrorCode` 在设备上能落到具体阶段。

**门禁**

- `node scripts/check-plugin-tests.mjs`
- `node scripts/source-build/check-linux-sources.mjs --self-test`
- `node scripts/check-release-gates.mjs`
- 更新 `linux-source-manifest.json` 的 `vendor/dsh-linux-runtime/modules/manager.js` 摘要 + `localPatches.reason`
- 来源链重建 runtime 资产 + APK

**设备验证**

- 安装日志出现 `rewrote N link(s); pending links now: 0`，exit 0。
- 不再出现 `find: Permission denied`。
- 之后停在 `_probeRuntime` 的 `execve EACCES`（WP-6 未合入时属预期）。

**完成判据**

- [ ] prepare 步骤在设备上 exit 0。
- [ ] 没有 app 私有 ELF 参与准备脚本（日志/`strace` 可选）。
- [ ] guest env 不变量测试仍绿。
- [ ] 资产与 manifest 摘要同步，来源链能重建。

**回滚**：revert + 重建资产；旧 runtime 资产仍可安装（bootstrap 按摘要选择）。

---

### WP-6 · ⑤ 运行时 exec（本机已确认主阻塞，P0）

**目标**：在 app 域内让 glibc guest 真正跑起来，或明确判定只能走特权/放弃；不再把“安装链修到 probe”当成目标。

> 2026-10-19 用户实测：插件已加载、热修 ①②③④ 后仍然跑不起来。这确认了 ⑤ 是本机主阻塞；WP-6 不是“后面的 spike”，而是 P0。作者的 V2425A 结果来自 `adb shell` 域，不能作为本机 app 的反证。

#### 6.1 已确认的根因（两轮实机）

- `/data/data` 是 **tmpfs + noexec**；app 私有 ELF 直接 exec 被 `MNT_NOEXEC` 拒；错误发生在 SELinux 之前；**不是** targetSdk，也不是 `untrusted_app` 域。
- guest node 是 **glibc v24.22.0**（interp=`/lib/ld-linux-aarch64.so.1`）；`$P/usr/bin/node` 是 **bionic v24.18.0**；`linker64` 不能加载 glibc。
- **bionilux 本身能启动**（bionic 0.4.2，NDK r30）；PHDR 出现在它**子进程** `execve(ld-linux-aarch64.so.1)` 时，是**从 bash 继承的 termux preload** 把这一跳改写成 linker64；`-n` 同样失败，说明不是 bionilux 自己的 preload。
- **`BIONILUX_LOADER` 不存在**；二进制里只有 `BIONILUX_PRELOAD`。
- **bionilux 不是 glibc→bionic 转换层**：它是 bionic launcher + glibc preload，仍然 `execve` glibc loader；noexec 卡的正是这一步。它做的是路径/rootfs/身份/exec 路由，不是 libc ABI 转换。
- 实验 4（W5）：bionilux 能解析 guest node，卡在 `execve(loader)` → `EACCES`。W5 结构性失败。
- 测试边界：agent 把 APK 内三个资产手动解到 `~/tmp/lx`，**没有安装运行时插件槽位**；exec 结论有效，安装链 ①–④ 仍需单独验收。

**非 noexec 落脚点矩阵（本机实测）**

| 路径 | 可写 | exec | 备注 |
|---|---|---|---|
| `/data/local/tmp` | ✗ | ✓ | app 不可写；app 能否 read/traverse 仍需实测 |
| `/dev/shm` | ✗（SELinux 拒） | ✓ | 不可用 |
| `/tmp` | ✗ | ✓ | 不可用 |
| `/cache` | ✗ | ✓ | 不可用 |
| `/sdcard` | ✓ | ✗（FUSE noexec） | 不可用 |
| app 私有（`/data/data`、`/data/user/0`） | ✓ | ✗ | 同一个 noexec tmpfs |

**结论**：任何仍然 `execve(loader)` 且 loader 在 app 私有目录的变体都会 `EACCES`。W5 不是“再修一版”，是结构性死路；必须改成“loader 在非 noexec 路径且 app 可 exec”或“根本不 `execve(loader)`”。

#### 6.1.1 已完成的实验（记录）

| # | 实验 | 实测 | 判定 |
|---|---|---|---|
| 1 | guest node interp/版本 | `/lib/ld-linux-aarch64.so.1`；v24.22.0 | ✅ 非 bionic |
| 2 | clean env 跑 node | `Permission denied`，126 | ✅ noexec |
| 3 | 保留 termux trio 跑 bionilux | bionilux 0.4.2 正常启动；PHDR 在子进程 exec loader | ✅ 位置修正 |
| 4 | W5（linker64 bionilux + 非 noexec loader） | `execve(loader)` EACCES；`BIONILUX_LOADER` 不存在 | ❌ 结构性失败 |

#### 6.2 W5（已失败，保留记录，不再候选）

- 失败点：bionilux 解析 guest node 成功，最后 `execve(…/rootfs/usr/lib/ld-linux-aarch64.so.1)` → `EACCES`。
- 两个硬事实：`BIONILUX_LOADER` 不存在；所有 app 可写路径都在 noexec 上。
- **不要**再把 W5 作为候选；下面只保留 W3-lite/W2/W1/W3/W4。

#### 6.3 W3-lite：把 loader 放到非 noexec 且 app 可访问的路径（首选，两变体）

- 做法：一次性把 glibc loader 放到一个 **非 noexec 且 app 可 read/exec** 的路径；app 侧 bionilux 使用它，rootfs 仍在 app 私有（loader 只 mmap target）。
- **变体 A（优先，可能不需要 Shizuku）**：APK native lib `/data/app/<pkg>/lib/arm64/...`。随 APK 分发、app 可读、在 `/data`（不是 `/data/data` tmpfs）。**两个硬门槛**：① `nativeLibraryDir` 里的文件 mode 是否带 x（PackageManager 常解成 0644，execve 会 EACCES；app 对 `/data/app` 只读，不能 chmod）；② SELinux `apk_data_file` 是否允许 `execve`（logcat avc 可证）。`android:extractNativeLibs=true` 才会有独立文件；loader 版本必须匹配 rootfs glibc。若 mode 0644 或 SELinux 拒 → 变体 A 死，直接 W2a memfd，不要硬撑。
- **变体 B（需要 Shizuku/ADB）**：把 loader 放到 `/data/local/tmp`（exec ✓，但 app 不可写）。**需实测** app 对它的 read/traverse/exec；此前 `ls` EACCES，不等于 exec 一定不行。
- 两个变体都要解决 **bionilux 没有 `BIONILUX_LOADER`** 的问题：先试 rootfs 内 `usr/lib/ld-linux...` symlink 指向外部 loader（看 bionilux 是否拒绝 rootfs 外 loader）；被拒则做一个最小 `BIONILUX_LOADER`/`--loader` 支持（小改，不是 fake-exec）。
- 若 A/B 都不可行：W2 或 W3 全量。
- 验收：`bionilux node --version` 输出 v24.22.0；`linux_bash` 能跑 `cat /etc/os-release`。

#### 6.4 W2：fake-exec / memfd（纯 app 域的主路线）

- 前置：`ptrace` 已验证可用（`SEIZE OK`）。
- **W2a（先试，可能更小）**：把 loader 写入 `memfd_create` 的匿名文件并 `fexecve`——匿名文件没有 noexec 挂载，可能绕过 `MNT_NOEXEC`；需验证 glibc loader 能正常启动并 mmap rootfs 的 target。若可行，改动远小于 full fake-exec。
- **W2b（W2a 失败再做）**：在 bionilux 的 `exec.rs`/preload 或 helper 里截获 `execve(ld-linux...)`，自己 mmap loader + target，跳 entry。
- 关键风险：与 preload 的 `execve` 链冲突；fork/exec 性能；必须覆盖 guest 子进程的 exec 链（apt/dpkg 会大量 exec）。
- 验收：A2a 在真机通过；`linux_bash` 连续 20 条命令稳定；apt/dpkg 可用。
- 门禁：`check-linux-sources`、`build-linux-assets.sh`、来源链 APK、三层验收。

#### 6.5 W1：proot 后端（注意：**不天然绕过 noexec**）

- proot 是 ptrace 的 chroot/bind 工具，最终仍依赖内核 exec guest loader；在 app 私有 noexec 上大概率同样 `EACCES`。**不要把 proot 当作 noexec 的万能解。**
- 只有在 rootfs/loader 位于非 noexec 路径（W3）时，proot 才有意义；纯 app 私有场景应走 W2b 的 userspace loader。
- 前置：`ptrace` 已验证可用；proot 本体启动（static → linker64/memfd；dynamic → linker64）需实测。
- 改动：新增 proot 资产（Termux 包或自编），runtime 改用 proot 启动；更新 GPL 合规三形态（`docs/AGENTS/gpl-compliance.md`、`THIRD_PARTY_NOTICES.md`、`app/src/main/assets/licenses/`）。
- 风险：GPL-2.0 合规、性能、`/proc`/bind mount 适配。
- 验收：同 A2a。

#### 6.6 W3：Shizuku/shell 域全量 helper（本机最可能工作的“稳妥”路线）

- 复用现有 Shizuku 特权 transport，把 bionilux/rootfs 整体放到 shell 可执行的 `/data/local/tmp`（非 noexec），以 shell 域运行；app 侧只做控制面。
- **不是 proot-distro 要求 Shizuku**：proot-distro 在 Termux 上无 root/无 Shizuku 就能跑；这里需要 Shizuku 只是因为**本 app 不能写 `/data/local/tmp`**，而 app 私有目录是 noexec。若 rootfs 能放在 app 可访问的非 noexec 路径（W3-lite-A），proot-distro 同样不需要 Shizuku。
- 这正是上游 V2425A 验证的 shell 域环境；不依赖 app 私有 exec，成功率最高。
- 风险：改变安全模型（rootfs 不再 app 私有）；Shizuku 需常驻/用户授权；rootfs 生命周期与清理重新设计；不能默认启用。
- 验收：A2a + 卸载/权限撤销后的失败关闭。

#### 6.7 W4：bionic-only 环境

- 不做 Debian/glibc；只提供快照的 bionic 工具链与 Node。
- 适用：产品接受放弃 `apt/dpkg`/Debian 兼容性；可立即交付，不需要 proot/fake-exec。

#### 6.8 保底：能力探测 + 明确不支持（fail-closed）

- **不要**用 `sh -c 'exec "<prefix>/bin/node" --version'` 作为能力判据：那是 **bionic** 引擎 node（v24.18），不是 glibc guest（v24.22）；它会在“只有 bionic 能跑”的机器上误报 supported。
- 正确的 `capabilityVerdict()` 必须测**真实 guest 启动路径**：
  - 若 W3-lite 已落地：用 `/data/local/tmp` 的 loader + `bionilux node --version`；
  - 若 W2/W1 已落地：用对应后端跑 `node --version`；
  - 若都未落地：读取 `filesDir` 所在挂载的 `noexec` 标志（`/proc/self/mounts` 或 `statfs` 不足以判断 noexec；可用 `adb`/宿主探测），直接返回 `linux-runtime-noexec-app-data`，**不要**解包。
- 判据：只有“真实 guest 输出 v24.22.0”才算 supported；`EACCES`/126、`PHDR`、spawn error、超时、缺失、任何不确定 → **unsupported / inconclusive，默认 unsupported**。
- 失败抛 `LinuxHostAssetError('linux-runtime-noexec-app-data' / 'linux-runtime-unsupported', ...)`，路由映射 409。
- `status()` 同时暴露 `supported/reason`，面板**禁用安装按钮**并说明原因，不是点击后才 409。
- 这是 W3-lite/W2/W1/W3 未落地时的默认发布形态。

#### 6.9 稳妥方案：分层后端，而不是单点 hack

按“执行环境是否允许 exec”分层，能力探测后选择：

| Tier | 条件 | 后端 | 优点 | 代价 |
|---|---|---|---|---|
| 0 | app 私有可 exec（标准设备） | bionilux 原生 | 快、无额外依赖 | 无 |
| 1 | app 私有 noexec，APK native lib 可 exec | bionilux/proot + APK lib loader（W3-lite-A） | 纯 app、改动小 | 依赖 native lib mode/SELinux；ROM 相关 |
| 2 | app 私有 noexec，`/data/local/tmp` 可访问 | bionilux/proot + `/data/local/tmp` loader（W3-lite-B） | 纯 app | 依赖 Shizuku/权限；app 可访问性未证 |
| 3 | 有 Shizuku，rootfs 可外置 | bionilux/proot + shell 域（W3） | 最接近上游验证；成功率最高 | 安全模型变化；**Shizuku 仅用于把 rootfs 放进 `/data/local/tmp`，不是 proot-distro 的依赖** |
| 4 | 纯 app、无特权 | W2b userspace loader（fake-exec） | 不依赖 ROM 路径/特权 | 实现/维护风险最高 |
| 5 | 都不行 | W4 bionic-only / 明确不支持 | 稳、可交付 | 放弃 Debian |

**推荐顺序**

1. 先测 **Tier 1 + Tier 2 + W2a（memfd）** 三个最便宜的路；任一成功即用。
2. 若都不行且 Shizuku 可用 → **Tier 3**，这是本机最可能“能跑”的稳妥路线。
3. 若必须纯 app 且无特权 → **Tier 4（W2b）**，先做最小 PoC 再立项。
4. **proot 只在 Tier 3 的非 noexec rootfs 下有意义**；不要把它当作 Tier 4 的替代，也不要假设 proot 能绕过 noexec。

**能力探测（`status()` + install 前）**

- 读 `filesDir` 挂载的 `noexec` 标志；测 APK native lib 与 `/data/local/tmp` 的 read/traverse/exec；测 `ptrace`。
- 选 Tier；`status()` 暴露 `tier/supported/reason`；不支持时禁用按钮。
- 探测必须测**真实 guest v24.22**，不能测 bionic node。

**安全/合规**

- Tier 3 的 rootfs 在 `/data/local/tmp`，不属于 app 私有，任何 shell 可读；不要放凭据，清理与权限撤销失败关闭。
- proot 若引入：GPL-2.0，按 GPL 三形态登记。
- Linux 环境不是安全沙箱；文档明确，不能宣称隔离。

#### 6.10 现成开源方案（可抄作业）

| 方案 | 许可证（以仓库为准） | 能抄什么 | 不能解决什么 |
|---|---|---|---|
| **Termux `proot` + `proot-distro`** | GPL-2.0 | Debian rootfs 安装/登录/清理、`--link2symlink` 硬链接兼容、bind mount、fake root | **不绕过 noexec**：最终仍内核 exec guest loader；只有 rootfs 在 `/data/local/tmp` 等非 noexec 路径（Tier 3）才有意义。**proot-distro 本身不要求 root/Shizuku**；本机 Tier 3 需要它只是为了把 rootfs 放进 app 不可写的 `/data/local/tmp` |
| **QEMU `linux-user`（`qemu-aarch64`）** | GPL-2.0 | 成熟**用户态 ELF/loader**：不 exec guest loader；可作 W2b 的现成实现，替代自研 fake-exec | 同架构 TCG 慢；`-L` 主要解决 interp/库路径，完整 rootfs 绝对路径语义仍需 proot 或 bionilux preload；不是完整发行版运行时 |
| **Termux `termux-exec`** | MIT（以仓库为准） | bionic ELF 的 `execve`→`linker64` trampoline；我们已用同一机制 | 只对 bionic ELF 有效；glibc 会 PHDR |
| **Termux `termux-packages`** | 各包自带（脚本 GPL 为主） | 源码级 bionic 化（W4）：把需要的包重编到 bionic | 不是二进制翻译；工作量是维护一个 bionic 发行版 |
| **proot `--link2symlink`** | GPL-2.0 | 硬链接被拒时改 symlink 的实现/语义；可作为 ③ 的参考 | bionilux 已有 link→copy，通常不需要再抄 |
| **UserLAnd / AnLinux / Andronix** | 各自仓库 | proot 的 Android UX：安装向导、rootfs 管理、会话/终端 | 底层仍是 proot；不解决 app 私有 noexec；多为 wrapper/脚本 |
| **gcompat（Alpine）** | MIT/GPL 混合（以仓库为准） | glibc ABI shim 的设计参考 | 只覆盖简单二进制；bionic 无对应；跑不了 apt/dpkg；**不建议** |
| **libhybris** | GPL-2.0 | 无（方向相反） | 它是 bionic 库跑在 glibc 上，不是 glibc→bionic |
| **Android Linux Terminal（AVF）** | AOSP | 系统级 Linux VM 的产品形态参考 | 不是库；设备/系统支持相关；非 app 级 rootfs |

**结论**

- **纯 app、无特权**：唯一现成的“用户态 loader”作业是 **QEMU linux-user**。先用 `qemu-aarch64 -L <rootfs> <rootfs>/usr/bin/node --version` 做 PoC；通过后再评估 `apt/dpkg` 的路径语义（可能需要 proot 或 bionilux preload 配合）与性能。它比自研 W2b 稳，但慢。
- **允许 Shizuku/shell 域**：抄 **proot-distro** 的 rootfs/会话管理，把 rootfs 放 `/data/local/tmp`；这是 Tier 3，最接近上游验证，且原生速度。不要把它用在 app 私有 noexec 上。
- **只想要 bionic**：抄 **termux-packages**，做 W4；这是唯一“真 bionic 化”的可靠路线。
- **不要抄**：gcompat 式 ABI shim（不完整）、libhybris（方向相反）、Wine（不是同一问题）。
- **不要自研同架构 JIT**：aarch64 guest 跑在 aarch64 上，JIT 不带来指令集收益；真正绕过 noexec 的是“用户态加载 ELF”，不是 JIT。自研 JIT 是编译器级工程，远大于 W2b loader；要用现成的就用 QEMU linux-user，且只作 PoC/后备。JIT 也解决不了 glibc→bionic 的 ABI 问题（JIT 翻译指令，不翻译 libc 语义）。
- **QEMU 可行性分层**：`node --version` 高（能加载 glibc loader 即过）；完整 apt/dpkg 中低（`-L` 只设 interp/库前缀，**不是 chroot**，guest 绝对路径会落到宿主；`/proc`/`/dev`/fake root/`chown` 仍需 proot 或 bionilux preload，组合复杂且慢）；作为产品主路线低。先一天 PoC：`qemu-aarch64 -L rootfs node --version` → `dpkg -l` → `apt-get update`；**apt 不通就止损**，转 W3/W2b。
- 引入 proot/qemu 都是 GPL-2.0，必须按 `docs/AGENTS/gpl-compliance.md` 的三形态登记、固定版本/哈希与来源。

**WP-6 完成判据**

- [ ] 第 1–4 项实验有设备记录：guest node 是 v24.22/glibc；bionilux 真实错误；W5 已失败；`/data/local/tmp` 的 app 可访问性。
- [ ] decision record 明确选 W3-lite/W2/W1/W3/W4；未选之前不写后端代码。
- [ ] 选定路线后，A2a 在真机通过；或明确判定 W4/不支持。
- [ ] 不通过放宽 probe 来「修」；不把 probe 换成 bionic node。
- [ ] 保底形态下零解包、零半成品、稳定错误码、按钮禁用。

---

### WP-7 · 验收脚本、文档收口、来源链 APK

**目标**：把「修好了」变成可重复验证，并产出唯一合法的发布物。

**新增 `scripts/verify-linux-environment.mjs`**

输入：`--serial <s>`，可选 `--ws <cdp>`、`--mode status|unsupported|install`。

断言：

| 模式 | 断言 |
|---|---|
| `status` | `GET /api/android/linux-environment/status` 200；`engine.log` 无 `did not activate`/`without inject`；`lastErrorCode` 字段存在 |
| `unsupported` | `POST install` 返回 409 + `code=linux-runtime-unsupported-app-domain`；`files/linux-environment/runtime` 不存在或为空；无新增 60 MB |
| `install` | 200 + `installed:true`；`run-as` 读 active；`linux_bash` 跑 `cat /etc/os-release`、`node --version`；重启后仍 active；卸载后无残留 |

鉴权：复用 `verify-state-sync.mjs` / `verify-browser-panel.mjs` 的 token 读取方式。

**文档收口**

- `docs/AGENTS/gotchas.md`：4 条新坑（Cordis 未 inject、别名根、link 兜底、宿主准备/域限制）。
- `docs/AGENTS/known-gaps.md`：更新 Linux 小节，链接本计划与调查报告。
- `docs/AGENTS/modules.md`：新增 `publishHardLink`、`systemShell` 选项、`lastErrorCode`。
- `docs/AGENTS/EXECUTION-MAP.md`：更新 `linux-host-asset-io`、`manager`、`bootstrap` 的执行链；跑 `check-code-map.mjs`。
- `docs/AGENTS/RUNTIME-PATCHES.md` / `DEPENDENCIES.md`：只有改动补丁/依赖时才更新。
- `docs/AGENTS/changelog-archive.md`：每个交付 PR 一行摘要。
- `release/v<版本>/notes.md`：面向用户先写问题改善，再写安装/限制/验证范围。

**来源链 APK**

```powershell
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref <branch>
# 或本地（仅已提交 HEAD）：
node scripts/source-build/run-local-source-chain.mjs
```

- 只使用来源链产物；禁止旧本地链。
- 记录产物哈希、provenance、run id。
- 安装：`adb -s <s> install -r -t out/v<版本>/pocket-harness-v<版本>-arm64.apk`。

**三层验收**

1. 代码层：`npm test`（相关插件）+ 门禁 + 新增负控。
2. CDP 层：`node scripts/verify-linux-environment.mjs --serial <s> --ws <ws> --mode ...`。
3. ADB 用户层：真实任务（模型自己编排）：打开设置 → 安装 → 运行 `cat /etc/os-release` / `node --version` → 重启 → 再运行 → 卸载；竖/横各一次；截图落到 `.deploy-tmp/<round>/ui-NN-*.png`。

**完成判据**

- [ ] A1–A6（A 线）或 B 线判据全过。
- [ ] 来源链 APK 与同一 HEAD 对应。
- [ ] PR 描述含三层结论行 + 截图路径；无「未做设备验证」遗留。
- [ ] `node scripts/clean-deploy-tmp.mjs --apply` 清理。

---

### WP-CI · 修复 `build-apk-source` 的 PTC companion 漏写（出包阻断）

> 这是**独立于 Linux 环境 5 条问题**的构建链缺陷，但它阻断 WP-5/6/7 需要的来源链 APK，所以列为 P0、先做。属于 L1（构建链逻辑），按 AGENTS §4.3 只需 `--self-test` + 一条受控负控，不需要设备。

#### CI 事件

| 项 | 值 |
|---|---|
| run | [39225525469](https://github.com/snoworwind/pocket-harness/actions/runs/39225525469) |
| workflow | `build-apk-source`（`workflow_dispatch`） |
| 分支 / SHA | `main` / `c640eb06ae884948dfeb140e275b3460570f249f` |
| 开始 | 2026-10-19 08:49:30Z |
| 失败 job | `build-arm64 (primary)` 与 `build-arm64 (reference)` 两个副本都失败 |
| 失败 step | 第 24 步 `Build runtime snapshot from verified inputs` |
| 错误 | `Error: incomplete canonical engine patch: ptc-android-native-A1` |
| 位置 | `scripts/source-build/reconcile-engine-patch-copies.mjs:94`（`verifyCanonicalEnginePatch`） |
| 后果 | `verify-arm64` / `sign-arm64` 被 skip，没有 APK 产物 |

`HEAD b836d3a` 相对 `c640eb0` 只改了 3 个 docs/evidence 文件（`git diff --stat c640eb0..HEAD`），**没有任何代码变化**，所以同一个失败在 HEAD 上仍会复现。

#### 真因（已本机复现）

1. `scripts/patches/ptc-android-native-A1.mjs` 的 `planPatch()` 返回**三个**文件：
   `lib/index.js`、`lib/process.js`、`lib/persistent-process.js`（0.2.1-rc.2 吸收时新增第三个，见 `ea3c58b`）。
2. `scripts/patches/registry.json` 的 `ptc-android-native-A1.additionalTargets` 也列了 `lib/persistent-process.js`。
3. 但 `scripts/patches/apply-patches.mjs:198-201` 的硬编码 `additionalFiles` 仍只有 `lib/process.js`（该行来自基线 `d7df784`，0.2.1-rc.2 升级时没有同步）。
4. 通用施加循环（`apply-patches.mjs:2483-2486`）只写 `impl.file` + `impl.additionalFiles`，所以 `lib/persistent-process.js` 虽然被 `planPatch` 算出来、也被放进 `IMPL_state`，**从未落盘**。
5. `apply-patches` 的 `check`（`:202-207`）只检查 `index.js` 的两个 marker 和 `process.js` 的 env marker，**不检查 `persistent-process.js`**，于是 `--check` 假绿 `ALL OK（24/24，mode=check，changed=0）`。
6. 之后的 `reconcile-engine-patch-copies.mjs` 用 `planPatch` 对规范包做精确 verifier，发现 `persistent-process.js` 仍会被改动（`before !== after`）→ 抛出 `incomplete canonical engine patch: ptc-android-native-A1`。

一句话：**patch 模块/登记表已经三文件，`apply-patches` 的伴生文件清单还停在两文件；`--check` 也只看两文件，所以假绿到 reconcile 才炸。**

#### 本机复现（已做）

用 `.deploy-tmp/engine-021rc2` 里的上游 `dsh-ptc-runtime-node@0.2.1-rc.2` 三个文件搭最小 stage：

```text
CURRENT: verifier threw -> incomplete canonical engine patch: ptc-android-native-A1
AFTER FIX: verifier passed
```

- `CURRENT` = 按现状只写 `index.js` + `process.js`；
- `AFTER FIX` = 补写 `persistent-process.js` 后同一 verifier 通过。

复现脚本在 `本机临时目录（不入仓）repro-ci-ptc.mjs`（丢弃式，项目工作树未改）。

#### 修复步骤

**必须（最小修复）**

1. `scripts/patches/apply-patches.mjs` 的 `ptc-android-native-A1.additionalFiles` 增加：
   ```js
   'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/persistent-process.js'
   ```
2. 同条目的 `check(s)` 增加对 `persistent-process.js` 的检查：
   - `loadImpl(.../lib/persistent-process.js, CURRENT_STAGE_ROOT)` 必须含 `PTC_ENV_MARKER`；
   - 建议同时调 `assertChildClearing(persistent)`，与 `apply` 的预检同源。
3. 这样 `apply-patches --check` 在伴生文件缺失时会判红，而不是把问题留到 reconcile。

**推荐（防再漂移）**

4. 在 `scripts/patches/ptc-android-native-A1.mjs` 导出唯一的文件清单：
   ```js
   export const PATCHED_FILES = Object.freeze(['lib/index.js', 'lib/process.js', 'lib/persistent-process.js'])
   ```
   `planPatch` 的非 source 分支直接用它；`apply-patches` 的 `additionalFiles` 由
   `PATCHED_FILES.filter(f => f !== 'lib/index.js')` 派生，不再手写。
5. 在 `scripts/patches/tests/ptc-android-native-A1.test.mjs` 增加断言：
   ```js
   assert.deepEqual([...PATCHED_FILES].sort(), planPatch(fixture).map(f => f.name).sort())
   ```
   这样「patch 计划文件」与「写入文件」由同一个常量约束。
6. 一次性审计其他补丁：对比 `registry.additionalTargets`、`IMPLS[id].additionalFiles`、补丁 `planPatch`/`planXxx` 的输出，确认没有第二个同类漂移。重点看 `pi-upstream-streaming-020`（已用 `PI_STREAMING_FILES` 派生）与 `mimo-thinking-toggle-056`（已用 `MIMO_PI_FILE`）；PTC 是唯一硬编码的。

**受控负控（必须有）**

7. 在测试里搭一个临时 stage，只放 PTC 三个上游文件，先跑 `apply-patches --only ptc-argv-L1,ptc-android-native-A1 --apply --scope engine`：
   - 修复前：`lib/persistent-process.js` 不含 marker，`reconcile` verifier 抛错（红）；
   - 修复后：三个文件都含 marker，verifier 通过（绿）。
8. 再加一条「去掉 `additionalFiles` 里的 persistent 行」的负控，断言 verifier 重新判红——证明这条测试真的守得住。

#### 测试与门禁

```powershell
node scripts/patches/tests/ptc-android-native-A1.test.mjs
node scripts/check-patch-test-manifest.mjs
node scripts/check-patch-mirror.mjs
node scripts/check-release-gates.mjs
```

- L1 档：`--self-test` + 一条受控负控；不需要设备。
- PR Gate 会跑补丁测试与聚合门禁。

#### CI 验收

```powershell
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref <fix-branch>
gh run watch <run-id> --repo snoworwind/pocket-harness
```

- 必须看到第 24 步 `Build runtime snapshot from verified inputs` **通过**，不再出现 `incomplete canonical engine patch`。
- 更重要的是**整条 run 走完** `verify-arm64` / `sign-arm64` 并产出 APK；只过第 24 步不算验收。
- 记录 run id、head SHA、产物哈希与 provenance 到 `release/v<版本>/notes.md`（或在 `release/v0.14.8/notes.md` 追加）。
- 如果后续步骤出现新失败（例如之前的 `sharp package identity mismatch`），按新事件单独立项，不混进本 PR。

#### 上下文：更早的两次失败已修复

| run | workflow | 失败点 | 现状 |
|---|---|---|---|
| 39221527808 / 39221768021 | `build-linux-assets` | `Linux source digest mismatch: plugins/dsh-linux-bootstrap/package.json` | 已由 `44cb6f0`（PR #40）修复；最新 `build-linux-assets` run 39222110870 成功 |
| 39222638056 | `build-apk-source` | `sharp package identity mismatch: sharp@0.35.5`（node-pty 交叉编译步） | 已由 `8466ee8`（PR #41）修复；run 39225525469 已越过该步，卡在 PTC |
| **39225525469** | **`build-apk-source`** | **`incomplete canonical engine patch: ptc-android-native-A1`** | **本轮 WP-CI 处理** |

#### 文档

- `docs/AGENTS/gotchas.md` 追加：「补丁的 `planPatch` 输出 / `registry.additionalTargets` 必须与 `apply-patches.additionalFiles` 同步；`--check` 必须覆盖全部 companion，否则 reconcile 才判红，浪费整轮构建」。
- `docs/AGENTS/RUNTIME-PATCHES.md` §7.1 的 PTC 行补上 `persistent-process.js`。
- `docs/AGENTS/changelog-archive.md` 一行摘要：`fix: write PTC persistent companion during engine patch apply`。

#### 完成判据

- [ ] `additionalFiles` 含三个文件，`check` 覆盖 `persistent-process.js`。
- [ ] 本机 verifier 复现：修复前红、修复后绿；负控红。
- [ ] 补丁测试、patch manifest、patch mirror、聚合门禁全绿。
- [ ] `build-apk-source` 新 run 整条绿并产出 APK。
- [ ] gotcha / RUNTIME-PATCHES / changelog 已更新。

#### 回滚

单 PR revert；CI 回到当前失败状态，不影响已产出的旧 APK。

---

## 4. 执行顺序与并行

```text
WP-CI ──────────────────────────────────────────────> 出包可用
WP-6 归因（P0，设备）──> W3-lite/W2/W1/W3/W4 ───────> 运行时可用
WP-0 ──> WP-1 ──> WP-2 ──> WP-3 ──> WP-4 ──> WP-5 ──> WP-7
```

**顺序说明**

- **WP-6 是 P0，不再是“后面的 spike”**：用户实测已确认插件加载 + 热修后仍失败；W5 已失败；归因矩阵一有设备就跑，路线 W3-lite/W2/W1/W3/W4 与 WP-3/4/5 并行。
- **WP-CI 先做/并行做**：它只改 `scripts/patches/**`，不碰 Linux 环境代码；但 WP-5/6/7 的 APK 依赖它。建议第 1 天就开分支，CI 一绿就能解锁后续出包。
- WP-0/1/2 可以同时推进（WP-2 要等 S1 决策）；WP-3/4 在 WP-2 评审后；WP-5 等 WP-3/4 与 WP-CI；WP-7 最后。

| 阶段 | 可并行 | 设备依赖 | 产出 |
|---|---|---|---|
| 第 1 天 | **WP-CI**、WP-0、WP-1、**WP-6 归因** | 归因必须 | 出包恢复；归因 decision record |
| 第 2 周 | WP-2（S1 已定）、WP-3、WP-4、WP-5 代码 + 单测 | WP-5 需设备/资产 | M1/M2 |
| 第 2–3 周 | WP-6 W3-lite 先测；不通再做 W2/W1 PoC（`ptrace` 已验证） | 必须 | 选路线 |
| 第 3 周+ | WP-6 实现 | 必须 | M3 |
| 最后 | WP-7 | 必须 | M4 发布 |

**规则**：WP-6 归因不等任何代码；先测 W5（loader 放非 noexec 路径），不通再做 W2/W1 PoC；`ptrace` 已由实机验证可用；WP-1/2 可以立即开始（WP-2 等 S1）；WP-3/4 在 WP-2 评审后；WP-5 的资产构建可与 WP-3/4 并行；WP-7 最后。

---

## 5. 总验收矩阵与证据

| 判据 | 覆盖 WP | 证据 | 存放 |
|---|---|---|---|
| A1 安装成功 | WP-2/4/5/6 | `active.json`、status、engine.log | `.deploy-tmp/linux-env/<round>/a1/` |
| A2 Debian 可执行 | WP-6 | `linux_bash` 输出、`dpkg -l`、apt 日志 | `.../a2/` |
| A3 重启持久 | WP-6 | 重启前后 active/mtime | `.../a3/` |
| A4 卸载干净 | WP-1/6 | `du -sh`、目录清单 | `.../a4/` |
| A5 失败安全 | WP-1/3/4 | 负控日志、错误码、旧 active 保留 | `.../a5/` |
| A6 三层验收 | WP-7 | 代码/CDP/ADB 结论行 + 截图 | `.../a6/` |

**每个 PR 的最小证据**

- L1（脚本/门禁）：`--self-test` + 一条受控负控。
- L2（解包/事务/桥协议）：代码层 + 真实路径单测 + 一条负控；设备层若离线则显式标注，发布前补。
- L3（UI/壳侧行为）：代码层 + CDP + ADB 截图；缺一层即未验收。

---

## 6. 风险登记

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | ⑤ 在 app 域不可行（ptrace 也被拒） | A2 永远不可达 | 先做 spike；默认走 C 能力探测；不承诺日期 |
| R2 | 5B 的 `runCommand` 复制 spawn 语义 | 超时/输出上限/进程组行为漂移 | 只作过渡；优先 5A；补 `manager.test.mjs` 对照 |
| R3 | 复制兜底破坏 hardlink 身份 | dpkg/perl 极少依赖 link count；风险低 | A2 用 `dpkg -l`/`perl -v` 验证；必要时记录 |
| R4 | 改 vendored/bootstrap 摘要链 | 门禁红，构建失败 | 同步 `check-vendored` + `package.json.dshVendor` + `linux-source-manifest`，跑自检 |
| R5 | 改 runtime 资产需要重建 + APK | 周期长 | 与 WP-3/4 并行；本地来源链仅已提交 HEAD |
| R6 | 设备长期离线 | L2/L3 无法关闭 | PR 标注「未做设备验证」；不发布；设备回来集中补验 |
| R7 | 503 文案/错误码改动影响前端测试 | 单测红 | 同步更新 `linux-environment.test.mjs` / `client-http.test.mjs` |
| R8 | 能力探测误判（supported 但实际失败） | 仍会解包后失败 | 探测用真实内核 exec；与 `_probeRuntime` 双保险；C 方案下宁可误报 unsupported |
| R9 | proot 的 GPL-2.0 合规 | 发布阻断 | 先读 `gpl-compliance.md`，把三形态补齐再引入 |
| R10 | `realpath(root)` 在并发删除时失败 | 解包失败 | `.catch(() => lexicalRoot)` 回落；不放松归属检查 |

---

## 7. 提交、PR 与发布纪律

- 分支：`fix/linux-env-<topic>`、`spike/linux-env-glibc-exec`、`test/linux-env-device-verify`。
- 提交：`<type>: <描述>`，不用 emoji；一个提交只做一件事。
- PR：1–3 标签；描述包含「问题/改动/证据/设备验证/回滚」；**未做设备验证必须显式写**。
- 合并：merge commit，禁止 squash/rebase；禁止 force push；禁止直接 push `main`。
- 热推：仅 JS 插件（bootstrap/lib、linux-env/lib）；Kotlin、Manifest、assets、runtime/backend 资产必须走 APK。
- 发布：只从来源链 APK；最终候选必须重装并完成三层验收；热推证据不能代替最终 APK。
- 清理：每轮结束 `node scripts/clean-deploy-tmp.mjs --apply`。

---

## 8. 附录 A：命令速查

```powershell
# 单元测试 / 门禁
cd plugins/dsh-android-linux-env; npm test
cd plugins/dsh-linux-bootstrap; npm run build
node scripts/check-plugin-tests.mjs
node scripts/check-vendored-linux-bootstrap.mjs --self-test
node scripts/source-build/check-linux-sources.mjs --self-test
node scripts/check-code-map.mjs
node scripts/check-release-gates.mjs

# 开发期热推（仅 JS）
node scripts/hot-push.mjs --serial <s> --plugin plugins/dsh-android-linux-env --pkg @dsh-android/dsh-android-linux-env --restart
node scripts/hot-push.mjs --serial <s> --plugin plugins/dsh-linux-bootstrap --pkg @dsh-android/linux-bootstrap --restart

# 来源链 APK
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref <branch>
# 或
node scripts/source-build/run-local-source-chain.mjs

# 安装
adb -s <s> install -r -t out/v<版本>/pocket-harness-v<版本>-arm64.apk

# 设备检查
adb -s <s> shell "run-as com.snoworwind.pocketharness sh -c 'ls -l files/linux-environment; cat files/linux-environment/linux-bootstrap-state.json'"
adb -s <s> shell "run-as com.snoworwind.pocketharness sh -c 'du -sh files/linux-environment'"

# 清理
node scripts/clean-deploy-tmp.mjs --apply
```

## 附录 B：PR 描述模板

```markdown
## 问题
（对应 WP-xx / 调查报告 §x；现象 → 真因 → 影响）

## 改动
（只列本 PR 的逻辑改动；不混重构）

## 证据
- 代码层：`npm test` / 门禁命令 + 结果
- 受控负控：旧实现红、新实现绿的具体用例
- CDP：verify 脚本 + 结果
- ADB：真实任务 + 截图路径

## 设备验证
- [ ] 已做（ARM64 V2425A，竖/横各一次）
- [ ] 未做（原因：设备离线；发布前必须补）

## 回滚
（revert 本 PR 即可；无数据迁移/迁移方式）
```

## 附录 C：证据目录约定

```text
.deploy-tmp/linux-env/<YYYY-MM-DD>-<topic>/
  code/        # 单测/门禁日志
  cdp/         # verify 脚本输出、JSON
  adb/         # screenshots、run-as 清单、du、state 文件
  apk/         # 产物哈希、provenance、run id
```

---

## 9. 建议的第一批动作（今天就能做，不需要设备）

1. **WP-CI**：开 `fix/ptc-persistent-companion` 分支，先在本机跑复现脚本确认「现状红、补后绿」，再加 `persistent-process.js` 与 `check`，跑补丁测试/门禁，最后用 `build-apk-source` 新 run 验收整条出包。它最先解锁 WP-5/6/7。
2. 建 `release/v<版本>/notes.md` 草稿（WP-0；若并入 0.14.8 则用 `release/v0.14.8/notes.md`）。
3. 开 WP-1 分支，先补「失败落盘 + 错误码 + 503 文案」的单测，再改实现。
4. **先做 §10 的 S1 决策**：bootstrap 到底“默认装载”还是“回到 D-014 的显式加载”；未定之前不要开 WP-2。若选 always-loaded，再按 WP-2 改；若选 D-014，WP-2 变成宿主接线，不是 vendored 补丁。
5. 设备回来后，先做 §10 的 S2 域矩阵，再决定 ⑤ 走 A/B/C；同时跑调查报告 §5 的实验。
6. ⑤ 的 spike 与 WP-1/2 并行，不要等整条链修完。

---

## 10. 计划自审（2026-10-19）：开工前必须处理的严重问题

> 这一节是对本计划的对抗性复核。**S1、S2 是阻断级**：不解决就开工会把“修 bug”变成“固化错误架构”或“做多余的后端工程”。S3–S9 会直接导致验收假红、安全退化或证据不可执行。

### S1（阻断）① 的修法可能与 D-014 冲突：bootstrap 到底该不该在 profile 里

**事实**

- 我们的出厂装配清单**默认插入** `linux-bootstrap`：`scripts/profile-web.cordis.patch.yml:86-89`，且 `build-apk.mjs` 会把它打进所有 profile。
- 上游决策 **D-014** 明确要求它**不进入 Cordis profile、也不加入注入集**，理由正是它需要**函数型 config**（`dataDir` / `manifestProvider` / `linuxAssetIO` / `pluginHost` …），YAML 无法表达；未启用时设置页不得出现入口（`.deploy-tmp/linux-runtime-source/docs/DECISIONS.md:180-198`）。
- `docs/AGENTS/BRIDGE-API.md:209` 与 AGENTS.md 也写“默认不启用——存在不等于启用”；但 `check-vendored-linux-bootstrap.mjs` 头注又说它“deliberately sits OUTSIDE the injection set”，与实际的 `plugin-dirs.json` / profile 插入互相矛盾。

**后果**

如果只按 WP-2 删掉 `ctx.filesDir`：

- bootstrap 会在**每轮 boot 都激活**，实验性服务常驻；
- 503 的“未启用”分支**永远不存在**；
- “默认不启用”的文档与安全评审面变成假话；
- 安装按钮对用户常驻，但 ⑤ 未解决时仍然是“点了必失败”。

**必须二选一（写进 WP-0 decision record）**

| 选项 | 动作 | 代价 |
|---|---|---|
| **A. 接受 always-loaded** | 删 `ctx.filesDir`；保留 profile 插入；更新 D-014 / BRIDGE-API / AGENTS / `check-vendored` 头注；503 文案删掉“未启用”；明确“安装仍需用户确认” | 小；但实验插件常驻，需安全评审确认 |
| **B. 回到 D-014** | 移除 profile 插入；在 `linux-env` 里实现**宿主显式加载**（`ctx.plugin(bootstrap, functionConfig)` + 持久 enable 标记 + client toggle）；bootstrap 的 `apply` 不需要 `ctx.filesDir` | 中/大；但是上游既定边界，503 文案重新有意义 |

> **不要**用“删一行”默认选 A。A 是一个架构决定，必须显式记录。

### S2（2026-10-19 第二轮实机）⑤：noexec 已确认；W5 结构性失败；分水岭是 W3-lite vs W2

> **测试边界**：这轮 agent 把 APK 内的 `bionilux-backend` / `node-glibc-v24.22.0` / `debian-minimal` 手动解到 `~/tmp/lx`，**没有安装运行时插件槽位**（`plugins/linux-runtime` 不存在）。因此它验证的是 **exec/bionilux 层**，不是完整安装链；安装链的 ①–④ 仍需单独验收。结论对 exec 有效。

**已确认的根因**

- 本 ROM 的 `/data/data` 是 `tmpfs rw,nosuid,nodev,noexec`；`EACCES` 来自 `do_open_execat()` 的 `MNT_NOEXEC`，在 SELinux 之前；**不是** targetSdk，也不是 `untrusted_app` 域。
- guest node 是 **glibc** v24.22.0，interp=`/lib/ld-linux-aarch64.so.1`；`$P/usr/bin/node` 是 **bionic** v24.18.0；`linker64` 不能加载 glibc。
- 实验 3 的位置修正：**bionilux 本身能启动**（bionic 0.4.2，NDK r30）；PHDR 出现在它**子进程** `execve(ld-linux-aarch64.so.1)` 时，是**从 bash 继承的 termux preload** 把这一跳改写成 linker64；`-n` 同样失败，说明不是 bionilux 自己的 preload。
- 实验 4（W5）：bionilux 能解析 guest node，卡在最后一步 `execve(loader)` → `EACCES`。
- **`BIONILUX_LOADER` 不存在**，二进制里只有 `BIONILUX_PRELOAD`。原计划的 W5 机制从根上不成立。

**非 noexec 落脚点矩阵（本机实测）**

| 路径 | 可写 | exec | 备注 |
|---|---|---|---|
| `/data/local/tmp` | ✗ | ✓ | app 不可写；app 能否 read/traverse 仍需实测 |
| `/dev/shm` | ✗（SELinux 拒） | ✓ | 不可用 |
| `/tmp` | ✗ | ✓ | 不可用 |
| `/cache` | ✗ | ✓ | 不可用 |
| `/sdcard` | ✓ | ✗（FUSE noexec） | 不可用 |
| app 私有（`/data/data`、`/data/user/0`） | ✓ | ✗ | 全部同一个 noexec tmpfs |

**结论**：**任何仍然 `execve(loader)` 且 loader 在 app 私有目录的变体都会同样 `EACCES`**。W5 不是“再修一版”，是结构性死路；必须改成“loader 在非 noexec 路径且 app 可 exec”或“根本不 `execve(loader)`”。

**下一步路线（按优先级）**

| 路线 | 做法 | 前置/风险 |
|---|---|---|
| **W3-lite（首选，若 Shizuku/ADB 可用）** | 一次性把 glibc loader 放到 `/data/local/tmp`；app 侧 bionilux 使用它；rootfs 仍在 app 私有（loader 只 mmap target） | 两个硬门槛：① app 能否 read/traverse `/data/local/tmp`（此前 `ls` EACCES）；② bionilux 没有 `BIONILUX_LOADER`，需要 rootfs 内 `lib/ld-linux...` symlink 指向它（看 bionilux 是否拒绝 rootfs 外 loader），或补一个 `--loader`/`BIONILUX_LOADER` 小改 |
| **W2（纯 app 域，若 W3-lite 不可行）** | ptrace 拦截 bionilux 的 `execve(loader)`，自己 mmap loader 后跳 entry；`ptrace` 已验证可用 | Rust/helper 改动大；与 preload 的 `execve` 冲突；要覆盖 fork/exec 链 |
| **W1（proot 后端）** | 静态 proot + rootfs；proot 是 ptrace chroot，**最终仍让内核 exec guest loader**；只有 rootfs 在非 noexec 路径（W3）才有意义 | GPL-2.0；性能；`/proc`/bind mount；proot 本体启动；**不能绕过 app 私有 noexec** |
| **W3（shell 域全量，稳妥）** | rootfs 整体放 `/data/local/tmp`，以 shell 域跑 bionilux/proot | 本机最可能工作；但安全模型变化；Shizuku 常驻/授权；rootfs 生命周期重设计 |
| **W4（bionic-only）** | 放弃 Debian/glibc | 功能范围缩小 |

**必须先跑的判定实验**

1. Shizuku/ADB 是否可用；若可用，把 loader 放 `/data/local/tmp`，在 **app 域**测 `stat`/`read`/`exec` 是否都通过（`ls` 之前 EACCES，不等于不可 exec）。
2. 若 app 可访问：把 rootfs 内 `usr/lib/ld-linux-aarch64.so.1` 换成指向 `/data/local/tmp/...` 的 symlink，跑 `bionilux node --version`；若 bionilux 拒绝 rootfs 外 loader，则做最小 `BIONILUX_LOADER`/`--loader` 支持。
3. 若 app 不可访问或 symlink 被拒：做 **W2** 最小 PoC（ptrace 拦截 + mmap loader + 跳 entry），只跑 `node --version`。
4. 并行做 **W1** proot PoC（静态 proot + 同一 rootfs），比较 W2/W1 的工作量与稳定性。
5. 确认 guest node 仍是 v24.22、真实 probe 仍失败；不要用 bionic node 冒充。

**明确不要做**

- **不要**把 probe 改成 `linker64 <P/usr/bin/node>`：那是 bionic v24.18，不是 glibc v24.22，假绿。
- **不要**再用 `BIONILUX_LOADER`：该变量不存在；只有 `BIONILUX_PRELOAD`。
- **不要**把 loader 放在 app 私有目录：noexec，必 EACCES。
- **不要**假设 `/data/local/tmp` 对 app 可读/可 exec；先测。
- **不要**用 JS 热修补 ①②③④ 来“碰运气”；它们改不了 noexec。
- **不要**放宽/绕过 `_probeRuntime`；`execute()` 同路。
- **不要**把 `targetSdk` 降回 28；它不是本因。

**WP-6 的入口条件**：先拿到“app 对 `/data/local/tmp` 的 read/traverse/exec”和“bionilux 是否接受 rootfs 外 loader”两个结果；W3-lite 通过就走它，否则直接 W2/W1。W5 留作失败记录，不再作为候选。


### S3（验收错误，已修正）A4 的“无 runtime 残留”不成立

`vendor/dsh-linux-runtime/test/manager.test.mjs:495-505` 明确断言：`uninstall()` 之后 `instances/` 与 `shared/node` **仍然存在**（uninstall 只移除 active，共享 Node 留作复用）。原计划的 A4 若要求“无 `linux-environment/runtime` 残留”，会判红或诱导删除共享数据。

已在 §0.3 改为：无 `active.json`、无 staged/partial instance、旧实例不复活、可再次安装；`instances/` 与 `shared/node` 可保留。

### S4（验收假红，已修正）A2 的 `apt-get update` 受 DNS/网络影响

上游 `STATUS.md:46-72` 记录过 guest DNS 不可用；`STATUS.md:131-145` 又说 V2425A 可用。把网络项当必过会产生**环境假红**。

已在 §0.3 拆成 A2a（本地必过：`os-release` / `node --version` / `dpkg -l`）与 A2b（条件项：`apt-get update`，失败记环境阻塞，不计产品红）。

### S5（技术）WP-5 的“系统 toybox”仍是环境假设；建议改成 Node 侧实现

**根因更正（2026-10-19 实机）**：`find` 的 `EACCES` 不是 SELinux 独有——`/data/data` 是 `tmpfs noexec`，`find` 是 app 私有 ELF，`cleanHostEnvironment()` 又剥掉了 termux-exec，所以直 exec 被 `MNT_NOEXEC` 拒。系统 toybox/Node 侧仍然是对的方向（它们避开 app 私有 ELF），但不要再把 ④ 解释成“只是 termux env 被剥”。

- 依赖 `/system/bin/{find,readlink,dirname,ln,mkdir,stat,chmod,awk,sed,wc,tr}` 全部存在且行为一致（`stat -c` / `ln -sfn` / `awk -v`）。任一差异都会让安装再次失败，只是把 `find: Permission denied` 换成别的错误。
- 脚本逻辑其实只有三件事：**枚举符号链接、读取目标、改写绝对链接**。用 Node 的 `readdir({withFileTypes})` + `lstat` + `readlink` + `symlink` + `unlink` 就能完成，且在 host 上可单测、可负控。**这能根除 ④，而不是换一套工具链。**
- 建议：WP-5 首选 **5A' Node 侧 `prepareRootfs`**（runtime 插件；保留现有 shell 脚本给构建宿主）；5B 的系统 shell 只作为过渡；5C（改 allowlist）继续禁止。
- 5B 若保留，必须复用 `spawnCommand` 的超时/捕获/进程组语义；报告 4a 的 `process.env` 临时合并会泄露宿主密钥，仍不可取。

### S6（安全）WP-3 的 `realpath` 失败回落是 fail-open

`.catch(() => lexicalRoot)` 在目录被删除/替换时回到非规范路径，重新引入别名不匹配；更糟的是，它把“规范化失败”变成“继续解包”。

**修正**：`realpath` 失败即抛错（fail closed）；realpath 之后再 lstat 一次，确认仍是同一目录且非符号链接；不要把 ② 说成修复 TOCTOU——它只修前缀比较。

### S7（安全/隐私）WP-1 的错误码可能是 Node errno，错误文本可能带路径

- `error.code` 可能是 `EACCES`/`ENOENT`（Node errno），不是稳定业务码；
- `safeError` 返回原始 `error.message`，可能含绝对路径、URL、甚至 token。

**修正**

- 只把白名单里的稳定码（`linux-*` / `linux-asset-*`）回前端；Node errno 映射成稳定码；
- 前端只显示**固定文案 + code**；原始 message/stack 只进 engine.log，且对 token/路径做脱敏；
- 503/500 都不回 `error.message` 原文。

### S8（UX/正确性）WP-6C 的能力探测默认 fail-open

“不是 `Permission denied`/126 就算 supported”会把 `sh` 启动失败、node 缺失、超时误判为支持。

**修正**

- 只有“exec 成功且拿到预期输出”才算 supported；其它一律 unsupported 或 inconclusive，**默认 unsupported**；
- 在 `status()` 暴露 `supported/reason`，面板**禁用安装按钮**并说明原因，而不是点击后才 409；
- 探测放在任何 manifest/下载/解包之前。

### S9（证据可行性）WP-7 依赖 `run-as`，release APK 未必可 debug

`run-as` 需要 debuggable；发布 APK 通常不是。用 release 包做 A1/A4 的文件证据会失败。

**修正**：明确用 **debug/dev APK** 做 `run-as` 证据；release 验收用 UI/status + 截图；或在 app 内加只读诊断导出。证据里标注构建类型。

### S10（门禁）WP-2 的摘要同步清单还差“不要改历史 evidence”

必改（若选 S1-A）：`check-vendored` 的 `LOCAL_PATCHES`、`package.json.dshVendor.localPatches`、`linux-source-manifest.json` 两处 `files` + `localPatches.reason`、`dshVendor.deviations`、gotchas/changelog；跑 `check-vendored --self-test`、`check-linux-sources --self-test`、`check-code-map`。

**不要改** `docs/AGENTS/ENGINE-UPGRADE-2026-10-19-evidence.json`（历史记录）。

若选 S1-B（宿主显式加载），上述 vendored 摘要大部分不需要动，改的是 host 插件与 profile——这也是为什么 S1 必须先定。

### S11（CI 计划小问题）

- `apply-patches.mjs` **没有 `--self-test`**；L1 证据应是 patch 测试套件 + 受控负控 + fixture 上的 `--apply`/`--check`，不是一个不存在的 flag。
- `PATCHED_FILES` 派生是正确方向；补一条“删掉 `additionalFiles` 行 → verifier 红”的负控。
- CI 验收必须整条 run 到 `verify-arm64`/`sign-arm64`；只过 step 24 不算。

---

## 11. 自审后的执行顺序（覆盖 §4）

```text
S2 归因（设备，P0）──> WP-6 路线 W3-lite/W2/W1/W3/W4（P0，可与 WP-3/4/5 并行）
S1 决策（A/B 架构）──> WP-2 ──> WP-3 ──> WP-4 ──> WP-5 ──> WP-7
WP-CI（独立）────────> 解锁 APK
WP-1（可并行，先做）
```

**硬规则**

- **S2 是本机已确认的主阻塞**：WP-6 为 P0；第 1–4 项实验未出结论前，不要启动 W2/W1 的后端实现；先测 W5（loader 放非 noexec 路径），不通再走 W2/W1。
- S1 未定，不开 WP-2。
- WP-5 优先 5A'（Node 侧）；toybox 只作过渡。
- A2b 网络项失败不得把发布判红；A4 不得要求删除 `shared/node`。
- 不再用 JS 热修补 ①②③④ 来“碰运气”；它们改不了内核 exec。








