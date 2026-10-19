# DeepSeek Harness 0.2.1-rc.2 吸收记录

2026-10-19 北京时间 14:43 启动本次一次性升级。应用源码版本推进到 0.14.8 / versionCode 52；当前为开发候选，未发布、未做设备验证。PR、最终来源构建和设备结果在取得后补记，不以本页源码结果宣称 APK 已验收。

## 来源与处置

| 项 | 本次事实 |
|---|---|
| 原引擎 | `dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84` |
| 目标引擎 | 官方预发布 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；官方发布于 2026-10-17，检查时 master 也指向此提交 |
| 选择依据 | [官方 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)、Git 标签实际查询、本仓 UPSTREAM-TRACKING 的单独升级条目；不把 RC 称为 stable |
| 参考输入 | [参考仓 PR #403](https://github.com/kelai141/dsh-mobile-apk/pull/403)，只审阅引擎适配；未引入其中虚拟屏 UI、旧 namespace、缓存垃圾或设备通过结论，参考仓不成为构建依赖 |
| 官方源码核实 | GitHub 固定提交源码归档在 WSL 物化；16,283 个普通文件及 14 个符号链接逐个核对 Git blob。三份 `.cmd` 按上游明确的 `eol=crlf` 属性核对规范 blob；构建前后受跟踪源码均干净 |
| 固定构建输入 | Node 24.15.0、Corepack 0.36.0、官方 `pnpm@11.28.5`；官方 lock SHA-256 `4637cca3b89c4c8d5a147321710e597aa62ec2444a3772ab542be5690893dfe4` |
| 实际源码产物 | 原生宿主 addon、Host/Client 包编译与 bundle、Web frontend 成功；导出 345 个固定源码包并记录各 tarball SHA-256，第一方不回拉 npm 发布字节 |

上游比较 API 报告两标签间 1,925 个提交；本轮未声称逐提交完整安全审计。审查集中于 Android 实际装配、插件 peer/槽位、PTC、凭据/路由边界、源码闭包和当前全部引擎补丁。完整差异与命令日志本机留在 `.deploy-tmp/engine-021rc2/`。

## 适配与安全边界

- 引擎固定 SHA、工作流、导出/部署/快照检查、bootstrap 和 marketplace 元数据一并推进；Cordis 4.0.5、Schemastery 3.18.5 使用目标官方源码，不回退旧 vendor。
- 新版官方 builder 把 Desktop 编译独立成步骤。Android 通过官方 `compile-referenced-projects` 的 Host/Client 步骤及根 tsdown/Web 构建生成产物；删除旧的临时改根 manifest 和冗余递归 bundle 流程。旧 Corepack VM loader 与 Node 22 的 native TS loader 问题不以降低类型检查解决。
- `pi-ai@1.1.0` 六 provider 官方补丁原字节 SHA-256 为 `66eaf960054f10441b93ac3857114e96c1901f6d183713e2f21437b007111644`；仍要求精确上下文、幂等、多文件先验证后写，MiMo 与工具调用补丁继续叠加。
- PTC 从 `nodeExecutable` 迁至 `launch: {kind: node-script, executable: <本应用 wrapper>}`。A1 同时适配一次执行和新增的持久进程：可信 linker64 + node 前缀、heap 仅由宿主写进 NODE_OPTIONS、原生启动白名单、两个子进程入口均清空模型可见环境；受限模式仍要求 confine，拒绝未审查的 spawn 数量、丢失 enforcing argv、缺 companion 或不完整补丁。参考适配只覆盖一次执行，本仓补齐了持久路径。
- 去掉已被官方删除的 `dsh-invariants` 依赖和本地 companion；外部子代理目录项按 SessionId 打开。90 个官方槽位和 186 条 base/web 行与实际源码核对，本地槽声明及 Linux bootstrap 行保留。调度等能力仍来自官方插件，壳侧没有新增 AI 工具。
- 路由登记跟随 `admitConnection`、`/connect` 与实验包移动，官方未挂载 Inspector/Webhook 的依据显式登记。Android 原有 private transport、审批、应用身份与签名约束继续执行。
- 所有插件源码、package.json、10 份真实重新解析的锁文件及本机 lib 产物同步。保留本仓独立维护的 Linux 运行时依赖闭包；模型能力插件保留，设置页的替代能力未经设备验证前不提前退役它。
- 三份运行时覆盖资产从本次真实源码包经过完整补丁链重出；session-persistence-jsonl 为 149,673 B，另两份字节未变。旧 Android runtime-capture 仅作历史登记，当前回归使用本轮真实构建夹具；替代编译格式继续以明确的合成用例测试，没有跳过该断言。

## 已取得的代码证据

| 命令/输入 | 实际结果与边界 |
|---|---|
| 官方 frozen install + native/Host/Client/Web 构建、export | 成功；345 个源码包，官方受跟踪源码未变；不是 APK |
| 实际生产部署闭包 | 官方 pnpm 12.2.0 deploy 成功；Android/ARM64 optional 输入与 Sharp WASM 闭包进入部署树；临时 manifest/lock/workspace 改动均已恢复，官方受跟踪源码干净；不是 APK |
| `probe-engine-anchors --fixtures --source-manifest …` | 从本轮实际 tarball 捕获 47 个文件；当前 24 条引擎补丁全部 applied；夹具门禁通过 |
| `check-patch-test-manifest`（WSL） | 30 文件，68/68 通过，0 跳过、0 已知失败；包含 PTC 15 项及其持久路径反证 |
| UI `vitest run --pool=threads` | 50 文件，752/752 通过 |
| `node --test scripts/source-build/*.test.mjs`（WSL） | 129/129 通过，0 跳过；含旧包管理器/缺 compiler/旧 recursive builder 负控 |
| Python 来源链套件（WSL） | 21 项通过 |
| Kotlin `:app:testDebugUnitTest`（WSL Java 17） | 122 个 suite、1,322 项，0 失败/错误/跳过，`BUILD SUCCESSFUL`；当前应用 0.14.8 配置参与编译，未执行 APK 组装或装机 |
| Linux 环境插件 `node --test …/test/*.test.mjs`（WSL） | 71/71 通过；Windows 删除/rename 语义报错不计通过 |
| contract / API auth / 锁根 | 14 条插入声明满足 peer；90 槽、186 行一致；路由 28、本轮官方注册面 20、无漏项，API SKIP=0；10 份锁根一致。contract 的协调仓独有文档段明确 SKIP=1 |
| 两份运行时资产行为回归 `--asset` | session-persistence-jsonl 发布独占与 fs-local 创建回归均通过；最终 APK 内的逐字节对账仍需来源链 |

Windows 全量 plugin gate 曾报 Linux 文件删除 ENOTEMPTY 及 Node 26 默认 forks 的 localStorage 环境差异；单独 Node 26 threads 的 UI 和 WSL 的 Linux 插件结果如上。完整 Linux PR CI 以同一 HEAD 的实际结果为准，不把这次 Windows gate 记绿。

## 设备与最终候选

实际调用 WSL Android SDK 的 `adb devices -l` 返回空列表；指定 `10AF2B0GN0001F2` 读取 `ro.product.cpu.abilist` 返回 `device not found`。因此 ABI 未知，CDP、ADB 真人操作、自主多步任务、横竖屏与覆盖升级均未验收。未使用旧 x86_64 包代验，未热推。

本次 APK 仅可在 PR 同一 HEAD CI 通过并以 merge commit 合入 main 后，由 main 来源链双构建、比对、隔离签名产生。最终候选仍须新 APK 重新安装并完成三层验收；设备缺口补齐前不得公开发布或称升级已通过设备验收。
