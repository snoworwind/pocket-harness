# DSH Mobile · 「Linux 环境」安装失败排查报告

> 记录时间：2026-10-19 15:50（+0800）
> 对象：设置页 **Linux 环境 → 安装 Linux 环境** 在真机上"点了没反应 / 最终失败"
> 结论：安装链路上共发现 **5 个问题**。前 4 个可在本机插件代码里修复（已验证装到"只剩最后一步 smoke probe"），第 5 个是 **bionilux 后端在 Android 10+ 上的执行模型限制**，需要后端改造，配置层绕不过去。
> 现状：本机所有临时补丁 **已全部回退**，插件文件与厂家 0.14.x 原版逐字节一致（sha256 见文末），残留目录已清理。本报告供上游修复参考。

---

## 1. 现象与调用链

设置页「Linux 环境」的"安装"按钮 → `POST /api/android/linux-environment/install`（`webServer` 精确路由）→ `linuxBootstrap.install()` → 依次：

```
① 读取/校验清单         readBundledManifest(<prefix>/share/pocket-harness/linux-assets/linux-release.json)
② 复制并校验运行时插件包  installVerifiedPluginBundle(linux-runtime-plugin.tar.xz)
③ 激活运行时插件         pluginHost.install()（Cordis ctx.plugin）
④ 解包 backend/rootfs/node LinuxRuntimeManager.install()
⑤ 准备 rootfs            prepare-rootfs.sh（依赖宿主 find/readlink）
⑥ smoke probe            bionilux node --version
⑦ 提交 active 记录、写回 state
```

失败发生在①（插件根本没激活）或③~⑥（激活后）。每一环的排查证据都在下面。

设备/版本事实：

| 项 | 值 |
|---|---|
| 应用数据根 | `/data/data/com.snoworwind.pocketharness/files`（与 `/data/user/0/com.snoworwind.pocketharness/files` **是同一目录的两个路径**） |
| profile | `~/.dsh/profiles/{web,headless}/node_modules/@dsh-android/` |
| 内置资产 | `<files>/usr/share/pocket-harness/linux-assets/`（`linux-release.json` + 4 个 tar.xz） |
| 插件版本 | `@dsh-android/linux-bootstrap` 0.5.0、`@dsh-android/linux-runtime` 0.5.0、bionilux 0.4.2 |
| 引擎日志 | `<files>/engine.log`、`<files>/boot-diag.log`（页面侧，含 http-error） |
| 文件系统 | f2fs（`app 数据区`） |

---

## 2. 问题 ①：插件启动即崩 → 设置页所有请求 503

**位置**：`profiles/<p>/node_modules/@dsh-android/linux-bootstrap/lib/index.js:589`

```js
export const inject = ['linuxPluginHost', 'linuxBootstrapConfig']   // 第 10 行

export function apply(ctx, config = {}) {
  const hostConfig = ctx.linuxBootstrapConfig ?? {}
  const pluginHost = config.pluginHost ?? ctx.linuxPluginHost
  const filesDir = config.filesDir ?? ctx.filesDir ?? process.env.DSH_FILES_DIR   // ← 589 行
  ...
}
```

**机理**：宿主从来没有 `ctx.provide('filesDir')`。Cordis 的 ctx 是一个 Proxy，访问未声明属性会抛
`cannot get property "<prop>" without inject`（`.../@deepseek-ai/cordis/lib/index.js:676`）。于是 `apply()` 抛错 → fiber 进入 error 态 → `linuxBootstrap` 服务缺席。

**后果**：`dsh-android-linux-env` 注册的路由里 `bootstrap()` 返回 undefined，于是：

```js
// dsh-android-linux-env/lib/linux-environment.js:289-293
const bootstrap = options.bootstrap();
if (!bootstrap) {
  send(res, 503, { error: 'Linux bootstrap 内部插件尚未启用。它随应用放在内置（hard）插件目录里，需要你显式启用后重载引擎；存在不等于启用。' });
  return;
}
```

文案把人引向"需要显式启用"，实际是插件崩了。

**证据**：

- `engine.log` 在修复前的**每一轮 boot** 里都出现（当时保留的 12:40×2 / 13:19 / 13:52 / 13:59 全部命中；日志轮转会覆盖旧条目）：
  ```
  dsh: warning: 1 entry did not activate
  linux-bootstrap (@dsh-android/linux-bootstrap): Error: cannot get property "filesDir" without inject
      at new apply (.../linux-bootstrap/lib/index.js:589:43)
  ```
- `boot-diag.log`（页面侧）记录 `GET /api/android/linux-environment/status status=503`。

**修复建议**：不要访问未声明属性。真源已经是 `linuxBootstrapConfig.dataDir`（宿主在 `linuxBootstrapConfig` 里给了 `dataDir = <files>/linux-environment`），或退回环境变量：

```js
const filesDir = config.filesDir ?? process.env.DSH_FILES_DIR
// dataDir 已经有 config.dataDir ?? hostConfig.dataDir ?? join(filesDir,'linux-environment') 三级回落
```

如果确实需要 `ctx.filesDir`，就把它加进 `inject` 并在宿主 `provide`，两边必须成对改。

---

## 3. 问题 ②：解包器硬链接校验用未规范化路径 → rootfs 必失败

**位置**：`dsh-android-linux-env/lib/linux-host-asset-io.js`，`extractVerifiedArchive()` 的硬链接收尾（原版 202–209 行）

```js
const root = resolve(destination);            // 可能是 /data/data/… 这条非规范路径
...
for (const entry of links.filter(item => item.hard)) {
  const sourceInfo = await lstat(entry.source);
  const physical = await realpath(entry.source);      // 返回规范化路径（如 /data/user/0/…）
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !physical.startsWith(root + sep))
    throw new Error('Archive hard link must target an extracted regular file');   // 恒触达
  await link(entry.source, entry.target);
}
```

**机理**：本机 `/data/data/…` 与 `/data/user/0/…` 是同一目录的两个路径。`root` 若来自
`resolve()`（未规范化），而 `realpath()` 返回规范化结果，`startsWith` 必然为 false。

**触发点**：Debian rootfs 里恰有一条硬链接
`./usr/bin/perl5.40.1 → ./usr/bin/perl`（`tarfile` 确认 `islnk()`，target 为普通文件），于是任何 rootfs 解包都会在这条上失败，报
`Archive hard link must target an extracted regular file`。

**修复建议**：比较前把两边都规范化（或一开始就用 `realpath(root)` 作为基准）：

```js
const rootCanonical = await realpath(root).catch(() => root);
...
const physical = await realpath(entry.source).catch(() => undefined);
if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || physical === undefined
    || (physical !== rootCanonical && !physical.startsWith(rootCanonical + sep)))
  throw new Error('Archive hard link must target an extracted regular file');
```

---

## 4. 问题 ③：本机文件系统禁止硬链接 → 修好②后仍失败

**位置**：同上，`await link(entry.source, entry.target)`。

**机理/证据**：

```
$ ln hla hlb
ln: failed to create hard link 'hlb' => 'hla': Permission denied      # EACCES
$ stat -f -c %T ~/tmp
f2fs
```

本机 app 数据分区（f2fs）**不允许创建硬链接**（不是 SELinux 的 exec 问题，普通 `ln` 也拒绝）。rootfs 的 `perl5.40.1` 又刚需这条硬链接。

**修复建议**：`link()` 失败时退回"内容副本"（语义等价，仅多占 ~4 MB）：

```js
try {
  await link(entry.source, entry.target);
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error?.code)) throw error;
  await copyFile(entry.source, entry.target);
  await chmod(entry.target, (await stat(entry.source)).mode & 0o777);
}
```

（`rootfs` 里硬链接很少，实测仅 1 条；`backend`/`node` 归档为 0 条，代价可忽略。）

---

## 5. 问题 ④：prepare-rootfs.sh 无法执行宿主工具（termux-exec 环境被剥）

**位置**：`linux-runtime` 插件包内的 `modules/manager.js`

```
HOST_ENV_ALLOWLIST = ['PATH','ANDROID_ROOT',…]        // 19–42 行，白名单里没有 LD_PRELOAD
cleanHostEnvironment()                                 // 369–375 行：只保留白名单变量
_prepareRootfs(): spawn({ file:'sh', args:[script,…], env: cleanHostEnvironment() })   // 722–735 行
```

**机理**：`sh` 脚本第 62 行 `links=$(find "$ROOTFS" -type l)`，`find` 解析到 `<prefix>/usr/bin/find`（app 私有数据区的 ELF）。Android 上这类 ELF 的 `execve` 被拒，必须靠 **termux-exec 的 LD_PRELOAD 拦截后改走 `/system/bin/linker64`**；而 `cleanHostEnvironment()` 把 `LD_PRELOAD`/`TERMUX_EXEC__*` 全剥掉了，于是：

```
prepare-rootfs.sh[62]: /data/data/…/usr/bin/find: Permission denied
```

**额外实测（很重要，决定了修法）**：

| 写法 | 结果 |
|---|---|
| `spawn(file, args, { env })` 显式传 env（哪怕 env 里带 LD_PRELOAD） | app 私有 ELF 一律 `EACCES` |
| `spawn(file, args)` 不传 env（继承进程环境） | 正常 |
| 用 `/system/bin/sh` + `LD_PRELOAD` 再 exec 宿主 `find` | 仍 `EACCES`（系统域进程 dlopen 不了 app 私有 .so） |
| `/system/bin/sh` + `PATH=/system/bin:…` 后 `find` | 正常（系统 toybox 自带 find/readlink/sed） |

**修复建议**（任选其一）：

1. **准备脚本不要依赖宿主 `$PREFIX` 工具**：把 `find` 换成系统 toybox（`/system/bin/find`），或在 Node 里直接遍历（脚本逻辑简单）。
2. 宿主侧注入 `runCommand`（插件本身支持 `config.runCommand`，只是宿主没提供）：
   - `spec.file === 'sh'` → 用 `/system/bin/sh` + `PATH=/system/bin:…`；
   - 其余命令 → **不要显式传 env**，把需要的变量临时并入 `process.env` 后 spawn（libuv 在 spawn 调用时同步构建 envp）。
3. 至少要允许 `LD_PRELOAD`/`TERMUX_EXEC__*` 通过 `HOST_ENV_ALLOWLIST`，并把 `sh` 钉到 app 数据区的 bash（系统 sh 加载不了 app 私有 preload）。

---

## 6. 问题 ⑤：smoke probe —— bionilux 启不动 glibc guest（平台限制）

**位置**：`linux-runtime/modules/manager.js` `_probeRuntime()`（541–566 行）

```js
{ file: health.paths.launcher,            // <instance>/backend/bin/bionilux
  args: ['node', '--version'],
  env: { BIONILUX_ROOTFS, BIONILUX_PRELOAD, BIONILUX_GUEST_PATH, BIONILUX_ANDROID_PATHS:'1', … } }
```

**机理**：`backend/bin/bionilux` 是
`ELF shared object, dynamic (/system/bin/linker64), for Android 24, built by NDK r30`（bionic 可执行）。
guest 的 `node` 是 **glibc** ELF（`node-glibc-v24.22.0-linux-arm64`，位于 app 私有数据区）。

两条路都走不通：

| 路径 | 结果 |
|---|---|
| 不注入 termux 拦截，bionilux 直接 `execve` guest node | `[ERROR] execve failed: EACCES: Permission denied`（Android 10+ 的 `execute_no_trans`：app 私有 ELF 不能被内核 exec） |
| 注入 termux 拦截（`TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`） | execve 被改写为 `/system/bin/linker64 <glibc node>` → bionic linker 拒绝 glibc ELF：`Could not find a PHDR: broken executable?` |

**结论**：这不是配置/JS 能修的。glibc guest 要在 Android 10+ 上启动，必须**绕过内核 execve**（proot 式 ptrace 注入/ELF 映射跳转），或改用 bionic 可加载的运行时；bionilux 当前 arm64 版本没有提供这条路。

**上游可选方向**：
- 给 bionilux 增加 fake-exec（proot 式）或在 Android 上走 proot 后端；
- 或者明确限制该功能只在允许 app 数据区 exec 的环境（targetSdk ≤ 28、或特定 ROM）开启，并在 UI 里做能力探测/说明；
- 或者提供"Termux proot-distro"路线的替代实现。

---

## 7. 可观测性问题（顺带发现）

- `linux-bootstrap` 安装失败时只 `emit()` 不 `save()`（`index.js` install 的 catch），所以状态文件里永远 `lastError: null`，设置页只能看到路由兜底的「操作失败，请检查环境状态与日志后重试」。
  建议：失败时 `await save()`，路由 500 响应带上稳定错误码/短原因。
- 503 的文案（`linux-environment.js:291`）在"插件崩溃"和"未启用"两种情况都会出现，建议区分。

---

## 8. 复现与验证方法（本机实测用的）

1. **看插件是否激活**：`grep -n "did not activate\|without inject" <files>/engine.log`。
2. **看页面请求结果**：`grep "linux-environment" <files>/boot-diag.log`（有 `status=503/500`）。
3. **单测解包**（不需要起引擎）：

```js
process.env.TERMUX__PREFIX = '<files>/usr'
const hostMod = await import('<profile>/node_modules/@dsh-android/dsh-android-linux-env/lib/linux-host-asset-io.js')
const hostConfig = hostMod.createLinuxBootstrapConfig({ filesDir: '<tmp>', appVersion: '0.14.7' })
await hostConfig.linuxAssetIO.extractArchive(
  '<files>/usr/share/pocket-harness/linux-assets/debian-minimal-aarch64.tar.xz',
  '<tmp>/rootfs', { kind: 'rootfs' })      // 原版：硬链接报错；修②③后：OK
```

4. **整链复现**（真实宿主流 + 真 Cordis）：

```js
const app = new (mod.Context)(); app.provide('tools', { register: () => () => {} })
const pluginHost = { install: async ({directory, entry='lib/index.js', config}) => {
  const plugin = await import(pathToFileURL(join(directory, entry)).href)
  const fiber = app.plugin(plugin, config); await fiber
  return { directory, manager: fiber.ctx.linuxRuntimeManager, rollback: () => fiber.dispose() } } }
const bootstrap = bootstrapMod.apply({ linuxBootstrapConfig: hostConfig, linuxPluginHost: pluginHost,
  provide(){}, effect(){}, get(){} }, {})
await bootstrap.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })
```

本机实跑结果（临时目录，未污染 app 数据）：

| 阶段 | 结果 |
|---|---|
| 原版 | `apply()` 抛 `cannot get property "filesDir" without inject` |
| 修① | `apply()` OK；`status()` = `installed:false` |
| 修② | rootfs 解包仍失败（`hard link must target an extracted regular file` → 修后进入 `link EACCES`） |
| 修③ | rootfs 解包 OK（6328 条目） |
| 修④ | `prepare-rootfs.sh` OK（整链 ~33 s 到达 probe） |
| 修⑤ | 卡在 `execve EACCES` / `Could not find a PHDR` |

---

## 9. 本机操作记录（已全部回退）

- 曾在 `profiles/{web,headless}` 内就地打过 4 处补丁（见 `ORIGINAL-PATCHES-2026-10-19.md`），并做过 3 次重启验证：
  - 14:10 重启后插件成功激活（`engine.log` 无 `did not activate`，`files/linux-environment/` 被创建）；
  - 14:46 点击安装 → 页面 500（此时已修到⑤之前的环节）；
  - 15:15 回退后重启 → 原版行为恢复（503 + `without inject`）。
- 回退后核对（与厂家原版逐字节一致）：
  ```
  7517ac3c…382645  linux-bootstrap/lib/index.js
  50f10c91…53a717  linux-host-asset-io.js
  ```
- 残留清理：`<files>/linux-environment/`（60 MB，失败安装产生）已删除；无其它遗留。

---

## 10. 一句话总结

> 用户点"安装"没反应，根因是 **linux-bootstrap 插件在激活阶段就崩了**（读了未声明的 `ctx.filesDir`），路由只能回 503；把激活修好后，安装链会依次撞上 **硬链接路径规范化**、**f2fs 禁硬链接**、**宿主命令被剥 termux-exec 环境** 三个真 bug，最终停在 **bionilux 无法在 Android 10+ 上 exec glibc guest** 这个平台级限制上。前四个可直接修，第五个需要后端支持 ptrace 式 fake-exec。



