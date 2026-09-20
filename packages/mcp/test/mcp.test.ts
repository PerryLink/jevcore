import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  EGRESS_FEATURES,
  EgressContract,
  JevService,
  MockProvider,
  type EgressFeature,
} from 'jevcore'
import { buildRuntime, chooseProvider } from '../src/runtime.js'
import { SYNTHETIC_WARNING, runAsk, runCheck, runRank, toQuestions } from '../src/tools.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const service = () =>
  new JevService({
    provider: new MockProvider(),
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
  })

describe('provider selection', () => {
  it('stays offline when nothing is configured', () => {
    expect(chooseProvider(() => undefined)).toBe('mock')
  })

  it('goes live when a key is present', () => {
    expect(chooseProvider((name) => (name === 'TYPESAFE_API_KEY' ? 'ts_live_x' : undefined))).toBe(
      'live',
    )
  })

  it('treats a blank key as absent', () => {
    expect(chooseProvider((name) => (name === 'TYPESAFE_API_KEY' ? '   ' : undefined))).toBe('mock')
  })

  it('lets an explicit JEV_PROVIDER override the key heuristic in both directions', () => {
    const withKey = (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : name === 'JEV_PROVIDER' ? 'mock' : undefined)
    expect(chooseProvider(withKey)).toBe('mock')
    const withoutKey = (name: string) => (name === 'JEV_PROVIDER' ? 'live' : undefined)
    expect(chooseProvider(withoutKey)).toBe('live')
  })

  it('selects openrouter when only an OpenRouter key is present', () => {
    // The point of the route: a host with an OpenRouter key but no TypeSafe key
    // should still reach Jev rather than quietly answering synthetically.
    const env = (name: string) => (name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-x' : undefined)
    expect(chooseProvider(env)).toBe('openrouter')
  })

  it('prefers TypeSafe when both keys are present', () => {
    const env = (name: string) =>
      name === 'TYPESAFE_API_KEY' ? 'ts' : name === 'OPENROUTER_API_KEY' ? 'or' : undefined
    expect(chooseProvider(env)).toBe('live')
  })

  it('honours an explicit openrouter selection', () => {
    expect(chooseProvider((name) => (name === 'JEV_PROVIDER' ? 'openrouter' : undefined))).toBe(
      'openrouter',
    )
  })
})

describe('runtime assembly', () => {
  it('defaults to an offline mock with an OFF egress report', async () => {
    const runtime = await buildRuntime(() => undefined)
    expect(runtime.config.provider).toBe('mock')
    expect(runtime.egress.reportLines().join('\n')).toContain('egress=OFF')
    expect(runtime.service.transmitting).toBe(false)
  })

  it('refuses to start live without a credential rather than failing per call', async () => {
    await expect(buildRuntime((name) => (name === 'JEV_PROVIDER' ? 'live' : undefined))).rejects.toThrow(
      /no credential was found/,
    )
  })

  it('refuses to start openrouter without an OpenRouter credential', async () => {
    await expect(
      buildRuntime((name) => (name === 'JEV_PROVIDER' ? 'openrouter' : undefined)),
    ).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it('starts openrouter with its key and reports the OpenRouter endpoint', async () => {
    const runtime = await buildRuntime((name) =>
      name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-test' : undefined,
    )
    expect(runtime.config.provider).toBe('openrouter')
    // The report must name the destination, not leave it implied by the provider.
    const report = runtime.egress.reportLines().join('\n')
    expect(report).toContain('egress=ON')
    expect(report).toContain('openrouter.ai')
    expect(runtime.service.transmitting).toBe(true)
  })

  it('defaults both routes to the same System One model id', async () => {
    const runtime = await buildRuntime((name) =>
      name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-test' : undefined,
    )
    // One default for both routes: OpenRouter maps a bare `jev-*` id onto its
    // own namespace, so no per-route substitution is needed.
    //
    // This test used to assert the OpenRouter default *started with*
    // `typesafe/`. That encoded a workaround rather than a requirement — the
    // provider rejected bare ids, so this runtime quietly substituted a prefixed
    // one while the DSH plugin passed the bare default straight through and threw
    // at startup. The regression worth guarding is that divergence between the
    // two entry points, so it is asserted as equality against the shared default.
    expect(runtime.config.model).toBe(DEFAULT_CONFIG.model)
    expect(runtime.config.model).toBe('jev-latest')
  })

  it('starts live when a credential is present', async () => {
    const runtime = await buildRuntime((name) =>
      name === 'JEV_PROVIDER' ? 'live' : name === 'TYPESAFE_API_KEY' ? 'ts_live_test' : undefined,
    )
    expect(runtime.config.provider).toBe('live')
    expect(runtime.egress.reportLines().join('\n')).toContain('egress=ON')
  })

  it('honours a model override', async () => {
    const runtime = await buildRuntime((name) => (name === 'TYPESAFE_MODEL' ? 'jev-1.13.0' : undefined))
    expect(runtime.config.model).toBe('jev-1.13.0')
  })

  it('does not make a network call while assembling the offline runtime', async () => {
    const spy = vi.fn(() => {
      throw new Error('offline assembly must not call fetch')
    })
    const original = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      await buildRuntime(() => undefined)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('question conversion', () => {
  it('builds a noul question', () => {
    expect(toQuestions({ q: { type: 'noul', instructions: 'ok?' } }).q).toEqual({
      type: 'noul',
      instructions: 'ok?',
    })
  })

  it('builds choice and score questions with their criteria', () => {
    const q = toQuestions({
      c: { type: 'choice', instructions: 'pick', criteria: { a: null, b: 'B' } },
      s: { type: 'score', instructions: 'rate', criteria: { low: null, high: null } },
    })
    expect(q.c).toMatchObject({ type: 'choice', criteria: { a: null, b: 'B' } })
    expect(q.s).toMatchObject({ type: 'score' })
  })

  it('treats missing criteria as an empty map rather than throwing here', () => {
    expect(toQuestions({ c: { type: 'choice', instructions: 'pick' } }).c).toMatchObject({
      criteria: {},
    })
  })
})

describe('jev_ask', () => {
  it('answers a batch and names the provider', async () => {
    const value = await runAsk(service(), {
      state: { ticket: 'charged twice' },
      questions: {
        urgent: { type: 'noul', instructions: 'Urgent?' },
        team: { type: 'choice', instructions: 'Team?', criteria: { billing: null, eng: null } },
      },
    })
    expect(Object.keys(value.answers).sort()).toEqual(['team', 'urgent'])
    expect(value.provider).toBe('mock')
  })

  it('warns that mock answers are synthetic', async () => {
    const value = await runAsk(service(), {
      state: 'x',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    expect(value.warning).toContain('SYNTHETIC')
  })

  it('emits the exported warning verbatim, so the constant is what callers see', async () => {
    // The exported constant and the string callers receive must be the same
    // value; a substring assertion alone would let the two drift apart.
    const value = await runAsk(service(), {
      state: 'x',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    expect(value.warning).toBe(SYNTHETIC_WARNING)
  })

  it('says how to get real answers', () => {
    // The warning is the only place a caller learns the result is not a real
    // judgment, so it has to say what to do about that.
    expect(SYNTHETIC_WARNING).toContain('TYPESAFE_API_KEY')
    expect(SYNTHETIC_WARNING).toContain('mock')
  })

  it('rejects an invalid batch before spending a call', async () => {
    await expect(
      runAsk(service(), {
        state: 'x',
        questions: { broken: { type: 'choice', instructions: 'pick', criteria: { only: null } } },
      }),
    ).rejects.toThrow(/declares 1 criteria/)
  })
})

describe('jev_rank', () => {
  it('returns every candidate sorted by relevance', async () => {
    const value = await runRank(service(), {
      query: 'find the billing doc',
      candidates: ['technical guide', 'billing policy', 'unrelated'],
    })
    expect(value.ranking).toHaveLength(3)
    const scores = value.ranking.map((entry) => (entry as { relevance?: number }).relevance ?? -1)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('short-circuits an empty candidate list without calling Jev', async () => {
    const value = await runRank(service(), { query: 'q', candidates: [] })
    expect(value.ranking).toEqual([])
  })

  it('marks an unanswered candidate instead of scoring it zero', async () => {
    const partial = new JevService({
      provider: {
        id: 'partial',
        answer: async () => ({
          model: 'm',
          provider: 'partial',
          latencyMs: 1,
          answers: { candidate_0: { type: 'noul' as const, noul: 0.9 } },
        }),
      },
      egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://x'),
    })
    const value = await runRank(partial, { query: 'q', candidates: ['a', 'b'] })
    const unanswered = value.ranking.find((entry) => (entry as { note?: string }).note !== undefined)
    expect(unanswered).toBeDefined()
    expect((unanswered as { relevance?: number }).relevance).toBeUndefined()
  })
})

describe('jev_check', () => {
  it('returns a verdict with probabilities behind it', async () => {
    const value = await runCheck(service(), { claim: 'the sky is blue', evidence: 'it is blue' })
    expect(['supported', 'contradicted', 'conflicted', 'insufficient', 'unknown']).toContain(
      value.verdict,
    )
    expect(Object.keys(value.probabilities).length).toBeGreaterThan(0)
  })
})

describe('egress is enforced in this transport too', () => {
  it('refuses a tool whose feature is disabled', async () => {
    const disabled = new JevService({
      provider: new MockProvider(),
      egress: new EgressContract(
        { transmitting: true, enabled: { ...allOn(), 'tool:jev_ask': false } },
        'https://x',
      ),
    })
    await expect(
      runAsk(disabled, { state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } }),
    ).rejects.toThrow(/not enabled/)
  })
})

describe('the server surface', () => {
  it('builds without throwing and without touching the network', async () => {
    const { createServer } = await import('../src/server.js')
    const server = createServer(service())
    expect(server).toBeDefined()
  })
})
