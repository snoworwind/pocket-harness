# Pocket Harness：安卓上的 Agent 壳

[English](README.en.md) · [下载最新版本](https://github.com/snoworwind/pocket-harness/releases/latest)

Pocket Harness 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Android 壳。它把 WebView 界面与 Termux 运行时快照打包在同一个 APK 中，让 Agent 能在手机上使用 bash 和设备能力，无需另装 Termux。

## 能做什么

- **运行 Agent**：内嵌 Linux 运行时，提供 bash、Node.js 和项目插件。
- **操作手机**：通过无障碍与 Shizuku 通道读取界面、执行输入和截屏。
- **浏览网页**：使用与主界面隔离的浏览器工作台管理网页和标签页。
- **使用虚拟屏**：在独立虚拟显示屏中运行和操作第三方应用（需要 Shizuku）。
- **处理文件**：通过系统文件选择器、分享入口和 SAF 目录桥将文件交给会话。

模型可见的能力由插件提供，壳侧不直接注册工具。详细接口和能力清单见[桥协议](docs/AGENTS/BRIDGE-API.md)及各插件说明。

## 下载与安装

当前正式版本为 **v0.14.9**，仅提供 ARM64 APK：[版本说明与验收范围](release/v0.14.9/notes.md) · [GitHub Release](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-625fd8e0311d-40473155658-1)。

```sh
adb install -r -t <apk>
```

APK ABI 必须与设备匹配；x86_64 模拟器不受支持。首次启动或覆盖安装后，运行时快照需要解压数分钟，请等待完成，期间不要强行停止应用。虚拟屏和特权 shell 功能需要安装并授权 Shizuku。

插件市场中的第三方插件尚未普遍完成手机适配，可能无法使用或存在问题；请不要把它们当作生产依赖。当前版本发布烟测已通过，但完整设备三层验收尚未完成，使用前请查看版本说明中的限制。

## 构建

APK 只能通过源码来源链构建；仅构建 ARM64。云端构建：

```sh
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
```

Linux / WSL 本地来源构建（只构建已提交的 HEAD）：

```sh
node scripts/source-build/run-local-source-chain.mjs
```

环境、产物与验证要求见[构建与环境](docs/AGENTS/build-and-env.md)和[发布政策](docs/RELEASE.md)。

## 项目文档

- [安全目标与加固原则](docs/AGENTS/SECURITY-HARDENING.md)
- [模块与架构地图](docs/AGENTS/modules.md) · [完整版本历史](docs/AGENTS/changelog-archive.md)
- [设备验收规范](docs/AGENTS/emulator-test-protocol.md)
- [开发入口与仓库约定](AGENTS.md)

## 致谢

特别感谢 [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) 项目。Pocket Harness 独立建立时，基于我们 fork 的该仓库中的 `security/hardening` 分支。

## 许可

项目采用 MIT 许可，保留原项目版权声明；详见 [LICENSE](LICENSE)。第三方组件按各自许可发布。
