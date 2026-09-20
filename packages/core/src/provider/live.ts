/**
 * The live provider: the only file in this plugin that can reach the network.
 *
 * It delegates to the official `@typesafe-ai/sdk` rather than hand-rolling
 * HTTP, so retries, timeouts, error classification, and response parsing are
 * the vendor's problem, not ours. The SDK is loaded lazily so an offline
 * install neither needs it nor fails without it.
 *
 * Two hardening decisions that differ from the ecosystem norm:
 *
 *  - **The ambient environment is not trusted.** The key is passed explicitly
 *    by the caller, which resolves it through DSH's credential service first.
 *    The SDK's own `TYPESAFE_API_KEY` fallback is defeated by passing
 *    `apiKey` for every request, so a stray variable cannot silently enable
 *    transmission.
 *  - **The endpoint is validated.** A `baseURL` that is not `https:` (or a
 *    loopback `http:`) is refused, so a typo cannot ship prompts in cleartext.
 */

import type {
  JevAnswer,
  JevProvider,
  JevRequest,
  JevResult,
  JevUsage,
} from '../types.js'
import { JevProviderError } from '../types.js'
import { isRecord, normalizeAnswer } from '../answers.js'
import {
  DEFAULT_TOTAL_BUDGET_MS,
  NO_PER_ATTEMPT_TIMEOUT_MS,
  armCallBudget,
  classifyProviderFailure,
} from './classify.js'

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai'
export const DEFAULT_MODEL = 'jev-latest'

/** The subset of the official SDK this provider uses. */
export interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: unknown; model?: string },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

export interface SdkModule {
  TypeSafeClient: new (config: {
    apiKey: string
    baseURL?: string
    /**
     * Passed explicitly, always. The SDK falls back to `TYPESAFE_LOG_LEVEL`
     * otherwise, and `debug` prints request bodies **unredacted** — which would
     * defeat this package's whole egress contract from the environment.
     */
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'off'
    /** Milliseconds per attempt. The SDK default is 10_000 with no total budget. */
    timeout?: number
    /** Retry overrides; omitted fields use the SDK's own defaults. */
    retry?: Readonly<Record<string, unknown>>
    dangerouslyAllowBrowser?: boolean
  }) => SystemOneClient
}

/**
 * The log level this provider always passes to the SDK.
 *
 * Defaults to `warn`, matching the SDK's own default but supplied explicitly so
 * the environment cannot raise it. See {@link LiveProviderOptions.logLevel}.
 */
export const DEFAULT_LOG_LEVEL = 'warn' as const

/** Log levels the SDK accepts. Re-exported so callers need no SDK import. */
export type ProviderLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off'

export interface LiveProviderOptions {
  /** Resolved API key. Never sourced from the environment by this class. */
  readonly apiKey: string
  /** API root. Defaults to {@link DEFAULT_ENDPOINT}. */
  readonly baseURL?: string
  /** Model name. Defaults to {@link DEFAULT_MODEL}. */
  readonly model?: string
  /**
   * SDK log level, passed explicitly so `TYPESAFE_LOG_LEVEL` cannot raise it.
   *
   * This matters more than it looks. The SDK documents that `debug` "adds
   * headers and bodies. Known credential headers are redacted; **bodies are
   * not**." A stray `TYPESAFE_LOG_LEVEL=debug` in the host environment would
   * therefore write unredacted request bodies — including the very state this
   * package redacts before sending — to the log. Passing the level explicitly
   * is what makes the redaction guarantee hold against the environment, the
   * same reason `apiKey` is never left to the SDK's own fallback.
   *
   * Defaults to {@link DEFAULT_LOG_LEVEL}.
   */
  readonly logLevel?: ProviderLogLevel
  /**
   * Milliseconds per attempt, or the SDK default (10_000) when omitted.
   *
   * **Per attempt, not per call.** The SDK is explicit that this is a "timeout
   * per attempt in milliseconds, without a total retry budget", so on its own
   * this number does not bound how long a call occupies: three attempts at 30s
   * plus backoff is roughly 90s, which is why this setting alone was never the
   * bound it looked like. {@link LiveProviderOptions.totalBudgetMs} is the bound.
   *
   * `0` means what it says — no per-attempt deadline. It cannot be passed
   * straight through, because the SDK's `assertPositiveMs` throws for any value
   * `<= 0`; a configured `0` used to make every call fail before a socket opened
   * and then report that failure as a network problem. See
   * {@link NO_PER_ATTEMPT_TIMEOUT_MS}.
   */
  readonly timeout?: number
  /**
   * Ceiling on one complete call, in milliseconds: every attempt plus every
   * backoff between them. Defaults to {@link DEFAULT_TOTAL_BUDGET_MS}.
   *
   * Deliberately not part of the documented configuration surface — it is the
   * safety net that makes `timeout` mean "per attempt" honestly, not a second
   * knob to tune. Pass `0` to remove the ceiling entirely.
   */
  readonly totalBudgetMs?: number
  /** Retry overrides, e.g. `{ maxRetries: 0 }` to fail fast inside a gate. */
  readonly retry?: Readonly<Record<string, unknown>>
  /** Injectable for tests, so no test needs a real key or a real socket. */
  readonly loadSdk?: () => Promise<SdkModule>
}

/**
 * The per-attempt timeout the SDK is given when a caller configures `0`.
 *
 * See the note on the encoding in `classify.ts`: the SDK's `assertPositiveMs`
 * rejects `0`, so "no per-attempt deadline" has to be expressed as a number it
 * accepts. Re-exported so a caller of this provider does not have to reach into
 * the classifier for it.
 */
export { NO_PER_ATTEMPT_TIMEOUT_MS }

/** The ceiling applied to one whole call when none is configured. */
export const DEFAULT_CALL_TOTAL_BUDGET_MS: number = DEFAULT_TOTAL_BUDGET_MS

/**
 * The `timeout` value to hand the SDK for a caller-configured timeout.
 *
 * `undefined` passes nothing, leaving the SDK's own default in place. `0` means
 * "no per-attempt deadline" and is encoded as {@link NO_PER_ATTEMPT_TIMEOUT_MS},
 * because the SDK throws on anything `<= 0`. Anything else is passed through.
 *
 * Exported so the OpenRouter route — which shares this client — cannot drift
 * from the TypeSafe route on what `0` means.
 */
export const timeoutForSdk = (timeout: number | undefined): number | undefined => {
  if (timeout === undefined) return undefined
  if (timeout <= 0) return NO_PER_ATTEMPT_TIMEOUT_MS
  return timeout
}

/** Refuse an endpoint that would send prompts in cleartext. */
export const assertUsableEndpoint = (baseURL: string): string => {
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new JevProviderError(
      `TypeSafe baseURL is not a valid URL: ${baseURL}`,
      'provider-unavailable',
    )
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new JevProviderError(
      `TypeSafe baseURL must use https (loopback http is allowed for local testing), got ` +
        `${parsed.protocol}//${parsed.hostname}`,
      'provider-unavailable',
    )
  }
  return baseURL.replace(/\/+$/, '')
}

/**
 * Load the official SDK.
 *
 * Exported so the "SDK is not installed" path is testable without uninstalling
 * anything: a test can call this with a specifier known to be unresolvable.
 */
export const loadOfficialSdk = async (specifier = '@typesafe-ai/sdk'): Promise<SdkModule> => {
  try {
    // A variable specifier keeps this out of the static graph, so the module
    // resolves only when someone actually selects the live provider.
    return (await import(specifier)) as unknown as SdkModule
  } catch (cause) {
    throw new JevProviderError(
      'provider "live" needs the official SDK. Install it with ' +
        '`npm install @typesafe-ai/sdk`, or keep the default mock provider.',
      'provider-unavailable',
      { cause },
    )
  }
}

const defaultLoadSdk = (): Promise<SdkModule> => loadOfficialSdk()

/** Pull the numeric fields the SDK reports, ignoring anything unshaped. */
const readUsage = (value: unknown): JevUsage | undefined => {
  if (!isRecord(value)) return undefined
  const count = (camel: string, snake: string): number | undefined => {
    const entry = typeof value[snake] === 'number' ? value[snake] : value[camel]
    return typeof entry === 'number' && Number.isFinite(entry) ? entry : undefined
  }
  const usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
  const inputTokens = count('inputTokens', 'input_tokens')
  const outputTokens = count('outputTokens', 'output_tokens')
  const costUsd = count('costUsd', 'cost_usd')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (costUsd !== undefined) usage.costUsd = costUsd
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** A provider backed by the official TypeSafe SDK. */
export class LiveProvider implements JevProvider {
  readonly id = 'live'
  private readonly baseURL: string
  private client: SystemOneClient | undefined

  constructor(private readonly options: LiveProviderOptions) {
    this.baseURL = assertUsableEndpoint(options.baseURL ?? DEFAULT_ENDPOINT)
  }

  /** The endpoint this provider will POST to. Used by the startup report. */
  get endpoint(): string {
    return this.baseURL
  }

  private async clientForRequest(): Promise<SystemOneClient> {
    if (this.client !== undefined) return this.client
    const load = this.options.loadSdk ?? defaultLoadSdk
    const sdk = await load()
    const timeout = timeoutForSdk(this.options.timeout)
    this.client = new sdk.TypeSafeClient({
      // Every field the SDK would otherwise take from the environment is
      // supplied explicitly. `apiKey` was always passed; `logLevel` was the gap,
      // and it is the one that can defeat redaction rather than merely
      // redirect a request: `debug` writes bodies unredacted, so an ambient
      // TYPESAFE_LOG_LEVEL=debug would log exactly what this package strips
      // before sending. `timeout` and `retry` are passed for a different
      // reason — the SDK's defaults let one call occupy ~30s, which is longer
      // than a tool gate should ever block.
      apiKey: this.options.apiKey,
      baseURL: this.baseURL,
      logLevel: this.options.logLevel ?? DEFAULT_LOG_LEVEL,
      ...(timeout === undefined ? {} : { timeout }),
      ...(this.options.retry === undefined ? {} : { retry: this.options.retry }),
      // This runs inside a DSH host process, never a browser page.
      dangerouslyAllowBrowser: false,
    })
    return this.client
  }

  async answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const startedAt = Date.now()
    const client = await this.clientForRequest()

    // One deadline for the whole call. `timeout` is per attempt and the SDK has
    // no total budget, so without this a call could occupy perAttempt x
    // (maxRetries + 1) plus backoff — the 90s worst case the per-attempt
    // timeout was mistaken for bounding.
    const budget = armCallBudget(
      this.options.totalBudgetMs ?? DEFAULT_CALL_TOTAL_BUDGET_MS,
      signal,
    )

    let response: unknown
    try {
      response = await client.systemOne(
        {
          state: request.state,
          questions: request.questions,
          ...(request.model ?? this.options.model
            ? { model: request.model ?? this.options.model }
            : {}),
        },
        budget.signal === undefined ? {} : { signal: budget.signal },
      )
    } catch (cause) {
      // The upstream's own body is never read: it can quote the offending
      // field, and request headers are exactly what this package keeps out of
      // logs. Only the status is carried across, plus a code that says whether
      // retrying could ever help.
      throw classifyProviderFailure(cause, {
        providerId: this.id,
        label: 'TypeSafe',
        signal,
      })
    } finally {
      budget.dispose()
    }

    if (!isRecord(response)) {
      throw new JevProviderError(
        'TypeSafe returned a response that is not an object.',
        'malformed-response',
      )
    }

    const rawAnswers = isRecord(response.answers) ? response.answers : undefined
    if (rawAnswers === undefined) {
      throw new JevProviderError(
        'TypeSafe response has no "answers" object.',
        'malformed-response',
      )
    }

    const answers: Record<string, JevAnswer> = {}
    for (const [questionId, question] of Object.entries(request.questions)) {
      const answer = normalizeAnswer(rawAnswers[questionId], question.type)
      if (answer !== undefined) answers[questionId] = answer
    }

    const model = typeof response.model === 'string' ? response.model : (request.model ?? DEFAULT_MODEL)
    const usage = readUsage(response.usage)

    return {
      model,
      answers,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: Date.now() - startedAt,
      provider: this.id,
    }
  }
}
