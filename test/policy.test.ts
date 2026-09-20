import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, answerOf, applyPolicy, verdictToAction } from '../src/policy.js'
import type { CategoricalAnswer, JevResult, NoulAnswer } from '../src/types.js'

const noul = (value: number, confidence?: number): NoulAnswer => ({
  type: 'noul',
  noul: value,
  ...(confidence === undefined ? {} : { confidence }),
})

const choice = (
  picked: string,
  probabilities: Record<string, number>,
  confidence?: number,
): CategoricalAnswer => ({
  type: 'choice',
  choice: picked,
  probabilities,
  ...(confidence === undefined ? {} : { confidence }),
})

describe('noul policy', () => {
  it('decides true above the probability floor', () => {
    const verdict = applyPolicy(noul(0.95), ['true', 'false'])
    expect(verdict).toEqual({ kind: 'decided', answer: 'true', probability: 0.95 })
  })

  it('decides false below it', () => {
    const verdict = applyPolicy(noul(0.05), ['true', 'false'])
    expect(verdict).toEqual({ kind: 'decided', answer: 'false', probability: 0.95 })
  })

  it('stays undecided on a near-tie instead of picking a side', () => {
    expect(applyPolicy(noul(0.52), ['true', 'false'])).toEqual({
      kind: 'undecided',
      reason: 'below-confidence',
    })
  })

  it('stays undecided when confidence is below the floor', () => {
    expect(applyPolicy(noul(0.99, 0.4), ['true', 'false'])).toMatchObject({
      kind: 'undecided',
      reason: 'below-confidence',
    })
  })

  it('treats a missing confidence as acceptable and judges on probability', () => {
    expect(applyPolicy(noul(0.99), ['true', 'false']).kind).toBe('decided')
  })

  it('flags a resolved value outside the declared criteria as invalid', () => {
    expect(applyPolicy(noul(0.99), ['yes', 'no'])).toMatchObject({ kind: 'invalid' })
  })
})

describe('categorical policy', () => {
  const criteria = ['low', 'medium', 'high']

  it('decides the selected criterion above the floor', () => {
    const verdict = applyPolicy(choice('high', { low: 0.05, medium: 0.15, high: 0.8 }, 0.8), criteria)
    expect(verdict).toEqual({ kind: 'decided', answer: 'high', probability: 0.8 })
  })

  it('stays undecided when the distribution is flat', () => {
    const verdict = applyPolicy(choice('high', { low: 0.34, medium: 0.33, high: 0.33 }, 0.9), criteria)
    expect(verdict).toMatchObject({ kind: 'undecided' })
  })

  it('treats a criterion outside the declared set as invalid, never as a decision', () => {
    const verdict = applyPolicy(choice('critical', { critical: 0.99 }, 0.99), criteria)
    expect(verdict).toMatchObject({ kind: 'invalid' })
  })

  it('trusts the reported choice when the distribution corroborates it', () => {
    const verdict = applyPolicy(choice('medium', { low: 0.1, medium: 0.7, high: 0.2 }), criteria)
    expect(verdict).toEqual({ kind: 'decided', answer: 'medium', probability: 0.7 })
  })

  it('falls back to the argmax when the distribution omits the reported choice', () => {
    // `high` is a declared criterion, so this is a well-formed answer; the
    // distribution simply does not mention it. The distribution is more
    // informative than the bare key, so the argmax wins.
    const verdict = applyPolicy(choice('high', { low: 0.1, medium: 0.7 }), criteria)
    expect(verdict).toEqual({ kind: 'decided', answer: 'medium', probability: 0.7 })
  })

  it('flags a reported choice that is not a declared criterion, checked before the distribution', () => {
    const verdict = applyPolicy(choice('critical', { medium: 0.9 }), criteria)
    expect(verdict).toMatchObject({ kind: 'invalid' })
  })

  it('stays undecided when the fallback argmax is itself too weak', () => {
    const verdict = applyPolicy(choice('high', { low: 0.4, medium: 0.35 }), criteria)
    expect(verdict).toMatchObject({ kind: 'undecided' })
  })

  it('stays undecided when the distribution is flat and the choice is missing from it', () => {
    const verdict = applyPolicy(choice('high', { low: 0.5, medium: 0.5 }), criteria)
    expect(verdict).toMatchObject({ kind: 'undecided' })
  })

  it('stays undecided when there is no distribution to fall back to', () => {
    expect(applyPolicy(choice('low', {}), criteria)).toMatchObject({ kind: 'undecided' })
  })
})

describe('missing answers', () => {
  it('is undecided rather than allow by default', () => {
    expect(applyPolicy(undefined, ['a', 'b'])).toEqual({ kind: 'undecided', reason: 'no-answer' })
  })
})

describe('verdict to action', () => {
  const options = { ...DEFAULT_POLICY, accept: { high: false, low: true } }

  it('denies an invalid verdict instead of guessing', () => {
    expect(verdictToAction({ kind: 'invalid', reason: 'x' }, options)).toBe('deny')
  })

  it('asks when undecided, so a human sees it', () => {
    expect(verdictToAction({ kind: 'undecided', reason: 'no-answer' }, options)).toBe('ask')
  })

  it('maps a decided verdict through the accept table', () => {
    expect(verdictToAction({ kind: 'decided', answer: 'low', probability: 0.9 }, options)).toBe('allow')
    expect(verdictToAction({ kind: 'decided', answer: 'high', probability: 0.9 }, options)).toBe('deny')
  })

  it('asks for a decided verdict with no accept entry rather than assuming allow', () => {
    expect(verdictToAction({ kind: 'decided', answer: 'medium', probability: 0.9 }, options)).toBe('ask')
  })
})

describe('answerOf', () => {
  it('reads one answer by question id', () => {
    const result: JevResult = {
      model: 'm',
      provider: 'mock',
      latencyMs: 1,
      answers: { q: noul(0.9) },
    }
    expect(answerOf(result, 'q')).toEqual(noul(0.9))
    expect(answerOf(result, 'missing')).toBeUndefined()
  })
})
