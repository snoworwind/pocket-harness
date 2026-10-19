# 「Linux 环境」修复建议 · 具体代码

> 配合 `ORIGINAL-REPORT-2026-10-19.md` 阅读。以下片段是**本机验证过**的写法（装到 smoke probe 之前全部通过），供上游参考，不一定是最终设计。
> 所有改动都在 `profiles/<web|headless>/node_modules/@dsh-android/` 下；改完需**重启引擎**才生效。

---

## 补丁 1 · 激活期：不要读未声明的 `ctx.filesDir`

文件：`linux-bootstrap/lib/index.js`（第 589 行）

```diff
 export function apply(ctx, config = {}) {
   const hostConfig = ctx.linuxBootstrapConfig ?? {}
   const pluginHost = config.pluginHost ?? ctx.linuxPluginHost
-  const filesDir = config.filesDir ?? ctx.filesDir ?? process.env.DSH_FILES_DIR
+  const filesDir = config.filesDir ?? process.env.DSH_FILES_DIR
   const dataDir = config.dataDir ?? hostConfig.dataDir ?? (filesDir ? path.join(filesDir, 'linux-environment') : null)
```

说明：宿主本来就只通过 `linuxBootstrapConfig.dataDir` 和 `DSH_FILES_DIR` 提供文件目录，`ctx.filesDir` 从未 `provide` 过；Cordis 对未声明属性直接抛 `cannot get property "filesDir" without inject`。
若坚持要 `ctx.filesDir`，必须同时把它加进 `inject` 数组并在宿主 `ctx.provide('filesDir', …)`，两边成对改。

---

## 补丁 2 · 安装失败时落盘 `lastError`（可观测性）

文件：`linux-bootstrap/lib/index.js`，`installRuntime()` 的 catch（约 408 行）

```diff
       state.lastError = safeError(error)
+      await save().catch(() => undefined)   // 否则状态文件里永远 lastError:null，UI 只有泛化文案
       emit()
       throw error
     } finally {
```

路由侧建议同步改（`dsh-android-linux-env/lib/linux-environment.js` 的 catch）：把 `error.message`（脱敏）或稳定错误码回给前端，而不是固定一句"操作失败"。

---

## 补丁 3 · 硬链接：路径规范化 + 本机禁硬链接时复制兜底

文件：`dsh-android-linux-env/lib/linux-host-asset-io.js`

### 3a. import（原第 6–7 行）

```diff
-import { createReadStream, createWriteStream } from 'node:fs';
-import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
+import { spawn } from 'node:child_process';
+import { createReadStream, createWriteStream, existsSync } from 'node:fs';
+import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
```

### 3b. `extractVerifiedArchive()` 的硬链接收尾

```diff
+    // Android 上 /data/data/… 与 /data/user/0/… 是同一目录，resolve() 与 realpath() 结果可能不同前缀
+    const rootCanonical = await realpath(root).catch(() => root);
     for (const entry of links.filter(item => item.hard)) {
         await safeParents(entry.target);
-        const sourceInfo = await lstat(entry.source);
-        const physical = await realpath(entry.source);
-        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !physical.startsWith(root + sep))
+        const sourceInfo = await lstat(entry.source).catch(() => undefined);
+        const physical = sourceInfo === undefined ? undefined : await realpath(entry.source).catch(() => undefined);
+        if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || physical === undefined
+            || (physical !== rootCanonical && !physical.startsWith(rootCanonical + sep)))
             throw new Error('Archive hard link must target an extracted regular file');
-        await link(entry.source, entry.target);
+        try {
+            await link(entry.source, entry.target);
+        }
+        catch (error) {
+            // 本机 app 数据分区为 f2fs，禁止创建硬链接（连 `ln` 都 EACCES）；复制等价，多占 ~4 MB
+            if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error?.code))
+                throw error;
+            await copyFile(entry.source, entry.target);
+            await chmod(entry.target, (await stat(entry.source)).mode & 0o777);
+        }
     }
```

---

## 补丁 4 · 宿主命令：补回 termux-exec 环境 / 准备脚本改用系统 toybox

背景（实测）：

| 写法 | 结果 |
|---|---|
| `spawn(file, args, { env })` 显式传 env（即便 env 里带 `LD_PRELOAD`） | app 私有 ELF `EACCES` |
| `spawn(file, args)` 不传 env（继承） | 正常 |
| `/system/bin/sh` + `LD_PRELOAD` 再 exec 宿主 `find` | 仍 `EACCES`（系统域进程 dlopen 不了 app 私有 .so） |
| `/system/bin/sh` + `PATH=/system/bin:…` | 正常（系统 toybox 提供 find/readlink/sed） |

### 4a. 宿主流注入 `runCommand`（推荐，改动都在宿主侧）

文件：`dsh-android-linux-env/lib/linux-host-asset-io.js`

```js
// 与 runtime 插件自带 spawnCommand 同形（捕获上限/超时），返回 Promise（插件两种形态都接受）
function runHostCommand(spec) {
  const args = spec.args ?? []
  const stdio = ['ignore', 'pipe', 'pipe']
  let file = spec.file
  let env
  if (spec.file === 'sh') {
    // prepare-rootfs.sh：系统 sh + 系统 toybox，完全避开 app 私有 ELF 的 exec 限制
    file = existsSync('/system/bin/sh') ? '/system/bin/sh' : spec.file
    env = { ...spec.env }
    const parts = (env.PATH ?? '').split(':').filter((p) => p && p !== '/system/bin')
    env.PATH = ['/system/bin', ...parts].join(':')
  }
  // 其余（bionilux 及其 guest）：不能显式传 env，否则 app 私有 ELF exec EACCES
  const child = env === undefined
    ? spawnWithoutExplicitEnv(file, args, spec.cwd, spec.env ?? {}, stdio)
    : spawn(file, args, { cwd: spec.cwd, env, stdio, detached: process.platform !== 'win32', windowsHide: true })
  return new Promise((resolve, reject) => {
    ...捕获 stdout/stderr（256 KiB 上限）、超时 SIGKILL、close 后 resolve({stdout,stderr,exitCode,signal,timedOut})
  })
}

/** 临时把 extraEnv 并入 process.env 后 spawn（uv 在 spawn 调用时同步构建 envp，随后立刻还原）。 */
function spawnWithoutExplicitEnv(file, args, cwd, extraEnv, stdio) {
  const saved = new Map()
  for (const [key, value] of Object.entries(extraEnv)) {
    if (process.env[key] === value) continue
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined)
    process.env[key] = value
  }
  try {
    return spawn(file, args, { cwd, stdio, detached: process.platform !== 'win32', windowsHide: true })
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
}
```

注入点：`createLinuxBootstrapConfig()` 的返回值，**必须放在 `runtimePluginConfig` 里**（插件只读那里；顶层 `runCommand` 不会传给插件）：

```diff
     return {
         dataDir,
+        runCommand: runHostCommand,
         manifestProvider,
         verifyManifest: …,
         linuxAssetIO: assetIO,
         runtimePluginConfig: {
+            runCommand: runHostCommand,
             downloadAsset: async (asset, destination) => { … },
             extractArchive: assetIO.extractArchive,
         },
```

### 4b. 或者改 runtime 插件侧（更彻底）

- `cleanHostEnvironment()` 的 `HOST_ENV_ALLOWLIST` 增加 `LD_PRELOAD` / `TERMUX_EXEC__EXECVE_CALL__INTERCEPT` / `TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE`，**并且**把 `sh` 钉到 app 数据区的 bash（`<prefix>/bin/bash`），因为 `/system/bin/sh` 加载不了 app 私有 preload；
- `prepare-rootfs.sh` 不依赖宿主 `$PREFIX/bin/find`：改用 `/system/bin/find`（toybox）或把逻辑搬进 Node；
- 把 `config.runCommand` 的透传文档化（现在插件支持，但宿主没有用）。

---

## 5. bionilux guest exec（需要后端改）

现状（本机实测）：

```
# 不注入 termux 拦截
[ERROR] execve failed: EACCES: Permission denied          # Android 10+ execute_no_trans
# 注入 termux 拦截（MODE=force）
Could not find a PHDR: broken executable?                  # bionic linker64 无法加载 glibc ELF
```

可选方向：

1. bionilux 增加 proot 式 fake-exec（ptrace 截获 execve，手工映射 glibc ELF/加载器），这是 Termux `proot-distro` 能在 Android 10+ 跑 Debian 的关键；
2. 或换用 bionic 可加载的运行时方案（guest 全 bionic）；
3. 或在 UI 做能力探测，明确不支持时给出说明，而不是安装到一半失败。

---

## 6. 验证命令速查

```bash
F=/data/data/com.snoworwind.pocketharness/files
P=$F/home/.dsh/profiles/web/node_modules/@dsh-android

# ① 插件是否激活（有输出=崩了）
grep -n "did not activate\|without inject" $F/engine.log

# ② 页面请求结果
grep "linux-environment" $F/boot-diag.log | grep -o "status=[0-9]*" | sort | uniq -c

# ③ 解包单测（rootfs，约 40 秒）
node --input-type=module -e "
process.env.TERMUX__PREFIX='$F/usr';
const h=await import('$P/dsh-android-linux-env/lib/linux-host-asset-io.js');
const c=h.createLinuxBootstrapConfig({filesDir:'$HOME/tmp/lbt',appVersion:'0.14.7'});
await c.linuxAssetIO.extractArchive('$F/usr/share/pocket-harness/linux-assets/debian-minimal-aarch64.tar.xz','$HOME/tmp/lbt/rootfs',{kind:'rootfs'});
console.log('EXTRACT OK')"

# ④ 硬链接能力
ln $HOME/tmp/a $HOME/tmp/b   # 本机：Permission denied（f2fs）
```

注意：`$HOME/tmp` 可用、`/tmp` 不可写；本机 `node` 不能派生 node 子进程（`process.execPath` 是 linker64），单测请直跑脚本。

---

## 7. 维护提醒

- 这些文件属于 App 从 APK 内置资源"铺"出来的 profile 树（tar 整秒时间戳可辨认），**应用版本变化时可能被重铺覆盖**；本机实测普通重启不会覆盖（13:19 / 14:10 / 14:47 三次重启后 sha 未变）。
- 建议把修复做进 APK 的模板/打包流程，而不是只在设备上就地改；否则每次升级都要重打。
- 改完插件代码需重启 DSH 才生效（插件只在 boot 时装载）。



