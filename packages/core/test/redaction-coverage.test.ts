/**
 * Redaction must cover everything that leaves, not just `state`.
 *
 * It used to cover `state` alone. That was a real leak rather than a theoretical
 * one: `jev_rank` built one question per candidate with the candidate's text
 * inside it, so a caller ranking a record that happened to contain a credential
 * had it transmitted verbatim from inside a question — while the same string in
 * `state` was redacted. Verified before the fix: a key in `state` became
 * `[redacted]`, and the identical key in a question left the machine intact.
 *
 * The contract's claim is that what leaves is the redacted content. A question is
 * content.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  JevService,
  redact,
  type EgressFeature,
  type JevProvider,
  type JevRequest,
} from '../src/index.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

/** A well-formed fake key of the shape the default value rules target. */
const SECRET = 'sk-live-9f3a2b7c8d1e4f5a6b0c9d8e7f6a5b4c'

/** Records the request the provider was handed, without answering. */
const recordingProvider = (): { provider: JevProvider; last: () => JevRequest | undefined } => {
  let last: JevRequest | undefined
  return {
    provider: {
      id: 'recording',
      async answer(request) {
        last = request
        return { model: 'm', provider: 'recording', latencyMs: 1, answers: {} }
      },
    },
    last: () => last,
  }
}

const serviceWith = (provider: JevProvider) =>
  new JevService({
    provider,
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
    transmitting: true,
    model: 'm',
  })

describe('redaction covers the whole payload', () => {
  it('redacts a secret in state', async () => {
    const { provider, last } = recordingProvider()
    await serviceWith(provider).ask({
      feature: 'tool:jev_ask',
      state: { note: `token ${SECRET}` },
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    expect(JSON.stringify(last()?.state)).not.toContain(SECRET)
  })

  it('redacts a secret inside a question, which is what used to leak', async () => {
    const { provider, last } = recordingProvider()
    await serviceWith(provider).ask({
      feature: 'tool:jev_ask',
      state: { query: 'rotate a key' },
      questions: {
        candidate_0: {
          type: 'noul',
          instructions: `Candidate: runbook, token ${SECRET} -- does it help?`,
        },
      },
    })
    const payload = JSON.stringify(last())
    expect(payload).not.toContain(SECRET)
    expect(payload).toContain('[redacted]')
  })

  it('redacts a secret in structured instructions, not only in a plain string', async () => {
    const { provider, last } = recordingProvider()
    await serviceWith(provider).ask({
      feature: 'tool:jev_ask',
      state: 'x',
      questions: {
        q: {
          type: 'noul',
          instructions: {
            question: 'Does the record indicate a duplicate?',
            record: { api_key: SECRET },
            focus: 'Compare identity fields.',
          },
        },
      },
    })
    expect(JSON.stringify(last()?.questions)).not.toContain(SECRET)
  })

  it('redacts a secret in a choice option description', async () => {
    const { provider, last } = recordingProvider()
    await serviceWith(provider).ask({
      feature: 'tool:jev_ask',
      state: 'x',
      questions: {
        q: {
          type: 'choice',
          instructions: 'Which team?',
          criteria: { platform: `Platform (contact: ${SECRET})`, security: 'Security' },
        },
      },
    })
    expect(JSON.stringify(last()?.questions)).not.toContain(SECRET)
  })

  it('attributes the redactions to the call, wherever they were found', async () => {
    // The audit trail has to count everything removed, or an operator reading it
    // would under-report what the redactor caught. Redactions are recorded on the
    // call, not returned with the result.
    const { provider } = recordingProvider()
    const service = serviceWith(provider)
    await service.ask({
      feature: 'tool:jev_ask',
      state: { note: `token ${SECRET}` },
      questions: { q: { type: 'noul', instructions: `also ${SECRET}` } },
    })
    const lastCall = service.stats().lastCall
    expect(lastCall?.redactions).toBeGreaterThanOrEqual(2)
    expect(lastCall?.redactionRules).toContain('openai-style-key')
  })

  it('the default ruleset really does recognise the fixture', () => {
    // Guards the test itself: if this stops matching, every assertion above
    // passes vacuously.
    expect(redact(`token ${SECRET}`).value).toContain('[redacted]')
  })
})
