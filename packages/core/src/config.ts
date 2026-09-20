/**
 * Plugin configuration and its validation.
 *
 * Hand-written rather than schema-library-driven on purpose: this package's
 * core must stay dependency-free so its tests run with nothing installed, and
 * the config surface is small enough that an explicit validator is clearer
 * than a schema plus its inference.
 *
 * The defaults are the security posture, not an afterthought. Out of the box
 * this plugin resolves no credential, opens no socket, and reads no tool
 * result:
 *
 *   provider            'mock'      — nothing to reach
 *   gates.safety        false       — does not judge tool calls
 *   gates.context       false       — does not read tool results
 *   defaultModel        'jev-latest'
 *   maxConfidenceFloor  0.7         — an unsure Jev produces `ask`, not `allow`
 */

/**
 * Which provider serves System One requests.
 *
 *  - `mock` — offline, deterministic, synthetic. The default.
 *  - `live` — TypeSafe's own API, using `apiKeyRef`.
 *  - `openrouter` — OpenRouter's Decisions route, using `openRouterApiKeyRef`.
 *    A second way to reach the same models when a TypeSafe key is impractical.
 */
export type ProviderKind = 'mock' | 'live' | 'openrouter'

/** Configuration for one gate: an object, or a bare boolean shorthand. */
export type GateInput = GateSettings | boolean

export interface GateSettings {
  /**
   * Enable the gate. When false the gate registers nothing, so it cannot
   * transmit. Default false.
   */
  readonly enabled?: boolean
  /**
   * What to do when the policy cannot decide.
   *  - `ask`  (default) surface the question to the human approval path
   *  - `allow` fail open
   *  - `deny`  fail closed
   */
  readonly onUndecided?: 'ask' | 'allow' | 'deny'
}

export interface JevConfigInput {
  readonly provider?: ProviderKind
  /**
   * Credential reference resolved through DSH's credential service. The key
   * itself is never written to configuration.
   */
  readonly apiKeyRef?: string
  /**
   * Credential reference for the OpenRouter provider, used when `provider` is
   * `openrouter`. Separate from {@link JevConfigInput.apiKeyRef} so the two
   * routes cannot accidentally share a key.
   */
  readonly openRouterApiKeyRef?: string
  /** API root for the live provider. */
  readonly baseURL?: string
  /** API root for the OpenRouter provider. */
  readonly openRouterBaseURL?: string
  /** Model name sent with every request. */
  readonly model?: string
  /** Log level for this plugin's own diagnostics. */
  readonly logLevel?: 'silent' | 'warn' | 'info' | 'debug'
  /** Minimum Jev `confidence` before an answer is acted upon. */
  readonly minConfidence?: number
  /** Minimum probability of the selected criterion. */
  readonly minProbability?: number
  /** Maximum characters of `state` sent per call. `0` uses the feature default. */
  readonly maxStateChars?: number
  readonly gates?: {
    readonly safety?: GateInput
    readonly context?: GateInput
  }
}

/** Resolved configuration: every field present and validated. */
export interface JevConfig {
  readonly provider: ProviderKind
  readonly apiKeyRef: string
  readonly openRouterApiKeyRef: string
  readonly baseURL: string | undefined
  readonly openRouterBaseURL: string | undefined
  readonly model: string
  readonly logLevel: 'silent' | 'warn' | 'info' | 'debug'
  readonly minConfidence: number
  readonly minProbability: number
  readonly maxStateChars: number | undefined
  readonly gates: {
    readonly safety: Required<GateSettings>
    readonly context: Required<GateSettings>
  }
}

export const DEFAULT_CONFIG: JevConfig = {
  provider: 'mock',
  apiKeyRef: 'TYPESAFE_API_KEY',
  openRouterApiKeyRef: 'OPENROUTER_API_KEY',
  baseURL: undefined,
  openRouterBaseURL: undefined,
  model: 'jev-latest',
  logLevel: 'warn',
  minConfidence: 0.7,
  minProbability: 0.6,
  maxStateChars: undefined,
  gates: {
    safety: { enabled: false, onUndecided: 'ask' },
    context: { enabled: false, onUndecided: 'ask' },
  },
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Fail config validation.
 *
 * Declared as a function rather than an arrow so TypeScript treats calls as
 * unreachable-returning, which lets the readers below narrow instead of
 * carrying `unknown` past their guards.
 */
function fail(message: string): never {
  throw new ConfigError(`dsh-jev config: ${message}`)
}

const readFraction = (name: string, value: unknown, fallback: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return fail(`"${name}" must be a number between 0 and 1, got ${String(value)}`)
  }
  return value
}

const readBoolean = (name: string, value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') return fail(`"${name}" must be a boolean, got ${String(value)}`)
  return value
}

const readProvider = (value: unknown): ProviderKind => {
  if (value === undefined) return DEFAULT_CONFIG.provider
  if (value === 'mock' || value === 'live' || value === 'openrouter') return value
  return fail(`"provider" must be "mock", "live", or "openrouter", got ${String(value)}`)
}

const readGate = (name: string, value: unknown, fallback: Required<GateSettings>): Required<GateSettings> => {
  if (value === undefined) return fallback
  // A bare boolean is accepted as shorthand for `{ enabled: <bool> }`, which
  // is how a patch file most naturally turns a gate on or off.
  if (typeof value === 'boolean') return { ...fallback, enabled: value }
  if (typeof value !== 'object' || value === null) {
    return fail(`"gates.${name}" must be an object or a boolean`)
  }
  const record = value as Record<string, unknown>
  const onUndecided = record.onUndecided
  if (
    onUndecided !== undefined &&
    onUndecided !== 'ask' &&
    onUndecided !== 'allow' &&
    onUndecided !== 'deny'
  ) {
    return fail(`"gates.${name}.onUndecided" must be "ask", "allow", or "deny"`)
  }
  return {
    enabled: readBoolean(`gates.${name}.enabled`, record.enabled, fallback.enabled),
    onUndecided: (onUndecided as 'ask' | 'allow' | 'deny' | undefined) ?? fallback.onUndecided,
  }
}

const readLogLevel = (value: unknown): JevConfig['logLevel'] => {
  if (value === undefined) return DEFAULT_CONFIG.logLevel
  if (value === 'silent' || value === 'warn' || value === 'info' || value === 'debug') return value
  return fail(`"logLevel" must be silent, warn, info, or debug, got ${String(value)}`)
}

const readMaxStateChars = (value: unknown): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fail('"maxStateChars" must be a non-negative integer')
  }
  // 0 means "use the feature default", which is represented as undefined.
  return value === 0 ? undefined : value
}

/** Validate and resolve a raw config object. Throws {@link ConfigError}. */
export const resolveConfig = (input: JevConfigInput | undefined): JevConfig => {
  if (input === undefined) return DEFAULT_CONFIG
  if (typeof input !== 'object' || input === null) return fail('configuration must be an object')
  const raw = input as Record<string, unknown>

  const gatesRaw = (raw.gates ?? {}) as Record<string, unknown>

  const readRef = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback

  return {
    provider: readProvider(raw.provider),
    apiKeyRef: readRef(raw.apiKeyRef, DEFAULT_CONFIG.apiKeyRef),
    openRouterApiKeyRef: readRef(raw.openRouterApiKeyRef, DEFAULT_CONFIG.openRouterApiKeyRef),
    baseURL:
      typeof raw.baseURL === 'string' && raw.baseURL.trim().length > 0 ? raw.baseURL.trim() : undefined,
    openRouterBaseURL:
      typeof raw.openRouterBaseURL === 'string' && raw.openRouterBaseURL.trim().length > 0
        ? raw.openRouterBaseURL.trim()
        : undefined,
    model:
      typeof raw.model === 'string' && raw.model.trim().length > 0
        ? raw.model.trim()
        : DEFAULT_CONFIG.model,
    logLevel: readLogLevel(raw.logLevel),
    minConfidence: readFraction('minConfidence', raw.minConfidence, DEFAULT_CONFIG.minConfidence),
    minProbability: readFraction('minProbability', raw.minProbability, DEFAULT_CONFIG.minProbability),
    maxStateChars: readMaxStateChars(raw.maxStateChars),
    gates: {
      safety: readGate('safety', gatesRaw.safety, DEFAULT_CONFIG.gates.safety),
      context: readGate('context', gatesRaw.context, DEFAULT_CONFIG.gates.context),
    },
  }
}
