/**
 * Provider answer normalization.
 *
 * Both routes — TypeSafe's `POST /v1/systemone` and OpenRouter's
 * `POST /api/alpha/decisions` — return the same three answer shapes. The
 * normalization lives here rather than in each provider so the two routes
 * cannot drift apart in how they are interpreted.
 *
 * The governing rule is that nothing is invented. An answer that does not match
 * a known shape is dropped, because a caller who receives no answer knows to
 * fall back, whereas a coerced answer is indistinguishable from a real
 * judgment. That is why `normalizeScoreAnswer` keeps the provider's own rubric
 * in `legend` instead of substituting the caller's level names: the rubric that
 * returns is the one Jev actually scored against, not the one we hoped it used.
 */

import type { CategoricalAnswer, JevAnswer, NoulAnswer, ScoreAnswer } from './types.js'

/** True for a plain JSON object, excluding arrays and `null`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A finite number, or `undefined` for anything else. */
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The optional `confidence`, included only when the provider reported one. */
const confidenceOf = (raw: Record<string, unknown>): { confidence?: number } => {
  const confidence = finite(raw.confidence)
  return confidence === undefined ? {} : { confidence }
}

/** Probability entries, keeping only the finite numbers. */
const probabilitiesOf = (value: unknown): Record<string, number> => {
  const probabilities: Record<string, number> = {}
  if (!isRecord(value)) return probabilities
  for (const [key, entry] of Object.entries(value)) {
    const probability = finite(entry)
    if (probability !== undefined) probabilities[key] = probability
  }
  return probabilities
}

/**
 * Normalize one raw answer against the question type it answers.
 *
 * Returns `undefined` when the payload does not carry the fields that type
 * requires — including a `score` answer whose numeric score is missing, since
 * there would be no judgment left to report.
 */
export const normalizeAnswer = (
  raw: unknown,
  expected: 'noul' | 'choice' | 'score',
): JevAnswer | undefined => {
  if (!isRecord(raw)) return undefined

  if (expected === 'noul') {
    const noul = finite(raw.noul)
    if (noul === undefined) return undefined
    const answer: NoulAnswer = { type: 'noul', noul, ...confidenceOf(raw) }
    return answer
  }

  if (expected === 'score') {
    const score = finite(raw.score)
    if (score === undefined) return undefined
    const legend: Record<string, string> = {}
    if (isRecord(raw.legend)) {
      for (const [index, description] of Object.entries(raw.legend)) {
        // A level left undescribed arrives as `null`; carry the index anyway so
        // the probabilities stay addressable.
        if (typeof description === 'string') legend[index] = description
      }
    }
    const answer: ScoreAnswer = {
      type: 'score',
      score,
      legend,
      probabilities: probabilitiesOf(raw.probabilities),
      ...confidenceOf(raw),
    }
    return answer
  }

  const choice = typeof raw.choice === 'string' ? raw.choice : undefined
  if (choice === undefined) return undefined
  const answer: CategoricalAnswer = {
    type: 'choice',
    choice,
    probabilities: probabilitiesOf(raw.probabilities),
    ...confidenceOf(raw),
  }
  return answer
}
