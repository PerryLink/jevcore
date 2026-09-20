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
    expect(score('How risky?', { low: 'none', medium: null, high: 'severe' })).toEqual({
      type: 'score',
      instructions: 'How risky?',
      criteria: ['none', 'severe'],
    })
  })

  it('keeps level order, since order is the scale', () => {
    expect(score('How risky?', { high: 'severe', low: 'none' }).criteria).toEqual(['severe', 'none'])
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

  it('rejects a score question with no described levels', () => {
    expect(() => assertValidQuestion('q', score('rate', {}))).toThrow(/declares 0 described level/)
  })

  it('rejects a score question whose levels are all undescribed', () => {
    // `null` means "leave this level undescribed", which sends nothing, so a
    // rubric of nulls is an empty rubric.
    expect(() => assertValidQuestion('q', score('rate', { low: null, high: null }))).toThrow(
      /declares 0 described level/,
    )
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
