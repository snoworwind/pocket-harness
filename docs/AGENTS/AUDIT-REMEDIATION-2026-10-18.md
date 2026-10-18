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
