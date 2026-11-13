# Linux 运行时来源链

main 的来源链生成 ARM64 与 x86_64 Linux APK 与生产签名的草稿发布资产；Termux 运行时和旧快照链不再是产品输入。云端构建只在 GitHub Actions 执行，不接受本地产物作为发布来源。

## 执行与证据

1. `build-base.yml` 按内容键复用或双副本构建固定 Harness 源码，验证 deploy tree、源码包与锁文件收据；引擎生产图直接解析 Linux ARM64/x64 glibc 的 Koffi/Sharp 与已审第三方 pins/消费者 overrides，不装 Android Koffi/Sharp WASM fallback；源码构建后恢复上游清单与锁文件。
2. `build-apk-source.yml` 构建清单中的壳插件，并对固定 marketplace 发布字节施加已登记补丁。
3. Kotlin 全量单测与测试数量门禁在重型资产构建前执行，避免编译或命名迁移失败后才浪费构建时间。随后固定官方 NDK 编译宿主 PRoot/loader/talloc/shmem 与原生终端；Debian 签名快照、固定 Node 归档和客体 system addon 由 Linux 资产生产器提供。先恢复缓存，再按命中情况安装交叉工具与 keyring；`linux-product-assets-v2` 精确内容键覆盖所有生产输入；不使用宽前缀恢复。
4. `build-linux-payload.mjs` 直接复制已审计 deploy tree，先按引擎补丁目标解析出第三方发布包并从固定 registry 拉取对应版本 tgz（sha512 校验，第一方来自源码导出），再施加引擎补丁、同步 pnpm 物理副本、物化第一方包；从上游官方 bundle 数据初始化 web/headless profile，按插件清单把源码构建产物与运行期依赖装入工厂 home。
5. `check-linux-engine.mjs` 从固定来源 tarball 独立重放补丁，核对第一方 payload、依赖闭包、pnpm 副本与预设载体；`check-linux-runtime-packages.mjs` 从每个已部署 koffi 消费者解析 目标 ABI 的 Koffi glibc 模块、沿 sharp 发布 loader 找到目标架构 ELF、并要求 node-pty 使用目标 linux-arm64/linux-x64 prebuild 且无源码 shadow，同时盘点 `.pnpm` 内全部原生模块只能属于已审家族；`check-inject-completeness.mjs --tree` 核对两套 profile 的源码字节、导入和运行期依赖。语法下限复扫、工厂 home 隐私与客体路径检查均为实际输入检查。
6. 客体引擎与 home 分别归档；Canvas JS facade 和 glibc binding 都按源码 SHA-512 pin 校验，Node 中含固定 pnpm。四件套经 `linux-instance-manifest.py` 写入压缩摘要、受管树摘要、版本与展开体积。
7. 产物装配前，`build-linux-apk.mjs` 执行 Linux 专用代码/桥/权限/协议/插件/测试数量门禁，打入四件套、ownership manifest 与按实际 Debian/Node/Harness 来源清单生成许可证通知，清除旧 snapshot 资产后调用 Gradle。
8. 最终 APK 必须通过宿主原生库字节/许可证/来源核验、Linux 载荷身份检查及 v1/v2/v3 构建期签名验证；构建副本的签名门禁显式绑定一次性构建证书文件，绝不回落到生产 keystore 指纹。
9. `reference=true` 时，`compare-linux-apks.py` 独立核验两份 APK 的 Linux 载荷，再比较全部 ZIP 文件内容摘要，仅排除 JAR 签名记录；`META-INF/services` 等内容仍必须一致，并写出绑定两份 APK 与源提交的 `independent-rebuild-verification.json`（schema 2）。
10. `sign-abi` 只在 main 且 `reference=true` 时运行：下载各 ABI 独立比对通过的 artifact，用仓库生产 keystore secrets 在隔离作业重签，校验生产证书指纹与最终字节，上传 `pocket-harness-<abi>-source-<sha>`。
11. `release-source-draft.yml` 只接受 main，调用来源构建（`reference=true`）后下载生产签名 artifact，校验证据清单、提交、生产证书与 APK 摘要，打包 `provenance.zip`/`SHA256SUMS.txt`，创建双 ABI draft prerelease；发布说明取自 `release/<version>/notes.md`。

## 已退役的 CI 路径与替代判据

| 旧路径 | 当前判据 |
|---|---|
| Termux bootstrap、滚动签名仓库、`.deb` 输入 job | 固定 Debian 签名快照 + 固定官方 Node；宿主程序从固定源码编译 |
| Android node-pty 与 Bionic Node/Canvas | npm 目标 Linux ABI node-pty prebuild、客体 system addon、glibc Canvas |
| `build-snapshot-013.mjs`、`build-apk.mjs`、临时替换 overlay gate | 独立 Linux payload/APK 入口；直接调用来源包独立重放检查器 |
| 快照注入、combo 缓存、Termux 裁剪与快照 fingerprint/decode | 目录插件完整性 + 工厂隐私检查 + 四件套 manifest/最终 APK 摘要 |
| 旧快照归一化与 native inventory | `linux-payload-identity.json`、`linux-engine-check.json`、`linux-payload-build.json` |
| 旧快照双 ABI 与无签名 draft | Linux 双 ABI；构建副本临时签名、独立比对后由隔离作业以生产证书签名 |

旧脚本保留供历史追溯或独立回归，不被当前产品构建调用。`dsh-shell-linux` 与 `LinuxBashExecutor` 统一使用客体语义，模型通道名为 `android_linux_channel_exec`；工厂配置直接使用客体路径。PR Gate 不执行旧快照产出/指纹/聚合发布接线门禁，改用 `check-linux-ci.mjs --self-test` 及 Linux 载荷负控；保留壳侧 Kotlin 与现有解包器等源码单测。

名称契约由 `check-linux-names.mjs --self-test` 锁定：插件目录/包名、执行器符号、模型工具、工厂客体路径、运行时配置目录和 UI 文案必须一致。Linux 升级/事务/用户包测试类也按实际对象命名，逐类测试数量下限随一对一改名保留。

本文件描述构建契约；云端构建成功与设备功能验收分别记录，不互相替代。

ABI 由 `linux-abi.mjs` / `linux-abi.py` 映射到 Debian、Node、ELF、addon 与产物路径，两文件同时进入源码归档和缓存键。本地 `--abi x86_64` 同样构建 Linux 四件套，不再跳过资产阶段或回退 snapshot；本地 QA 仍不作为正式发布来源。R-07/R-17/R-18 及设备证据缺口见 known-gaps.md。

历史 `check-release-gates.mjs` 的旧快照/Termux 接线断言仍可能报旧 CI 缺口，不代表当前 Linux 发布链已执行这些门禁；它不是现行产品入口。不要补回旧快照调用来制造聚合器全绿，现行接线及负控由 `check-linux-ci.mjs` 和 PR Gate 承担。
