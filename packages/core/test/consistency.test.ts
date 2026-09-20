import { describe, expect, it } from 'vitest'
import { runRepeated } from '../src/consistency.js'
import { EGRESS_FEATURES, EgressContract, type EgressFeature } from '../src/egress.js'
import { choice, noul, score } from '../src/primitives.js'
import { MockProvider } from '../src/provider/mock.js'
import { JevService } from '../src/service.js'
import type { JevProvider, JevResult } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<
    EgressFeature,
    boolean
  >

const liveContract = () =>
  new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai')

const service = (provider: JevProvider = new MockProvider()) =>
  new JevService({ provider, egress: liveContract() })

const questions = { urgent: noul('urgent?') }

type Scripted = {
  readonly provider: JevProvider
  readonly calls: () => number
}

/**
 * A provider whose answers are scripted, so a test can produce the exact spread
 * it asserts on. A hash-based mock cannot: it is deterministic by design, so it
 * can prove agreement but never disagreement.
 */
const scripted = (values: readonly (number | Error)[]): Scripted => {
  let call = 0
  return {
    provider: {
      id: 'scripted',
      answer: async (): Promise<JevResult> => {
        const value = values[call]
        call += 1
        if (value === undefined) throw new Error('the script ran out of entries')
        if (value instanceof Error) throw value
        return {
          model: 'scripted',
          provider: 'scripted',
          latencyMs: 1,
          answers: { urgent: { type: 'noul', noul: value } },
        }
      },
    },
    calls: () => call,
  }
}

describe('runRepeated against the offline mock', () => {
  it('agrees perfectly, because a deterministic provider cannot disagree', async () => {
    const run = await runRepeated(
      service(),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 5 },
    )
    expect(run.repeats).toBe(5)
    expect(run.completed).toBe(5)
    expect(run.failed).toBe(0)
    const [urgent] = run.questions
    expect(urgent?.questionId).toBe('urgent')
    expect(urgent?.values).toHaveLength(5)
    expect(urgent?.answered).toBe(5)
    expect(urgent?.unanswered).toBe(0)
    expect(urgent?.spread).toBe(0)
    expect(urgent?.agreed).toBe(true)
  })

  it('reports the mean of the observed values', async () => {
    const run = await runRepeated(
      service(),
      { feature: 'tool:jev_ask', state: { a: 1 }, questions },
      { repeats: 3 },
    )
    const [urgent] = run.questions
    expect(urgent?.mean).toBe(urgent?.values[0])
  })

  it('can be driven by a bare provider, with no service and no egress contract', async () => {
    // The offline-testability requirement: MockProvider, and no service at all.
    const run = await runRepeated(
      new MockProvider(),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 3 },
    )
    expect(run.completed).toBe(3)
    expect(run.questions[0]?.agreed).toBe(true)
  })
})

describe('runRepeated against controlled variation', () => {
  it('reports the spread of disagreeing answers', async () => {
    const { provider } = scripted([0.4, 0.9, 0.65])
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 3 },
    )
    const [urgent] = run.questions
    expect(urgent?.values).toEqual([0.4, 0.9, 0.65])
    expect(urgent?.spread).toBeCloseTo(0.5)
    expect(urgent?.agreed).toBe(false)
    expect(urgent?.mean).toBeCloseTo(0.65)
  })

  it('keeps observations in repeat order, one per repeat', async () => {
    const { provider } = scripted([0.1, 0.2, 0.3])
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 3 },
    )
    expect(run.questions[0]?.observations.map((entry) => entry.repeat)).toEqual([1, 2, 3])
    expect(run.questions[0]?.observations.map((entry) => entry.value)).toEqual([0.1, 0.2, 0.3])
  })

  it('does not abort the run when one repeat fails', async () => {
    const { provider, calls } = scripted([0.5, new Error('one bad repeat'), 0.5])
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 3 },
    )
    // The repeat after the failure still ran: evidence already paid for is not
    // thrown away because one call went wrong.
    expect(calls()).toBe(3)
    expect(run.failed).toBe(1)
    expect(run.completed).toBe(2)
    const [urgent] = run.questions
    expect(urgent?.failed).toBe(1)
    expect(urgent?.answered).toBe(2)
    expect(urgent?.spread).toBe(0)
    // A failed repeat is not agreement: two of three answered, so the run as a
    // whole did not repeat itself.
    expect(urgent?.agreed).toBe(false)
    expect(urgent?.observations[1]?.error).toContain('one bad repeat')
  })

  it('truncates a failure message so a report cannot carry a payload', async () => {
    const { provider } = scripted([new Error('x'.repeat(2_000))])
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 1 },
    )
    expect(run.questions[0]?.observations[0]?.error).toHaveLength(300)
  })

  it('counts an unanswered question separately from a failed repeat', async () => {
    // A provider that returns a result carrying no answer for the id asked. The
    // live route does this deliberately — an answer it cannot normalize is dropped
    // rather than coerced (provider/live.ts) — so this is reachable in production
    // and must not be reported as a failure.
    const provider: JevProvider = {
      id: 'silent',
      answer: async () => ({ model: 'silent', provider: 'silent', latencyMs: 1, answers: {} }),
    }
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 2 },
    )
    const [urgent] = run.questions
    expect(run.failed).toBe(0)
    expect(urgent?.answered).toBe(0)
    expect(urgent?.unanswered).toBe(2)
    expect(urgent?.agreed).toBe(false)
    expect(urgent?.spread).toBe(0)
    expect(urgent?.mean).toBeUndefined()
  })

  it('agrees on a stable choice by label, and reports its probabilities separately', async () => {
    const choiceQuestions = { team: choice('team?', { a: null, b: null }) }
    // Same label every time, different probabilities underneath it.
    const script: readonly Record<string, number>[] = [
      { a: 0.9, b: 0.1 },
      { a: 0.6, b: 0.4 },
      { a: 0.7, b: 0.3 },
    ]
    let call = 0
    const provider: JevProvider = {
      id: 'varying',
      answer: async () => {
        const probabilities = script[call] ?? { a: 0.7, b: 0.3 }
        call += 1
        return {
          model: 'varying',
          provider: 'varying',
          latencyMs: 1,
          answers: { team: { type: 'choice', choice: 'a', probabilities } },
        }
      },
    }
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions: choiceQuestions },
      { repeats: 3 },
    )
    const [team] = run.questions
    // The decision held, so the answers agreed...
    expect(team?.agreed).toBe(true)
    expect(team?.labels).toEqual(['a', 'a', 'a'])
    // ...while the distribution moved, which `spread` reports rather than hiding
    // behind the single `agreed` flag.
    expect(team?.spread).toBeCloseTo(0.3)
  })

  it('disagrees when a choice flips label', async () => {
    let call = 0
    const provider: JevProvider = {
      id: 'flip',
      answer: async () => {
        call += 1
        const label = call === 1 ? 'a' : 'b'
        return {
          model: 'flip',
          provider: 'flip',
          latencyMs: 1,
          answers: { team: { type: 'choice', choice: label, probabilities: { a: 0.5, b: 0.5 } } },
        }
      },
    }
    const run = await runRepeated(
      service(provider),
      {
        feature: 'tool:jev_ask',
        state: 'x',
        questions: { team: choice('team?', { a: null, b: null }) },
      },
      { repeats: 2 },
    )
    expect(run.questions[0]?.agreed).toBe(false)
    expect(run.questions[0]?.labels).toEqual(['a', 'b'])
    // Identical probabilities, so the numeric spread is 0 while the answers
    // differ: this is why agreement is checked on the label for a choice.
    expect(run.questions[0]?.spread).toBe(0)
  })

  it('reports a score question on its own scale', async () => {
    const scoreQuestions = {
      severity: score('how bad?', { mild: 'a mild issue', moderate: 'moderate', severe: 'severe' }),
    }
    let call = 0
    const provider: JevProvider = {
      id: 'scoring',
      answer: async () => {
        call += 1
        return {
          model: 'scoring',
          provider: 'scoring',
          latencyMs: 1,
          answers: {
            severity: {
              type: 'score',
              score: call,
              legend: { '0': 'mild', '1': 'moderate', '2': 'severe' },
              probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
            },
          },
        }
      },
    }
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions: scoreQuestions },
      { repeats: 2 },
    )
    expect(run.questions[0]?.values).toEqual([1, 2])
    expect(run.questions[0]?.spread).toBe(1)
    expect(run.questions[0]?.agreed).toBe(false)
  })

  it('keeps questions separate, in declaration order', async () => {
    const twoQuestions = { first: noul('a?'), second: noul('b?') }
    const provider: JevProvider = {
      id: 'two',
      answer: async () => ({
        model: 'two',
        provider: 'two',
        latencyMs: 1,
        answers: {
          first: { type: 'noul', noul: 0.2 },
          second: { type: 'noul', noul: 0.8 },
        },
      }),
    }
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions: twoQuestions },
      { repeats: 2 },
    )
    expect(run.questions.map((question) => question.questionId)).toEqual(['first', 'second'])
    expect(run.questions.map((question) => question.mean)).toEqual([0.2, 0.8])
  })

  it('ignores an answer nobody asked for', async () => {
    const provider: JevProvider = {
      id: 'extra',
      answer: async () => ({
        model: 'extra',
        provider: 'extra',
        latencyMs: 1,
        answers: {
          urgent: { type: 'noul', noul: 0.5 },
          unasked: { type: 'noul', noul: 0.9 },
        },
      }),
    }
    const run = await runRepeated(
      service(provider),
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 1 },
    )
    expect(run.questions.map((question) => question.questionId)).toEqual(['urgent'])
  })
})

describe('runRepeated refuses what it cannot measure honestly', () => {
  it('rejects a repeat count that is not a positive integer', async () => {
    const input = { feature: 'tool:jev_ask' as const, state: 'x', questions }
    for (const repeats of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runRepeated(service(), input, { repeats })).rejects.toThrow(RangeError)
    }
  })

  it('spends no call when it refuses', async () => {
    const { provider, calls } = scripted([0.5])
    const svc = service(provider)
    await runRepeated(
      svc,
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 0 },
    ).catch(() => undefined)
    // The refusal is about authorisation, not arithmetic: rounding 0 up to 1
    // would transmit a call the caller never asked for.
    expect(calls()).toBe(0)
    expect(svc.stats().transmitted).toBe(0)
  })

  it('records one call per repeat, through the service', async () => {
    const svc = service()
    await runRepeated(svc, { feature: 'tool:jev_ask', state: 'x', questions }, { repeats: 4 })
    expect(svc.stats().calls).toBe(4)
    expect(svc.recent()).toHaveLength(4)
  })

  it('surfaces an egress denial as failed repeats rather than inventing agreement', async () => {
    // The shipped offline default denies every feature, so nothing may leave.
    const svc = new JevService({
      provider: new MockProvider(),
      egress: new EgressContract(
        { transmitting: false, enabled: {} as Record<EgressFeature, boolean> },
        'none',
      ),
    })
    const run = await runRepeated(
      svc,
      { feature: 'tool:jev_ask', state: 'x', questions },
      { repeats: 2 },
    )
    expect(run.failed).toBe(2)
    expect(run.completed).toBe(0)
    expect(run.questions[0]?.agreed).toBe(false)
    // The reason the call never left is carried through as the repeat's failure,
    // rather than being flattened into a generic error.
    expect(run.questions[0]?.observations[0]?.error).toContain('is not enabled')
    expect(svc.stats().transmitted).toBe(0)
  })
})
