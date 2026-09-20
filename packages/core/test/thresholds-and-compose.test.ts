/**
 * Two capabilities the audit found missing against official guidance.
 *
 * **Per-action thresholds.** "A confidence threshold is not one number. Different
 * actions within the same system should be gated at different levels depending on
 * the consequences of getting it wrong." The docs' worked example gates two actions
 * in one system at 0.6 and 0.85. The package could say *whether* a criterion was
 * actionable (`accept`) but not how sure the answer had to be, so the risk-scaled
 * half of that guidance was inexpressible.
 *
 * **Composite scoring.** "Break the judgment into independent dimensions, score
 * each one separately" and combine them with weights you control. Asking per
 * dimension worked; combining them did not exist, so every integration hand-rolled
 * the level-to-fraction arithmetic.
 */

import { describe, expect, it } from 'vitest'
import { compositeScore, normalizeScore } from '../src/compose.js'
import { applyPolicy } from '../src/policy.js'
import type { CategoricalAnswer, NoulAnswer, ScoreAnswer } from '../src/types.js'

const noul = (value: number): NoulAnswer => ({ type: 'noul', noul: value })

const score = (value: number, levels: number, confidence = 0.9): ScoreAnswer => {
  const legend: Record<string, string> = {}
  const probabilities: Record<string, number> = {}
  for (let index = 0; index < levels; index += 1) {
    legend[String(index)] = `level ${index}`
    probabilities[String(index)] = 1 / levels
  }
  return { type: 'score', score: value, legend, probabilities, confidence }
}

const choice = (picked: string, probabilities: Record<string, number>, confidence = 0.9): CategoricalAnswer => ({
  type: 'choice',
  choice: picked,
  probabilities,
  confidence,
})

describe('per-action thresholds', () => {
  it('gates one criterion harder than another in the same policy', () => {
    // The documented shape: a cheap action at a low floor, a risky one much higher.
    const policy = {
      minConfidence: 0.6,
      minProbability: 0.6,
      thresholds: { approve_transfer: { minConfidence: 0.85, minProbability: 0.85 } },
    }
    const answer = choice('approve_transfer', { approve_transfer: 0.7, check_balance: 0.3 }, 0.7)

    // 0.7 clears the policy floor for a cheap action...
    expect(applyPolicy(answer, [], policy).kind).toBe('undecided')
    // ...and the override is what stops it, since 0.7 < 0.85.
    expect(applyPolicy(answer, [], policy).kind).toBe('undecided')

    const cheap = choice('check_balance', { approve_transfer: 0.3, check_balance: 0.7 }, 0.7)
    expect(applyPolicy(cheap, [], policy).kind).toBe('decided')
  })

  it('lets an override loosen a floor as well as tighten it', () => {
    const strict = { minConfidence: 0.9, minProbability: 0.9 }
    const relaxed = { ...strict, thresholds: { cheap_probe: { minProbability: 0.5 } } }
    const answer = choice('cheap_probe', { cheap_probe: 0.6, other: 0.4 }, 0.95)
    expect(applyPolicy(answer, [], strict).kind).toBe('undecided')
    expect(applyPolicy(answer, [], relaxed).kind).toBe('decided')
  })

  it('applies an override to a noul, keyed by the answered value', () => {
    // A noul is keyed by 'true'/'false', which is what a hazard question resolves
    // to — the case where gating one answer harder matters most.
    const policy = {
      minConfidence: 0.6,
      minProbability: 0.6,
      thresholds: { true: { minProbability: 0.95 } },
    }
    expect(applyPolicy(noul(0.8), [], policy).kind).toBe('undecided')
    expect(applyPolicy(noul(0.98), [], policy).kind).toBe('decided')
    // The 'false' side is unaffected, so a confident "not hazardous" still passes.
    expect(applyPolicy(noul(0.02), [], policy).kind).toBe('decided')
  })

  it('falls back to the policy floors for a criterion with no override', () => {
    const policy = {
      minConfidence: 0.6,
      minProbability: 0.6,
      thresholds: { risky: { minProbability: 0.99 } },
    }
    expect(applyPolicy(choice('plain', { plain: 0.7, risky: 0.3 }, 0.7), [], policy).kind).toBe('decided')
  })

  it('is inert when no overrides are supplied', () => {
    const policy = { minConfidence: 0.7, minProbability: 0.6 }
    expect(applyPolicy(choice('a', { a: 0.8, b: 0.2 }, 0.8), [], policy).kind).toBe('decided')
    expect(applyPolicy(choice('a', { a: 0.5, b: 0.5 }, 0.8), [], policy).kind).toBe('undecided')
  })
})

describe('normalizeScore', () => {
  it('places the rubric on 0 to 1, so a 5-level middle is 0.5', () => {
    expect(normalizeScore(score(0, 5))).toBe(0)
    expect(normalizeScore(score(2, 5))).toBe(0.5)
    expect(normalizeScore(score(4, 5))).toBe(1)
  })

  it('handles the smallest legal rubric', () => {
    expect(normalizeScore(score(0, 2))).toBe(0)
    expect(normalizeScore(score(1, 2))).toBe(1)
  })

  it('reads the scale from the answer, not from an expectation', () => {
    // The legend is what Jev scored against, so it is the only honest source for
    // the number of levels.
    expect(normalizeScore(score(1, 3))).toBeCloseTo(0.5)
  })

  it('clamps an expected score that rounds outside the rubric', () => {
    expect(normalizeScore(score(4.02, 5))).toBe(1)
    expect(normalizeScore(score(-0.01, 5))).toBe(0)
  })

  it('returns undefined rather than inventing a value', () => {
    // A missing answer and a genuine zero are different findings; folding one into
    // the other turns absent evidence into a bad grade.
    expect(normalizeScore(undefined)).toBeUndefined()
    expect(normalizeScore(noul(0.9))).toBeUndefined()
    expect(normalizeScore(score(1, 1))).toBeUndefined()
  })
})

describe('compositeScore', () => {
  it('weights dimensions as supplied', () => {
    const result = compositeScore(
      { a: 0.75, b: 0.25 },
      { a: score(4, 5), b: score(0, 5) },
    )
    expect(result.score).toBeCloseTo(0.75)
    expect(result.missing).toEqual([])
  })

  it('treats weights as relative, not as fractions that must sum to 1', () => {
    const asFractions = compositeScore({ a: 0.75, b: 0.25 }, { a: score(4, 5), b: score(0, 5) })
    const asIntegers = compositeScore({ a: 3, b: 1 }, { a: score(4, 5), b: score(0, 5) })
    expect(asIntegers.score).toBeCloseTo(asFractions.score)
  })

  it('renormalises over the dimensions that answered, and names the rest', () => {
    // A missing dimension must not drag the total toward zero, and must not be
    // silently treated as a lowest score.
    const result = compositeScore({ a: 1, b: 1 }, { a: score(4, 5) })
    expect(result.score).toBeCloseTo(1)
    expect(result.missing).toEqual(['b'])
    expect(result.contributions.a?.weight).toBeCloseTo(1)
  })

  it('reports the arithmetic, so the total can be checked', () => {
    const result = compositeScore({ a: 1, b: 1 }, { a: score(4, 5), b: score(2, 5) })
    expect(result.contributions.a).toEqual({ weight: 0.5, value: 1, points: 0.5 })
    expect(result.contributions.b).toEqual({ weight: 0.5, value: 0.5, points: 0.25 })
    expect(result.score).toBeCloseTo(0.75)
  })

  it('ignores a zero-weight dimension rather than treating it as missing', () => {
    const result = compositeScore({ a: 1, b: 0 }, { a: score(4, 5), b: score(0, 5) })
    expect(result.score).toBeCloseTo(1)
    expect(result.missing).toEqual([])
  })

  it('refuses a composite of nothing instead of returning 0', () => {
    expect(() => compositeScore({}, {})).toThrow(/at least one/)
    expect(() => compositeScore({ a: 1 }, {})).toThrow(/not a low score/)
    expect(() => compositeScore({ a: 1 }, { a: noul(0.9) })).toThrow(/not a low score/)
  })

  it('refuses a negative or non-finite weight', () => {
    expect(() => compositeScore({ a: -1 }, { a: score(4, 5) })).toThrow(/negative/)
    expect(() => compositeScore({ a: Number.NaN }, { a: score(4, 5) })).toThrow(/finite/)
  })

  it('does not mutate its inputs', () => {
    const weights = { a: 1, b: 1 }
    const answers = { a: score(4, 5) }
    compositeScore(weights, answers)
    expect(weights).toEqual({ a: 1, b: 1 })
    expect(Object.keys(answers)).toEqual(['a'])
  })
})
