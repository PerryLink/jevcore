/**
 * Failure classification, and the difference between a timeout and a budget.
 *
 * Two defects are pinned here.
 *
 * **1. Every status became one code.** The live provider's condition was
 * `status === 401 || status === 403 ? 'upstream-rejected' : status === undefined
 * ? 'upstream-unreachable' : 'upstream-rejected'` — three branches, two outcomes,
 * so 429/402/422/500 all arrived as "the upstream rejected the request". The
 * OpenRouter provider's was `status === 401 || status === 403 || status !==
 * undefined`, which is true whenever a status exists at all: the 401/403 test was
 * dead code. A caller could not tell "back off and retry" from "your key is
 * wrong" from "your account is empty" from "your request is malformed", and
 * those need opposite reactions. TypeSafe's own error table lists 401 / 422 /
 * 429 / 529 as distinct, with 529 explicitly telling the caller to retry shortly.
 *
 * **2. `timeout` was per attempt while reading as per call.** The SDK documents
 * "timeout per attempt in milliseconds, **without a total retry budget**", so
 * three attempts plus backoff is the real worst case — roughly 90s under the
 * previous 30s setting, which is the quantity that setting's comment claimed to
 * bound. The providers now arm a total budget around the whole call and the
 * budget is what aborts it.
 *
 * A third, smaller one lives in the same area: `requestTimeoutMs: 0` was
 * documented as "disables the timeout" and passed straight through to an SDK
 * whose `assertPositiveMs` throws for any value `<= 0`. Every call failed before
 * a socket opened, and the failure was reported as "network or timeout".
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CALL_TOTAL_BUDGET_MS,
  DEFAULT_CONFIG,
  DEFAULT_REQUEST_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LiveProvider,
  NO_PER_ATTEMPT_TIMEOUT_MS,
  OpenRouterProvider,
  classifyProviderFailure,
  classifyStatus,
  retryAfterOf,
  statusOf,
  timeoutForSdk,
  type JevErrorCode,
} from '../src/index.js'

const QUESTION = { q: { type: 'noul' as const, instructions: 'ok?' } }

/**
 * The error a transport raises when a deadline passes.
 *
 * `DOMException(..., 'TimeoutError')` is exactly what `AbortSignal.timeout`
 * raises, and what the total budget installs as its own abort reason, so this is
 * the shape the classifier actually has to recognise.
 */
const timeoutError = (): DOMException => new DOMException('the operation timed out', 'TimeoutError')

/** An SDK stub that rejects the way the transport would. */
const failingSdk = (error: unknown) => ({
  module: {
    TypeSafeClient: class {
      async systemOne(): Promise<never> {
        throw error
      }
    },
  } as never,
})

/** An SDK stub that never answers, and reports when it was aborted. */
const neverAnsweringSdk = (onAbort?: () => void) => {
  const stub = {
    TypeSafeClient: class {
      systemOne(_request: unknown, options?: { signal?: AbortSignal }): Promise<never> {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal
          if (signal === undefined) return
          const fail = () => {
            onAbort?.()
            reject(timeoutError())
          }
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail, { once: true })
        })
      }
    },
  }
  return { module: stub as never }
}

/** What a provider threw, as a plain object, without rethrowing. */
const failureOf = async (promise: Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await promise
  } catch (error) {
    return error as Record<string, unknown>
  }
  throw new Error('the provider resolved, so there was no failure to classify')
}

const liveFailing = (error: unknown) =>
  new LiveProvider({
    apiKey: 'k',
    loadSdk: async () => failingSdk(error).module,
    retry: { maxRetries: 0 },
  })

const openRouterFailing = (error: unknown) =>
  new OpenRouterProvider({
    apiKey: 'k',
    loadSdk: async () => failingSdk(error).module,
    retry: { maxRetries: 0 },
  })

describe('status classification is a decision, not a bucket', () => {
  it('maps every documented status to its own code', () => {
    const expected: Record<number, JevErrorCode> = {
      401: 'upstream-rejected',
      403: 'upstream-rejected',
      402: 'quota-exceeded',
      422: 'invalid-request',
      429: 'rate-limited',
      529: 'overloaded',
      503: 'overloaded',
      500: 'upstream-unreachable',
      502: 'upstream-unreachable',
      400: 'invalid-request',
    }
    for (const [status, code] of Object.entries(expected)) {
      expect(classifyStatus(Number(status)), `HTTP ${status}`).toBe(code)
    }
  })

  it('keeps retryable and non-retryable statuses apart', () => {
    // The distinction the old code erased. Retrying a 401 or a 402 loops
    // forever; not retrying a 429 throws away a call the server asked us to
    // repeat.
    for (const status of [429, 529, 503]) {
      expect(classifyStatus(status), `HTTP ${status}`).not.toBe('upstream-rejected')
    }
    expect(classifyStatus(401)).toBe('upstream-rejected')
    expect(classifyStatus(402)).toBe('quota-exceeded')
  })
})

describe('both providers classify identically', () => {
  const cases: ReadonlyArray<readonly [number, JevErrorCode]> = [
    [401, 'upstream-rejected'],
    [403, 'upstream-rejected'],
    [402, 'quota-exceeded'],
    [422, 'invalid-request'],
    [429, 'rate-limited'],
    [529, 'overloaded'],
    [500, 'upstream-unreachable'],
  ]

  for (const [status, code] of cases) {
    it(`reports HTTP ${status} as ${code} on both routes`, async () => {
      const live = await failureOf(liveFailing({ status }).answer({ state: 's', questions: QUESTION }))
      const openrouter = await failureOf(
        openRouterFailing({ status }).answer({ state: 's', questions: QUESTION }),
      )
      expect(live.code, `live ${status}`).toBe(code)
      expect(openrouter.code, `openrouter ${status}`).toBe(code)
      // The raw status travels with the code, so a caller logging or alerting on
      // the exact status does not have to re-derive it from the message.
      expect(live.status).toBe(status)
      expect(openrouter.status).toBe(status)
      expect(live.providerId).toBe('live')
      expect(openrouter.providerId).toBe('openrouter')
      expect(String(live.message)).toContain(`HTTP ${status}`)
    })
  }

  it('reports a transport failure with no status as unreachable', async () => {
    const failure = await failureOf(
      liveFailing(new Error('socket hang up')).answer({ state: 's', questions: QUESTION }),
    )
    expect(failure.code).toBe('upstream-unreachable')
    expect(failure.status).toBeUndefined()
  })

  it('carries the Retry-After the upstream asked for', async () => {
    const failure = await failureOf(
      liveFailing({
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) },
      }).answer({ state: 's', questions: QUESTION }),
    )
    expect(failure.code).toBe('rate-limited')
    expect(failure.retryAfterMs).toBe(2_000)
  })

  it('reads retry-after-ms in preference to retry-after', async () => {
    expect(
      retryAfterOf({
        headers: { get: (name: string) => (name === 'retry-after-ms' ? '1500' : '9') },
      }),
    ).toBe(1_500)
  })

  it('treats a blank or absent Retry-After as no delay rather than zero', () => {
    // `Number(null)` is 0, which would read as "retry immediately".
    expect(retryAfterOf({ headers: { get: () => null } })).toBeUndefined()
    expect(retryAfterOf({ headers: { get: () => '' } })).toBeUndefined()
    expect(retryAfterOf(new Error('no headers'))).toBeUndefined()
  })

  it('never echoes the upstream body, whatever the status', async () => {
    const secret = 'ts_live_secretvalue'
    for (const route of [liveFailing, openRouterFailing]) {
      const failure = await failureOf(
        route({ status: 500, message: `Authorization: Bearer ${secret}` }).answer({
          state: 's',
          questions: QUESTION,
        }),
      )
      expect(String(failure.message)).not.toContain(secret)
    }
  })
})

describe('cancellation is not a timeout', () => {
  it('reports an already-aborted caller signal as aborted, not unreachable', async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = await failureOf(
      liveFailing(timeoutError()).answer({ state: 's', questions: QUESTION }, controller.signal),
    )
    // The caller's signal wins over what the error says about itself: they
    // cancelled, so reporting a timeout would send them looking for a fault.
    expect(failure.code).toBe('aborted')
  })

  it('reports an abort-shaped error as aborted even with no signal', async () => {
    const abortError = new Error('the user aborted a request')
    abortError.name = 'APIUserAbortError'
    const failure = await failureOf(
      liveFailing(abortError).answer({ state: 's', questions: QUESTION }),
    )
    expect(failure.code).toBe('aborted')
  })

  it('reports a per-attempt timeout as a timeout', async () => {
    const failure = await failureOf(
      liveFailing(timeoutError()).answer({ state: 's', questions: QUESTION }),
    )
    expect(failure.code).toBe('timeout')
  })

  it('reports a 408 as a timeout rather than a rejected request', () => {
    const failure = classifyProviderFailure(
      { status: 408 },
      { providerId: 'live', label: 'TypeSafe' },
    )
    expect(failure.code).toBe('timeout')
    expect(failure.status).toBe(408)
  })
})

describe('the total budget is a real ceiling on a call', () => {
  it('aborts a call that outlives its budget, and reports a timeout', async () => {
    let aborted = false
    const provider = new LiveProvider({
      apiKey: 'k',
      totalBudgetMs: 40,
      retry: { maxRetries: 3 },
      loadSdk: async () =>
        neverAnsweringSdk(() => {
          aborted = true
        }).module,
    })

    const startedAt = Date.now()
    const failure = await failureOf(provider.answer({ state: 's', questions: QUESTION }))
    const elapsed = Date.now() - startedAt

    // The transport never answered, so the only thing that could end this call
    // is the budget. It is reported as a timeout, not as an abort: the caller
    // did not cancel.
    expect(failure.code).toBe('timeout')
    expect(aborted).toBe(true)
    // Well inside what 4 attempts at a 100ms per-attempt timeout would allow.
    expect(elapsed).toBeLessThan(1_000)
  })

  it('keeps a fast call fast, and clears its timer', async () => {
    const startedAt = Date.now()
    const provider = new LiveProvider({
      apiKey: 'k',
      // A long budget must not be waited out by a call that already answered.
      totalBudgetMs: 5_000,
      loadSdk: async () =>
        ({
          TypeSafeClient: class {
            async systemOne() {
              return { model: 'm', answers: {} }
            }
          },
        }) as never,
    })
    await provider.answer({ state: 's', questions: QUESTION })
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('defaults to a ceiling sized for the attempts it wraps', () => {
    // 10s per attempt x 3 attempts + backoff, derived from the shared defaults
    // rather than written down twice.
    expect(DEFAULT_CALL_TOTAL_BUDGET_MS).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS * (DEFAULT_REQUEST_MAX_RETRIES + 1) + 10_000,
    )
    // And the old worst case — 30s per attempt plus two backoffs — is strictly
    // above it, which is the bug this replaces.
    expect(DEFAULT_CALL_TOTAL_BUDGET_MS).toBeLessThan(30_000 * 3)
  })

  it('accepts an explicit budget of 0 as "no ceiling"', () => {
    const provider = new LiveProvider({ apiKey: 'k', totalBudgetMs: 0 })
    // Nothing to assert structurally beyond it constructing; the behaviour is
    // that no timer is armed, which `armCallBudget` covers directly.
    expect(provider).toBeInstanceOf(LiveProvider)
  })
})

describe('a configured 0 timeout does not break the SDK', () => {
  it('encodes 0 as a finite positive timeout the SDK accepts', () => {
    // The SDK's `assertPositiveMs` throws for `<= 0`, so passing 0 through made
    // every call fail before a socket opened — and the failure was reported as a
    // network problem.
    expect(timeoutForSdk(0)).toBe(NO_PER_ATTEMPT_TIMEOUT_MS)
    expect(timeoutForSdk(0)).toBeGreaterThan(0)
    expect(Number.isFinite(timeoutForSdk(0) as number)).toBe(true)
  })

  it('passes a positive timeout through unchanged', () => {
    expect(timeoutForSdk(2_500)).toBe(2_500)
  })

  it('passes nothing when no timeout is configured, leaving the SDK default', () => {
    expect(timeoutForSdk(undefined)).toBeUndefined()
  })

  it('hands the SDK a value it will not reject, for every configured shape', async () => {
    const seen: Array<Record<string, unknown>> = []
    const stub = {
      TypeSafeClient: class {
        constructor(config: Record<string, unknown>) {
          seen.push(config)
        }
        async systemOne() {
          return { model: 'm', answers: {} }
        }
      },
    }
    for (const timeout of [undefined, 0, 5_000]) {
      const provider = new LiveProvider({
        apiKey: 'k',
        ...(timeout === undefined ? {} : { timeout }),
        loadSdk: async () => stub as never,
      })
      await provider.answer({ state: 's', questions: QUESTION })
    }
    expect(seen[0]).not.toHaveProperty('timeout')
    for (const config of seen.slice(1)) {
      expect(typeof config.timeout).toBe('number')
      expect(config.timeout as number).toBeGreaterThan(0)
    }
  })

  it('ships a per-attempt default that matches the SDK and the config surface', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_CONFIG.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
  })
})

describe('status reading tolerates both spellings', () => {
  it('reads statusCode as well as status', () => {
    expect(statusOf({ statusCode: 429 })).toBe(429)
    expect(statusOf({ status: 500 })).toBe(500)
    expect(statusOf({ status: 'nope' })).toBeUndefined()
    expect(statusOf(new Error('no status'))).toBeUndefined()
  })
})
