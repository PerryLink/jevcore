import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_CHECK_THRESHOLDS,
  EGRESS_FEATURES,
  EgressContract,
  EgressTooLargeError,
  JevService,
  MockProvider,
  VERDICT_QUESTION,
  asRendered,
  rankingSize,
  renderAnswer,
  renderResult,
  resolveCheck,
  summarize,
  type CheckResolution,
  type EgressFeature,
  type JevProvider,
  type JevRequest,
  type JevResult,
  type JsonValue,
} from 'jevcore'
import { jevAskTool, toQuestions } from '../src/ask.js'
import {
  STATE_CHAR_CAP as CHECK_STATE_CHAR_CAP,
  TOOL_VERDICTS,
  jevCheckTool,
  reconcileVerdict,
} from '../src/check.js'
import {
  CANDIDATE_QUESTION_OVERHEAD,
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_CRITERION,
  QUESTION_CHAR_CAP,
  STATE_CHAR_CAP as RANK_STATE_CHAR_CAP,
  candidateCap,
  candidateIndex,
  candidateQuestionId,
  jevRankTool,
  rankSummary,
} from '../src/rank.js'
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

/** A provider that records every request, so a test can see what actually left. */
const recordingProvider = (): { requests: JevRequest[]; provider: JevProvider } => {
  const requests: JevRequest[] = []
  return {
    requests,
    provider: {
      id: 'recording',
      answer: async (request) => {
        requests.push(request)
        return { model: 'recording', provider: 'recording', latencyMs: 1, answers: {} }
      },
    },
  }
}

/**
 * What the registry does with one result: run the call, then project the
 * output's `presentationMeta` over the canonical value.
 *
 * Nothing called this projection before, and that is exactly how `jev_rank`
 * shipped unusable: its `presentationMeta` threw on every call, the registry
 * turned the throw into `returned invalid output`, and the model received zero
 * candidates - while all 410 tests passed, because they only ever called
 * `execute`.
 */
const present = async (
  definition: {
    execute(args: unknown, exec: never): Promise<unknown>
    output: { presentationMeta?(args: unknown, value: JsonValue): JsonValue }
  },
  args: unknown,
): Promise<{ value: JsonValue; summary: string }> => {
  const value = (await run(definition, args)) as JsonValue
  const meta = definition.output.presentationMeta?.(args, value)
  return { value, summary: String((meta as { summary?: unknown } | undefined)?.summary ?? '') }
}

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

describe('jev_rank candidate cap', () => {
  /**
   * The description with its thousands separators removed.
   *
   * The description groups digits for a reader ("4,000"); the contract declares
   * `4000`. Comparing digits rather than formatted text keeps this test about the
   * number agreeing and not about the punctuation.
   */
  const plainDigits = (text: string): string => text.replace(/(\d),(?=\d{3}\b)/g, '$1')

  const candidates = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `candidate ${index}`)

  it('states the caps and the per-candidate cost the egress contract declares', () => {
    // The model can only stay under a budget it is told about. Every number in the
    // note is interpolated from the contract or measured from the question builder,
    // so this asserts the wiring rather than a transcription: if the core's cap
    // changes, or a question's wording grows, the note moves with it or this fails.
    const description = plainDigits(jevRankTool(service()).description)

    expect(description).toContain(`${QUESTION_CHAR_CAP} characters`)
    expect(description).toContain(`${CANDIDATE_QUESTION_OVERHEAD} characters plus`)
    expect(description).toContain(`about ${DEFAULT_CANDIDATE_CAP} candidates`)
    expect(description).toContain(`${RANK_STATE_CHAR_CAP} characters`)
    // ...and says which of the two is refused, and which is not.
    expect(description).toContain('REFUSED')
    expect(description).toContain('truncated')
  })

  it('finds the boundary with the same counter the description is written from', async () => {
    // The strongest form of "the description and the enforcement agree": don't
    // compare the note to a second copy of the arithmetic - drive the real tool to
    // the boundary the note advertises and one candidate past it. `candidateCap` is
    // what the note interpolates, so this closes the loop for every criterion, not
    // just the default one.
    const tool = jevRankTool(service())
    for (const criterion of [DEFAULT_CRITERION, 'x'.repeat(400), 'y'.repeat(120)]) {
      const cap = candidateCap(criterion)
      const atCap = candidates(cap)

      const accepted = (await run(tool, { query: 'q', candidates: atCap, criterion })) as {
        ranking: unknown[]
      }
      expect(accepted.ranking).toHaveLength(cap)

      // Refused, not trimmed: the call fails outright, so a model that sent too
      // many gets an error naming both sizes rather than a silently shorter list.
      await expect(
        run(tool, { query: 'q', candidates: [...atCap, 'one past the cap'], criterion }),
      ).rejects.toThrow(EgressTooLargeError)
    }
  })

  it('shows the criterion shortening the effective candidate count', async () => {
    // The claim the note makes in words: the criterion is repeated into every
    // question, so a long one costs candidates. Asserted as a relationship rather
    // than a second magic number.
    expect(candidateCap('x'.repeat(400))).toBeLessThan(DEFAULT_CANDIDATE_CAP)
    expect(candidateCap('x'.repeat(400))).toBeGreaterThan(0)
    // An empty criterion is substituted with the default before it is measured, so
    // the count the note gives for `criterion: ""` is the default one.
    const tool = jevRankTool(service())
    await expect(
      run(tool, { query: 'q', candidates: candidates(DEFAULT_CANDIDATE_CAP), criterion: '   ' }),
    ).resolves.toBeDefined()
  })

  it('marks a state that lost candidates to the size cap instead of ranking it silently', async () => {
    // The second budget, and the one that does NOT refuse: twenty candidates of
    // 800 characters fit the question budget and not the state budget. Jev is asked
    // about a truncation envelope, so the ranking beside it describes no candidate
    // at all - the result has to say so, or the model reads twenty judgments about
    // evidence Jev never saw.
    const recorder = recordingProvider()
    const tool = jevRankTool(service(recorder.provider))
    const long = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(800, 'y'))

    const value = (await run(tool, { query: 'q', candidates: long })) as {
      truncated?: unknown
      egress?: { truncated?: unknown; stateChars?: unknown }
      ranking: unknown[]
    }

    // Every candidate is still listed - that is what makes the silence dangerous.
    expect(value.ranking).toHaveLength(20)
    expect(value.truncated).toBe(true)
    expect(value.egress?.truncated).toBe(true)
    expect(value.egress?.stateChars).toBeLessThanOrEqual(RANK_STATE_CHAR_CAP)
    // What Jev was actually handed: an envelope, with no `candidates` array in it.
    expect(Object.keys((recorder.requests[0]?.state ?? {}) as object)).toEqual([
      '[truncated]',
      '[originalChars]',
      '[maxChars]',
      '[head]',
    ])
    // And the one-line card carries it, for the same reason the payload does.
    expect(rankSummary(value)).toContain('[truncated]')
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

  it('reports undecided when the evidence is sufficient but neither side is strong', () => {
    // `undecided` exists so this finding is not reported as `insufficient`: the
    // sufficiency answer says the evidence settles the question (0.9), and only
    // the support/contradiction measurements are weak.
    expect(
      resolve({ supports_claim: 0.4, contradicts_claim: 0.3, evidence_is_sufficient: 0.9 }).verdict,
    ).toBe('undecided')
    // The other reading of "nothing is strong": weak support *and* evidence
    // judged unable to settle it stays `insufficient`.
    expect(
      resolve({ supports_claim: 0.4, contradicts_claim: 0.3, evidence_is_sufficient: 0.1 }).verdict,
    ).toBe('insufficient')
  })

  it('reports unknown when nothing was answered', () => {
    expect(resolveCheck({ model: 'm', provider: 'fixed', latencyMs: 1, answers: {} }).verdict).toBe(
      'unknown',
    )
  })

  it('fails closed when the sufficiency question was never answered', () => {
    // This assertion is inverted from what it used to be, deliberately. The core
    // returned `supported` from exactly this payload - its guard read
    // `sufficient !== undefined && sufficient < thresholds.sufficiency`, so an
    // unanswered question skipped the test entirely. An unanswered question is
    // not a favourable answer: the analysis report reproduced it, and both the
    // core and the DSH adapter's `reconcileVerdict` now fail closed.
    expect(resolve({ supports_claim: 0.9, contradicts_claim: 0.05 }).verdict).toBe('insufficient')
  })

  it('honours custom thresholds', () => {
    const result = {
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: {
        supports_claim: { type: 'noul' as const, noul: 0.6 },
        evidence_is_sufficient: { type: 'noul' as const, noul: 0.9 },
      },
    }
    // Support below the threshold with the evidence judged sufficient is
    // `undecided` - the claim is not established, and the payload already says
    // why (0.6 against a 0.7 boundary). Lowering the boundary is what turns it
    // into `supported`, which is the point of the threshold being configurable.
    expect(resolveCheck(result).verdict).toBe('undecided')
    expect(
      resolveCheck(result, { ...DEFAULT_CHECK_THRESHOLDS, support: 0.5 }).verdict,
    ).toBe('supported')

    // The sufficiency boundary is configurable on its own, and moving it is what
    // separates `supported` from the evidence-does-not-settle-it finding.
    const borderline = {
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: {
        supports_claim: { type: 'noul' as const, noul: 0.9 },
        evidence_is_sufficient: { type: 'noul' as const, noul: 0.6 },
      },
    }
    expect(resolveCheck(borderline).verdict).toBe('supported')
    expect(
      resolveCheck(borderline, { ...DEFAULT_CHECK_THRESHOLDS, sufficiency: 0.8 }).verdict,
    ).toBe('insufficient')
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

  it('marks a state that lost the evidence to the size cap instead of judging it silently', async () => {
    // The handler rebuilds its payload from `rendered` fields, which is how the
    // core's `truncated` and `egress` went missing: `renderResult` computed them
    // and this return never mentioned them. Reading `renderResult` and assuming a
    // caller forwards its value is not evidence — a call does. One oversized
    // evidence string is enough, because `state` is a character budget and this
    // field is free text.
    const recorder = recordingProvider()
    const capped = jevCheckTool(service(recorder.provider))

    const value = (await run(capped, { claim: 'the sky is blue', evidence: 'e'.repeat(17_000) })) as {
      truncated?: unknown
      egress?: { truncated?: unknown; stateChars?: unknown }
      verdict?: unknown
    }

    // A verdict still comes back, which is what made the omission dangerous.
    expect(value.verdict).toBeDefined()
    expect(value.truncated).toBe(true)
    expect(value.egress?.truncated).toBe(true)
    expect(value.egress?.stateChars).toBeLessThanOrEqual(CHECK_STATE_CHAR_CAP)
    // What Jev was handed: an envelope, with neither `claim` nor `evidence` in it.
    expect(Object.keys((recorder.requests[0]?.state ?? {}) as object)).toEqual([
      '[truncated]',
      '[originalChars]',
      '[maxChars]',
      '[head]',
    ])
    // And the evidence parameter says so before the call, not only after it:
    // `parameters` is the compiled schema, so this asserts the text the model is
    // actually sent rather than a spec a compiler might have dropped.
    const declared = JSON.stringify(capped.parameters).replace(/(\d),(?=\d{3}\b)/g, '$1')
    expect(declared).toContain('truncated')
    expect(declared).toContain(String(CHECK_STATE_CHAR_CAP))
  })
})

describe('presentationMeta (the projection the registry runs)', () => {
  it('summarizes a rank payload, which carries no `answers` at all', async () => {
    const { value, summary } = await present(jevRankTool(service()), {
      query: 'find the billing doc',
      candidates: ['technical guide', 'billing policy', 'unrelated note'],
    })

    // The root cause: `summarize` maps over `RenderedResult.answers`, and this
    // payload has only `ranking`. Passing it through `asRendered` (a type
    // assertion, not a conversion) threw on `value.answers.map`.
    expect(Object.keys(value as Record<string, unknown>)).not.toContain('answers')
    expect(summary).toContain('jev_rank (3 candidates)')
    expect(summary).toContain('top: ')
    expect(summary).toContain('%')
    expect(summary).toContain('[synthetic]')
  })

  it('would throw if a rank payload went through the core summarize', () => {
    // The exact call that used to stand behind `presentationMeta`. Kept as a
    // test so nobody "simplifies" `rankSummary` back into it: `summarize` maps
    // over `answers`, and a ranking has none - `asRendered` is an assertion, not
    // a conversion. The registry turns the throw into
    // `tool "jev_rank" returned invalid output: output.presentationMeta failed:
    // Cannot read properties of undefined (reading 'map')`.
    expect(() =>
      summarize(
        asRendered({ provider: 'mock', model: 'm', latencyMs: 1, ranking: [] }),
        'jev_rank (0 candidates)',
      ),
    ).toThrow(/map/)
  })

  it('names the top candidate and its probability', async () => {
    const tool = jevRankTool(
      service(
        fixedProvider({
          answers: {
            candidate_0: { type: 'noul', noul: 0.2 },
            candidate_1: { type: 'noul', noul: 0.9 },
          },
        }),
      ),
    )
    const { summary } = await present(tool, { query: 'q', candidates: ['weak', 'strong'] })
    expect(summary).toBe('jev_rank (2 candidates) - top: strong (90%) - 7ms')
  })

  it('says how many candidates Jev did not answer, instead of scoring them zero', async () => {
    const tool = jevRankTool(
      service(fixedProvider({ answers: { candidate_0: { type: 'noul', noul: 0.9 } } })),
    )
    const { summary } = await present(tool, { query: 'q', candidates: ['answered', 'silent'] })
    expect(summary).toBe('jev_rank (2 candidates) - top: answered (90%) - 7ms - 1 unanswered')
  })

  it('summarizes the empty-candidate payload, which never reaches a provider', async () => {
    const { summary } = await present(jevRankTool(service()), { query: 'q', candidates: [] })
    expect(summary).toBe('jev_rank (0 candidates) - no candidate answered - 0ms')
  })

  it('renders a malformed payload rather than throwing, because a throw fails the call', () => {
    // The registry wraps this projection in try/catch and reports a throw as
    // `returned invalid output` - which is how the defect reached a real host
    // as "the model got zero candidates". Total by construction, at every level.
    expect(rankSummary(undefined)).toBe('jev_rank (0 candidates) - no candidate answered - ?ms')
    expect(rankSummary({})).toBe('jev_rank (0 candidates) - no candidate answered - ?ms')
    expect(rankSummary({ ranking: 'not an array', latencyMs: 3 })).toBe(
      'jev_rank (0 candidates) - no candidate answered - 3ms',
    )
    expect(rankSummary({ ranking: [{}], warning: 'synthetic', latencyMs: 1 })).toBe(
      'jev_rank (1 candidate) [synthetic] - no candidate answered - 1ms - 1 unanswered',
    )
  })

  it('shortens a long candidate so the summary stays one line', () => {
    const summary = rankSummary({
      ranking: [{ candidate: 'x'.repeat(400), relevance: 0.5 }],
      latencyMs: 1,
    })
    expect(summary).toContain('...')
    expect(summary.length).toBeLessThan(120)
  })

  it('projects jev_ask, whose payload really is a rendered result', async () => {
    const { summary } = await present(jevAskTool(service()), {
      state: 'x',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    expect(summary).toContain('jev_ask')
    expect(summary).toContain('[synthetic]')
    expect(summary).toContain('q=')
  })

  it('projects jev_check', async () => {
    const { summary } = await present(jevCheckTool(service()), { claim: 'c', evidence: 'e' })
    expect(summary).toMatch(/^[a-z]+ - jev_check$/)
  })
})

describe('output schema (the validation the registry runs)', () => {
  /**
   * What the registry does with one result, one layer above `present`: it
   * validates the value against `output.schema` and **throws** on a violation.
   *
   * Every other test in this file calls `execute` directly, which is one layer
   * *below* that validator - and that is exactly why the suite passed while
   * `jev_ask` failed every call in a real host. `ToolRuntime` runs the host's
   * `validateJsonSchemaValue` over the returned value on every dispatch, and a
   * non-empty result becomes `tool "jev_ask" returned invalid output:
   * "value.egress" is not a declared property (additionalProperties: false)` -
   * the model receives nothing at all.
   *
   * `validateJsonSchemaValue` is the host's own exported validator rather than a
   * second copy of the rule, so this asserts the enforcement itself. The key
   * subset is asserted beside it because it names the offending key on one line.
   */
  const check = async (tool: ToolDefinition, args: unknown) => {
    const value = (await run(tool, args)) as JsonValue
    const keys = Object.keys(value as Record<string, unknown>)
    const declared = Object.keys(tool.output.schema.properties ?? {})
    return {
      keys,
      declared,
      undeclared: keys.filter((key) => !declared.includes(key)),
      violations: validateJsonSchemaValue(tool.output.schema, value, 'value'),
    }
  }

  const askArgs = { state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } }

  it('declares every key jev_ask returns when no cap was hit', async () => {
    const { keys, undeclared, violations } = await check(jevAskTool(service()), askArgs)
    // `egress` is stamped on every result the service prepared, so this one
    // missing key was enough to fail every `jev_ask` call.
    expect(keys).toContain('egress')
    expect(undeclared).toEqual([])
    expect(violations).toEqual([])
  })

  it('declares `truncated` too, on the call that actually sets it', async () => {
    // The other key the schema was missing, and the one that appears only when
    // the state was capped: 17,000 characters against the 16,000-character cap.
    const { keys, undeclared, violations } = await check(jevAskTool(service()), {
      state: 'x'.repeat(17_000),
      questions: askArgs.questions,
    })
    expect(keys).toContain('truncated')
    expect(undeclared).toEqual([])
    expect(violations).toEqual([])
  })

  it('declares every key jev_rank and jev_check return', async () => {
    // The same validator over the two tools that *were* given these keys when
    // `ask.ts` was not. Three tools, one contract - and the reason a regression
    // in either sibling fails here rather than in a host.
    const siblings: [ToolDefinition, unknown][] = [
      [jevRankTool(service()), { query: 'q', candidates: ['a', 'b'] }],
      [jevCheckTool(service()), { claim: 'c', evidence: 'e' }],
    ]
    for (const [tool, args] of siblings) {
      const { undeclared, violations } = await check(tool, args)
      expect(undeclared).toEqual([])
      expect(violations).toEqual([])
    }
  })

  it('reports an undeclared key instead of ignoring it, so the checks above can fail', async () => {
    // Proof the guard is not vacuous. This is the assertion that would have
    // caught the defect: an extra key is a violation, not a field the validator
    // shrugs at, which is what makes the three tests above a contract rather
    // than a restatement of today's payload.
    const tool = jevAskTool(service())
    const value = { ...((await run(tool, askArgs)) as Record<string, unknown>), drift: 1 }
    expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([
      '"value.drift" is not a declared property (additionalProperties: false)',
    ])
  })
})

describe('concurrency declaration', () => {
  it('opts all three tools into the host parallel pool', () => {
    // The registry classifies a tool with no classifier as `exclusive`
    // (`ToolRuntime`: `if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }`),
    // so an undeclared field serializes every independent judgment. `defineTool`
    // validates the arguments first and answers false for a malformed call, so
    // each call below is a well-formed one.
    expect(
      jevAskTool(service()).isConcurrencySafe?.({
        state: 'x',
        questions: { q: { type: 'noul', instructions: 'ok?' } },
      }),
    ).toBe(true)
    expect(jevRankTool(service()).isConcurrencySafe?.({ query: 'q', candidates: ['a'] })).toBe(true)
    expect(jevCheckTool(service()).isConcurrencySafe?.({ claim: 'c', evidence: 'e' })).toBe(true)
  })

  it('does not claim a malformed call is safe', () => {
    expect(jevRankTool(service()).isConcurrencySafe?.({ query: 42 })).toBe(false)
  })
})

describe('noul boundaries', () => {
  it('forwards a declared boundary to the provider as the question criteria', async () => {
    const recorded = recordingProvider()
    await run(jevAskTool(service(recorded.provider)), {
      state: { migration: 'rehearsed on staging' },
      questions: {
        rollback: {
          type: 'noul',
          instructions: 'Can the migration be rolled back safely?',
          boundary: {
            true: 'It can be reversed without data loss.',
            false: 'It cannot be reversed, or reversing it loses data.',
          },
        },
      },
    })

    expect(recorded.requests[0]?.questions['rollback']).toEqual({
      type: 'noul',
      instructions: 'Can the migration be rolled back safely?',
      criteria: {
        true: 'It can be reversed without data loss.',
        false: 'It cannot be reversed, or reversing it loses data.',
      },
    })
  })

  it('reads the upstream `criteria: {true, false}` spelling as the same boundary', () => {
    // This shape was accepted at the tool boundary and then dropped for nouls,
    // so a caller could declare a boundary and have it silently ignored.
    expect(
      toQuestions({
        q: {
          type: 'noul',
          instructions: 'ok?',
          criteria: { true: 'It holds', false: 'It does not' },
        },
      }),
    ).toEqual({
      q: {
        type: 'noul',
        instructions: 'ok?',
        criteria: { true: 'It holds', false: 'It does not' },
      },
    })
  })

  it('sends no criteria for a noul that declared no boundary', () => {
    expect(toQuestions({ q: { type: 'noul', instructions: 'ok?' } })).toEqual({
      q: { type: 'noul', instructions: 'ok?' },
    })
  })

  it('refuses a noul criteria map whose keys name no outcome', () => {
    expect(() =>
      toQuestions({ q: { type: 'noul', instructions: 'ok?', criteria: { yes: 'y', no: 'n' } } }),
    ).toThrow(/name no outcome/)
  })

  it('refuses a boundary that describes neither outcome', () => {
    expect(() => toQuestions({ q: { type: 'noul', instructions: 'ok?', boundary: {} } })).toThrow(
      /describes neither outcome/,
    )
  })

  it('refuses a boundary on a choice instead of dropping it', () => {
    expect(() =>
      toQuestions({
        pick: {
          type: 'choice',
          instructions: 'pick one',
          criteria: { a: 'A', b: 'B' },
          boundary: { true: 'y' },
        },
      }),
    ).toThrow(/exists only for noul/)
  })
})

describe('jev_check boundaries', () => {
  it('asks all three questions with an explicit true/false boundary', async () => {
    const recorded = recordingProvider()
    await run(jevCheckTool(service(recorded.provider)), { claim: 'c', evidence: 'e' })
    const questions = recorded.requests[0]?.questions ?? {}
    expect(Object.keys(questions).sort()).toEqual(
      [
        VERDICT_QUESTION.supports,
        VERDICT_QUESTION.contradicts,
        VERDICT_QUESTION.sufficient,
      ].sort(),
    )
    for (const id of Object.values(VERDICT_QUESTION)) {
      const question = questions[id] as
        | { type?: string; criteria?: { true?: unknown; false?: unknown } }
        | undefined
      expect(question?.type).toBe('noul')
      // `noul.criteria` was wired up nowhere in this repo before this change.
      expect(typeof question?.criteria?.true).toBe('string')
      expect(typeof question?.criteria?.false).toBe('string')
    }
  })

  it('tells the supports question that silence is not support', async () => {
    const recorded = recordingProvider()
    await run(jevCheckTool(service(recorded.provider)), { claim: 'c', evidence: 'e' })
    const question = recorded.requests[0]?.questions[VERDICT_QUESTION.supports] as
      | { criteria?: { true?: string; false?: string } }
      | undefined
    // The failure this tool exists to catch: evidence that reads as supportive
    // while being silent on what the claim asserts.
    expect(question?.criteria?.false).toMatch(/silent/)
    expect(question?.criteria?.true).toMatch(/states the claim/)
  })
})

describe('jev_check reconcileVerdict', () => {
  const resolution = (
    verdict: CheckResolution['verdict'],
    probabilities: Partial<Pick<CheckResolution, 'supports' | 'contradicts' | 'sufficient'>>,
  ): CheckResolution => ({
    verdict,
    supports: undefined,
    contradicts: undefined,
    sufficient: undefined,
    ...probabilities,
  })

  it('fails closed when the sufficiency question went unanswered', () => {
    // The core returns `supported` from this input: its guard is
    // `sufficient !== undefined && sufficient < thresholds.sufficiency`, so an
    // unanswered question skips it entirely. An unanswered question is not a
    // favourable answer.
    expect(
      reconcileVerdict(resolution('supported', { supports: 0.95, contradicts: 0.05 })),
    ).toBe('insufficient')
  })

  it('keeps `supported` when sufficiency is behind it', () => {
    expect(
      reconcileVerdict(
        resolution('supported', { supports: 0.9, contradicts: 0.05, sufficient: 0.9 }),
      ),
    ).toBe('supported')
  })

  it('does not report `insufficient` beside a sufficiency probability that says otherwise', () => {
    // The analysis report's experiment C, exactly as it was observed.
    expect(
      reconcileVerdict(
        resolution('insufficient', { supports: 0.0524, contradicts: 0.5173, sufficient: 0.9895 }),
      ),
    ).toBe('undecided')
  })

  it('keeps `insufficient` when the evidence really was judged insufficient', () => {
    expect(
      reconcileVerdict(
        resolution('insufficient', { supports: 0.9, contradicts: 0.05, sufficient: 0.1 }),
      ),
    ).toBe('insufficient')
  })

  it('keeps `insufficient` when sufficiency is unanswered and neither side is strong', () => {
    expect(reconcileVerdict(resolution('insufficient', { supports: 0.4, contradicts: 0.2 }))).toBe(
      'insufficient',
    )
  })

  it('leaves contradicted, conflicted and unknown alone', () => {
    expect(
      reconcileVerdict(
        resolution('conflicted', { supports: 0.9, contradicts: 0.9, sufficient: 0.9 }),
      ),
    ).toBe('conflicted')
    expect(
      reconcileVerdict(
        resolution('contradicted', { supports: 0.1, contradicts: 0.95, sufficient: 0.1 }),
      ),
    ).toBe('contradicted')
    expect(reconcileVerdict(resolution('unknown', {}))).toBe('unknown')
  })

  it('tracks the configured thresholds rather than a hardcoded boundary', () => {
    const lenient = { ...DEFAULT_CHECK_THRESHOLDS, sufficiency: 0.5 }
    const strict = { ...DEFAULT_CHECK_THRESHOLDS, sufficiency: 0.8 }
    const resolved = resolution('insufficient', {
      supports: 0.4,
      contradicts: 0.2,
      sufficient: 0.6,
    })
    expect(reconcileVerdict(resolved, lenient)).toBe('undecided')
    expect(reconcileVerdict(resolved, strict)).toBe('insufficient')
  })

  it('never returns a verdict that contradicts its own probabilities, across a grid', () => {
    // The invariant the two guards exist to establish, and it has to hold
    // whatever `resolveCheck` does - so it is asserted over the whole grid of
    // answers a provider could return, missing sufficiency included.
    const values = [0, 0.2, 0.4, 0.49, 0.5, 0.6, 0.7, 0.9, 1]
    for (const supports of values) {
      for (const contradicts of values) {
        for (const sufficient of [...values, undefined]) {
          const answers = {
            [VERDICT_QUESTION.supports]: { type: 'noul' as const, noul: supports },
            [VERDICT_QUESTION.contradicts]: { type: 'noul' as const, noul: contradicts },
            ...(sufficient === undefined
              ? {}
              : { [VERDICT_QUESTION.sufficient]: { type: 'noul' as const, noul: sufficient } }),
          }
          const resolved = resolveCheck({ model: 'm', provider: 'fixed', latencyMs: 1, answers })
          const verdict = reconcileVerdict(resolved)
          expect(TOOL_VERDICTS).toContain(verdict)
          // An unanswered sufficiency question never buys `supported`.
          if (verdict === 'supported') expect(resolved.sufficient).toBeDefined()
          // `insufficient` is never reported while the evidence was judged able
          // to settle the question: an absent answer counts as not sufficient.
          if (verdict === 'insufficient') {
            expect(resolved.sufficient ?? 0).toBeLessThan(DEFAULT_CHECK_THRESHOLDS.sufficiency)
          }
        }
      }
    }
  })

  it('is idempotent, so a core-side fix cannot be rewritten twice', () => {
    // Both guards key on a state their own output cannot be in - an absent
    // sufficiency answer, or a *core* `insufficient` - so feeding a result back
    // in has to reproduce it. That is what makes the shim safe to keep after the
    // core fails closed and returns `undecided` on its own: it becomes a no-op
    // rather than a second rewrite.
    const resolutions: CheckResolution[] = [
      resolution('supported', { supports: 0.95, contradicts: 0.05 }),
      resolution('insufficient', { supports: 0.0524, contradicts: 0.5173, sufficient: 0.9895 }),
      resolution('supported', { supports: 0.9, contradicts: 0.05, sufficient: 0.9 }),
      resolution('insufficient', { supports: 0.9, contradicts: 0.05, sufficient: 0.1 }),
      resolution('insufficient', { supports: 0.4, contradicts: 0.2 }),
      resolution('contradicted', { supports: 0.1, contradicts: 0.95, sufficient: 0.1 }),
      resolution('conflicted', { supports: 0.9, contradicts: 0.9, sufficient: 0.9 }),
      resolution('unknown', {}),
    ]
    for (const resolved of resolutions) {
      const once = reconcileVerdict(resolved)
      // The shim's own output, re-entering it exactly as a core that already
      // fails closed (or already returns `undecided`) would present it.
      const twice = reconcileVerdict({ ...resolved, verdict: once })
      expect(twice).toBe(once)
    }
  })
})

describe('jev_check through the tool', () => {
  it('fails closed when the provider omits the sufficiency answer', async () => {
    const tool = jevCheckTool(
      service(
        fixedProvider({ answers: { [VERDICT_QUESTION.supports]: { type: 'noul', noul: 0.95 } } }),
      ),
    )
    const value = (await run(tool, { claim: 'c', evidence: 'e' })) as {
      verdict: string
      probabilities: Record<string, number>
    }
    expect(value.probabilities.supports).toBe(0.95)
    expect(value.probabilities.sufficient).toBeUndefined()
    // This payload used to come back as `supported`.
    expect(value.verdict).toBe('insufficient')
  })

  it('never reports `insufficient` while its own sufficiency probability says otherwise', async () => {
    const tool = jevCheckTool(
      service(
        fixedProvider({
          answers: {
            [VERDICT_QUESTION.supports]: { type: 'noul', noul: 0.0524 },
            [VERDICT_QUESTION.contradicts]: { type: 'noul', noul: 0.5173 },
            [VERDICT_QUESTION.sufficient]: { type: 'noul', noul: 0.9895 },
          },
        }),
      ),
    )
    const value = (await run(tool, {
      claim: 'The migration completed without data loss.',
      evidence: 'Migration log: Status: SUCCESS. Rows copied: 1,204,388.',
    })) as { verdict: string; probabilities: Record<string, number> }
    expect(value.probabilities.sufficient).toBeCloseTo(0.9895)
    expect(value.verdict).toBe('undecided')
  })
})

describe('jev_check verdict vocabulary', () => {
  const tool = jevCheckTool(service())

  it('advertises exactly the verdicts it can return', () => {
    for (const verdict of TOOL_VERDICTS) {
      expect(tool.description).toContain(`"${verdict}"`)
    }
  })

  it('no longer offers a "not supported" verdict no code path returns', () => {
    // The description sold the distinction between "not supported" and
    // "contradicted" while the vocabulary contained no such value; the resolver
    // spells that outcome `insufficient`.
    expect(tool.description).not.toContain('"not supported"')
  })
})
