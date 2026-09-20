/**
 * A ceiling on what a process may spend in calls and dollars.
 *
 * The gap this fills is specific. The request path already bounds *how long* one
 * call may take — `DEFAULT_REQUEST_TIMEOUT_MS` per attempt, plus a derived total
 * (`DEFAULT_TOTAL_BUDGET_MS`) around the whole thing — and that pair is a real
 * bound on one call. Neither of them bounds *how many* calls there are. A loop
 * that retries, a gate that runs on every tool call, a scheduler that wakes up:
 * each call is individually well-behaved and collectively they can spend without
 * limit. A timeout is not a budget; it is a bound on latency that is easy to
 * mistake for one.
 *
 * So this is a ceiling, and the difference between a ceiling and a hint is what
 * happens at the boundary: the call is refused, with a typed error, before
 * anything is transmitted. Nothing here logs and continues.
 *
 * **The honest problem: cost is unknown on a route that reports none.** The
 * service accumulates `result.usage?.costUsd ?? 0`, which treats "the provider
 * told me nothing" as "this call was free". Repeated, that makes a spend ceiling
 * unfalsifiable — the number stays at zero while money leaves. This module will
 * not repeat that: a call whose cost is unknown is counted as *unknown*, adds
 * nothing to the spend total, and is reported in
 * {@link JevBudgetReport.unknownCostCalls}. A spend ceiling on such a route is
 * therefore not a guarantee, and {@link JevBudgetReport.spendBounded} says so in
 * a value rather than in a comment. A caller who needs the ceiling to bite must
 * either supply `recordCost` on every call or pass `unknownCost: 'refuse'`, which
 * rejects unknown-cost calls outright.
 *
 * State is in memory and starts empty, so a restart resets the ceiling. That is
 * stated rather than fixed: a durable budget needs storage this package does not
 * have, and pretending otherwise would be a worse lie than the limitation.
 */

/**
 * What to do about a call whose cost the route did not report.
 *
 * `'count'` runs the call and records that its cost is unaccounted for. That is
 * the default because refusing every call on a route that reports no usage would
 * make the module unusable on exactly the routes where cost is hardest to see,
 * and an operator would then turn the whole thing off rather than this setting.
 * `'refuse'` is the strict direction: with it, `spendUsd` is an actual ceiling,
 * because no call gets through without a cost somebody stands behind.
 */
export type UnknownCostPolicy = 'count' | 'refuse'

/** Limits for one window. Omit either to leave that dimension unbounded. */
export interface BudgetLimits {
  /**
   * Calls allowed per window. Omitted means no call ceiling.
   *
   * `0` is a real ceiling that permits nothing, not a spelling of "unlimited" —
   * falsy is not absent, and a budget that quietly became infinite because
   * somebody wrote `0` is the failure this whole module is about.
   */
  readonly calls?: number
  /** Dollars allowed per window. Omitted means no spend ceiling. */
  readonly spendUsd?: number
  /**
   * Window length in milliseconds. Omitted means the window never rolls over, so
   * the limits are for the lifetime of the instance.
   */
  readonly windowMs?: number
  /** What to do when a call's cost is unknown. Defaults to `'count'`. */
  readonly unknownCost?: UnknownCostPolicy
}

/**
 * Everything {@link JevBudget} needs to be constructed.
 *
 * An options object rather than positional arguments, matching
 * {@link FailureBreaker} and `AnswerCache`. A clock passed positionally is the
 * kind of parameter a caller passes once and then never again while the ceiling
 * it governs silently reads the wall clock — which is exactly the mistake that
 * makes a windowed budget untestable and its tests flaky.
 */
export interface BudgetOptions {
  /** The ceilings. Omitted means no ceiling. */
  readonly limits?: BudgetLimits
  /** Clock, injected so tests advance time instead of sleeping. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** A refusal decision, returned by {@link JevBudget.check}. */
export type BudgetDecision =
  | {
      readonly allowed: true
      readonly callsUsed: number
      readonly spendUsd: number
      readonly remainingCalls: number
      readonly remainingUsd: number
    }
  | {
      readonly allowed: false
      /** Which ceiling was hit, for a caller that behaves differently per limit. */
      readonly limit: 'calls' | 'spend' | 'unknown-cost'
      readonly callsUsed: number
      readonly spendUsd: number
      readonly remainingCalls: number
      readonly remainingUsd: number
      readonly reason: string
    }

/** What one window has consumed, and how much of it is accounted for. */
export interface JevBudgetReport {
  readonly callsUsed: number
  readonly spendUsd: number
  /**
   * Estimates held for calls that have been reserved and not yet settled.
   *
   * Reported separately from `spendUsd` because the two are different claims: one
   * is money that has been spent, the other is money the budget is refusing to
   * hand to a second call until the first reports back. A ceiling checked against
   * their sum is tight; a ceiling checked against `spendUsd` alone is not.
   */
  readonly reservedUsd: number
  readonly unknownCostCalls: number
  /** Epoch milliseconds when the current window began. */
  readonly windowStartedAt: number
  /** Epoch milliseconds when it rolls over, or `undefined` when it does not. */
  readonly windowEndsAt: number | undefined
  /**
   * False when a spend ceiling is configured and `spendUsd` is not the whole
   * story: a call in this window reported no cost, or a reserved estimate has not
   * been settled yet.
   *
   * The number an operator needs and the one the service's own accounting cannot
   * give them: without it, `spendUsd` on a mock or usage-less route reads as a
   * complete total rather than as a lower bound.
   */
  readonly spendBounded: boolean
}

/**
 * Thrown when a call would exceed the configured ceiling.
 *
 * Its own class, separate from `JevProviderError`, because the two call for
 * opposite reactions: a provider failure means the upstream had a problem, and a
 * refusal means this process decided not to ask. They are also distinguishable
 * by machine rather than by message — this one is not a {@link JevProviderError}
 * and carries no `code`, so a `catch` that branches on `instanceof
 * JevProviderError` will not mistake a budget stop for a network fault, and the
 * breaker will not count one as an upstream failure.
 */
export class JevBudgetExceededError extends Error {
  override readonly name = 'JevBudgetExceededError'

  constructor(
    /** Which ceiling was hit: a call count, a dollar amount, or the cost policy. */
    readonly limit: 'calls' | 'spend' | 'unknown-cost',
    readonly callsUsed: number,
    readonly spendUsd: number,
    readonly remainingCalls: number,
    readonly remainingUsd: number,
    reason: string,
  ) {
    super(
      `Jev budget refused the call: ${reason}. Nothing was transmitted. This is a local decision ` +
        `and not an upstream failure.`,
    )
  }
}

/** A ceiling that permits nothing. Useful as an explicit "off" that reports why. */
export const ZERO_BUDGET: BudgetLimits = { calls: 0 }

/**
 * Ceiling on calls and/or spend within a window, per instance.
 *
 * Pure state plus an injected clock: no timers, no scheduled reset, nothing that
 * can keep a process alive. The window rolls over lazily on the next call, so an
 * idle budget costs nothing and an observation cannot be stale — the rollover is
 * computed from `now()` at the moment it is asked, not from a callback that may
 * or may not have fired.
 *
 * One limit is enforced exactly: `calls`, which is known before the call is made.
 * Spend is enforced against the estimate held by {@link JevBudget.reserve} plus
 * what has already settled, so a call whose true cost exceeds its estimate can
 * still push the total past the ceiling. This bounds the number of calls and the
 * known spend; it does not make the total impossible to exceed.
 */
export class JevBudget {
  private readonly limits: BudgetLimits
  private readonly now: () => number
  private callsUsed = 0
  private spendUsd = 0
  /** Estimates charged by `reserve` and not yet settled by `recordCost`. */
  private reservedUsd = 0
  /** Calls reserved and waiting to be settled. Mirrors `heldEstimates.length`. */
  private reservedCalls = 0
  /**
   * The estimate held for each outstanding call, oldest first.
   *
   * Kept as a list rather than a single running total so `recordCost` releases
   * the estimate that belongs to the call it is settling. A shared total would
   * have to be decremented by something, and the only available something is the
   * *settled* cost — which differs from the estimate precisely when a call cost
   * more or less than expected, and would drift the held total away from the
   * truth on every such call.
   */
  private readonly heldEstimates: number[] = []
  private unknownCostCalls = 0
  private windowStartedAt: number
  private windowEndsAt: number | undefined

  /**
   * @param options - the ceilings, plus the clock. Omitting the limits means no
   *   ceiling at all, which is inert on purpose: a budget that limits nothing is
   *   worse than no budget, because it looks like one, so a half-configured
   *   budget is visible as unlimited rather than as silently permissive.
   * @throws RangeError when `calls` is not a non-negative integer, `spendUsd` is
   *   not a non-negative finite number, or `windowMs` is not a positive one. A
   *   NaN ceiling compares false against everything and would permit every call
   *   forever while looking like a configured limit.
   */
  constructor(options: BudgetOptions = {}) {
    const limits = options.limits ?? {}
    const now = options.now ?? Date.now
    const calls = limits.calls
    if (calls !== undefined && (!Number.isInteger(calls) || calls < 0)) {
      throw new RangeError(`budget calls must be a non-negative integer, got ${String(calls)}`)
    }
    const spendUsd = limits.spendUsd
    if (spendUsd !== undefined && (!Number.isFinite(spendUsd) || spendUsd < 0)) {
      throw new RangeError(
        `budget spendUsd must be a non-negative finite number, got ${String(spendUsd)}`,
      )
    }
    const windowMs = limits.windowMs
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) {
      throw new RangeError(
        `budget windowMs must be a positive number of milliseconds, got ${String(windowMs)}; ` +
          `omit it for a window that never rolls over`,
      )
    }
    this.limits = limits
    this.now = now
    this.windowStartedAt = now()
    this.windowEndsAt = windowMs === undefined ? undefined : this.windowStartedAt + windowMs
  }

  /** The ceilings in force, for a status surface. */
  get limitsInForce(): BudgetLimits {
    return this.limits
  }

  /**
   * Whether a call may be made right now, without consuming anything.
   *
   * A question, not a bookkeeping step: call it to decide, call
   * {@link JevBudget.reserve} to decide *and* charge. The difference matters when
   * several calls are in flight at once, because two `check`s can both say yes
   * and the two `reserve`s after them cannot.
   *
   * Room is measured against the settled spend *plus* the estimates
   * {@link JevBudget.reserve} is still holding, so a call already in flight has
   * its money taken out of the window before it returns.
   */
  check(): BudgetDecision {
    this.renew()
    const remainingCalls = this.remainingCalls()
    const remainingUsd = this.remainingUsd()
    const base = {
      callsUsed: this.callsUsed,
      spendUsd: this.spendUsd,
      remainingCalls,
      remainingUsd,
    }
    if (this.limits.calls !== undefined && this.callsUsed >= this.limits.calls) {
      return {
        allowed: false,
        limit: 'calls',
        ...base,
        reason: `${this.callsUsed} of ${this.limits.calls} calls used in this window`,
      }
    }
    if (this.limits.spendUsd !== undefined && this.committedUsd() >= this.limits.spendUsd) {
      return {
        allowed: false,
        limit: 'spend',
        ...base,
        reason:
          `$${this.committedUsd().toFixed(4)} of $${this.limits.spendUsd.toFixed(4)} committed ` +
          `in this window (${this.spendUsd.toFixed(4)} settled, ${this.reservedUsd.toFixed(4)} ` +
          `held as an estimate)`,
      }
    }
    return { allowed: true, ...base }
  }

  /**
   * The same decision as {@link check}, thrown instead of returned.
   *
   * Named `assert` to match `EgressContract.assert`, because the two are the same
   * kind of guard in the same call path: one asks whether content may leave, this
   * one asks whether there is room for the call at all, and both belong *before*
   * the provider is invoked.
   *
   * @throws JevBudgetExceededError when the ceiling is reached.
   */
  assert(): void {
    const decision = this.check()
    if (decision.allowed) return
    throw new JevBudgetExceededError(
      decision.limit,
      decision.callsUsed,
      decision.spendUsd,
      decision.remainingCalls,
      decision.remainingUsd,
      decision.reason,
    )
  }

  /**
   * Claim one call. Its call count is charged, an optional cost estimate is held,
   * and the ceiling is re-checked against both.
   *
   * This is the method the real path should use, not `check` followed later by
   * `recordCost`. Two reasons, and the second is the one that matters: `check`
   * twice can both say yes and only one of the two calls may be affordable; and a
   * spend ceiling consulted only *after* the provider returns has already spent
   * the money it was supposed to prevent. `reserve` decides and charges in one
   * step, so the estimate is held before the call is in flight and every later
   * `check` sees it.
   *
   * `estimateUsd` is an estimate, not a hold on the maximum. A call that ends up
   * costing more than its estimate can take the total past the ceiling; the next
   * `check` refuses, but this call has happened. Under-estimating is the way to
   * make a spend ceiling loose, and it is documented rather than prevented
   * because the alternative is a caller inventing a pessimistic number it does
   * not believe.
   *
   * The estimate is released by {@link JevBudget.recordCost}, which is what turns
   * it into a settled cost. A caller that reserves and never records leaves the
   * estimate held, which under-spends rather than over-spends and is visible in
   * {@link JevBudgetReport.reservedUsd}.
   *
   * @throws JevBudgetExceededError when the ceiling is reached — reported against
   *   the count and the committed total, including this call's own estimate — or
   *   when `unknownCost: 'refuse'` is set and no estimate was given.
   */
  reserve(estimateUsd?: number): BudgetDecision {
    const decision = this.check()
    if (!decision.allowed) {
      throw new JevBudgetExceededError(
        decision.limit,
        decision.callsUsed,
        decision.spendUsd,
        decision.remainingCalls,
        decision.remainingUsd,
        decision.reason,
      )
    }
    const known = estimateUsd !== undefined && Number.isFinite(estimateUsd) && estimateUsd >= 0
    if (!known && this.limits.unknownCost === 'refuse') {
      throw new JevBudgetExceededError(
        'unknown-cost',
        this.callsUsed,
        this.spendUsd,
        decision.remainingCalls,
        decision.remainingUsd,
        'the cost of this call is not known and `unknownCost` is "refuse", so a spend ceiling ' +
          'could not be enforced against it',
      )
    }
    const estimate = known ? (estimateUsd as number) : 0
    const ceiling = this.limits.spendUsd
    if (ceiling !== undefined && this.committedUsd() + estimate > ceiling) {
      throw new JevBudgetExceededError(
        'spend',
        this.callsUsed,
        this.spendUsd,
        decision.remainingCalls,
        decision.remainingUsd,
        `an estimate of $${estimate.toFixed(4)} would commit ` +
          `$${(this.committedUsd() + estimate).toFixed(4)} of a $${ceiling.toFixed(4)} ceiling, ` +
          `with ${decision.remainingUsd.toFixed(4)} still available`,
      )
    }
    this.callsUsed += 1
    this.reservedCalls += 1
    this.reservedUsd += estimate
    this.heldEstimates.push(estimate)
    return this.check()
  }

  /**
   * Settle the call {@link JevBudget.reserve} claimed: release its estimate and
   * add what it actually cost.
   *
   * It does **not** charge a call. The call was charged at `reserve`, and charging
   * it again here would make the call ceiling depend on how many times a caller
   * reported its outcome. That is why every call must be reserved first, and why
   * calling this without an outstanding reservation throws rather than guessing:
   * either reading of an unmatched call would corrupt one of the two totals, and
   * a silently wrong budget is worse than a loud refusal to record.
   *
   * `costUsd` being `undefined` is the case this module exists to get right, and
   * it is not zero. The call is counted in
   * {@link JevBudgetReport.unknownCostCalls} and contributes nothing to the spend
   * total, and its estimate is released so the window does not hold money that
   * was never spent. A provider that reports a real `0` is a *known* zero: it
   * also spends nothing, but it does not mark the window's accounting incomplete.
   * The two facts are kept apart all the way to the report.
   *
   * @throws RangeError when there is no call waiting to be settled, or when
   *   `costUsd` is negative or not finite. A negative cost is not a refund, and
   *   accepting one would let a route report its way under a ceiling.
   */
  recordCost(costUsd?: number): void {
    this.renew()
    if (this.reservedCalls === 0) {
      throw new RangeError(
        'recordCost was called with no call reserved. Reserve first — the call count and the ' +
          'cost estimate are both charged by `reserve`, and settling a call that was never ' +
          'claimed would either double-count it or invent one.',
      )
    }
    if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0)) {
      throw new RangeError(
        `recordCost must be given a non-negative finite cost or nothing at all, got ` +
          `${String(costUsd)}. A negative cost is not a refund.`,
      )
    }
    this.reservedCalls -= 1
    // The oldest outstanding estimate is released, which is the right one under
    // the only ordering a caller can have: calls are reserved before they are
    // settled.
    const released = this.heldEstimates.shift() ?? 0
    this.reservedUsd = Math.max(0, this.reservedUsd - released)
    if (costUsd === undefined) {
      this.unknownCostCalls += 1
      return
    }
    this.spendUsd += costUsd
  }

  /**
   * What this window has consumed.
   *
   * Advances the window if it has rolled over, so a caller reading a report gets
   * the window it is actually in rather than the last one that was used.
   */
  report(): JevBudgetReport {
    this.renew()
    const spendCeiling = this.limits.spendUsd !== undefined
    return {
      callsUsed: this.callsUsed,
      spendUsd: this.spendUsd,
      reservedUsd: this.reservedUsd,
      unknownCostCalls: this.unknownCostCalls,
      windowStartedAt: this.windowStartedAt,
      windowEndsAt: this.windowEndsAt,
      // Two ways the settled total stops being the whole story: a call the route
      // could not price, and money still held against a call in flight.
      spendBounded: !(spendCeiling && (this.unknownCostCalls > 0 || this.reservedCalls > 0)),
    }
  }

  /** Start a new window now, whatever the clock says. */
  reset(): void {
    this.windowStartedAt = this.now()
    this.windowEndsAt =
      this.limits.windowMs === undefined ? undefined : this.windowStartedAt + this.limits.windowMs
    this.callsUsed = 0
    this.spendUsd = 0
    this.reservedUsd = 0
    this.reservedCalls = 0
    this.heldEstimates.length = 0
    this.unknownCostCalls = 0
  }

  private remainingCalls(): number {
    if (this.limits.calls === undefined) return Number.POSITIVE_INFINITY
    return Math.max(0, this.limits.calls - this.callsUsed)
  }

  /** Room left against the spend ceiling, against settled and held money alike. */
  private remainingUsd(): number {
    if (this.limits.spendUsd === undefined) return Number.POSITIVE_INFINITY
    return Math.max(0, this.limits.spendUsd - this.committedUsd())
  }

  /** Settled spend plus the estimates `reserve` is holding. */
  private committedUsd(): number {
    return this.spendUsd + this.reservedUsd
  }

  /**
   * Roll the window over if it has expired.
   *
   * `>=` rather than `>`: a window of 1_000ms that began at 0 covers `[0, 1000)`,
   * so the instant 1_000 belongs to the next one. Using `>` would hand back a
   * window that is one millisecond longer than the one that was configured.
   */
  private renew(): void {
    if (this.windowEndsAt === undefined) return
    const at = this.now()
    if (at < this.windowEndsAt) return
    const windowMs = this.limits.windowMs as number
    // Anchored to the expiry rather than to `now`, so a window does not stretch
    // by however long the process was idle before the next call arrived.
    let started = this.windowEndsAt
    while (started + windowMs <= at) started += windowMs
    this.windowStartedAt = started
    this.windowEndsAt = started + windowMs
    this.callsUsed = 0
    this.spendUsd = 0
    this.reservedUsd = 0
    this.reservedCalls = 0
    this.heldEstimates.length = 0
    this.unknownCostCalls = 0
  }
}
