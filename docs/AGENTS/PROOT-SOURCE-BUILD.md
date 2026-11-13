# PRoot 宿主闭包源码构建

本实验由用户授权在 `codex/linux-runtime-experiment` 推进，不合并 main、不发布 APK。
目标是替换 Termux `.deb` 原件，先建立可修改、可重建的宿主后端；完整 Linux 主运行时
迁移见 [实验账本](NATIVE-RUNTIME-MIGRATION.md)。

## 已实现的构建入口

```sh
# 一次下载源归档，每份必须匹配本仓已审阅的 SHA-256；不会请求 Termux 包索引或 bootstrap。
python3 scripts/source-build/build-proot-source.py --download-sources <源码缓存目录>

# 编译本身离线。NDK 目录须为官方 r30 / 30.0.16248370，输出目录不得覆盖已有 ABI 产物。
python3 scripts/source-build/build-proot-source.py <源码缓存目录> <NDK根> <输出根> --abi arm64
python3 scripts/source-build/build-proot-source.py <源码缓存目录> <NDK根> <输出根> --abi x86_64

# 无 NDK 的判据/路径回归：要求有宿主 cc/clang，真实编译并运行路径 helper 测试。
python3 scripts/source-build/build-proot-source.py --self-test
```

宿主需要 GNU make、GNU awk（gawk，生成 loader 元数据需要 strtonum）和 Python 3。构建器优先使用 gawk，拒绝 mawk/BSD awk，并记录其版本与摘要。

支持 Linux 和 macOS 构建宿主，Android API 26、ARM64/x86_64；不编译或承诺 32 位客体 loader。
NDK 预编译工具链是构建引导输入，不进入 APK。源归档身份直接读取现有
`linux-backend-packages.json::packageSources` 与 `expectedVersions`，但不执行 Termux recipe，
不读取 `.deb`、包仓、keyring、bootstrap 或 Termux 运行环境。

本轮实际使用的 NDK macOS 归档由 Google `repository2-3.xml` 给出的大小与 SHA-1 核验，
与仓内 Linux 来源链使用的 r30 同一修订；产物报告另记实际 clang 可执行字节摘要、版本和
`source.properties` 摘要。官方二进制工具链引导不等于它自身已从源码重建。

## 为什么暂保留 Android 适配源码基线

当前基线是固定摘要的 `termux/proot` 源归档，而不是 Termux 构建出来的 PRoot 包。
它已有 Android/Bionic、共享内存、独立 loader 与 APK 安装位置所需适配。
已对照 `proot-me/proot` 的构建入口：上游默认嵌入 loader，构建目标和依赖组织不同；
不能只换仓库 URL 就宣称 Android 高 target 场景可用。
后续可按运行故障与上游差异收敛补丁；**本轮没有证明 Termux 分支本身的所有缺陷已消失**。

“Termux 脱离”的运行时判据是不依赖其 App、bootstrap、包仓、私有前缀与 termux-exec，
不要求抹去已使用开源 Android 适配代码的真实来源。

## 本轮源码适配

构建器只在新解包的源码副本上进行定点修改；锚点必须唯一，源码变动即拒绝猜测。
每个修改文件的前后摘要进入 provenance，实际配方和独立 helper 的摘要也会记录。

| 组件 | 实修原因与方式 |
| --- | --- |
| talloc 2.5.0 | 构建时指定 SONAME `libtalloc.so`，使 PRoot 正常链接 APK 可安装的名字；不再对 PRoot ELF 字符串表做事后字节重写。交叉配置答案与实际生成配置可复核；不把 configure 中的交叉答案当设备功能测试 |
| libandroid-shmem 0.7 | `_PATH_TMP` 依赖外部 Termux 构建宏，官方 NDK 下实际编译失败。移除固定路径格式串，使用本仓 helper 从 `PROOT_TMP_DIR`、其次 `TMPDIR` 读取目录；缺失或相对目录拒绝，snprintf 越界拒绝；调用处出错会释放既有 mutex 后返回 |
| PRoot 5.1.107.102 | ashmem_memfd 源文件漏引 `string.h`，新 Clang 对 strcmp/memset 隐式声明实际报错；定点补头文件，不关闭编译诊断。版本带 `-pocket-source.1` 标识；GIT=false 防止把外层项目仓库版本意外写入 build.h |
| PRoot 5.1.107.102（issue #322） | 新增两处**运行期开关**：`src/tracee/event.c` 在 `PROOT_POCKET_TRACE_WAIT` 下把每个 `waitpid` 状态打到 stderr（判「子进程初始 ptrace stop 到底有没有送达」）；`src/tracee/tracee.c` 在 `PROOT_POCKET_RESUME_SILENT_CHILD` 下对「fork 事件已登记但从未报过首次 stop」的子进程恢复：先置 `sigstop = SIGSTOP_ALLOWED`、按 `seccomp` 状态显式给出 `restart_how`（`PROOT_NO_SECCOMP=1` 下是 `PTRACE_SYSCALL`），再走 `restart_tracee()` 而不是裸 `PTRACE_CONT`——裸 CONT 会跳过系统调用入口 stop，PRoot 就失去路径翻译与 syscall 改写的机会。用于鸿蒙 Linux ABI 兼容层不投递 initial stop 的场景。两者缺省关闭，正常内核行为不变；配方用 `replace_once` 锚点，锚点漂移即拒绝构建 |
| loader/NDK | 独立静态 loader 以 APK 名称交付；32 位目标显式关闭；主程序及全部原生依赖使用 16 KB LOAD 对齐；默认 loader 路径是故意不可用的 sentinel，调用者必须传入当前安装目录的 PROOT_LOADER |

`/dev/shm/...` 在 shared-memory 源码中还用于抽象 Unix socket 名称（sun_path[0] 为零），
不是写 Android `/dev/shm` 的文件路径，不能把它按硬编码文件路径盲改。

### issue #322 的两个运行期开关（2026-11-13）

构建产物默认行为不变；只有在环境里显式设置才生效，用来在真机（鸿蒙兼容层）上取证与试探：

```sh
# 1) 打印每个 waitpid 状态：判断子进程首次 stop 是否被内核投递
PROOT_POCKET_TRACE_WAIT=1
# 2) 对「登记了但从未报 stop」的子进程强制恢复：fork 挂死的候选修复
PROOT_POCKET_RESUME_SILENT_CHILD=1
```

判读：若开 (1) 后 fork 子进程的 pid 从未出现在 `proot-wait:` 行里，说明内核没有投递 initial stop。

开 (2) 之后必须三条同时成立才算真修好，缺一不可（第一条只是「不挂死」，第二条才是「没丢 syscall 拦截」）：

1. `bash -c '/bin/true; echo OK'` 不再挂死且真的打印 `OK`；
2. 路径翻译仍正确：`ls /` 看到的是 Debian rootfs、`cat /etc/os-release` 是 Debian；
3. 嵌套 fork 与管道正常：`bash -c 'bash -c "echo NESTED"'`、`yes | head -1`。

若只满足第一条而第二条失败（典型是宿主 `/bin/true` 的 ENOENT），说明恢复成功但丢了 syscall 拦截，属「换了症状」，不能算修复。两个开关都只改 PRoot 源码（构建期定点补丁，provenance 记录前后摘要），不改 Termux 包。

同一批补丁还给 loader 的 `FATAL()` 加了落点诊断：任何 182 都会先往 stderr 写一行
`[proot-loader] site=<行号> status=<errno>`（`FATAL_STATUS`），再按原语义退出 182。
这样设备上再遇到 2%-10% 的 182 时，能直接区分是 open(2) 还是 mmap(2) 失败、错误码是什么，
不用再靠排除法。写 stderr 是尽力而为（guest 无可用 stderr 时只是没有这一行），不改变退出码。

另一个排查边界：PRoot 源码 `src/loader/loader.c` 的 `FATAL()` 会以 **182** 退出。
182 本身不能唯一证明 seccomp 加速器故障，应结合 loader 映射、系统页大小和实际 syscall
日志判根因；当前已有运行时的 `PROOT_NO_SECCOMP=1` 配置不因这次编译被改写。

## 输出与验证边界

```text
<输出根>/native-libs/arm64-v8a/ 或 x86_64/
  libpocketharness_proot.so
  libpocketharness_proot_loader.so
  libtalloc.so
  libandroid-shmem.so
<输出根>/proot-source-build-<abi>.json
<输出根>/work-<abi>-*/          源码副本、配置、编译日志（失败也保留）
```

产物验证强制检查：文件集合、普通可执行文件、ELF64/ABI、PRoot 入口及 Android 解释器、
loader 静态入口、talloc/shmem SONAME、无 RPATH/RUNPATH、无可写可执行 LOAD、
16 KB ELF 段对齐以及依赖闭包只落在本组文件或允许的 Android 公共库。
负控包含错 ABI、错对齐、错 SONAME、丢/多件、坏 loader、未知依赖、无执行位、
源码摘要篡改、NDK 版本错误、源码解包越界与路径 helper 的失效条件。

本轮在 macOS ARM64 / 官方 NDK r30 上实际构建两个 ABI 的完整闭包。
随后在另一输出目录对两个 ABI 分别重建，四个 ELF 的 SHA-256 均逐字节一致；这是同机
独立目录的重建证据，不是不同 runner 的 APK 独立来源双构建，也不是 Android 运行证明。
本地证据保存到 `.deploy-tmp/native-runtime-p0/`；真实已发布来源 APK 的解析复核也在该目录，
不把旧 APK 的设备状态归给新源码产物。
构建报告始终写 `deviceValidation=not-run`。main 现通过
`prepare-proot-source-backend.py` 接入 Linux 资产链：重验 ELF/收据、原始归档摘要并重放补丁，
生成 schema 2 的源码来源协议，保留三个源码归档和源许可证；APK 字节门禁和 notices
分别消费该协议。schema 1 的历史包来源仍可审计，但源码产物禁止携带其验签包字段。
完整 Linux 资产链已在实验提交 `8ab359a9` 成功运行：
[run 43145766367](https://github.com/snoworwind/pocket-harness/actions/runs/43145766367)
完成后端源码编译、组装、Debian rootfs/Node 资产和原生库校验；下载后的 schema 2 收据也通过本地复核。
这包含发行版/官方预编译的 guest 工具和 Node，不代表所有客体程序已自编译。
该轮未切主运行时；当前源码已切换，最新来源 APK/Android 16 验收状态见
[实验账本](NATIVE-RUNTIME-MIGRATION.md)。

补齐源码归档后的实验提交 `a764c83e` 再次全链成功：
[run 43147536575](https://github.com/snoworwind/pocket-harness/actions/runs/43147536575)。
下载后的归档确认包含根 LICENSE、ELF 测试夹具及源码组装器；schema 2 收据复核通过。
ARM64 Android 16（API 36）host GPU AVD 上，云端源码产物在 ADB shell UID 下通过
`--version` 与禁用 seccomp 加速器的 shell tracee 烟测。该测试不代表应用 UID 权限、
APK 安装/提取路径、Linux rootfs 或 UI 验收；证据位于 `.deploy-tmp/native-runtime-p0/`。

GNU awk 前置检查来自实际本地失败；另用上游 loader-info.awk 与受控符号表复现了
BSD awk 返回 0 退出码却将预期偏移 128 生成为 0 的情况。这类生成元数据未由 ELF 头门禁覆盖。
此前 macOS 双目录字节一致仅说明旧配方的输出稳定，不能用来证明生成偏移语义正确；
更新配方统一要求 GNU awk，旧构建证据仍按各自提交保存，不替代更新配方和应用 UID 验收。

### 在设备上打开这两个开关

开关由 PRoot 进程读取，所以不能靠 `adb shell export`。应用会在启动客体引擎前读取
`$HOME/.dsh/proot-env`（宿主路径 `files/home/.dsh/proot-env`，只接受上表两个键，其他行忽略，
符号链接或超过 4 KiB 直接不生效），把它们作为 PRoot 的进程环境传入。

原生终端里用**内建命令**写入即可（fork 挂死时也能用）：

```sh
printf 'PROOT_POCKET_TRACE_WAIT=1\n' > ~/.dsh/proot-env
printf 'PROOT_POCKET_RESUME_SILENT_CHILD=1\n' >> ~/.dsh/proot-env
```

然后重启应用让引擎以新环境重建 PRoot。关闭就删除该文件。
