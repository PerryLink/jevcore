/**
 * A consecutive-failure circuit breaker, in the vocabulary the provider layer
 * already uses.
 *
 * The failure this prevents is cheap to describe: an upstream goes down, every
 * call in the process keeps trying, and the process spends its budget, its
 * latency and its log volume discovering the same fact over and over. A breaker
 * says "stop asking for a while" — and the whole value of it depends on saying
 * that *accurately*.
 *
 * Three things this module is careful about, because a breaker that gets them
 * wrong is worse than none:
 *
 *  1. **It reasons about the existing categories rather than inventing a second
 *     taxonomy.** `classifyProviderFailure` already sorts a thrown transport
 *     error into one of ten {@link JevErrorCode}s, and `retryAfterOf` already
 *     extracts a server-requested delay. This module consumes both. It does not
 *     read HTTP statuses, it does not parse headers, and it does not have its own
 *     idea of what a failure is. A breaker with its own opinion about which
 *     errors count would disagree with the classifier the moment either changed.
 *
 *  2. **`Retry-After` wins over the configured cooldown.** A server that says
 *     "come back in 30 seconds" and a client that retries in one is not a client
 *     with a shorter backoff, it is a client ignoring an instruction — and it is
 *     asking to be rate-limited again. When a failure carries a longer delay than
 *     the cooldown, the longer one is used, including when the breaker is already
 *     open and the new instruction arrives.
 *
 *  3. **Opening explains itself.** {@link BreakerSnapshot} carries the state, the
 *     instant it will change, the count that tripped it, and the failure code
 *     that was last seen — so "the breaker is open" is answerable as "it opened
 *     after 5 consecutive failures, the last of which was a `rate-limited`, and it
 *     will allow a probe at T". It carries no message text: upstream error bodies
 *     are exactly what this package keeps out of logs.
 *
 * What it does not do: run the call, retry it, wait for the cooldown, or hold a
 * timer. It is a state machine over an injected clock, with no scheduled work, and
 * a caller who wants to wait must wait itself.
 */

import { retryAfterOf, statusOf } from '../provider/classify.js'
import { JevProviderError, type JevErrorCode } from '../types.js'

/** The three states, spelled out because two of them are easy to confuse. */
export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerOptions {
  /**
   * Consecutive provider failures that open the breaker. Defaults to
   * {@link DEFAULT_FAILURE_THRESHOLD}.
   *
   * Consecutive, not cumulative: a success resets the count. A ratio over a
   * rolling window would tolerate a flapping upstream that is failing most of the
   * time, which is the case a breaker is for.
   */
  readonly failureThreshold?: number
  /**
   * How long the breaker stays open before it will try again, in milliseconds.
   * Defaults to {@link DEFAULT_COOLDOWN_MS}.
   *
   * This is a floor, not a promise: a failure carrying `Retry-After` can extend
   * it, and the breaker never shortens the wait because a later failure happened
   * to carry a smaller delay.
   */
  readonly cooldownMs?: number
  /** Clock, injected so tests advance time instead of sleeping. Defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * What the breaker is doing, in a shape a status surface can print.
 *
 * `openedAt` is `undefined` in `closed`, and `lastFailureCode` is `undefined`
 * until a provider failure has been recorded — an aborted call and a budget
 * refusal are never recorded, so they leave it untouched.
 */
export interface BreakerSnapshot {
  readonly state: BreakerState
  /** Consecutive provider failures counted so far. */
  readonly consecutiveFailures: number
  readonly threshold: number
  readonly cooldownMs: number
  /** When the breaker opened, in epoch milliseconds. */
  readonly openedAt: number | undefined
  /** When it will allow a probe, in epoch milliseconds. */
  readonly opensUntil: number | undefined
  /**
   * The classifier's code for the last failure that was counted.
   *
   * A code rather than a message: the code is the stable, machine-readable half,
   * and a message could carry anything the upstream sent.
   */
  readonly lastFailureCode: JevErrorCode | undefined
  /** The upstream's HTTP status for the last counted failure, when it sent one. */
  readonly lastFailureStatus: number | undefined
  /** The delay the upstream asked for on the last counted failure, when it named one. */
  readonly lastRetryAfterMs: number | undefined
  /** Operator-facing sentence. No payload, no message text, no credential. */
  readonly reason: string
}

/**
 * Thrown when the breaker is open and the caller asked it to run the call anyway.
 *
 * Not a {@link JevProviderError}: no request was made, so there is no upstream
 * failure to report and nothing for the classifier to have said. A caller that
 * branches on `instanceof JevProviderError` will correctly see this as a local
 * decision.
 */
export class BreakerOpenError extends Error {
  override readonly name = 'BreakerOpenError'

  constructor(
    /** When a probe will next be allowed, in epoch milliseconds. */
    readonly retryAt: number,
    /** Milliseconds from the clock at the moment of refusal. */
    readonly retryInMs: number,
    readonly consecutiveFailures: number,
    readonly cooldownMs: number,
    readonly lastFailureCode: JevErrorCode | undefined,
    reason: string,
  ) {
    super(
      `Jev breaker is open, so nothing was transmitted: ${reason}. It will allow a half-open ` +
        `probe at ${retryAt} (in ${retryInMs}ms).`,
    )
  }
}

/** Default consecutive-failure count that opens the breaker. */
export const DEFAULT_FAILURE_THRESHOLD: number = 5

/**
 * Default cooldown, in milliseconds.
 *
 * 30_000, chosen against the numbers already in this package rather than picked
 * for feel: one call's total budget is `DEFAULT_TOTAL_BUDGET_MS` (40_000), so a
 * cooldown shorter than a single call's worst case would let the breaker reopen
 * while the very call that opened it was still in flight, and a cooldown long
 * enough to outlive several calls is long enough to be a real rest. It is also
 * the smallest delay an upstream that sent no `Retry-After` is plausibly asking
 * for.
 */
export const DEFAULT_COOLDOWN_MS: number = 30_000

/** A circuit breaker over provider failures, with an injected clock. */
export class FailureBreaker {
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private openedAt: number | undefined
  private opensUntil: number | undefined
  private lastFailureCode: JevErrorCode | undefined
  private lastFailureStatus: number | undefined
  private lastRetryAfterMs: number | undefined

  /**
   * @param options - thresholds and the clock.
   * @throws RangeError when `failureThreshold` is not a positive integer or
   *   `cooldownMs` is not a positive finite number. A threshold of zero would
   *   open the breaker on a clean process, and a non-finite cooldown would open
   *   it permanently; neither is a configuration worth honouring quietly.
   */
  constructor(options: BreakerOptions = {}) {
    const threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError(
        `failureThreshold must be a positive integer, got ${String(threshold)}; a threshold of ` +
          `zero would open the breaker before any call was made`,
      )
    }
    const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      throw new RangeError(
        `cooldownMs must be a positive finite number of milliseconds, got ${String(cooldownMs)}`,
      )
    }
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = options.now ?? Date.now
  }

  /**
   * The state right now, computed from the clock without changing anything.
   *
   * A getter rather than a method because it observes: reading it cannot consume
   * a probe or move the breaker. The stored state and this value differ in one
   * situation — an `open` breaker whose cooldown has elapsed reports `half-open`
   * here while `state` still says `open` until a call actually arrives. That is
   * the honest reading: the breaker has not probed anything yet.
   */
  get currentState(): BreakerState {
    return this.effectiveState(this.now())
  }

  /** The reason the breaker is open, or a sentence saying it is not. */
  get reason(): string {
    return this.snapshot().reason
  }

  /**
   * Whether a call may be attempted.
   *
   * `half-open` returns `true`: the state exists precisely to let a call through,
   * and refusing one would mean nothing could ever close the breaker. A caller
   * that wants the refusal to be an error rather than a boolean should use
   * {@link FailureBreaker.assert}. Neither of them reserves the probe — see
   * {@link FailureBreaker.recordSuccess} for why the state only advances once an
   * outcome is recorded.
   */
  allows(): boolean {
    return this.effectiveState(this.now()) !== 'open'
  }

  /**
   * The same decision as {@link FailureBreaker.allows}, thrown instead of
   * returned, carrying the numbers behind it.
   *
   * Named `assert` to match `EgressContract.assert` and `JevBudget.assert`: the
   * three are the same kind of guard in the same call path, and a caller reading
   * them together should not have to learn three idioms.
   *
   * @throws BreakerOpenError when the breaker is open.
   */
  assert(): void {
    const at = this.now()
    const state = this.effectiveState(at)
    if (state !== 'open') return
    // `opensUntil` is set whenever the state is open, so the fallback is
    // unreachable; it exists so the error's numbers are never `NaN`.
    const retryAt = this.opensUntil ?? at
    throw new BreakerOpenError(
      retryAt,
      Math.max(0, retryAt - at),
      this.consecutiveFailures,
      this.cooldownMs,
      this.lastFailureCode,
      this.describe(at, state),
    )
  }

  /**
   * Record a successful call: any state becomes `closed`, and the count resets.
   *
   * A success from `half-open` is the probe that closed the breaker. A success
   * from `closed` is an ordinary call that resets a partial run of failures —
   * which is what makes the threshold consecutive rather than cumulative.
   *
   * There is no separate `recordProbe` because there is no second kind of
   * success: whatever the breaker's state was, a call came back and that is the
   * evidence.
   */
  recordSuccess(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.openedAt = undefined
    this.opensUntil = undefined
    this.lastFailureCode = undefined
    this.lastFailureStatus = undefined
    this.lastRetryAfterMs = undefined
  }

  /**
   * Record a failed call, and open the breaker if that was the threshold-th
   * consecutive one.
   *
   * `error` is the thrown value, not a pre-digested summary, so this module
   * extracts the delay with the same `retryAfterOf` the classifier uses and
   * cannot drift from it.
   *
   * **Not every error counts.** Three are explicitly excluded, and each exclusion
   * is a way a naive breaker hurts:
   *
   *  - **A budget refusal** (`JevBudgetExceededError`, from `./budget.js`) is not
   *    a `JevProviderError` and is ignored, so a process that stopped spending
   *    does not also open a breaker and report an upstream outage that never
   *    happened.
   *  - **A caller abort** (`code === 'aborted'`) is the caller's own decision and
   *    says nothing about the upstream's health.
   *  - **A malformed request** (`code === 'invalid-request'`) cannot be fixed by
   *    waiting. Opening the breaker would delay every *other* caller's perfectly
   *    valid request behind one caller's bug.
   *
   * A message-parsing caller cannot make that judgement from text; the code is
   * the whole reason `classifyProviderFailure` exists.
   *
   * Returns the state after the call, so a caller can react without a second
   * reading.
   */
  recordFailure(error: unknown): BreakerState {
    const at = this.now()
    const before = this.effectiveState(at)

    if (!(error instanceof JevProviderError)) return before
    if (error.code === 'aborted' || error.code === 'invalid-request') return before

    this.consecutiveFailures += 1
    this.lastFailureCode = error.code
    const status = error.status ?? statusOf(error.cause)
    // `exactOptionalPropertyTypes` is on, so these stay `undefined` rather than
    // being assigned `undefined` into an optional field.
    this.lastFailureStatus = status
    const retryAfterMs = error.retryAfterMs ?? retryAfterOf(error.cause)
    this.lastRetryAfterMs = retryAfterMs

    const halfOpenProbeFailed = before === 'half-open'
    if (!halfOpenProbeFailed && this.consecutiveFailures < this.threshold) return before

    // The server's own instruction wins when it asks for longer than the
    // cooldown, and an already-open breaker is never *shortened* by a later,
    // smaller delay: extending is honoured, cutting the wait is not.
    const requested = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0
    const until = at + Math.max(this.cooldownMs, requested)
    const current = this.opensUntil
    this.state = 'open'
    this.openedAt = at
    this.opensUntil = current === undefined ? until : Math.max(current, until)
    return 'open'
  }

  /**
   * Everything a status surface needs, in one read.
   *
   * The reason sentence is generated here rather than at each call site so that
   * the same state is never described two different ways.
   */
  snapshot(): BreakerSnapshot {
    const at = this.now()
    const state = this.effectiveState(at)
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.threshold,
      cooldownMs: this.cooldownMs,
      openedAt: this.openedAt,
      opensUntil: this.opensUntil,
      lastFailureCode: this.lastFailureCode,
      lastFailureStatus: this.lastFailureStatus,
      lastRetryAfterMs: this.lastRetryAfterMs,
      reason: this.describe(at, state),
    }
  }

  /**
   * The state as of `at`.
   *
   * The only derived transition is `open` + cooldown elapsed = `half-open`. The
   * stored state is deliberately not moved here, so a `half-open` reading is a
   * statement about the clock rather than a claim that a probe is under way.
   */
  private effectiveState(at: number): BreakerState {
    if (this.state === 'open' && this.opensUntil !== undefined && at >= this.opensUntil) {
      return 'half-open'
    }
    return this.state
  }

  private describe(at: number, state: BreakerState): string {
    if (state === 'closed') {
      return this.consecutiveFailures === 0
        ? 'closed; no provider failure has been recorded'
        : `closed; ${this.consecutiveFailures} of ${this.threshold} consecutive failures recorded`
    }
    if (state === 'half-open') {
      return (
        `half-open; the cooldown has elapsed and one call will be allowed to decide whether the ` +
        `upstream recovered`
      )
    }
    const retryInMs = this.opensUntil === undefined ? 0 : Math.max(0, this.opensUntil - at)
    const why =
      this.lastFailureCode === undefined
        ? 'no counted failure is on record'
        : `the last counted failure was "${this.lastFailureCode}"`
    const asked =
      this.lastRetryAfterMs === undefined
        ? 'no Retry-After was sent'
        : `the upstream asked for ${this.lastRetryAfterMs}ms`
    return (
      `open after ${this.consecutiveFailures} consecutive failures; ${why}; ${asked}; ` +
      `a probe is allowed in ${retryInMs}ms`
    )
  }
}
