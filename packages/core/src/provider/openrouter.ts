/**
 * The OpenRouter provider.
 *
 * OpenRouter serves the System One models at `https://openrouter.ai/api/v1/systemone`
 * — the **same endpoint path** TypeSafe serves, documented by OpenRouter as the
 * supported way to reach Jev without a TypeSafe key. So this route is not a second
 * protocol to implement: it is the official client with a different `baseURL` and
 * the caller's own OpenRouter key.
 *
 * ```
 * const client = new TypeSafeClient({
 *   apiKey: openRouterKey,
 *   baseURL: 'https://openrouter.ai/api',   // the SDK appends /v1/systemone
 * })
 * ```
 *
 * This previously spoke to OpenRouter's own `POST /api/alpha/decisions` through
 * `@openrouter/sdk`, a second client for a second, `alpha`-named shape. Two reasons
 * that was wrong: the route is declared alpha by OpenRouter's own SDK while the
 * documented one is the TypeSafe path, and maintaining a translation layer meant
 * this provider and `LiveProvider` could disagree about what a valid request is —
 * which they did, in a way that made the DSH plugin throw at startup on the shared
 * default model while the MCP server quietly substituted another.
 *
 * What is genuinely different is the destination, not the shape: state goes to
 * OpenRouter rather than TypeSafe, which is a different third party with different
 * retention. The egress report names this endpoint for that reason.
 *
 * @see https://openrouter.ai/docs/guides/community/typesafe-sdk
 */

import type { JevProvider, JevRequest, JevResult, JevUsage } from '../types.js'
import { JevProviderError } from '../types.js'
import { isRecord, normalizeAnswer } from '../answers.js'
import {
  DEFAULT_TOTAL_BUDGET_MS,
  armCallBudget,
  classifyProviderFailure,
} from './classify.js'
import {
  DEFAULT_MODEL,
  loadOfficialSdk,
  sdkClientConfig,
  type ProviderLogLevel,
  type SdkModule,
  type SystemOneClient,
} from './live.js'

/**
 * OpenRouter's API root.
 *
 * Note the `/api`: the SDK appends `/v1/systemone`, so the endpoint this provider
 * posts to is `https://openrouter.ai/api/v1/systemone`. Passing the bare origin
 * would post to `/v1/systemone` and miss the route entirely.
 */
export const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api'

/**
 * The model prefix TypeSafe's ids carry on OpenRouter.
 *
 * Both a bare id (`jev-1.13`) and a prefixed one (`typesafe/jev-1.13`) are
 * accepted by the route; OpenRouter maps the bare form onto its own namespace.
 */
export const OPENROUTER_MODEL_PREFIX = 'typesafe/'

/**
 * The model to call when the caller names none.
 *
 * Deliberately the same default as the TypeSafe route. A bare `jev-*` id works on
 * both, so there is no reason for the two entry points to disagree — and they used
 * to, because the guard here rejected bare ids and the MCP runtime worked around
 * it by substituting a prefixed one.
 */
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_MODEL

export interface OpenRouterProviderOptions {
  /** Resolved OpenRouter API key. Never sourced from the environment here. */
  readonly apiKey: string
  /** API root. Defaults to {@link DEFAULT_OPENROUTER_ENDPOINT}. */
  readonly baseURL?: string
  /** Model id. A bare `jev-*` id, or one carrying the `typesafe/` prefix. */
  readonly model?: string
  /** SDK log level, passed explicitly so the environment cannot raise it. */
  readonly logLevel?: ProviderLogLevel
  /**
   * Let the SDK print request bodies, including the state this package redacted.
   *
   * Off by default. The SDK's `debug` level logs `body: req.body` with the body
   * unredacted (`@typesafe-ai/sdk@0.6.0`, `dist/index.mjs:598`), so `debug` is
   * forwarded at the body-safe level unless this is set. See
   * {@link sdkLogLevelFor}, which both routes share.
   */
  readonly allowSdkBodyLogging?: boolean
  /**
   * Milliseconds per attempt, **not per call**.
   *
   * Shared with the TypeSafe route, including the meaning of `0`: no per-attempt
   * deadline, encoded as a finite number the SDK accepts because its own
   * `assertPositiveMs` rejects `0` outright.
   */
  readonly timeout?: number
  /**
   * Ceiling on one complete call, in milliseconds: every attempt plus every
   * backoff between them. Defaults to `DEFAULT_TOTAL_BUDGET_MS` (40_000), the
   * same shared default as the TypeSafe route.
   */
  readonly totalBudgetMs?: number
  /** Retry overrides, e.g. `{ maxRetries: 0 }` to fail fast inside a gate. */
  readonly retry?: Readonly<Record<string, unknown>>
  /** Injectable for tests, so no test needs a real key or a socket. */
  readonly loadSdk?: () => Promise<SdkModule>
}

/**
 * Refuse an endpoint that would send prompts in cleartext.
 *
 * Same rule as the TypeSafe route: https, or http on loopback for a local proxy.
 */
export const assertUsableOpenRouterEndpoint = (baseURL: string): string => {
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new JevProviderError(
      `OpenRouter baseURL is not a valid URL: ${baseURL}`,
      'provider-unavailable',
    )
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new JevProviderError(
      `OpenRouter baseURL must use https (loopback http is allowed for local testing), got ` +
        `${parsed.protocol}//${parsed.hostname}`,
      'provider-unavailable',
    )
  }
  return baseURL.replace(/\/+$/, '')
}

/**
 * Throw unless the model is one of TypeSafe's.
 *
 * Both accepted shapes were verified against the live route:
 *
 *  - bare `jev-*`, which OpenRouter maps onto its own namespace;
 *  - `typesafe/jev-*`, passed through as-is.
 *
 * The guard still earns its place — a model from another family answers with prose
 * this package cannot read as a decision — but it must not reject the bare form,
 * which is the package default. Note that the prefix alone proves nothing: live,
 * `typesafe/jev-1.13` resolves and `typesafe/jev-latest` does **not**.
 */
export const assertSystemOneModel = (model: string): string => {
  const trimmed = model.trim()
  if (trimmed.length === 0) {
    throw new JevProviderError(
      'provider "openrouter" needs a model id; got an empty string.',
      'provider-unavailable',
    )
  }
  const jevFamily = /^jev-[a-z0-9][a-z0-9.-]*$/i
  const prefixed = trimmed.startsWith(OPENROUTER_MODEL_PREFIX)
    ? trimmed.slice(OPENROUTER_MODEL_PREFIX.length)
    : undefined
  if (jevFamily.test(trimmed) || (prefixed !== undefined && jevFamily.test(prefixed))) {
    return trimmed
  }
  throw new JevProviderError(
    `provider "openrouter" can only call System One models: a bare id such as "jev-1.13", or ` +
      `one carrying the "${OPENROUTER_MODEL_PREFIX}" prefix. Got "${trimmed}". Other models ` +
      `answer with prose, which this plugin cannot interpret as a decision.`,
    'provider-unavailable',
  )
}

/**
 * Pull the usage fields the SDK reports.
 *
 * Read from both spellings because the vendor is inconsistent: the wire shape is
 * snake_case (`input_tokens`, `cost`) while the SDK's TypeScript type declares
 * camelCase and its `fromJSON` remaps one to the other. Reading the wrong spelling
 * does not throw — it reports no usage at all.
 */
const readUsage = (value: unknown): JevUsage | undefined => {
  if (!isRecord(value)) return undefined
  const count = (camel: string, snake: string): number | undefined => {
    const entry = typeof value[camel] === 'number' ? value[camel] : value[snake]
    return typeof entry === 'number' && Number.isFinite(entry) ? entry : undefined
  }
  const usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
  const inputTokens = count('inputTokens', 'input_tokens')
  const outputTokens = count('outputTokens', 'output_tokens')
  const costUsd = count('cost', 'cost_usd')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (costUsd !== undefined) usage.costUsd = costUsd
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * A provider backed by OpenRouter, over the official TypeSafe client.
 *
 * It shares that client with {@link LiveProvider} precisely so the two routes
 * cannot drift: the request shape, the answer normalization and the error
 * classification are the same code, and only the destination differs.
 */
export class OpenRouterProvider implements JevProvider {
  readonly id = 'openrouter'
  private readonly baseURL: string
  private readonly model: string
  private client: SystemOneClient | undefined

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.baseURL = assertUsableOpenRouterEndpoint(options.baseURL ?? DEFAULT_OPENROUTER_ENDPOINT)
    this.model = assertSystemOneModel(options.model ?? DEFAULT_OPENROUTER_MODEL)
  }

  /** The endpoint this provider will POST to. Used by the startup report. */
  get endpoint(): string {
    return `${this.baseURL}/v1/systemone`
  }

  /** The model id being called, for the report. */
  get modelId(): string {
    return this.model
  }

  private async clientForRequest(): Promise<SystemOneClient> {
    if (this.client !== undefined) return this.client
    const load = this.options.loadSdk ?? loadOfficialSdk
    const sdk = await load()
    // Built by the one shared builder, for the same reasons as the TypeSafe
    // route: the key is never left to the environment, `logLevel` is never left
    // to it either, and `debug` is clamped so this route cannot write request
    // bodies — which the SDK's `debug` level does, headers redacted and bodies
    // not (`@typesafe-ai/sdk@0.6.0`, `dist/index.mjs:596-599`). This provider's
    // own options carry the same escape hatch as the TypeSafe route's, named
    // after the consequence: {@link OpenRouterProviderOptions.allowSdkBodyLogging}.
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

  async answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const startedAt = Date.now()
    const client = await this.clientForRequest()
    const model = assertSystemOneModel(request.model ?? this.model)

    // The same shared ceiling as the TypeSafe route: `timeout` is per attempt
    // and the SDK has no total budget, so this is what actually bounds the call.
    const budget = armCallBudget(
      this.options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS,
      signal,
    )

    let response: unknown
    try {
      response = await client.systemOne(
        {
          state: request.state,
          questions: request.questions,
          model,
        },
        budget.signal === undefined ? {} : { signal: budget.signal },
      )
    } catch (cause) {
      // Classify from the status alone; never echo the upstream body, which can
      // quote request headers. The classification is shared with the TypeSafe
      // route, so the two cannot disagree about what a 429 means — and this
      // condition used to be `status === 401 || status === 403 || status !==
      // undefined`, which is true whenever a status exists at all.
      throw classifyProviderFailure(cause, {
        providerId: this.id,
        label: 'OpenRouter',
        signal,
      })
    } finally {
      budget.dispose()
    }

    if (!isRecord(response)) {
      throw new JevProviderError(
        'OpenRouter returned a response that is not an object.',
        'malformed-response',
      )
    }

    const rawAnswers = isRecord(response.answers) ? response.answers : undefined
    if (rawAnswers === undefined) {
      throw new JevProviderError('OpenRouter response has no "answers" object.', 'malformed-response')
    }

    const answers: Record<string, ReturnType<typeof normalizeAnswer>> = {}
    for (const [questionId, question] of Object.entries(request.questions)) {
      const answer = normalizeAnswer(rawAnswers[questionId], question.type)
      if (answer !== undefined) answers[questionId] = answer
    }

    const reported = typeof response.model === 'string' ? response.model : model
    const usage = readUsage(response.usage)

    return {
      model: reported,
      answers: answers as JevResult['answers'],
      ...(usage === undefined ? {} : { usage }),
      latencyMs: Date.now() - startedAt,
      provider: this.id,
    }
  }
}
