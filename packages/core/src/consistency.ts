/**
 * Self-consistency: ask the same state N times and look at the spread.
 *
 * This is the "does the answer repeat?" check, lifted out of the loop
 * `scripts/probe-live.mjs` runs by hand. It is a diagnostic, not a gate, and that
 * distinction is the reason the file exists in this shape:
 *
 *  - A **small spread does prove self-consistency.** The provider returned the
 *    same judgment for the same input, so the number describes the state rather
 *    than the draw.
 *  - A small spread does **not** prove calibration, and must never be reported as
 *    accuracy. A model that answers 0.91 every single time has a spread of exactly
 *    0 and is perfectly self-consistent while being wrong about every item it is
 *    wrong about. Repeatability is necessary for a probability to mean anything,
 *    and nowhere near sufficient for it to mean the right thing. Nothing here
 *    compares an answer to ground truth, because nothing here has any.
 *
 * The repeats are sequential and the requests identical, deliberately: those are
 * the only conditions under which the observations are comparable, and a run that
 * varied either one would be measuring the variation it introduced.
 */

import type { JevAskInput, JevService } from './service.js'
import type { JevAnswer, JevProvider, JevRequest, JevResult } from './types.js'

/**
 * What to ask: a {@link JevService} (preferred) or a bare {@link JevProvider}.
 *
 * Both are accepted because the two callers this exists for differ. A service is
 * the honest route — it applies the egress contract and writes a call record, so a
 * consistency run is subject to the same permission check as every other
 * transmission. A provider is accepted for the offline case, where `MockProvider`
 * makes the whole helper testable with no credential and no socket, and for the
 * out-of-band live probe, which deliberately talks to the vendor outside the
 * service.
 *
 * **Passing a provider bypasses the egress contract and the call record.** There
 * is no service in the path to apply them, and `feature` on the input is then not
 * consulted at all. That is a real difference in what leaves the machine, not a
 * detail of plumbing.
 */
export type RepeatedSource = JevService | JevProvider

/** How many times to ask. */
export type RepeatedRunOptions = {
  /**
   * Number of repeats: a positive integer.
   *
   * Refused rather than rounded when it is not one — see {@link runRepeated}. One
   * repeat is legal and reports a spread of 0, which is vacuous rather than
   * reassuring; see {@link RepeatedQuestion.agreed}.
   */
  readonly repeats: number
}

/**
 * One repeat's answer to one question.
 *
 * `value` is the answer's own headline number: `noul` for a noul, `score` for a
 * score, and the probability of the winning option for a choice. Those are not the
 * same quantity — a probability and a rubric score — so a `spread` is only
 * comparable between questions of the same type, and this helper never pools
 * questions of different types together.
 *
 * A repeat that failed carries `error` and nothing else. A repeat that succeeded
 * but returned no answer for this question carries neither, which is a third
 * state and is counted as one: a provider that silently drops a question it could
 * not normalize is exactly the failure this shape is built to keep visible.
 */
export type RepeatedObservation = {
  /** 1-based repeat index, in the order the calls were made. */
  readonly repeat: number
  /** The answer's type, absent when this repeat produced no answer for this id. */
  readonly type?: JevAnswer['type']
  /** The headline number, absent for a choice whose winning option had no probability. */
  readonly value?: number
  /** The chosen option, for choice answers only. */
  readonly label?: string
  /** Failure message, truncated to 300 characters. See {@link runRepeated}. */
  readonly error?: string
}

/**
 * What N repeats did for one question.
 *
 * `agreed` is agreement on the axis the answer type actually has: the chosen label
 * for a choice, the number for a noul or a score. It is therefore *not* a claim
 * that a choice's whole distribution repeated — the labels can hold steady while
 * the probabilities underneath them move, and `spread` is what reports that.
 */
export type RepeatedQuestion = {
  readonly questionId: string
  /** One entry per repeat, in repeat order. */
  readonly observations: readonly RepeatedObservation[]
  /** The headline numbers observed, in repeat order. */
  readonly values: readonly number[]
  /** The chosen labels observed, in repeat order. Empty for non-choice questions. */
  readonly labels: readonly string[]
  /** Repeats that returned an answer carrying a headline number. */
  readonly answered: number
  /** Repeats that completed but returned no answer for this id. */
  readonly unanswered: number
  /** Repeats whose call threw. */
  readonly failed: number
  /** Mean of {@link RepeatedQuestion.values}, or absent when none was observed. */
  readonly mean?: number
  /**
   * `max - min` over {@link RepeatedQuestion.values}, and `0` when fewer than two
   * were observed.
   *
   * A `0` from a single repeat means "no disagreement was observed", which is not
   * the same as "no disagreement exists" — one repeat cannot disagree with itself.
   */
  readonly spread: number
  /**
   * True when every repeat answered and every answer was identical on its type's
   * axis.
   *
   * Exact equality, with no tolerance on purpose: a helper that quietly applied an
   * epsilon would report agreement for a run that never repeated itself, and the
   * caller could not tell which threshold it had used.
   *
   * Vacuous when only one repeat ran. Read {@link RepeatedRun.repeats} alongside
   * it: a run that never repeated anything says nothing about repeatability.
   */
  readonly agreed: boolean
}

/** One consistency run: the repeats that were made, and what each question did. */
export type RepeatedRun = {
  /** The number of repeats actually run. */
  readonly repeats: number
  /** Repeats that completed and returned a result. */
  readonly completed: number
  /** Repeats whose call threw. */
  readonly failed: number
  /** Per-question results, in the order the questions were declared. */
  readonly questions: readonly RepeatedQuestion[]
}

/**
 * True for a {@link JevService}, false for a bare provider.
 *
 * Narrowing on `ask`, not on `answer`: a service has no `answer` method of its
 * own, and a provider has no `ask`, so the two are disjoint and neither check can
 * mistake one for the other.
 */
const isService = (source: RepeatedSource): source is JevService =>
  'ask' in source && typeof source.ask === 'function'

/**
 * Perform one repeat.
 *
 * The provider path sends `state` and `questions` only. There is no model
 * override to send: on a service that lives in its options, and a bare provider
 * carries its own.
 */
const askOnce = async (source: RepeatedSource, input: JevAskInput): Promise<JevResult> => {
  if (isService(source)) return source.ask(input)
  const request: JevRequest = { state: input.state, questions: input.questions }
  return source.answer(request, input.signal)
}

/** Read one answer as a comparable observation. */
const observationOf = (repeat: number, answer: JevAnswer | undefined): RepeatedObservation => {
  if (answer === undefined) return { repeat }
  if (answer.type === 'noul') return { repeat, type: 'noul', value: answer.noul }
  if (answer.type === 'score') return { repeat, type: 'score', value: answer.score }
  const value = answer.probabilities[answer.choice]
  return value === undefined
    ? { repeat, type: 'choice', label: answer.choice }
    : { repeat, type: 'choice', label: answer.choice, value }
}

/**
 * True when two observations are the same answer, on the axis that type has.
 *
 * An unanswered observation is never the same answer as anything, including
 * another unanswered one: "both said nothing" is not agreement.
 */
const sameAnswer = (left: RepeatedObservation, right: RepeatedObservation): boolean => {
  if (left.type === undefined || right.type === undefined) return false
  if (left.type !== right.type) return false
  // For a choice the answer IS the label, so agreement is label agreement. Its
  // probabilities may still have moved; `spread` reports that separately rather
  // than letting one flag claim both.
  if (left.type === 'choice') return left.label === right.label
  return left.value === right.value
}

/** `max - min`, and `0` when there is nothing to compare. */
const spreadOf = (values: readonly number[]): number =>
  values.length < 2 ? 0 : Math.max(...values) - Math.min(...values)

/**
 * Ask the same state `repeats` times and report the spread per question.
 *
 * One provider call per repeat: this is not a batching primitive and cannot be
 * one, because a System One request carries exactly one `state`. {@link JevService.askMany}
 * is the bounded-concurrency sibling for *different* states; this one re-sends the
 * same state, which is what makes the results comparable.
 *
 * A repeat that fails does not abort the run. Its failure is recorded in that
 * repeat's observations, the other repeats still run, and the aggregate says how
 * many failed — dropping the remaining repeats would throw away the evidence
 * already paid for, and hiding the failure would let a partially-failed run read
 * as a stable one.
 *
 * @throws RangeError when `options.repeats` is not a positive integer. Refused
 * rather than rounded up or clamped, because every repeat is a provider call:
 * quietly running one the caller did not ask for is a transmission they did not
 * authorise, and quietly running none would report an empty run as agreement.
 */
export const runRepeated = async (
  source: RepeatedSource,
  input: JevAskInput,
  options: RepeatedRunOptions,
): Promise<RepeatedRun> => {
  const repeats = options.repeats
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new RangeError(
      `runRepeated needs a positive integer number of repeats, got ${repeats}. Refusing ` +
        'rather than rounding: every repeat is a provider call, and running one the caller ' +
        'did not ask for is a transmission they did not authorise.',
    )
  }

  // Seeded from the questions that were asked, so the report is about the request
  // rather than about whatever the provider happened to return: an answer for an
  // id nobody asked about is ignored, and a question the provider dropped still
  // appears with its count of unanswered repeats.
  const observed = new Map<string, RepeatedObservation[]>()
  for (const questionId of Object.keys(input.questions)) observed.set(questionId, [])

  let failed = 0
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    try {
      const result = await askOnce(source, input)
      for (const [questionId, entries] of observed) {
        entries.push(observationOf(repeat, result.answers[questionId]))
      }
    } catch (error) {
      failed += 1
      // Truncated for the same reason `JevCallRecord.error` is: a provider's
      // message is not guaranteed to be payload-free, and this one is destined
      // for a report a human reads.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      for (const entries of observed.values()) entries.push({ repeat, error: message })
    }
  }

  const questions: RepeatedQuestion[] = []
  for (const [questionId, observations] of observed) {
    const values: number[] = []
    const labels: string[] = []
    let answered = 0
    let unanswered = 0
    let questionFailed = 0
    for (const observation of observations) {
      if (observation.error !== undefined) {
        questionFailed += 1
        continue
      }
      if (observation.type === undefined) {
        unanswered += 1
        continue
      }
      answered += 1
      if (observation.value !== undefined) values.push(observation.value)
      if (observation.label !== undefined) labels.push(observation.label)
    }

    const first = observations[0]
    const mean =
      values.length === 0
        ? undefined
        : values.reduce((total, value) => total + value, 0) / values.length
    questions.push({
      questionId,
      observations,
      values,
      labels,
      answered,
      unanswered,
      failed: questionFailed,
      ...(mean === undefined ? {} : { mean }),
      spread: spreadOf(values),
      agreed:
        observations.length === repeats &&
        answered === repeats &&
        first !== undefined &&
        observations.every((observation) => sameAnswer(observation, first)),
    })
  }

  return { repeats, completed: repeats - failed, failed, questions }
}
