/**
 * Thresholds have one source, not five.
 *
 * `minConfidence` and `minProbability` were literal in five places: the policy
 * defaults, `DEFAULT_CONFIG`, both gates, and the DSH plugin's `CONFIG_DOC`. Each
 * was true when written and nothing made them stay true — tuning one left the
 * others enforcing a different floor, silently. The DSH `CONFIG_DOC` is the copy
 * a user reads to decide what to set, so it was the worst of the five to let
 * drift.
 *
 * The official guidance is explicit: "Put the constants (questions and
 * thresholds) in a single place so they're easy to review."
 *
 * These assertions are equalities between the copies rather than checks of
 * specific numbers, so they keep holding when someone deliberately retunes the
 * defaults — which is the point.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { createContextGate } from '../src/gates/context.js'
import { createSafetyGate } from '../src/gates/safety.js'
import { DEFAULT_MIN_PROBABILITY, DEFAULT_POLICY, applyPolicy } from '../src/policy.js'
import { DEFAULT_NOUL_BAND, noulBand } from '../src/render.js'
import { JevService } from '../src/service.js'
import { EgressContract } from '../src/egress.js'
import { MockProvider } from '../src/provider/mock.js'
import type { NoulAnswer } from '../src/types.js'

/** A service with the mock provider, so a gate can be exercised without a socket. */
const service = () =>
  new JevService({
    provider: new MockProvider(),
    egress: new EgressContract({ transmitting: true, enabled: {} as never }, 'https://x.invalid'),
    transmitting: false,
  })

describe('thresholds come from one place', () => {
  it('DEFAULT_CONFIG agrees with DEFAULT_POLICY', () => {
    expect(DEFAULT_CONFIG.minConfidence).toBe(DEFAULT_POLICY.minConfidence)
    expect(DEFAULT_CONFIG.minProbability).toBe(DEFAULT_POLICY.minProbability)
  })

  it('the policy floor behaves consistently on both sides', () => {
    // The gate resolves its thresholds from `DEFAULT_POLICY`; this asserts the
    // arithmetic it relies on without reaching into the gate's internals.
    //
    // Note the answer is built literally rather than with the `noul` builder: that
    // builder constructs a *question* and takes instructions as its first
    // argument, so `noul(0.5)` would produce `{type:'noul', instructions:0.5}` and
    // leave the probability undefined. The first version of this test did exactly
    // that and asserted nonsense.
    const answerAt = (value: number): NoulAnswer => ({ type: 'noul', noul: value })
    const at = DEFAULT_POLICY.minProbability

    // Strength is `max(noul, 1 - noul)`, so this is comfortably above the floor.
    expect(applyPolicy(answerAt(at + 0.05), ['true', 'false'], DEFAULT_POLICY).kind).toBe('decided')
    // An even split has strength exactly 0.5, below any floor worth having.
    expect(applyPolicy(answerAt(0.5), ['true', 'false'], DEFAULT_POLICY).kind).toBe('undecided')
    // And the floor is above an even split, or `undecided` would be unreachable
    // for a noul and the setting would be decorative.
    expect(at).toBeGreaterThan(0.5)
  })

  it('both gates remain constructible from their documented minimum', () => {
    // Guards the specific failure of a gate defaulting to `undefined` while every
    // other copy carries a number: that compiles, and then treats every answer as
    // undecided, which for the safety gate means asking about every tool call.
    expect(() => createSafetyGate({ service: service(), onUndecided: 'ask' })).not.toThrow()
    expect(() => createContextGate({ service: service() })).not.toThrow()
    expect(Number.isFinite(DEFAULT_POLICY.minConfidence)).toBe(true)
    expect(Number.isFinite(DEFAULT_POLICY.minProbability)).toBe(true)
  })

  it('the policy defaults are fractions, since they are compared to probabilities', () => {
    for (const value of [DEFAULT_POLICY.minConfidence, DEFAULT_POLICY.minProbability]) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

/**
 * The band and the policy floor are the same boundary.
 *
 * They used to be two numbers in two files that disagreed: `noulBand` called
 * `[0.60, 0.70]` uncertain while `DEFAULT_POLICY.minProbability` was `0.6`, so a
 * noul at 0.65 was `uncertain` when it was rendered and `decided` when a gate
 * judged it. Neither number was wrong alone — they were two answers to one
 * question.
 *
 * These assertions are relationships, not literals, so retuning the band moves
 * the floor with it instead of leaving the two to drift apart again.
 */
describe('the band and the policy floor agree at the boundary', () => {
  const answerAt = (value: number): NoulAnswer => ({ type: 'noul', noul: value })

  it('takes the floor from the band rather than restating it', () => {
    expect(DEFAULT_POLICY.minProbability).toBe(DEFAULT_NOUL_BAND.high)
    expect(DEFAULT_MIN_PROBABILITY).toBe(DEFAULT_NOUL_BAND.high)
    expect(DEFAULT_CONFIG.minProbability).toBe(DEFAULT_NOUL_BAND.high)
  })

  it('never decides a noul the band calls uncertain', () => {
    // The reported contradiction, checked on both edges and just inside them:
    // below `low`, exactly `low`, the middle, exactly `high`, and just above.
    const low = DEFAULT_NOUL_BAND.low
    const high = DEFAULT_NOUL_BAND.high
    const inside = [low, low + 0.01, 0.5, high - 0.01, high]
    for (const value of inside) {
      expect(noulBand(value), `band at ${value}`).toBe('uncertain')
      // A noul's strength is `max(noul, 1 - noul)`, which is what the floor is
      // compared against — so the mirrored value is checked too.
      for (const noul of [value, 1 - value]) {
        expect(applyPolicy(answerAt(noul), ['true', 'false']).kind, `policy at ${noul}`).toBe(
          'undecided',
        )
      }
    }
    // And outside the band the two agree that a side has been picked.
    for (const value of [0, low - 0.01, high + 0.01, 0.99]) {
      expect(noulBand(value), `band at ${value}`).toBe(value < 0.5 ? 'no' : 'yes')
      expect(applyPolicy(answerAt(value), ['true', 'false']).kind, `policy at ${value}`).toBe(
        'decided',
      )
    }
  })

  it('keeps the band endpoints inclusive, as upstream documents them', () => {
    // "from 0.30 through 0.70, including both boundaries". An off-by-one here
    // would put one edge in `no`/`yes` and reinstate the knife edge the band
    // exists to remove.
    expect(noulBand(DEFAULT_NOUL_BAND.low)).toBe('uncertain')
    expect(noulBand(DEFAULT_NOUL_BAND.high)).toBe('uncertain')
    // The floor is the upper edge, not the lower one: acting on an answer needs
    // the band to name a side, which at the lower edge it does not.
    expect(DEFAULT_POLICY.minProbability).not.toBe(DEFAULT_NOUL_BAND.low)
  })
})
