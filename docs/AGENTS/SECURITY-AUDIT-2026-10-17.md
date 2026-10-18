# 安全审计与修复：2026-10-17

本轮由主 agent 与三名子 agent 分区审查，基线为 `185740dcc5a4d3e3c55e3080a80ee0c52f176b8f`。四项独立修复提交为：备份 `9b04d7f`、发现限额 `9bcc5e6`、安卓导航 `df07880`、工作流 `c433c59`。目标是减少真实攻击面，未把静态扫描或代码测试当作设备验收。

## 发现与根因

| 发现 | 触发条件与影响 | 修复与生产调用链 |
|---|---|---|
| 372 外部应用启动出口过宽 | 主 WebView 的主 frame 非引擎导航被直接交给 ACTION_VIEW；脚本导航与自定义协议可触发外部应用。未证明外部应用自身会绕过授权执行敏感操作 | `MainActivity.shouldOverrideUrlLoading` 传递 `hasGesture` → `DownloadSaver.openInExternalBrowser` → `canOpenExternalBrowser` 仅接受用户选中的明确 HTTP(S) 地址，拒绝凭据、歧义字符及非法端口，Intent 加 BROWSABLE |
| 373 发现响应资源无界 | Linux bootstrap 信任远端 release/manifest 响应，读取全文且无 body deadline；异常或恶意上游可消耗内存并占住串行操作队列 | `fetchLatestManifest` → `fetchBytes` 限 release 2 MiB、manifest 256 KiB 的实际解码字节；每次请求包括响应体限 30 秒，超限取消并中止。此 bootstrap 仍默认未挂载，不宣称修复当前默认启用的远程入口 |
| 374 解密临时文件覆盖与明文泄露 | 用户导入位于可写目录的加密备份，旧实现以固定 `<zip>.dec.tmp` 写解密明文；预置同名文件被覆盖/删除，链接目标可被写穿。普通导入还会重新读取已检查过的路径 | `importSnapshots` → `readZip(Buffer)`，加密和普通导入都解析已经读取的字节，取消相邻明文文件及第二次路径读取。未声称解决首次 stat/read 之间的所有并发替换或导入内存预算问题 |
| 375 CI 外部 action 可变引用 | 外部 action 的版本标签可在本仓审查后改变，影响构建、Pages 及持写 token 的草稿任务；这是供应链加固，未声称已发现 action 被入侵 | 四个 workflow 外部 action 固定官方仓库解析到的完整提交 SHA；`check-workflow-action-pins.mjs` 拒绝可变标签、分支、短 SHA、表达式及未固定镜像，PR/来源预检实际执行。上游 action 的内部依赖及 runner 环境仍属于信任边界 |

## 覆盖与独立复核

- 安卓壳：WebView 顶层 bridge capability、EngineAuth/transport、Intent 和文件来源边界；已存在的修复未重复计为本轮收益。安卓审计 agent 另交叉评审备份修复，确认实际生产调用链与 Buffer 接口相符。
- 插件：Linux 资产发现、解包及缓存、鉴权、凭据与文件路径；只有能定位根因并验证的发现列入修复，未把文本扫描当成全面安全证明。
- 来源链：所有 workflow 外部 action 与草稿发布身份、资产哈希/集合、ZIP 路径、符号链接及写权限隔离；后一组未发现新的可利用缺口。
- 主 agent：前端 DOM 写入、发布页数据与下载 URL、vendor 备份导入/导出与恢复路径，并复核三个子 agent 改动。未执行全依赖漏洞数据库扫描，未证明不存在其他漏洞。

## 复现与证据

代码测试只证明对应宿主路径；以下 Linux 命令从仓库根在 WSL 执行。

```text
node --test vendor/dsh-undo-savepoint/test/import-plaintext.test.mjs
node --test plugins/dsh-linux-bootstrap/test/github-limits.test.mjs plugins/dsh-android-linux-env/test/linux-host-asset-io.test.mjs
node plugins/dsh-linux-bootstrap/test/github-limits-negative-control.mjs
node --test scripts/source-build/*.test.mjs
python3 -m unittest discover -s scripts/source-build -p 'test_*.py' -v
node scripts/source-build/check-workflow-action-pins.mjs --self-test
node scripts/check-vendored-linux-bootstrap.mjs --self-test
```

- 备份导入 5/5 通过、无跳过；旧 HEAD `core.mjs` 作为 UUT 跑相同测试时 3 项失败，含实际链接目标被覆盖。日志 `.deploy-tmp/security-team/undo-import-{test,negative}.log`。Windows 写 ZIP 的临时目录 rename 失败原始结果不记通过，Linux 实跑作为该项证据。
- Linux 发现与宿主资产 IO 首轮 23/23 通过；扩大至 bootstrap、linux-env、bridge 路由鉴权、model-capability 和 file-open 后 293/293 通过、无跳过，含新增 10 项安全测试。旧源码接受同一 3,145,896 字节超限响应，新源码拒绝。日志 `.deploy-tmp/security-runtime-suite-20261017.log`、`security-runtime-negative-20261017.log`、`security-runtime-vendor-selftest-20261017.log`；负控可重跑 `node plugins/dsh-linux-bootstrap/test/github-limits-negative-control.mjs 185740dcc5a4d3e3c55e3080a80ee0c52f176b8f`。初跑 model 缺依赖失败，补齐生产 peer 依赖后重跑全绿，未改 tracked lockfile。
- 来源 Node 全套 98/98、Python 8/8，无跳过；日志 `.deploy-tmp/security-source-build-wsl-tests.log`、`security-source-build-python-wsl-tests.log`。固定引用门禁自检与真实 CLI 负控验证可变 ref 会退出失败。
- 桥对称、API 鉴权登记、control op、op registry、Manifest、bounded IO、工具名承诺与补丁树内自洽分别通过，日志 `.deploy-tmp/security-team/check-*.log`。这些是结构证据。
- Kotlin 新增策略测试 3/3 通过、无跳过，主源码与完整测试源码编译通过（保留已有 warnings）。日志 `.deploy-tmp/security-android-browser-test.log`。扩大全量首跑缺 SDK 环境变量，原日志 `security-team/kotlin-all.log` 保留；指定现有 SDK 后重跑结果在 `security-team/kotlin-all-sdk.log`，最终状态以下方收口为准。

最终收口：WSL Node v22.22.1、OpenJDK 17.0.20.1、既有 SDK 36；Kotlin 全量 **120 类 / 1308 项，失败、错误、跳过均为 0**，`BUILD SUCCESSFUL`。使用 `.deploy-tmp/source-validation.init.gradle` 将构建目录移至用户缓存，原始 XML 按 mtime 复制回门禁预期位置后，`check-kotlin-test-count.mjs` 的逐类基线、新鲜度与无失败检查通过（SKIP=0），日志 `security-team/kotlin-count.log`。最终 CI 新安全回归 15/15、workflow 专项 10/10 均通过；执行地图、维护文档、Kotlin 注释及聚合静态接线通过。聚合静态入口不代表来源构建和设备门禁已全部执行。

补充 transport/顶层桥宿主回归 9/9，无跳过，日志 `.deploy-tmp/security-team/transport-bridge.log`。29 个变更输入的工作树字节摘要及基线/HEAD 记录于 `.deploy-tmp/security-team/input-hashes.json`（CRLF 工作树摘要，跨系统复跑须注明换行差异）。

云端来源链已对已推送 `ed0960e` 启动：[run 39030453876](https://github.com/snoworwind/dsh-mobile-apk/actions/runs/39030453876)。记录时固定引用 actions、来源替换预检及输入检出成功，正在引擎源码构建，**最终 APK/产物门禁尚无结论**；不把既有其他提交的成功 run 算作本轮通过。后续本审计文档的证据补记不改变该 run 的源码身份。

WSL 完整 Kotlin 命令：`ANDROID_HOME=/home/zouhaoyu/.local/share/android-sdk ANDROID_SDK_ROOT=/home/zouhaoyu/.local/share/android-sdk java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain --no-daemon --parallel --console=plain -I .deploy-tmp/source-validation.init.gradle :app:testDebugUnitTest`。复跑时按自己的 SDK 路径设置环境；上述缓存 init 仅移动 buildDirectory，内容为 `allprojects { layout.buildDirectory.set(new File(System.getProperty('user.home'), '.cache/dsh-mobile-apk-build/' + project.path.replace(':', '_'))) }`。

本仓未找到 AGENTS 指向的协调仓 `scripts/clean-deploy-tmp.mjs`，未擅自改用递归清理；本轮只新增小型日志及负控源码，临时旧 UUT 已删除，未保留 APK/快照副本。所有新增证据属于三日保留窗口。

## 设备与剩余边界

**未做设备验证**。WSL SDK 的 `adb devices` 为空，连接 `127.0.0.1:16416` 与 `127.0.0.1:16384` 均 `Connection refused`。没有本轮来源链新 APK，也没有 CDP、ADB 真操作、双方向截图或真机结果。L2/L3 即时三层验证尚未完成，以上源码修复不得据此作为发布候选验收通过。

外部浏览器策略保留用户点击的普通 web 地址；自动导航、非 web 深链及丢失 WebView 手势标记的重定向可能被拒绝。`hasGesture` 不是 iframe 身份证明，带手势的 frame 导航仍只允许普通 web 地址。需要用本轮来源链 APK 在设备验证这些兼容边界。

历史公开 debug key 按用户既有决定保留，仍不能提供独占签名身份保证。raw shell 文本策略不是通用执行沙箱；同 UID 任意恶意代码、构建 runner 和 Git 对象库仍属信任边界。备份累计解压预算与首次读取仍有资源及并发边界，不把本轮修复描述成通用文件系统隔离。

本地日志只供本机复核；测试和负控源码入库可重跑。已显著收紧四类边界，但不能据此宣称“没有漏洞”或“设备安全验收完成”。
