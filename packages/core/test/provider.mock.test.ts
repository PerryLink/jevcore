import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOCK_CONFIDENCE, MOCK_MODEL, MockProvider, fnv1a } from '../src/provider/mock.js'
import { choice, noul, score } from '../src/primitives.js'
import type { JevRequest } from '../src/types.js'

const request = (overrides: Partial<JevRequest> = {}): JevRequest => ({
  state: { ticket: 'I was charged twice.' },
  questions: {
    urgent: noul('Does this convey urgency?'),
    team: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
    risk: score('How risky?', { low: 'none', medium: 'some', high: 'severe' }),
  },
  ...overrides,
})

describe('mock provider shape', () => {
  it('identifies itself as a mock so an answer cannot be mistaken for a live one', async () => {
    const result = await new MockProvider().answer(request())
    expect(result.provider).toBe('mock')
    expect(result.model).toBe(MOCK_MODEL)
    expect(result.model).toContain('mock')
  })

  it('reports zero usage, because it calls nothing', async () => {
    const result = await new MockProvider().answer(request())
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })

  it('answers every question it was asked', async () => {
    const result = await new MockProvider().answer(request())
    expect(Object.keys(result.answers).sort()).toEqual(['risk', 'team', 'urgent'])
  })
})

describe('determinism', () => {
  it('returns identical answers for identical input', async () => {
    const provider = new MockProvider()
    const first = await provider.answer(request())
    const second = await provider.answer(request())
    expect(first.answers).toEqual(second.answers)
  })

  it('returns different answers when the state differs', async () => {
    const provider = new MockProvider()
    const a = await provider.answer(request({ state: 'state one' }))
    const b = await provider.answer(request({ state: 'state two' }))
    expect(a.answers.urgent).not.toEqual(b.answers.urgent)
  })

  it('hashes deterministically', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
  })
})

describe('answer validity', () => {
  it('returns a noul probability inside [0, 1]', async () => {
    const result = await new MockProvider().answer(request())
    const answer = result.answers.urgent
    expect(answer?.type).toBe('noul')
    if (answer?.type !== 'noul') throw new Error('expected noul')
    expect(answer.noul).toBeGreaterThanOrEqual(0)
    expect(answer.noul).toBeLessThanOrEqual(1)
  })

  it('selects a criterion it was actually given', async () => {
    const result = await new MockProvider().answer(request())
    const answer = result.answers.team
    expect(answer?.type).toBe('choice')
    if (answer?.type !== 'choice') throw new Error('expected choice')
    expect(['billing', 'technical']).toContain(answer.choice)
    expect(Object.keys(answer.probabilities).sort()).toEqual(['billing', 'technical'])
  })

  it('never selects the most probable criterion incorrectly', async () => {
    // The choice must agree with the distribution it reports, otherwise a
    // caller branching on `choice` and one branching on argmax disagree.
    for (const state of ['a', 'b', 'c', 1, 2, { deep: true }]) {
      const result = await new MockProvider().answer(request({ state }))
      const answer = result.answers.team
      if (answer?.type !== 'choice') throw new Error('expected choice')
      const best = Object.entries(answer.probabilities).sort((x, y) => y[1] - x[1])[0]
      expect(answer.choice).toBe(best?.[0])
    }
  })

  it('labels every score answer with its own type', async () => {
    const result = await new MockProvider().answer(request())
    expect(result.answers.risk?.type).toBe('score')
  })

  it('reports a fixed, low confidence for choice and score, and none for noul', async () => {
    // Confidence is a statistic over a multi-outcome distribution, so it belongs
    // on choice and score. A noul has two outcomes and no such field. Attaching
    // one made the mock judge differently from a real provider under the same
    // policy — which is the opposite of a stand-in's job, and it silently
    // disabled the safety gate, since 0.5 sits below the default floor of 0.7.
    const result = await new MockProvider().answer(request())
    for (const answer of Object.values(result.answers)) {
      if (answer.type === 'noul') {
        expect(answer).not.toHaveProperty('confidence')
        continue
      }
      expect(answer.confidence).toBe(MOCK_CONFIDENCE)
      expect(answer.confidence).toBeLessThan(0.8)
    }
  })
})

describe('cancellation', () => {
  it('rejects an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before start'))
    await expect(new MockProvider().answer(request(), controller.signal)).rejects.toThrow(
      'cancelled before start',
    )
  })
})

describe('the mock never reaches the network', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('does not call fetch for any question shape', async () => {
    const spy = vi.fn(() => {
      throw new Error('the mock provider must not call fetch')
    })
    globalThis.fetch = spy as unknown as typeof fetch
    await new MockProvider().answer(request())
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('edge cases', () => {
  it('returns no answer for a question that vanished from the request', async () => {
    const result = await new MockProvider().answer(request({ questions: {} }))
    expect(result.answers).toEqual({})
  })

  it('skips a categorical question with no criteria rather than inventing one', async () => {
    const result = await new MockProvider().answer(
      request({ questions: { broken: choice('pick', {}) } }),
    )
    expect(result.answers.broken).toBeUndefined()
  })

  it('accepts a string state', async () => {
    const result = await new MockProvider().answer(request({ state: 'plain text' }))
    expect(result.answers.urgent).toBeDefined()
  })
})
