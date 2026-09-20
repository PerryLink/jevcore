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
 *   minConfidence       0.7         — an unsure Jev produces `ask`, not `allow`
 *
 * The two numeric thresholds are read from `DEFAULT_POLICY` rather than written
 * here, so the posture described above and the posture enforced cannot drift
 * apart. They used to be literals in five separate places.
 */

import { DEFAULT_POLICY } from './policy.js'

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
  /**
   * Milliseconds allowed per provider attempt. `0` disables the per-attempt
   * deadline; it does not disable the call.
   *
   * **Per attempt, not per call.** The TypeSafe SDK documents its own default as
   * "timeout per attempt in milliseconds, without a total retry budget", so a
   * per-attempt number cannot bound how long one call occupies. The bound is the
   * total budget the providers arm around the whole call
   * (`DEFAULT_TOTAL_BUDGET_MS`, 40_000ms, which covers 3 attempts at the default
   * timeout plus backoff).
   *
   * `0` used to be documented as "disables the timeout" and was then passed
   * straight to the SDK, whose `assertPositiveMs` throws for any value `<= 0`:
   * every call failed before a socket opened, and the failure was reported as
   * "network or timeout". `0` now means what it says — the per-attempt deadline
   * is encoded as a finite number no real attempt reaches — and the total budget
   * still applies, so "no timeout" cannot become "blocks forever".
   */
  readonly requestTimeoutMs?: number
  /**
   * Retries after the first attempt, `0` to disable. Defaults to `2`.
   *
   * Worth lowering inside a gate: every retry multiplies the worst-case latency
   * above, and most gate decisions can afford to fall back to `ask`.
   */
  readonly requestMaxRetries?: number
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
  readonly requestTimeoutMs: number
  readonly requestMaxRetries: number
  readonly minConfidence: number
  readonly minProbability: number
  readonly maxStateChars: number | undefined
  readonly gates: {
    readonly safety: Required<GateSettings>
    readonly context: Required<GateSettings>
  }
}

/**
 * Per-attempt timeout handed to the provider. **Per attempt, not per call.**
 *
 * 10_000, which is what the upstream SDK documents and defaults to: *"Timeout
 * per attempt in milliseconds, without a total retry budget. Default: 10000."*
 * Matching it is the honest choice, because this package does not get to
 * redefine what the number means by picking a different one.
 *
 * What the number cannot do on its own is bound the call. Three attempts at this
 * timeout plus the backoff between them is roughly 30–40s, and the SDK has no
 * total budget in JavaScript, so a per-attempt setting is not a ceiling on how
 * long a tool call blocks. That ceiling exists — it is the total budget the
 * providers arm around the whole call (`DEFAULT_TOTAL_BUDGET_MS`, 40_000) — and
 * this value is deliberately sized so the two agree: 10s x 3 attempts + ~10s of
 * backoff ≈ 40s.
 *
 * The previous value was 30_000, with a comment claiming it was "chosen to bound
 * the SDK's worst case rather than to match its default". It bounded nothing: the
 * worst case under it was 30s x 3 attempts + backoff ≈ 90s, which is an order of
 * magnitude more blocking than the comment described.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS: number = 10_000

/**
 * Retries after the first attempt. The SDK's own default, restated explicitly.
 *
 * Kept in step with the total budget above: the budget is sized for
 * `DEFAULT_REQUEST_MAX_RETRIES + 1` attempts, so raising this without raising the
 * budget would silently cut the last attempts short.
 */
export const DEFAULT_REQUEST_MAX_RETRIES: number = 2

export const DEFAULT_CONFIG: JevConfig = {
  provider: 'mock',
  apiKeyRef: 'TYPESAFE_API_KEY',
  openRouterApiKeyRef: 'OPENROUTER_API_KEY',
  baseURL: undefined,
  openRouterBaseURL: undefined,
  model: 'jev-latest',
  logLevel: 'warn',
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  requestMaxRetries: DEFAULT_REQUEST_MAX_RETRIES,
  // Taken from `DEFAULT_POLICY` rather than restated. Both values used to be
  // written out literally here *and* in the policy module *and* in both gates
  // *and* in the DSH plugin's own config docs — five copies of two numbers, so
  // tuning one left the others silently disagreeing. The official guidance is
  // blunt about it: "Put the constants (questions and thresholds) in a single
  // place so they're easy to review."
  minConfidence: DEFAULT_POLICY.minConfidence,
  minProbability: DEFAULT_POLICY.minProbability,
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
  throw new ConfigError(`jevcore config: ${message}`)
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

/** Read a non-negative integer, or fail with the field name. */
const readPositiveInt = (name: string, value: unknown, fallback: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fail(`"${name}" must be a non-negative integer`)
  }
  return value
}

const readRequestTimeoutMs = (value: unknown): number => {
  // 0 is a deliberate "no per-attempt deadline", distinct from "unset". The
  // provider encodes it as a finite number, because the SDK rejects 0 — passing
  // it through was the defect this comment used to assert did not exist.
  return readPositiveInt('requestTimeoutMs', value, DEFAULT_CONFIG.requestTimeoutMs)
}

const readRequestMaxRetries = (value: unknown): number =>
  readPositiveInt('requestMaxRetries', value, DEFAULT_CONFIG.requestMaxRetries)

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
    requestTimeoutMs: readRequestTimeoutMs(raw.requestTimeoutMs),
    requestMaxRetries: readRequestMaxRetries(raw.requestMaxRetries),
    minConfidence: readFraction('minConfidence', raw.minConfidence, DEFAULT_CONFIG.minConfidence),
    minProbability: readFraction('minProbability', raw.minProbability, DEFAULT_CONFIG.minProbability),
    maxStateChars: readMaxStateChars(raw.maxStateChars),
    gates: {
      safety: readGate('safety', gatesRaw.safety, DEFAULT_CONFIG.gates.safety),
      context: readGate('context', gatesRaw.context, DEFAULT_CONFIG.gates.context),
    },
  }
}
