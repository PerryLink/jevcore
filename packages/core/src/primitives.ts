/**
 * Question builders.
 *
 * These mirror the TypeSafe API primitives (`noul`, `choice`, `score`) and are
 * deliberately tiny: they exist so a caller cannot construct a question Jev
 * would reject, and so the batch shape is readable at the call site.
 */

import type { ChoiceQuestion, JevQuestion, NoulQuestion, ScoreQuestion } from './types.js'

/** Ask a yes/no question. The answer carries the probability of `true`. */
export const noul = (instructions: string): NoulQuestion => ({
  type: 'noul',
  instructions,
})

/**
 * Ask Jev to pick one of a fixed set.
 *
 * @param criteria - permitted answers mapped to an optional description.
 *   Keys are what Jev returns; values describe the key for the model.
 */
export const choice = (
  instructions: string,
  criteria: Readonly<Record<string, string | null>>,
): ChoiceQuestion => ({
  type: 'choice',
  instructions,
  criteria,
})

/**
 * Ask Jev to place the state on an ordered scale of named levels.
 *
 * Pass the levels in scale order: the first entry is score `0` and the last is
 * score `n-1`. The map is converted to the ordered array the API expects, so
 * insertion order is what defines the scale.
 *
 * Keys are level *names*, used in this project's output and never sent: Jev
 * scores positions, so it receives the descriptions alone and returns a numeric
 * expected score with a `legend` mapping each index back to its description.
 *
 * @param criteria - level name to its description, in ascending scale order.
 *   All levels must be described. `null` and a missing value are rejected rather
 *   than dropped — see {@link scoreCriteriaArray} — and `''` is a legal way to
 *   hold a position in the scale without describing it.
 */
export const score = (
  instructions: string,
  criteria: Readonly<Record<string, string | null | undefined>>,
): ScoreQuestion => ({
  type: 'score',
  instructions,
  criteria: scoreCriteriaArray(criteria),
})

/**
 * A key that parses as a JavaScript integer index.
 *
 * `Object.keys` reorders these ahead of every other key, so a level map using
 * them would silently produce a scale in an order the author never wrote. That
 * is worth an error rather than a surprise.
 */
const INDEX_LIKE_KEY = /^(?:0|[1-9][0-9]*)$/

/** Documented ceilings, confirmed against the live API. */
export const MAX_SCORE_LEVELS = 10
export const MAX_CHOICE_OPTIONS = 255

/**
 * Convert a level map to the ordered array the API expects.
 *
 * **A level's position in this array *is* its score.** That is why an undescribed
 * level is an error rather than something to filter out: dropping one silently
 * renumbers every level after it, so `{low, medium: null, high}` would send a
 * two-level scale in which `high` occupies position 1 — the answer would come
 * back with `legend` keyed `"1": "severe"` and any caller mapping positions back
 * to names would read it as the *medium* level.
 *
 * This was previously silent, and the live API rejects `null` entries anyway
 * (422, `criteria.1.str: Input should be a valid string`) — so there was no
 * correct behaviour to fall back to, only a wrong one to hide. Callers who want
 * a level to hold its place undescribed should pass `''`, which the API accepts.
 */
export const scoreCriteriaArray = (
  levels: Readonly<Record<string, string | null | undefined>>,
): readonly string[] => {
  const keys = Object.keys(levels)
  const reordered = keys.filter((key) => INDEX_LIKE_KEY.test(key))
  if (reordered.length > 0 && keys.length > 1) {
    throw new Error(
      `score criteria use integer-like level names (${reordered.join(', ')}). JavaScript reorders ` +
        'integer-like keys ahead of the rest, so the scale would not follow the order written. ' +
        'Name the levels instead, such as "low"/"medium"/"high".',
    )
  }
  const undescribed = keys.filter((key) => {
    const description = levels[key]
    return description === null || description === undefined
  })
  if (undescribed.length > 0) {
    throw new Error(
      `score level(s) ${undescribed.map((key) => `"${key}"`).join(', ')} have no description. A ` +
        'level\'s position in the scale is its score, so an undescribed level cannot simply be ' +
        'dropped: doing so would renumber every level after it and make answers map back to the ' +
        'wrong names. Describe the level, or pass an empty string "" to hold its place in the ' +
        'scale without describing it.',
    )
  }
  return keys.map((key) => levels[key] as string)
}

/** Reject a question whose criteria map would make an answer unverifiable. */
export const assertValidQuestion = (id: string, question: JevQuestion): void => {
  if (question.instructions.trim().length === 0) {
    throw new Error(`question "${id}" has empty instructions`)
  }
  if (question.type === 'noul') return
  if (question.type === 'score') {
    if (question.criteria.length < 2) {
      throw new Error(
        `question "${id}" is a score but declares ${question.criteria.length} described level(s). ` +
          'A scale needs at least two, because a one-level scale carries no ordering.',
      )
    }
    if (question.criteria.length > MAX_SCORE_LEVELS) {
      // The API's own error for this reads "Too many score levels. Must have at
      // most 10 levels." Catching it here turns a wasted round-trip into a
      // caller-side error, which is the point of local validation.
      throw new Error(
        `question "${id}" is a score with ${question.criteria.length} levels; the API accepts at ` +
          `most ${MAX_SCORE_LEVELS}.`,
      )
    }
    return
  }
  const keys = Object.keys(question.criteria)
  if (keys.length < 2) {
    throw new Error(`question "${id}" is ${question.type} but declares ${keys.length} criteria`)
  }
  if (question.type === 'choice' && keys.length > MAX_CHOICE_OPTIONS) {
    throw new Error(
      `question "${id}" is a choice with ${keys.length} options; the API accepts at most ` +
        `${MAX_CHOICE_OPTIONS}.`,
    )
  }
}

/** Validate every question in one batch, throwing on the first defect. */
export const assertValidBatch = (questions: Readonly<Record<string, JevQuestion>>): void => {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new Error('a Jev request needs at least one question')
  for (const id of ids) {
    const question = questions[id]
    if (question === undefined) throw new Error(`question "${id}" is undefined`)
    assertValidQuestion(id, question)
  }
}

/**
 * The top-scoring criterion of a categorical answer, or `undefined` when the
 * probabilities do not single one out.
 *
 * Ties yield `undefined` rather than an arbitrary winner: a caller deciding
 * whether to act should treat "no clear winner" as no answer, not as a win.
 */
export const topCriterion = (
  probabilities: Readonly<Record<string, number>>,
): string | undefined => {
  let best: string | undefined
  let bestValue = Number.NEGATIVE_INFINITY
  let tied = false
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = key
      bestValue = value
      tied = false
    } else if (value === bestValue) {
      tied = true
    }
  }
  return tied ? undefined : best
}
