# 综合审查修复账本（2026-10-18）

用户已授权修复 [综合审查](COMPREHENSIVE-AUDIT-2026-10-18.md) 的全部问题。原报告保留发现时事实；本账本区分实现、宿主验证和设备验收。每组独立提交与 PR，未取得设备证据的项目不得记为验收关闭。

| 项目 | 实现与验证 | 设备/产物边界 |
|---|---|---|
| A09 | 函数体切片前统一 CRLF→LF，保留原业务断言；原 CRLF 工作树是受控负例，修复后重跑 overlay 与文件点击测试 | 仅测试代码，无运行时行为变更 |
| A08 | undo_list 将 ISO 时间转换为本地日期分量，无效时间原样保留；原失败业务反例重跑并接入 PR Gate | 未做设备验证；最终快照展示待验 |
| A05 | 最后共享任务退出唤醒等待者；pendingExclusive 阻止后来的命令越过管理操作。补最后退出/双管理者/读者插队反例 | 宿主并发回归，设备待验 |
| A06 | active.json 提交前失败才回滚新实例；提交后清理错误仅报告 cleanupWarning，观察者逐个隔离。补清理失败/重启回读/观察者异常/指针写失败反例 | 宿主事务回归，设备待验 |
| runtime scope 补充 | Cordis scope 卸载时 await 自己创建的 manager.dispose，终止仍在执行的命令；外部注入 manager 仍归宿主。已 disposed 的保留 handle 可执行卸载数据，不能重新执行或安装。补 scope/取消/保留 handle 卸载与真实 Cordis 回收断言 | 因源码变化，首轮来源 run 主动取消；重建证据须绑定修复后的 main，设备待验 |
| A07 | build-apk 的两个复用入口显式 inherit Secrets，补逐条删掉传递的受控负例，并核对草稿内层传递 | 来源构建实际签名待全链；未改 Secrets，未做设备验证 |
| A10 | 直接云端来源入口在 checkout/签名前拒绝非 main；本地实际执行与续跑也检查 attached main，list/dry-run 仍可审查候选。补分支/tag/PR/detached 反例 | 不在非 main 构建 APK；main 全链待最终集成 |
| A01–A04 | 仅允许一次零大小根目录条目；plugin 禁链接，runtime 链接在数据文件完成后受限创建，拒绝越界/链接父目录/非普通 hardlink；包槽统一到宿主 plugins/linux-runtime；runtimePluginConfig 提供离线下载写入与按 kind 解包适配。真实 host/bootstrap/runtime 禁网安装→执行→重装→卸载与路径负控通过 | 宿主联测仅原生执行器用夹具，真实 ARM64 原生资产和来源 APK/CDP/ADB 未验收 |

本机证据目录 `.deploy-tmp/audit-fixes-2026-10-18/`；源码基线、输入和命令以对应 PR 与日志为准。未做设备验证。

旧 PR #2 的输入法独有修复另行移植：保留当前 applicationId 与 Kotlin namespace 分离，IME 和广播接收器使用完整组件名；环境准备以 ime list 的完整组件匹配判断，不再 grep 旧包名。真实 env_prepare 工具的正反例与组件声明核对通过，设备层仍未验收。旧 PR 的整树包名改写不直接合入。

旧 PR #3 的独立重建证明另行适配：两个全新 runner 用临时 PKCS12 证书构建，中间产物不得交付；第三个无生产 Secret 的 job 比较实际 APK entries、hard manifest 与 v3 快照语义，拒绝 JS/DEX/权限/条件导出顺序/服务文件差异，解析不执行或解压不可信内容到文件系统。只有隔离最终签名 job 读取正式 PKCS12 Secrets，核对 proof 的源码 SHA 和签名前 APK 摘要，签后重新绑定摘要；草稿准备再次验证。源码、夹具自测和负控通过不代表真实双构建已通过。真实 main 来源链和设备证据仍待取得。

## 集成与证据（2026-10-18）

- 独立修复 PR #10–#18 均在各自 HEAD CI 通过后合入候选；最终候选 `c5b119f` 的 PR Gate 和 Linux source validate 均通过，再经 [PR #8](https://github.com/snoworwind/pocket-harness/pull/8) 合入 main `f5d0d9265951e2eb067a9468c9eb44378d569d5b`。旧草稿 #2/#3 关闭，其独有工作已由 #17/#18 适配保留，没有直接合入旧身份改写。
- 最终 POSIX Node24 宿主全量 **239/239**（0 fail/skip），`all-node-final-posix.log`；来源/组装专项 **126/126**、Python **15/15**（`source-full-posix.log` / `source-python-posix.log`）。
- 插件总入口 **11 个单元、SKIP=0**：bridge165、browser34、file-open26、linux-env69、manage94、vdisplay91、bootstrap10、model-capability194、host-web-compat59、UI748；`plugins-final-posix.log`。旧 ignored lib 先由原源码重建，Node 使用 CI 同代 v24.21.0，不再用审计时过时产物/Node22 的结果代替。
- runtime 的 Linux 全量 **23/23**；隔离导入旧 manager 的受控反例会被新锁/事务回归拒绝（`runtime-negative.log`），不只检查实现文本。云端各修复的 Kotlin 全量仍通过；初始本地 Kotlin 120 类/1310 项证据见原审查，后续未改 Kotlin 实现。
- 真实旧 ARM64 来源资产 `437eea45…` 的 runtime/Node/backend/rootfs 逐个核对 manifest SHA-256 与长度后，调用当前生产解包器在 WSL ext4 成功，Node npm 与 rootfs bin/sh 链接可解析；`real-assets-ext4.log`。首次 NTFS 上 `PAM.7.gz`/`pam.7.gz` 大小写冲突的 EEXIST 保留在 `real-assets.log`，原样转 ext4 后通过。旧资产只证明格式兼容，不能证明本次源码的 APK 已构建或 Android 原生执行已验收。
- 已实际触发 main 包装入口 `build-apk.yml`、`draft_release=false`：[来源双构建 run 39112321118](https://github.com/snoworwind/pocket-harness/actions/runs/39112321118)，源码为 `f5d0d92…`。启动时两台 runner 均通过来源预检、main guard 和临时证书自证，进入实际源码构建；最终比对/正式签名结果须以该 run 后续结论为准，不在此提前记 PASS。
- **未做设备验证**：实际 `/home/zouhaoyu/.local/share/android-sdk/platform-tools/adb devices -l` 为空。未取得 CDP/ADB 自主任务、双方向截图、实际 IME/通知/授权交互或最终 ARM64 APK 装机证据；不能把源码修复或宿主绿记为功能完整验收，未创建 Release、未公开发布。

## 最终 main 来源链的容量失败与修复（2026-10-18）

- 最终 main HEAD `d4aa9fcc50ea2b4fc0ab249929b5b3d3bb695613` 的来源双构建 run [39113529859](https://github.com/snoworwind/pocket-harness/actions/runs/39113529859) 未通过：两个 replica 都在 APK 构建的 `check-engine-overlay` 适配器处失败，日志先显示 `Free space left: 83 MB`，随后 `check-dsh-source-snapshot.mjs` 在复制解包后的 engine 到 `/tmp/.../reference` 时 `ENOSPC`。这不是业务判据失败，也不是源码修复回退；该 run 不能作为最终候选证据。
- 新增 `scripts/source-build/reclaim-build-disk.mjs`：在快照封包和 post-snapshot 检查后删除不再被后续步骤读取的 source-only 树，保留 `snapshot-013/.../stage`、`engine-overlay`、`source-build` 报告和 `linux-build/provenance`；每目标校验真实路径位于 `.deploy-tmp`，拒绝 symlink、挂载中的 rootfs 和特殊文件，清理后低于 4 GiB 即失败。`cloud-workflow.test.mjs` 增加调用位置回归和“删掉调用必须判红”的负控。
- 本机证据：WSL Linux 下 `reclaim-build-disk.mjs --self-test` 通过（正控、symlink escape、`--check-only`、空间下限四项）；`node --test scripts/source-build/*.test.mjs` 为 **120/120，零失败、零跳过**（`source-tests-final.log`）。Linux 全量来源测试已取得；新的 main 双构建仍待运行，不能提前记为 PASS。设备侧仍未验收。
