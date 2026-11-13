# dsh-shell-linux

`@dsh-android/dsh-shell-linux` 为 Pocket Harness 的 Debian/glibc 客体提供 Bash 执行能力。

每个子进程显式获得客体 PATH、HOME、SHELL；生命周期、输出预算与超时复用上游执行器。插件不注入 Bionic 库路径，也不伪装路径级沙箱：受限档位失败关闭，必须由当前会话显式选择完全访问，执行仍受 Android 应用 UID 约束。

工厂配置使用 `/usr/bin/bash`、`/usr`、`/home` 与 `/home/.dsh/workspaces`。工具链表由本包导出，Linux 环境插件只读同一份表。构建后的 `lib/` 不入库，由 CI 从同步源码重建。
