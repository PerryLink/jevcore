/**
 * The result has to carry what egress did to it.
 *
 * `MeasuredPayload.truncated` was computed in `EgressContract.measure` and then
 * had nowhere to go. It was passed to `JevService.record` for the call log and
 * nowhere else, so a caller holding a `JevResult` could not tell a decision made
 * from the whole state from one made from a fragment of it — and the answer
 * changes when the state changes, because the state is the evidence.
 *
 * That is not only a logging gap. `render.ts` promises "a missing answer is
 * reported as missing", and a truncated state is the same category of fact: the
 * caller is looking at a judgment about something other than what they passed.
 * So it is reported in the value, not only in a log line that may be turned off.
 *
 * The other half of the same defect lived in the cap itself: with the cap below
 * the size of the truncation envelope, the envelope was sliced to
 * `{"[truncated]":true,...,"[head]":""}` — a payload whose entire state is the
 * word "truncated". Jev answered about that, and the answer looked ordinary.
 * That is refused now.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  EgressTooLargeError,
  JevService,
  MIN_TRUNCATED_HEAD_CHARS,
  MockProvider,
  redact,
  renderResult,
  type EgressFeature,
  type JevProvider,
  type JevRequest,
  type JevResult,
} from '../src/index.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

/** A contract with the operator's own state cap, which is what makes caps real. */
const capped = (maxStateChars: number | undefined) =>
  new EgressContract(
    { transmitting: true, enabled: allOn() },
    'https://api.typesafe.ai',
    maxStateChars,
  )

/** A provider that echoes what it was asked, so the payload can be inspected. */
const recordingProvider = (): { provider: JevProvider; last: () => JevRequest | undefined } => {
  let last: JevRequest | undefined
  return {
    provider: {
      id: 'recording',
      async answer(request): Promise<JevResult> {
        last = request
        return { model: 'm', provider: 'recording', latencyMs: 1, answers: {} }
      },
    },
    last: () => last,
  }
}

const serviceWith = (egress: EgressContract, provider: JevProvider = new MockProvider()) =>
  new JevService({ provider, egress, transmitting: true, model: 'm' })

const questions = { q: { type: 'noul' as const, instructions: 'is this relevant?' } }

describe('the reported size is the size that actually left', () => {
  it('matches the payload the provider received, character for character', async () => {
    // The assertion the whole feature rests on. `stateChars` is computed by the
    // egress contract and then reported back in the result; on its own that is
    // the contract grading its own homework. This measures the payload at the
    // other end of the call instead.
    //
    // Measurement basis, stated exactly: `stateChars` is the length of
    // `JSON.stringify(state)` — the serialized length of the state *field*, which
    // is the unit both `maxChars` and the startup report's `state<=Nc` are
    // expressed in. It is not the length of the `state` string content, which
    // would differ by the quotes and escapes. So the equivalent measurement on
    // the provider's side is `JSON.stringify(request.state).length`, and it can
    // be compared for exact equality: the provider receives the parsed value, and
    // re-serializing it reproduces the same escaping the envelope was built with,
    // including when the head was cut mid-escape-sequence.
    const { provider, last } = recordingProvider()
    const rawState = { body: 'x'.repeat(50_000) }
    const service = serviceWith(capped(500), provider)

    const result = await service.ask({ feature: 'tool:jev_ask', state: rawState, questions })

    const sent = last()?.state as Record<string, unknown> | undefined
    expect(sent).toBeDefined()
    // 1. What left is the truncation envelope, not the original state.
    expect(sent).toMatchObject({ '[truncated]': true })
    expect(JSON.stringify(sent)).not.toBe(JSON.stringify(rawState))
    // 2. The envelope carries real content, so it is a smaller state and not an
    //    empty one.
    expect(String(sent?.['[head]']).length).toBeGreaterThan(0)
    // 3. The number reported equals the number sent, exactly.
    const sentChars = JSON.stringify(sent).length
    expect(sentChars).toBe(result.egress?.stateChars)
    // 4. And the same number is the one the cap promised — which also settles
    //    whether the cap really reached the wire rather than the report.
    expect(sentChars).toBe(500)
    expect(result.egress?.stateChars).toBe(500)
    // 5. Nothing of the original was silently kept beyond the cap.
    expect(JSON.stringify(sent)).not.toContain('x'.repeat(1_000))
  })

  it('holds for a payload whose head is cut inside an escape sequence', async () => {
    // The case that could break the equality above: the head is a slice of the
    // *serialized* text, so it can end between a backslash and the character it
    // escapes. The envelope escapes that dangling backslash itself, and
    // re-serializing the parsed head escapes it identically, so the two lengths
    // still agree — but only because the measurement is taken on the serialized
    // form on both sides. A test comparing string *content* lengths would differ.
    for (const raw of ['\\'.repeat(20_000), '"'.repeat(20_000), 'a"b\\c\nd\te'.repeat(5_000)]) {
      const { provider, last } = recordingProvider()
      const service = serviceWith(capped(400), provider)
      const result = await service.ask({ feature: 'tool:jev_ask', state: { body: raw }, questions })
      const sent = last()?.state as Record<string, unknown> | undefined
      expect(sent).toMatchObject({ '[truncated]': true })
      expect(JSON.stringify(sent).length, raw.slice(0, 3)).toBe(result.egress?.stateChars)
      expect(JSON.stringify(sent).length, raw.slice(0, 3)).toBeLessThanOrEqual(400)
    }
  })

  it('reports the size it sent when nothing was capped either', async () => {
    // The same equality without a cap involved, so the number is not a special
    // case of truncation.
    const { provider, last } = recordingProvider()
    const service = serviceWith(capped(undefined), provider)
    const rawState = { ticket: 'help', n: 1 }
    const result = await service.ask({ feature: 'tool:jev_ask', state: rawState, questions })
    const sentChars = JSON.stringify(last()?.state).length
    expect(sentChars).toBe(JSON.stringify(rawState).length)
    expect(sentChars).toBe(result.egress?.stateChars)
    expect(result.truncated).toBeUndefined()
  })
})

describe('truncation is stated in the result', () => {
  it('marks a result produced from a capped state', async () => {
    const service = serviceWith(capped(500))
    const result = await service.ask({ feature: 'tool:jev_ask', state: 'x'.repeat(5_000), questions })
    expect(result.truncated).toBe(true)
    expect(result.egress?.truncated).toBe(true)
    // The size actually sent, so a caller can see how much Jev saw.
    expect(result.egress?.stateChars).toBeLessThanOrEqual(500)
    expect(result.egress?.stateChars).toBeGreaterThan(0)
  })

  it('leaves the key absent when nothing was capped', async () => {
    const service = serviceWith(capped(undefined))
    const result = await service.ask({ feature: 'tool:jev_ask', state: { a: 1 }, questions })
    // Absent rather than `false`, so an ordinary result keeps the shape it had
    // before this field existed.
    expect(result.truncated).toBeUndefined()
    expect(result.egress?.truncated).toBe(false)
    expect('truncated' in result).toBe(false)
  })

  it('reports the redactions that shaped the same payload', async () => {
    const service = serviceWith(capped(undefined))
    const result = await service.ask({
      feature: 'tool:jev_ask',
      state: { api_key: 'sk-live-abcdefghijklmnopqrstuvwx', note: 'keep me' },
      questions,
    })
    expect(result.egress?.redactedFields).toContain('api_key')
    expect(result.egress?.redactions).toBeGreaterThanOrEqual(1)
    expect(result.egress?.redactionRules).toContain('key-name')
  })

  it('counts free-text replacements apart from named fields', async () => {
    const service = serviceWith(capped(undefined))
    const result = await service.ask({
      feature: 'tool:jev_ask',
      // No sensitive field name anywhere: this is the value-rule path.
      state: { note: 'the token is sk-live-abcdefghijklmnopqrstuvwx' },
      questions,
    })
    expect(result.egress?.redactedValues).toBeGreaterThanOrEqual(1)
    expect(result.egress?.redactedFields).toContain('[value]')
    expect(result.egress?.redactedFields).not.toContain('note')
  })

  it('never records the value that was removed, only the field', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwx'
    const service = serviceWith(capped(undefined))
    const result = await service.ask({
      feature: 'tool:jev_ask',
      state: { api_key: secret },
      questions,
    })
    expect(JSON.stringify(result.egress)).not.toContain(secret)
  })

  it('records truncation on the call record as well, for the status surface', async () => {
    const service = serviceWith(capped(500))
    await service.ask({ feature: 'tool:jev_ask', state: 'y'.repeat(4_000), questions })
    expect(service.stats().lastCall?.truncated).toBe(true)
  })
})

describe('the rendered output carries it to the model', () => {
  it('forwards truncation through renderResult', async () => {
    const service = serviceWith(capped(500))
    const result = await service.ask({ feature: 'tool:jev_ask', state: 'x'.repeat(5_000), questions })
    const rendered = renderResult(result, ['q'])
    expect(rendered.truncated).toBe(true)
    expect(rendered.egress?.truncated).toBe(true)
  })

  it('omits both keys when there is nothing to say', async () => {
    const service = serviceWith(capped(undefined))
    const result = await service.ask({ feature: 'tool:jev_ask', state: 'short', questions })
    const rendered = renderResult(result, ['q'])
    expect('truncated' in rendered).toBe(false)
    // `egress` is always present when a service prepared the payload: the counts
    // are informative even when they are zero.
    expect(rendered.egress?.truncated).toBe(false)
  })

  it('does not put the removed content into the rendered payload', async () => {
    const service = serviceWith(capped(300))
    const result = await service.ask({
      feature: 'tool:jev_ask',
      state: `api_key=sk-live-abcdefghijklmnopqrstuvwx ${'z'.repeat(4_000)}`,
      questions,
    })
    expect(JSON.stringify(renderResult(result, ['q']))).not.toContain(
      'sk-live-abcdefghijklmnopqrstuvwx',
    )
  })
})

describe('a cap too small for a truncation envelope is refused, not emptied', () => {
  /** Well above the envelope, below the content: the normal truncation case. */
  const bigState = { body: 'x'.repeat(50_000) }

  it('produces a head with real content at a usable cap', () => {
    const measured = capped(2_000).measure({
      feature: 'tool:jev_ask',
      state: bigState,
      questions,
      redact,
    })
    expect(measured.truncated).toBe(true)
    const state = measured.state as Record<string, unknown>
    expect(state['[truncated]']).toBe(true)
    expect(String(state['[head]']).length).toBeGreaterThanOrEqual(MIN_TRUNCATED_HEAD_CHARS)
    // And it fits the cap it was given, envelope included.
    expect(measured.stateChars).toBeLessThanOrEqual(2_000)
  })

  it('refuses a cap below the envelope instead of sending an empty head', () => {
    // The reported defect: when the cap was smaller than the truncation
    // envelope, the head was sliced to zero characters and the payload that left
    // was `{"[truncated]":true,…,"[head]":""}` — a document whose entire "state"
    // is the word *truncated*. Jev answered a question about it, and the answer
    // was reported as if it were about the caller's state.
    //
    // The envelope's own markers take about 72 characters before any content, so
    // these caps cannot hold a state by any reading.
    for (const cap of [1, 20, 60, 70]) {
      let caught: unknown
      try {
        capped(cap).measure({ feature: 'tool:jev_ask', state: bigState, questions, redact })
      } catch (error) {
        caught = error
      }
      expect(caught, `cap ${cap}`).toBeInstanceOf(EgressTooLargeError)
      const error = caught as EgressTooLargeError
      expect(error.feature).toBe('tool:jev_ask')
      expect(error.field).toBe('state')
      expect(error.maxChars).toBe(cap)
      expect(error.actualChars).toBeGreaterThan(cap)
      // Actionable: it has to say what to raise the limit to.
      expect(error.message).toContain('too small to hold even a truncated state')
      expect(error.message).toMatch(/at least \d+/)
    }
  })

  it('draws that boundary exactly where it says it does', () => {
    // The refusal above is only credible if the boundary is real, so this finds
    // it rather than trusting a number: the first cap that works, the cap one
    // character below it, and whether the working one uses every character it
    // was given.
    const fits = (cap: number): boolean => {
      try {
        capped(cap).measure({ feature: 'tool:jev_ask', state: bigState, questions, redact })
        return true
      } catch {
        return false
      }
    }
    let boundary = 1
    while (boundary < 400 && !fits(boundary)) boundary += 1
    expect(boundary).toBeLessThan(400)
    expect(fits(boundary), `cap ${boundary}`).toBe(true)
    expect(fits(boundary - 1), `cap ${boundary - 1}`).toBe(false)

    const measured = capped(boundary).measure({
      feature: 'tool:jev_ask',
      state: bigState,
      questions,
      redact,
    })
    const state = measured.state as Record<string, unknown>
    expect(String(state['[head]']).length).toBeGreaterThanOrEqual(MIN_TRUNCATED_HEAD_CHARS)
    // Exactly the cap: at one character less the envelope does not fit, so a
    // payload at the boundary cannot be leaving slack behind.
    expect(JSON.stringify(measured.state).length).toBe(boundary)
  })

  it('never emits a payload whose head is empty, at any cap', () => {
    // Sweeps the boundary rather than trusting one number, since the envelope
    // size depends on the payload's own length.
    for (const cap of [1, 50, 100, 200, 260, 300, 500, 1_000]) {
      let measured: ReturnType<EgressContract['measure']> | undefined
      try {
        measured = capped(cap).measure({
          feature: 'tool:jev_ask',
          state: bigState,
          questions,
          redact,
        })
      } catch (error) {
        expect(error, `cap ${cap}`).toBeInstanceOf(EgressTooLargeError)
        continue
      }
      const state = measured.state as Record<string, unknown>
      expect(String(state['[head]']).length, `cap ${cap}`).toBeGreaterThanOrEqual(
        MIN_TRUNCATED_HEAD_CHARS,
      )
      expect(measured.stateChars, `cap ${cap}`).toBeLessThanOrEqual(cap)
    }
  })

  it('leaves a state that fits the cap untouched, however small the cap is', () => {
    // The refusal is about truncation, not about size: a small state under a
    // small cap is still a valid request.
    const measured = capped(20).measure({
      feature: 'tool:jev_ask',
      state: 'tiny',
      questions,
      redact,
    })
    expect(measured.truncated).toBe(false)
    expect(measured.state).toBe('tiny')
  })
})
