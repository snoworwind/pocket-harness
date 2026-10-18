// 端到端验证（A9 的本地真实引擎半边）：模拟一个 provider + 一个**真实存在**的模型，
// 走真实 settings 保存路径触发自动补齐，然后读回 settings 校验字段是否正确。
//
// 为什么这不是「手搓夹具的自说自话」：
//   1. settings 服务用的是**出货引擎树**里的真实实现；
//   2. llm-pi-ai 的命名空间 schema 用的是**出货** dsh-llm-pi-ai 的 Config；
//   3. 目录快照用的是出货 lib/catalog-snapshot.json（1046 键 / 41 provider）；
//   4. 保存走的是真实 settings 服务的 mutate（触发 settings/document-updated），
//      即用户点「保存」时上游实际走的那条路。
//
// 用法：node scripts/e2e-real-model-fill.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..')
const REPO = join(PLUGIN, '..', '..')
const ENGINE = process.env.DSH_ENGINE_TREE
  ?? 'D:/coding/dsh-mobile/.deploy-tmp/fx2/tree/node_modules/@deepseek-ai'

const CONTROL_TOKEN_TEST_ENV = 'DSH_CONTROL_TOKEN_TEST'
const CONTROL_TOKEN_ENV = 'DSH_CONTROL_TOKEN'
// 真实引擎树只在开发机上存在（.deploy-tmp 下的解包产物，不在 git 里）。
// 缺席时**显式 SKIP 并给出取法**，而不是抛一个看不懂的 MODULE_NOT_FOUND —— 这与仓库里
// 「不用 SKIP 掩盖 CI 缺数据」的纪律不冲突：本脚本不在 npm test 链上，它是人工/验收用的
// 真实引擎取证；缺引擎树时它本来就无法产出任何有效结论。
if (!existsSync(ENGINE)) {
  console.log('E2E-REAL-MODEL-FILL SKIPPED：未找到真实引擎树')
  console.log('  查找路径：' + ENGINE)
  console.log('  取法：解包任意一份出货快照后在 node_modules/@deepseek-ai/ 下即有；')
  console.log('        或用 DSH_ENGINE_TREE=<.../node_modules/@deepseek-ai> 显式指定。')
  process.exit(2)
}

const fail = []
const note = (line) => console.log(line)
/**
 * 断言并打印。**label 必须陈述「要求成立时的事实」** —— 因为它在 PASS 与 FAIL 两行都会打印。
 *
 * 写反的 label 会自相矛盾（真实事故 2026-10-11，Lead 指出）：
 *   PASS  input 未被裁到 schema 接受集（audio 仍在）  [["text","image"]]
 * PASS 行说「audio 仍在」，同一行却显示 audio 不在；这类消息会在下一次排查时
 * 把维护者引向**相反**的方向，比没有消息更坏。
 * 正确写法是陈述要求：'input 已裁到 schema 接受集（恰为 ["text","image"]，不含 audio）'。
 */
const assert = (ok, label, detail = '') => {
  note((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === '' ? '' : '  [' + detail + ']'))
  if (!ok) fail.push(label)
}

const snapshot = JSON.parse(readFileSync(join(PLUGIN, 'lib', 'catalog-snapshot.json'), 'utf8'))

// ── 选一个「真实存在」的模型：在出货目录里，且带 thinkingLevelMap（思考档位）──────
// zai-org/GLM-5.3-Fast 是目录里真实存在的键（provider=baseten，单条 entry、方言 thinkingFormat=openai）。
const REAL_ID = 'zai-org/GLM-5.3-Fast'
const entries = snapshot.models[REAL_ID]
note('目录快照：' + String(snapshot.modelCount) + ' 个模型键 / ' + String(snapshot.source))
note('选用模型 id：' + REAL_ID + '（目录里存在，provider=' + (entries ?? []).map((e) => e.provider).join(',') + '）')
assert(Array.isArray(entries) && entries.length > 0, '所选模型 id 在出货目录里真实存在')
const expectedEfforts = (() => {
  const map = entries[0].thinkingLevelMap ?? {}
  const out = {}
  for (const [level, wire] of Object.entries(map)) if (typeof wire === 'string' && wire.length > 0) out[level] = wire
  return out
})()
note('目录声明的能力：' + JSON.stringify({
  reasoningEfforts: expectedEfforts,
  input: entries[0].input,
  contextWindow: entries[0].contextWindow,
  maxTokens: entries[0].maxTokens,
}))

// ── 载入真实 settings 服务 ─────────────────────────────────────────────────────
const settingsUrl = pathToFileURL(join(ENGINE, 'dsh-settings', 'lib', 'index.js')).href
const settingsModule = await import(settingsUrl)
const SettingsForms = settingsModule.SettingsForms ?? settingsModule.default
note('已载入出货 settings 服务：' + settingsUrl)
assert(typeof SettingsForms === 'function', '出货 dsh-settings 提供 SettingsForms')

// 真实 pi-ai 命名空间 schema（出货包）。
const piAiUrl = pathToFileURL(join(ENGINE, 'dsh-llm-pi-ai', 'lib', 'index.js')).href
const piAi = await import(piAiUrl)
note('已载入出货 llm-pi-ai：' + piAiUrl)

// 真实 cordis 本体：SettingsForms extends Service，构造时会走 cordis 的
// `ctx.reflect.provide(...)`；手搓的鸭子类型对象在这一步就会抛
// （实测：TypeError: Cannot read properties of undefined (reading 'provide')）。
const cordisUrl = pathToFileURL(join(ENGINE, 'cordis', 'lib', 'index.js')).href
const { Context } = await import(cordisUrl)
note('已载入出货 cordis：' + cordisUrl)
assert(typeof piAi.Config === 'function' || typeof piAi.Config === 'object', '出货 llm-pi-ai 提供 Config（命名空间 schema）')

// ── 一个「最小但真实」的宿主：只装配 settings 需要的两个服务 ────────────────────
// configEditor 负责全 profile 的 configuration()；profileContext 提供 home 路径。
// 二者都用真实语义（读盘、按 entry 投影），不是空壳。
const home = mkdtempSync(join(tmpdir(), 'e2e-fill-'))
const profileFile = join(home, 'cordis.patch.yml')
writeFileSync(profileFile, '')
note('隔离 DSH_HOME：' + home)

const listeners = new Map()
const emit = (name, ...args) => { for (const l of listeners.get(name) ?? []) l(...args) }

let storedPatch = {}
// 真实 configEditor 契约（出货 dsh-settings/lib/index.js:501-537 实测）：
//   entries()            -> 全 profile 的 entry 列表（每条带 options.id 与 fiber.runtime.Config）
//   configuration()      -> { entry, inherited, override } 投影（describe 用）
//   edit(entry, mutator) -> mutator(raw, inherited) 返回新 raw，落到 profile patch 文件
//   documentPath         -> profile patch 路径
// entry.fiber.runtime.Config 必须是**真实**的 pi-ai Config schema（settings.write:538-541 读它，
// 且 volatileForm / isVolatilePath 都基于它判定字段是否可写）。
// 关键：describe() 的 value = projectForm(form, plainConfig(entry.fiber.config))
// （出货 dsh-settings/lib/index.js:436），**不是**读 patch 文件。因此 edit 必须同步 fiber.config，
// 否则读回永远是空的 —— 这正是本脚本第一版踩到的坑。uid 参与 revision 的 raw 串（:421-425）。
const piAiEntry = {
  id: 'llm-pi-ai',
  options: { id: 'llm-pi-ai' },
  fiber: {
    state: 2,
    uid: 1,
    runtime: { Config: piAi.Config },
    config: {},
    ctx: new Context(),
  },
}
const configEditor = {
  documentPath: profileFile,
  entries: () => [piAiEntry],
  configuration: () => [{ entry: piAiEntry, inherited: {}, override: storedPatch }],
  // 真实契约：mutator(raw, inherited) 返回新 raw；返回值同时落盘并成为 live 配置。
  //
  // 关键二：出货 describe() 的事件条件是 `previous.raw !== raw`，而
  // raw = JSON.stringify([fiber.uid, schema.toJSON(), options.config])（:421-435）——
  // **patch 值本身不在 raw 里**。真实链路里 configEditor.edit 会走 hmr runExclusive
  // 触发该 entry 重载，fiber.uid 随之变化，raw 才变、事件才发。
  // 因此这里必须模拟「编辑 -> entry 重载」：写盘的同时推进 uid（= 真实 reload 的等价物）。
  // 不模拟这一步，第二次保存不会发事件 —— 这正是本脚本第二版踩到的坑。
  edit: async (_entry, mutator) => {
    const next = mutator(storedPatch, {})
    storedPatch = next
    piAiEntry.fiber.config = next
    piAiEntry.fiber.uid += 1
    writeFileSync(profileFile, JSON.stringify(next, null, 2))
    return next
  },
}
const profileContext = { home, name: 'e2e', entry: { options: { id: 'llm-pi-ai' } } }

/**
 * 真实 cordis Context：SettingsForms extends Service，构造时会走 cordis 的
 * `ctx.reflect.provide(...)` 注册服务。手搓的鸭子类型对象在这一步就会抛
 * （实测：TypeError: Cannot read properties of undefined (reading 'provide')），
 * 所以必须用**出货 cordis** 本体搭宿主 —— 这也正是「真实引擎半边」的实质。
 */
const root = new Context()
// settings 只与两个服务交互：configEditor（全 profile 投影）与 profileContext（home 路径）。
root.provide('configEditor', configEditor)
root.provide('profileContext', profileContext)
// SettingsForms 构造里 await 了 loader；给一个立即完成的最小 loader。
root.provide('loader', { await: () => Promise.resolve() })

/** 在真实 cordis 上注册一个 effect，并转发到我们的 listeners 表（settings 用 on/emit）。 */
const hostCtx = root
const settings = new SettingsForms(hostCtx)
note('真实 SettingsForms 已实例化（真实 cordis Context 上）')

// ── 装配本插件（用出货 lib/index.js，即镜像进快照的那份产物）──────────────────
const plugin = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
note('已载入 dsh-model-capability 产物：' + join(PLUGIN, 'lib', 'index.js'))

// 本插件 inject ['tools','settings']：静态依赖只这两项（webServer 是**可选**依赖，见下）。
const registeredTools = []
const registeredRoutes = []
root.provide('tools', { register: (t) => { registeredTools.push(t); return () => {} } })
// settings 已经由 SettingsForms 构造时注册进 cordis 服务表；这里再显式确认一次解析。
// 用 root.get 显式确认一次（不一致说明宿主装配错了，后续判据都会失真）。
assert(typeof root.get === 'function', '真实 cordis Context 提供 get()')

process.env.DSH_HOME = home
// 壳侧控制令牌：出货语义要求显式测试开关在场时 DSH_CONTROL_TOKEN 才生效
// （control-queue.ts:319-334；未声明开关时 env 完全不参与）。A6 路由需要一个真令牌。
process.env[CONTROL_TOKEN_TEST_ENV] = '1'
process.env[CONTROL_TOKEN_ENV] = 'e2e-control-token'

// ── 装配顺序必须是「apply 先、webServer 后」────────────────────────────────────
//
// 这是本脚本最重要的忠实性约束，也是一次真实假绿的教训（2026-10-11 设备实锤）：
// 真实装配里 profile-web.cordis.patch.yml:94-96 的 model-capability 行**早于**
// dsh-web-app/cordis.patch.yml:150 的 webserver 行。而 cordis 的 ctx.get(name) 默认
// strict=true（只返回已激活实现），所以在 apply() 那一刻读 webServer 必然 undefined。
// 上一版脚本先 provide('webServer') 再 apply，顺序与真实相反，于是「读得到」恒成立，
// 把「A6 在真机上永不注册」这个缺陷完全掩盖了 —— 屏幕/夹具顺序错了，判据就恒绿。
//
// 因此这里先 apply、后 provide，并断言「apply 那一刻读不到 + 最终仍然注册成功」。
let webServerAtApply = 'not-observed'
const originalGet = root.get.bind(root)
root.get = (name, strict) => (name === 'webServer' && !webServerProvided ? undefined : originalGet(name, strict))
let webServerProvided = false
const installWebServer = () => {
  webServerProvided = true
  root.provide('webServer', { register: (r) => { registeredRoutes.push(r); return () => {} } })
}

// 预置 models.dev 缓存：本脚本要复现「models.dev 声明了 audio」的设备现场，
// 而该来源在 apply() 的启动刷新里读缓存 —— 所以必须在 apply 之前落盘。
// 形状与设备上真实缓存一致（empiriolabs 的 mimo-v2-5 是 input:["text","image","audio"]）。
const AUDIO_ROUTE = 'audio-gateway'
const AUDIO_ID = 'empiriolabs/mimo-v2-5'
writeFileSync(join(home, 'models-dev.json'), JSON.stringify({
  schema: 1,
  source: 'models.dev',
  generatedAt: new Date().toISOString(),
  modelCount: 1,
  models: [{
    id: AUDIO_ID, name: 'MiMo V2.5', provider: 'empiriolabs',
    contextWindow: 1000000, maxTokens: 128000,
    input: ['text', 'image', 'audio'],
    thinkingLevels: ['off', 'low'],
  }],
}))

// 诊断轨迹会写到 $DSH_HOME/model-capability.log：出问题时可据此定位（本脚本失败时自动打印）。
plugin.apply(root, {})
webServerAtApply = String(root.get('webServer'))
note('apply 时 webServer（真实拓扑：尚未加载）=' + webServerAtApply)

// webServer 更晚装配 —— 与真实引擎一致。
installWebServer()
// ctx.inject 回调是异步派发的，给一个事件循环回合让它落地。
await new Promise((r) => setTimeout(r, 50))

note('装配后：tools=' + String(registeredTools.length) + ' routes=' + String(registeredRoutes.length))
assert(registeredTools.length >= 1, '插件注册了工具')
assert(webServerAtApply === 'undefined',
  '真实拓扑复现：apply 那一刻 webServer 尚未提供（这是缺陷能出现的必要条件）', webServerAtApply)
assert(registeredRoutes.some((r) => r.path === '/api/android/model-capability/fill'),
  'A6 手动补齐路由最终仍注册成功（webServer 后到）')
const fillRoute = registeredRoutes.find((r) => r.path === '/api/android/model-capability/fill')

// ── 场景：用户「添加自定义供应商」+ 勾选真实模型 -> 保存 ────────────────────────
const ROUTE = 'my-custom-gateway'
const saveModels = async (models, route = ROUTE, baseURL = 'https://gw.example/v1') => {
  // 真实保存：mutate 写 providers.<route>，随后服务自己 emit settings/document-updated。
  await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: { baseURL, api: 'openai-completions', models } }])
}
/** 从真实 settings describe 里读回指定路由的 models（出货描述符字段名是 value）。 */
const readBackOf = (route) => {
  const section = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
  return section?.value?.providers?.[route]?.models
}
const readBack = () => readBackOf(ROUTE)

// 第一次保存：建立基线（A7：首读只记录、不写）。
await saveModels([])
await new Promise((r) => setTimeout(r, 150))

// 第二次保存：把真实模型加进去 —— 这才是「用户这次实际保存的模型」。
await saveModels([{ id: REAL_ID }])
await new Promise((r) => setTimeout(r, 400))

{
  const d = settings.describe({ namespaces: ['llm-pi-ai'] }).find((x) => x.ns === 'llm-pi-ai')
  note('DEBUG value keys=' + JSON.stringify(Object.keys(d?.value ?? {})))
  note('DEBUG providers=' + JSON.stringify(Object.keys(d?.value?.providers ?? {})))
  note('DEBUG route value=' + JSON.stringify(d?.value?.providers?.[ROUTE]).slice(0, 500))
}
const models = readBack()
const entry = (models ?? []).find((m) => (typeof m === 'string' ? m : m.id) === REAL_ID)
note('保存后读回 settings：' + JSON.stringify(entry))
assert(entry !== undefined && typeof entry === 'object', '保存后条目存在')

// ── 判据：字段是否**正确**（不是「有没有写」而是「值与目录声明一致」）──────────
if (entry && typeof entry === 'object') {
  assert(JSON.stringify(entry.reasoningEfforts) === JSON.stringify(expectedEfforts),
    'reasoningEfforts 与目录声明逐字一致（A9：模型选择器据此渲染推理强度小字）',
    JSON.stringify(entry.reasoningEfforts))
  assert(JSON.stringify(entry.input) === JSON.stringify(entries[0].input),
    'input 与目录声明逐字一致', JSON.stringify(entry.input))
  assert(entry.contextWindow === entries[0].contextWindow,
    'contextWindow 与目录声明一致', String(entry.contextWindow))
  assert(entry.maxTokens === entries[0].maxTokens,
    'maxTokens 与目录声明一致', String(entry.maxTokens))
  // A9 的运行期条件：模型选择器只在 reasoning !== undefined 时渲染小字。
  assert(entry.reasoningEfforts !== undefined && Object.keys(entry.reasoningEfforts).length > 0,
    'A9 前提成立：补齐后 reasoningEfforts 非空 => 选择器会渲染推理强度小字')

  // A9 的客户端半边：在**出货客户端产物**上取证「无需重启即可生效」的两个条件。
  // 只读断言源码，不启动 UI（设备层那一步留给装机后的三层验收）。
  const clientPath = join(ENGINE, 'dsh-client-ui-model-selection', 'lib', 'client.js')
  if (existsSync(clientPath)) {
    const client = readFileSync(clientPath, 'utf8')
    // 条件一：settings/document-updated 到达时刷新目录（补齐是我方第二次写，会再发一次事件 =>
    // 选择器不需要重启就能看到新档位）。
    assert(client.includes('ctx.remote.$on("settings/document-updated"'),
      'A9 客户端：模型目录订阅 settings/document-updated（补齐事件到达即刷新，无需重启）')
    // 用字符串定位而不是正则：本行要断言的是「事件名之后不远处出现 refresh 调用」，
    // 写成正则会把 \s\S 转义搞成不可读的一团，且这一步不需要正则的表达力。
    const eventAt = client.indexOf('ctx.remote.$on("settings/document-updated"')
    const refreshAt = client.indexOf('catalog.refresh()', eventAt)
    assert(eventAt >= 0 && refreshAt > eventAt && refreshAt - eventAt < 200,
      'A9 客户端：该事件确实触发 catalog.refresh()')
    // 条件二：推理强度入口仅在 reasoning !== undefined 时渲染（值缺失 = 不渲染，补齐后 = 渲染）。
    assert(client.includes('reasoning !== void 0 &&'),
      'A9 客户端：推理强度入口以 reasoning !== undefined 为渲染条件')
    note('A9 客户端取证件：' + clientPath)
  } else {
    note('A9 客户端取证件不在场，跳过该两项静态断言：' + clientPath)
  }
}
{
  const logPath = join(home, 'model-capability.log')
  try {
    const log = readFileSync(logPath, 'utf8')
    note('插件诊断轨迹（' + logPath + '）：')
    const lines = log.split(String.fromCharCode(10)).filter((l) => l.trim() !== '')
    for (const line of lines.slice(0, 40)) note('  | ' + line)
  } catch {
    note('插件诊断轨迹不存在（' + logPath + '）')
  }
}

// ── 反向 1：未勾选（不在本次保存里）的既有模型不动 ────────────────────────────
const OTHER = 'another-model-not-selected'
await saveModels([{ id: REAL_ID }, { id: OTHER }])
await new Promise((r) => setTimeout(r, 300))
const after = readBack()
const other = (after ?? []).find((m) => (typeof m === 'string' ? m : m.id) === OTHER)
note('未勾选模型读回：' + JSON.stringify(other))
assert(other !== undefined && other.reasoningEfforts === undefined, 'A1：本次保存未涉及的模型不被补齐')

// ── 设备实锤场景：声明含 audio 的模型 -> 不能连坐（0.14.6 修复）──────────────
//
// 真机现场：xiaomimimo 的 mimo-v2.5 在 models.dev 里声明 input=["text","image","audio"]，
// 而出货 pi-ai 的 schema 只接受 text|image。于是写回被 schemastery 整条拒绝：
//   $.providers.<r>.models[0].input[2] expected "text" | "image" but got "audio"
// —— **写回是一次 mutate，校验失败 = 整条被拒**，所以同一模型的 reasoningEfforts 也写不进去。
// 设备历史里 8 次 REJECTED 即此，且它正是功能 A 的主目标（思考档位）失效。
//
// 本段用**真实 settings + 真实 schema + 真实保存事件**复现该场景，断言：
//   ① input 被裁到 schema 接受集（不含 audio）；
//   ② reasoningEfforts 等其它字段**真的写进去了**（不连坐的正面证据）。
{
  const AUDIO_ROUTE = 'audio-gateway'
  // 与设备同源：models.dev 的条目声明了 audio（用真实缓存里的形状，不是杜撰）。
  // models.dev 缓存已在 apply 之前预置（见上面 AUDIO_ROUTE/AUDIO_ID 的说明）。
  await saveModels([{ id: AUDIO_ID }], AUDIO_ROUTE, 'https://audio.example/v1')
  await new Promise((r) => setTimeout(r, 400))
  const written = (readBackOf(AUDIO_ROUTE) ?? []).find((m) => m.id === AUDIO_ID)
  note('含 audio 声明后读回：' + JSON.stringify(written))
  assert(written !== undefined, '含 audio 的路由出现在 settings 里')
  assert(JSON.stringify(written.input) === JSON.stringify(['text', 'image']),
    'input 已裁到 schema 接受集（恰为 ["text","image"]，不含 audio）', JSON.stringify(written.input))

  // **不连坐的正面证据**：同一批 patch 里的其它字段必须真的写进去。
  // 修前（缺过滤）这三条会一起消失 —— 因为 mutate 整条被 schemastery 拒绝。
  assert(written.contextWindow === 1000000,
    '不连坐：contextWindow 仍被写入（未被 input 的非法模态连坐）', String(written.contextWindow))
  assert(written.maxTokens === 128000,
    '不连坐：maxTokens 仍被写入', String(written.maxTokens))

  // 最强证据：拿**出货 schema 本体**校验这条真实写回结果（不是我们自己的宽松校验）。
  // 修前这里会抛 expected text|image but got audio —— 那正是设备上的 REJECTED。
  let schemaError = ''
  try {
    piAi.Config({ providers: { [AUDIO_ROUTE]: { api: 'openai-completions', baseURL: 'https://audio.example/v1', models: readBackOf(AUDIO_ROUTE) } } })
  } catch (error) {
    schemaError = String(error && error.message ? error.message : error)
  }
  assert(schemaError === '',
    '修好的写回可通过出货 schema 校验（不再是设备上的 mutate-rejected）', schemaError.slice(0, 120))
}

// ── 反向 2：仅改 baseURL/apiKey 而模型集合未变 -> 不触发补齐 ─────────────────
const REAL2 = 'moonshotai/Kimi-K2.5'
await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', ROUTE], value: {
  baseURL: 'https://gw2.example/v1', api: 'openai-completions', apiKey: 'k2',
  models: [{ id: REAL_ID, reasoningEfforts: { low: 'USER' } }, { id: OTHER }],
} }])
await new Promise((r) => setTimeout(r, 300))
const after2 = readBack()
const kept = (after2 ?? []).find((m) => m.id === REAL_ID)
note('仅改 baseURL 后读回：' + JSON.stringify(kept))
assert(kept !== undefined && JSON.stringify(kept.reasoningEfforts) === JSON.stringify({ low: 'USER' }),
  'A1/A5：仅改 baseURL/apiKey 不触发补齐，且用户手写值不覆盖')
void REAL2

// ── A6：手动补齐入口（真实路由 handler）─────────────────────────────────────
if (fillRoute !== undefined) {
  // 造一个「用户早就在用、但当时没补过能力」的状态。
  //
  // 为什么不走 settings.mutate：mutate 会把该路由并入现有值（mergeLayers），
  // 清不掉已补齐的能力字段。A6 的真实场景是**升级前就存在**的配置——那是在
  // 旧版本里落盘、本次进程启动时读进来的，因此直接构造 live 配置（等价于用户
  // 早已保存好的那条路由）才是忠实模拟。
  const LEGACY = 'legacy-gateway'
  const legacyModel = { id: REAL_ID, input: ['text'] }
  storedPatch = { ...storedPatch, providers: { ...storedPatch.providers, [LEGACY]: {
    baseURL: 'https://legacy.example/v1', api: 'openai-completions', models: [legacyModel],
  } } }
  piAiEntry.fiber.config = storedPatch
  piAiEntry.fiber.uid += 1
  await settings.describe({ namespaces: ['llm-pi-ai'] })
  const beforeManual = (readBackOf(LEGACY) ?? []).find((m) => m.id === REAL_ID)
  note('手动补齐前（legacy-gateway）：' + JSON.stringify(beforeManual))
  assert(beforeManual !== undefined && beforeManual.reasoningEfforts === undefined,
    'A6 前置：待补模型确实缺 reasoningEfforts（否则判据无判别力）')

  const response = { code: null, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body ?? '' } }
  // 未带令牌 + Host 非回环 -> 必须被拒（证明鉴权真的在跑，不是登记个名字蒙门禁）。
  await fillRoute.handler({ method: 'POST', headers: { host: 'evil.example' } }, response)
  note('鉴权（非回环 Host、无令牌）响应码：' + String(response.code))
  assert(response.code === 403 || response.code === 401, 'A6 路由确实鉴权（非回环 Host 被拒）', String(response.code))

  // 带壳侧控制令牌 + 回环 Host -> 放行。
  const bridge = await import(pathToFileURL(join(REPO, 'plugins', 'dsh-android-bridge', 'lib', 'index.js')).href)
  const token = bridge.shellControlToken()
  note('壳侧控制令牌来源：' + (token === undefined ? '未配置' : '已配置'))
  const okResponse = { code: null, body: '', writeHead(code) { this.code = code }, end(body) { this.body = body ?? '' } }
  await fillRoute.handler({ method: 'POST', headers: { host: '127.0.0.1:3080', 'x-dsh-control-token': token ?? '' } }, okResponse)
  note('鉴权（回环 Host + 控制令牌）响应码：' + String(okResponse.code) + ' body=' + okResponse.body.slice(0, 200))
  const payload = JSON.parse(okResponse.body || '{}')
  // A6 覆盖全部非内置路由，故同时看 legacy（应被补）与 ROUTE（已补满，应 no-change）。
  const manualEntry = (readBackOf(LEGACY) ?? []).find((m) => m.id === REAL_ID)
  const untouchedRoute = (readBack() ?? []).find((m) => m.id === REAL_ID)
  note('手动补齐后（legacy-gateway）：' + JSON.stringify(manualEntry))
  note('手动补齐后（my-custom-gateway）：' + JSON.stringify(untouchedRoute))
  assert(okResponse.code === 200, 'A6 手动补齐在正常鉴权下返回 200', String(okResponse.code))
  assert(payload.wrote >= 1, 'A6 手动补齐真的写入了字段', JSON.stringify(payload))
  assert(manualEntry !== undefined && manualEntry.reasoningEfforts !== undefined,
    'A6 手动补齐补上了 reasoningEfforts（用户早就在用的模型也能补）')
  assert(JSON.stringify(manualEntry?.input) === JSON.stringify(['text']),
    'A6 手动补齐不覆盖用户已声明的 input')
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
rmSync(home, { recursive: true, force: true })
console.log('')
if (fail.length === 0) {
  console.log('E2E-REAL-MODEL-FILL PASSED（全部判据通过）')
  process.exit(0)
}
console.log('E2E-REAL-MODEL-FILL FAILED（' + String(fail.length) + ' 项）：' + fail.join('；'))
process.exit(1)
