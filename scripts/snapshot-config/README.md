# 快照构建配置

本目录保存 `scripts/build-snapshot-013.mjs` 和来源构建所用的配置与模板。目录内文件由本仓维护；来源链从已提交的 Pocket Harness 树读取，不要求同步到其他仓库。`build-snapshot-013.mjs` 是来源链内部步骤，不应单独用它生成发布 APK；构建入口见 [构建与环境](../../docs/AGENTS/build-and-env.md) 和 [安全加固原则](../../docs/AGENTS/SECURITY-HARDENING.md)。

| 文件 | 用途 |
|---|---|
| `preinstall.json` | Termux/npm 下载源、预装包、工具和版本输入。 |
| `engine-overlay.json` | 来源链构建 Harness 引擎时使用的依赖覆盖与补充包。 |
| `engine-overlay-licenses.json` | 引擎 overlay 组件的许可登记，由来源构建与许可检查消费。 |
| `seed-settings.yaml` | 剥离机密后写入快照的非机密出厂设置模板。 |
| `strip.json` | 剥离机密文件、陈旧包管理状态和运行时目录的清单。 |
| `slim.json` | 快照瘦身与不适用平台包的清单。 |
| `apt.conf.template` | APT 配置模板；构建时将 `@@PREFIX@@` 替换为设备端前缀。 |
| `install-clang.sh` | 随快照分发的按需 C 工具链安装器；构建时替换 `@@PREFIX@@`。 |

## 维护约束

- `@@PREFIX@@` 只允许出现在模板文件中。构建产物不得包含构建机临时目录或 stage 路径。
- `seed-settings.yaml` 中空对象的语义不可改回裸键：`settings-file` 对 `null` section 会抛错并导致模型设置页失效。
- `slim.json` 的清单键必须继续由构建器消费；`check-snapshot-builder-output.mjs` 会检查死键。删除 reflink 项时保留 `find -name` 匹配方式，避免带引号的 shell glob 静默不展开。
- 引擎 overlay、预装清单或模板的具体锁定与验证规则，以同目录配置和 `scripts/source-build/` 的来源构建实现为准。
