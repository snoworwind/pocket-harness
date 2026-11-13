<!-- dsh-mobile-factory-baseline -->
# Pocket Harness 运行时与操作纪律（出厂基线）

> 本文件随安装包发布，升级时整份替换。自己的长期约定请写 `~/.agents/AGENTS.md`；
> 项目约定写项目根 `AGENTS.md`，个人覆盖写同目录 `AGENTS.local.md`。

## 1. 当前执行环境

引擎、普通 `bash`、终端、Python 和 Undo CLI 都在 PRoot 的 Debian/glibc 客体中执行。
没有第二个 `linux_bash` 工具，也不需要再次安装 Linux。Android 平台能力通过插件与桥提供。
PRoot 不提供独立内核、安全沙箱或 Android root；`uname` 仍可能显示 Android 宿主内核。

| 内容 | 客体路径 | 升级规则 |
|---|---|---|
| APK 管理的 Node / npm / pnpm | `/opt/node` | 随 APK 校验和更新，不要在此存用户资产 |
| APK 管理的引擎 | `/opt/dsh` | 随 APK 校验和更新，不要修改其中的包 |
| Debian 与 apt 软件 | `/usr`、`/etc`、`/var` | 首装铺底，普通 APK 更新不重铺；显式重置才删除 |
| 用户 home | `/root`，即 `$HOME` | 持久保留；工厂种子只补缺失文件 |

- 使用 apt 管理 Debian 软件；npm 全局前缀为 `$HOME/.local`，pnpm 用户目录也在 home。
- PATH 默认先取 `/opt/node/bin`，再取 `~/.local/bin` 与 pnpm 用户命令目录，然后是 Debian 系统目录。
  apt 安装的同名 Node/npm 仍可用绝对路径显式调用；用户交互 shell 的自定义 PATH 可以改变命令选择。
- 引擎搜索使用其依赖的 `@vscode/ripgrep`；命令行 `rg` 使用 apt 版本。版本和行为可能不同。
- 引擎的原生构建默认使用 `/usr/bin/python3`、gcc/g++、make。显式切换 pyenv、conda 或编译器后，
  先记录实际版本和路径；不要把不同工具链的结果当成同一构建证据。
- Python 用户包保存在 `~/.local`。Python minor/SOABI 变化后需要为新解释器重装原生扩展；旧文件不自动删除。
- Node 通过 `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` 使用 Debian 的额外 CA；
  修改证书后重启引擎。Node 内置 OpenSSL/SQLite 与命令行版本可不同。

## 2. 操作与排障

- 使用正常的 Debian `/tmp`。不要沿用旧 Android linker64 的 Node 派生限制；遇到子进程问题，
  先检查 `process.execPath`、命令路径和实际错误，再给最小复现。
- 首装会解包大型 rootfs；保持前台，不要在准备中强停。中断后的重试会校验并复用已完成组件。
- 运行时更新由 APK 管理。起不来先看 `boot-fail.log`、`engine.log` 和 Linux 试运行诊断；
  不要删 rootfs 或清应用数据来“修复”受管 node/engine 缺件。
- Linux 环境页是只读状态与自检。需要重置时先从原生管理中心导出备份；重置会删除 apt 软件和配置。
  导出的备份含凭据，应保存在可信位置。
- 应用内 Undo 保护配置与插件代码，不代表用户 home、apt 软件或手写资产都有可用回滚点。
  破坏性操作前自己备份，并分别验证备份可读与目标内容。

## 3. Android 环境事实

- 公共共享存储可能不支持符号链接或可靠的原子 rename，依赖安装优先放在私有 home。
- 后台可能冻结应用进程组；长任务保持前台或分屏。回前台后需要重新核对网络和超时状态。
- 公共源码目录可放 `.nomedia` 避免媒体扫描。
- 大范围扫描先明确目标文件，避免无目的地遍历整棵 rootfs 或引擎树。
- 破坏性命令单独执行并先 dry-run；每次结论同时保留正向证据和失败条件，不把空输出当成功。

## 4. 约定放在哪儿

- `~/.dsh/AGENTS.md` 是随 APK 更新的出厂件，不存个人长期约定。
- `~/.agents/AGENTS.md` 是用户全局约定；升级不覆盖。
- 项目根 `AGENTS.md` 是项目约定，同目录 `AGENTS.local.md` 是个人覆盖。
