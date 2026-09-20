import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_CONFIG,
  DEFAULT_OPENROUTER_ENDPOINT,
  EGRESS_FEATURES,
  EgressContract,
  JevService,
  MockProvider,
  type EgressFeature,
  type JevQuestion,
  type JevRequest,
} from 'jevcore'
import { buildRuntime, chooseProvider } from '../src/runtime.js'
import { createServer } from '../src/server.js'
import { SYNTHETIC_WARNING, runAsk, runCheck, runRank, toQuestions } from '../src/tools.js'

/** This package's manifest. `src/` and `lib/` are both one level below it. */
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  version: string
  mcpName?: string
  keywords?: string[]
  files?: string[]
  bin?: Record<string, string>
}

/** The registry entry that ships beside it. */
const registryEntry = JSON.parse(
  readFileSync(new URL('../server.json', import.meta.url), 'utf8'),
) as {
  name: string
  description: string
  version: string
  packages: {
    registryType: string
    identifier: string
    version: string
    transport: { type: string }
  }[]
}

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

describe('the OpenRouter endpoint', () => {
  const withOpenRouterKey = (extra: Record<string, string> = {}) => (name: string) =>
    name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-test' : extra[name]

  it('defaults to the core endpoint, not to a copy of the origin', async () => {
    // This default used to be the literal 'https://openrouter.ai' — no `/api` —
    // while the provider it describes posted to the core's own default. The
    // egress report therefore named a host that never received anything, which
    // is the one thing the report exists to get right.
    expect(DEFAULT_OPENROUTER_ENDPOINT).toBe('https://openrouter.ai/api')

    const runtime = await buildRuntime(withOpenRouterKey())
    const report = runtime.egress.reportLines().join('\n')
    expect(report).toContain(DEFAULT_OPENROUTER_ENDPOINT)
    expect(runtime.config.openRouterBaseURL).toBe(DEFAULT_OPENROUTER_ENDPOINT)
  })

  it('reports the same endpoint it would post to', async () => {
    const runtime = await buildRuntime(withOpenRouterKey())
    const reported = runtime.config.openRouterBaseURL
    expect(reported).toBeDefined()
    // `OpenRouterProvider` appends `/v1/systemone` to this value. The origin
    // alone would have been reported as a destination while the SDK was handed
    // the `/api` root.
    expect(new URL(reported as string).pathname).toBe('/api')
  })

  it('honours an explicit base URL and stays consistent about it', async () => {
    const custom = 'https://proxy.example.test/api'
    const runtime = await buildRuntime(withOpenRouterKey({ OPENROUTER_BASE_URL: custom }))
    expect(runtime.config.openRouterBaseURL).toBe(custom)
    expect(runtime.egress.reportLines().join('\n')).toContain(custom)
  })

  it('leaves the TypeSafe route alone', async () => {
    const runtime = await buildRuntime((name) =>
      name === 'JEV_PROVIDER' ? 'live' : name === 'TYPESAFE_API_KEY' ? 'ts_live_test' : undefined,
    )
    expect(runtime.config.provider).toBe('live')
    expect(runtime.config.openRouterBaseURL).toBeUndefined()
    expect(runtime.egress.reportLines().join('\n')).toContain('https://api.typesafe.ai')
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
    // A choice option may be null — the live API accepts that and the docs use
    // it for "needs no explanation". A score level may not: its position is its
    // score, so an undescribed level is refused rather than dropped.
    const q = toQuestions({
      c: { type: 'choice', instructions: 'pick', criteria: { a: null, b: 'B' } },
      s: { type: 'score', instructions: 'rate', criteria: { low: 'none', high: 'severe' } },
    })
    expect(q.c).toMatchObject({ type: 'choice', criteria: { a: null, b: 'B' } })
    expect(q.s).toMatchObject({ type: 'score', criteria: ['none', 'severe'] })
  })

  it('refuses a score level with no description rather than renumbering the scale', () => {
    expect(() =>
      toQuestions({ s: { type: 'score', instructions: 'rate', criteria: { low: null, high: 'x' } } }),
    ).toThrow(/have no description/)
  })

  it('treats missing criteria as an empty map rather than throwing here', () => {
    expect(toQuestions({ c: { type: 'choice', instructions: 'pick' } }).c).toMatchObject({
      criteria: {},
    })
  })
})

describe('the noul boundary', () => {
  it('forwards a declared boundary into the question as criteria', () => {
    // The MCP surface called `noul(instructions)` and dropped the boundary, so
    // the capability existed in the core and in the DSH plugin but silently did
    // nothing here. This is the regression that has to stay closed.
    const questions = toQuestions({
      urgent: {
        type: 'noul',
        instructions: 'Does this convey urgency?',
        boundary: { true: 'needs a reply today', false: 'can wait a week' },
      },
    })
    expect(questions.urgent).toMatchObject({
      type: 'noul',
      criteria: { true: 'needs a reply today', false: 'can wait a week' },
    })
  })

  it('accepts the legacy criteria spelling for a noul', () => {
    const questions = toQuestions({
      urgent: {
        type: 'noul',
        instructions: 'Urgent?',
        criteria: { true: 'today', false: 'next week' },
      },
    })
    expect(questions.urgent).toMatchObject({ criteria: { true: 'today', false: 'next week' } })
  })

  it('prefers boundary when both spellings are present', () => {
    const questions = toQuestions({
      urgent: {
        type: 'noul',
        instructions: 'Urgent?',
        boundary: { true: 'from boundary' },
        criteria: { true: 'from criteria' },
      },
    })
    expect(questions.urgent).toMatchObject({ criteria: { true: 'from boundary' } })
  })

  it('omits criteria entirely when no boundary is declared', () => {
    expect(toQuestions({ q: { type: 'noul', instructions: 'ok?' } }).q).not.toHaveProperty('criteria')
  })

  it('accepts structured instructions, as the core does', () => {
    const questions = toQuestions({
      q: {
        type: 'noul',
        instructions: { question: 'Is it urgent?', not_for: ['a newsletter'] },
      },
    })
    expect(questions.q).toMatchObject({
      instructions: { question: 'Is it urgent?', not_for: ['a newsletter'] },
    })
  })

  it('refuses a noul criteria key that names no outcome', () => {
    expect(() =>
      toQuestions({
        q: { type: 'noul', instructions: 'ok?', criteria: { billing: 'payments' } },
      }),
    ).toThrow(/name no outcome/)
  })

  it('refuses a boundary on a choice or a score', () => {
    expect(() =>
      toQuestions({
        c: { type: 'choice', instructions: 'pick', criteria: { a: null, b: null }, boundary: { true: 'x' } },
      }),
    ).toThrow(/exists only for noul/)
  })

  it('refuses a boundary that describes neither outcome, via the core check', async () => {
    // `toQuestions` is deliberately lax — it is the core's `assertValidBatch`
    // that owns this rule, so the refusal is asserted on the path a call takes.
    await expect(
      runAsk(service(), {
        state: 'x',
        questions: { q: { type: 'noul', instructions: 'ok?', boundary: {} } },
      }),
    ).rejects.toThrow(/describes neither outcome/)
  })

  it('reaches the provider with the boundary intact', async () => {
    // The unit above proves the conversion; this proves the converted question
    // is what actually goes out, which is the whole point of the fix.
    const seen: JevQuestion[] = []
    const spied = new JevService({
      provider: {
        id: 'spy',
        answer: async (request: JevRequest) => {
          seen.push(request.questions['urgent'] as JevQuestion)
          return {
            model: 'm',
            provider: 'spy',
            latencyMs: 1,
            answers: { urgent: { type: 'noul' as const, noul: 0.9 } },
          }
        },
      },
      egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://x'),
    })

    await runAsk(spied, {
      state: 'x',
      questions: {
        urgent: {
          type: 'noul',
          instructions: 'Urgent?',
          boundary: { true: 'today', false: 'next week' },
        },
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ criteria: { true: 'today', false: 'next week' } })
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

  it('reports the version in package.json, not a literal that can drift', () => {
    // This read '0.1.0' while the package was on 0.2.2. A hardcoded version is
    // one nobody rebumps, so the test asks the manifest rather than a number:
    // any correct implementation passes, and a stale literal fails here.
    const reported = (createServer(service()).server as unknown as { _serverInfo: { version: string } })
      ._serverInfo.version
    expect(reported).toBe(manifest.version)
    expect(reported).not.toBe('0.1.0')
  })

  it('lets a caller name the version explicitly, so the default is provably the manifest', () => {
    const info = (createServer(service(), '9.9.9').server as unknown as {
      _serverInfo: { name: string; version: string }
    })._serverInfo
    expect(info.version).toBe('9.9.9')
    expect(info.name).toBe('jevcore')
  })
})

describe('the published entry point', () => {
  it('starts with a shebang, so a host can execute it directly', () => {
    // `bin` points at the compiled lib/bin.js, and a POSIX host (and the
    // symlink shim npm writes there) execs that file rather than passing it to
    // node. Without a shebang the first line is a comment, the file is not
    // runnable, and `npx -y jevcore-mcp` produced a process that never wrote a
    // byte. tsc copies the shebang into lib/bin.js; this guards the source.
    const source = readFileSync(new URL('../src/bin.ts', import.meta.url))
    expect(source.subarray(0, 2).toString('latin1')).toBe('#!')
    // The whole first line, to the newline: a shebang on line 2 is not a shebang.
    expect(source.subarray(0, 20).toString('latin1')).toBe('#!/usr/bin/env node\n')
  })

  it('is the file bin points at', () => {
    expect(manifest.bin?.['jevcore-mcp']).toBe('./lib/bin.js')
  })
})

describe('the registry entry', () => {
  it('names the package the way the official registry requires', () => {
    // The registry verifies the npm package against `mcpName`, and the
    // GitHub-based namespace anchors on the repository owner.
    expect(manifest.mcpName).toBe('io.github.PerryLink/jevcore')
    expect(manifest.mcpName).toBe(registryEntry.name)
    expect(registryEntry.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
  })

  it('carries the published version in both places', () => {
    expect(registryEntry.version).toBe(manifest.version)
    expect(registryEntry.packages[0]?.version).toBe(manifest.version)
  })

  it('points at this package, over stdio', () => {
    expect(registryEntry.packages).toHaveLength(1)
    expect(registryEntry.packages[0]?.registryType).toBe('npm')
    expect(registryEntry.packages[0]?.identifier).toBe(manifest.name)
    expect(registryEntry.packages[0]?.transport.type).toBe('stdio')
  })

  it('keeps the registry description inside the schema limit', () => {
    // The schema caps `description` at 100 characters. A longer one is refused
    // at publish time, which is a long way from the edit that caused it.
    expect(registryEntry.description.length).toBeGreaterThan(0)
    expect(registryEntry.description.length).toBeLessThanOrEqual(100)
  })

  it('ships server.json in the tarball and keeps the ecosystem keyword', () => {
    // A file that is not in `files` is not published, and a package the
    // registry cannot find is not listed however correct its metadata is.
    expect(manifest.files).toContain('server.json')
    expect(manifest.keywords).toContain('mcp-server')
  })
})
