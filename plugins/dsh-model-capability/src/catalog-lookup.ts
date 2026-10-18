/**
 * Engine-catalog capability source (0.13.5 W3, issue #125).
 *
 * The engine ships pi-ai's vendor catalogs (`dist/providers/data/*.json`). Those
 * files are a *vendor declaration* of what each model offers — `thinkingLevelMap`,
 * `input`, context limits, `compat` — so an exact model-id lookup is reading a
 * declaration, not inferring from a name. That is the only honest source for a
 * hand-declared route whose endpoint reports no capability metadata at all
 * (measured 2026-09-10: a generic OpenAI-compatible `/models` returns ids only,
 * and the gateway accepts any `reasoning_effort` value, so acceptance proves
 * nothing).
 *
 * Agreement rule: several catalogs may describe the same model id (different
 * gateways for the same upstream model). A field is reported only when every
 * declaring entry agrees; disagreement is reported as a conflict and never
 * applied. `reasoningEfforts` is derived from `thinkingLevelMap` by keeping the
 * levels whose wire value is a non-empty string (pi-ai semantics: `null` means
 * the level is not offered by that route).
 */
import { DIALECT_COMPAT_KEYS, THINKING_LEVELS, type Modality, type ReasoningEfforts } from './capability-probe.js'

export interface CatalogEntry {
  provider: string
  api?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  compat?: Record<string, unknown>
}

export interface CatalogSnapshot {
  schema?: number
  source?: string
  generatedAt?: string
  modelCount?: number
  models: Record<string, CatalogEntry[]>
}

export interface CatalogCapabilities {
  /** Only set when every matching catalog row names the same protocol. */
  api?: string
  reasoningEfforts?: ReasoningEfforts
  input?: Modality[]
  contextWindow?: number
  maxTokens?: number
  compat?: Record<string, unknown>
}

export interface CatalogMatch {
  id: string
  /** Provider ids whose catalog declares the matched model id. */
  providers: string[]
  /** Fields every declaring entry agrees on. */
  capabilities: CatalogCapabilities
  /** Human-readable disagreement notes; an empty list means unanimous. */
  conflicts: string[]
  /**
   * How [id] reached its entries. `not-found` and `ambiguous` both deliver no
   * capabilities, and are distinct so a caller can report why.
   */
  resolution: CatalogResolution
  /**
   * Folded-tier candidates when {@link CatalogResolution} is `ambiguous`: the
   * catalog keys that collided, sorted. Empty otherwise.
   */
  ambiguousIds: string[]
}

/**
 * How a model id resolved to catalog entries.
 *
 * The tiers are ordered and stop at the first that yields candidates: an exact
 * id is never normalized, because folding an id that is already an exact key can
 * only turn a decidable lookup into an ambiguous one.
 */
export type CatalogResolution =
  /** L1: the id is a catalog key verbatim. */
  | 'exact'
  /** L2: exactly one catalog key equals the id case-insensitively. */
  | 'case-folded'
  /** L3: exactly one catalog key equals the id after folding case and separators. */
  | 'separator-folded'
  /** L4: the id names no catalog key. */
  | 'not-found'
  /** L2/L3 found more than one candidate, so no entry is privileged. */
  | 'ambiguous'

const KNOWN_MODALITIES: Modality[] = ['text', 'image', 'audio', 'pdf']

/** L3 normalization: case folded, then `- _ . / ` and spaces removed. */
function foldSeparators(id: string): string {
  return id.toLowerCase().replace(/[-_.\/\s]+/g, '')
}

function toModality(value: unknown): Modality | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.toLowerCase()
  if (text === 'text' || text === 'input_text') return 'text'
  if (text === 'image' || text === 'input_image' || text === 'vision') return 'image'
  if (text === 'audio' || text === 'input_audio') return 'audio'
  if (text === 'pdf' || text === 'file' || text === 'document') return 'pdf'
  return undefined
}

function modalitiesOf(entry: CatalogEntry): Modality[] | undefined {
  if (!Array.isArray(entry.input)) return undefined
  const mapped = entry.input.map(toModality).filter((m): m is Modality => m !== undefined)
  const unique = KNOWN_MODALITIES.filter((m) => mapped.includes(m))
  return unique.length > 0 ? unique : undefined
}

/**
 * Levels a catalog entry offers, taken from `thinkingLevelMap`.
 *
 * pi-ai semantics: a `null` (or absent) mapping means the route does not offer
 * that level, so only levels with a non-empty wire value are kept — and the wire
 * value is preserved verbatim (it need not equal the level name, e.g. `max: "ultra"`).
 */
export function effortsOf(entry: CatalogEntry): ReasoningEfforts | undefined {
  const map = entry.thinkingLevelMap
  if (!map || typeof map !== 'object') return undefined
  const efforts: ReasoningEfforts = {}
  for (const [level, wire] of Object.entries(map)) {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) continue
    if (typeof wire === 'string' && wire.length > 0) efforts[level as keyof ReasoningEfforts] = wire
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

function keyOf(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * Resolve one model id to the catalog key(s) that describe it, in four ordered
 * tiers that stop at the first with candidates.
 *
 * L1 is a verbatim key lookup, so the overwhelming majority of ids resolve
 * without normalization. L2 folds case and L3 additionally folds the separators
 * vendors disagree about (`-`, `_`, `.`, `/`, space); each is used only when it
 * leaves **exactly one** candidate. More than one is ambiguity, not a tie to
 * break: the folded keys here carry genuinely different capabilities (measured
 * 2026-10-11: 37 of the 1046 shipped keys collide on case alone), and a wrong
 * reasoning level or modality is written into the user's configuration where
 * nothing surfaces it. Folding separators adds further collisions on top, which
 * the same rule discards.
 *
 * `Object.hasOwn` rather than a plain index: model ids are user-controlled
 * strings, and a bare `models[id]` returns inherited `Object.prototype`
 * members for ids like `constructor` (measured: a `TypeError` from calling
 * `.filter` on a function). Such an id names no catalog entry.
 *
 * @param models - the snapshot's id-keyed entry table.
 * @param id - the model id as the user declared it.
 * @returns the matched key and tier, or the reason none was used.
 */
function resolveCatalogKey(
  models: Record<string, CatalogEntry[]>,
  id: string,
): { key: string; resolution: CatalogResolution } | { resolution: CatalogResolution; candidates: string[] } {
  if (Object.hasOwn(models, id)) return { key: id, resolution: 'exact' }
  const keys = Object.keys(models)
  const fold = id.toLowerCase()
  const caseHits = keys.filter((key) => key.toLowerCase() === fold)
  if (caseHits.length === 1) return { key: caseHits[0], resolution: 'case-folded' }
  if (caseHits.length > 1) return { resolution: 'ambiguous', candidates: caseHits.sort() }
  const bare = foldSeparators(id)
  // An id of only separators folds to nothing, which would otherwise match a key
  // that also folds to nothing: that is a name with no content, not a model.
  if (bare === '') return { resolution: 'not-found', candidates: [] }
  const separatorHits = keys.filter((key) => foldSeparators(key) === bare)
  if (separatorHits.length === 1) return { key: separatorHits[0], resolution: 'separator-folded' }
  if (separatorHits.length > 1) return { resolution: 'ambiguous', candidates: separatorHits.sort() }
  return { resolution: 'not-found', candidates: [] }
}

/**
 * Looks one model id up across the snapshot. When [api] is given, only entries
 * explicitly describing that wire family are considered; an absent API cannot
 * safely inherit protocol-specific serialization data.
 *
 * The id is resolved to a catalog key before [api] filters rows, so a protocol
 * mismatch still reports the resolution it reached (`providers` stays empty)
 * rather than silently implying the id is unknown.
 */
export function lookupCatalog(snapshot: CatalogSnapshot | undefined, id: string, api?: string): CatalogMatch {
  const match: CatalogMatch = { id, providers: [], capabilities: {}, conflicts: [], resolution: 'not-found', ambiguousIds: [] }
  if (!snapshot?.models) return match
  const resolved = resolveCatalogKey(snapshot.models, id)
  if ('candidates' in resolved) {
    match.resolution = resolved.resolution
    match.ambiguousIds = resolved.candidates
    if (resolved.candidates.length > 0) {
      match.conflicts.push(`目录中 ${resolved.candidates.length} 个大小写/分隔符变体同时命中（${resolved.candidates.join(' / ')}），身份不确定——不采用任何一条`)
    }
    return match
  }
  match.resolution = resolved.resolution
  const entries = snapshot.models[resolved.key].filter((entry) => {
    if (!api) return true
    return entry.api === api
  })
  if (entries.length === 0) return match
  const apis = [...new Set(entries.map((entry) => entry.api).filter((value): value is string => typeof value === 'string'))]
  const hasMissingApi = entries.some((entry) => typeof entry.api !== 'string')
  if (api !== undefined) match.capabilities.api = api
  else if (apis.length === 1 && !hasMissingApi) match.capabilities.api = apis[0]
  else if (apis.length > 1 || hasMissingApi) match.conflicts.push(`api conflict: ${apis.join('/') || 'unknown'}`)
  match.providers = entries.map((entry) => entry.provider)

  const unanimous = <T>(values: Array<T | undefined>, label: string): T | undefined => {
    const declared = values.filter((value): value is T => value !== undefined)
    if (declared.length === 0) return undefined
    const distinct = new Set(declared.map((value) => keyOf(value)))
    if (distinct.size > 1) {
      match.conflicts.push(`${label}: 目录声明不一致（${[...distinct].join(' vs ')}）`)
      return undefined
    }
    return declared[0]
  }

  const efforts = unanimous(entries.map((entry) => effortsOf(entry)), 'reasoningEfforts')
  if (efforts) match.capabilities.reasoningEfforts = efforts
  const input = unanimous(entries.map((entry) => modalitiesOf(entry)), 'input')
  if (input) match.capabilities.input = input
  const contextWindow = unanimous(entries.map((entry) => entry.contextWindow), 'contextWindow')
  if (contextWindow) match.capabilities.contextWindow = contextWindow
  const maxTokens = unanimous(entries.map((entry) => entry.maxTokens), 'maxTokens')
  if (maxTokens) match.capabilities.maxTokens = maxTokens

  // compat: 逐键合并；同一键出现不同值时该键丢弃并记冲突。
  // 方言键（thinkingFormat / supportsReasoningEffort / maxTokensField）另加严格口径：
  // 只要有目录**声明了却另一些没声明**，方言就不算确定——缺失不能当成一致
  // （issue #134：opencode-go 只声明 maxTokensField、zai 才声明 thinkingFormat，
  //  宽松口径会拿 zai 的方言去配任意自定义网关）。
  const compat: Record<string, unknown> = {}
  const keys = new Set<string>()
  for (const entry of entries) for (const key of Object.keys(entry.compat ?? {})) keys.add(key)
  for (const key of keys) {
    const declared = entries.map((entry) => entry.compat?.[key])
    const isDialect = (DIALECT_COMPAT_KEYS as readonly string[]).includes(key)
    const missing = declared.filter((value) => value === undefined).length
    if (isDialect && missing > 0 && missing < declared.length) {
      match.conflicts.push(`compat.${key}: 仅部分目录声明（方言不明）`)
      continue
    }
    const value = unanimous(declared, `compat.${key}`)
    if (value !== undefined) compat[key] = value
  }
  if (Object.keys(compat).length > 0) match.capabilities.compat = compat

  return match
}

/** True when the match carries at least one applicable capability. */
export function hasCapabilities(match: CatalogMatch): boolean {
  return Object.keys(match.capabilities).length > 0
}
