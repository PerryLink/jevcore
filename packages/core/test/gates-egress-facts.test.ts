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
 * The fields are carried only when there is something to say. A decision made from
 * an ordinary call keeps the shape it had before they existed, and a decision made
 * without any call at all carries nothing rather than an empty object — absence
 * means the gate never got a measurement, which is a different fact from a
 * measured payload with nothing to report.
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FEATURES,
  EgressContract,
  type EgressFeature,
  type MeasuredPayload,
} from '../src/egress.js'
import { CONTEXT_QUESTIONS, createContextGate } from '../src/gates/context.js'
import { createSafetyGate, HAZARD_QUESTIONS, SAFETY_FEATURE } from '../src/gates/safety.js'
import { JevService } from '../src/service.js'
import type { JevAnswer, JevProvider, JevResult } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

/** A contract that keeps the payload it measured, so a test can compare. */
class RecordingContract extends EgressContract {
  last: MeasuredPayload | undefined

  override measure(input: Parameters<EgressContract['measure']>[0]): MeasuredPayload {
    const measured = super.measure(input)
    this.last = measured
    return measured
  }
}

const contract = () => new RecordingContract({ transmitting: true, enabled: allOn() }, 'https://x')

/**
 * A provider that answers every yes/no question at `probability`, and rates the
 * severity at the bottom of the ladder — so a gate reaches a decision rather than
 * the undecided path, and the decision under test is about egress and not about
 * thresholds.
 */
const answering = (probability: number): JevProvider => {
  const nouls = [...Object.keys(HAZARD_QUESTIONS), ...Object.keys(CONTEXT_QUESTIONS)]
  const answers: Record<string, JevAnswer> = {
    severity: { type: 'score', score: 0, legend: { '0': 'none' }, probabilities: { '0': 1 } },
  }
  for (const id of nouls) answers[id] = { type: 'noul', noul: probability }
  return {
    id: 'fixed',
    answer: async (): Promise<JevResult> => ({
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers,
    }),
  }
}

describe('the safety gate carries the egress facts', () => {
  /** A tool call whose serialized arguments are far over `gate:safety`'s 8,000-char cap. */
  const hugeArgs = { command: 'x'.repeat(30_000) }

  const gate = (egress: EgressContract, onUndecided: 'ask' | 'allow' = 'ask') =>
    createSafetyGate({ service: new JevService({ provider: answering(0), egress }), onUndecided })

  it('marks a decision made from a capped state as truncated', async () => {
    const egress = contract()
    const decision = await gate(egress)({ name: 'pwsh', args: hugeArgs })

    // `truncated` is the field the verifier found missing: the gate judged a
    // `[truncated]` envelope and said so nowhere.
    expect(decision.truncated).toBe(true)
    expect(egress.last?.truncated).toBe(true)
    expect(decision.egress?.truncated).toBe(true)
    // The same numbers the contract computed, which is the whole claim of carrying
    // them: the decision describes the payload that left, not a re-derivation.
    expect(decision.egress?.stateChars).toBe(egress.last?.stateChars)
    expect(decision.egress?.questionsChars).toBe(egress.last?.questionsChars)
    // Copied, so a consumer cannot edit the measurement through the decision.
    expect(decision.egress?.redactionRules).not.toBe(egress.last?.redactionRules)
  })

  it('carries the redaction facts, not only the cap', async () => {
    const egress = contract()
    const decision = await gate(egress)({
      name: 'pwsh',
      args: { command: 'deploy --token sk-live-abcdef0123456789' },
    })

    // The arguments are serialized into `state`, so a credential there is free text
    // and is caught by a value rule; `'[value]'` is how that is named, because
    // there is no field name to report.
    expect(decision.egress?.redactionRules).toContain('openai-style-key')
    expect(decision.egress?.redactedFields).toContain('[value]')
    expect(decision.egress?.redactions).toBeGreaterThan(0)
    // Not truncated, and absent rather than `false`: an ordinary call keeps the
    // shape it had before this field existed.
    expect(decision.truncated).toBeUndefined()
  })

  it('says nothing for a call it does not judge at all', async () => {
    const egress = contract()
    const judge = gate(egress)

    const uncovered = await judge({ name: 'totally_unrelated_tool', args: {} })

    expect(uncovered).toEqual({ kind: 'allow' })
    // Nothing was measured, so nothing is claimed — the point of `undefined` over
    // an empty `egress` object.
    expect('egress' in uncovered).toBe(false)
    expect('truncated' in uncovered).toBe(false)
    expect(egress.last).toBeUndefined()
  })

  it('says nothing when egress for the gate is switched off', async () => {
    const off = new EgressContract(
      { transmitting: false, enabled: { ...allOn(), [SAFETY_FEATURE]: false } },
      'none',
    )
    const decision = await gate(off)({ name: 'pwsh', args: hugeArgs })

    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('the context gate carries the egress facts', () => {
  /**
   * A result over `gate:context`'s 6,000-character state cap, carrying a token
   * shape in free text. Deliberately past the cap: the truncation is what the
   * decision has to disclose.
   */
  const bigResult = [
    { type: 'text', text: `${'lorem ipsum '.repeat(700)}saw ghp_${'a'.repeat(20)} in the log` },
  ]

  const gate = (probability: number, egress: EgressContract = contract()) =>
    createContextGate({
      service: new JevService({ provider: answering(probability), egress }),
      describeGoal: () => 'find the thing',
    })

  it('marks a decision made from a capped state as truncated, on the keep path', async () => {
    // `block: false` is the decision a caller is least likely to question, and the
    // one where a capped state matters most: the gate read a fragment and chose to
    // keep the result anyway.
    const decision = await gate(1)({ toolName: 'read', content: bigResult })

    expect(decision.block).toBe(false)
    expect(decision.truncated).toBe(true)
    expect(decision.egress?.truncated).toBe(true)
    expect(decision.egress?.redactionRules).toContain('github-token')
    expect(decision.egress?.redactedValues).toBe(1)
  })

  it('marks a blocking decision too', async () => {
    // A confident "not relevant" blocks, and the caller reading the feedback has
    // the same reason to know the judge read a fragment.
    const decision = await gate(0)({ toolName: 'read', content: bigResult })

    expect(decision.block).toBe(true)
    expect(decision.truncated).toBe(true)
    expect(decision.egress?.stateChars).toBeGreaterThan(0)
  })

  it('says nothing when it never judged, rather than implying a clean payload', async () => {
    // Below `minChars` there is no call at all, and no measurement to describe.
    const decision = await gate(1)({ toolName: 'read', content: [{ type: 'text', text: 'short' }] })

    expect(decision).toEqual({ block: false })
  })
})
