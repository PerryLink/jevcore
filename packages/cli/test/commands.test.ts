/**
 * `jev ask` and `jev egress` — the two commands that need no judgment of their
 * own, and the paths they share.
 *
 * `ask` runs entirely against the offline mock here, which is the honest test for
 * it: the mock is the default provider, it is deterministic, and it is the
 * configuration in which most people will first run this tool. A test that needed
 * a stub transport to exercise `ask` would be testing the live route instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EGRESS_FEATURES } from 'jevcore'
import { EXIT } from '../src/types.js'
import { createHarness, type Harness } from './helpers/harness.js'

let harness: Harness
beforeEach(() => {
  harness = createHarness()
})
afterEach(() => {
  harness.dispose()
})

/** The smallest valid question document, plus a state for it. */
const fixture = (): { state: string; questions: string } => ({
  state: harness.json('state.json', { record: 'the state being judged' }),
  questions: harness.json('questions.json', {
    is_usable: { type: 'noul', instructions: 'Is this record usable?' },
  }),
})

describe('jev ask', () => {
  it('answers one batch against the mock, and labels the answer synthetic', async () => {
    const { state, questions } = fixture()
    const result = await harness.run([
      'ask',
      '--state',
      state,
      '--questions',
      questions,
      '--feature',
      'tool:jev_ask',
    ])

    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('ask tool:jev_ask')
    expect(result.stdout).toContain('[synthetic]')
    expect(result.stdout).toContain('is_usable=')
    // The mock warns on stderr as well as in the payload: an operator who sees a
    // probability and no provenance has been told something misleading.
    expect(result.stderr).toContain('SYNTHETIC')
    expect(result.stderr).toContain('no network call will be made')
  })

  it('defaults to the ask feature when --feature is omitted', async () => {
    const { state, questions } = fixture()
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('ask tool:jev_ask')
  })

  it('reads the state from standard input', async () => {
    const { questions } = fixture()
    const result = await harness.run(
      ['ask', '--state', '-', '--questions', questions, '--json'],
      { stdin: '{"record":"piped"}' },
    )
    expect(result.code).toBe(EXIT.OK)
    expect(result.json<{ ok: boolean }>().ok).toBe(true)
  })

  it('emits a stable JSON document with the answer fields a consumer reads', async () => {
    const { state, questions } = fixture()
    const result = await harness.run([
      'ask', '--state', state, '--questions', questions, '--feature', 'tool:jev_ask', '--json',
    ])
    const payload = result.json<{
      ok: boolean
      command: string
      provider: string
      model: string
      latencyMs: number
      data: {
        feature: string
        answers: { question: string; type: string; answer?: string; probability?: number; band?: string }[]
        egress: { stateChars: number; redactions: number; redactedFields: string[] }
        warning?: string
      }
    }>()

    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('ask')
    expect(payload.provider).toBe('mock')
    expect(payload.data.feature).toBe('tool:jev_ask')
    expect(payload.data.answers).toHaveLength(1)
    const answer = payload.data.answers[0]
    expect(answer?.question).toBe('is_usable')
    expect(answer?.type).toBe('noul')
    expect(['true', 'false']).toContain(answer?.answer)
    expect(['no', 'uncertain', 'yes']).toContain(answer?.band)
    expect(typeof answer?.probability).toBe('number')
    // The egress facts are in the payload as well as on stderr, because a
    // consumer that never reads stderr still has to be able to see what left.
    expect(payload.data.egress.stateChars).toBeGreaterThan(0)
    expect(payload.data.egress.redactions).toBe(0)
    expect(payload.data.warning).toContain('SYNTHETIC')
  })

  it('refuses an undeclared egress feature, listing the declared ones', async () => {
    const { state, questions } = fixture()
    const result = await harness.run([
      'ask', '--state', state, '--questions', questions, '--feature', 'tool:not_declared',
    ])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('"tool:not_declared" is not a declared egress feature')
    for (const feature of EGRESS_FEATURES) expect(result.stderr).toContain(feature)
  })

  it('refuses a question document that is not an object', async () => {
    const state = harness.json('state.json', { a: 1 })
    const questions = harness.json('questions.json', ['not', 'an', 'object'])
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--questions must be a JSON object')
  })

  it('refuses a question type that does not exist', async () => {
    const state = harness.json('state.json', { a: 1 })
    const questions = harness.json('questions.json', {
      q: { type: 'maybe', instructions: 'Is this a question?' },
    })
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('which is not a question type')
  })

  it('refuses an empty question batch with the core\'s own message', async () => {
    const state = harness.json('state.json', { a: 1 })
    const questions = harness.json('questions.json', {})
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.FAIL)
    expect(result.stderr).toContain('needs at least one question')
  })

  it('accepts both spellings of a noul boundary', async () => {
    const state = harness.json('state.json', { a: 1 })
    const questions = harness.json('questions.json', {
      first: { type: 'noul', instructions: 'q?', boundary: { true: 'yes', false: 'no' } },
      second: { type: 'noul', instructions: 'q?', criteria: { true: 'yes', false: 'no' } },
    })
    const result = await harness.run(['ask', '--state', state, '--questions', questions, '--json'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.json<{ data: { answers: unknown[] } }>().data.answers).toHaveLength(2)
  })

  it('refuses a criteria map on a noul that names no outcome', async () => {
    const state = harness.json('state.json', { a: 1 })
    const questions = harness.json('questions.json', {
      q: { type: 'noul', instructions: 'q?', criteria: { maybe: 'yes', perhaps: 'no' } },
    })
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('name no outcome')
  })

  it('names the malformed file when a fixture is not valid JSON', async () => {
    const state = harness.file('state.json', '{oh no')
    const questions = harness.json('questions.json', { q: { type: 'noul', instructions: 'q?' } })
    const result = await harness.run(['ask', '--state', state, '--questions', questions])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--state')
    expect(result.stderr).toContain('is not valid JSON')
  })

  it('reports a missing file by its resolved path', async () => {
    const questions = harness.json('questions.json', { q: { type: 'noul', instructions: 'q?' } })
    const result = await harness.run([
      'ask', '--state', `${harness.dir}/absent.json`, '--questions', questions,
    ])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('does not exist')
    expect(result.stderr).toContain('absent.json')
  })
})

describe('jev egress', () => {
  it('prints every declared feature person-readably, and says nothing is transmitted', async () => {
    const result = await harness.run(['egress'])
    expect(result.code).toBe(EXIT.OK)
    for (const feature of EGRESS_FEATURES) expect(result.stdout).toContain(feature)
    expect(result.stdout).toContain('transmitting: no')
    expect(result.stdout).toContain('provider=mock')
    expect(result.stdout).toContain('egress=OFF')
    // The limit of redaction is disclosed on the same screen as the claim, not
    // only in the README.
    expect(result.stdout).toContain('best-effort')
  })

  it('reports the declared cap for each field it would send', async () => {
    const result = await harness.run(['egress', '--json'])
    const payload = result.json<{
      data: {
        endpoint: string | null
        transmitting: boolean
        features: { feature: string; armed: boolean; fields: { field: string; maxChars: number }[] }[]
        report: string[]
      }
    }>()
    expect(payload.data.transmitting).toBe(false)
    expect(payload.data.endpoint).toBeNull()
    expect(payload.data.features).toHaveLength(EGRESS_FEATURES.length)

    const rank = payload.data.features.find((entry) => entry.feature === 'tool:jev_rank')
    expect(rank?.fields).toEqual([
      expect.objectContaining({ field: 'state', maxChars: 16_000 }),
      expect.objectContaining({ field: 'questions', maxChars: 4_000 }),
    ])
    // The contract's own audit line travels with the structured report.
    expect(payload.data.report.join('\n')).toContain('egress=OFF')
  })

  it('arms only the features named, and says which those are', async () => {
    const result = await harness.run(['egress', '--feature', 'gate:safety', '--json'])
    const payload = result.json<{ data: { features: { feature: string; armed: boolean }[] } }>()
    const armed = payload.data.features.filter((entry) => entry.armed).map((entry) => entry.feature)
    expect(armed).toEqual(['gate:safety'])
  })

  it('refuses an undeclared feature', async () => {
    const result = await harness.run(['egress', '--feature', 'nope'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('not a declared egress feature')
  })

  it('describes a transmitting route without resolving a credential', async () => {
    // Arming a feature must not require a key: the report is about what would be
    // sent, and a command that insisted on a credential in order to describe a
    // transmission it will not make would fail on exactly the machine where the
    // question matters most.
    const result = await harness.run(['egress', '--provider', 'live', '--json'], {
      env: { TYPESAFE_API_KEY: '' },
    })
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{ data: { transmitting: boolean; endpoint: string } }>()
    expect(payload.data.transmitting).toBe(true)
    expect(payload.data.endpoint).toBe('https://api.typesafe.ai')
  })

  it('names the OpenRouter endpoint it would post to, including the /api prefix', async () => {
    const result = await harness.run(['egress', '--provider', 'openrouter', '--json'])
    const payload = result.json<{ data: { endpoint: string } }>()
    expect(payload.data.endpoint).toBe('https://openrouter.ai/api')
  })
})
