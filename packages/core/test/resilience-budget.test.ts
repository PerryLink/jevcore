/**
 * A ceiling is only a ceiling if the boundary is exact.
 *
 * The existing request path bounds how long one call may take and nothing about
 * how many there are, so the tests that matter here are the ones at the edge:
 * the third call under `calls: 3` is allowed and the fourth is refused, and a
 * spend ceiling of $0.50 refuses the call that would take the total *to* $0.50
 * rather than the one after it. An off-by-one in a budget is not a rounding
 * error; it is a limit that does not hold.
 *
 * The other half is the honest one. On a route that reports no usage, cost is not
 * zero — it is unknown, and the difference between those two readings is whether
 * a spend ceiling means anything at all. Every test here drives an injected clock.
 */

import { describe, expect, it } from 'vitest'
import {
  JevBudget,
  JevBudgetExceededError,
  ZERO_BUDGET,
  type BudgetLimits,
} from '../src/resilience/index.js'
import { JevProviderError } from '../src/types.js'

/** Limits plus the clock a test drives, so a setup reads as one object. */
type BudgetSetup = BudgetLimits & { readonly now?: () => number }

/**
 * Build a budget from a setup whose `now`, if present, is lifted out of the
 * limits and handed to the budget as its clock.
 *
 * The lift is the point of this helper. A clock left *inside* the limits object
 * is invisible to the budget, which then reads the wall clock: every assertion
 * about a window would pass against a machine whose tests happen to run quickly,
 * and the suite would be testing nothing. That is not hypothetical — it is what
 * the first draft of these tests did.
 */
const budgetOf = (setup: BudgetSetup): JevBudget => {
  const { now, ...limits } = setup
  return new JevBudget(now === undefined ? { limits } : { limits, now })
}

/** A clock a test moves by hand. Nothing here reads the real one. */
const clock = (start = 0): { now: () => number; advance: (ms: number) => void } => {
  let at = start
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

/** Reserve and settle one call at a stated cost, which is the paired lifecycle. */
const chargedCall = (budget: JevBudget, costUsd?: number): void => {
  budget.reserve(costUsd)
  budget.recordCost(costUsd)
}

/** Walk a budget up to its call ceiling, charging nothing. */
const spendCalls = (budget: JevBudget, times: number): void => {
  for (let index = 0; index < times; index += 1) {
    budget.reserve()
    budget.recordCost()
  }
}

/** The refusal a call produced, or `undefined` when it was allowed. */
const refusalOf = (call: () => void): JevBudgetExceededError | undefined => {
  try {
    call()
    return undefined
  } catch (thrown) {
    return thrown as JevBudgetExceededError
  }
}

describe('the call ceiling refuses at the exact boundary', () => {
  it('allows exactly the configured number of calls and refuses the next', () => {
    const budget = budgetOf({ calls: 3 })
    expect(budget.check().allowed).toBe(true)
    spendCalls(budget, 3)
    const fourth = budget.check()
    expect(fourth.allowed).toBe(false)
    if (fourth.allowed) throw new Error('unreachable')
    expect(fourth.limit).toBe('calls')
    expect(fourth.callsUsed).toBe(3)
    expect(fourth.remainingCalls).toBe(0)
    expect(() => budget.reserve()).toThrow(JevBudgetExceededError)
  })

  it('counts the call when it is reserved, not when it is reported', () => {
    // The call ceiling has to bite *before* the call, so it is charged at
    // `reserve`. `recordCost` settles the money and never charges a call again.
    const budget = budgetOf({ calls: 2 })
    budget.check()
    expect(budget.report().callsUsed).toBe(0)
    budget.reserve()
    expect(budget.report().callsUsed).toBe(1)
    budget.recordCost(0)
    expect(budget.report().callsUsed).toBe(1)
    budget.reserve()
    expect(budget.check().allowed).toBe(false)
  })

  it('treats a ceiling of zero as a ceiling, not as "unlimited"', () => {
    expect(budgetOf(ZERO_BUDGET).check().allowed).toBe(false)
    expect(budgetOf({}).check().allowed).toBe(true)
  })
})

describe('a spend ceiling refuses at the exact boundary', () => {
  it('refuses the call that would reach the ceiling, not the one after it', () => {
    // 0.25 is exact in binary, so the boundary under test is the comparison and
    // not the floating-point arithmetic arriving at it.
    const budget = budgetOf({ spendUsd: 0.5 })
    chargedCall(budget, 0.25)
    chargedCall(budget, 0.25)
    expect(budget.report().spendUsd).toBe(0.5)
    expect(budget.report().reservedUsd).toBe(0)
    const third = budget.check()
    expect(third.allowed).toBe(false)
    if (third.allowed) throw new Error('unreachable')
    expect(third.limit).toBe('spend')
    expect(third.remainingUsd).toBe(0)
    expect(() => budget.reserve(0)).toThrow(JevBudgetExceededError)
  })

  it('lets a call through while there is room below the ceiling', () => {
    const budget = budgetOf({ spendUsd: 0.5 })
    chargedCall(budget, 0.25)
    const second = budget.check()
    expect(second.allowed).toBe(true)
    expect(second.remainingUsd).toBe(0.25)
    chargedCall(budget, 0.1)
    expect(budget.report().spendUsd).toBeCloseTo(0.35, 10)
  })

  it('holds an estimate against the ceiling before the call happens', () => {
    const budget = budgetOf({ spendUsd: 0.3 })
    const held = budget.reserve(0.2)
    expect(budget.report().reservedUsd).toBe(0.2)
    // Nothing has been spent yet, and the money is already unavailable.
    expect(budget.report().spendUsd).toBe(0)
    expect(held.remainingUsd).toBeCloseTo(0.1, 10)
    const second = budget.check()
    expect(second.allowed).toBe(true)
    // 0.2 + 0.2 would commit 0.4 against a 0.3 ceiling, so this call is refused
    // rather than allowed and discovered afterwards.
    const refused = refusalOf(() => budget.reserve(0.2))
    expect(refused?.limit).toBe('spend')
    expect(refused?.message).toMatch(/would commit/)
    expect(budget.report().callsUsed).toBe(1)
  })

  it('allows a call whose estimate fits the ceiling exactly', () => {
    // The boundary belongs to the caller: an estimate of exactly what is left is
    // affordable. Refusing it would make the last affordable call unmakeable.
    const budget = budgetOf({ spendUsd: 0.3 })
    const held = budget.reserve(0.3)
    expect(budget.report().reservedUsd).toBe(0.3)
    expect(held.remainingUsd).toBe(0)
    expect(budget.check().allowed).toBe(false)
  })

  it('releases the estimate and charges the real cost when the call settles', () => {
    const budget = budgetOf({ spendUsd: 0.3 })
    budget.reserve(0.2)
    budget.recordCost(0.05)
    const report = budget.report()
    expect(report.reservedUsd).toBe(0)
    expect(report.spendUsd).toBe(0.05)
    expect(report.spendBounded).toBe(true)
    // The under-estimate is what it is: the ceiling had 0.25 in hand, not 0.05.
    expect(budget.check().remainingUsd).toBeCloseTo(0.25, 10)
  })

  it('refuses to settle a call that was never reserved', () => {
    // Either reading of an unmatched call corrupts a total: counting it would
    // double-charge a call already reserved, and not counting it would invent a
    // free one. Refusing loudly is the only honest option.
    const budget = budgetOf({ spendUsd: 1 })
    expect(() => budget.recordCost(0.1)).toThrow(RangeError)
    expect(budget.report().spendUsd).toBe(0)
    expect(budget.report().callsUsed).toBe(0)
  })

  it('refuses a negative cost, which is not a refund', () => {
    const budget = budgetOf({ spendUsd: 1 })
    budget.reserve()
    expect(() => budget.recordCost(-0.1)).toThrow(RangeError)
  })
})

describe('cost that is unknown is not cost that is zero', () => {
  it('counts an unreported cost as unknown and spends nothing', () => {
    const budget = budgetOf({ spendUsd: 0.5 })
    budget.reserve()
    budget.recordCost()
    const report = budget.report()
    expect(report.spendUsd).toBe(0)
    expect(report.unknownCostCalls).toBe(1)
    // The number an operator needs: a ceiling exists and cannot be enforced
    // against the calls that were counted.
    expect(report.spendBounded).toBe(false)
  })

  it('treats a reported zero as a known zero, which does not unbind the ceiling', () => {
    // The mock reports `costUsd: 0`. That is a real answer, and it is different
    // from silence.
    const budget = budgetOf({ spendUsd: 0.5 })
    chargedCall(budget, 0)
    const report = budget.report()
    expect(report.unknownCostCalls).toBe(0)
    expect(report.spendUsd).toBe(0)
    expect(report.spendBounded).toBe(true)
  })

  it('is unbounded by definition when no spend ceiling was configured', () => {
    const budget = budgetOf({ calls: 10 })
    budget.reserve()
    budget.recordCost()
    expect(budget.report().spendBounded).toBe(true)
    expect(budget.report().unknownCostCalls).toBe(1)
  })

  it('reports a window as unsettled while a reservation is still held', () => {
    const budget = budgetOf({ spendUsd: 0.5 })
    budget.reserve(0.1)
    expect(budget.report().spendBounded).toBe(false)
    budget.recordCost(0.1)
    expect(budget.report().spendBounded).toBe(true)
  })

  it('refuses an unknown-cost call outright under the strict policy', () => {
    const budget = budgetOf({ spendUsd: 1, unknownCost: 'refuse' })
    const refused = refusalOf(() => budget.reserve())
    expect(refused).toBeInstanceOf(JevBudgetExceededError)
    expect(refused?.limit).toBe('unknown-cost')
    expect(refused?.message).toMatch(/Nothing was transmitted/)
    expect(budget.report().callsUsed).toBe(0)
    // An estimate is enough to get through, because then the ceiling has
    // something to bite on.
    expect(() => budget.reserve(0.01)).not.toThrow()
    expect(budget.report().callsUsed).toBe(1)
    expect(budget.report().unknownCostCalls).toBe(0)
  })

  it('keeps the two kinds of exclusion apart in the refusal message', () => {
    const budget = budgetOf({ calls: 1 })
    budget.reserve()
    budget.recordCost()
    const refused = refusalOf(() => budget.reserve())
    expect(refused?.limit).toBe('calls')
    expect(refused?.message).toMatch(/not an upstream failure/)
  })
})

describe('the window rolls over on the clock', () => {
  it('resets the counters at the window boundary and not before', () => {
    const at = clock(1_000)
    const budget = budgetOf({ calls: 2, windowMs: 1_000, now: at.now })
    spendCalls(budget, 2)
    expect(budget.check().allowed).toBe(false)

    at.advance(999)
    expect(budget.check().allowed).toBe(false)
    expect(budget.report().callsUsed).toBe(2)

    // Exactly at the boundary belongs to the next window: `[0, 1000)` was the
    // first one.
    at.advance(1)
    const next = budget.check()
    expect(next.allowed).toBe(true)
    expect(next.callsUsed).toBe(0)
    expect(budget.report().windowStartedAt).toBe(2_000)
    expect(budget.report().windowEndsAt).toBe(3_000)
  })

  it('anchors windows to the clock rather than to when the process woke up', () => {
    const at = clock(0)
    const budget = budgetOf({ calls: 1, windowMs: 1_000, now: at.now })
    spendCalls(budget, 1)
    // Idle for three and a half windows. The current window is the one containing
    // `now`, so it began at 3_000 and ends at 4_000 — not at `now + 1000`.
    at.advance(3_500)
    expect(budget.report().callsUsed).toBe(0)
    expect(budget.report().windowStartedAt).toBe(3_000)
    expect(budget.report().windowEndsAt).toBe(4_000)
  })

  it('never resets when no window was configured', () => {
    const at = clock(0)
    const budget = budgetOf({ calls: 1, now: at.now })
    spendCalls(budget, 1)
    at.advance(86_400_000)
    expect(budget.check().allowed).toBe(false)
    expect(budget.report().windowEndsAt).toBeUndefined()
  })

  it('resets on demand, releasing a held estimate as well', () => {
    const at = clock(0)
    const budget = budgetOf({ calls: 1, spendUsd: 1, windowMs: 60_000, now: at.now })
    budget.reserve(0.5)
    expect(budget.report().reservedUsd).toBe(0.5)
    budget.reset()
    const report = budget.report()
    expect(report.callsUsed).toBe(0)
    expect(report.spendUsd).toBe(0)
    expect(report.reservedUsd).toBe(0)
    expect(report.windowStartedAt).toBe(0)
    expect(budget.check().allowed).toBe(true)
  })
})

describe('a budget refusal is distinguishable from a provider failure', () => {
  it('is not a JevProviderError and carries no provider code', () => {
    // The difference a `catch` needs: a provider failure means the upstream had a
    // problem, a refusal means this process decided not to ask.
    const budget = budgetOf({ calls: 0 })
    let caught: unknown
    try {
      budget.assert()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(JevBudgetExceededError)
    expect(caught).not.toBeInstanceOf(JevProviderError)
    expect(caught instanceof JevBudgetExceededError && 'code' in caught).toBe(false)
    expect((caught as Error).name).toBe('JevBudgetExceededError')
  })
})

describe('a budget that cannot mean anything is refused rather than honoured', () => {
  it('refuses a non-integer or negative call ceiling', () => {
    expect(() => budgetOf({ calls: 1.5 })).toThrow(RangeError)
    expect(() => budgetOf({ calls: -1 })).toThrow(RangeError)
  })

  it('refuses a NaN or negative spend ceiling', () => {
    // `NaN` compares false against everything, so a NaN ceiling would permit
    // every call forever while looking like a configured limit.
    expect(() => budgetOf({ spendUsd: Number.NaN })).toThrow(RangeError)
    expect(() => budgetOf({ spendUsd: -0.01 })).toThrow(RangeError)
  })

  it('refuses a window that is not a positive number of milliseconds', () => {
    expect(() => budgetOf({ windowMs: 0 })).toThrow(RangeError)
    expect(() => budgetOf({ windowMs: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })

  it('reports the ceilings in force so a status surface need not guess', () => {
    const budget = budgetOf({ calls: 3, spendUsd: 1, windowMs: 1_000 })
    expect(budget.limitsInForce).toEqual({ calls: 3, spendUsd: 1, windowMs: 1_000 })
  })
})
