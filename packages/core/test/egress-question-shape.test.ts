/**
 * The question map must survive redaction with its shape intact.
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
 * So these assertions are about *values and shapes*, not names, and one of them
 * drives a deliberately broken redactor to prove the new guard actually fires.
 */

import { describe, expect, it } from 'vitest'
import { EGRESS_FEATURES, EgressContract, EgressShapeError, type EgressFeature } from '../src/egress.js'
import { HAZARD_QUESTIONS, SAFETY_FEATURE, SAFETY_QUESTIONS } from '../src/gates/safety.js'
import { MockProvider } from '../src/provider/mock.js'
import { redact } from '../src/redact.js'
import { JevService } from '../src/service.js'
import type { JevProvider, JevRequest, JsonValue } from '../src/types.js'

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
        // The value rules must keep working; only the key rules are withheld.
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

  it('refuses a redactor that reshapes the map, rather than asking about everything', () => {
    // The guard, driven by its own failure mode: a redactor that ignores the
    // options is exactly the bug that shipped. Without the check the payload goes
    // out malformed and the gate degrades to `ask` for reasons nobody can see.
    const reshapesTheMap = (value: JsonValue) => redact(value)

    expect(() =>
      contract().measure({
        feature: SAFETY_FEATURE,
        state: { tool: 'pwsh' },
        questions: SAFETY_QUESTIONS,
        redact: reshapesTheMap,
      }),
    ).toThrow(EgressShapeError)
  })
})
