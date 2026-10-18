# dsh-shell-termux 沙箱边界审计（2026-10-19）

审查基线：`3708f748404d59159cf8763a5862a3e647060751`（`main`）。

审查对象：本仓 Android shell provider `@dsh-android/dsh-shell-termux` 0.2.0，及其装配、配置、Android 权限面与文档承诺。

状态：源码级调查完成；**未修复产品代码、未重建插件 lib、未构建 APK、未做 Android 设备三层验收**。本报告只针对本仓 Android 实现，不评价桌面端 DSH 的进程沙箱，也不把宿主机探针当作设备证据。

## 1. 结论

`dsh-shell-termux` 的 `workspace-write` 和 `read-only` **没有路径级执行边界**。执行器把档位、工作区和共享目录写进子进程环境变量，然后直接启动 `bash -c`；`spec.sandboxPolicy` 在 `execute()` 中完全未被读取。`enforcement: 'partial'` 只是返回结果里的一个字段，既不会拒绝命令，也不会触发审批，模型面渲染还不会显示它。

因此，模型可以用 bash 读写应用私有目录；在用户授予 All Files Access 后，还可以访问共享存储中该权限覆盖的文件。这不是某一条命令的文本检查被绕过，而是围栏本身没有实现。

需要区分两个目标：

- **写面围栏**：`workspace-write` 只允许写工作区与明确授权的共享目录。当前未实现。
- **读隔离**：工作区外文件不可读。当前既未实现，也不是上游 `workspace-write` 的既有承诺；若产品需要，必须单独设计读白名单。

本报告把两者分开，避免把“只做写面”的旧契约误写成“读写都隔离”。

## 2. 范围与非范围

### 2.1 在范围内

- `dsh-shell-termux` 的 `resolve()` / `execute()` / `declareSandbox()` 执行链。
- `scripts/profile-web.cordis.patch.yml` 中 `shell-termux` 的装配与注释承诺。
- `app/src/main/AndroidManifest.xml` 的存储权限面。
- `dsh-shell-termux/README.md`、`docs/design.md` 与构建脚本对该边界的描述。
- 模型面是否会看到 `enforcement: partial`、是否会触发审批。
- 修复选项与设备验收判据。

### 2.2 不在范围内

- 桌面端 DSH 的进程沙箱行为。
- Android 内核、SELinux 策略本身的其他应用隔离能力。
- 其他应用私有目录的跨 UID 访问；Android SELinux 仍阻止普通应用互相读取。
- 真实设备上的 `/sdcard` 可访问性结论；本轮无在线设备，只能给出代码级路径与待验命令。
- 供应商凭据、控制令牌的具体值；本报告不读取、不记录任何秘密内容。

## 3. 预期语义与对外承诺

### 3.1 档位名义语义

| 档位 | 名义效果 | 当前 Android 实现 |
|---|---|---|
| `read-only` | 不产生文件写入 | 仍执行任意 bash；写入照常成功 |
| `workspace-write` | 只写工作区与允许的临时/共享目录 | 只设置环境变量；不检查路径 |
| `danger-full-access` | 不限制文件修改 | 与 `workspace-write` 实际无差别 |

### 3.2 仓库内的承诺互相矛盾

- [`scripts/profile-web.cordis.patch.yml`](../../scripts/profile-web.cordis.patch.yml#L22-L27) 写的是“写面栅栏（0.13.0 D21）：默认档位仅工作区与选定共享目录”，并配置 `workspaceRoot` 与 `sharedDirs`。
- [`dsh-shell-termux/src/index.ts`](../../dsh-shell-termux/src/index.ts#L154-L157) 的注释说这三个键是“write-fence facts”，是“host file tools fence against”的同一份配置。
- [`dsh-shell-termux/README.md`](../../dsh-shell-termux/README.md#L67-L69) 又明确说保护边界是 Android app domain，“not a path-level confiner”。
- [`dsh-shell-termux/docs/design.md`](../../dsh-shell-termux/docs/design.md#L58) 声称策略决策走 `sandbox-policy` + `tools/pre-execute` 审批（`ask`）。
- [`scripts/make-snapshot.sh`](../../scripts/make-snapshot.sh#L179-L193) 最直接：“no path-level confiner … read-only mode degrades the same way”。

实现与最后一组描述一致，与“仅工作区”的承诺不一致。这个矛盾不是单纯文案问题：配置和权限预设会据此向用户/模型声明 workspace 边界。

## 4. 执行链事实

### 4.1 调用链

1. `tool-bash` 按会话解析 `sandboxPolicy`，把 `spec.sandboxPolicy` 交给 `ctx.shell.execute()`。
2. [`TermuxBashExecutor.resolve()`](../../dsh-shell-termux/src/index.ts#L181-L186) 用 `termuxEnv()` 生成环境变量，并删除调用方对 `DSH_WRITE_MODE` / `DSH_WORKSPACE` / `DSH_SHARED_DIRS` 的覆盖。
3. [`termuxEnv()`](../../dsh-shell-termux/src/index.ts#L159-L171) 只写入 `PATH`、`LD_LIBRARY_PATH`、`HOME`、`PREFIX`、`TERMUX_VERSION`、`SHELL` 和三个 `DSH_*` 键；没有任何路径检查。
4. [`execute()`](../../dsh-shell-termux/src/index.ts#L229-L232) 直接调用 `executeArgv(spec, bashArgv(spec.command))`；[`bashArgv()`](../../dsh-shell-termux/src/index.ts#L200-L202) 返回裸的 `[bashPath, '-c', command]`。
5. `execute()` 从未调用 `ctx.sandbox.confine()`；`spec.sandboxPolicy` 也没有被读取。
6. [`declareSandbox()`](../../dsh-shell-termux/src/index.ts#L211-L221) 固定写入 `mode: this.writeMode`、`denied: false`、`enforcement: 'partial'`。`this.writeMode` 来自部署配置，不是本次调用的 `spec.sandboxPolicy.mode`。

### 4.2 工作区不是 cwd

装配里的 `workspaceRoot` 是 `files/home/.dsh/workspaces`，但默认 `cwd` 是 [`files/home`](../../scripts/profile-web.cordis.patch.yml#L19)。调用没有显式 `workdir` 时，bash 回落到 `files/home`；即使会话 `workdir` 被设为 workspace，bash 也可以立即 `cd /` 或 `cd /data/data/<package>/files/home`，访问 `.dsh/.credentials.yaml`、`shared_prefs` 等应用私有内容。`workspaceRoot` 只作为 `DSH_WORKSPACE` 环境变量存在，不参与 cwd，也不参与任何包含判定。

### 4.3 Android 权限面放大

[`AndroidManifest.xml`](../../app/src/main/AndroidManifest.xml#L4-L6) 声明了 `MANAGE_EXTERNAL_STORAGE`。一旦用户授予 All Files Access，同一 app UID 下的 bash 就能访问共享存储中该权限覆盖的范围；即使未授予，app 私有目录仍然可读写。

## 5. 复现

### 5.1 宿主等价执行器探针

本轮使用临时探针（未入库）构造真实的 `TermuxBashExecutor`，用假的 Cordis context 捕获/执行 subprocess。设置：

- `workspaceRoot = /tmp/dsh-termux-workspace`
- 目标 = `/tmp/dsh-termux-outside/written-by-bash`（工作区外）
- 请求策略 = `read-only`
- 命令 = `printf pwn > <目标>; pwd`

结果：

```json
{
  "workspace": "/tmp/dsh-termux-workspace",
  "target": "/tmp/dsh-termux-outside/written-by-bash",
  "requestedMode": "read-only",
  "reportedMode": "workspace-write",
  "enforcement": "partial",
  "exitCode": 0,
  "stdout": "/private/tmp/dsh-termux-workspace",
  "wroteOutsideWorkspace": true,
  "targetContents": "pwn"
}
```

这证明了三件事：

1. 请求 `read-only`，执行器实际报告 `workspace-write`；
2. 工作区外文件被成功写入，退出码 0；
3. 没有 `sandbox-exec`、bwrap、Landlock 或任何等价包装；spawn 的 argv 就是 `[bashPath, '-c', command]`。

探针只验证执行器逻辑，不代表 Android 设备上的 SELinux/共享存储实测结论。

### 5.2 探针关键形态

```js
const spec = executor.resolve({
  command: `printf pwn > ${target}`,
  workdir: workspace,
  sandboxPolicy: { mode: 'read-only', workspaceRoot: workspace },
})
const result = await (await executor.execute(spec)).result()
```

只要 fake `ctx.subprocess.spawn` 捕获 `spec.argv`，就能看到裸 bash；只要让它真实执行，就能看到工作区外写入成功。复现不依赖 Android 设备，也不依赖桌面沙箱配置。

### 5.3 Android 设备待验命令

以下命令只用于修复后的设备验收，本轮**未执行**（本机无 `adb`）：

```sh
# 写面：工作区外写入应被拒绝
touch /sdcard/Download/dsh-sandbox-probe

# 读面：若产品要求读隔离，应不可读
test -r /data/data/com.snoworwind.pocketharness/files/home/.dsh/.credentials.yaml && echo readable

# 工作区内写入应成功
touch /data/data/com.snoworwind.pocketharness/files/home/.dsh/workspaces/probe
```

设备验收必须按 [模拟器验收规范](emulator-test-protocol.md) 做代码层、CDP 层、ADB 用户层三层，不能用本报告的宿主探针代替。

## 6. 根因

1. **缺少执行层**：为了绕开 Android 上 `bash-sandbox` 的 fail-closed，`dsh-shell-termux` 直接把 `ctx.shell` 换成裸 bash，但没有补上路径级 fence。
2. **每次调用的策略被丢弃**：`execute()` 不读 `spec.sandboxPolicy`；`read-only` / `danger-full-access` 会话档位对 bash 完全不生效。
3. **事实字段硬编码**：`declareSandbox()` 使用部署配置的 `this.writeMode`，不是本次调用的 mode；因此返回的 `mode` 也可能是错的。
4. **`partial` 不是门**：它只是一个结果字段。没有 denial，模型不会被提示重试；即使提示，也只有显式提交 `sandbox_permissions` 才会请求审批。模型面渲染只处理 `sandbox.denied`，不显示 `enforcement`。
5. **文档与实现分叉**：配置注释承诺“仅工作区与共享目录”，README/构建脚本又承认“no path-level confiner”。两条叙事同时存在，用户和模型会按前者理解。
6. **app-domain 边界被当成了 workspace 边界**：SELinux 只隔离不同 app UID；同一 UID 的 bash 与应用私有目录、引擎、会话数据没有隔离。
7. **权限面放大**：`MANAGE_EXTERNAL_STORAGE` 让 app-domain 进一步覆盖共享存储。

## 7. 影响

| 类别 | 前提 | 影响 |
|---|---|---|
| 读应用私有数据 | 始终（同 UID） | 可读 `.dsh/.credentials.yaml`、会话日志、快照/配置、`shared_prefs` 等；代码级可达，设备待验 |
| 写应用私有数据 | 始终（同 UID） | 可改 profile patch、配置、会话/工作区数据，可能形成跨重启持久化 |
| 读共享存储 | 用户授予 All Files Access | 可读照片、下载、文档及其他应用在共享存储的可见文件 |
| 写共享存储 | 用户授予 All Files Access | 可写/删共享存储中的用户文件 |
| 审批绕过 | 上述所有场景 | 因为 `denied: false`，不会产生 denial 提示；正常命令不需要用户批准。 |
| 模型/用户知情 | 上述所有场景 | `enforcement: partial` 不进入模型面文本，普通成功输出不会提示“未完全围栏” |
| 凭据外带 | 有网络权限 | 读取到的 provider 凭据/控制令牌可经 bash `curl` 等外发；网络面不在本沙箱策略内 |

严重度：在“`workspace-write` 表示工作区写边界”的威胁模型下为 **High**；若产品明确接受 app-domain 作为边界，则降为 **文档/授权语义缺陷 + 高危能力面**，但用户仍需被告知 bash 不是 workspace 围栏。

## 8. 现有缓解为何不足

| 缓解 | 为什么不够 |
|---|---|
| `enforcement: 'partial'` | 只是结果字段；不阻断、不审批、不进入模型面。它是标签，不是边界。 |
| Android SELinux app domain | 防的是其他 app 的私有目录；同一 app UID 内的 bash、引擎、凭据没有隔离。共享存储还受 All Files Access 放大。 |
| 审批流 | 本报告的 Android 装配检查未发现普通 bash 的通用 `tools/pre-execute` ask 监听；`tool-bash` 只在模型显式提交 `sandbox_permissions` 时调用 escalation，denial 只返回提示。本路径没有 denial。 |
| `DSH_WRITE_MODE` / `DSH_WORKSPACE` / `DSH_SHARED_DIRS` | 只是环境变量，子进程可忽略、可覆盖（`export`），不能阻止 `cd /` 或写入任意路径。 |
| `workspaceRoot` 配置 | 不是 cwd，不参与包含检查；只是 `DSH_WORKSPACE` 的值。 |
| `sandbox-local` 的 Android 降级补丁 | `shell-termux` 根本不调用 `ctx.sandbox.confine()`；即使调用，该补丁也是在 Android 上返回原 argv，不会产生路径 fence。 |
| bwrap / Landlock | 当前 Android 装配没有可用实现；不能把“上游 Linux 有”当成“Android 有”。 |

## 9. 修复选项

### 9.1 P0：先停止“无声无围栏”执行

这是最小、最快的风险收口，但会改变默认可用性，需要产品决策。

- `TermuxBashExecutor.execute()` 读取 `spec.sandboxPolicy`，不要再用部署 `this.writeMode` 覆盖本次调用。
- 当 mode 是 `read-only` 或 `workspace-write`，且没有真实 fence 时：
  - **方案 A（推荐，fail-closed）**：拒绝执行并返回结构化 `SANDBOX_UNAVAILABLE` 类错误，提示用户显式切换到 `danger-full-access` 或安装围栏。
  - **方案 B（可用性优先）**：将这两档显式升级为 `danger-full-access`，但必须先走用户审批，并在结果里标注“实际以完整权限执行”。
- 无论选 A 还是 B，都必须把 `enforcement: partial` 或 `denied` 写进模型可读文本，不能只放在结构化字段里。
- 修正配置注释、README、design.md 和构建脚本中的“写面栅栏/仅工作区”措辞，统一为“app-domain，不是路径级围栏”，直到真正实现 fence。

### 9.2 P1：实现真正的 Android 路径围栏

- **Landlock 原生 addon**：优先方案。给 bash 及其后代授予：
  - 读写：workspace、必要的临时目录；
  - 只读：系统运行时、动态库、`/system`、`/apex` 等；
  - 其他路径：拒绝。
  必须在目标 ARM64 内核上探测 Landlock ABI；不可用就 fail closed，不能静默退回裸 bash。
- **独立 UID / 独立进程**：如果 Landlock 不可用，考虑把 shell 放进独立 UID 的进程，只通过受控通道暴露 workspace；这会牵涉文件共享、IPC 和权限模型，是架构级改动。
- **容器 / VM**：需要完整隔离时使用；`proot` 不应作为安全边界。
- **最小权限**：评估是否必须保留 `MANAGE_EXTERNAL_STORAGE`；共享目录优先走 SAF 显式授权，而不是全域 All Files Access。
- **秘密隔离**：把 provider 凭据、控制令牌移出 bash 同 UID 可读的范围，或使用 shell 进程无法解密的封装；仅靠“应用私有目录”不是隔离。

### 9.3 P2：测试与文档

- 单元测试：`read-only` 请求不得写出 workspace；返回的 `mode` 必须等于请求 mode；`workspace-write` 外写必须被拒绝。
- 宿主测试：保留本报告的等价探针，作为 fence 行为的快速回归（不能替代设备验收）。
- 设备测试：按 [模拟器验收规范](emulator-test-protocol.md) 做三层，覆盖：
  - `read-only` 下 `touch /sdcard/...` 被拒；
  - `workspace-write` 下工作区外写被拒、工作区内写成功；
  - 若要求读隔离，`.dsh/.credentials.yaml` 不可读；
  - `danger-full-access` 经用户审批后才可执行，并有审计记录；
  - 模型面显示 `partial`/denial，而不是普通成功。
- 把本报告链接到 [known-gaps.md](known-gaps.md)，修复后更新状态与证据。

## 10. 验收判据

| 用例 | 前置 | 修复后预期 | 证据 |
|---|---|---|---|
| 工作区外写 | `workspace-write` | 拒绝，目标文件不存在 | 设备截图 + 命令回执 + 代码层断言 |
| 工作区内写 | `workspace-write` | 成功 | 同上 |
| `read-only` 写 | `read-only` | 拒绝，目标文件不存在 | 同上 |
| 读应用私有凭据 | 任意受限档位 | 若承诺读隔离则拒绝；仅写面则明确记录可读 | 设备布尔探针，不落秘密明文 |
| 档位切换 | 会话切 `read-only` → `danger-full-access` | 返回 mode 随调用变化，环境/事实一致 | 单元测试 + 设备回执 |
| 审批 | 受限档位尝试越界 | 不静默成功；需要审批时有审批记录 | 审批 UI 截图 + session 审计 |
| 模型面提示 | 任意 `partial` 执行 | 文本出现 partial/denial 提示 | CDP 层工具结果断言 |

## 11. 证据与限制

- 基线：`3708f748404d59159cf8763a5862a3e647060751`。
- 代码证据：本报告引用的 `src/index.ts`、装配 yml、Manifest、README、design.md、make-snapshot.sh。`lib/index.js` 是 `src/index.ts` 的同源构建产物，当前同步。
- 运行时证据：临时探针在宿主上用真实 `/bin/bash` 执行，输出见第 5.1 节；探针未入库，不进入产品。
- **未做设备验证**：本机没有 `adb`，没有在线 ARM64 设备；未构建 APK、未安装、未跑 CDP/ADB 用户任务。第 5.3 节命令只是待验清单，不是通过证据。
- **未修复**：本报告不改变生产代码，也不把 `enforcement: partial` 当作已关闭。
- 本报告不读取或记录任何凭据内容；设备验收应使用 `test -r`/布尔结果，不把秘密明文拉回工作区。

## 12. 相关文档

- [known-gaps.md](known-gaps.md) — 当前缺口登记。
- [SECURITY-HARDENING.md](SECURITY-HARDENING.md) — 本分支安全边界与证据要求。
- [emulator-test-protocol.md](emulator-test-protocol.md) — 三层验收与真实任务要求。
- [AGENTS.md](../../AGENTS.md) — 分支、PR、设备验证与文档更新协议。
- [dsh-shell-termux/README.md](../../dsh-shell-termux/README.md) — 该包的自我声明。
- [dsh-shell-termux/docs/design.md](../../dsh-shell-termux/docs/design.md) — 设计意图与历史边界。

## 附录 A：报告结论一句话

`workspace-write` 在 Android 上没有执行层，只有环境变量和 `partial` 标签；bash 以 app UID 直接运行，读应用私有目录是必然，读共享存储取决于 All Files Access，且全程不需要审批。
