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
  type EntryType,
  type JevQuestion,
  type JevService,
  type JsonValue,
  type NoulCriteria,
} from 'jevcore'

export interface QuestionInput {
  readonly type: 'noul' | 'choice' | 'score'
  /**
   * The question itself.
   *
   * `EntryType` rather than `string`, matching the DSH plugin's `ask.ts`: that is
   * what actually reaches `noul`/`choice`/`score`, since the question map is an
   * opaque object and nothing here narrows `instructions`. The upstream docs
   * recommend an object or array of named fields whenever definitions, contrasts
   * or examples clarify the question, so claiming `string` was a narrower
   * promise than the code kept.
   */
  readonly instructions: EntryType
  /** choice/score criteria, and (legacy spelling) a noul's two outcomes. */
  readonly criteria?: Readonly<Record<string, string | null>>
  /**
   * noul only: what "true" and what "false" mean.
   *
   * This is the field the MCP surface was missing. `criteria` was declared with
   * the choice/score shape and then never passed to `noul`, so the upstream
   * boundary definition — new in API v1, and the thing that makes a 0.5
   * interpretable — had a usage rate of zero here while the DSH plugin had
   * already wired it. `NoulCriteria` is the core's own type, so a boundary that
   * typechecks at this boundary cannot be rejected by `noul` on the other side.
   *
   * Field name and type are the DSH plugin's (`packages/dsh/src/ask.ts:48`),
   * deliberately: the same capability behind two entry points must not accept
   * two different spellings.
   */
  readonly boundary?: NoulCriteria
}

/**
 * The boundary a noul declared, under either spelling this surface accepts.
 *
 * Two spellings, because `criteria` came first: a caller could declare
 * `criteria: { true: ..., false: ... }` — the upstream `NoulCriteria` shape
 * exactly — and have it silently ignored. `boundary` is the documented spelling
 * and wins when both are present.
 *
 * Deliberately the same logic as `packages/dsh/src/ask.ts:66`; the divergence
 * this closes is between the two entry points, so re-inventing the rules here
 * would reopen it. A boundary that names neither outcome is not rejected here:
 * `assertValidBatch` refuses it below, with the core's own message.
 */
const noulBoundary = (id: string, question: QuestionInput): NoulCriteria | undefined =>
  question.boundary ?? fromOutcomeCriteria(id, question.criteria)

/**
 * Read the `NoulCriteria` spelling out of a noul's `criteria` map.
 *
 * A key that names no outcome is refused rather than dropped: for a noul,
 * `criteria` can only mean the two outcomes, so a map keyed by anything else is
 * a caller bug and forwarding it would put a key on the wire that means nothing.
 * An empty map declares nothing and stays legal.
 */
const fromOutcomeCriteria = (
  id: string,
  criteria: QuestionInput['criteria'],
): NoulCriteria | undefined => {
  if (criteria === undefined) return undefined
  const keys = Object.keys(criteria)
  if (keys.length === 0) return undefined
  const alien = keys.filter((key) => key !== 'true' && key !== 'false')
  if (alien.length > 0) {
    throw new Error(
      `question "${id}" is a noul but its criteria keys (${alien.join(', ')}) name no outcome. A ` +
        'noul boundary says what "true" and what "false" mean: declare it as ' +
        '`boundary: { true, false }` (or `criteria: { true, false }`). A keyed `criteria` map is ' +
        'for choice and score.',
    )
  }
  const boundary: { true?: EntryType; false?: EntryType } = {}
  const yes = criteria['true']
  const no = criteria['false']
  if (yes !== undefined) boundary.true = yes
  if (no !== undefined) boundary.false = no
  return boundary
}

/** Convert the wire question shape into a core question batch. */
export const toQuestions = (
  input: Readonly<Record<string, QuestionInput>>,
): Record<string, JevQuestion> => {
  const out: Record<string, JevQuestion> = {}
  for (const [id, question] of Object.entries(input)) {
    if (question.type === 'noul') {
      // `undefined` means "no boundary declared", which `noul` omits from the
      // wire payload rather than writing `criteria: undefined` into it.
      out[id] = noul(question.instructions, noulBoundary(id, question))
      continue
    }
    if (question.boundary !== undefined) {
      throw new Error(
        `question "${id}" is a ${question.type} but declares a noul "boundary". A boundary says ` +
          'what "true" and what "false" mean and exists only for noul; a choice declares its ' +
          'permitted answers and a score its ordered levels, both in `criteria`.',
      )
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
