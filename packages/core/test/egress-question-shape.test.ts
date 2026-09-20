/**
 * The question map must survive redaction with its shape intact, and everything
 * inside a question must still be redacted.
 *
 * This file exists because of a shipped defect that no test caught, and the
 * reason no test caught it is worth stating: the existing disclosure test
 * compared the *keys* of the transmitted question map against the declared one,
 * and the defect preserved the keys exactly. It replaced the values.
 *
 * `EgressContract` redacted the question map with the key rules on. A key rule
 * replaces a value whose field name looks secret-bearing, and one of this
 * package's own hazard ids is `credential_exposure` — which `/credential/i`
 * matches. So the gate's own question was replaced by the string `"[redacted]"`
 * before it left: 160 characters of a declared 1,774-character payload, gone.
 *
 * What made it survive is the interesting part. On the offline route the mock
 * provider throws `TypeError: Cannot convert undefined or null to object`, and
 * the safety gate catches provider errors and routes them through `onUndecided`,
 * whose default is `ask`. A gate that had stopped judging anything returned the
 * decision a careful gate returns. Nothing failed; nothing was asked either.
 *
 * The first fix for that withheld the key rules from the whole question subtree,
 * and an adversarial verifier falsified it from the other side: a secret named by
 * its key *inside* a question was then transmitted verbatim, and counted as zero
 * redactions. `dsh/src/ask.ts` passes caller-shaped `instructions` and `criteria`
 * straight into `noul`/`choice`/`score`, so that was a live path.
 *
 * The fix both halves point at is the one under test here: the ids are *re-keyed*
 * — redact each question's value with the full ruleset, then put the result back
 * under the id it arrived with — so no rule has to be withheld from anything.
 * That leaves the shape guard protecting a different invariant than it did, which
 * is why the guard tests below drive redactors that rewrite the payload rather
 * than the old "ignores its options" stand-in.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  EgressShapeError,
  type EgressFeature,
} from '../src/egress.js'
import { HAZARD_QUESTIONS, SAFETY_FEATURE, SAFETY_QUESTIONS } from '../src/gates/safety.js'
import { noul } from '../src/primitives.js'
import { MockProvider } from '../src/provider/mock.js'
import { redact } from '../src/redact.js'
import { JevService } from '../src/service.js'
import type { JevProvider, JevQuestion, JevRequest, JsonValue } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const contract = () =>
  new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai')

/** A provider that records the request and answers nothing, so nothing is judged. */
const recorder = (requests: JevRequest[]): JevProvider => ({
  id: 'recording',
  answer: async (request) => {
    requests.push(request)
    return { model: 'recording', provider: 'recording', latencyMs: 1, answers: {} }
  },
})

const secret = 'hunter2-correct-horse'

describe('the question map survives redaction', () => {
  it('sends every hazard as a question, including the one whose id looks like a secret', async () => {
    const requests: JevRequest[] = []
    const service = new JevService({ provider: recorder(requests), egress: contract() })

    await service.ask({ feature: SAFETY_FEATURE, state: { tool: 'pwsh' }, questions: SAFETY_QUESTIONS })

    const sent = requests[0]?.questions as unknown as Record<string, unknown>

    // The id is the regression: `/credential/i` matched it and the whole question
    // became a string. Named explicitly so a future reader sees the exact case.
    expect(sent.credential_exposure).not.toBe('[redacted]')

    // Then the general property, which is what would have caught it: every
    // declared id arrives carrying an object with a type, not a marker string.
    for (const [id, question] of Object.entries(SAFETY_QUESTIONS)) {
      const arrived = sent[id] as { type?: unknown } | undefined
      expect(typeof arrived, `${id} arrived as ${typeof arrived}`).toBe('object')
      expect(arrived?.type, `${id} arrived without a type`).toBe(question.type)
    }
  })

  it('still redacts a credential written into a question body', async () => {
    const requests: JevRequest[] = []
    const service = new JevService({ provider: recorder(requests), egress: contract() })

    await service.ask({
      feature: 'tool:jev_ask',
      state: { note: 'nothing here' },
      questions: {
        // A value rule has to keep working on the text of a question.
        authored: { type: 'noul', instructions: 'Does the log contain api_key="sk-live-abcdef0123456789"?' },
      },
    })

    expect(JSON.stringify(requests[0]?.questions)).not.toContain('sk-live-abcdef0123456789')
  })

  it('lets the offline mock answer the real hazard list instead of throwing', async () => {
    // The default install is the offline one, and this is the path that failed:
    // the mock treats a question by its `type`, and a `"[redacted]"` string has
    // none, so it reached `Object.keys(undefined)`.
    const service = new JevService({ provider: new MockProvider(), egress: contract() })

    await expect(
      service.ask({ feature: SAFETY_FEATURE, state: { tool: 'pwsh' }, questions: SAFETY_QUESTIONS }),
    ).resolves.toBeDefined()

    expect(Object.keys(HAZARD_QUESTIONS)).toHaveLength(5)
  })
})

describe('a secret inside a question is content and is redacted', () => {
  it('redacts a secret named by its key in a question instruction object', () => {
    // The verifier's reproduction, exactly: an instruction object whose own key
    // names the secret. Withholding the key rules from the question subtree left
    // this string in the payload and reported `redactions: 0`.
    const measured = contract().measure({
      feature: 'tool:jev_ask',
      state: { note: 'nothing here' },
      questions: { q1: noul({ context: 'the deployment notes', password: secret }) },
      redact,
    })

    expect(JSON.stringify(measured.questions)).not.toContain(secret)
    // Counted, not merely removed: the caller-facing totals are what an operator
    // reads to decide whether anything sensitive was in the payload at all.
    expect(measured.redactions).toBeGreaterThan(0)
    expect(measured.redactionRules).toContain('key-name')
    expect(measured.redactedFields).toContain('password')
    // The id is still a protocol identifier, and it arrives intact.
    expect(Object.keys(measured.questions)).toEqual(['q1'])
  })

  it('redacts a secret nested in a noul boundary, which is caller-shaped too', () => {
    const measured = contract().measure({
      feature: 'tool:jev_ask',
      state: 1,
      questions: { q2: noul('Is the key valid?', { true: { dbPassword: secret }, false: 'no' }) },
      redact,
    })

    expect(JSON.stringify(measured.questions)).not.toContain(secret)
    expect(measured.redactedFields).toContain('dbPassword')
  })

  it('reaches no provider with the secret, on the live path jev_ask uses', async () => {
    // The whole point of the finding: the leak was reachable end to end, not just
    // observable through `measure`. `packages/dsh/src/ask.ts` `toQuestions` builds
    // exactly this shape from model-authored input.
    const requests: JevRequest[] = []
    const service = new JevService({ provider: recorder(requests), egress: contract() })

    await service.ask({
      feature: 'tool:jev_ask',
      state: { note: 'x' },
      questions: { q1: noul({ context: 'the deployment notes', password: secret }) },
    })

    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.questions)).not.toContain(secret)
  })

  it('aggregates the per-question counts into the payload totals', () => {
    // Redacting question by question is an implementation detail; dropping a
    // count because of it would not be. One keyed secret in the state, one keyed
    // secret in a question, one free-text token shape in a question body.
    const measured = contract().measure({
      feature: 'tool:jev_ask',
      state: { password: 'state-secret' },
      questions: {
        keyed: noul({ context: 'notes', apiKey: 'question-secret' }),
        freeText: { type: 'noul', instructions: `leaked ghp_${'a'.repeat(20)} in a log` },
      },
      redact,
    })

    expect(measured.redactions).toBe(3)
    expect(measured.redactedValues).toBe(1)
    // Compared as a set: the payload's rule names are state rules first, then
    // question rules, and that order is neither promised nor worth pinning. That
    // the set holds both is the aggregation.
    expect([...measured.redactionRules].sort()).toEqual(['github-token', 'key-name'])
    // `'[value]'` is how a replacement inside free text is named; sorted, it
    // leads, because `[` sorts before any letter.
    expect(measured.redactedFields).toEqual(['[value]', 'apiKey', 'password'])
  })
})

describe('the shape guard fires rather than failing open', () => {
  /** A redactor that rewrites the payload instead of its content. */
  const returning = (value: unknown) => () => ({
    value: value as JsonValue,
    summary: { redactions: 1, rules: ['key-name'], fields: [], values: 0 },
  })

  const measureWithQuestions = (questions: unknown) =>
    contract().measure({
      feature: SAFETY_FEATURE,
      state: { tool: 'pwsh' },
      questions: questions as Readonly<Record<string, JevQuestion>>,
      redact,
    })

  it('refuses a redactor that returns something other than a question', () => {
    // The verifier's reproduction of the hole: `Object.entries(7)` is `[]` rather
    // than an error, so `measure` used to return a payload whose `questions` was
    // the number 7 and nothing noticed. `null` and `undefined` threw a raw
    // `TypeError`, which no caller can branch on.
    for (const replacement of [null, undefined, '[redacted]', 7, false, [], ['q1']]) {
      expect(
        () =>
          contract().measure({
            feature: SAFETY_FEATURE,
            state: { tool: 'pwsh' },
            questions: SAFETY_QUESTIONS,
            redact: returning(replacement),
          }),
        `map replaced by ${JSON.stringify(replacement) ?? 'undefined'}`,
      ).toThrow(EgressShapeError)
    }
  })

  it('refuses a question map that is not a non-null, non-array object', () => {
    // Same three failures one level up, where the *caller* is the one who passed
    // the wrong shape. An array is included on purpose: `Object.entries` walks one
    // happily and the payload then leaves as a JSON array where an object belongs.
    for (const map of [null, undefined, 7, false, '[redacted]', []]) {
      expect(
        () => measureWithQuestions(map),
        `map was ${JSON.stringify(map) ?? 'undefined'}`,
      ).toThrow(EgressShapeError)
    }
  })

  it('names the offending ids in the error, so the failure is diagnosable', () => {
    // One question rewritten, the other left alone, so the message has to name
    // the id that broke rather than blaming the whole map.
    const breaksOneQuestion = (value: JsonValue) =>
      JSON.stringify(value).includes('bad')
        ? {
            value: '[redacted]' as JsonValue,
            summary: { redactions: 1, rules: ['key-name'], fields: [], values: 0 },
          }
        : redact(value)

    let caught: unknown
    try {
      contract().measure({
        feature: SAFETY_FEATURE,
        state: { tool: 'pwsh' },
        questions: { fine: noul('ok?'), broken: noul('bad?') },
        redact: breaksOneQuestion,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EgressShapeError)
    const error = caught as EgressShapeError
    expect(error.feature).toBe(SAFETY_FEATURE)
    expect(error.field).toBe('questions')
    // The id, not a list of everything that was sent: the reason to name anything
    // is that the reader has to find what did it.
    expect(error.ids).toEqual(['broken'])
    expect(error.message).toContain('broken')
    expect(error.message).toContain('Question ids key the answers')
  })

  it('does not fire for a redactor that ignores its options, because ids are re-keyed', () => {
    // This is the *old* guard test, and it has to fail for the guard to mean
    // anything: `redact(value)` — full rules, options ignored — was the redactor
    // that destroyed the map when the map was redacted as a whole. Now it runs per
    // question and cannot touch an id, so the payload is correct and throwing
    // would be a false positive. The guard's job moved; this pins where it moved
    // to.
    const ignoresOptions = (value: JsonValue) => redact(value)

    const measured = contract().measure({
      feature: SAFETY_FEATURE,
      state: { tool: 'pwsh' },
      questions: SAFETY_QUESTIONS,
      redact: ignoresOptions,
    })

    expect(Object.keys(measured.questions)).toEqual(Object.keys(SAFETY_QUESTIONS))
    expect(measured.questions.credential_exposure?.type).toBe('noul')
  })

  it('does not catch a value nested past redaction maxDepth, which is a known limit', () => {
    // Stated as a limit rather than a guarantee. `redact` replaces anything deeper
    // than its `maxDepth` with its own depth marker — documented behaviour of that
    // module, applied to `state` the same way — so the question stays a question
    // object and this guard has nothing to fire on. What the provider receives is
    // an instruction that is shorter than it was written, silently: the marker is
    // `redact`'s private constant, and re-detecting it here would mean this module
    // hard-coding another one's literal.
    let deep: JsonValue = { leaf: 'x' }
    for (let index = 0; index < 14; index += 1) deep = { nested: deep }

    const measured = contract().measure({
      feature: 'tool:jev_ask',
      state: 1,
      questions: { q1: noul(deep) },
      redact,
    })

    expect(measured.questions.q1?.type).toBe('noul')
    expect(JSON.stringify(measured.questions.q1)).toContain('[truncated:depth]')
  })
})
