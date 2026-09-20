/**
 * The mock provider: deterministic, offline, and unmistakably synthetic.
 *
 * This is the default. Every answer is derived from a hash of the question and
 * state, so a test can assert an exact value, and no network call is possible
 * because this module contains no fetch and imports no client.
 *
 * Two deliberate properties:
 *
 *  - **Answers are never passed off as real.** {@link MOCK_MODEL} names itself
 *    a mock, and `JevResult.provider` says `mock`. A caller cannot confuse the
 *    two.
 *  - **Confidence is reported honestly.** A mock has no basis for confidence,
 *    so it reports a fixed low value rather than a plausible-looking high one.
 *    Silently confident synthetic answers are exactly how a "fabricated 1.0
 *    probability" bug reaches production.
 */

import type {
  CategoricalAnswer,
  JevAnswer,
  JevProvider,
  JevRequest,
  JevResult,
  NoulAnswer,
} from '../types.js'

export const MOCK_MODEL = 'mock/jev-synthetic'

/** Confidence reported by the mock. Fixed and low, because it is meaningless. */
export const MOCK_CONFIDENCE = 0.5

/** FNV-1a over a string, as an unsigned 32-bit integer. */
export const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Map a hash to a float in `[0, 1)`, using the full 32-bit range. */
const unit = (hash: number): number => hash / 0x1_0000_0000

/** Round to 4 decimals so assertions are stable across platforms. */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

const probe = (questionId: string, request: JevRequest): number =>
  fnv1a(`${questionId}\u0000${JSON.stringify(request.state) ?? 'null'}`)

/**
 * Distribute one unit of probability across criteria using the hash as a seed.
 *
 * Uses a small linear congruential step per criterion so the weights differ
 * from each other but remain a pure function of the hash. The result sums to 1.
 */
const weights = (hash: number, keys: readonly string[]): Record<string, number> => {
  let cursor = hash
  const raw: number[] = []
  let total = 0
  for (let index = 0; index < keys.length; index += 1) {
    cursor = (Math.imul(cursor, 1_664_525) + 1_013_904_223) >>> 0
    const weight = 0.05 + unit(cursor)
    raw.push(weight)
    total += weight
  }
  const out: Record<string, number> = {}
  keys.forEach((key, index) => {
    out[key] = round4((raw[index] ?? 0) / total)
  })
  return out
}

const answerFor = (questionId: string, request: JevRequest): JevAnswer | undefined => {
  const question = request.questions[questionId]
  if (question === undefined) return undefined

  if (question.type === 'noul') {
    const answer: NoulAnswer = {
      type: 'noul',
      noul: round4(unit(probe(questionId, request))),
      confidence: MOCK_CONFIDENCE,
    }
    return answer
  }

  const keys = Object.keys(question.criteria)
  if (keys.length === 0) return undefined
  const probabilities = weights(probe(questionId, request), keys)
  // Pick the argmax deterministically; a tie is impossible here because the
  // weights are derived from distinct LCG steps.
  let best = keys[0] as string
  for (const key of keys) {
    if ((probabilities[key] ?? 0) > (probabilities[best] ?? 0)) best = key
  }
  const answer: CategoricalAnswer = {
    type: question.type,
    choice: best,
    probabilities,
    confidence: MOCK_CONFIDENCE,
  }
  return answer
}

/** A provider that answers offline and deterministically. */
export class MockProvider implements JevProvider {
  readonly id = 'mock'

  answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const startedAt = Date.now()
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('aborted'))
    }
    const answers: Record<string, JevAnswer> = {}
    for (const questionId of Object.keys(request.questions)) {
      const answer = answerFor(questionId, request)
      if (answer !== undefined) answers[questionId] = answer
    }
    return Promise.resolve({
      model: request.model ?? MOCK_MODEL,
      answers,
      // The mock touches no API, so there is nothing to account for.
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - startedAt,
      provider: this.id,
    })
  }
}
