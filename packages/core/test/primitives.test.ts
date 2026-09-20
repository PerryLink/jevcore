import { describe, expect, it } from 'vitest'
import { assertValidBatch, assertValidQuestion, choice, noul, score, topCriterion } from '../src/primitives.js'
import type { JevQuestion } from '../src/types.js'

describe('question builders', () => {
  it('builds a noul question', () => {
    expect(noul('Is this urgent?')).toEqual({ type: 'noul', instructions: 'Is this urgent?' })
  })

  it('builds a choice question with its criteria', () => {
    expect(choice('Which team?', { billing: 'Payments', technical: null })).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Payments', technical: null },
    })
  })

  it('builds a score question as an ordered array of level descriptions', () => {
    // The API scores positions, so the scale is the sequence of descriptions,
    // not a keyed map. See `ScoreCriteria` in the official SDK.
    expect(score('How risky?', { low: 'none', medium: 'some', high: 'severe' })).toEqual({
      type: 'score',
      instructions: 'How risky?',
      criteria: ['none', 'some', 'severe'],
    })
  })

  it('keeps level order, since order is the scale', () => {
    expect(score('How risky?', { high: 'severe', low: 'none' }).criteria).toEqual(['severe', 'none'])
  })

  it('refuses to drop an undescribed level, because position is the score', () => {
    // This used to filter `null` out silently, which renumbered the scale: a
    // caller declaring {low, medium: null, high} got a two-level rubric in which
    // `high` occupied position 1, so every answer mapped back to the wrong name.
    // The live API rejects `null` entries with 422 anyway, so there was no
    // correct fallback — only a wrong one to hide.
    expect(() => score('How risky?', { low: 'none', medium: null, high: 'severe' })).toThrow(
      /have no description/,
    )
  })

  it('points the caller at the empty string as a way to hold a position', () => {
    // The error has to be actionable: the API accepts "" as an entry, so there
    // is a legal way to say "position 1 exists, it just is not described".
    expect(() => score('How risky?', { low: 'none', medium: null, high: 'severe' })).toThrow(
      /empty string/,
    )
    expect(score('How risky?', { low: 'none', medium: '', high: 'severe' }).criteria).toEqual([
      'none',
      '',
      'severe',
    ])
  })
})

describe('question validation', () => {
  it('rejects empty instructions', () => {
    expect(() => assertValidQuestion('q', noul('   '))).toThrow(/empty instructions/)
  })

  it('accepts a noul question without criteria', () => {
    expect(() => assertValidQuestion('q', noul('ok'))).not.toThrow()
  })

  it('rejects a choice question with fewer than two criteria', () => {
    expect(() => assertValidQuestion('q', choice('pick', { only: null }))).toThrow(/declares 1 criteria/)
  })

  it('rejects a score question with no levels at all', () => {
    expect(() => assertValidQuestion('q', score('rate', {}))).toThrow(/at least two/)
  })

  it('rejects a score question whose levels are all undescribed', () => {
    // `null` is refused at construction, so this now fails before validation
    // gets a chance to see it. Kept as a regression guard on the ordering of the
    // two checks: the message a caller sees should name the undescribed level,
    // not merely count levels.
    expect(() => score('rate', { low: null, high: null })).toThrow(/have no description/)
  })

  it('rejects a score with more levels than the API accepts', () => {
    // The live API answers "Too many score levels. Must have at most 10 levels."
    // Catching it locally turns a wasted round-trip into a caller-side error.
    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_unused, index) => [`l${index}`, `level ${index}`]),
    )
    expect(() => assertValidQuestion('q', score('rate', eleven))).toThrow(/at most 10/)
  })

  it('rejects a choice with more options than the API accepts', () => {
    const many = Object.fromEntries(
      Array.from({ length: 256 }, (_unused, index) => [`o${index}`, `option ${index}`]),
    )
    expect(() => assertValidQuestion('q', choice('pick', many))).toThrow(/at most 255/)
  })

  it('rejects an empty batch', () => {
    expect(() => assertValidBatch({})).toThrow(/at least one question/)
  })

  it('validates every question in a batch', () => {
    const batch: Record<string, JevQuestion> = {
      good: noul('fine'),
      bad: choice('broken', { one: null }),
    }
    expect(() => assertValidBatch(batch)).toThrow(/"bad"/)
  })
})

describe('topCriterion', () => {
  it('returns the single highest-scoring key', () => {
    expect(topCriterion({ a: 0.2, b: 0.7, c: 0.1 })).toBe('b')
  })

  it('returns undefined on a tie rather than picking arbitrarily', () => {
    expect(topCriterion({ a: 0.5, b: 0.5 })).toBeUndefined()
  })

  it('returns undefined for an empty distribution', () => {
    expect(topCriterion({})).toBeUndefined()
  })

  it('handles a single candidate', () => {
    expect(topCriterion({ only: 1 })).toBe('only')
  })
})
