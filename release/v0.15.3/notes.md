# v0.15.3（开发草稿，未发布）

Termux 继续作为主环境。Linux 改为按需下载的插件环境；Linux 安装或启动失败不会阻止 Termux 工具使用。

修复 Linux 重启后工具未恢复、glibc 预检被 PRoot warning 干扰，以及 rootfs 打包丢失 /dev/fd 别名。PRoot 对文件 mmap 的 EFAULT 增加一次限定重试与参数诊断，实际设备有效性尚待验证。

当前没有最终 APK、CDP 或 ADB 验收结论。发布前须核对最终来源构建、归档下载 URL、签名与设备验收。开发过程见 [插件迁移记录](plugin-migration.md)。
