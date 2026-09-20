/**
 * Composite scoring: combine several Score answers into one number.
 *
 * The official pattern is two steps, and this package previously had only the
 * first:
 *
 *  1. ask one `score` question per dimension — supported, and several can travel in
 *     one batch;
 *  2. normalise each to 0–1 and combine them with weights **you** control, so
 *     "changing a weight need not rerun inference when evidence and question
 *     meanings are unchanged".
 *
 * Step two was missing entirely, which is why a caller wanting an overall grade had
 * to hand-roll the arithmetic and the level-to-fraction conversion in every
 * integration. The docs' worked example weights four dimensions
 * (`0.40·py + 0.10·lead + 0.40·arch + 0.10·general`) and the stated payoff is
 * "visibility into how exactly the final score is being calculated" — hence
 * `contributions` below rather than only a total.
 *
 * Everything here is pure: it takes answers and returns numbers. It does not call
 * a model, and it does not mutate what it was given.
 *
 * @see https://docs.typesafe.ai/patterns/composite-scoring
 */

import type { JevAnswer, ScoreAnswer } from './types.js'

/**
 * Normalise a score answer onto 0–1.
 *
 * The scale is `score / (levels - 1)`, so a 5-level rubric puts the middle level
 * at 0.5. Returns `undefined` rather than guessing when the answer is missing or
 * its rubric is degenerate: a one-level scale has no range to normalise into, and a
 * fabricated 0 would be indistinguishable from a genuine lowest score.
 *
 * The rubric size comes from the answer's own `legend`, so it reflects the scale
 * Jev actually scored against rather than the one the caller hoped it used.
 */
export const normalizeScore = (answer: JevAnswer | undefined): number | undefined => {
  if (answer === undefined || answer.type !== 'score') return undefined
  const scale = scoreScale(answer)
  if (scale === undefined) return undefined
  const { score, top } = scale
  // Clamped: the expected score may sit fractionally outside the rubric through
  // rounding, and a caller combining weights should not see 1.02.
  return Math.min(Math.max(score / top, 0), 1)
}

/** The expected score and the top of its scale, or `undefined` if degenerate. */
const scoreScale = (answer: ScoreAnswer): { score: number; top: number } | undefined => {
  const levels = Object.keys(answer.legend).length
  if (levels < 2) return undefined
  if (!Number.isFinite(answer.score)) return undefined
  return { score: answer.score, top: levels - 1 }
}

/** One dimension's share of a composite score. */
export interface Contribution {
  /** The weight as supplied, after normalising the weights to sum to 1. */
  readonly weight: number
  /** The dimension's normalised value, or `undefined` when it had no answer. */
  readonly value: number | undefined
  /** `weight × value`, or `undefined` when the dimension had no answer. */
  readonly points: number | undefined
}

export interface CompositeScore {
  /** Weighted mean over the dimensions that answered, on 0–1. */
  readonly score: number
  /**
   * Dimensions that produced no usable answer, in the order supplied.
   *
   * Reported rather than folded in as zero. A missing dimension and a genuine
   * lowest score are different findings, and silently treating the first as the
   * second turns absent evidence into a bad grade.
   */
  readonly missing: readonly string[]
  /** Per-dimension arithmetic, so the total can be checked rather than trusted. */
  readonly contributions: Readonly<Record<string, Contribution>>
}

/**
 * Combine several score answers into one weighted number.
 *
 * Weights are relative, not required to sum to 1: `{a: 2, b: 1}` behaves the same
 * as `{a: 0.67, b: 0.33}`. They are renormalised over the dimensions that
 * **answered**, so a missing dimension neither drags the score toward zero nor
 * silently reweights the others against a total that includes it.
 *
 * Throws on a non-positive total weight, because every input then yields the same
 * division by zero and the caller has a bug worth hearing about.
 */
export const compositeScore = (
  weights: Readonly<Record<string, number>>,
  answers: Readonly<Record<string, JevAnswer | undefined>>,
): CompositeScore => {
  const names = Object.keys(weights)
  if (names.length === 0) {
    throw new Error('compositeScore needs at least one weighted dimension')
  }

  const contributions: Record<string, Contribution> = {}
  const missing: string[] = []
  let answeredWeight = 0

  for (const name of names) {
    const weight = weights[name] ?? 0
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`weight for "${name}" must be a finite non-negative number, got ${weight}`)
    }
    const value = normalizeScore(answers[name])
    if (value === undefined) {
      missing.push(name)
      contributions[name] = { weight, value: undefined, points: undefined }
      continue
    }
    answeredWeight += weight
    contributions[name] = { weight, value, points: undefined }
  }

  if (answeredWeight <= 0) {
    throw new Error(
      `no dimension with a positive weight produced a usable score ` +
        `(missing: ${missing.join(', ') || 'none'}; weights sum to 0 over the answered set). ` +
        'A composite of nothing is not a low score, so this is an error rather than 0.',
    )
  }

  let total = 0
  for (const name of names) {
    const contribution = contributions[name]
    if (contribution === undefined || contribution.value === undefined) continue
    const share = contribution.weight / answeredWeight
    const points = share * contribution.value
    contributions[name] = { weight: share, value: contribution.value, points }
    total += points
  }

  return { score: total, missing, contributions }
}
