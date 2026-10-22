# Linux 宿主工具识别与 DNS 修复（2026-10-22）

## 现场与根因

新版 Termux 环境已能启动 GNU `sed --version` 并以 exit 0 正常输出，但 linker 把绝对可执行路径放进 `argv[0]`，输出首行形如 `/data/.../usr/bin/sed (GNU sed) 4.10`。runtime 的正则要求行首是 `sed`，因此把正确的 GNU 工具误报为 `linux-host-toolchain-unavailable`。

rootfs 准备脚本支持 `--dns`，但 runtime 未传该参数；Debian 资产没有 `/etc/resolv.conf`。Bionilux 已有 `BIONILUX_DNS_SERVERS` 覆盖入口，但 Android 壳此前没有提供当前网络的 DNS 地址，且 resolver 只处理 IPv4。

## 源码修复

- `find`、`sed`、`wc` 的 GNU 身份匹配接受 basename 或带目录的 `argv[0]`，仍要求各自 GNU 项目标识。
- 壳侧读取 Android 默认网络 `LinkProperties.dnsServers`，用网络回调跟踪 Wi-Fi、蜂窝和默认 VPN 的变化，并通过同目录原子替换写入应用私有的 `files/linux-dns-servers`；回调写入前还会确认事件中的网络仍是当前默认网络，避免旧网络的排队事件覆盖新 DNS。新增 `ACCESS_NETWORK_STATE`（普通权限，无运行时弹窗）。链路本地 IPv6 地址不传递，因为跨进程转发后缺少原接口的 scope ID。Android API 28+ 检测到 Private DNS 正在使用时，不发布 resolver 地址：Bionilux 当前发的是传统 UDP/TCP DNS，不能绕过 Android 的加密 DNS 政策。
- runtime 在构造宿主环境时重新读取并校验该文件；`prepare-rootfs.sh` 收到当前地址列表时写入 guest `/etc/resolv.conf`，每次启动 guest 子进程时也将当前列表传给 Bionilux。无安全可用的 resolver 时使用 `none` 环境状态并通过 `--no-dns` 清除 rootfs 中旧 nameserver，避免误用安装时或上一个网络留下的 DNS。
- Bionilux resolver 支持 IPv4 与 IPv6 DNS server，UDP 截断时的 TCP 重试也使用对应地址族。该阶段 runtime/Linux release 为 `0.5.2`；后续 `0.5.3` 将 bootstrap package identity 对齐到同批 release，bootstrap 行为未改变。

## 边界与验证状态

该 DNS 修复已留在本 PR 源码里，随后 runtime 升至 `0.5.3` 以加入 Android nativeLibraryDir exec 修复。DNS 相关定向用例此前通过；本轮合并前的完整验证状态见 [Android 执行入口修复记录](REMEDIATION-ANDROID-EXEC-2026-10-22.md)。最终 APK 必须从来源链构建，并包含与当前 rootfs 配对的 native loader。

Android 官方 `LinkProperties` 契约要求 Private DNS 活跃时不得发送未加密 DNS 查询。当前实现选择 fail-closed：Private DNS 活跃时 Linux guest 无法解析外部域名，直到增加经证书校验的 DoT 或调用 Android 系统 resolver 的安全转发。关闭 Private DNS 的网络会使用系统公布的 DNS 地址；默认 VPN 的路由与策略仍需设备验证。整个修复尚未做设备验证，不能据源码断言 Linux 已恢复。
