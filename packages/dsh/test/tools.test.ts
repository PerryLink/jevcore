import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHECK_THRESHOLDS,
  EGRESS_FEATURES,
  EgressContract,
  JevService,
  MockProvider,
  asRendered,
  rankingSize,
  renderAnswer,
  renderResult,
  resolveCheck,
  summarize,
  type EgressFeature,
  type JevProvider,
  type JevResult,
} from 'jevcore'
import { jevAskTool } from '../src/ask.js'
import { jevCheckTool } from '../src/check.js'
import { candidateIndex, candidateQuestionId, jevRankTool } from '../src/rank.js'
const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const service = (provider: JevProvider = new MockProvider()) =>
  new JevService({
    provider,
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
  })

/** Call a tool definition directly, as the registry would. */
const run = async (definition: { execute(args: unknown, exec: never): Promise<unknown> }, args: unknown) =>
  definition.execute(args, { signal: new AbortController().signal } as never)

const fixedProvider = (result: Partial<JevResult>): JevProvider => ({
  id: 'fixed',
  answer: async () => ({
    model: 'jev-test',
    provider: 'fixed',
    latencyMs: 7,
    answers: {},
    ...result,
  }),
})

describe('render helpers', () => {
  it('flattens a noul answer into a boolean with its strength', () => {
    expect(renderAnswer('q', { type: 'noul', noul: 0.9 })).toMatchObject({
      answer: 'true',
      noul: 0.9,
      probability: 0.9,
    })
    expect(renderAnswer('q', { type: 'noul', noul: 0.1 })).toMatchObject({ answer: 'false' })
  })

  it('reports a missing answer as missing rather than inventing one', () => {
    const rendered = renderAnswer('q', undefined)
    expect(rendered.note).toContain('no answer')
    expect(rendered.answer).toBeUndefined()
  })

  it('warns that mock answers are synthetic', () => {
    const rendered = renderResult(
      { model: 'm', provider: 'mock', latencyMs: 1, answers: {} },
      [],
    )
    expect(rendered.warning).toContain('SYNTHETIC')
  })

  it('does not warn for a live result', () => {
    const rendered = renderResult({ model: 'm', provider: 'live', latencyMs: 1, answers: {} }, [])
    expect(rendered.warning).toBeUndefined()
  })

  it('summarizes compactly and marks synthetic answers', () => {
    const value = renderResult(
      { model: 'm', provider: 'mock', latencyMs: 12, answers: { q: { type: 'noul', noul: 0.8 } } },
      ['q'],
    )
    const line = summarize(value, 'jev_ask')
    expect(line).toContain('[synthetic]')
    expect(line).toContain('q=true')
    expect(line).toContain('80%')
  })

  it('narrows a schema-inferred value back to the rendered shape', () => {
    expect(asRendered({ provider: 'x', answers: [] }).provider).toBe('x')
  })

  it('counts ranking entries defensively', () => {
    expect(rankingSize({ ranking: [1, 2, 3] })).toBe(3)
    expect(rankingSize({ ranking: 'not an array' })).toBe(0)
    expect(rankingSize({})).toBe(0)
  })
})

describe('jev_ask', () => {
  const tool = jevAskTool(service())

  it('answers a noul, choice, and score question in one call', async () => {
    const value = (await run(tool, {
      state: { ticket: 'charged twice' },
      questions: {
        urgent: { type: 'noul', instructions: 'Urgent?' },
        team: {
          type: 'choice',
          instructions: 'Which team?',
          criteria: { billing: 'Payments', technical: 'Bugs' },
        },
        risk: {
          type: 'score',
          instructions: 'Risk?',
          criteria: { low: 'No user impact', high: 'Users blocked' },
        },
      },
    })) as {
      answers: {
        question: string
        type: string
        answer?: string
        score?: number
        legend?: Record<string, string>
      }[]
    }

    expect(value.answers.map((answer) => answer.question)).toEqual(['urgent', 'team', 'risk'])
    expect(value.answers.map((answer) => answer.type)).toEqual(['noul', 'choice', 'score'])
  })

  it('reports a score with its rubric, not just a number', async () => {
    const value = (await run(tool, {
      state: 'x',
      questions: {
        risk: {
          type: 'score',
          instructions: 'Risk?',
          criteria: { low: 'No user impact', high: 'Users blocked' },
        },
      },
    })) as { answers: { answer?: string; score?: number; legend?: Record<string, string> }[] }

    const answer = value.answers[0]
    // The scale is the order written, so the rubric comes back indexed from zero
    // and the score may fall between levels.
    expect(answer?.legend).toEqual({ '0': 'No user impact', '1': 'Users blocked' })
    expect(typeof answer?.score).toBe('number')
    expect(['No user impact', 'Users blocked']).toContain(answer?.answer)
  })

  it('refuses a score whose levels carry no descriptions', async () => {
    // `null` is not a way to mean "undescribed": the level's position in the
    // scale *is* its score, so dropping one renumbers the rest. The tool reports
    // that rather than silently sending a shorter rubric, and names the empty
    // string as the way to hold a position.
    await expect(
      run(tool, {
        state: 'x',
        questions: {
          risk: { type: 'score', instructions: 'Risk?', criteria: { low: null, high: null } },
        },
      }),
    ).rejects.toThrow(/have no description/)
  })

  it('accepts an empty string as an undescribed level that holds its place', async () => {
    const value = (await run(tool, {
      state: 'x',
      questions: {
        risk: {
          type: 'score',
          instructions: 'Risk?',
          criteria: { low: 'No impact', medium: '', high: 'Users blocked' },
        },
      },
    })) as { answers: { legend?: Record<string, string> }[] }

    // Three levels, so `high` stays at position 2 instead of sliding into 1.
    expect(value.answers[0]?.legend).toEqual({
      '0': 'No impact',
      '1': '',
      '2': 'Users blocked',
    })
  })

  it('returns probabilities, not decisions', async () => {
    const value = (await run(tool, {
      state: 'x',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })) as { answers: { probability?: number }[] }
    expect(typeof value.answers[0]?.probability).toBe('number')
  })

  it('rejects a batch Jev would reject, before spending the call', async () => {
    await expect(
      run(tool, {
        state: 'x',
        questions: {
          broken: { type: 'choice', instructions: 'pick', criteria: { only: null } },
        },
      }),
    ).rejects.toThrow(/declares 1 criteria/)
  })

  it('names the provider in the result', async () => {
    const value = (await run(tool, {
      state: 'x',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })) as { provider: string; warning?: string }
    expect(value.provider).toBe('mock')
    expect(value.warning).toBeDefined()
  })
})

describe('jev_rank', () => {
  const tool = jevRankTool(service())

  it('maps candidates to and from question ids', () => {
    expect(candidateQuestionId(3)).toBe('candidate_3')
    expect(candidateIndex('candidate_3')).toBe(3)
    expect(candidateIndex('nonsense')).toBeUndefined()
  })

  it('returns every candidate, sorted by relevance', async () => {
    const value = (await run(tool, {
      query: 'find the billing doc',
      candidates: ['technical guide', 'billing policy', 'unrelated note'],
    })) as { ranking: { candidate: string; relevance?: number }[] }

    expect(value.ranking).toHaveLength(3)
    const scores = value.ranking.map((entry) => entry.relevance ?? -1)
    expect(scores).toEqual([...scores].sort((left, right) => right - left))
  })

  it('handles an empty candidate list without calling Jev', async () => {
    const value = (await run(tool, { query: 'q', candidates: [] })) as { ranking: unknown[] }
    expect(value.ranking).toEqual([])
  })

  it('marks a candidate Jev did not answer instead of scoring it zero', async () => {
    const partial = jevRankTool(
      service(
        fixedProvider({
          answers: { candidate_0: { type: 'noul', noul: 0.9 } },
        }),
      ),
    )
    const value = (await run(partial, { query: 'q', candidates: ['a', 'b'] })) as {
      ranking: { note?: string; relevance?: number }[]
    }
    const unanswered = value.ranking.find((entry) => entry.note !== undefined)
    expect(unanswered).toBeDefined()
    expect(unanswered?.relevance).toBeUndefined()
    // The answered one still ranks first.
    expect(value.ranking[0]?.relevance).toBe(0.9)
  })
})

describe('jev_check verdict precedence', () => {
  const resolve = (answers: Record<string, number>) =>
    resolveCheck({
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [key, { type: 'noul' as const, noul: value }]),
      ),
    })

  it('reports support when the evidence supports and is sufficient', () => {
    expect(
      resolve({ supports_claim: 0.9, contradicts_claim: 0.05, evidence_is_sufficient: 0.9 }).verdict,
    ).toBe('supported')
  })

  it('reports contradiction over support when both are strong', () => {
    // Conflict is the whole reason this tool exists: reporting it as support
    // would be the worst available error.
    expect(
      resolve({ supports_claim: 0.9, contradicts_claim: 0.9, evidence_is_sufficient: 0.9 }).verdict,
    ).toBe('conflicted')
  })

  it('reports contradiction when only contradiction is strong', () => {
    expect(
      resolve({ supports_claim: 0.1, contradicts_claim: 0.95, evidence_is_sufficient: 0.9 }).verdict,
    ).toBe('contradicted')
  })

  it('distinguishes support-on-insufficient-evidence from support', () => {
    expect(
      resolve({ supports_claim: 0.9, contradicts_claim: 0.05, evidence_is_sufficient: 0.1 }).verdict,
    ).toBe('insufficient')
  })

  it('reports insufficient when nothing is strong', () => {
    expect(
      resolve({ supports_claim: 0.4, contradicts_claim: 0.3, evidence_is_sufficient: 0.9 }).verdict,
    ).toBe('insufficient')
  })

  it('reports unknown when nothing was answered', () => {
    expect(resolveCheck({ model: 'm', provider: 'fixed', latencyMs: 1, answers: {} }).verdict).toBe(
      'unknown',
    )
  })

  it('treats missing sufficiency as sufficient rather than blocking on it', () => {
    expect(resolve({ supports_claim: 0.9, contradicts_claim: 0.05 }).verdict).toBe('supported')
  })

  it('honours custom thresholds', () => {
    const result = {
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: { supports_claim: { type: 'noul' as const, noul: 0.6 } },
    }
    expect(resolveCheck(result).verdict).toBe('insufficient')
    expect(
      resolveCheck(result, { ...DEFAULT_CHECK_THRESHOLDS, support: 0.5 }).verdict,
    ).toBe('supported')
  })
})

describe('jev_check tool', () => {
  const tool = jevCheckTool(service())

  it('returns a verdict with the underlying probabilities', async () => {
    const value = (await run(tool, { claim: 'the sky is blue', evidence: 'it is blue' })) as {
      verdict: string
      probabilities: Record<string, number>
    }
    expect([
      'supported',
      'contradicted',
      'conflicted',
      'insufficient',
      'unknown',
    ]).toContain(value.verdict)
    expect(Object.keys(value.probabilities).length).toBeGreaterThan(0)
  })

  it('never reports a verdict without probabilities behind it', async () => {
    const value = (await run(tool, { claim: 'c', evidence: 'e' })) as {
      verdict: string
      probabilities: Record<string, number>
    }
    if (value.verdict !== 'unknown') {
      expect(Object.keys(value.probabilities).length).toBeGreaterThan(0)
    }
  })
})
