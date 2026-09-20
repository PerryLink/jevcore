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
   * Minimum `confidence` for an answer to be acted upon. Jev's own calibration
   * is the point of the model, so this is a floor on trusting it, not a
   * substitute for it.
   */
  readonly minConfidence: number
  /**
   * Minimum probability of the selected criterion. Guards the case where Jev
   * is confident but the distribution is nearly flat.
   */
  readonly minProbability: number
  /**
   * Optional per-verdict mapping from criterion key to whether the caller
   * should act. Keys absent from the map yield `undecided`.
   */
  readonly accept?: Readonly<Record<string, boolean>>
}

export const DEFAULT_POLICY: PolicyOptions = {
  minConfidence: 0.7,
  minProbability: 0.6,
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
    const confidence = answer.confidence
    if (confidence !== undefined && confidence < options.minConfidence) {
      return { kind: 'undecided', reason: 'below-confidence' }
    }
    const probability = answer.noul
    const key = probability >= 0.5 ? 'true' : 'false'
    const strength = Math.max(probability, 1 - probability)
    if (strength < options.minProbability) return { kind: 'undecided', reason: 'below-confidence' }
    if (criteria.length > 0 && !criteria.includes(key)) {
      return { kind: 'invalid', reason: `noul resolved to "${key}", which is not a declared criterion` }
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

  const confidence = answer.confidence
  if (confidence !== undefined && confidence < options.minConfidence) {
    return { kind: 'undecided', reason: 'below-confidence' }
  }
  if (probability < options.minProbability) return { kind: 'undecided', reason: 'below-confidence' }
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
