/**
 * models.dev encyclopedia source (S3 of the capability ladder).
 *
 * models.dev is a cross-vendor encyclopedia keyed by provider, so it covers the
 * long tail an exact model-id lookup in the engine's shipped pi-ai catalogs (S4)
 * cannot: a custom gateway routinely serves models the engine has never heard of.
 * That is a capability gap, not a style preference — hence a real source.
 *
 * It is an UPSTREAM encyclopedia and stays additive: S3 sits before S4, and when
 * both describe an id the values are reconciled field by field (see
 * @link mergeModelsDev). Disagreement is recorded as a conflict and that field is
 * NOT written, matching the engine-catalog arbitration: a fact no source states
 * stays absent rather than becoming a coin flip.
 *
 * Field paths were measured against a real fetch on 2026-09-26 (E-P2-1), not copied
 * from another implementation:
 *   provider map: { <providerId>: { id, name, models: { <modelId>: <entry> } } }
 *   entry.id, entry.name
 *   entry.limit.context -> contextWindow        (present on 8181/8181 models)
 *   entry.limit.output  -> maxTokens            (present on 8181/8181)
 *   entry.modalities.input[] -> input           (present on 8181/8181)
 *   entry.reasoning_options[] -> thinkingLevels (present on 4796/8181)
 *
 * The `values` array exists only on the `effort` variant; four distinct entry
 * shapes were observed (type only / type+values / type+min+max / type+min), so a
 * bare `type: 'toggle'` or `budget_tokens` entry names no level at all. Only the
 * `effort` variant names levels, and only words in the engine vocabulary are kept.
 *
 * Size discipline: only the fields above are retained (every other models.dev field
 * is dropped) and the snapshot is measured before it is written, because the file
 * lives in DSH_HOME on a phone.
 *
 * @module dsh-model-capability/models-dev
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { THINKING_LEVELS, type Modality, type ReasoningEfforts } from './capability-probe.js'

/** The encyclopedia endpoint. One request, no request body, no credential. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Entries older than this are refreshed in the background; 7 days, as upstream churns slowly. */
export const MODELS_DEV_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Refuse to retain a snapshot above this size; the file lives on a phone. */
export const MODELS_DEV_MAX_BYTES = 8 * 1024 * 1024

/** One model as this module retains it; every other models.dev field is discarded. */
export interface ModelsDevEntry {
  id: string
  name?: string
  provider: string
  contextWindow?: number
  maxTokens?: number
  input?: Modality[]
  /**
   * Ordered, de-duplicated levels the encyclopedia says the model offers. Same
   * meaning as the engine catalog's thinking level map: which levels exist, NOT
   * how to spell them on the wire (that is the dialect's job).
   */
  thinkingLevels?: string[]
}

export interface ModelsDevSnapshot {
  schema: 1
  source: string
  generatedAt: string
  modelCount: number
  models: ModelsDevEntry[]
}

const KNOWN_MODALITIES: Modality[] = ['text', 'image', 'audio', 'pdf']

/** models.dev modality spellings that map onto the engine vocabulary. */
const MODALITY_ALIASES: Record<string, Modality> = {
  text: 'text',
  input_text: 'text',
  image: 'image',
  input_image: 'image',
  vision: 'image',
  audio: 'audio',
  input_audio: 'audio',
  pdf: 'pdf',
  file: 'pdf',
  document: 'pdf',
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function modalitiesFrom(value: unknown): Modality[] | undefined {
  const mapped: Modality[] = []
  for (const item of asArray(value)) {
    const modality = MODALITY_ALIASES[String(item).toLowerCase()]
    if (modality !== undefined) mapped.push(modality)
  }
  const unique = KNOWN_MODALITIES.filter((modality) => mapped.includes(modality))
  return unique.length > 0 ? unique : undefined
}

/**
 * Levels an entry names, in engine order.
 *
 * Only the `effort` reasoning-option variant carries `values`; `toggle` and
 * `budget_tokens` name no level. Words outside the engine vocabulary are dropped
 * rather than mapped onto a level the encyclopedia did not name.
 * @param reasoningOptions - the entry's raw `reasoning_options` array.
 * @returns levels in THINKING_LEVELS order, or undefined when none were named.
 */
export function thinkingLevelsFrom(reasoningOptions: unknown): string[] | undefined {
  const named = new Set<string>()
  for (const option of asArray(reasoningOptions)) {
    const record = asRecord(option)
    if (record.type !== 'effort') continue
    for (const value of asArray(record.values)) {
      const level = String(value).toLowerCase()
      if ((THINKING_LEVELS as readonly string[]).includes(level)) named.add(level)
    }
  }
  const ordered = (THINKING_LEVELS as readonly string[]).filter((level) => named.has(level))
  return ordered.length > 0 ? ordered : undefined
}

/**
 * Parses a models.dev payload into retained entries.
 *
 * Tolerates the provider-map shape actually returned by the endpoint; anything
 * else yields an empty list (the source is then simply absent).
 * @param data - parsed JSON body.
 * @returns one entry per (provider, model), dropping every unretained field.
 */
export function parseModelsDev(data: unknown): ModelsDevEntry[] {
  const root = asRecord(data)
  const out: ModelsDevEntry[] = []
  for (const [providerId, providerValue] of Object.entries(root)) {
    const provider = asRecord(providerValue)
    const models = asRecord(provider.models)
    for (const [modelId, modelValue] of Object.entries(models)) {
      const model = asRecord(modelValue)
      const id = asNonEmptyString(model.id) ?? modelId
      if (id === '') continue
      const limit = asRecord(model.limit)
      const entry: ModelsDevEntry = {
        id,
        provider: asNonEmptyString(provider.id) ?? providerId,
      }
      const name = asNonEmptyString(model.name)
      if (name !== undefined) entry.name = name
      const contextWindow = asPositiveNumber(limit.context)
      if (contextWindow !== undefined) entry.contextWindow = contextWindow
      const maxTokens = asPositiveNumber(limit.output)
      if (maxTokens !== undefined) entry.maxTokens = maxTokens
      const input = modalitiesFrom(asRecord(model.modalities).input)
      if (input !== undefined) entry.input = input
      const thinkingLevels = thinkingLevelsFrom(model.reasoning_options)
      if (thinkingLevels !== undefined) entry.thinkingLevels = thinkingLevels
      out.push(entry)
    }
  }
  return out
}

/** Builds the retained snapshot; the caller decides whether it may be persisted. */
export function buildModelsDevSnapshot(entries: ModelsDevEntry[], now: number = Date.now()): ModelsDevSnapshot {
  return {
    schema: 1,
    source: 'models.dev',
    generatedAt: new Date(now).toISOString(),
    modelCount: entries.length,
    models: entries,
  }
}

/**
 * Whether a snapshot is older than the TTL.
 * @param generatedAt - ISO timestamp the snapshot was built at.
 * @param now - epoch milliseconds to compare against.
 * @returns true when the snapshot is stale or its timestamp is unparseable.
 */
export function isStale(generatedAt: string, now: number = Date.now()): boolean {
  const stamp = Date.parse(generatedAt)
  if (!Number.isFinite(stamp)) return true
  return now - stamp >= MODELS_DEV_TTL_MS
}

/** Strips a leading provider slash segment (zai-org/GLM-5.2-Fast -> GLM-5.2-Fast). */
function withoutProviderPrefix(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(slash + 1) : id
}

/** Last slash- or colon-delimited segment (XiaomiMiMo/MiMo-V2.6-Pro -> MiMo-V2.6-Pro). */
function trailingSegment(id: string): string {
  const at = Math.max(id.lastIndexOf('/'), id.lastIndexOf(':'))
  return at >= 0 && at < id.length - 1 ? id.slice(at + 1) : id
}

/**
 * Looks one id up: exact -> without a provider prefix -> trailing segment.
 *
 * models.dev also lists several providers for the same model id, so a lookup
 * returns every matching entry; the caller reconciles them.
 * @param snapshot - retained snapshot, or undefined when the source is absent.
 * @param id - the configured model id.
 * @returns matching entries (empty when the model is not described).
 */
export function lookupModelsDev(snapshot: ModelsDevSnapshot | undefined, id: string): ModelsDevEntry[] {
  if (!snapshot?.models || id === '') return []
  const target = id.toLowerCase()
  // 1) 精确；2) 去掉前置 provider 段后再精确。
  for (const candidate of [target, withoutProviderPrefix(target)]) {
    const hits = snapshot.models.filter((entry) => entry.id.toLowerCase() === candidate)
    if (hits.length > 0) return hits
  }
  // 3) 用末段反查：两侧都取末段再比，否则库里的 XiaomiMiMo/MiMo-V2.6-Pro
  //    永远匹配不上用户写的 MiMo-V2.6-Pro（前者整串不等于后者）。
  // 注意：查询本身常常没有斜杠（MiMo-V2.6-Pro），此时 target 就是自己的末段。
  // 不能再加 tail !== target 这类「去重」判断——那会把本步整个跳过，
  // 而库里的条目恰恰是带前缀的（XiaomiMiMo/MiMo-V2.6-Pro），末段比较才有意义。
  const tail = trailingSegment(target)
  if (tail !== '') {
    const hits = snapshot.models.filter((entry) => trailingSegment(entry.id.toLowerCase()) === tail)
    if (hits.length > 0) return hits
  }
  return []
}

/** Fields every declaring entry agreed on, plus one note per disagreed field. */
export interface ModelsDevAgreement {
  providers: string[]
  contextWindow?: number
  maxTokens?: number
  input?: Modality[]
  thinkingLevels?: string[]
  conflicts: string[]
}

/**
 * Reconciles every encyclopedia description of one id, field by field.
 *
 * models.dev routinely describes the same id under several providers with
 * different limits (measured: tencent/Hy3 carries 262144/128000 under one provider
 * and 262144/262144 under another), so a field is reported only when every
 * declaring entry agrees — the same rule the engine catalog already uses.
 * @param hits - entries returned by lookupModelsDev.
 * @returns agreed fields, their provider ids, and one conflict note per disagreed field.
 */
export function mergeModelsDev(hits: ModelsDevEntry[]): ModelsDevAgreement {
  const providers = hits.map((entry) => entry.provider)
  const conflicts: string[] = []
  const unanimous = <T>(values: Array<T | undefined>, label: string): T | undefined => {
    const declared = values.filter((value): value is T => value !== undefined)
    if (declared.length === 0) return undefined
    const distinct = new Set(declared.map((value) => JSON.stringify(value)))
    if (distinct.size > 1) {
      conflicts.push(label + ': models.dev 声明不一致（' + [...distinct].join(' vs ') + '）')
      return undefined
    }
    return declared[0]
  }
  const out: ModelsDevAgreement = { providers, conflicts }
  const contextWindow = unanimous(hits.map((entry) => entry.contextWindow), 'contextWindow')
  if (contextWindow !== undefined) out.contextWindow = contextWindow
  const maxTokens = unanimous(hits.map((entry) => entry.maxTokens), 'maxTokens')
  if (maxTokens !== undefined) out.maxTokens = maxTokens
  const input = unanimous(hits.map((entry) => entry.input), 'input')
  if (input !== undefined) out.input = input
  const thinkingLevels = unanimous(hits.map((entry) => entry.thinkingLevels), 'thinkingLevels')
  if (thinkingLevels !== undefined) out.thinkingLevels = thinkingLevels
  return out
}

/**
 * Turns reported levels into the engine's effort map.
 *
 * Only level NAMES are known here, so each is spelled as itself — the same
 * conservative rule the passive descriptor path uses.
 * @param levels - levels the source reported.
 * @returns the effort map, or undefined when nothing usable was reported.
 */
export function effortsFromLevels(levels: string[] | undefined): ReasoningEfforts | undefined {
  if (!levels || levels.length === 0) return undefined
  const efforts: ReasoningEfforts = {}
  for (const level of levels) {
    if ((THINKING_LEVELS as readonly string[]).includes(level)) {
      efforts[level as keyof ReasoningEfforts] = level
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * Resolves the cache path under DSH_HOME, matching the convention diag() uses so a
 * user migrating from the third-party plugin is read by this one unchanged.
 * @param home - DSH_HOME override; defaults to the environment.
 * @returns absolute cache file path.
 */
export function modelsDevCachePath(home: string | undefined = process.env.DSH_HOME): string {
  const base = home ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
  return base.replace(/\/+$/, '') + '/models-dev.json'
}

/** Reads the retained snapshot; a missing or unreadable file is an absent source. */
export function readModelsDevSnapshot(path: string): ModelsDevSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ModelsDevSnapshot
    return Array.isArray(parsed?.models) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Persists the snapshot when it fits the size budget.
 * @param path - cache file path.
 * @param snapshot - snapshot to write.
 * @returns bytes written, or undefined when the snapshot exceeds the budget.
 */
export function writeModelsDevSnapshot(path: string, snapshot: ModelsDevSnapshot): number | undefined {
  const text = JSON.stringify(snapshot)
  const bytes = Buffer.byteLength(text)
  if (bytes > MODELS_DEV_MAX_BYTES) return undefined
  writeFileSync(path, text)
  return bytes
}
