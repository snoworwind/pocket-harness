# scripts/snapshot-config/ — 快照构建数据模块（Phase 2b，2026-09-05）

`build-snapshot-013.mjs`（编排器）消费的全部清单与模板。**数据与流程分离**：改预装包/镜像/剥离/瘦身策略只动本目录，不动编排器；双仓（协调仓/apk 仓 scripts/）必须同版（雷点 10）。

| 文件 | 消费点 | 内容 |
|---|---|---|
| `preinstall.json` | 预装/下载链 | Termux 镜像链、npm 镜像链、TARGETS 预装包清单、pnpm/canvas 版本 |
| `seed-settings.yaml` | 机密剥离后写回 | 出厂 settings.yaml 非机密模板（verbatim 写入快照 home/.dsh/settings.yaml） |
| `strip.json` | base-dsh 合并后 | secretLeaves（机密文件）/ stalePnpmState（陈旧 pnpm 状态）/ runtimeDirs（运行时目录） |
| `slim.json` | 7e-2/8a/8a2 | nodePtyPrebuilds / reflinkGlobs / misplacedDirs / sourcemapDelete |
| `apt.conf.template` | 7d 包管理器路径覆盖 | APT_CONFIG 主文件；`@@PREFIX@@` 构建期替换设备端前缀 |
| `install-clang.sh` | 0.13.1 W6 工具链 | C 工具链按需安装器（随快照分发）；`@@PREFIX@@` 同上 |
| `go-compat.mjs` / `go-compat.sh` | Go argv 兼容组件 | 检测受影响的 Termux Go，并从现有 GOROOT 源码重编修复版 Android/arm64 工具链；只生成旁路目录，不覆盖原安装 |

### Go argv 兼容组件

组件随快照安装为 `go-compat`，但不预装 Go。它只接受同时具备已知 runtime argv 补丁和 `TERMUX_EXEC__PROC_SELF_EXE` 执行标记的 Go 源码树；源码检查不匹配时会拒绝重编。先诊断，再将 GOROOT 复制到临时构建树、修改副本并输出到 `~/.dsh/opt/golang-argvfix-<版本>`：

```sh
go-compat diagnose --go "$HOME/.dsh/opt/golang/bin/go"
go-compat rebuild --go "$HOME/.dsh/opt/golang/bin/go" --goroot "$HOME/.dsh/opt/golang"
```

重编成功后按命令输出设置 `GOROOT` 与 `PATH`，并用新工具链重新构建 Go 应用。旧二进制仍带有原 runtime 行为。重编会同时保留原工具链、源码副本和新工具链，运行前应确保有足够空间。组件不会覆盖原 Go 安装，也不会对不匹配的 Go 源码猜测修改。

## 约定

- `@@PREFIX@@` 是模板占位符，只允许出现在模板文件中；替换发生在 build-snapshot 构建期，**构建期本地 stage 路径不可烧入快照**（实测泄漏史）。
- seed-settings.yaml 的空对象语义不可改回裸键（settings-file section() 对 null 抛 TypeError → 模型页全灭，fx-1 实锤）。
- slim.json 的 reflink 删除走 `find -name`（glob 在双引号内不被 shell 展开，`rm "path/*.node"` 是静默 no-op）。
