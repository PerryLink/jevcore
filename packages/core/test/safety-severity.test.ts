/**
 * The severity dimension of the safety gate.
 *
 * The hazards are yes/no, so "delete one scratch file" and "drop the production
 * database" both arrive as a plain `true` and the gate cannot tell them apart.
 * The score question and its block level are what separate them.
 *
 * Three properties are the point, and each is asserted rather than described:
 *
 *  - **It never loosens.** The old hazard-only decision is transcribed below and
 *    run over the same fixtures, so a configuration in which the new gate allows
 *    something the old one asked about is a failure rather than a review note.
 *  - **An unreadable severity is undecided, never `none`.** Including a score
 *    index the gate never declared, a legend that disagrees with the rubric, and
 *    an answer of the wrong type. A gate that allows on uncertainty is not a
 *    gate.
 *  - **Only the declared ladder is trusted.** The level is read by position;
 *    nothing the provider puts in `legend` can choose it.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAFETY_SEVERITY_BLOCK,
  SEVERITY_LEVELS,
  type SeverityLevel,
} from '../src/config.js'
import { EGRESS_FEATURES, EgressContract, type EgressFeature } from '../src/egress.js'
import {
  createSafetyGate,
  HAZARD_QUESTIONS,
  SAFETY_QUESTIONS,
  SEVERITY_QUESTION_ID,
  SEVERITY_QUESTIONS,
  type GateDecision,
  type SafetyGateOptions,
} from '../src/gates/safety.js'
import { DEFAULT_POLICY, applyPolicy } from '../src/policy.js'
import { redact } from '../src/redact.js'
import { JevService } from '../src/service.js'
import {
  JevProviderError,
  type JevAnswer,
  type JevProvider,
  type JevQuestion,
  type JsonValue,
} from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const service = (provider: JevProvider) =>
  new JevService({
    provider,
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
  })

/**
 * A score answer naming one rung of the declared ladder.
 *
 * The legend is built from the declared rubric so a fixture cannot quietly use a
 * scale the gate does not send, and `probabilities` is a point mass on the named
 * rung, which is what makes the answer `decided` under the default floors.
 */
const severityAnswer = (level: SeverityLevel, confidence = 0.9): JevAnswer => {
  const index = SEVERITY_LEVELS.indexOf(level)
  const question = SEVERITY_QUESTIONS[SEVERITY_QUESTION_ID]
  const criteria = question?.type === 'score' ? question.criteria : []
  return {
    type: 'score',
    score: index,
    legend: Object.fromEntries(criteria.map((description, i) => [String(i), description])),
    probabilities: { [String(index)]: 0.95 },
    confidence,
  }
}

/**
 * A provider answering every hazard at `noul` and the severity question with
 * `severity` — or with nothing at all, when that is what the test is about.
 */
const providerWith = (noul: number, severity: JevAnswer | undefined): JevProvider => ({
  id: 'fixed',
  answer: async () => ({
    model: 'm',
    provider: 'fixed',
    latencyMs: 1,
    answers: {
      ...Object.fromEntries(
        Object.keys(HAZARD_QUESTIONS).map((key) => [key, { type: 'noul', noul } as JevAnswer]),
      ),
      ...(severity === undefined ? {} : { [SEVERITY_QUESTION_ID]: severity }),
    },
  }),
})

/** A provider that answers the hazards at `noul` and the severity at `level`. */
const atSeverity = (level: SeverityLevel | undefined, noul = 0.01): JevProvider =>
  providerWith(noul, level === undefined ? undefined : severityAnswer(level))

const gate = (
  provider: JevProvider,
  options: Partial<
    Pick<SafetyGateOptions, 'onUndecided' | 'severityBlock' | 'minConfidence' | 'minProbability'>
  > = {},
) =>
  createSafetyGate({
    service: service(provider),
    onUndecided: options.onUndecided ?? 'ask',
    ...(options.severityBlock === undefined ? {} : { severityBlock: options.severityBlock }),
    ...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
    ...(options.minProbability === undefined ? {} : { minProbability: options.minProbability }),
  })

/** One gated call, so the fixtures below read as what they are. */
const judge = (provider: JevProvider, options?: Parameters<typeof gate>[1]) =>
  gate(provider, options)({ name: 'pwsh', args: { command: 'rm -rf build' } })

describe('a damaging call is asked about on severity alone', () => {
  it('escalates with no hazard above its floor', async () => {
    const decision = await judge(atSeverity('critical'))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBe('critical')
    // Nothing was raised: the severity is the whole reason for the question.
    expect(decision.raised).toBeUndefined()
  })

  it('treats the block level itself as over the line', async () => {
    // The cookbook's comparison is `severity >= severity_block`, so the rung the
    // operator named is asked about rather than one above it.
    const decision = await judge(atSeverity(DEFAULT_SAFETY_SEVERITY_BLOCK))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBe(DEFAULT_SAFETY_SEVERITY_BLOCK)
  })

  it('does not escalate a rung below the block level', async () => {
    const decision = await judge(atSeverity('moderate'))
    expect(decision.kind).toBe('allow')
    // Reported even when it allows: the level is what Jev said, not a verdict.
    expect(decision.severity).toBe('moderate')
  })

  it('cannot talk the gate out of a hazard that crossed its floor', async () => {
    const decision = await judge(atSeverity('none', 0.99))
    expect(decision.kind).toBe('ask')
    expect(decision.raised?.length).toBeGreaterThan(0)
    expect(decision.severity).toBe('none')
  })

  it('escalates where onUndecided alone would have allowed', async () => {
    // Hazards sit at 0.5, which is undecided, and the operator's fail-open says
    // to allow that. A decided severity at the block level still stops the call:
    // fail-open is about questions the gate could not decide.
    const decision = await judge(atSeverity('critical', 0.5), { onUndecided: 'allow' })
    expect(decision.kind).toBe('ask')
  })

  it('follows the configured block level rather than the shipped one', async () => {
    expect(DEFAULT_SAFETY_SEVERITY_BLOCK).toBe('high')
    expect((await judge(atSeverity('high'), { severityBlock: 'critical' })).kind).toBe('allow')
    expect((await judge(atSeverity('critical'), { severityBlock: 'critical' })).kind).toBe('ask')
  })

  it('cannot be configured off, only made stricter or looser within the ladder', async () => {
    // The lowest rung is the strictest setting: every resolved level is at or
    // above it. There is deliberately no value that disables the dimension.
    expect((await judge(atSeverity('none'), { severityBlock: 'none' })).kind).toBe('ask')
  })

  it('names the severity and the block level in the reason', async () => {
    const decision = await judge(atSeverity('critical'))
    expect(decision.reason).toContain('critical')
    expect(decision.reason).toContain(DEFAULT_SAFETY_SEVERITY_BLOCK)
    expect(decision.reason).toContain('safety gate')
  })

  it('never tells the operator to approve something the host may refuse', async () => {
    // A host with no approval service turns `ask` into a denial and keeps this
    // reason, so an instruction here would be attached to a call nobody can
    // approve. The reason states facts in both deployments instead.
    const stopped = [
      await judge(atSeverity('critical')),
      await judge(atSeverity('none', 0.99)),
      await judge(atSeverity(undefined)),
    ]
    for (const decision of stopped) {
      expect(decision.kind).toBe('ask')
      expect(decision.reason ?? '').not.toMatch(/approve|confirm|click|yes to/i)
    }
  })
})

describe('an unreadable severity is undecided, never none', () => {
  it('asks when the severity question is not answered at all', async () => {
    const decision = await judge(atSeverity(undefined))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBeUndefined()
    expect(decision.reason).toContain(SEVERITY_QUESTION_ID)
  })

  it('routes an unanswered severity through onUndecided like any other question', async () => {
    expect((await judge(atSeverity(undefined), { onUndecided: 'deny' })).kind).toBe('deny')
    expect((await judge(atSeverity(undefined), { onUndecided: 'ask' })).kind).toBe('ask')
    // The operator's own fail-open, unchanged — and it still never invents a
    // level: the decision carries no severity to read.
    const failedOpen = await judge(atSeverity(undefined), { onUndecided: 'allow' })
    expect(failedOpen.kind).toBe('allow')
    expect(failedOpen.severity).toBeUndefined()
  })

  it('refuses a rubric index the gate never declared', async () => {
    const outOfLadder: JevAnswer = {
      type: 'score',
      score: 9,
      legend: { '9': 'a rung this gate did not send' },
      probabilities: { '9': 0.99 },
      confidence: 0.95,
    }
    const decision = await judge(providerWith(0.01, outOfLadder))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBeUndefined()
  })

  it('reads an answer by position, not by the legend text it echoed', async () => {
    // The provider returns the *critical* description at index 0. Text matching
    // would read that as critical and stop an ordinary call; position reads it
    // as what index 0 is, which is `none`.
    const question = SEVERITY_QUESTIONS[SEVERITY_QUESTION_ID]
    if (question?.type !== 'score') throw new Error('the severity question must be a score')
    const criticalDescription = question.criteria[SEVERITY_LEVELS.length - 1]
    if (criticalDescription === undefined) throw new Error('the ladder needs a critical rung')
    const echoed: JevAnswer = {
      type: 'score',
      score: 0,
      legend: { '0': criticalDescription },
      probabilities: { '0': 0.99 },
      confidence: 0.95,
    }
    const decision = await judge(providerWith(0.01, echoed))
    expect(decision.kind).toBe('allow')
    expect(decision.severity).toBe('none')
  })

  it('will not read an answer of the wrong type as a level', async () => {
    const decision = await judge(providerWith(0.01, { type: 'noul', noul: 0.97 }))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBeUndefined()
  })

  it('applies the operator confidence floor to the severity answer too', async () => {
    // 0.2 is below the default floor, so the level is not acted on — and an
    // unacted level is asked about, not treated as harmless.
    const decision = await judge(providerWith(0.01, severityAnswer('critical', 0.2)))
    expect(decision.kind).toBe('ask')
    expect(decision.severity).toBeUndefined()

    const trusted = await judge(providerWith(0.01, severityAnswer('critical', 0.9)))
    expect(trusted.severity).toBe('critical')
  })

  it('declares a severity question that survives the egress redaction pass', () => {
    // Redaction walks the whole question map and matches *keys* against the
    // secret-name rules, so a question id can be mistaken for a secret-bearing
    // field. `severity` must come out the other side as a question object, or
    // Jev is sent a string where an ordered rubric should be.
    //
    // Asserted rather than assumed because a sibling declaration does not
    // survive that pass today: `credential_exposure` matches the `/credential/i`
    // key rule and its value is replaced with `[redacted]` before transmission.
    // That is a defect in the redaction pass, not in this declaration, and it is
    // reported rather than worked around here.
    const redacted = redact(SAFETY_QUESTIONS as unknown as JsonValue)
    const questions = redacted.value as unknown as Record<string, JevQuestion>
    const question = questions[SEVERITY_QUESTION_ID]
    expect(question?.type).toBe('score')
    expect(JSON.stringify(question)).not.toContain('[redacted]')
  })

  it('keeps the provider-failure path exactly as it was', async () => {
    const failing: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('down', 'upstream-unreachable')
      },
    }
    const asked = await judge(failing)
    expect(asked.kind).toBe('ask')
    expect(asked.reason).toContain('upstream-unreachable')
    expect(asked.severity).toBeUndefined()
    expect((await judge(failing, { onUndecided: 'deny' })).kind).toBe('deny')
  })
})

describe('severity never loosens the gate', () => {
  /**
   * The decision this gate made before the severity dimension existed.
   *
   * A transcription of the implementation it replaced — raised hazards ask,
   * then `onUndecided`, then allow — kept here because the property under check
   * is about the old behaviour, and production code must not carry a second
   * decision path for a test to compare against.
   */
  const hazardOnly = (
    noul: number,
    onUndecided: 'ask' | 'allow' | 'deny',
  ): GateDecision['kind'] => {
    const verdicts = Object.keys(HAZARD_QUESTIONS).map(() =>
      applyPolicy({ type: 'noul', noul }, ['true', 'false'], DEFAULT_POLICY),
    )
    if (verdicts.some((verdict) => verdict.kind === 'decided' && verdict.answer === 'true')) {
      return 'ask'
    }
    if (verdicts.some((verdict) => verdict.kind !== 'decided')) return onUndecided
    return 'allow'
  }

  /** Rungs strictly below the shipped block level, written out rather than computed. */
  const BELOW_DEFAULT_BLOCK: readonly SeverityLevel[] = ['none', 'low', 'moderate']

  it('never allows what the hazard-only gate would have asked about', async () => {
    // The matrix is written against this default; if it moves, the expectations
    // below are the thing that should fail first.
    expect(DEFAULT_SAFETY_SEVERITY_BLOCK).toBe('high')

    // Every shape the two dimensions can take together: no hazard above its
    // floor, a hazard raised, a hazard undecided — crossed with a severity below
    // the block, at or above it, and unreadable.
    const levels: readonly (SeverityLevel | undefined)[] = [...SEVERITY_LEVELS, undefined]
    const loosened: string[] = []
    let newlyAsked = 0

    for (const noul of [0.01, 0.5, 0.99]) {
      for (const level of levels) {
        for (const onUndecided of ['ask', 'allow', 'deny'] as const) {
          const decision = await judge(atSeverity(level, noul), { onUndecided })
          const before = hazardOnly(noul, onUndecided)
          const label = `noul=${noul} severity=${String(level)} onUndecided=${onUndecided}`

          if (before === 'ask' && decision.kind === 'allow') loosened.push(label)
          if (before !== 'ask' && decision.kind === 'ask') newlyAsked += 1

          if (level !== undefined && BELOW_DEFAULT_BLOCK.includes(level)) {
            // Below the line the dimension changes nothing at all, which is what
            // makes the transcription above checkable rather than merely
            // plausible.
            expect(decision.kind, label).toBe(before)
            continue
          }
          if (level === undefined) {
            // Undecided severity joins the undecided path: it can never allow
            // where the old gate asked, and it cannot invent a level.
            expect(decision.severity, label).toBeUndefined()
            continue
          }
          // At or above the line the call is asked about, whatever the hazards
          // said and whatever `onUndecided` says — including under the fail-open
          // setting, where the old gate would have allowed.
          expect(decision.kind, label).toBe('ask')
          expect(decision.severity, label).toBe(level)
        }
      }
    }

    expect(loosened).toEqual([])
    // Not vacuous: the matrix contains calls the old gate allowed and this one
    // asks about, which is the whole reason the dimension exists.
    expect(newlyAsked).toBeGreaterThan(0)
  })
})
