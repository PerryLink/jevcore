/**
 * Turning a failed outbound call into a code a caller can act on.
 *
 * Both providers used to classify failures from the status alone and collapse
 * everything into one bucket. The narrower statements were wrong in different
 * ways:
 *
 *  - `live.ts` had `status === 401 || status === 403 ? 'upstream-rejected' :
 *    status === undefined ? 'upstream-unreachable' : 'upstream-rejected'` — three
 *    branches that produce two outcomes, so 429, 402, 422 and 500 all arrived as
 *    "the upstream rejected the request".
 *  - `openrouter.ts` had `status === 401 || status === 403 || status !==
 *    undefined ? 'upstream-rejected' : 'upstream-unreachable'`. The third test
 *    subsumes the first two, so that condition is true whenever a status exists
 *    at all: the 401/403 branch was dead code, and so was almost the whole
 *    expression.
 *
 * The practical cost is a caller that cannot tell "back off and retry" (429,
 * 529) from "your key is wrong" (401), "you are out of credit" (402), "your
 * request is malformed" (422), or "the user cancelled". Those call for opposite
 * reactions, and TypeSafe's own error table lists 401 / 422 / 429 / 529 as
 * distinct outcomes with distinct handling — 529 explicitly says "retry after a
 * short delay".
 *
 * One deliberate property of everything here: the upstream body is never read,
 * echoed, or included in a message. The docs are clear that a rejected request's
 * body can quote the offending field, and request headers are what this package
 * exists to keep out of logs.
 */

import { isRecord } from '../answers.js'
import { DEFAULT_REQUEST_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_MS } from '../config.js'
import { JevProviderError, type JevErrorCode } from '../types.js'

/** Everything the classifier needs to describe one failure. */
export interface ProviderCallContext {
  /** Provider identity, recorded on the thrown error. */
  readonly providerId: string
  /** The name this provider uses for itself in messages, e.g. `"TypeSafe"`. */
  readonly label: string
  /** The caller's signal, so a cancellation is not reported as a timeout. */
  readonly signal?: AbortSignal | undefined
}

/**
 * The per-attempt timeout to hand the SDK when the caller asked for "none".
 *
 * The SDK's `assertPositiveMs` throws for any value `<= 0`, so passing a
 * configured `0` straight through did not disable the timeout: it made every
 * call fail with `\`timeout\` must be a positive number of milliseconds, got 0`
 * before a socket was even opened — and that failure was then reported as a
 * network problem. A day is the honest encoding of "no per-attempt deadline":
 * long enough that no real attempt reaches it, finite so it stays a number the
 * SDK accepts, and still bounded by the call's total budget.
 */
export const NO_PER_ATTEMPT_TIMEOUT_MS: number = 86_400_000

/** The status the SDK put on its error, without assuming its class. */
export const statusOf = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined
  for (const key of ['statusCode', 'status'] as const) {
    const value = error[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * The delay the upstream asked for, in milliseconds, when it named one.
 *
 * The SDK hands back an API error carrying a `Headers` instance, so the header
 * spelling (`retry-after` in seconds, `retry-after-ms` in milliseconds) is read
 * first, and a plain object with either key is accepted as well for transports
 * that do not use `Headers`.
 */
export const retryAfterOf = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined
  /** A header value is only a delay when it parses to a finite, non-negative number. */
  const parse = (raw: string | null | undefined): number | undefined => {
    if (raw === null || raw === undefined) return undefined
    const trimmed = raw.trim()
    // `Number(null)` is 0 and `Number('')` is 0, so a missing or blank header
    // would otherwise read as "retry immediately".
    if (trimmed.length === 0) return undefined
    const value = Number(trimmed)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }

  const headers = error.headers
  if (isRecord(headers) && typeof headers.get === 'function') {
    const read = (headers as unknown as { get(name: string): string | null }).get.bind(headers)
    // `retry-after-ms` wins: it is the same instruction at a finer resolution.
    const ms = parse(read('retry-after-ms'))
    if (ms !== undefined) return ms
    const seconds = parse(read('retry-after'))
    return seconds === undefined ? undefined : seconds * 1_000
  }
  const directMs = parse(error['retry-after-ms'] as string | undefined)
  if (directMs !== undefined) return directMs
  const seconds = parse(error['retry-after'] as string | undefined)
  return seconds === undefined ? undefined : seconds * 1_000
}

/** The error names that mean "this call ran out of time". */
const TIMEOUT_NAMES = new Set(['TimeoutError', 'APITimeoutError'])

/** The error names that mean "the caller pulled the plug". */
const ABORT_NAMES = new Set(['AbortError', 'APIUserAbortError'])

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : ''

/** Whether one attempt ran out of time rather than failing for another reason. */
export const isTimeoutFailure = (error: unknown): boolean =>
  TIMEOUT_NAMES.has(nameOf(error)) || statusOf(error) === 408

/** Whether the caller aborted, rather than the call failing on its own. */
export const isAbortFailure = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || ABORT_NAMES.has(nameOf(error))

/**
 * Map an HTTP status to the code a caller should branch on.
 *
 * Exported so the mapping is testable directly, and so a caller classifying its
 * own transport errors cannot drift from what the providers do.
 *
 * `422` is the documented "the request body failed validation". `402` is not in
 * TypeSafe's table but is the conventional "payment required", and treating it
 * as a rejection would send a caller into a retry loop against an empty account.
 * `529` is TypeSafe's own "temporarily overloaded"; `503` is its HTTP cousin.
 * Anything else in the 5xx range is `upstream-unreachable`: the request was
 * fine as far as anyone can tell and the server could not answer it.
 */
export const classifyStatus = (status: number): JevErrorCode => {
  if (status === 401 || status === 403) return 'upstream-rejected'
  if (status === 402) return 'quota-exceeded'
  if (status === 429) return 'rate-limited'
  if (status === 529 || status === 503) return 'overloaded'
  if (status === 404) return 'invalid-request'
  if (status >= 400 && status < 500) return 'invalid-request'
  if (status >= 500) return 'upstream-unreachable'
  // A 1xx/2xx/3xx that arrived as a failure is not a rejection: something other
  // than a decision came back, which is what `malformed-response` describes.
  return 'malformed-response'
}

/**
 * Classify a thrown transport failure.
 *
 * Order matters. A caller aborts by definition, so their signal wins over
 * everything the error says about itself — including a `TimeoutError`, which is
 * what `AbortSignal.timeout` raises when *our* budget fires while the caller's
 * own signal is also set. Timeouts come next, then the status.
 */
export const classifyProviderFailure = (
  cause: unknown,
  context: ProviderCallContext,
): JevProviderError => {
  const status = statusOf(cause)
  const retryAfterMs = retryAfterOf(cause)
  const evidence = {
    // `cause` is attached for debugging; nothing here reads its body.
    cause,
    providerId: context.providerId,
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }

  if (isAbortFailure(cause, context.signal)) {
    return new JevProviderError(
      `${context.label} call was aborted before an answer arrived.`,
      'aborted',
      evidence,
    )
  }

  if (isTimeoutFailure(cause)) {
    return new JevProviderError(
      status === undefined
        ? `${context.label} call timed out before an answer arrived.`
        : `${context.label} call timed out after HTTP ${status}.`,
      'timeout',
      evidence,
    )
  }

  if (status === undefined) {
    // No status and no abort: the request never got a response. Connection
    // refused, DNS failure, socket reset — the original `upstream-unreachable`.
    return new JevProviderError(
      `${context.label} request failed before a response arrived (network or timeout).`,
      'upstream-unreachable',
      evidence,
    )
  }

  const code = classifyStatus(status)
  return new JevProviderError(
    `${context.label} rejected the request with HTTP ${status} (${code}).`,
    code,
    evidence,
  )
}

/**
 * The per-attempt timeout a caller gets when they configure none.
 *
 * Shared with configuration rather than restated: `DEFAULT_CONFIG.requestTimeoutMs`
 * resolves to this same number, so the value a caller reads in the config
 * surface and the value the transport ends up using cannot drift. It is the same
 * 10_000 the upstream SDK documents as its own default.
 */
export const DEFAULT_PER_ATTEMPT_TIMEOUT_MS: number = DEFAULT_REQUEST_TIMEOUT_MS

/**
 * Retries after the first attempt, matching the SDK's documented default.
 *
 * Used here only to size the default total budget; the transport still receives
 * the caller's own `retry` setting.
 */
export const DEFAULT_MAX_RETRIES: number = DEFAULT_REQUEST_MAX_RETRIES

/**
 * The ceiling on one complete call: every attempt, plus every backoff between
 * them.
 *
 * This is the number that makes `timeout` mean what its name suggests. The SDK
 * is explicit that `timeout` is *"timeout per attempt in milliseconds, without a
 * total retry budget"*, so a configured per-attempt timeout says nothing about
 * how long a call can occupy — three attempts at 30s plus backoff is roughly
 * 90s. That is the quantity this exists to bound, and it is enforced here rather
 * than delegated, because the SDK has no such setting in JavaScript.
 *
 * Sized from the defaults it wraps:
 * `per-attempt timeout x (maxRetries + 1) + backoff`
 * `= 10_000 x 3 + ~10_000 = 40_000`. The arithmetic is derived rather than
 * written down, so raising the timeout or the retry count moves the ceiling with
 * it instead of silently cutting the last attempt short.
 *
 * It is a defensive ceiling rather than a second configurable timeout: it stays
 * out of the documented configuration surface on purpose, and a caller who needs
 * a different bound passes `totalBudgetMs` to the provider.
 */
export const DEFAULT_TOTAL_BUDGET_MS: number =
  DEFAULT_PER_ATTEMPT_TIMEOUT_MS * (DEFAULT_MAX_RETRIES + 1) + 10_000

/**
 * What one call's budget looks like once it has been armed.
 *
 * `expired` distinguishes "the deadline passed" from "the caller cancelled",
 * which is the difference between `timeout` and `aborted` on the way out.
 */
export interface CallBudget {
  /** The signal to hand the SDK: the caller's, or one that also honours the budget. */
  readonly signal: AbortSignal | undefined
  /** Whether the budget itself fired, rather than the caller aborting. */
  readonly expired: () => boolean
  /** Clear the timer. Always call it, in a `finally`. */
  readonly dispose: () => void
}

/**
 * Arm the total budget for one call.
 *
 * The returned signal aborts when either the caller's signal aborts or the
 * deadline passes. The abort reason is named `TimeoutError` when the budget is
 * what fired, so the existing timeout classification below reports it as a
 * timeout without a second code path.
 */
export const armCallBudget = (budgetMs: number | undefined, signal?: AbortSignal): CallBudget => {
  if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    return { signal, expired: () => false, dispose: () => {} }
  }

  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    const reason = new Error(`the call exceeded its total budget of ${budgetMs}ms`)
    reason.name = 'TimeoutError'
    controller.abort(reason)
  }, budgetMs)
  // Do not hold the event loop open for a call that already finished.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }

  const signalOut =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])

  return {
    signal: signalOut,
    expired: () => expired,
    dispose: () => clearTimeout(timer),
  }
}
