/**
 * The declared `questions` cap must be enforced, not merely reported.
 *
 * It previously was not. `measure` computed a capped question string, used its
 * length for the report line, and then returned the *original* uncapped map — so
 * the startup report printed `questions<=4000c` while nothing bounded it. That is
 * the defect `egress.ts`'s own header describes as the reason the module exists,
 * so it belongs under test rather than under a comment.
 *
 * `questions` is refused rather than truncated, unlike `state`. The question map
 * is what answers are keyed by; shortening it would return answers that cannot be
 * matched back to the questions that produced them.
 */

import { describe, expect, it } from 'vitest'
import { EGRESS_FEATURES, EgressContract, EgressTooLargeError, type EgressFeature } from '../src/index.js'
import type { JevQuestion } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

/** A contract that transmits, for one feature. */
const transmitting = () =>
  new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai')

/** Redaction that does nothing, so the test measures the cap and nothing else. */
const identityRedact = (value: unknown) => ({
  value: value as never,
  summary: { redactions: 0, rules: [], fields: [], values: 0 },
})

const ask = (questions: Record<string, JevQuestion>, feature: EgressFeature = 'tool:jev_ask') =>
  transmitting().measure({ feature, state: { x: 1 }, questions, redact: identityRedact })

describe('the questions cap is enforced', () => {
  it('accepts a batch within the declared limit', () => {
    const measured = ask({ q: { type: 'noul', instructions: 'ok?' } })
    expect(measured.questionsChars).toBeGreaterThan(0)
    expect(measured.truncated).toBe(false)
  })

  it('refuses a batch over the limit rather than reporting a size it never sends', () => {
    // `tool:jev_ask` declares 4,000 characters for questions. One long
    // instruction is enough to exceed it.
    const long: JevQuestion = { type: 'noul', instructions: 'x'.repeat(5_000) }
    let caught: unknown
    try {
      ask({ big: long })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EgressTooLargeError)
    const error = caught as EgressTooLargeError
    expect(error.feature).toBe('tool:jev_ask')
    expect(error.field).toBe('questions')
    expect(error.maxChars).toBe(4_000)
    expect(error.actualChars).toBeGreaterThan(4_000)
    // The message has to be actionable: the operator cannot fix a number they
    // cannot see.
    expect(error.message).toMatch(/over the declared limit/)
    expect(error.message).toMatch(/cannot be matched to what was asked/)
  })

  it('applies each feature\'s own limit, not one shared number', () => {
    // A batch that fits jev_ask's 4,000 must still be refused by the gates'
    // smaller caps, or the per-feature declaration would be decorative.
    const instructions = 'y'.repeat(2_500)
    expect(() => ask({ q: { type: 'noul', instructions } }, 'tool:jev_ask')).not.toThrow()
    expect(() => ask({ q: { type: 'noul', instructions } }, 'gate:safety')).toThrow(EgressTooLargeError)
    expect(() => ask({ q: { type: 'noul', instructions } }, 'gate:context')).toThrow(EgressTooLargeError)
  })

  it('still truncates state, which can be reduced without changing the answers', () => {
    const measured = transmitting().measure({
      feature: 'tool:jev_ask',
      state: 'z'.repeat(20_000),
      questions: { q: { type: 'noul', instructions: 'ok?' } },
      redact: identityRedact,
    })
    expect(measured.truncated).toBe(true)
    // The declared limit is a limit. It used to allow itself 200 characters of
    // slack for the truncation envelope, which meant `state<=16000c` in the
    // startup report was not true of what left the machine.
    expect(measured.stateChars).toBeLessThanOrEqual(16_000)
    expect(measured.stateCharsDropped).toBeGreaterThan(0)
  })
})
