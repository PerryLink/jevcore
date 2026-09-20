/**
 * The service's bookkeeping, under the two things that used to be able to corrupt
 * it: a reader with the history in hand, and a cache that throws.
 *
 * Every assertion here is a defect an adversarial verifier reproduced against the
 * shipped code, and each one shares a theme worth naming: the service advertises
 * "the honest record of what actually happened", and every way of making that
 * sentence false is a failure of *accounting* rather than of answering. A record a
 * caller can rewrite, a budget charged for a call that was never made, and a
 * provider success retold as a provider failure all leave the numbers describing a
 * process that did not run.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  type EgressFeature,
  type MeasuredPayload,
} from '../src/egress.js'
import { noul } from '../src/primitives.js'
import { BreakerOpenError, FailureBreaker } from '../src/resilience/breaker.js'
import { JevBudget, JevBudgetExceededError, ZERO_BUDGET } from '../src/resilience/budget.js'
import { AnswerCache, type CacheKey } from '../src/resilience/cache.js'
import { JevService } from '../src/service.js'
import {
  JevProviderError,
  type JevProvider,
  type JevResult,
  type JsonValue,
} from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const contract = () =>
  new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai')

const questions = { q: noul('Is this so?') }

/** A contract that keeps the payload it measured, so a test can inspect it. */
class RecordingContract extends EgressContract {
  last: MeasuredPayload | undefined

  override measure(input: Parameters<EgressContract['measure']>[0]): MeasuredPayload {
    const measured = super.measure(input)
    this.last = measured
    return measured
  }
}

const caching = () => new AnswerCache({ decision: { mode: 'allow', features: ['tool:jev_ask'] } })

describe('the recorded history is not writable from outside', () => {
  /** A provider that answers, and reports one redaction rule's worth of context. */
  const answering = (): JevProvider => ({
    id: 'answering',
    answer: async (): Promise<JevResult> => ({
      model: 'm',
      provider: 'answering',
      latencyMs: 1,
      answers: { q: { type: 'noul', noul: 0.5 } },
    }),
  })

  it('refuses the forgery that used to succeed, and the history is unchanged', async () => {
    // The verifier's reproduction: `svc.recent()[0].redactionRules.push('FORGED-
    // RULE')` succeeded, and `svc.stats().lastCall.redactionRules` then showed the
    // forged rule — the record of what happened, rewritten by a reader of it.
    const service = new JevService({ provider: answering(), egress: contract() })
    await service.ask({ feature: 'tool:jev_ask', state: { password: 'abc' }, questions })

    const record = service.recent()[0]
    expect(record).toBeDefined()
    if (record === undefined) return

    expect(Object.isFrozen(record.redactionRules)).toBe(true)
    // The attempt is made the way the verifier made it. Whether it throws (a
    // frozen array in strict mode) or silently does nothing is an engine detail;
    // what must hold either way is that the history does not move.
    try {
      ;(record.redactionRules as string[]).push('FORGED-RULE')
    } catch {
      // Expected: the array is frozen.
    }

    expect(service.recent()[0]?.redactionRules).not.toContain('FORGED-RULE')
    expect(service.stats().lastCall?.redactionRules).not.toContain('FORGED-RULE')
    // The honest value is still there, so the assertions above cannot pass by the
    // array having been emptied.
    expect(service.stats().lastCall?.redactionRules).toContain('key-name')
  })

  it('copies the measured array instead of freezing the contract’s own', async () => {
    // Both halves of the same bug. Storing the measured array unfrozen leaves the
    // history writable; freezing it in place reaches out of this class and freezes
    // an array the egress contract also handed back.
    const egress = new RecordingContract({ transmitting: true, enabled: allOn() }, 'https://x')
    const service = new JevService({ provider: answering(), egress })
    await service.ask({ feature: 'tool:jev_ask', state: { password: 'abc' }, questions })

    const measured = egress.last
    expect(measured).toBeDefined()
    if (measured === undefined) return

    expect(Object.isFrozen(measured.redactionRules)).toBe(false)
    expect(service.recent()[0]?.redactionRules).not.toBe(measured.redactionRules)
    expect(service.recent()[0]?.redactionRules).toEqual(measured.redactionRules)
  })

  it('hands the observer the same unwritable record', async () => {
    // `onRecord` gets the stored record itself, so the hook is one more reader
    // that must not be able to rewrite what the others are shown.
    let seen: readonly string[] | undefined
    const service = new JevService({
      provider: answering(),
      egress: contract(),
      onRecord: (record) => {
        seen = record.redactionRules
        try {
          ;(record.redactionRules as string[]).push('FORGED-RULE')
        } catch {
          // Expected.
        }
      },
    })
    await service.ask({ feature: 'tool:jev_ask', state: { password: 'abc' }, questions })

    expect(seen).toContain('key-name')
    expect(service.recent()[0]?.redactionRules).not.toContain('FORGED-RULE')
  })
})

describe('a call that was never made does not cost a call', () => {
  it('leaves the budget untouched when the breaker refuses', async () => {
    // The verifier's measurement: with `limits: { calls: 3 }` and a failing
    // provider, `callsUsed` reached 3 while `transmitted` stayed at 0 — every
    // refusal from the open breaker charged the ceiling even though nothing left
    // the machine. `reserve()` charges immediately and nothing releases a charge
    // for a call that was never made, so the order is what fixes it.
    const budget = new JevBudget({ limits: { calls: 3, spendUsd: 1 } })
    const breaker = new FailureBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    let reached = 0
    const failing: JevProvider = {
      id: 'failing',
      answer: async () => {
        reached += 1
        throw new JevProviderError('the endpoint is not answering', 'upstream-unreachable')
      },
    }
    const service = new JevService({ provider: failing, egress: contract(), budget, breaker })

    const attempt = () => service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    // One real attempt: the provider is reached, fails, and the breaker opens.
    await expect(attempt()).rejects.toThrow(JevProviderError)
    expect(reached).toBe(1)
    const afterFailure = budget.report().callsUsed
    expect(afterFailure).toBe(1)

    // Two more attempts, refused by the open breaker before anything is reserved.
    await expect(attempt()).rejects.toThrow(BreakerOpenError)
    await expect(attempt()).rejects.toThrow(BreakerOpenError)
    expect(reached).toBe(1)
    expect(budget.report().callsUsed).toBe(afterFailure)
    expect(service.stats().transmitted).toBe(1)
    // The failed call's own reservation is still held, and deliberately so: the
    // budget documents that a caller which reserves and never settles
    // under-spends rather than over-spends, because the money may already have
    // been spent. What must not happen is the *refusals* adding to it, which is
    // what the two attempts above would have done before the order changed.
  })

  it('still refuses on the budget when the breaker is closed', async () => {
    // The order changed; the budget's own refusal did not. Both still throw
    // outside the provider call, and neither is a provider failure.
    const budget = new JevBudget({ limits: ZERO_BUDGET })
    const breaker = new FailureBreaker({ failureThreshold: 1 })
    const service = new JevService({
      provider: {
        id: 'untouched',
        answer: async () => {
          throw new Error('the provider must not be reached')
        },
      },
      egress: contract(),
      budget,
      breaker,
    })

    await expect(
      service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions }),
    ).rejects.toThrow(JevBudgetExceededError)
    expect(service.stats().failures).toBe(0)
    expect(breaker.snapshot().state).toBe('closed')
  })
})

describe('a cache failure is not a provider failure', () => {
  /** A cache whose write side is broken, which is the latent case: a disk, a store. */
  class ThrowingCache extends AnswerCache {
    override store(_key: CacheKey, _result: JsonValue): void {
      throw new Error('cache disk full')
    }
  }

  it('returns the provider’s answer and keeps the accounting clean', async () => {
    // `cache.store` used to be called inside the same `try` as the provider call,
    // so its exception landed in the provider-failure `catch`: `failures`
    // incremented, `breaker.recordFailure` ran, and a call whose provider answered
    // correctly was counted — and thrown away — as a provider failure. The breaker
    // ignored that particular error because it was not a `JevProviderError`; a
    // store that threw one would have counted, and the call was misreported either
    // way.
    const breaker = new FailureBreaker({ failureThreshold: 3 })
    const service = new JevService({
      provider: {
        id: 'answering',
        answer: async (): Promise<JevResult> => ({
          model: 'm',
          provider: 'answering',
          latencyMs: 4,
          answers: { q: { type: 'noul', noul: 0.5 } },
        }),
      },
      egress: contract(),
      cache: new ThrowingCache({ decision: { mode: 'allow', features: ['tool:jev_ask'] } }),
      breaker,
    })

    const result = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    // The answer survives, which is the point: a call that succeeded is still a
    // call that succeeded.
    expect(result.answers.q).toEqual({ type: 'noul', noul: 0.5 })
    const stats = service.stats()
    expect(stats.calls).toBe(1)
    expect(stats.failures).toBe(0)
    expect(stats.transmitted).toBe(1)
    expect(stats.lastCall?.ok).toBe(true)
    // Nothing was learned about the provider's health from a storage bug, so the
    // breaker must not have been told anything either.
    expect(breaker.snapshot().state).toBe('closed')
    expect(breaker.snapshot().consecutiveFailures).toBe(0)
  })

  it('loses only the reuse, which is what the swallow costs', async () => {
    // Stated rather than hidden: swallowing means the next identical request
    // transmits and is billed again. Asserted so the cost of the decision is
    // visible in the suite rather than only in the comment.
    let reached = 0
    const service = new JevService({
      provider: {
        id: 'counting',
        answer: async (): Promise<JevResult> => {
          reached += 1
          return {
            model: 'm',
            provider: 'counting',
            latencyMs: 1,
            answers: { q: { type: 'noul', noul: 0.5 } },
          }
        },
      },
      egress: contract(),
      cache: new ThrowingCache({ decision: { mode: 'allow', features: ['tool:jev_ask'] } }),
    })

    await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    expect(reached).toBe(2)
    expect(service.stats().transmitted).toBe(2)
    expect(service.stats().failures).toBe(0)
  })
})

describe('a cache hit keeps the synthetic marker', () => {
  /** A result that marks its own answers as synthetic, as a route may. */
  type MarkedResult = JevResult & { readonly warning: string }

  const marked = (): JevProvider => ({
    id: 'marked',
    answer: async (): Promise<MarkedResult> => ({
      model: 'm',
      provider: 'marked',
      latencyMs: 42,
      answers: { q: { type: 'noul', noul: 0.5 } },
      usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.01 },
      warning: 'These answers are SYNTHETIC.',
    }),
  })

  it('carries warning through, while still dropping what describes the first call', async () => {
    // The verifier measured `keys(first) → keys(second) === ['usage', 'warning']`:
    // the hit path rebuilds from `provider`, `model`, `answers` and `latencyMs: 0`,
    // which is right for `usage` (tokens this call did not spend) and wrong for
    // `warning` — the marker that says the answers are not real. A cached
    // synthetic answer must not come back looking like a real judgment.
    const service = new JevService({ provider: marked(), egress: contract(), cache: caching() })

    const first = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    const second = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    expect((first as MarkedResult).warning).toBe('These answers are SYNTHETIC.')
    expect((second as MarkedResult).warning).toBe('These answers are SYNTHETIC.')
    // The fields that must still be dropped, so this test cannot be satisfied by
    // replaying the first result wholesale.
    expect(second.usage).toBeUndefined()
    expect(second.latencyMs).toBe(0)
    expect(service.stats().lastCall?.cached).toBe(true)
  })

  it('does not invent a warning for a result that had none', async () => {
    const service = new JevService({
      provider: {
        id: 'plain',
        answer: async (): Promise<JevResult> => ({
          model: 'm',
          provider: 'plain',
          latencyMs: 1,
          answers: { q: { type: 'noul', noul: 0.5 } },
        }),
      },
      egress: contract(),
      cache: caching(),
    })

    await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    const second = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })

    expect('warning' in second).toBe(false)
  })
})
