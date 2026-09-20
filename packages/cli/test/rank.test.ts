/**
 * `jev rank` — ordering, the per-candidate numbers, and the disclosure that they
 * do not sum to 1.
 *
 * The probabilities come from a stub transport so the ordering is exact. A
 * ranking asserted against the offline mock could only check that the list has
 * the right length, which is the part of this command least likely to be wrong.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/types.js'
import { createHarness, type Harness } from './helpers/harness.js'
import { installStubSdk, type StubHarness } from './helpers/stub-sdk.js'

let harness: Harness
let stub: StubHarness

beforeAll(async () => {
  stub = await installStubSdk('rank')
})
afterAll(() => {
  stub.dispose()
})
beforeEach(() => {
  harness = createHarness()
})
afterEach(() => {
  harness.dispose()
})

/** The message `rank` must print wherever it prints a ranking. */
const NOTE_FRAGMENT = 'do NOT sum to 1'

/** Run `rank` against candidates whose probabilities the test chooses. */
const rank = async (relevances: readonly (number | undefined)[], extra: readonly string[] = []) => {
  stub.sdk.TypeSafeClient.throws = undefined
  stub.sdk.TypeSafeClient.answer = async () => ({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      relevances.map((value, index) =>
        value === undefined
          ? [`candidate_${index}`, { type: 'noul' }]
          : [`candidate_${index}`, { type: 'noul', noul: value }],
      ),
    ),
  })
  const candidates = harness.json('candidates.json', ['alpha', 'beta', 'gamma'])
  return harness.run(
    [
      'rank',
      '--query',
      'which candidate answers the question?',
      '--candidates',
      candidates,
      '--provider',
      'live',
      ...extra,
    ],
    { env: stub.env() },
  )
}

describe('ordering', () => {
  it('sorts by relevance, highest first', async () => {
    const result = await rank([0.2, 0.9, 0.5], ['--json'])
    const payload = result.json<{
      data: { ranking: { candidate: string; relevance?: number; index: number }[] }
    }>()
    expect(payload.data.ranking.map((entry) => entry.candidate)).toEqual(['beta', 'gamma', 'alpha'])
    expect(payload.data.ranking.map((entry) => entry.relevance)).toEqual([0.9, 0.5, 0.2])
  })

  it('keeps a candidate with no answer at the end, labelled rather than dropped', async () => {
    const result = await rank([0.9, undefined, 0.4], ['--json'])
    const payload = result.json<{
      data: { ranking: { candidate: string; relevance?: number; note?: string }[] }
    }>()
    expect(payload.data.ranking).toHaveLength(3)
    const last = payload.data.ranking[2]
    expect(last?.candidate).toBe('beta')
    expect(last?.relevance).toBeUndefined()
    expect(last?.note).toContain('no answer returned for this candidate')
  })

  it('prints the ranking person-readably with the criterion it used', async () => {
    const result = await rank([0.2, 0.9, 0.5])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('rank 3 candidates against:')
    expect(result.stdout).toContain('Does the candidate hold information that would help answer')
    expect(result.stdout).toContain('1. relevance=0.90  beta')
  })
})

describe('the independence disclosure', () => {
  it('states in the human output that the probabilities do not sum to 1', async () => {
    const result = await rank([0.9, 0.9, 0.9])
    expect(result.stdout).toContain(NOTE_FRAGMENT)
    expect(result.stdout).toContain('independent per-candidate judgments')
  })

  it('carries the same statement in the JSON payload', async () => {
    const result = await rank([0.9, 0.9, 0.9], ['--json'])
    const payload = result.json<{ data: { note: string } }>()
    expect(payload.data.note).toContain(NOTE_FRAGMENT)
  })

  it('does not normalize the numbers, which is the point of the note', async () => {
    // Three independent 0.9s are not "0.33 each". A command that rescaled them
    // would make the note false.
    const result = await rank([0.9, 0.9, 0.9], ['--json'])
    const payload = result.json<{ data: { ranking: { relevance: number }[] } }>()
    expect(payload.data.ranking.map((entry) => entry.relevance)).toEqual([0.9, 0.9, 0.9])
  })
})

describe('candidates and queries', () => {
  it('answers an empty candidate list without a provider call', async () => {
    stub.sdk.TypeSafeClient.throws = new Error('the provider must not be called')
    const candidates = harness.json('candidates.json', [])
    const result = await harness.run(
      ['rank', '--query', 'q', '--candidates', candidates, '--provider', 'live', '--json'],
      { env: stub.env() },
    )
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{ provider: string; data: { ranking: unknown[]; note: string } }>()
    expect(payload.provider).toBe('none')
    expect(payload.data.ranking).toEqual([])
    expect(payload.data.note).toContain(NOTE_FRAGMENT)
    stub.sdk.TypeSafeClient.throws = undefined
  })

  it('refuses a candidate list that is not an array', async () => {
    const candidates = harness.json('candidates.json', { a: 'not an array' })
    const result = await harness.run(['rank', '--query', 'q', '--candidates', candidates])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('must be a JSON array of strings')
  })

  it('names the offending entry when a candidate is not a string', async () => {
    const candidates = harness.json('candidates.json', ['fine', 42])
    const result = await harness.run(['rank', '--query', 'q', '--candidates', candidates])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--candidates[1] must be a string')
  })

  it('reads candidates from standard input', async () => {
    stub.sdk.TypeSafeClient.answer = async () => ({
      model: 'jev-1.13.0',
      answers: { candidate_0: { type: 'noul', noul: 0.8 } },
    })
    const result = await harness.run(
      ['rank', '--query', 'q', '--candidates', '-', '--provider', 'live', '--json'],
      { env: stub.env(), stdin: '["piped candidate"]' },
    )
    expect(result.code).toBe(EXIT.OK)
    expect(result.json<{ data: { ranking: unknown[] } }>().data.ranking).toHaveLength(1)
  })

  it('uses a caller-supplied criterion in place of the default', async () => {
    const result = await rank([0.5, 0.5, 0.5], ['--criterion', 'Is it about penguins?'])
    expect(result.stdout).toContain('criterion: Is it about penguins?')
  })

  it('sends candidates in the state and refers to them by path, never as question text', async () => {
    // The anti-pattern the docs name outright: splicing a caller's data into a
    // question string. It would put candidate text on the wire as *question* text,
    // which is a different field with a different cap and a different redaction
    // path — and the answer would be keyed by a question nobody can reconstruct.
    const candidates = harness.json('candidates.json', ['SECRET-CANDIDATE-TEXT'])
    stub.sdk.TypeSafeClient.answer = async () => ({
      model: 'jev-1.13.0',
      answers: { candidate_0: { type: 'noul', noul: 0.5 } },
    })
    await harness.run(
      ['rank', '--query', 'q', '--candidates', candidates, '--provider', 'live'],
      { env: stub.env() },
    )

    const request = stub.sdk.TypeSafeClient.lastRequest as {
      state: { candidates: { index: number; text: string }[]; query: string }
      questions: Record<string, { instructions: string }>
    }
    expect(request.state.candidates).toEqual([{ index: 0, text: 'SECRET-CANDIDATE-TEXT' }])
    const instructions = request.questions.candidate_0?.instructions ?? ''
    expect(instructions).toContain('`candidates[0].text`')
    expect(instructions).not.toContain('SECRET-CANDIDATE-TEXT')
  })
})
