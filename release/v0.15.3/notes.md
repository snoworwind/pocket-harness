# v0.15.3（开发草稿，未发布）

Termux 继续作为主环境。Linux 改为按需下载的插件环境；Linux 安装或启动失败不会阻止 Termux 工具使用。

修复 Linux 重启后工具未恢复、glibc 预检被 PRoot warning 干扰，以及 rootfs 打包丢失 /dev/fd 别名。PRoot 对文件 mmap 的 EFAULT 增加一次限定重试与参数诊断，实际设备有效性尚待验证。

当前没有最终 APK、CDP 或 ADB 验收结论。发布前须核对最终来源构建、归档下载 URL、签名与设备验收。开发过程见 [插件迁移记录](plugin-migration.md)。

安装反馈补充：显示下载/解包/准备/健康检查阶段、当前资产与下载量；重复点击查看已有任务，失败诊断包含阶段、资产、HTTP 状态和固定 URL，失败也刷新目标版本。测试 runtime 附件可从成功草稿 CI 独立发布为公开 prerelease，APK 不随之公开。

已知限制：SGT-AL10 的 PRoot 启动超时及 loader EFAULT 本轮未修复。最终 host GPU 模拟器、CDP 和 ADB 证据在迁移记录中单独标注，不能推广为该真机已验收。
