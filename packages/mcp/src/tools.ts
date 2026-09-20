/**
 * The tool implementations, independent of the MCP transport.
 *
 * Kept separate so the judgment logic is testable without standing up a server,
 * and so the MCP layer below is only schema declaration and result framing.
 */

import {
  DEFAULT_CHECK_THRESHOLDS,
  VERDICT_QUESTION,
  assertValidBatch,
  choice,
  noul,
  resolveCheck,
  score,
  type JevQuestion,
  type JevService,
  type JsonValue,
} from 'jevcore'

export interface QuestionInput {
  readonly type: 'noul' | 'choice' | 'score'
  readonly instructions: string
  readonly criteria?: Readonly<Record<string, string | null>>
}

/** Convert the wire question shape into a core question batch. */
export const toQuestions = (
  input: Readonly<Record<string, QuestionInput>>,
): Record<string, JevQuestion> => {
  const out: Record<string, JevQuestion> = {}
  for (const [id, question] of Object.entries(input)) {
    if (question.type === 'noul') {
      out[id] = noul(question.instructions)
      continue
    }
    const criteria = question.criteria ?? {}
    out[id] = question.type === 'choice'
      ? choice(question.instructions, criteria)
      : score(question.instructions, criteria)
  }
  return out
}

export interface AskInput {
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, QuestionInput>>
}

export const runAsk = async (service: JevService, input: AskInput) => {
  const questions = toQuestions(input.questions)
  assertValidBatch(questions)
  const result = await service.ask({
    feature: 'tool:jev_ask',
    state: input.state,
    questions,
  })
  return {
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    answers: result.answers,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.provider === 'mock' ? { warning: SYNTHETIC_WARNING } : {}),
  }
}

const SYNTHETIC_WARNING =
  'These answers are SYNTHETIC. The mock provider derived them from a hash of the input; they ' +
  'carry no judgment. Set TYPESAFE_API_KEY (or OPENROUTER_API_KEY), or JEV_PROVIDER=live, for ' +
  'real answers.'

export interface RankInput {
  readonly query: string
  readonly candidates: readonly string[]
  /**
   * `| undefined` is explicit because `exactOptionalPropertyTypes` is on and a
   * schema library produces `{ criterion: undefined }` rather than omitting the
   * key. Without it, a validated argument object is not assignable here.
   */
  readonly criterion?: string | undefined
}

export const runRank = async (service: JevService, input: RankInput) => {
  if (input.candidates.length === 0) {
    return { provider: service.providerId, model: '', latencyMs: 0, ranking: [] }
  }
  const criterion =
    input.criterion?.trim() ||
    'Does the candidate hold information that would help answer the query?'

  // Candidates travel in `state`, and each question refers to its own by a
  // backticked path. Splicing them into the question text — which this did — is
  // the anti-pattern the docs name outright, and it meant candidate contents
  // reached the wire as question text. See `EgressContract.measure`.
  const state = {
    query: input.query,
    candidates: input.candidates.map((candidate, index) => ({ index, text: candidate })),
  }

  const questions: Record<string, JevQuestion> = {}
  input.candidates.forEach((_candidate, index) => {
    questions[`candidate_${index}`] = noul(
      `Does \`candidates[${index}].text\` satisfy the criterion in \`query\`? ` +
        `The criterion is: ${criterion}`,
    )
  })

  const result = await service.ask({
    feature: 'tool:jev_rank',
    state,
    questions,
  })

  const ranking = input.candidates
    .map((candidate, index) => {
      const answer = result.answers[`candidate_${index}`]
      if (answer?.type !== 'noul') {
        return { index, candidate, note: 'no answer returned for this candidate' }
      }
      return {
        index,
        candidate,
        relevance: answer.noul,
        // No `confidence`: a noul answer carries none, so offering the field
        // would invite a caller to compare values that never arrive.
      }
    })
    .sort(
      (left, right) =>
        ((right as { relevance?: number }).relevance ?? -1) -
        ((left as { relevance?: number }).relevance ?? -1),
    )

  return {
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    ranking,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.provider === 'mock' ? { warning: SYNTHETIC_WARNING } : {}),
  }
}

export interface CheckInput {
  readonly claim: string
  readonly evidence: string
}

export const runCheck = async (service: JevService, input: CheckInput) => {
  const questions = {
    [VERDICT_QUESTION.supports]: noul('Does this evidence support the claim?'),
    [VERDICT_QUESTION.contradicts]: noul('Does this evidence contradict the claim?'),
    [VERDICT_QUESTION.sufficient]: noul(
      'Is this evidence sufficient to settle whether the claim is true?',
    ),
  }

  const result = await service.ask({
    feature: 'tool:jev_check',
    state: { claim: input.claim, evidence: input.evidence },
    questions,
  })

  const resolved = resolveCheck(result, DEFAULT_CHECK_THRESHOLDS)
  return {
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    verdict: resolved.verdict,
    probabilities: {
      ...(resolved.supports === undefined ? {} : { supports: resolved.supports }),
      ...(resolved.contradicts === undefined ? {} : { contradicts: resolved.contradicts }),
      ...(resolved.sufficient === undefined ? {} : { sufficient: resolved.sufficient }),
    },
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.provider === 'mock' ? { warning: SYNTHETIC_WARNING } : {}),
  }
}

export { SYNTHETIC_WARNING }
