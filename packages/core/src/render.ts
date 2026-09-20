/**
 * Tool output formatting.
 *
 * Kept separate so the tools themselves stay about decisions, and so the shape
 * the model sees is reviewable in one place.
 *
 * Two rules hold across every tool here:
 *
 *  - **A missing answer is reported as missing.** Nothing is filled in, and no
 *    default confidence is invented. A model that cannot see an answer knows to
 *    ask again; a model shown a fabricated one will act on it.
 *  - **The provider is named.** When the mock answers, the model is told so, so
 *    a synthetic value cannot be mistaken for a real judgment.
 */

import type { JevAnswer, JevResult, JevUsage } from './types.js'

/**
 * Declared as a type alias rather than an interface on purpose: the tool-output
 * schema validates this as lossless JSON, and only an alias receives the
 * implicit index signature that makes it assignable to `JsonValue`.
 */
export type RenderedAnswer = {
  question: string
  type: JevAnswer['type']
  /** Selected key: `"true"`/`"false"` for noul, the criterion otherwise. */
  answer?: string
  /** Probability of the selected key. */
  probability?: number
  /** Probability of `true`, for noul answers only. */
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
  /** Present when the question was asked and Jev returned nothing for it. */
  note?: string
}

/** One answer, flattened for the model. */
export const renderAnswer = (questionId: string, answer: JevAnswer | undefined): RenderedAnswer => {
  if (answer === undefined) {
    return { question: questionId, type: 'noul', note: 'no answer returned for this question' }
  }
  if (answer.type === 'noul') {
    return {
      question: questionId,
      type: 'noul',
      answer: answer.noul >= 0.5 ? 'true' : 'false',
      noul: answer.noul,
      probability: Math.max(answer.noul, 1 - answer.noul),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    }
  }
  const probability = answer.probabilities[answer.choice]
  return {
    question: questionId,
    type: answer.type,
    answer: answer.choice,
    ...(probability === undefined ? {} : { probability }),
    probabilities: { ...answer.probabilities },
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  }
}

/** Type alias for the same reason as {@link RenderedAnswer}. */
export type RenderedResult = {
  provider: string
  model: string
  latencyMs: number
  answers: RenderedAnswer[]
  usage?: JevUsage
  /**
   * Present only for the mock provider. Stated in the result itself so the
   * model cannot treat a synthetic answer as a real judgment.
   */
  warning?: string
}

const MOCK_WARNING =
  'These answers are SYNTHETIC. The mock provider derived them from a hash of the input; ' +
  'they carry no judgment. Set provider to "live" and configure a TypeSafe credential for real answers.'

/** Build the canonical value every tool returns. */
export const renderResult = (result: JevResult, questionIds: readonly string[]): RenderedResult => ({
  provider: result.provider,
  model: result.model,
  latencyMs: result.latencyMs,
  answers: questionIds.map((id) => renderAnswer(id, result.answers[id])),
  ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
  ...(result.provider === 'mock' ? { warning: MOCK_WARNING } : {}),
})

/**
 * Adapt a schema-inferred value back to the shape this module produced.
 *
 * The output schema declares fields as JSON nodes, so the registry infers
 * `JsonValue` for them and a presenter receives that wider type. This narrows
 * it for display without asserting anything the schema did not guarantee — the
 * value came from {@link renderResult}, which always produces this shape.
 */
export const asRendered = (value: unknown): RenderedResult => value as RenderedResult

/**
 * A short human-readable line for a Native tool card.
 *
 * The synthetic marker keys off the `warning` field rather than the provider
 * name, so a result labelled as synthetic is shown as synthetic. Keying off
 * `provider === 'mock'` meant any other provider that set a warning would have
 * been presented as if its answers carried real judgment.
 */
export const summarize = (value: RenderedResult, headline: string): string => {
  const parts = value.answers.map((answer) => {
    if (answer.note !== undefined) return `${answer.question}=?`
    const probability =
      answer.probability === undefined ? '' : ` (${Math.round(answer.probability * 100)}%)`
    return `${answer.question}=${answer.answer ?? '?'}${probability}`
  })
  const synthetic = value.warning === undefined ? '' : ' [synthetic]'
  return `${headline}${synthetic} - ${parts.join(' ')} - ${value.latencyMs}ms`
}

/**
 * How many candidates a rank payload carries.
 *
 * Total: any input at all yields a number. This runs from a presentation
 * callback, where an exception would break the card rather than merely look
 * wrong — so `undefined` and other non-payload values have to return 0 instead
 * of throwing.
 */
export const rankingSize = (value: unknown): number => {
  if (typeof value !== 'object' || value === null) return 0
  const ranking = (value as { ranking?: unknown }).ranking
  return Array.isArray(ranking) ? ranking.length : 0
}