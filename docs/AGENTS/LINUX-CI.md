# Linux 实验分支 CI

本分支的当前来源链只生成 ARM64 Linux 实验 APK artifact；不接受 main、x86_64、生产签名、草稿或公开发布。显式 `linux_experiment=true` 和 `codex/linux-runtime-experiment` 必须同时满足。只在 GitHub Actions 构建，不在当前开发机执行 APK/运行时构建。

## 执行与证据

1. `build-base.yml` 按内容键复用或双副本构建固定 Harness 源码，验证 deploy tree、源码包与锁文件收据；它与平台包来源无关，继续复用。
2. `build-apk-source.yml` 构建清单中的壳插件，并对固定 marketplace 发布字节施加已登记补丁。
3. 固定官方 NDK 编译宿主 PRoot/loader/talloc/shmem 与原生终端；Debian 签名快照、固定 Node 归档和客体 system addon 由 Linux 资产生产器提供。`linux-product-assets-v1` 精确内容键覆盖所有生产输入；不使用宽前缀恢复。
4. `build-linux-payload.mjs` 直接复制已审计 deploy tree，施加引擎补丁、同步 pnpm 物理副本、物化第一方包；从上游官方 bundle 数据初始化 web/headless profile，按插件清单把源码构建产物与运行期依赖装入工厂 home。
5. `check-linux-engine.mjs` 从固定来源 tarball 独立重放补丁，核对第一方 payload、依赖闭包、pnpm 副本与预设载体；`check-inject-completeness.mjs --tree` 核对两套 profile 的源码字节、导入和运行期依赖。语法下限复扫、工厂 home 隐私与客体路径检查均为实际输入检查。
6. 客体引擎与 home 分别归档；Canvas JS facade 和 glibc binding 都按源码 SHA-512 pin 校验，Node 中含固定 pnpm。四件套经 `linux-instance-manifest.py` 写入压缩摘要、受管树摘要、版本与展开体积。
7. Kotlin 全量单测后，`build-linux-apk.mjs` 执行 Linux 专用代码/桥/权限/协议/插件/测试数量门禁，打入四件套、ownership manifest 与许可证，清除旧 snapshot 资产后调用 Gradle。
8. 最终 APK 必须通过宿主原生库字节/许可证/来源核验、Linux 载荷身份检查及 v1/v2/v3 临时签名验证。工厂载荷报告通过 builder 与 verifier artifact 两个边界保存。
9. `reference=true` 时，`compare-linux-apks.py` 独立核验两份 APK 的 Linux 载荷，再比较全部 ZIP 文件内容摘要，仅排除 JAR 签名记录；`META-INF/services` 等内容仍必须一致。`reference=false` 不声称通过独立重建比对。

## 已退役的 CI 路径与替代判据

| 旧路径 | 当前判据 |
|---|---|
| Termux bootstrap、滚动签名仓库、`.deb` 输入 job | 固定 Debian 签名快照 + 固定官方 Node；宿主程序从固定源码编译 |
| Android node-pty 与 Bionic Node/Canvas | npm linux-arm64 node-pty prebuild、客体 system addon、glibc Canvas |
| `build-snapshot-013.mjs`、`build-apk.mjs`、临时替换 overlay gate | 独立 Linux payload/APK 入口；直接调用来源包独立重放检查器 |
| 快照注入、combo 缓存、Termux 裁剪与快照 fingerprint/decode | 目录插件完整性 + 工厂隐私检查 + 四件套 manifest/最终 APK 摘要 |
| 旧快照归一化与 native inventory | `linux-payload-identity.json`、`linux-engine-check.json`、`linux-payload-build.json` |
| 双 ABI 草稿与生产 signer | 实验分支一律拒绝；只有只读权限的 artifact 构建 |

旧脚本保留供历史追溯或独立回归，不被当前产品构建调用。`dsh-shell-termux` 是现有插件包身份，其源码已经适配客体路径；它不表示 CI 仍引入 Termux 运行时。PR Gate 不再执行旧快照产出/指纹/聚合发布接线门禁，改用 `check-linux-ci.mjs --self-test` 及 Linux 载荷负控；保留壳侧 Kotlin 与现有解包器等源码单测。

本文件描述构建契约；云端构建成功与设备功能验收分别记录，不互相替代。
