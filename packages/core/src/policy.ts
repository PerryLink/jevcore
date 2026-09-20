/**
 * Local decision policy.
 *
 * Jev returns calibrated probabilities. It does not return permission. This
 * module is where a probability becomes an action, and the split is deliberate:
 *
 *  - the thresholds are local configuration, not model output;
 *  - nothing the model can say changes them;
 *  - an answer below the confidence floor yields `undecided`, never a default
 *    allow.
 *
 * That last point is the one that matters. A gate that defaults to "allow" when
 * it is unsure is not a gate. A gate that decides from a probability it did not
 * understand is worse — it looks like one.
 */

import { topCriterion } from './primitives.js'
import { DEFAULT_NOUL_BAND } from './render.js'
import type { CategoricalAnswer, JevAnswer, JevResult, ScoreAnswer } from './types.js'

/** The outcome of applying a local policy to one Jev answer. */
export type Verdict =
  /** The answer was clear enough and crossed the threshold. */
  | { readonly kind: 'decided'; readonly answer: string; readonly probability: number }
  /** Jev answered, but not confidently enough for this threshold. */
  | { readonly kind: 'undecided'; readonly reason: 'below-confidence' | 'no-answer' }
  /** The answer selected a value outside the declared criteria. */
  | { readonly kind: 'invalid'; readonly reason: string }

export interface PolicyOptions {
  /**
   * Minimum `confidence` for an answer to be acted upon, when the answer has a
   * confidence at all.
   *
   * Note what `confidence` is: a *concentration* statistic over the answer's own
   * distribution, not a measure of whether the answer is true. The calibrated
   * quantity is `probabilities`, and calibration is measured across a group of
   * predictions rather than guaranteed for any single one. So this is a floor on
   * acting, not a trust score — and a noul, which has no confidence, is judged on
   * its probability alone.
   */
  readonly minConfidence: number
  /**
   * Minimum probability of the selected criterion. Guards the case where the
   * distribution is nearly flat.
   */
  readonly minProbability: number
  /**
   * Optional per-verdict mapping from criterion key to whether the caller
   * should act. Keys absent from the map yield `undecided`.
   */
  readonly accept?: Readonly<Record<string, boolean>>
  /**
   * Per-criterion threshold overrides, for the thing the docs are most emphatic
   * about: **"A confidence threshold is not one number. Different actions within
   * the same system should be gated at different levels depending on the
   * consequences of getting it wrong."**
   *
   * The official worked example gates two actions in one system at 0.6 and 0.85.
   * `accept` can already say *whether* a criterion is actionable, but not how sure
   * the answer must be, so the risk-scaled part of that guidance was previously
   * inexpressible: every criterion shared one floor.
   *
   * Keys are criterion values, matching `accept`. A key that is absent falls back
   * to the two floors above.
   */
  readonly thresholds?: Readonly<Record<string, ThresholdPair>>
}

/** A floor pair for one criterion. Omitted fields inherit the policy's own. */
export interface ThresholdPair {
  readonly minConfidence?: number
  readonly minProbability?: number
}

/** The floors that apply to one criterion, after any override. */
const floorsFor = (
  selected: string | undefined,
  options: PolicyOptions,
): { minConfidence: number; minProbability: number } => {
  const override = selected === undefined ? undefined : options.thresholds?.[selected]
  return {
    minConfidence: override?.minConfidence ?? options.minConfidence,
    minProbability: override?.minProbability ?? options.minProbability,
  }
}

/**
 * The band edge that acts as the default probability floor.
 *
 * Declared before {@link DEFAULT_POLICY} on purpose: a `const` read before its
 * own initializer throws, and this module is reached from `render.ts`'s importer
 * graph, so the order here is load-bearing rather than cosmetic.
 */
export const DEFAULT_MIN_PROBABILITY: number = DEFAULT_NOUL_BAND.high

/**
 * The shipped floors.
 *
 * `minProbability` is the noul band's upper edge, not a number of its own, and
 * that is the point. The two used to disagree: the band said a noul in
 * `[0.60, 0.70]` was `uncertain` while this floor said `decided`, so the same
 * probability had two readings and which one a caller got depended on whether
 * they were looking at a rendered answer or at a policy verdict. Nothing was
 * wrong with either number in isolation — they were two answers to the same
 * question, maintained in two files.
 *
 * Deriving one from the other means the band a caller reads and the floor a gate
 * enforces are the same boundary, and it keeps the direction honest: acting on a
 * noul requires the band to say `yes` (or `no`), so a `decided` verdict can
 * never contradict the `band` reported beside it.
 *
 * The band's endpoints keep their documented meaning — `0.30` and `0.70` are
 * both `uncertain`, which is why the floor is `high` rather than something just
 * below it. See {@link DEFAULT_NOUL_BAND}.
 *
 * `minConfidence` stays a literal `0.7`. It is a different quantity — a floor on
 * the confidence that choice and score answers carry, whereas the band describes
 * how to read a noul — so the two happen to agree today rather than being the
 * same number, and tying them together would suggest a relationship that does
 * not exist.
 */
export const DEFAULT_POLICY: PolicyOptions = {
  minConfidence: 0.7,
  minProbability: DEFAULT_MIN_PROBABILITY,
}

/**
 * Apply a policy to one answer.
 *
 * `criteria` is the set the caller declared. An answer naming anything else is
 * `invalid` rather than trusted — the whole promise of a typed decision model
 * is that it cannot return an undeclared value, so a violation means something
 * upstream is wrong and acting on it would be unsafe.
 */
export const applyPolicy = (
  answer: JevAnswer | undefined,
  criteria: readonly string[],
  options: PolicyOptions = DEFAULT_POLICY,
): Verdict => {
  if (answer === undefined) return { kind: 'undecided', reason: 'no-answer' }

  if (answer.type === 'noul') {
    // No confidence floor here, because a noul has no confidence to floor — see
    // `NoulAnswer`. This branch used to read one, which had two consequences that
    // pointed in opposite directions for the same configuration: on the live
    // routes the field is absent so the floor never applied, while the mock
    // attached its own `MOCK_CONFIDENCE` of 0.5, below the 0.7 default, so every
    // hazard resolved `undecided` and the safety gate could never decide at all.
    // The answer's strength is the only signal: `max(noul, 1 - noul)`. A noul is
    // also the case the per-criterion override matters most for, since a hazard is
    // keyed by its question id and a caller may well want "is this destructive?"
    // gated harder than "is this relevant?".
    const probability = answer.noul
    const key = probability >= 0.5 ? 'true' : 'false'
    const strength = Math.max(probability, 1 - probability)
    if (criteria.length > 0 && !criteria.includes(key)) {
      return { kind: 'invalid', reason: `noul resolved to "${key}", which is not a declared criterion` }
    }
    const floors = floorsFor(key, options)
    // Strictly greater, not "at least", and the difference is the whole point of
    // this line. A noul's strength is `max(noul, 1 - noul)`, and the band this
    // floor comes from calls *both* of its edges uncertain — so `strength ===
    // minProbability` is precisely the boundary value the band refuses to read as
    // a side. Accepting it here would leave one probability with two readings
    // again, at exactly the value where the two definitions meet: `noulBand(0.7)`
    // says `uncertain` while the policy would say `decided`.
    //
    // A choice or score answer keeps the inclusive comparison — it has no band,
    // so there is no second reading to contradict.
    if (strength <= floors.minProbability) {
      return { kind: 'undecided', reason: 'below-confidence' }
    }
    return { kind: 'decided', answer: key, probability: strength }
  }

  if (answer.type === 'score') {
    // A score answer's "criteria" are its rubric indices, because that is what
    // its distribution is over. An index outside the rubric it returned means
    // the answer and its own legend disagree, which is not something to act on.
    const indices = Object.keys(answer.legend)
    const declared =
      criteria.length > 0 ? criteria : indices.length > 0 ? indices : Object.keys(answer.probabilities)
    return selectFrom(answer, answer.probabilities, undefined, declared, options)
  }

  return selectFrom(answer, answer.probabilities, answer.choice, criteria, options)
}

/**
 * Resolve which key an answer selects, then judge its strength.
 *
 * The reported `choice` wins when the distribution corroborates it; otherwise
 * the argmax does. Only then is the confidence floor applied, so a weak reported
 * choice cannot mask a strong distribution.
 */
const selectFrom = (
  answer: CategoricalAnswer | ScoreAnswer,
  probabilities: Readonly<Record<string, number>>,
  reported: string | undefined,
  criteria: readonly string[],
  options: PolicyOptions,
): Verdict => {
  if (reported !== undefined && criteria.length > 0 && !criteria.includes(reported)) {
    return {
      kind: 'invalid',
      reason: `answer "${reported}" is not one of the declared criteria`,
    }
  }

  const reportedProbability = reported === undefined ? undefined : probabilities[reported]
  const selected = reportedProbability !== undefined ? reported : topCriterion(probabilities)
  if (selected === undefined) return { kind: 'undecided', reason: 'no-answer' }
  const probability = probabilities[selected] ?? reportedProbability ?? 0

  // The floors are resolved once the selected criterion is known, so a caller can
  // gate a risky action harder than a cheap one. See `PolicyOptions.thresholds`.
  const floors = floorsFor(selected, options)
  const confidence = answer.confidence
  if (confidence !== undefined && confidence < floors.minConfidence) {
    return { kind: 'undecided', reason: 'below-confidence' }
  }
  if (probability < floors.minProbability) return { kind: 'undecided', reason: 'below-confidence' }
  return { kind: 'decided', answer: selected, probability }
}

/** Convenience: apply a policy and reduce it to the tri-state a gate needs. */
export const verdictToAction = (
  verdict: Verdict,
  options: PolicyOptions = DEFAULT_POLICY,
): 'allow' | 'deny' | 'ask' => {
  if (verdict.kind === 'invalid') return 'deny'
  if (verdict.kind === 'undecided') return 'ask'
  const accepted = options.accept?.[verdict.answer]
  if (accepted === undefined) return 'ask'
  return accepted ? 'allow' : 'deny'
}

/** Read one answer out of a result, or `undefined` when it is absent. */
export const answerOf = (result: JevResult, questionId: string): JevAnswer | undefined =>
  result.answers[questionId]
