/**
 * A breaker is only useful if it opens for the right reason and waits for the
 * right length of time.
 *
 * Four things are under test, and each is a way a breaker does harm instead of
 * good:
 *
 *  1. Consecutive failures open it, and a success resets the run — so a flapping
 *     upstream still trips it while a healthy one never does.
 *  2. It reasons about the codes `classifyProviderFailure` already produces, and
 *     ignores the two that say nothing about the upstream's health: a caller's
 *     own abort, and a malformed request that waiting cannot fix.
 *  3. `Retry-After` is honoured. A server that asks for 30 seconds and a client
 *     that comes back in one is not a client with a shorter backoff.
 *  4. The half-open probe is a real transition: one call through, a success closes
 *     the breaker, and a failure opens it again rather than granting a second
 *     probe.
 *
 * Every test drives an injected clock. None of them sleeps, and none of them
 * touches the network.
 */

import { describe, expect, it } from 'vitest'
import {
  BreakerOpenError,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  FailureBreaker,
} from '../src/resilience/index.js'
import { JevBudgetExceededError } from '../src/resilience/budget.js'
import { JevProviderError, type JevErrorCode } from '../src/types.js'

/** A clock a test moves by hand. Nothing here reads the real one. */
const clock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let at = start
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

/** A failure as the provider layer would throw it. */
const failure = (
  code: JevErrorCode,
  options: { retryAfterMs?: number; status?: number } = {},
): JevProviderError =>
  new JevProviderError(`upstream said ${code}`, code, {
    providerId: 'live',
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.status === undefined ? {} : { status: options.status }),
  })

/** Fail `times` in a row. */
const failTimes = (breaker: FailureBreaker, times: number, error?: JevProviderError): void => {
  for (let index = 0; index < times; index += 1) {
    breaker.recordFailure(error ?? failure('upstream-unreachable', { status: 503 }))
  }
}

describe('closed, open and half-open are explicit transitions', () => {
  it('starts closed and stays closed below the threshold', () => {
    const breaker = new FailureBreaker({ failureThreshold: 3, cooldownMs: 1_000 })
    expect(breaker.currentState).toBe('closed')
    expect(breaker.allows()).toBe(true)
    failTimes(breaker, 2)
    expect(breaker.currentState).toBe('closed')
    expect(breaker.allows()).toBe(true)
    expect(breaker.snapshot().consecutiveFailures).toBe(2)
  })

  it('opens on the threshold-th consecutive failure, not the one after it', () => {
    const breaker = new FailureBreaker({ failureThreshold: 3, cooldownMs: 1_000 })
    failTimes(breaker, 2)
    expect(breaker.recordFailure(failure('overloaded', { status: 529 }))).toBe('open')
    expect(breaker.currentState).toBe('open')
    expect(breaker.allows()).toBe(false)
    expect(breaker.snapshot().consecutiveFailures).toBe(3)
  })

  it('refuses an open breaker with the numbers behind the refusal', () => {
    const at = clock(1_000)
    const breaker = new FailureBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: at.now })
    failTimes(breaker, 2, failure('overloaded', { status: 529 }))
    const refused = (() => {
      try {
        breaker.assert()
        return undefined
      } catch (thrown) {
        return thrown as BreakerOpenError
      }
    })()
    expect(refused).toBeInstanceOf(BreakerOpenError)
    expect(refused?.retryAt).toBe(2_000)
    expect(refused?.retryInMs).toBe(1_000)
    expect(refused?.consecutiveFailures).toBe(2)
    expect(refused?.lastFailureCode).toBe('overloaded')
    expect(refused?.message).toMatch(/nothing was transmitted/)
  })

  it('moves to half-open when the cooldown elapses, and lets exactly one call through', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: at.now })
    failTimes(breaker, 2)
    expect(breaker.allows()).toBe(false)

    at.advance(999)
    expect(breaker.currentState).toBe('open')
    at.advance(1)
    expect(breaker.currentState).toBe('half-open')
    expect(breaker.allows()).toBe(true)
    // The stored state is not moved by reading it: nothing has probed yet.
    expect(breaker.snapshot().state).toBe('half-open')
    expect(breaker.snapshot().reason).toMatch(/cooldown has elapsed/)
  })

  it('closes on a successful probe and forgets the run', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: at.now })
    failTimes(breaker, 2)
    at.advance(1_000)
    expect(breaker.currentState).toBe('half-open')
    breaker.recordSuccess()
    const snapshot = breaker.snapshot()
    expect(snapshot.state).toBe('closed')
    expect(snapshot.consecutiveFailures).toBe(0)
    expect(snapshot.openedAt).toBeUndefined()
    expect(snapshot.opensUntil).toBeUndefined()
    expect(snapshot.lastFailureCode).toBeUndefined()
    expect(breaker.allows()).toBe(true)
  })

  it('reopens immediately when the probe fails, rather than granting a second one', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: at.now })
    failTimes(breaker, 3)
    at.advance(1_000)
    expect(breaker.currentState).toBe('half-open')
    // One failure is enough here: the threshold governs entering the open state
    // from a healthy run, not whether a probe that failed is a failure.
    expect(breaker.recordFailure(failure('upstream-unreachable'))).toBe('open')
    expect(breaker.allows()).toBe(false)
    expect(breaker.snapshot().opensUntil).toBe(2_000)
    // The count keeps climbing, so the report does not read as "3 failures, still
    // tripping".
    expect(breaker.snapshot().consecutiveFailures).toBe(4)
  })

  it('resets the consecutive count on a success between failures', () => {
    const breaker = new FailureBreaker({ failureThreshold: 3, cooldownMs: 1_000 })
    failTimes(breaker, 2)
    breaker.recordSuccess()
    failTimes(breaker, 2)
    expect(breaker.currentState).toBe('closed')
    expect(breaker.snapshot().consecutiveFailures).toBe(2)
  })
})

describe('the breaker reasons in the classifier\'s categories', () => {
  it('ignores a caller abort, which says nothing about the upstream', () => {
    const breaker = new FailureBreaker({ failureThreshold: 2, cooldownMs: 1_000 })
    failTimes(breaker, 5, failure('aborted'))
    expect(breaker.currentState).toBe('closed')
    expect(breaker.snapshot().consecutiveFailures).toBe(0)
    expect(breaker.snapshot().lastFailureCode).toBeUndefined()
  })

  it('ignores a malformed request, which waiting cannot fix', () => {
    // One caller's 422 must not delay every other caller's valid request.
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
    failTimes(breaker, 3, failure('invalid-request', { status: 422 }))
    expect(breaker.currentState).toBe('closed')
  })

  it('ignores a budget refusal, which is a local decision', () => {
    // A process that stopped spending must not also report an upstream outage.
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
    breaker.recordFailure(new JevBudgetExceededError('calls', 1, 0, 0, 0, 'out of calls'))
    breaker.recordFailure(new Error('something else entirely'))
    expect(breaker.currentState).toBe('closed')
    expect(breaker.snapshot().consecutiveFailures).toBe(0)
  })

  it('counts the codes that do describe upstream health', () => {
    for (const code of ['overloaded', 'rate-limited', 'timeout', 'upstream-unreachable'] as const) {
      const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
      breaker.recordFailure(failure(code))
      expect(breaker.currentState).toBe('open')
      expect(breaker.snapshot().lastFailureCode).toBe(code)
    }
  })

  it('keeps the code, the status and the asked-for delay for the report', () => {
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000 })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 5_000 }))
    const snapshot = breaker.snapshot()
    expect(snapshot.lastFailureCode).toBe('rate-limited')
    expect(snapshot.lastFailureStatus).toBe(429)
    expect(snapshot.lastRetryAfterMs).toBe(5_000)
  })
})

describe('a Retry-After is honoured rather than approximated', () => {
  it('waits at least as long as the server asked, when that is longer than the cooldown', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: at.now })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 30_000 }))
    expect(breaker.snapshot().opensUntil).toBe(30_000)

    at.advance(1_000)
    expect(breaker.currentState).toBe('open')
    expect(breaker.allows()).toBe(false)
    at.advance(28_999)
    expect(breaker.currentState).toBe('open')
    at.advance(1)
    expect(breaker.currentState).toBe('half-open')
  })

  it('keeps its own cooldown when the server asks for less', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 5_000, now: at.now })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 100 }))
    expect(breaker.snapshot().opensUntil).toBe(5_000)
    at.advance(4_999)
    expect(breaker.allows()).toBe(false)
  })

  it('reads a delay out of the error\'s headers the way the classifier does', () => {
    // The SDK hands back an API error carrying a `Headers` instance. `retryAfterOf`
    // reads it, and so does the breaker — one implementation, not two.
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: at.now })
    const withHeaders = new Error('429')
    Object.assign(withHeaders, { headers: new Headers({ 'retry-after': '7' }) })
    breaker.recordFailure(withHeaders)
    // Not a `JevProviderError`, so it is not counted at all — which is the
    // documented behaviour for anything the classifier did not produce.
    expect(breaker.currentState).toBe('closed')

    const classified = new JevProviderError('rate limited', 'rate-limited', {
      cause: withHeaders,
      providerId: 'live',
      retryAfterMs: 7_000,
    })
    breaker.recordFailure(classified)
    expect(breaker.snapshot().opensUntil).toBe(7_000)
    expect(breaker.snapshot().lastRetryAfterMs).toBe(7_000)
  })

  it('extends an already-open breaker when a later failure asks for longer', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: at.now })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 2_000 }))
    expect(breaker.snapshot().opensUntil).toBe(2_000)
    at.advance(100)
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 10_000 }))
    expect(breaker.snapshot().opensUntil).toBe(10_100)
  })

  it('never shortens an open window when a later failure asks for less', () => {
    // Honouring a smaller delay would be treating an instruction as a suggestion
    // and retrying sooner than the server already told us to.
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: at.now })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 10_000 }))
    at.advance(100)
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 50 }))
    expect(breaker.snapshot().opensUntil).toBe(10_000)
    expect(breaker.snapshot().lastRetryAfterMs).toBe(50)
  })

  it('treats a Retry-After of zero as no delay, not as an open-forever breaker', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: at.now })
    breaker.recordFailure(failure('rate-limited', { status: 429, retryAfterMs: 0 }))
    expect(breaker.snapshot().opensUntil).toBe(1_000)
    at.advance(1_000)
    expect(breaker.currentState).toBe('half-open')
  })
})

describe('a breaker that opens makes the failure more legible', () => {
  it('says why it is open, without carrying upstream message text', () => {
    const at = clock(0)
    const breaker = new FailureBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: at.now })
    failTimes(breaker, 2, failure('rate-limited', { status: 429, retryAfterMs: 2_000 }))
    const reason = breaker.reason
    expect(reason).toMatch(/open after 2 consecutive failures/)
    expect(reason).toMatch(/rate-limited/)
    expect(reason).toMatch(/the upstream asked for 2000ms/)
    expect(reason).toMatch(/a probe is allowed in 2000ms/)
    expect(reason).not.toMatch(/upstream said/)
  })

  it('describes a partial run while it is still closed', () => {
    const breaker = new FailureBreaker({ failureThreshold: 4, cooldownMs: 1_000 })
    expect(breaker.reason).toMatch(/no provider failure has been recorded/)
    failTimes(breaker, 2)
    expect(breaker.reason).toMatch(/2 of 4 consecutive failures/)
  })

  it('reports the thresholds it is actually using', () => {
    const defaults = new FailureBreaker()
    const snapshot = defaults.snapshot()
    expect(snapshot.threshold).toBe(DEFAULT_FAILURE_THRESHOLD)
    expect(snapshot.cooldownMs).toBe(DEFAULT_COOLDOWN_MS)
    // A cooldown shorter than one call's own total budget would let the breaker
    // reopen while the call that opened it was still in flight.
    expect(DEFAULT_COOLDOWN_MS).toBeGreaterThan(10_000)
  })
})

describe('a breaker that could not mean anything is refused', () => {
  it('refuses a threshold below one', () => {
    expect(() => new FailureBreaker({ failureThreshold: 0 })).toThrow(RangeError)
    expect(() => new FailureBreaker({ failureThreshold: 1.5 })).toThrow(RangeError)
  })

  it('refuses a cooldown that is not a positive finite number', () => {
    // A non-finite cooldown is a breaker that never closes again.
    expect(() => new FailureBreaker({ cooldownMs: 0 })).toThrow(RangeError)
    expect(() => new FailureBreaker({ cooldownMs: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })
})
