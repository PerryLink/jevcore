/**
 * The resilience layer, wired into `JevService`.
 *
 * `resilience-{cache,budget,breaker}.test.ts` prove the three modules behave
 * correctly on their own. They say nothing about whether the service uses them,
 * and this file exists because "the module is tested" and "the feature works" are
 * different claims — the gap between them is what the `presentationMeta` defect
 * in `packages/dsh` lived in for a whole release.
 *
 * The behaviours worth naming up front, because each is a decision rather than an
 * implementation detail:
 *
 *  - a cache hit does NOT increment `transmitted`. That counter means "left the
 *    machine", and nothing did;
 *  - a hit reports `latencyMs: 0` and drops `usage`, because both stored values
 *    describe the call that filled the cache and would otherwise let a caller
 *    total up work that never happened;
 *  - a budget refusal and an open breaker are NOT provider failures. They throw
 *    before the provider is touched, so `failures` does not move and the breaker
 *    does not learn anything from them;
 *  - the budget is handed `undefined` for a route that reports no cost, never
 *    `0`, because the two are different facts and only one of them bounds spend.
 */

import { describe, expect, it } from 'vitest'
import { EGRESS_FEATURES, EgressContract, type EgressFeature } from '../src/egress.js'
import { noul } from '../src/primitives.js'
import { BreakerOpenError, FailureBreaker } from '../src/resilience/breaker.js'
import { JevBudget, JevBudgetExceededError, ZERO_BUDGET } from '../src/resilience/budget.js'
import { AnswerCache } from '../src/resilience/cache.js'
import { JevService } from '../src/service.js'
import { JevProviderError, type JevProvider, type JevResult } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const contract = () =>
  new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai')

const questions = { q: noul('Is this so?') }

/** A provider that counts how often it was actually reached. */
const counting = (options: { readonly failEvery?: boolean; readonly costUsd?: number } = {}) => {
  let calls = 0
  const provider: JevProvider = {
    id: 'counting',
    answer: async (): Promise<JevResult> => {
      calls += 1
      if (options.failEvery === true) {
        throw new JevProviderError('the endpoint is not answering', 'upstream-unreachable')
      }
      return {
        model: 'counting-model',
        provider: 'counting',
        latencyMs: 7,
        answers: { q: { type: 'noul', noul: 0.91 } },
        // Deliberately without a cost: the official TypeSafe route reports none,
        // so this is the shape every real call has.
        usage: options.costUsd === undefined
          ? { inputTokens: 3, outputTokens: 1 }
          : { inputTokens: 3, outputTokens: 1, costUsd: options.costUsd },
      }
    },
  }
  return { provider, reached: () => calls }
}

const caching = () => new AnswerCache({ decision: { mode: 'allow', features: ['tool:jev_ask'] } })

describe('the answer cache, wired in', () => {
  it('serves the second identical request without transmitting it', async () => {
    const { provider, reached } = counting()
    const service = new JevService({ provider, egress: contract(), cache: caching() })

    const first = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    const second = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    expect(reached()).toBe(1)
    expect(second.answers.q).toEqual(first.answers.q)
    expect(service.stats().calls).toBe(2)
    // The point of the whole feature: the second call left nothing.
    expect(service.stats().transmitted).toBe(1)
    expect(service.stats().lastCall?.cached).toBe(true)
  })

  it('reports the hit honestly rather than replaying the original call', async () => {
    const { provider } = counting()
    const service = new JevService({ provider, egress: contract(), cache: caching() })

    const first = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    const second = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    expect(first.latencyMs).toBe(7)
    // Zero, because this call took no measurable time and the stored 7ms belongs
    // to a call that already happened.
    expect(second.latencyMs).toBe(0)
    // Dropped, because these tokens were not spent now. A caller summing `usage`
    // across calls would otherwise double-count them.
    expect(second.usage).toBeUndefined()
    // The egress facts are this call's, not the stored ones.
    expect(second.egress?.stateChars).toBeGreaterThan(0)
  })

  it('never serves a feature that is protected from caching', async () => {
    const { provider, reached } = counting()
    const service = new JevService({ provider, egress: contract(), cache: caching() })

    // `gate:safety` is excluded in code, not by configuration, so a decision that
    // names it cannot turn it on.
    await service.ask({ feature: 'gate:safety', state: { t: 1 }, questions })
    await service.ask({ feature: 'gate:safety', state: { t: 1 }, questions })

    expect(reached()).toBe(2)
    expect(service.stats().lastCall?.cached).toBeUndefined()
  })
})

describe('the budget, wired in', () => {
  it('refuses before the provider is touched, and not as a provider failure', async () => {
    const { provider, reached } = counting()
    const service = new JevService({
      provider,
      egress: contract(),
      budget: new JevBudget({ limits: ZERO_BUDGET }),
    })

    await expect(service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })).rejects.toThrow(
      JevBudgetExceededError,
    )

    // Nothing was sent, so nothing about the provider was learned: it was never
    // reached, no failure is recorded, and `transmitted` stays at zero.
    expect(reached()).toBe(0)
    expect(service.stats().failures).toBe(0)
    expect(service.stats().transmitted).toBe(0)
  })

  it('treats an unreported cost as unknown rather than free', async () => {
    const { provider } = counting()
    const budget = new JevBudget({ limits: { calls: 5, spendUsd: 1 } })
    const service = new JevService({ provider, egress: contract(), budget })

    await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    const report = budget.report()
    // The distinction that stops a spend ceiling from bounding nothing: this
    // route cannot report cost, so the spend figure is a lower bound and says so.
    expect(report.unknownCostCalls).toBe(1)
    expect(report.spendBounded).toBe(false)
  })
})

describe('the breaker, wired in', () => {
  it('stops calling a failing provider, and does not count its own refusal as a failure', async () => {
    const { provider, reached } = counting({ failEvery: true })
    const service = new JevService({
      provider,
      egress: contract(),
      breaker: new FailureBreaker({ failureThreshold: 2 }),
    })

    const attempt = () => service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    await expect(attempt()).rejects.toThrow(JevProviderError)
    await expect(attempt()).rejects.toThrow(JevProviderError)
    expect(service.stats().failures).toBe(2)

    // Now open. The third call must not reach the provider at all...
    await expect(attempt()).rejects.toThrow(BreakerOpenError)
    expect(reached()).toBe(2)
    // ...and must not be recorded as a third provider failure, because the
    // provider was never asked.
    expect(service.stats().failures).toBe(2)
  })
})
