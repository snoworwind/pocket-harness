# dsh-model-capability — 自定义提供商能力发现（0.14.5，Issue #56）

> 状态：**已挂载到 profile，支持模型级能力回填和 Issue #56 的 MiMo 二态思考开关**。
> 本轮以本地协议夹具和两份插件回归验证；未使用真实凭据或真实 API。

## 解决的问题

用户自填的提供商路由（llm-pi-ai `providers.<route>`）没有能力元数据：设置页的自定义
提供商编辑器只写 `id/name/contextWindow/maxTokens`，所以输入框旁**没有可选的推理等级**，
模态（图片/音频）也只能手改 settings.yaml。本插件按「端点说了什么就记什么」的原则补上
这层元数据。

## 发现管线（严格顺序，任一阶段未声明即保持未知）

1. **被动 GET**：只读取配置端点**实际返回**的字段。`openai-completions`/`anthropic-messages`/
   `openrouter` 走 `GET <baseURL>/models`；`google-generative` 走 `GET <baseURL>/models?key=`；
   `ollama` 走 `GET <baseURL>/api/tags` + 只读元数据 `POST /api/show`（不发补全请求、不耗额度）。
2. **厂商描述符解析**：按**响应形状**（不是 URL 或模型名）识别显式能力 schema：
   - OpenAI 兼容：`data[].id`，若带 `context_length`/`max_output_tokens` 则读入；
   - OpenRouter 形态：`architecture.input_modalities` → 模态；`supported_parameters` 含
     `reasoning` 只说明「支持推理」，**等级词表仍未声明 → 保持未知并记注**；
     `reasoning_efforts` 显式给出等级词才写入（词表外单词丢弃并记注）；
   - Google：`models[].name`（剥 `models/` 前缀）、`inputTokenLimit`/`outputTokenLimit`；
   - Ollama：`/api/show.capabilities`（`vision` → 图片模态；`thinking` → 支持推理但等级未知）。
3. **主动 reasoning 探测受显式授权和协议门控**：只有 `active=true` 且 `confirm=true`、
   在线端点模式才可能发请求。`openai-responses` 使用 `/responses` 与
   `reasoning.effort`；`openai-completions` 仅在用户明确配置
   `compat.thinkingFormat=openai` 且 `supportsReasoningEffort=true` 时使用标准
   `/chat/completions` 与 `reasoning_effort`。两者都先发无效 effort 负控；只有服务端以明确
   提及 reasoning/effort 的参数错误拒绝负控，候选成功才标记 `active-probe`。MiMo 的
   `thinking.type` 二态开关永不进入 effort 探测。

**协议与写回**：有效 wire API 按 DSH 规则解析，模型 compat 高于 route compat，高于同协议 catalog。
`openai-completions` 的自动档位要求有效 compat 同时明确 `thinkingFormat` 与
`supportsReasoningEffort: true`；pi-ai 会按该组合生成对应 request field。`openai-responses`
由 serializer 将 `thinkingLevelMap` 映射到 `reasoning.effort`，不要求 Completions compat。
仅 models.dev 或端点自述的多个 Responses 档位不足以证明语义不同，因此保持未知；目录内相同
wire spelling 的档位会合并。
route/model 已显式设置的 compat、reasoningEfforts（包括 `false`）仅参与判断，不会被重新写回。

**MiMo 思考开关**：插件只对精确、版本化的官方 profile（`mimo-v2.5`、`mimo-v2.5-pro`）或用户
明确写入 `compat.thinkingFormat=mimo` 的 `openai-completions` 模型生成二态运行时视图。即使已有
用户档位（例如 `high`），设置中的原值也不改写；DSH 运行时仅把旧的非 `off` 默认值归一为
canonical `low`，selector 固定显示“关闭思考/开启思考”。PiAi serializer 只发送
`thinking.type=disabled|enabled`，不发送 `reasoning_effort`；多轮 assistant 历史回传实际
`reasoning_content`，没有内容时按协议要求补空字段。官方默认思考为开启。
未知 API、模型别名、URL 和 route 名均不用于自动识别，用户已声明的值保持原样。上游 `dsh/`
保持只读，适配由本仓 0.14.5 补丁完成。

**不变量**：不做 URL/模型名启发式；未声明的能力保持缺席；每条能力都带 `source`
（`endpoint-descriptor` / `vendor-descriptor` / `models-dev` / `engine-catalog` / `user-fallback`）；
`reasoningEfforts` 永远是模型级值。MiMo 借用 `off/low` 代表二态 UI，但不会将其序列化成强度。

## 工具

`model_capability_probe`（参数：`provider` 必填；`active`/`confirm`/`levels` 可选）。主动探测会
产生模型请求与费用，必须同时传 `active=true`、`confirm=true`；默认档位为 `low/medium/high`。
返回摘要文本 + 结构化 `report`（`fetched` 审计抓取过的端点、`models[].sources` 标来源、
`unknown` 列未获元数据的模型、`notes` 记端点自述与丢弃的未知等级词）。

## 触发时机：只在保存时补给，没有任何定时器

自动补给**唯一**的触发源是上游在设置写入后 emit 的 `settings/document-updated`
（`dsh-settings` 的 `SettingsForms.write` 每次用户保存都 `describe()` 一次，而 describe 在
raw 段变化时 emit 该事件）。本插件不排 `setTimeout`，也不排 `setInterval`。

收窄口径：事件只带 `(ns, revision)` 不带值，因此插件用「上一轮描述符 vs 本轮描述符」按
`(route, modelId)` 的**值敏感签名**做 diff（`src/signature.ts` 的 `modelSignatureParts`，
与自触发签名同源），只对本次保存**新增或改动**的模型做发现与写回。因此：

- 用户在设置页「获取模型列表 → 勾选 → 保存」时，只处理这次实际保存的模型；未勾选的既有模型不动；
- 只改 `baseURL`/`apiKey` 而模型集合未变时**不触发**任何能力补齐（路由级键不参与模型签名）；
- 启停之间没有基线可比时（进程刚起、还没读到过描述符）**一律不写**：无法区分「这次新加的模型」
  与「用户早就在用的模型」，后者不该被自动改写。首读只记录基线。
- 只处理**非内置** provider（引擎自带目录已声明的网关由上游自己声明，补写只会打架）；
  内置集合由出货目录快照的 `provider` 字段重建，与上游 `llm-pi-ai` 的 `declared: !catalog.has(provider)` 同源。

历史（为什么去掉定时器）：0.14.2 之前是「每 5 秒全量 describe 取签名」，实测常驻 24-26% CPU；
0.14.2 改成「启动延迟一轮 + 120 秒兜底轮询」。设备实证（2026-10-10，`$DSH_HOME/model-capability.log`
380KB）显示后者每 120 秒写一行 tick 日志、连续数日，而该设备当时 `runAutoPass: routes=[]` ——
零价值工作仍常驻。真因是 `describe` 本身就贵（`settings` 服务没有「只读自有命名空间」的轻量路径，
每次 `describe` 都走 `configEditor.configuration()` 并对全 profile 每个 entry 重做
`inherited()` + `structuredClone`，单次实测 300-1500ms），所以「调大间隔」只是摊薄而非消除。

事件循环边界：每次补给在每条 route 发现之前通过 `setImmediate`（`yieldAutoPass`）让出事件循环。
自动路径使用 `offline=true`、`allowModelsDevNetwork=false`，绝不联网；主动请求授权条件保持原样。
各阶段保留原描述符缓存、写后失效与 CAS 重试；checkpoint 期间插件销毁则终止后续发现和读写。

## 手动补齐入口（A6）

「早就在用、当时没补过能力」的模型不会再被自动改写（见上节的基线规则），因此需要一个显式入口：

- 宿主路由：`POST /api/android/model-capability/fill`，与其它 Android 自有路由同一道门
  （`authorizeMobileRoute`：`connection` 服务的 Host/Origin/browser-session 优先，缺 `connection` 时
  回环 Host + 壳侧实时 controlToken）；已登记 `scripts/api-route-auth-policy.json`。
- 页面入口：设置页「开发者选项」里紧邻「清除运行时缓存」的一行（复用既有 `dsh-dev-row` 样式，
  不新增设置分区）。**挂载时不发请求**，只在点击时 POST 一次。
- 语义：覆盖该插件范围内的全部非内置路由（即用户明确要求的「把我现在这些模型补齐」），
  但仍遵守字段级写入与「不覆盖用户已有值」，且只写已经在 settings 里声明的模型
  （`planModelPatch` 不会凭空创建条目）；同样不联网。结果逐路由如实上屏，失败原因不被粉饰。

## 查找语义：L1 精确 → L2 大小写折叠 → L3 分隔符折叠 → L4 不命中

命中即停，且每个折叠层**只在恰好剩下一个候选时**才采用：

| 层 | 规则 | 不采用的条件 |
|---|---|---|
| L1 | 与目录键逐字相等（区分大小写） | —— |
| L2 | 折叠大小写后相等 | 候选 >= 2（判歧义） |
| L3 | 再折叠 `- _ . /` 与空格后相等 | 候选 >= 2（判歧义） |
| L4 | 都不成立 | 一律不补，记录 `not-found` / `ambiguous` |

歧义一律不补齐、绝不任取一条：出货目录 1046 个键里有 **37 组**仅大小写不同的重复键，
且这 37 组的两形态 capabilities **全都不同**（例：`moonshotai/Kimi-K2.5` 的 baseten 形态有
`thinkingLevelMap` 与 `thinkingFormat=baseten`，huggingface 形态两者皆无，`contextWindow` 也不同）。
再折叠分隔符会额外引入 49 组新冲突，按同一规则自动退化为「不补齐」——那是期望行为。
补错能力值（写出与真实网关不符的思考档位/模态）比不补更坏，用户无法察觉。

L1 不做规范化：本来精确可判的输入不能被折叠层抢走（那会把确定结果退化成歧义）。
目录索引一律走 `Object.hasOwn`，因为模型 id 是用户可控字符串，裸索引会取到
`Object.prototype` 的成员（`constructor`/`toString`/`__proto__` 等，实测抛 `TypeError`）。

## 验收边界

- 插件和补丁的本地回归覆盖配置校验、selector 二态映射、Completions 请求字段、用户值保护、
  多轮 `reasoning_content` 回传，以及无确认/离线/不支持 API 时的零主动请求。
- 真实服务端行为和设备 UI 尚未在本轮验收；这不影响协议夹具和离线回归结论，也不应表述为真实 API 已验证。

## 开发

```powershell
cd plugins\dsh-model-capability
npm run build     # tsc
npm test          # build + 插件本地回归测试（含 A1/A4/A5/A7 的反向判据）
npm run e2e       # 真实引擎树上的端到端取证（缺引擎树时显式 SKIP，见脚本头部）
```
