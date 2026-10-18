/**
 * Reads one user-declared provider route out of the llm-pi-ai settings section.
 * Kept dependency-free so the mapping is unit-testable without the engine.
 */
import type { ProviderConfig } from './capability-probe.js'

export interface SettingsDescriptorLike {
  ns: string
  value: unknown
  revision: number
}

export interface SettingsLike {
  describe(options?: { namespaces?: readonly string[] }): SettingsDescriptorLike[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Model ids may be declared as strings or as objects carrying `id`. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return item
    const id = record(item).id
    return typeof id === 'string' ? id : ''
  }).filter((id) => id !== '')
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const source = record(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function compatMap(value: unknown): Record<string, unknown> | undefined {
  const source = record(value)
  return Object.keys(source).length > 0 ? { ...source } : undefined
}

function modelProfiles(value: unknown): NonNullable<ProviderConfig['modelProfiles']> {
  const out: NonNullable<ProviderConfig['modelProfiles']> = {}
  if (!Array.isArray(value)) return out
  for (const item of value) {
    if (typeof item === 'string') continue
    const profile = record(item)
    if (typeof profile.id !== 'string' || profile.id === '') continue
    out[profile.id] = {
      ...(profile.compat === undefined ? {} : { compat: compatMap(profile.compat) ?? {} }),
      ...(Object.prototype.hasOwnProperty.call(profile, 'reasoningEfforts')
        ? { reasoningEfforts: profile.reasoningEfforts }
        : {}),
    }
  }
  return out
}

/**
 * Returns the provider configuration, or undefined when the route (or its
 * baseURL) is absent — the caller reports that instead of guessing a target.
 */
export function providerFromSettings(
  settings: SettingsLike | undefined,
  route: string,
  sectionOverride?: unknown,
): ProviderConfig | undefined {
  if (!settings) return undefined
  let section: unknown = sectionOverride
  if (sectionOverride === undefined) {
    try {
      // 注意：settings.describe(options) 的 options 当前被实现忽略（返回全部命名空间），
      // 所以必须按 ns 查找——不能用 [0]（实测踩坑：拿到的可能是 llm-deepseek）。
      section = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')?.value
    } catch {
      return undefined
    }
  }
  const entry = record(record(section).providers ? record(record(section).providers)[route] : undefined)
  const baseURL = typeof entry.baseURL === 'string' && entry.baseURL !== '' ? entry.baseURL : undefined
  if (!baseURL) return undefined
  const models = stringList(entry.models)
  const overrides = record(entry.modelOverrides)
  const overrideIds = Object.keys(overrides)
  const declaredProfiles = modelProfiles(entry.models)
  for (const [id, value] of Object.entries(overrides)) {
    if (models.length > 0 && !models.includes(id)) continue
    const override = record(value)
    const declared = declaredProfiles[id] ?? {}
    const overrideCompat = compatMap(override.compat)
    const declaredCompat = declared.compat
    declaredProfiles[id] = {
      ...(overrideCompat || declaredCompat
        ? { compat: { ...overrideCompat, ...declaredCompat } }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(declared, 'reasoningEfforts')
        ? { reasoningEfforts: declared.reasoningEfforts }
        : Object.prototype.hasOwnProperty.call(override, 'reasoningEfforts')
          ? { reasoningEfforts: override.reasoningEfforts }
          : {}),
    }
  }
  const apiKeyEnv = typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv !== '' ? entry.apiKeyEnv : undefined
  return {
    route,
    api: typeof entry.api === 'string' ? entry.api : undefined,
    ...(entry.compat === undefined ? {} : { compat: compatMap(entry.compat) ?? {} }),
    baseURL,
    apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : undefined,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    headers: stringMap(entry.headers),
    models: models.length > 0 ? models : overrideIds,
    modelProfiles: declaredProfiles,
  }
}
