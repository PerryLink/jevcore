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
  requestIdOf,
} from './classify.js'

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai'
export const DEFAULT_MODEL = 'jev-latest'

/**
 * The SDK's models resource, as far as this package uses it.
 *
 * `client.models.list()` is the SDK's own model-listing call
 * (`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:232-237`, `client.models` at
 * `:269`), backed by the documented `GET /v1/models`
 * (https://docs.typesafe.ai/models). It is declared as an *optional* capability
 * of the client rather than a required one, because a transport injected through
 * `loadSdk` may not implement it — and "this transport cannot list models" is a
 * fact worth reporting, not a crash worth having.
 */
export interface ModelLister {
  /** `GET /v1/models`. Resolves to the SDK's unwrapped `ModelCard[]`. */
  list(options?: { signal?: AbortSignal }): Promise<unknown>
}

/**
 * The richer result the SDK's `APIPromise.withResponse()` resolves to.
 *
 * `data` is the parsed body; `requestId` is whatever `x-typesafe-request-id`
 * carried, `undefined` when the server sent none (`dist/index.d.mts:3-10`).
 * Deliberately not typed as the SDK's `WithResponse<T>`: this package reads it
 * structurally, so a transport that resolves a plain object can be used here
 * without importing the vendor's generics.
 */
export interface SdkResponseEnvelope {
  readonly data: unknown
  readonly requestId?: string | undefined
}

/**
 * The promise `systemOne` returns.
 *
 * The SDK returns an `APIPromise`, which is a real `Promise` that *additionally*
 * carries `withResponse()` (`dist/index.d.mts:16-32`). Declaring that as an
 * optional method is what lets the id be read when the capability is present and
 * the call behave exactly as it used to when it is not — no cast, no feature
 * detection against the vendor's class, and no assumption that every injected
 * transport is the official one.
 */
export interface SystemOnePromise extends Promise<unknown> {
  withResponse?(): Promise<SdkResponseEnvelope>
}

/** The subset of the official SDK this provider uses. */
export interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: unknown; model?: string },
    options?: { signal?: AbortSignal },
  ): SystemOnePromise
  /** Present on the official client; absent on a transport that cannot list models. */
  readonly models?: ModelLister | undefined
}

export interface SdkModule {
  TypeSafeClient: new (config: SdkClientConfig) => SystemOneClient
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

/**
 * The most verbose SDK log level that cannot print a request body.
 *
 * `debug` is the only level that does, and it is one step above this one; `info`
 * is what remains of it once the bodies are gone. See {@link sdkLogLevelFor} for
 * the source of that claim and why it matters here.
 */
export const BODY_SAFE_LOG_LEVEL: ProviderLogLevel = 'info'

/**
 * The level actually handed to the SDK for the level a caller asked for.
 *
 * **`debug` is not forwarded unless the caller asks for it by consequence.**
 * The SDK prints request bodies verbatim at `debug`. Its published source,
 * `@typesafe-ai/sdk@0.6.0` `dist/index.mjs:596-599`:
 *
 * ```js
 * this.logger.debug(`${tag} -> ${url}`, {
 *   headers: redactHeaders(attemptHeaders),
 *   body: req.body
 * })
 * ```
 *
 * Headers pass through `redactHeaders`; `body` does not. The same level prints
 * the parsed response body (`:573`) and an error response body (`:618`). The
 * SDK's own documentation says so in as many words — "`info` logs request
 * summaries; `debug` adds headers and bodies. Known credential headers are
 * redacted; bodies are not" (`dist/index.d.mts:210-215`, and
 * https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig).
 *
 * That lands differently in this package than in most, because the body is
 * exactly what the egress layer redacts before sending. Forwarding `debug` would
 * hand the vendor's logger — `console`, unless a logger is injected — the state
 * this package just stripped, and the SDK's redaction is header-only, so nothing
 * downstream would put it back. A caller asking for more operational detail
 * would silently be asking for the one thing this package exists to prevent.
 *
 * So `debug` becomes {@link BODY_SAFE_LOG_LEVEL}: every line an operator
 * actually wants survives — attempt summaries with status, latency and the
 * server's request id (`dist/index.mjs:615`), caller aborts (`:649`), timeouts
 * (`:653`), connection errors (`:656`), retry decisions (`:668`) — and only the
 * three body-printing lines are dropped.
 *
 * It refuses to be a dead end, too: `allowBodyLogging` is the caller's explicit
 * opt-in, named after the consequence rather than the level, so the one caller
 * who genuinely wants bodies logged can say so and read why not to.
 */
export const sdkLogLevelFor = (
  level: ProviderLogLevel,
  allowBodyLogging = false,
): ProviderLogLevel => (level === 'debug' && !allowBodyLogging ? BODY_SAFE_LOG_LEVEL : level)

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
   * Let the SDK print request bodies, including the state this package redacted.
   *
   * Off by default, and off is what makes `logLevel: 'debug'` safe: with this
   * unset, `debug` is forwarded as {@link BODY_SAFE_LOG_LEVEL} and no body ever
   * reaches the logger. See {@link sdkLogLevelFor} for the SDK source that
   * settles what `debug` writes.
   *
   * Set it only to debug the wire shape of what is being sent, and read what it
   * does first: the SDK logs `body: req.body` (`@typesafe-ai/sdk@0.6.0`,
   * `dist/index.mjs:598`) with no redaction of the body at all, so the value
   * that arrives in the log is the state **after** this package's redaction
   * rather than the caller's original — but it is still payload the caller
   * believed was being kept out of logs. It is named after that consequence, not
   * after the SDK level it maps to, because "enable debug" does not sound like
   * "write the request body to the console".
   */
  readonly allowSdkBodyLogging?: boolean
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

/**
 * The constructor config every route in this package passes to the SDK.
 *
 * Every field here is a decision the package has already made once: the key is
 * never taken from the environment, the log level is never left to it, and
 * `debug` is clamped as {@link sdkLogLevelFor} describes. `dangerouslyAllowBrowser`
 * is pinned to `false` for the obvious reason — this runs in a host process.
 */
export interface SdkClientConfig {
  readonly apiKey: string
  readonly baseURL: string
  readonly logLevel: ProviderLogLevel
  readonly timeout?: number | undefined
  readonly retry?: Readonly<Record<string, unknown>> | undefined
  readonly dangerouslyAllowBrowser: false
}

/**
 * What a caller supplies for {@link sdkClientConfig}, before defaults are applied.
 *
 * `undefined` is spelled out on each optional field rather than left implicit so
 * a caller can pass its own optional through directly under
 * `exactOptionalPropertyTypes`, instead of writing a conditional spread at every
 * call site. The three routes that build a client would otherwise carry three
 * copies of that shape, which is how the copies start to differ.
 */
export interface SdkClientOptions {
  readonly apiKey: string
  readonly baseURL: string
  readonly logLevel?: ProviderLogLevel | undefined
  readonly timeout?: number | undefined
  readonly retry?: Readonly<Record<string, unknown>> | undefined
  readonly allowSdkBodyLogging?: boolean | undefined
}

/**
 * Build the SDK client config, in one place.
 *
 * WHY one function and not a literal per provider: three call sites construct
 * this client — the TypeSafe route, the OpenRouter route, and the model
 * catalogue — and each field is a security decision rather than a preference.
 * The `logLevel` default in particular is what keeps an ambient
 * `TYPESAFE_LOG_LEVEL` from raising verbosity, and the clamp is what keeps a
 * caller's own `debug` from writing bodies. A copy of this object is a place
 * both can quietly stop being true.
 */
export const sdkClientConfig = (options: SdkClientOptions): SdkClientConfig => {
  const timeout = timeoutForSdk(options.timeout)
  return {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    logLevel: sdkLogLevelFor(
      options.logLevel ?? DEFAULT_LOG_LEVEL,
      options.allowSdkBodyLogging === true,
    ),
    ...(timeout === undefined ? {} : { timeout }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    // This runs inside a DSH host process, never a browser page.
    dangerouslyAllowBrowser: false,
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

/**
 * One answer, plus the server's own correlation id when it sent one.
 *
 * A {@link JevResult} with one optional field, so a caller holding a
 * `LiveProvider` can read the id without a cast while everything downstream that
 * takes a `JevResult` — the service, the tools, the policies — is unaffected.
 * Absent, not empty, when the endpoint named none: the shape stays exactly what
 * it was for every call that cannot be correlated.
 */
export interface LiveResult extends JevResult {
  /**
   * `x-typesafe-request-id` from the response — **assigned by TypeSafe**, read
   * back by the SDK and surfaced here.
   *
   * This is not a value this package invents or sends. `RequestOptions.headers`
   * would permit sending one (`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:188-189`),
   * but no TypeSafe source — the API reference
   * (https://docs.typesafe.ai/api), the models page, the SDK reference, or the
   * SDK's own source — documents a client-supplied value as accepted or echoed,
   * and an id the server did not issue would send an operator hunting a request
   * that does not exist on TypeSafe's side. An unverified header is worse than
   * none, so this package sends none and reports only what came back.
   *
   * Quote it to TypeSafe support, or grep it out of a log, to line one call up
   * with the vendor's own records.
   */
  readonly requestId?: string | undefined
}

/**
 * One `systemOne` call, using the SDK's richer result when it is there.
 *
 * WHY `withResponse()`: the id is only reachable through it. Awaiting the
 * `APIPromise` directly — which is what this provider used to do — throws the id
 * away, because the plain `then` path resolves the parsed body alone
 * (`@typesafe-ai/sdk@0.6.0`, `dist/index.mjs:41-43`), while `withResponse()`
 * additionally reads `x-typesafe-request-id` off the response (`:25-32`).
 *
 * It is called as a method on the promise, not detached: the SDK's `APIPromise`
 * keeps its state in `#private` fields (`dist/index.mjs:7-15`), so an unbound
 * call would throw rather than degrade.
 *
 * The capability is optional because it belongs to the SDK, not to this package:
 * a caller who injects a transport through `loadSdk` may resolve a plain
 * promise, and that is not an error — the call then behaves exactly as it did
 * before this existed, body and no id.
 */
const callSystemOne = async (
  client: SystemOneClient,
  request: { state: unknown; questions: unknown; model?: string },
  options: { signal?: AbortSignal },
): Promise<{ data: unknown; requestId?: string | undefined }> => {
  const pending = client.systemOne(request, options)
  const withResponse = pending.withResponse
  if (typeof withResponse !== 'function') return { data: await pending }

  const envelope: unknown = await withResponse.call(pending)
  if (!isRecord(envelope)) {
    // A `withResponse()` that resolves to something unshaped is reported as a
    // malformed response by the caller rather than silently re-awaited: guessing
    // which of the two results was meant is how a decision gets made about a
    // body nobody read.
    return { data: undefined }
  }
  const requestId = requestIdOf(envelope)
  return { data: envelope.data, ...(requestId === undefined ? {} : { requestId }) }
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
    // Every field the SDK would otherwise take from the environment is supplied
    // explicitly, through the one builder every route shares. `apiKey` was
    // always passed; `logLevel` was the gap, and it is the one that can defeat
    // redaction rather than merely redirect a request. `timeout` and `retry` are
    // passed for a different reason — the SDK's defaults let one call occupy
    // ~30s, which is longer than a tool gate should ever block.
    this.client = new sdk.TypeSafeClient(
      sdkClientConfig({
        apiKey: this.options.apiKey,
        baseURL: this.baseURL,
        logLevel: this.options.logLevel,
        timeout: this.options.timeout,
        retry: this.options.retry,
        allowSdkBodyLogging: this.options.allowSdkBodyLogging,
      }),
    )
    return this.client
  }

  async answer(request: JevRequest, signal?: AbortSignal): Promise<LiveResult> {
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

    let call: { data: unknown; requestId?: string | undefined }
    try {
      call = await callSystemOne(
        client,
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
      // retrying could ever help — and the correlation id, which is the one
      // thing worth having when someone has to ask the vendor what happened.
      throw classifyProviderFailure(cause, {
        providerId: this.id,
        label: 'TypeSafe',
        signal,
        requestId: requestIdOf(cause),
      })
    } finally {
      budget.dispose()
    }

    const response = call.data
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
      ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
    }
  }
}
