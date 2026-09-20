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
  CategoricalAnswer,
  JevAnswer,
  JevProvider,
  JevRequest,
  JevResult,
  JevUsage,
  NoulAnswer,
} from '../types.js'
import { JevProviderError } from '../types.js'

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai'
export const DEFAULT_MODEL = 'jev-latest'

/** The subset of the official SDK this provider uses. */
interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: unknown; model?: string },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

interface SdkModule {
  TypeSafeClient: new (config: {
    apiKey: string
    baseURL?: string
    dangerouslyAllowBrowser?: boolean
  }) => SystemOneClient
}

export interface LiveProviderOptions {
  /** Resolved API key. Never sourced from the environment by this class. */
  readonly apiKey: string
  /** API root. Defaults to {@link DEFAULT_ENDPOINT}. */
  readonly baseURL?: string
  /** Model name. Defaults to {@link DEFAULT_MODEL}. */
  readonly model?: string
  /** Injectable for tests, so no test needs a real key or a real socket. */
  readonly loadSdk?: () => Promise<SdkModule>
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Pull the numeric fields the SDK reports, ignoring anything unshaped. */
const readUsage = (value: unknown): JevUsage | undefined => {
  if (!isRecord(value)) return undefined
  const usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
  if (typeof value.input_tokens === 'number') usage.inputTokens = value.input_tokens
  if (typeof value.output_tokens === 'number') usage.outputTokens = value.output_tokens
  if (typeof value.cost_usd === 'number') usage.costUsd = value.cost_usd
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Normalize the SDK's answer payload.
 *
 * Anything that does not match a known primitive shape is dropped rather than
 * coerced: a caller that receives no answer knows to fall back, whereas a
 * coerced answer is indistinguishable from a real one.
 */
const normalizeAnswer = (raw: unknown, expected: 'noul' | 'choice' | 'score'): JevAnswer | undefined => {
  if (!isRecord(raw)) return undefined

  if (expected === 'noul') {
    const value = raw.noul
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    const answer: NoulAnswer = {
      type: 'noul',
      noul: value,
      ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    }
    return answer
  }

  const choice = typeof raw.choice === 'string' ? raw.choice : undefined
  if (choice === undefined) return undefined
  const probabilities: Record<string, number> = {}
  if (isRecord(raw.probabilities)) {
    for (const [key, value] of Object.entries(raw.probabilities)) {
      if (typeof value === 'number' && Number.isFinite(value)) probabilities[key] = value
    }
  }
  const answer: CategoricalAnswer = {
    type: expected,
    choice,
    probabilities,
    ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
  }
  return answer
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
    // apiKey is always passed, so the SDK never falls back to the environment.
    this.client = new sdk.TypeSafeClient({
      apiKey: this.options.apiKey,
      baseURL: this.baseURL,
      // This runs inside a DSH host process, never a browser page.
      dangerouslyAllowBrowser: false,
    })
    return this.client
  }

  async answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const startedAt = Date.now()
    const client = await this.clientForRequest()

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
        signal === undefined ? {} : { signal },
      )
    } catch (cause) {
      // The SDK distinguishes rate limits, auth failures, and transport
      // errors. Preserve the distinction without leaking response bodies,
      // which can echo request headers.
      const status = isRecord(cause) && typeof cause.status === 'number' ? cause.status : undefined
      const code =
        status === 401 || status === 403
          ? 'upstream-rejected'
          : status === undefined
            ? 'upstream-unreachable'
            : 'upstream-rejected'
      throw new JevProviderError(
        status === undefined
          ? 'TypeSafe request failed before a response arrived (network or timeout).'
          : `TypeSafe rejected the request with HTTP ${status}.`,
        code,
        { cause },
      )
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
