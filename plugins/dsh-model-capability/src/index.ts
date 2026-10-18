import { boundedResponseText } from './bounded-response.js'

/**
 * dsh-model-capability — host-side capability discovery for user-declared provider
 * routes (issues #122 / #125: a custom provider has no selectable reasoning effort).
 *
 * Sources, in strict order — a capability that no source states stays absent:
 *   1. `endpoint-descriptor` — a passive GET of metadata the endpoint itself returns;
 *   2. `vendor-descriptor`  — explicit capability schemas (OpenRouter / Google / Ollama);
 *   3. `engine-catalog`     — exact model-id lookup in the pi-ai vendor catalogs the
 *      engine ships (a vendor *declaration*, never a name heuristic);
 *   4. active reasoning probes run only after explicit confirmation, through a
 *      known serializer, with a rejecting negative control.
 *
 * Write-back is opt-in per call (or by the startup pass) and field-level: it only
 * fills missing model-level fields and never overwrites a value the user declared.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DIALECT_COMPAT_KEYS,
  THINKING_LEVELS,
  canApplyReasoningEfforts,
  effortsFrom,
  normalizeReasoningEfforts,
  providerDiagnostic,
  probePassive,
  probeOpenAICompletionsReasoningEfforts,
  probeResponsesReasoningEfforts,
  type FetchLike,
  type Modality,
  type ModelCapabilities,
  type ProbeReport,
  type ProviderConfig,
  type ReasoningEfforts,
} from './capability-probe.js'
import { hasCapabilities, lookupCatalog, type CatalogSnapshot } from './catalog-lookup.js'
import { providerFromSettings, type SettingsLike } from './settings-config.js'
import { applyModelPatch, createStampStore, type ModelPatch, type SettingsWriteLike } from './settings-writer.js'
import { modelSignatureParts, type ModelSignaturePart } from './signature.js'
import {
  authorizeMobileRoute,
  sendMobileRouteRejection,
  shellControlToken,
  type ConnectionRouteAuth,
  type MobileRouteRequest,
  type MobileRouteResponse,
} from '@dsh-android/dsh-android-bridge'
import {
  MODELS_DEV_URL,
  buildModelsDevSnapshot,
  effortsFromLevels,
  isStale,
  lookupModelsDev,
  mergeModelsDev as mergeModelsDevEntries,
  modelsDevCachePath,
  parseModelsDev,
  readModelsDevSnapshot,
  writeModelsDevSnapshot,
  type ModelsDevSnapshot,
} from './models-dev.js'

export const name = 'dsh-model-capability'

/**
 * `settings` is the write-back seam; `tools` registers the discovery tools.
 *
 * `webServer` is deliberately **not** injected: it is optional. The headless profile
 * mounts no HTTP server (dsh-headless/cordis.patch.yml: "It mounts no Host, HTTP server,
 * Web runtime, or browser plugin"), and `inject` gates `apply()` — declaring it here
 * would stop the tools and the save-triggered fill from ever registering on every
 * profile without a web server. The manual-fill route (A6) instead reads it through
 * {@link optionalService} and simply skips registration when it is absent.
 */
export const inject = ['tools', 'settings'] as const

export {
  THINKING_LEVELS,
  canApplyReasoningEfforts,
  normalizeReasoningEfforts,
  probePassive,
  probeOpenAICompletionsReasoningEfforts,
  probeResponsesReasoningEfforts,
  probeReasoningEfforts,
  parseDescriptor,
  parseOllamaShow,
  effortsFrom,
} from './capability-probe.js'
export type {
  ActiveProbeResult,
  ModelCapabilities,
  ProbeReport,
  ProviderConfig,
  ReasoningEfforts,
  ThinkingLevel,
} from './capability-probe.js'
export { providerFromSettings } from './settings-config.js'
export type { SettingsLike } from './settings-config.js'
export { lookupCatalog, effortsOf, hasCapabilities } from './catalog-lookup.js'
export type { CatalogEntry, CatalogMatch, CatalogSnapshot } from './catalog-lookup.js'
export { planModelPatch, applyModelPatch } from './settings-writer.js'
export type { ModelPatch, PlanResult, WriteResult } from './settings-writer.js'
export {
  MODELS_DEV_URL,
  MODELS_DEV_TTL_MS,
  MODELS_DEV_MAX_BYTES,
  parseModelsDev,
  buildModelsDevSnapshot,
  isStale,
  lookupModelsDev,
  mergeModelsDev,
  effortsFromLevels,
  modelsDevCachePath,
  readModelsDevSnapshot,
  writeModelsDevSnapshot,
  thinkingLevelsFrom,
} from './models-dev.js'
export type { ModelsDevEntry, ModelsDevSnapshot, ModelsDevAgreement } from './models-dev.js'

export interface PluginConfig {
  /**
   * Enrich capabilities when a settings save is observed (default true). There is
   * no timer of any kind: the only writer is the `settings/document-updated` event
   * a save emits (see the auto-apply comment in `apply()`).
   */
  autoApply?: boolean
  /** Restrict the automatic pass to these routes (default: every declared route). */
  routes?: string[]
  /**
   * S3: consult the models.dev encyclopedia (default true). A failed fetch degrades
   * to the previous snapshot, and with none the source is simply absent — it never
   * blocks S1/S2/S4.
   */
  modelsDev?: boolean
  /**
   * S5: fallback values the USER explicitly declared. Absent means there is no S5 —
   * an unstated capability stays absent rather than becoming a factory constant.
   * Values from here are tagged `user-fallback` on write-back.
   */
  fallbacks?: {
    contextWindow?: number
    maxTokens?: number
    input?: Modality[]
    reasoningEfforts?: ReasoningEfforts
  }
}

interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

interface CtxLike {
  settings?: SettingsLike & SettingsWriteLike
  logger?: (name: string) => { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
  effect?: (fn: () => () => void) => void
  /** cordis 服务查询：未提供的服务返回 undefined（不要直接读 ctx.<service>——未 inject 会抛）。 */
  get?: (name: string) => unknown
  tools: { register(tool: unknown): void }
}

/** Manual-fill route path (A6): the settings page calls this to fill on demand. */
export const MANUAL_FILL_ROUTE = '/api/android/model-capability/fill'

/** 可选服务读取：未声明 inject 时直接读属性会抛（cordis 4 实测），统一走 ctx.get。 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  try {
    const getter = (ctx as { get?: (n: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    return getter.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

let cachedSnapshot: CatalogSnapshot | undefined
let snapshotTried = false

/**
 * 诊断轨迹（DSH_MODEL_CAPABILITY_TRACE=0 可关）：追加到 $DSH_HOME/model-capability.log。
 * 引擎 stdout（engine.log）轮转很快、只留极短尾部，自动补给的静默失败在真机上无法定位——
 * 这条文件轨迹是现场排障的唯一可靠面（不含任何凭据）。
 */
function writeDiagnostic(message: string): void {
  if (process.env.DSH_MODEL_CAPABILITY_TRACE === '0') return
  try {
    const home = process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
    appendFileSync(`${home}/model-capability.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 诊断失败不影响主流程
  }
}

/** Loads the build-time catalog snapshot shipped beside this module. */
export function loadCatalogSnapshot(): CatalogSnapshot | undefined {
  if (snapshotTried) return cachedSnapshot
  snapshotTried = true
  try {
    cachedSnapshot = JSON.parse(readFileSync(new URL('./catalog-snapshot.json', import.meta.url), 'utf8')) as CatalogSnapshot
  } catch {
    cachedSnapshot = undefined
  }
  return cachedSnapshot
}

/**
 * Keep only the wire-dialect compat keys, and only when the catalog actually
 * declares a thinking format — a partial dialect (e.g. only maxTokensField)
 * would still let pi-ai fall back to a detected default (issue #134).
 * @param compat - unanimous compat map from the catalog lookup.
 * @returns the dialect keys to write, or undefined when the dialect is unknown.
 */
export function pickDialect(compat: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!compat || compat.thinkingFormat === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const key of DIALECT_COMPAT_KEYS) {
    const value = compat[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

function effectiveCompat(
  provider: ProviderConfig | undefined,
  id: string,
  catalogCompat?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged = { ...catalogCompat, ...provider?.compat, ...provider?.modelProfiles?.[id]?.compat }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function hasConfiguredEfforts(provider: ProviderConfig | undefined, id: string): boolean {
  return Boolean(provider?.modelProfiles?.[id]
    && Object.prototype.hasOwnProperty.call(provider.modelProfiles[id], 'reasoningEfforts'))
}

/** Official, exact-id profile. Its profile id versions this protocol assertion. */
export const MIMO_THINKING_PROFILES = Object.freeze([{
  profileId: 'xiaomi-mimo-openai-completions-thinking-toggle-v1',
  api: 'openai-completions',
  modelIds: ['mimo-v2.5', 'mimo-v2.5-pro'],
  sourceUrl: 'https://mimo.mi.com/docs/zh-CN/api/chat/openai-api',
}] as const)

/** Apply only a versioned exact-model profile or a user's explicit mimo dialect. */
export function applyMimoThinkingProfile(provider: ProviderConfig, report: ProbeReport): void {
  if ((provider.api ?? '').toLowerCase() !== 'openai-completions') return
  for (const id of provider.models ?? []) {
    const model = report.models.find((item) => item.id === id)
    const explicit = effectiveCompat(provider, id)
    if (explicit?.thinkingFormat !== undefined && explicit.thinkingFormat !== 'mimo') continue
    const official = MIMO_THINKING_PROFILES.find((profile) => profile.api === provider.api?.toLowerCase()
      && profile.modelIds.includes(id.toLowerCase() as typeof profile.modelIds[number]))
    if (explicit?.thinkingFormat !== 'mimo' && !official) continue
    const source = explicit?.thinkingFormat === 'mimo' ? 'user profile' : official?.profileId
    const target = model ?? { id, sources: {} }
    const configured = provider.modelProfiles?.[id]
    const hasConfiguredValue = configured !== undefined && Object.prototype.hasOwnProperty.call(configured, 'reasoningEfforts')
    const configuredEfforts = configured && hasConfiguredValue
      ? configured.reasoningEfforts : undefined
    const explicitlyDisabled = hasConfiguredValue && configuredEfforts === false
    const preserveUserMap = (configuredEfforts && typeof configuredEfforts === 'object' && !Array.isArray(configuredEfforts))
      ? configuredEfforts as ReasoningEfforts
      : model?.sources.reasoningEfforts === 'user-fallback' ? model.reasoningEfforts : undefined
    if (explicitlyDisabled) {
      delete target.reasoningEfforts
      delete target.sources.reasoningEfforts
    } else if (preserveUserMap) {
      // The old saved map remains visible in the report/settings. The pinned DSH
      // overlay presents it as a binary mode and PiAi serializes only the toggle.
      target.reasoningEfforts = preserveUserMap
      target.sources.reasoningEfforts = 'user-fallback'
    } else {
      target.reasoningEfforts = { off: 'off', low: 'low' }
      target.sources.reasoningEfforts = 'protocol-profile'
    }
    const compat = { ...target.compat }
    for (const [key, value] of Object.entries(explicit ?? {})) {
      if (compat[key] === undefined) compat[key] = value
    }
    // An official exact-id profile outranks passive/catalog descriptions. Explicit
    // user compat above remains intact because conflicting user thinkingFormat exits.
    if (explicit?.thinkingFormat === undefined) compat.thinkingFormat = 'mimo'
    if (explicit?.supportsReasoningEffort === undefined) compat.supportsReasoningEffort = false
    if (explicit?.requiresReasoningContentOnAssistantMessages === undefined) compat.requiresReasoningContentOnAssistantMessages = true
    target.compat = compat
    if (!report.models.includes(target)) report.models.push(target)
    report.notes.push(`${id}: 使用 ${source} MiMo 二态思考 profile（off/low 映射为关闭/开启；不会发送 reasoning_effort）`)
  }
  report.models.sort((a, b) => a.id.localeCompare(b.id))
  report.unknown = (provider.models ?? []).filter((id) => {
    const model = report.models.find((item) => item.id === id)
    return !model || Object.keys(model.sources).length === 0
  })
}

/** Add an explicitly authorized active result without replacing declared/discovered levels. */
export async function runConfirmedActiveProbe(
  provider: ProviderConfig,
  report: ProbeReport,
  options: {
    active?: boolean
    confirm?: boolean
    offline?: boolean
    source?: 'auto' | 'endpoint' | 'catalog' | 'modelsdev' | 'offline'
    levels?: string[]
    fetchImpl?: FetchLike
  },
): Promise<void> {
  if (!options.active) return
  if (options.confirm !== true) {
    report.notes.push('主动 reasoning probe 未执行：必须同时设置 active=true 与 confirm=true')
    return
  }
  if (options.offline === true || options.source === 'offline' || options.source === 'catalog' || options.source === 'modelsdev') {
    report.notes.push('主动 reasoning probe 未执行：当前请求为离线或非端点网络模式')
    return
  }
  const api = (provider.api ?? '').toLowerCase()
  const isResponses = api === 'openai-responses'
  const isCompletions = api === 'openai-completions'
  if (!isResponses && !isCompletions) {
    report.notes.push(`主动 reasoning probe 未执行：API 方言「${provider.api ?? 'unknown'}」没有已验证的主动请求序列化，能力保持未知`)
    return
  }
  const levels = options.levels?.length ? options.levels : ['low', 'medium', 'high']
  for (const id of provider.models ?? []) {
    const model = report.models.find((item) => item.id === id)
    const compat = effectiveCompat(provider, id, model?.compat)
    if (isCompletions && compat?.thinkingFormat === 'mimo') {
      report.notes.push(`${id}: MiMo thinking.type 是二态开关，主动 reasoning_effort probe 未执行`)
      continue
    }
    if (isCompletions && (compat?.thinkingFormat !== 'openai' || compat.supportsReasoningEffort !== true)) {
      report.notes.push(`${id}: 主动 reasoning probe 未执行：Completions 缺少明确的 thinkingFormat=openai + supportsReasoningEffort=true 序列化声明`)
      continue
    }
    if (hasConfiguredEfforts(provider, id)) {
      report.notes.push(`${id}: 已存在用户声明的 reasoningEfforts，主动探测跳过并保留原值`)
      continue
    }
    if (model?.reasoningEfforts) {
      report.notes.push(`${id}: 已有来源声明 reasoningEfforts，主动探测跳过并保留原值`)
      continue
    }
    const result = isResponses
      ? await probeResponsesReasoningEfforts(provider, id, levels, { fetchImpl: options.fetchImpl })
      : await probeOpenAICompletionsReasoningEfforts(provider, id, compat, levels, { fetchImpl: options.fetchImpl })
    const negative = result.negativeControl
    if (negative?.reason) report.notes.push(`${id}: reasoning effort 负控未能证明服务端校验字段（${negative.reason}），候选接受结果不写入`)
    else if (negative) report.notes.push(`${id}: reasoning effort 负控被服务端拒绝（HTTP ${negative.status}），继续核验指定档位`)
    if (result.accepted.length > 0) {
      const { efforts } = effortsFrom(result.accepted)
      if (efforts) {
        const target = model ?? { id, sources: {} }
        target.reasoningEfforts = efforts
        target.sources.reasoningEfforts = 'active-probe'
        if (!report.models.includes(target)) report.models.push(target)
      }
    }
    report.notes.push(`${id}: 主动 reasoning probe accepted=${result.accepted.join('/') || 'none'} rejected=${result.rejected.map((item) => item.level).join('/') || 'none'} inconclusive=${result.inconclusive.map((item) => item.level).join('/') || 'none'}`)
  }
  report.unknown = (provider.models ?? []).filter((id) => {
    const model = report.models.find((item) => item.id === id)
    return !model || Object.keys(model.sources).length === 0
  })
}

/**
 * Injects models.dev (S3) capabilities into a probe report and recomputes unknowns.
 *
 * Runs before {@link mergeCatalog} (S4): models.dev is the upstream encyclopedia and
 * the engine catalog is the offline floor, so the encyclopedia wins the fields it
 * states. A lookup returns every provider that describes the id, and the fields they
 * disagree on are recorded as conflicts and left unwritten (same rule as S4).
 * @param report - report to enrich in place.
 * @param snapshot - retained models.dev snapshot, or undefined when absent.
 * @returns the same report.
 */
export function mergeModelsDevInto(
  report: ProbeReport,
  declared: string[],
  snapshot: ModelsDevSnapshot | undefined,
  /** Filled with levels that must wait for a wire dialect (see applyDeferredModelsDevLevels). */
  deferred?: Map<string, ReasoningEfforts>,
  provider?: ProviderConfig,
): ProbeReport {
  if (!snapshot) return report
  const byId = new Map(report.models.map((model) => [model.id, model]))
  for (const id of declared) {
    if (!byId.has(id)) {
      const fresh: ModelCapabilities = { id, sources: {} }
      byId.set(id, fresh)
      report.models.push(fresh)
    }
  }
  for (const model of byId.values()) {
    const hits = lookupModelsDev(snapshot, model.id)
    if (hits.length === 0) continue
    const agreed = mergeModelsDevEntries(hits)
    report.notes.push(`${model.id}: models.dev 命中 ${agreed.providers.join('/')}`)
    for (const conflict of agreed.conflicts) report.notes.push(`${model.id}: ${conflict}`)
    if (agreed.input && !model.input) {
      model.input = agreed.input
      model.sources.input = 'models-dev'
    }
    if (agreed.contextWindow && !model.contextWindow) {
      model.contextWindow = agreed.contextWindow
      model.sources.contextWindow = 'models-dev'
    }
    if (agreed.maxTokens && !model.maxTokens) {
      model.maxTokens = agreed.maxTokens
      model.sources.maxTokens = 'models-dev'
    }
    // models.dev supplies names, not endpoint-specific meaning. Responses can
    // encode one declared on-level safely; several levels stay unknown because
    // some Responses providers document them as enable-only.
    const levels = effortsFromLevels(agreed.thinkingLevels)
    if (levels && !model.reasoningEfforts && !hasConfiguredEfforts(provider, model.id)) {
      const api = provider?.api ?? model.api
      const compat = effectiveCompat(provider, model.id, model.compat)
      if (canApplyReasoningEfforts(api, compat)) {
        model.reasoningEfforts = normalizeReasoningEfforts(api, compat, levels, 'models-dev')
        if (model.reasoningEfforts) model.sources.reasoningEfforts = 'models-dev'
        else report.notes.push(`${model.id}: models.dev 档位无法证明 Responses 各等级语义不同，保持推理能力未知`)
      } else {
        // 方言还没到（models.dev 不声明 wire 方言，S4 目录可能稍后给出）。先挂起，
        // 由 applyDeferredModelsDevLevels 在 S4 之后决定写或跳过——方言门本身不动。
        deferred?.set(model.id, levels)
      }
    }
  }
  report.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  report.unknown = declared.filter((id) => {
    const found = byId.get(id)
    return !found || Object.keys(found.sources).length === 0
  })
  return report
}

/**
 * Injects user-declared fallback values (S5) into a probe report.
 *
 * S5 exists ONLY when the user explicitly configured `fallbacks`; there is no factory
 * default. Applying a constant to every model regardless of what it is would be
 * inventing a fact — a 262144 context window written onto an 8k model reads to the user
 * as capacity the gateway then refuses. So an unconfigured fallback leaves the
 * capability absent, and a configured one is tagged `user-fallback` to keep it
 * distinguishable from a declaration by endpoints, encyclopedias, or catalogs.
 * @param report - report to enrich in place.
 * @param fallbacks - user-declared values, or undefined when none were configured.
 * @param configured - true when the user actually supplied a `fallbacks` block.
 * @returns the same report.
 */
export function mergeFallbacks(
  report: ProbeReport,
  declared: string[],
  fallbacks: { contextWindow?: number; maxTokens?: number; input?: Modality[]; reasoningEfforts?: ReasoningEfforts } | undefined,
  configured: boolean,
  provider?: ProviderConfig,
): ProbeReport {
  if (!configured || !fallbacks) return report
  // 先确保每个 declared 模型都有条目：models.dev 关闭/无缓存时它不会建条目（提前返回），
  // 而「用户配了兜底值」恰恰最需要在这种情况下生效——否则 S5 会在最该用的场景哑掉。
  const byId = new Map(report.models.map((model) => [model.id, model]))
  for (const id of declared) {
    if (!byId.has(id)) {
      const fresh: ModelCapabilities = { id, sources: {} }
      byId.set(id, fresh)
      report.models.push(fresh)
    }
  }
  report.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  for (const model of report.models) {
    for (const key of ['input', 'contextWindow', 'maxTokens', 'reasoningEfforts'] as const) {
      const value = fallbacks[key]
      if (value === undefined) continue
      if (key === 'reasoningEfforts' && hasConfiguredEfforts(provider, model.id)) continue
      if (model[key] !== undefined) continue
      if (Object.prototype.hasOwnProperty.call(model.sources, key)) continue
      ;(model as unknown as Record<string, unknown>)[key] = value
      model.sources[key] = 'user-fallback'
    }
  }
  report.unknown = declared.filter((id) => {
    const found = report.models.find((m) => m.id === id)
    return !found || Object.keys(found.sources).length === 0
  })
  return report
}

/**
 * Writes levels that models.dev reported but could not yet write, now that the
 * engine catalog (S4) may have supplied the wire dialect.
 *
 * Deferred levels are applied only after the route/model API and serializer compat
 * are known. Responses accepts a serializer mapping but unverified multi-level
 * lists remain unknown because some gateways expose enable-only reasoning.
 * @param report - report to update in place.
 * @param deferred - levels parked by {@link mergeModelsDev}.
 * @returns the same report.
 */
export function applyDeferredModelsDevLevels(
  report: ProbeReport,
  deferred: Map<string, ReasoningEfforts>,
  provider?: ProviderConfig,
): ProbeReport {
  if (deferred.size === 0) return report
  for (const model of report.models) {
    const levels = deferred.get(model.id)
    if (!levels || model.reasoningEfforts || hasConfiguredEfforts(provider, model.id)) continue
    const api = provider?.api ?? model.api
    const compat = effectiveCompat(provider, model.id, model.compat)
    if (canApplyReasoningEfforts(api, compat)) {
      model.reasoningEfforts = normalizeReasoningEfforts(api, compat, levels, 'models-dev')
      if (model.reasoningEfforts) {
        model.sources.reasoningEfforts = 'models-dev'
        continue
      }
      report.notes.push(`${model.id}: models.dev 档位无法证明 Responses 各等级语义不同，保持推理能力未知`)
      continue
    }
    report.notes.push(
      `${model.id}: models.dev 列出推理档位（${Object.keys(levels).join('/')}）但未给出 wire 方言`
      + '——跳过 reasoningEfforts 写入，避免按错误方言发送导致请求被拒',
    )
  }
  return report
}

/** Injects catalog-derived capabilities into a probe report and recomputes unknowns. */export function mergeCatalog(
  report: ProbeReport,
  declared: string[],
  snapshot: CatalogSnapshot | undefined,
  api: string | undefined,
  provider?: ProviderConfig,
): ProbeReport {
  const byId = new Map<string, ModelCapabilities>(report.models.map((model) => [model.id, model]))
  for (const id of declared) {
    if (!byId.has(id)) {
      const fresh: ModelCapabilities = { id, sources: {} }
      byId.set(id, fresh)
      report.models.push(fresh)
    }
  }
  for (const model of byId.values()) {
    const match = lookupCatalog(snapshot, model.id, api)
    if (match.providers.length > 0) report.notes.push(`${model.id}: 引擎目录命中 ${match.providers.join('/')}`)
    for (const conflict of match.conflicts) report.notes.push(`${model.id}: ${conflict}`)
    const capabilities = match.capabilities
    if (capabilities.api) model.api = capabilities.api
    const explicitCompat = effectiveCompat(provider, model.id)
    const resolvedCompatForGate = effectiveCompat(provider, model.id, capabilities.compat)
    const explicitToggleDialect = resolvedCompatForGate?.thinkingFormat === 'mimo'
    const catalogDialect = pickDialect(capabilities.compat)
    if (catalogDialect) {
      const missing: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(catalogDialect)) {
        // A toggle serializer has no effort parameter, even when another catalog
        // row for the same id claims that one is accepted.
        if (explicitToggleDialect && key === 'supportsReasoningEffort') continue
        if (explicitCompat?.[key] === undefined && model.compat?.[key] === undefined) missing[key] = value
      }
      if (Object.keys(missing).length > 0) model.compat = { ...model.compat, ...missing }
    }
    if (capabilities.reasoningEfforts && !model.reasoningEfforts && !hasConfiguredEfforts(provider, model.id)) {
      const effectiveApi = provider?.api ?? capabilities.api
      const resolvedCompat = effectiveCompat(provider, model.id, capabilities.compat)
      if (canApplyReasoningEfforts(effectiveApi, resolvedCompat)) {
        model.reasoningEfforts = normalizeReasoningEfforts(
          effectiveApi, resolvedCompat, capabilities.reasoningEfforts, 'engine-catalog',
        )
        if (model.reasoningEfforts) model.sources.reasoningEfforts = 'engine-catalog'
      } else {
        report.notes.push(
          `${model.id}: API=${effectiveApi ?? 'unknown'} 的推理序列化信息不足`
          + '——跳过 reasoningEfforts 写入；Completions 请显式声明 compat.thinkingFormat',
        )
      }
    }
    if (capabilities.input && !model.input) {
      model.input = capabilities.input
      model.sources.input = 'engine-catalog'
    }
    if (capabilities.contextWindow && !model.contextWindow) {
      model.contextWindow = capabilities.contextWindow
      model.sources.contextWindow = 'engine-catalog'
    }
    if (capabilities.maxTokens && !model.maxTokens) {
      model.maxTokens = capabilities.maxTokens
      model.sources.maxTokens = 'engine-catalog'
    }
  }
  report.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  report.unknown = declared.filter((id) => {
    const found = byId.get(id)
    return !found || Object.keys(found.sources).length === 0
  })
  return report
}

function summarize(report: ProbeReport): string {
  const lines = [`提供商路由 ${report.route}：抓取 ${report.fetched.length} 个端点，识别 ${report.models.length} 个模型`]
  for (const model of report.models) {
    const parts: string[] = []
    if (model.input) parts.push('模态 ' + model.input.join('/'))
    if (model.contextWindow) parts.push('上下文 ' + model.contextWindow)
    if (model.maxTokens) parts.push('输出上限 ' + model.maxTokens)
    if (model.reasoningEfforts) {
      if (model.sources.reasoningEfforts === 'protocol-profile' && model.compat?.thinkingFormat === 'mimo') {
        parts.push('思考开关 关闭/开启')
      } else {
        parts.push('推理等级 ' + Object.keys(model.reasoningEfforts).join('/'))
      }
    }
    const sources = Object.entries(model.sources).map(([key, source]) => `${key}<-${source}`).join(' ')
    lines.push(`- ${model.id}: ${parts.length > 0 ? parts.join('，') : '未声明任何能力'}${sources ? ' [' + sources + ']' : ''}`)
  }
  if (report.unknown.length > 0) {
    lines.push(`未获得能力元数据：${report.unknown.map((id) => `${id}（S1-S5 均无声明）`).join(', ')}`)
  }
  for (const note of report.notes) lines.push('注：' + note)
  return lines.join('\n')
}

/** Turns a report into field-level patches, keeping each field's provenance. */
export function patchesFrom(report: ProbeReport): ModelPatch[] {
  const patches: ModelPatch[] = []
  for (const model of report.models) {
    const patch: ModelPatch = { id: model.id }
    let any = false
    if (model.reasoningEfforts) { patch.reasoningEfforts = model.reasoningEfforts; any = true }
    if (model.compat) { patch.compat = model.compat; any = true }
    if (model.input) { patch.input = model.input; any = true }
    if (model.contextWindow) { patch.contextWindow = model.contextWindow; any = true }
    if (model.maxTokens) { patch.maxTokens = model.maxTokens; any = true }
    if (any) {
      const sources = Object.values(model.sources)
      patch.source = [...new Set(sources)].join('+')
      patches.push(patch)
    }
  }
  return patches
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const c = ctx as unknown as CtxLike
  const settings = c.settings
  const diagnosticConfigs = new Map<string, ProviderConfig>()
  const safeDiagnostic = (message: string): string => {
    for (const provider of diagnosticConfigs.values()) message = providerDiagnostic(message, provider)
    return message
  }
  const diag = (message: string): void => writeDiagnostic(safeDiagnostic(message))
  const rawLog = c.logger?.('dsh-model-capability')
  const log = rawLog === undefined ? undefined : {
    info: (message: string) => rawLog.info?.(safeDiagnostic(message)),
    warn: (message: string) => rawLog.warn?.(safeDiagnostic(message)),
    debug: (message: string) => rawLog.debug?.(safeDiagnostic(message)),
  }
  // diag() 落在 $DSH_HOME/model-capability.log：引擎 stdout 轮转太快，写回被拒的真因只有这里留得住。
  const logWithTrace = log === undefined ? undefined : { ...log, trace: diag }
  const snapshot = loadCatalogSnapshot()
  if (snapshot) log?.info?.(`catalog snapshot: ${snapshot.source} / ${String(snapshot.modelCount ?? 0)} models`)
  else log?.info?.('catalog snapshot absent — engine-catalog stage disabled')

  /**
   * 引擎自带目录声明的网关 id 集合，即「内置 provider」。
   *
   * 与上游 llm-pi-ai 的判据同源：那边用 `catalog.has(provider)` 决定一条路由是内置还是
   * 用户自建（`declared: !catalog.has(provider)`，见 llm-pi-ai/src/index.ts:139）。
   * 本插件的快照正是从同一份 pi-ai 目录数据生成的，因此这里按 provider 字段重建同一集合。
   */
  const builtInProviders = new Set<string>()
  for (const entries of Object.values(snapshot?.models ?? {})) {
    for (const entry of entries) {
      if (typeof entry.provider === 'string') builtInProviders.add(entry.provider)
    }
  }

  /**
   * 该路由是否是**非内置** provider —— A1 的适用范围。
   *
   * 内置 provider 的模型能力由引擎目录自己声明，补写只会与上游打架；快照缺席时无法
   * 区分二者，一律返回 false：宁可少补，也不能把能力写进内置 provider 的模型里。
   * @param route - settings 里的 provider 路由名。
   * @returns 需要本插件补能力时为 true。
   */
  const isNonBuiltInRoute = (route: string): boolean => builtInProviders.size > 0 && !builtInProviders.has(route)

  /**
   * models.dev cache state, held per apply() call.
   *
   * The snapshot is loaded ONCE here, synchronously, from the local cache file. Network
   * work happens in exactly two places, neither of which is the tick's synchronous path:
   *   1. {@link refreshModelsDevOnStartup} — one background refresh per process start, fired
   *      from the auto-apply effect before the first pass, so a clean install has S3 data
   *      without anyone calling a tool;
   *   2. an explicit tool call, which may also force a refetch.
   * A network fetch on the tick path is exactly the regression T1 removed (24-26% resident
   * CPU), so tick only ever reads this in-memory snapshot.
   */
  const modelsDevPath = modelsDevCachePath()
  let modelsDevSnapshot: ModelsDevSnapshot | undefined = readModelsDevSnapshot(modelsDevPath)
  let modelsDevFetched = false
  /** Startup-refresh latch: at most one attempt per process, success or failure. */
  let startupRefreshStarted = false

  /**
   * One-line cache state for diagnostics; the 2026-09-26 field report could only infer
   * "S3 never ran" from a missing file, so this makes the state directly readable.
   * @returns disabled | no-cache | stale | fresh.
   */
  const modelsDevStatus = (): string => {
    if (config.modelsDev === false) return 'disabled'
    if (!modelsDevSnapshot) return 'no-cache'
    return isStale(modelsDevSnapshot.generatedAt) ? 'stale' : 'fresh'
  }
  /**
   * Fetches models.dev and persists it when it fits the budget.
   *
   * Failure is never fatal: a fetch error keeps the previous snapshot, and with no
   * snapshot at all the source is simply absent (S1/S2/S4 carry on unchanged). This
   * runs only from an explicit call path (tool, or the one-time startup warm-up),
   * never from tick.
   * @param force - refetch even when the cached snapshot is fresh.
   * @returns the snapshot in use, or undefined when the source is absent.
   */
  const ensureModelsDev = async (
    force = false,
    /**
     * When false the call is a pure cache read: it never performs I/O. The tick path
     * passes false so the automatic pass can use S3 without any network work on its
     * synchronous path (the T1 regression was exactly that).
     */
    allowNetwork = true,
  ): Promise<ModelsDevSnapshot | undefined> => {
    if (config.modelsDev === false) return undefined
    if (!allowNetwork) return modelsDevSnapshot
    if (!force && modelsDevSnapshot && !isStale(modelsDevSnapshot.generatedAt)) return modelsDevSnapshot
    if (modelsDevFetched && !force) return modelsDevSnapshot
    const fetchImpl = globalThis.fetch as unknown as FetchLike | undefined
    if (typeof fetchImpl !== 'function') return modelsDevSnapshot
    try {
      const response = await fetchImpl(MODELS_DEV_URL, { headers: { accept: 'application/json' }, method: 'GET', signal: AbortSignal.timeout(30_000), redirect: 'error' })
      if (!response.ok) {
        diag(`models.dev fetch -> HTTP ${String(response.status)}；沿用旧缓存（${modelsDevSnapshot ? '有' : '无'}）`)
        return modelsDevSnapshot
      }
      const entries = parseModelsDev(JSON.parse(await boundedResponseText(response)))
      const next = buildModelsDevSnapshot(entries)
      const bytes = writeModelsDevSnapshot(modelsDevPath, next)
      if (bytes === undefined) {
        diag(`models.dev 快照超过尺寸上限（${String(next.modelCount)} 条），不落盘；本进程仍用内存副本`)
      }
      modelsDevSnapshot = next
      modelsDevFetched = true
      diag(`models.dev 拉取成功 modelCount=${String(next.modelCount)} bytes=${String(bytes ?? -1)}`)
      return next
    } catch (error) {
      diag(`models.dev 拉取失败（${(error as Error)?.message ?? String(error)}）；沿用旧缓存（${modelsDevSnapshot ? '有' : '无'}）`)
      return modelsDevSnapshot
    }
  }

  /** Result of a startup refresh attempt, for the caller's diagnostics. */
  const refreshModelsDevOnStartup = async (): Promise<'disabled' | 'fresh' | 'fetched' | 'failed' | 'no-fetch'> => {
    if (config.modelsDev === false) return 'disabled'
    if (startupRefreshStarted) return modelsDevSnapshot ? 'fresh' : 'no-fetch'
    startupRefreshStarted = true
    // 只在「陈旧或无缓存」时拉：新鲜缓存不该在每次启动都产生流量。
    if (modelsDevSnapshot && !isStale(modelsDevSnapshot.generatedAt)) {
      diag('models.dev 启动刷新：缓存新鲜，跳过')
      return 'fresh'
    }
    diag(`models.dev 启动刷新：${modelsDevSnapshot ? '缓存陈旧' : '无缓存'}，开始拉取`)
    const result = await ensureModelsDev(true, true)
    if (result === undefined) return 'failed'
    return modelsDevFetched ? 'fetched' : 'failed'
  }

  // modelsDev 状态只有在 modelsDevPath/modelsDevStatus 声明之后才可读；放在这里而不是
  // 函数开头，是因为启动那一行 diag 要报告缓存状态（这次现场就是靠「缓存文件不存在」反推的）。
  diag(`apply(): settings=${settings ? 'yes' : 'no'} catalog=${snapshot ? `${snapshot.source} models=${String(snapshot.modelCount ?? 0)}` : 'absent'} autoApply=${String(config.autoApply)} modelsDev=${modelsDevStatus()} cache=${modelsDevPath}`)

  /** Resolves the route's API key: explicit settings value first, then the credential ref. */
  async function resolveConfig(route: string, sectionOverride?: unknown) {
    const config = providerFromSettings(settings, route, sectionOverride)
    if (!config) return undefined
    const credentials = optionalService<CredentialsLike>(ctx, 'credentials')
    if (!config.apiKey && config.apiKeyEnv && credentials) {
      try {
        const resolved = await credentials.resolve(config.apiKeyEnv)
        if (resolved?.value) config.apiKey = resolved.value
      } catch {
        // 凭据不可读不阻断被动探测（有些端点 /models 免鉴权）
      }
    }
    diagnosticConfigs.set(route, config)
    return config
  }

  async function discover(
    route: string,
    options: {
      active?: boolean
      confirm?: boolean
      levels?: string[]
      offline?: boolean
      /** Force a models.dev refetch before resolving. */
      refresh?: boolean
      /** Stage selector; 'auto' (default) walks the whole ladder. */
      source?: 'auto' | 'endpoint' | 'catalog' | 'modelsdev' | 'offline'
      /**
       * Consult S3 from the cached snapshot while still skipping every network call.
       * The automatic pass sets this so it can use models.dev without doing I/O on
       * the tick path; the public `offline` flag keeps its "engine catalog only"
       * meaning, so tool behavior is unchanged.
       */
      useCachedModelsDev?: boolean
      /** When false, S3 is read from cache only and never fetched. */
      allowModelsDevNetwork?: boolean
    } = {},
    sectionOverride?: unknown,
  ) {
    const providerConfig = await resolveConfig(route, sectionOverride)
    if (!providerConfig) {
      diag(`discover(${route}): providerFromSettings 返回 undefined（路由或 baseURL 不在 llm-pi-ai 里）`)
      return undefined
    }
    diag(`discover(${route}): baseURL=${providerConfig.baseURL} api=${providerConfig.api ?? '-'} models=${JSON.stringify(providerConfig.models ?? [])} apiKey=${providerConfig.apiKey ? 'yes' : 'no'}`)
    const fetchImpl = globalThis.fetch as unknown as FetchLike
    // 来源梯选择：'offline' 与 'catalog' 都只走离线地板；'modelsdev' 只走 S3；
    // 'endpoint' 只走 S1/S2；'auto'（默认）按 S1->S2 -> S3 -> S4 -> S5 全走。
    const source = options.source ?? 'auto'
    const skipNetwork = options.offline === true || source === 'offline' || source === 'catalog' || source === 'modelsdev'
    const report = skipNetwork
      ? { route, fetched: [], models: [], unknown: [...(providerConfig.models ?? [])], notes: [] } as ProbeReport
      : await probePassive(providerConfig, { fetchImpl })
    const deferred = new Map<string, ReasoningEfforts>()
    // 自动补给路径（useCachedModelsDev）只读缓存，绝不发网络请求；显式工具调用才允许拉取。
    const wantModelsDev = source === 'modelsdev' || (source === 'auto' && (options.useCachedModelsDev === true || options.offline !== true))
    if (wantModelsDev) {
      const allowNetwork = options.allowModelsDevNetwork !== false
      const dev = await ensureModelsDev(options.refresh === true, allowNetwork)
      mergeModelsDevInto(report, providerConfig.models ?? [], dev, deferred, providerConfig)
    }
    if (source !== 'endpoint' && source !== 'modelsdev') {
      mergeCatalog(report, providerConfig.models ?? [], snapshot, providerConfig.api, providerConfig)
      applyDeferredModelsDevLevels(report, deferred, providerConfig)
    }
    mergeFallbacks(report, providerConfig.models ?? [], config.fallbacks, config.fallbacks !== undefined, providerConfig)
    applyMimoThinkingProfile(providerConfig, report)
    await runConfirmedActiveProbe(providerConfig, report, {
      ...options,
      offline: skipNetwork,
      fetchImpl,
    })
    return { providerConfig, report }
  }

  const probeTool = defineTool({
    name: 'model_capability_probe',
    description:
      'Discover capabilities for a user-declared route in source order: endpoint descriptor, vendor schema, models.dev, engine catalog. ' +
      'Never infer from URL/name; unknown stays unknown. ' +
      'Active probes are billable, require active=true and confirm=true, and use supported Responses or explicitly configured standard OpenAI Completions with a rejecting negative control. MiMo toggles are not effort probes. ' +
      'apply=true fills missing fields only.',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id, e.g. "my-gateway"' },
      active: { type: 'boolean', description: 'Run billable probes (default false)' },
      confirm: { type: 'boolean', description: 'Required with active=true' },
      levels: { type: 'array', items: { type: 'string' }, description: 'Candidate levels (default low/medium/high)' },
      apply: { type: 'boolean', description: 'Write discovered capabilities back to settings (missing fields only)' },
      offline: { type: 'boolean', description: 'Skip network entirely and use only the engine catalog (default false)' },
      source: { type: 'string', description: 'Source stage (default auto)' },
      refresh: { type: 'boolean', description: 'Force models.dev refetch' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          report: { type: 'object', additionalProperties: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; levels?: string[]; apply?: boolean; offline?: boolean; source?: 'auto' | 'endpoint' | 'catalog' | 'modelsdev' | 'offline'; refresh?: boolean }) => {
      const found = await discover(args.provider, args)
      if (!found) {
        return { ok: false, text: `未在 llm-pi-ai 设置中找到提供商路由「${args.provider}」或其 baseURL——请先在设置页填写自定义提供商。`, report: {} } as never
      }
      const { report } = found
      let applied: Record<string, unknown> | undefined
      if (args.apply) {
        const result = await applyModelPatch(settings, args.provider, patchesFrom(report), logWithTrace)
        applied = result as unknown as Record<string, unknown>
        report.notes.push(result.wrote
          ? `已写回 ${result.changes.length} 项：${result.changes.join('；')}`
          : `未写回（${result.reason}）${result.changes.length > 0 ? '：' + result.changes.join('；') : ''}`)
      }
      return { ok: true, text: summarize(report), report, applied } as never
    },
  })

  const applyTool = defineTool({
    name: 'model_capability_apply',
    description:
      'Discover and fill missing model-level capabilities for a declared route; preserve user values. ' +
      'Active probes are billable, require active=true and confirm=true, and use supported Responses or explicitly configured standard OpenAI Completions with a rejecting negative control. MiMo and offline mode never send effort probes.',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id' },
      active: { type: 'boolean', description: 'Run billable probes (default false)' },
      confirm: { type: 'boolean', description: 'Required with active=true' },
      offline: { type: 'boolean', description: 'Use only the engine catalog (default true for apply)' },
      source: { type: 'string', description: 'Source stage (default auto)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; offline?: boolean; source?: 'auto' | 'endpoint' | 'catalog' | 'modelsdev' | 'offline' }) => {
      const found = await discover(args.provider, { ...args, offline: args.offline ?? true, source: args.source ?? 'offline' })
      if (!found) {
        return { ok: false, text: `未找到提供商路由「${args.provider}」。` } as never
      }
      const result = await applyModelPatch(settings, args.provider, patchesFrom(found.report), logWithTrace)
      const lines = [summarize(found.report)]
      lines.push(result.wrote
        ? `已写回：${result.changes.join('；')}`
        : `未写回（${result.reason}）`)
      if (result.skipped.length > 0) lines.push(`跳过：${result.skipped.join('；')}`)
      return { ok: true, text: lines.join('\n'), applied: result as unknown as Record<string, unknown> } as never
    },
  })

  ctx.tools.register(probeTool)
  ctx.tools.register(applyTool)
  log?.info?.('model_capability_probe / model_capability_apply registered')

  /**
   * 手动补齐入口（A6）：用户已经在用的模型（在 A7 之前由启动轮/轮询补过、之后不再自动补）
   * 需要一个显式触发点。
   *
   * 为什么是页面 + 受鉴权路由而不是新工具：A6 要求「复用现有设置区域，尽量不新增显眼独立
   * 按钮」，且能力补齐是设置页动作、不是模型可见能力（用户裁定 7：仅用户平面）。
   * 因此挂在既有的「开发者选项」dsh-dev-row 里，走 `/api/android/model-capability/fill`。
   *
   * 鉴权：与 linux-env 的 runtime-cache 同一道门（authorizeMobileRoute：connection 的
   * Host/Origin/browser-session 优先，缺 connection 时回环 Host + 壳侧实时 controlToken），
   * 并登记进 scripts/api-route-auth-policy.json（缺登记 -> check-api-route-auth.mjs 判红）。
   *
   * 与自动路径的差别：手动路径补该路由下**所有**缺失字段的模型（用户明确要求「把我现在
   * 这些模型补齐」），但仍遵守字段级与不覆盖用户值；模型必须已在 settings 里声明
   * （planModelPatch 不会凭空创建条目）。
   */
  // 可选依赖：用 ctx.inject 声明**可选**服务，而不是在 apply() 里裸读。
  //
  // 为什么不能用 optionalService(ctx,'webServer')（2026-10-11 设备实锤）：cordis 的
  // ctx.get(name) 默认 strict=true，只返回**已激活**（fiber.state===2）的实现；而装配顺序是
  // 「我们的插件行早于 webserver 行」（scripts/profile-web.cordis.patch.yml:94-96
  // vs dsh-web-app/cordis.patch.yml:150），故 apply() 执行那一刻 webServer 尚未提供，
  // ctx.get 恒为 undefined -> 路由永不注册。真机 5/5 次引擎启动命中
  // 「webServer 缺席：手动补齐路由未注册」，A6 在 web 上完全不可用。
  // ctx.inject([...], cb) 是 cordis 惯用法：依赖（含后到的）可用后回调才跑；依赖永不到达
  // （headless「mounts no Host, HTTP server」）则回调不跑，也不报错。它**不写进静态 inject
  // 数组**，因此不会把 apply() 挡掉（上一轮 headless 问题的解法保留）。
  const registerManualFill = (webServer: { register(registration: unknown): () => void }): void => {
    if (!settings) return
    const authOptions = () => ({
      token: shellControlToken,
      connection: optionalService<ConnectionRouteAuth>(ctx, 'connection'),
    })
    const sendJson = (res: MobileRouteResponse, code: number, payload: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: MANUAL_FILL_ROUTE,
      handler: async (req: MobileRouteRequest, res: MobileRouteResponse) => {
        const rejection = authorizeMobileRoute(req, authOptions())
        if (rejection !== undefined) {
          sendMobileRouteRejection(res, rejection)
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        // 手动路径同样绝不联网：只读引擎目录 + 本地 models.dev 缓存。
        const section = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
        const providers = (section?.value as { providers?: Record<string, unknown> } | undefined)?.providers ?? {}
        const routes = (config.routes ?? Object.keys(providers)).filter((route) => isNonBuiltInRoute(route))
        const filled: Array<{ route: string; wrote: boolean; reason: string; changes: string[] }> = []
        for (const route of routes) {
          try {
            const found = await discover(route, { offline: true, useCachedModelsDev: true, allowModelsDevNetwork: false }, section?.value)
            if (!found) continue
            const result = await applyModelPatch(settings, route, patchesFrom(found.report), logWithTrace)
            filled.push({ route, wrote: result.wrote, reason: safeDiagnostic(result.reason), changes: result.changes.map(safeDiagnostic) })
            diag('manual fill ' + route + ': wrote=' + String(result.wrote) + ' reason=' + result.reason + ' changes=' + JSON.stringify(result.changes))
          } catch (error) {
            filled.push({ route, wrote: false, reason: safeDiagnostic((error as Error)?.message ?? String(error)), changes: [] })
            diag('manual fill ' + route + ' failed: ' + ((error as Error)?.message ?? String(error)))
          }
        }
        sendJson(res, 200, {
          ok: true,
          routes: filled.length,
          wrote: filled.filter((item) => item.wrote).length,
          details: filled,
        })
      },
    }))
    log?.info?.('manual capability fill route registered: ' + MANUAL_FILL_ROUTE)
  }
  // 可选依赖：webServer 后到也一定会触发（web）；永不提供则回调不跑（headless）。
  ctx.inject(['webServer'], (c) => {
    const svc = optionalService<{ register(registration: unknown): () => void }>(c, 'webServer')
    if (svc) registerManualFill(svc)
    else diag('webServer 解析为空：手动补齐路由未注册（A6 入口不可用）')
  })

  // 补给只在**保存**时发生（A1/A7，2026-10-11）：唯一触发器是上游在设置写入后
  // emit 的 settings/document-updated，没有任何定时器（既无启动轮，也无兜底轮询）。
  //
  // 历史与代价（T1 常驻 CPU，2026-09-25；设备实证 2026-10-10）：旧实现先有「每 5 秒
  // 全量 describe 取签名」，后改为「启动延迟一轮 + 120s 兜底轮询」。后者在真实设备上
  // 留下每 120 秒一条 tick 日志、连续数日（$DSH_HOME/model-capability.log 实测 380KB），
  // 而该设备当时 runAutoPass: routes=[] —— 零价值工作却常驻五年。
  // 真因是 describe 本身就贵：settings 服务没有「只读自有命名空间」的轻量路径，每次
  // describe 都走 configEditor.configuration() → 对全 profile 每个 entry 重做 inherited()
  // + structuredClone（单次实测 300-1500ms）。所以「调大间隔」只是摊薄，不是消除；
  // 用户口径要的是「不做定时扫描」，只有事件路径能满足。
  //
  // 为什么事件够用：上游 SettingsForms.write 每次用户保存都会 describe() 一次，而
  // describe 在 raw 段变化时 emit settings/document-updated(ns, revision)
  // （dsh-settings/src/index.ts:316-318、:337）。即**每一次保存必然产生该事件**。
  // 事件只带 (ns, revision) 不带值，所以回调里仍要读一次描述符——这一次读是必要的，
  // 且每次真实保存只发生一次。
  //
  // 收窄：事件不带「这次保存了哪些模型」，故用「上一轮描述符 vs 本轮描述符」按
  // (route, modelId) 值敏感签名做 diff（signature.ts 的 modelSignatureParts），
  // 只对本次新增或改动的模型做发现与写回。路由级键（baseURL/apiKey 等）的变化
  // 不改模型集合，因此不触发任何模型补齐——那正是用户的意图，不是遗漏。
  // 事件的**数据面**（为什么事件够用、以及与 settings.watch 的关系）见下方
  // subscribeSettingsEvents 的注释。
  if (config.autoApply !== false && settings) {
    /** 本 tick 内共享的描述符：避免同一 tick 对 llm-pi-ai 重复 describe。 */
    let tickSection: unknown
    /** 事件已触发但本轮尚未消费时置真：tick 看到它即跑一轮，保证「先到的事件不丢」。 */
    let eventPending = false
    /** effect 是否已停止（deferrer 的回调在事务外跑，需自行判断存活）。 */
    const stoppedRef = { value: false }
    /**
     * 上一轮读到的每个路由下已声明模型的签名（route -> 模型签名的有序列表）。
     *
     * 首读只建立它、不写任何东西；之后每次保存都拿它与当轮比较，得出「这次保存新增或改动
     * 了哪些模型」。未建立时（例如首次读取失败）一律不写——没有基线就无法区分
     * 「这次新加的模型」与「用户早就在用的模型」，后者不该被自动改写。
     */
    let baselineModels: Map<string, string> | undefined
    /** 仅首读建立基线；此后恒为 false（全插件没有任何定时重读）。 */
    let needsBaselineRead = true

    /**
     * 读一次 llm-pi-ai 描述符，并在**本 tick 内**复用给签名 / providerFromSettings /
     * applyModelPatch。旧实现在同一 tick 里 describe 2-3 次，每次都付一次全量
     * configuration() + structuredClone（单次 300-1500ms），这是 T1 成本的主要来源。
     * @returns 描述符，读失败时 undefined（调用方按「无路由」处理）。
     */
    const readDescriptor = () => {
      if (tickSection === undefined) {
        try {
          tickSection = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
        } catch {
          tickSection = null
        }
      }
      return tickSection === null ? undefined : tickSection as { ns: string; value: unknown; revision: number } | undefined
    }

    const routesInSection = (): string[] => {
      // describe(options) 的 options 被实现忽略 → 必须按 ns 查找（不能用 [0]）
      const section = readDescriptor()?.value as { providers?: Record<string, unknown> } | undefined
      return config.routes ?? Object.keys(section?.providers ?? {})
    }

    const routeValueOf = (route: string): unknown => {
      const section = readDescriptor()?.value as { providers?: Record<string, unknown> } | undefined
      return section?.providers?.[route]
    }

    /** 一个路由下已声明模型的签名（与 capabilitySignature 同源口径）。 */
    const modelsOf = (route: string): ModelSignaturePart[] => modelSignatureParts(routeValueOf(route))

    /**
     * 把当轮描述符录成「上一轮基线」：只记录、不写回。
     * @param routes - 需要记录的路由。
     * @returns 新的基线。
     */
    const snapshotBaseline = (routes: readonly string[]): Map<string, string> => {
      const next = new Map<string, string>()
      for (const route of routes) {
        for (const part of modelsOf(route)) next.set(route + '\u0000' + part.signature, part.id)
      }
      return next
    }

    /**
     * 对比基线与当轮，算出**这次保存**新增或改动的模型。
     *
     * 口径与自触发签名一致（都走 modelSignatureParts）：模型条目任一声明字段变化即算改动，
     * 而路由级键（apiKey / baseURL 等）不参与，因此「只换 key 或只改 baseURL 而模型集合
     * 未变」不会触发任何补齐——那是用户的意图，不是遗漏。
     * @param previous - 上一轮基线；undefined 表示还没有基线（首读，不做任何写回）。
     * @param routes - 当轮要考察的路由。
     * @returns 本次新增或改动模型的 route->条目 映射，以及被删除模型的诊断串。
     */
    const diffAgainstBaseline = (previous: Map<string, string> | undefined, routes: readonly string[]) => {
      const added = new Map<string, ModelSignaturePart[]>()
      const removed: string[] = []
      if (!previous) return { added, removed }
      for (const route of routes) {
        const now = modelsOf(route)
        const fresh: ModelSignaturePart[] = []
        for (const part of now) {
          if (!previous.has(route + '\u0000' + part.signature)) fresh.push(part)
        }
        if (fresh.length > 0) added.set(route, fresh)
        // 模型被删掉同样意味着「模型集合变了」，但删模型不需要补齐，只记诊断。
        const nowKeys = new Set(now.map((part) => route + '\u0000' + part.signature))
        for (const key of previous.keys()) {
          if (key.startsWith(route + '\u0000') && !nowKeys.has(key)) removed.push(key.slice(route.length + 1).replace('\u0000', ' '))
        }
      }
      return { added, removed }
    }

    /** 来源戳：记录「该字段现在的值是我方写下的」，使新发现的值可刷新我方旧写入（用户手写值无戳）。 */
    const stamps = createStampStore()

    // settings.describe performs full profile/schema projection even with a namespace
    // hint. Cached catalog parsing and the final fresh signature must run in separate
    // event-loop turns so an offline pass cannot combine their synchronous cost.
    const yieldAutoPass = () => new Promise<void>((resolve) => setImmediate(resolve))

    /**
     * 对「本次保存新增或改动的模型」做一次能力发现与写回。
     *
     * 只在 [savedIds] 里的模型上写回：未勾选的模型、以及用户早就配好在用的模型都不动
     * （A1/A3/A5）。这是与旧实现的根本差别——旧实现每个 route 一律把该 route 下**全部**
     * 模型重跑一遍补齐，用户改一个无关字段也会连带触碰所有模型。
     *
     * 非内置 provider 之外的路由不处理：内置 provider 的目录由引擎自己声明，
     * 我们补写只会与上游打架。
     * @param savedIds - 本次保存新增或改动的「route -> 模型 id 集合」。
     * @returns 无。
     */
    const runAutoPass = async (savedIds: Map<string, Set<string>>) => {
      const routes = [...savedIds.keys()].filter((route) => isNonBuiltInRoute(route))
      diag(`runAutoPass: routes=${JSON.stringify(routes)}`)
      if (routes.length === 0) return
      // 每个 route 各取一次描述符快照：任一 route 写成功后 settings revision 就会推进，
      // 之前取到的 override 便不再是「刚读到的、没被任何人改过」，因此重取而非靠重试兜底。
      let wroteThisPass = false
      for (const route of routes) {
        await yieldAutoPass()
        if (stoppedRef.value) return
        try {
          if (wroteThisPass) {
            tickSection = undefined
            readDescriptor()
          }
          const tickValue = readDescriptor()?.value
          // offline + useCachedModelsDev：绝不联网；allowModelsDevNetwork=false 保证
          // 补给路径零网络（T1 回归判据，见 t1-poll-cost.test.mjs）。
          const found = await discover(route, { offline: true, useCachedModelsDev: true, allowModelsDevNetwork: false }, tickValue)
          if (!found) continue
          // 只保留本次保存涉及的模型：discover 会把该 route 下所有声明模型都探一遍。
          const wanted = savedIds.get(route) ?? new Set<string>()
          const applicable = found.report.models.filter((model) => wanted.has(model.id))
          if (applicable.length === 0) continue
          diag(`runAutoPass(${route}): models=${applicable.length} efforts=${JSON.stringify(applicable.map((m) => [m.id, m.reasoningEfforts ?? null]))}`)
          // 写回全部缺失字段（不只是 reasoningEfforts）：S3/S5 的价值就是补长尾的
          // contextWindow/maxTokens/input，只放 reasoningEfforts 会让这两个源形同虚设。
          // 用户已有的值不会被动：planModelPatch 只填空，来源戳进一步保护我方旧写入。
          const patches = patchesFrom({ ...found.report, models: applicable })
          diag(`runAutoPass(${route}): patches=${patches.length}`)
          if (patches.length === 0) continue
          const descriptor = readDescriptor()
          const result = await applyModelPatch(settings, route, patches, logWithTrace, stamps, descriptor)
          if (result.wrote) wroteThisPass = true
          diag(`runAutoPass(${route}): wrote=${result.wrote} reason=${result.reason} changes=${JSON.stringify(result.changes)}`)
          if (result.wrote) log?.info?.(`auto-apply ${route}: ${result.changes.join('；')}`)
        } catch (error) {
          diag(`runAutoPass(${route}) failed: ${(error as Error)?.message ?? String(error)}`)
          log?.warn?.(`auto-apply ${route} failed: ${(error as Error)?.message ?? String(error)}`)
        }
      }
    }

    /** 事件与首读共用一个在跑标志：跑动期间到达的保存只置 rerun，由本轮结束后补跑。 */
    let ticking = false
    let rerun = false

    /**
     * 一次补给。唯一的**写**触发源是保存事件；无事件时这里最多只做一次只读基线。
     * @param fromEvent - 本轮是否由 settings/document-updated 触发。
     */
    const tick = async (fromEvent: boolean) => {
      if (ticking) {
        if (fromEvent) eventPending = true
        rerun = true
        return
      }
      ticking = true
      try {
        do {
          rerun = false
          tickSection = undefined
          const isSave = fromEvent || eventPending
          eventPending = false
          const routes = routesInSection()
          if (needsBaselineRead) {
            if (routes.length === 0) {
              // describe 还没就绪或此刻确实没有任何路由：这次读不构成有效基线。
              // 保持 needsBaselineRead 为真，留待下一次保存重建——宁可少补一次，
              // 也不能拿空基线当「全是新模型」，那会把用户早就配好的模型全量改写。
              diag('tick: baseline read saw no routes; will rebuild on the next save')
              break
            }
            needsBaselineRead = false
            baselineModels = snapshotBaseline(routes)
            diag(`tick: baseline recorded routes=${routes.length} models=${baselineModels.size}`)
            // 首次读到基线时，本轮拿到的是**保存之后**的状态，无从判断这次保存改了什么。
            // 因此本轮一律不写（A7）；真正「加模型 → 档位出现」由下一次保存完成。
            if (isSave) diag('tick: first baseline read, no write this round')
            break
          }
          const previous = baselineModels
          const { added, removed } = diffAgainstBaseline(previous, routes)
          if (removed.length > 0) diag(`tick: models removed=${JSON.stringify(removed)}`)
          if (!isSave || added.size === 0) {
            // 无新增/改动即无事可做：仍要刷新基线（值可能变了但不在我们的关注字段上）。
            baselineModels = snapshotBaseline(routes)
            diag('tick: save observed, nothing to fill (no new or changed models)')
            break
          }
          const saved = [...added].map(([route, parts]) => [route, new Set(parts.map((part) => part.id))] as const)
          diag(`tick: save observed, added=${JSON.stringify(saved.map(([route, ids]) => [route, [...ids]]))}`)
          // 先记录本次保存后的基线再写回：写回自身也会推进 revision 并发事件，
          // 先记录才能让那个事件 diff 出 0 个模型、从而收敛（不自旋）。
          baselineModels = snapshotBaseline(routes)
          await runAutoPass(new Map(saved))
          await yieldAutoPass()
          if (stoppedRef.value) return
          tickSection = undefined
          baselineModels = snapshotBaseline(routes)
          if (eventPending) rerun = true
          fromEvent = true
        } while (rerun)
      } finally {
        ticking = false
      }
    }

    /**
     * 把回调送出当前异步上下文（X1 修复，2026-09-25）。
     *
     * 为什么必须送出：hmr 用 `AsyncLocalStorage` 标记「事务执行中」
     * （dsh-hmr/src/index.ts:130 `executing`，:140 嵌套即抛
     * `HMR transactions cannot be nested`）。`settings/document-updated` 是在**用户那次
     * 写事务之内**同步 emit 的（出货 settings 的 write → configEditor.edit → hmr.runExclusive），
     * 所以事件回调里再调 `settings.mutate` → `configEditor.edit` → 又一次 `runExclusive` 就被拒。
     *
     * 关键：**在事务内新调度的普通调度器会继承该上下文**——setTimeout / setImmediate /
     * queueMicrotask / process.nextTick / Promise.then 全部继承（离线实测，
     * `.deploy-tmp/fix-b1/als-escape.mjs`）。只有**在事务外预建**的 async 资源不会继承：
     * 预建 MessageChannel 的 onmessage 落在干净上下文（`.deploy-tmp/fix-b1/als3.mjs`，ESCAPED）。
     * 因此这里在 effect 装配时（彼时不在任何事务内）预建通道，事件到来时只 postMessage。
     * @returns 送出函数与释放函数。
     */
    const createDeferrer = () => {
      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel()
        // 队列而不是单槽：同一轮里可能同步 defer 多次（例如启动刷新 + 一个 document-updated
        // 事件），单槽会让后一次覆盖前一次，静默丢掉一个回调。
        const queue: Array<() => void> = []
        channel.port1.onmessage = () => {
          const run = queue.shift()
          run?.()
        }
        // 不让诊断通道拖住进程退出（Android 上尤其重要）
        ;(channel.port1 as unknown as { unref?: () => void }).unref?.()
        ;(channel.port2 as unknown as { unref?: () => void }).unref?.()
        return {
          defer: (fn: () => void) => { queue.push(fn); channel.port2.postMessage(0) },
          dispose: () => { queue.length = 0; channel.port1.close(); channel.port2.close() },
        }
      }
      // 兜底：预建 promise 链（continuation 在事务外注册，同样不继承上下文）
      // 判据同 als3.mjs 的 premade-gate：第二跳仍为 ESCAPED。
      let wake: (() => void) | undefined
      let closed = false
      const queue: Array<() => void> = []
      const arm = (): Promise<void> => new Promise<void>((resolve) => { wake = resolve })
      let gate = arm()
      void (async () => {
        for (;;) {
          await gate
          if (closed) return
          gate = arm()
          // 一次唤醒清空当前队列（与 MessageChannel 版同语义：不丢回调）。
          while (queue.length > 0) queue.shift()?.()
        }
      })()
      return {
        defer: (fn: () => void) => { queue.push(fn); wake?.() },
        dispose: () => { closed = true; queue.length = 0; wake?.() },
      }
    }

    /**
     * 订阅「设置文档变化」事件作为主触发器。
     *
     * 依据（出货 0.14.1 `dsh-settings/lib/index.js:515-547`）：该服务在**raw 段**变化时
     * bumpRevision → emitDocumentUpdated('settings/document-updated', ns, revision)，
     * 经共享的 `ctx.events` 总线 emit 派发；同一总线对所有插件可见（cordis Context
     * 只在 root 构造一个 EventsService，见 vendor/cordis/src/context.ts:80）。
     * 因此本插件不需要 `settings.watch`（那是「自有命名空间」的接口，见
     * `register()` 返回的 scope.watch；llm-pi-ai 归 llm-pi-ai 插件所有，我们不是它的 owner），
     * 也不需要轮询：事件本身就是「用户改了配置」的权威信号。
     *
     * 事件只带 (ns, revision)，不带值——所以回调里仍然要读一次描述符。这次读是**必要的**
     * 而不是浪费：没有它无从知道新值；而它每「一次真实用户修改」只发生一次，
     * 不再是「每 5 秒一次」。
     * @param deferrer - 把 tick 送出当前 HMR 事务的通道（见 createDeferrer）。
     */
    const subscribeSettingsEvents = (deferrer: { defer: (fn: () => void) => void }) => {
      const on = (ctx as unknown as {
        on?: (name: string, listener: (...args: unknown[]) => void) => () => void
      }).on
      if (typeof on !== 'function') {
        diag('settings/document-updated 不可订阅（ctx.on 缺席）→ 退化为轮询兜底')
        return undefined
      }
      try {
        return on.call(ctx, 'settings/document-updated', (...args: unknown[]) => {
          const ns = String(args[0] ?? '')
          if (ns !== 'llm-pi-ai') return
          diag(`settings/document-updated ns=${ns} rev=${String(args[1])}`)
          // 落一个「有变化待消费」标记：tick 在跑则它会在本轮结束后补跑，
          // 没在跑则这次调用直接跑。两种情况下事件都不会被丢掉。
          eventPending = true
          // 必须经 deferrer 送出事务上下文，否则 tick 内的 settings.mutate 会被 hmr 拒绝（X1）。
          deferrer.defer(() => { if (!stoppedRef.value) void tick(true) })

        })
      } catch (error) {
        diag(`settings/document-updated 订阅失败（${(error as Error)?.message ?? String(error)}）→ 退化为轮询兜底`)
        return undefined
      }
    }

    c.effect?.(() => {
      let stopped = false
      stoppedRef.value = false
      diag('auto-apply effect armed')
      // deferrer 必须在**事务外**预建：它的 async 资源不能带上 hmr 的事务上下文，
      // 否则事件回调里触发的写回仍会被 hmr 判为嵌套（见 createDeferrer）。
      const deferrer = createDeferrer()
      // 全插件**没有任何定时器**（A7）：不排 setTimeout / setInterval，因此不会有一个
      // 常驻 tick、也不会每分钟写一行日志。写入只由下面这个保存事件触发。
      const unsubscribe = subscribeSettingsEvents(deferrer)
      diag(`event-driven=${String(unsubscribe !== undefined)} modelsDev=${modelsDevStatus()}`)
      // 【P2-S3 启动后台刷新（2026-09-26）】方案 §2.2 的降级链是「无缓存 -> 拉；有缓存且未陈旧 ->
      // 不拉；陈旧 -> 后台拉」。此前只实现了「显式调工具才拉」，于是干净安装上没人调工具 =>
      // 缓存永远不存在 => S3 永不自动生效（设备实测：models-dev.json 不存在、日志 0 命中）。
      // 这里补上缺失的一环：每个进程启动最多一次后台刷新。
      // 纪律：经 deferrer 送出（与 tick 同一条逃逸通道，避开 hmr 事务上下文）；
      //      仅陈旧/无缓存才真的拉；失败只记 diag、不阻断、不重试；
      //      拉完写缓存，由既有的补给路径自然消费（补给路径仍 0 网络）。
      // 这是**一次性**动作，不是轮询：发起处不排任何定时器。
      deferrer.defer(() => {
        if (stopped) return
        void refreshModelsDevOnStartup().then((outcome) => {
          diag(`models.dev 启动刷新结果=${outcome} 状态=${modelsDevStatus()}`)
        })
      })
      // 首读基线：只读一次描述符、只记录当轮模型集合，绝不写回（A7）。
      // 没有这一步，之后每次保存都无从判断「哪些模型是这次才加的」，只能全量重跑。
      // 经 deferrer 送出（启动期 profile 重载等也可能落在别人的 hmr 事务里）。
      // 刻意**不等**：等待需要定时器，而本插件的纪律是零定时器。设置服务此刻还没就绪
      // 也无妨——tick 读到空路由时不登记基线（needsBaselineRead 保持为真），
      // 下一次保存会自然把它补上，不需要任何重试或延迟。
      deferrer.defer(() => { if (!stopped) void tick(false) })
      return () => {
        stopped = true
        stoppedRef.value = true
        unsubscribe?.()
        deferrer.dispose()
      }
    })
  } else {
    diag(`auto-apply 未启用（autoApply=${String(config.autoApply)} settings=${settings ? 'yes' : 'no'}）`)
  }
}
