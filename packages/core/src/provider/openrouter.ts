/**
 * The OpenRouter provider.
 *
 * OpenRouter hosts the System One models behind its own Decisions route
 * (`POST /api/alpha/decisions`), which takes the same three primitives TypeSafe
 * serves — `noul`, `choice`, `score` — plus a `model` field naming which one to
 * use. That makes it a real second route to Jev rather than an approximation of
 * one, and it matters because obtaining a TypeSafe key is not always practical:
 * if you already have an OpenRouter key, this unblocks live judgments without
 * waiting for one.
 *
 * Two things to know before enabling it:
 *
 *  - **The route is `alpha`.** It is declared as such in OpenRouter's own SDK, so
 *    treat the shape as subject to change and pin your expectations loosely.
 *  - **Your state goes to OpenRouter, not to TypeSafe.** That is a different
 *    third party with different retention and logging. The egress contract
 *    reports the endpoint for exactly this reason; read it rather than assuming
 *    the destination from the provider's name.
 *
 * Delegates to the official `@openrouter/sdk` rather than hand-rolling HTTP, so
 * retries, error classification and request validation are the vendor's. The SDK
 * is loaded lazily and is an optional dependency: an install without it still
 * gets the mock.
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

export const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai'
export const DEFAULT_OPENROUTER_MODEL = 'typesafe/jev-1.13'

/**
 * The only model prefix this provider will call.
 *
 * The Decisions route is OpenRouter's System One surface, and a model id that is
 * not one of TypeSafe's would be routed to something that answers with prose —
 * which this plugin would then have to discard or, worse, misread. Refusing up
 * front is cheaper than debugging that.
 */
export const OPENROUTER_MODEL_PREFIX = 'typesafe/'

/** The subset of the OpenRouter SDK this provider uses. */
interface DecisionsClient {
  alpha: {
    decisions: {
      create(
        request: {
          decisionsRequest: {
            model: string
            state: unknown
            questions: unknown
            sessionId?: string
          }
        },
        options?: { signal?: AbortSignal },
      ): Promise<unknown>
    }
  }
}

interface SdkModule {
  OpenRouter: new (config: { apiKey: string; serverURL?: string }) => DecisionsClient
}

export interface OpenRouterProviderOptions {
  /** Resolved OpenRouter API key. Never sourced from the environment here. */
  readonly apiKey: string
  /** API root. Defaults to {@link DEFAULT_OPENROUTER_ENDPOINT}. */
  readonly baseURL?: string
  /** Model id. Must carry the `typesafe/` prefix. */
  readonly model?: string
  /** Injectable for tests, so no test needs a real key or a socket. */
  readonly loadSdk?: () => Promise<SdkModule>
}

/**
 * Refuse an endpoint that would send prompts in cleartext.
 *
 * Same rule as the TypeSafe provider: https, or http on loopback for a local
 * proxy under test.
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

/** Throw unless the model is one of TypeSafe's. */
export const assertSystemOneModel = (model: string): string => {
  if (!model.startsWith(OPENROUTER_MODEL_PREFIX)) {
    throw new JevProviderError(
      `provider "openrouter" can only call System One models, whose ids start with ` +
        `"${OPENROUTER_MODEL_PREFIX}". Got "${model}". Other models answer with prose, which this ` +
        `plugin cannot interpret as a decision.`,
      'provider-unavailable',
    )
  }
  return model
}

export const loadOpenRouterSdk = async (
  specifier = '@openrouter/sdk',
): Promise<SdkModule> => {
  try {
    return (await import(specifier)) as unknown as SdkModule
  } catch (cause) {
    throw new JevProviderError(
      'provider "openrouter" needs the official SDK. Install it with ' +
        '`npm install @openrouter/sdk`, or use "live" with a TypeSafe key, or stay on the mock.',
      'provider-unavailable',
      { cause },
    )
  }
}

/**
 * Pull the usage fields the SDK reports.
 *
 * The vendor is inconsistent here, so both spellings are read:
 *
 *  - the wire schema (`DecisionsResponseUsage$inboundSchema`) requires
 *    snake_case `input_tokens` / `output_tokens`;
 *  - the TypeScript type (`DecisionsResponseUsage`) declares camelCase
 *    `inputTokens` / `outputTokens`, and the generated `fromJSON` remaps wire
 *    keys to those names.
 *
 * Which spelling arrives depends on whether the SDK has already deserialized
 * the response, and reading the wrong one does not throw — it silently reports
 * no usage at all. Accepting both is the only option that is correct either way.
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

/** Read an HTTP-ish status off an SDK error without assuming its class. */
const statusOf = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined
  for (const key of ['statusCode', 'status'] as const) {
    const value = error[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Detect the account-level provider allowlist failure.
 *
 * OpenRouter answers a model whose provider the account has not permitted with
 * HTTP 404 and a body saying so. The status alone reads as "the model does not
 * exist", which sends the reader hunting for a typo in a model id that is
 * perfectly valid. The message is the only signal that distinguishes the two,
 * so it is worth matching on — narrowly, and only to pick a better error.
 */
const isProviderNotAllowed = (error: unknown): boolean =>
  isRecord(error) &&
  typeof error.message === 'string' &&
  /no allowed providers|allowed-providers setting/i.test(error.message)

/** A provider backed by OpenRouter's Decisions route. */
export class OpenRouterProvider implements JevProvider {
  readonly id = 'openrouter'
  private readonly baseURL: string
  private readonly model: string
  private client: DecisionsClient | undefined

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.baseURL = assertUsableOpenRouterEndpoint(options.baseURL ?? DEFAULT_OPENROUTER_ENDPOINT)
    this.model = assertSystemOneModel(options.model ?? DEFAULT_OPENROUTER_MODEL)
  }

  /** The endpoint this provider will POST to. Used by the startup report. */
  get endpoint(): string {
    return `${this.baseURL}/api/alpha/decisions`
  }

  /** The model id being called, for the report. */
  get modelId(): string {
    return this.model
  }

  private async clientForRequest(): Promise<DecisionsClient> {
    if (this.client !== undefined) return this.client
    const load = this.options.loadSdk ?? loadOpenRouterSdk
    const sdk = await load()
    // apiKey is always passed, so the SDK never falls back to the environment.
    this.client = new sdk.OpenRouter({ apiKey: this.options.apiKey, serverURL: this.baseURL })
    return this.client
  }

  async answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const startedAt = Date.now()
    const client = await this.clientForRequest()
    const model = request.model ?? this.model
    assertSystemOneModel(model)

    let response: unknown
    try {
      response = await client.alpha.decisions.create(
        {
          // The route wraps its payload; the SDK rejects a bare object.
          decisionsRequest: {
            model,
            state: request.state,
            questions: request.questions,
          },
        },
        signal === undefined ? {} : { signal },
      )
    } catch (cause) {
      // Classify without echoing the upstream body, which can quote request
      // headers. A 401/403 is a credential or access problem; anything else is
      // treated as a transport failure.
      if (isProviderNotAllowed(cause)) {
        throw new JevProviderError(
          'OpenRouter refused the request because this account does not permit the "typesafe" ' +
            'provider. System One models are served by TypeSafe alone, so no other provider can ' +
            'answer them. Enable it under "Allowed providers" at ' +
            'https://openrouter.ai/settings/privacy and retry.',
          'provider-unavailable',
          { cause },
        )
      }
      const status = statusOf(cause)
      const code =
        status === 401 || status === 403
          ? 'upstream-rejected'
          : status === undefined
            ? 'upstream-unreachable'
            : 'upstream-rejected'
      throw new JevProviderError(
        status === undefined
          ? 'OpenRouter request failed before a response arrived (network or timeout).'
          : `OpenRouter rejected the request with HTTP ${status}.`,
        code,
        { cause },
      )
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

    const answers: Record<string, JevAnswer> = {}
    for (const [questionId, question] of Object.entries(request.questions)) {
      const answer = normalizeAnswer(rawAnswers[questionId], question.type)
      if (answer !== undefined) answers[questionId] = answer
    }

    const reported = typeof response.model === 'string' ? response.model : model
    const usage = readUsage(response.usage)

    return {
      model: reported,
      answers,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: Date.now() - startedAt,
      provider: this.id,
    }
  }
}
