/**
 * Both gates must carry what egress did to the payload they judged from.
 *
 * This is the same defect class that was fixed in `packages/mcp/src/tools.ts` and
 * `packages/dsh/src/{rank,check}.ts` in the same round, and the reason it matters
 * more here than anywhere else: a gate decision is what a human reads *instead of*
 * the tool call. A call judged on a `[truncated]` envelope used to produce exactly
 * the same `ask` as a call judged on the whole state, so "Jev flagged X" arrived
 * with no signal that Jev had read a fragment of X — the one reading a gate must
 * never invite. Redaction is the quieter half: a credential replaced before
 * sending means the answer is about a payload the caller never wrote.
 *
 * The fields are carried only when there is something to say. A decision made
 * from an ordinary call keeps the shape it had before they existed, so a consumer
 * cannot read "absent" as "nothing was capped" from the same key it reads as
 * "clean" — absence means the gate never got a measurement at all.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  type EgressFeature,
  type MeasuredPayload,
} from '../src/egress.js'
import { createContextGate } from '../src/gates/context.js'
import { createSafetyGate, SAFETY_FEATURE } from '../src/gates/safety.js'
import { noul } from '../src/primitives.js'
import { JevService } from '../src/service.js'
import type { JevProvider, JevResult } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

/** A contract that records the payload it measured, so a test can compare it. */
class RecordingContract extends EgressContract {
  last: MeasuredPayload | undefined

  override measure(input: Parameters<EgressContract['measure']>['0']): MeasuredPayload {
    const measured = super.measure(input)
    this.last = measured
    return measured
  }
}

const contract = () => new RecordingContract({ transmitting: true, enabled: allOn() }, 'https://x')

/**
 * A provider that answers every question with `true` at `probability` — 0 for
 * everything except severity, so the gate reaches a decision instead of the
 * undecided path.
 */
const answering = (probability: number): JevProvider => ({
  id: 'fixed',
  answer: async (): Promise<JevResult> => ({
    model: 'm',
    provider: 'fixed',
    latencyMs: 1,
    answers: {
      severity: { type: 'score', score: 0, legend: {}, probabilities: { '0': 1 } },
      ...Object.fromEntries(
        ['is_relevant', 'adds_information'].map((id) => [id, { type: 'noul', noul: probability }]),
      ),
    },
  }),
})

describe('the safety gate carries the egress facts', () => {
  /** A tool call whose state is comfortably over `gate:safety`'s 8,000-char cap. */
  const hugeCall = () => ({ name: 'pwsh', args: { command: 'x'.repeat(30_000) } })

  it('marks a decision made from a capped state as truncated', async () => {
    const egress = contract()
    const gate = createSafetyGate({
      service: new JevService({ provider: answering(0), egress }),
      onUndecided: 'ask',
    })

    const decision = await gate(hugeCall())

    // `truncated` is the field the verifier found missing: the gate judged a
    // `[truncated]` envelope and said so nowhere.
    expect(decision.truncated).toBe(true)
    expect(egress.last?.truncated).toBe(true)
    // The counts are this payload's, not a re-measurement: same numbers, and the
    // arrays are copies rather than the measurement's own.
    expect(decision.egress?.stateChars).toBe(egress.last?.stateChars)
    expect(decision.egress?.truncated).toBe(true)
    expect(decision.egress?.redactedFields).toEqual(egress.last?.redactedFields)
    expect(decision.egress?.redactionRules).not.toBe(egress.last?.redactionRules)
  })

  it('carries the redaction facts, not only the cap', async () => {
    const gate = createSafetyGate({
      service: new JevService({ provider: answering(0), egress: contract() }),
      onUndecided: 'ask',
    })

    const decision = await gate({ name: 'pwsh', args: { password: 'hunter2-correct-horse' } })

    // The arguments are serialized into `state`, so the credential is a keyed
    // field there and the decision says a field was replaced.
    expect(decision.egress?.redactedFields).toContain('password')
    expect(decision.egress?.redactionRules).toContain('key-name')
    expect(decision.truncated).toBeUndefined()
  })

  it('still says nothing for a call it does not judge', async () => {
    // The other half of the contract: an `allow` for an uncovered tool, and an
    // `allow` while egress is switched off, have no measurement behind them, and
    // an empty `egress` object would claim one.
    const off = new EgressContract(
      { transmitting: false, enabled: { ...allOn(), [SAFETY_FEATURE]: false } },
      'none',
    )
    const gate = createSafetyGate({
      service: new JevService({ provider: answering(0), egress: off }),
      onUndecided: 'ask',
    })

    const uncovered = await gate({ name: 'totally_unrelated_tool', args: {} })
    const disabled = await gate({ name: 'pwsh', args: {} })

    expect(uncovered).toEqual({ kind: 'allow' })
    expect(disabled).toEqual({ kind: 'allow' })
  })
})

describe('the context gate carries the egress facts', () => {
  /** A result large enough to be judged, carrying a credential shape in free text. */
  const bigResult = (extra: string) => [
    { type: 'text', text: `${'lorem ipsum '.repeat(400)}token ghp_${'a'.repeat(20)} ${extra}` },
  ]

  const gate = (probability: number) =>
    createContextGate({
      service: new JevService({ provider: answering(probability), egress: contract() }),
      describeGoal: () => 'find the thing',
    })

  it('marks a decision made from a capped state as truncated, on the keep path', async () => {
    // `block: false` is the decision a caller is least likely to question, and the
    // one where a capped state matters most: the gate read a fragment and decided
    // to keep the result anyway.
    const decision = await gate(1)({ toolName: 'read', content: bigResult('more') })

    expect(decision.block).toBe(false)
    expect(decision.truncated).toBe(true)
    expect(decision.egress?.truncated).toBe(true)
    expect(decision.egress?.redactionRules).toContain('github-token')
    expect(decision.egress?.redactedValues).toBe(1)
  })

  it('marks a blocking decision too', async () => {
    // A confident "not relevant" blocks, and the caller reading the feedback has
    // the same reason to know the judge saw a fragment.
    const decision = await gate(0)({ toolName: 'read', content: bigResult('more') })

    expect(decision.block).toBe(true)
    expect(decision.truncated).toBe(true)
    expect(decision.egress?.stateChars).toBeGreaterThan(0)
  })

  it('says nothing when it never judged, rather than implying a clean payload', async () => {
    // Below `minChars` there is no call at all. An absent field is the honest
    // answer; an empty object would read as "measured, nothing to report".
    const decision = await gate(1)({ toolName: 'read', content: [{ type: 'text', text: 'short' }] })

    expect(decision).toEqual({ block: false })
  })
})

describe('the facts survive a service that measured them', () => {
  it('agrees with the measured payload the contract produced', async () => {
    const egress = contract()
    const gate = createSafetyGate({
      service: new JevService({ provider: answering(0), egress }),
      onUndecided: 'allow',
    })

    await gate({ name: 'pwsh', args: { command: 'x'.repeat(30_000), apiKey: 'sk-live-abcdef0123456789' } })

    const measured = egress.last
    expect(measured).toBeDefined()
    if (measured === undefined) return
    // The same numbers the contract computed, which is the whole claim of carrying
    // them: the decision describes the payload that left, not a re-derivation.
    const decision = await gate({ name: 'pwsh', args: { command: 'x'.repeat(30_000), apiKey: 'sk-live-abcdef0123456789' } })
    expect(decision.egress?.stateChars).toBe(measured.stateChars)
    expect(decision.egress?.redactions).toBe(measured.redactions)
    expect(measured.redactions).toBeGreaterThan(0)
    expect(noul('a question the gate never asks')).toBeDefined()
  })
})
