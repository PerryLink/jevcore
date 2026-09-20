/**
 * `jev rank` — order candidates by relevance to a query.
 *
 * One noul question per candidate, all in one request, which is the pattern the
 * upstream cookbook measures: the questions are independent, so batching them
 * costs one call rather than N. The judged state carries the query and every
 * candidate, and each question refers to its own candidate by a backticked path
 * rather than splicing its text into the question — splicing is the anti-pattern
 * the docs name outright, and it would also put candidate text on the wire as
 * *question* text, which is a different field with a different cap and a
 * different redaction path.
 *
 * **The numbers do not sum to 1.** They are independent probabilities, one per
 * candidate, each answering "does this candidate satisfy the criterion". This is
 * the single most misread thing about a ranking, so the human output says it in
 * as many words rather than leaving it to the README.
 */

import { noul, type JevQuestion } from 'jevcore'
import { hasFlag, optionalString, requireString } from './../args.js'
import { DEFAULT_RANK_CRITERION, FEATURE } from './../constants.js'
import { egressLines, formatProbability, toJson } from './../format.js'
import { asStringArray, readJson } from './../input.js'
import { buildContext, provenanceLine } from './../runtime.js'
import { EXIT, type CommandContext } from './../types.js'

/** One candidate and what Jev said about it. */
interface RankedCandidate {
  readonly index: number
  readonly candidate: string
  /** Probability that this candidate satisfies the criterion. */
  readonly relevance?: number
  readonly note?: string
}

/**
 * The sentence that must appear wherever a ranking is printed.
 *
 * A constant so the human output and the JSON payload carry the same words, and
 * so a test can assert that neither lost it.
 */
export const INDEPENDENCE_NOTE =
  'These probabilities are independent per-candidate judgments of the criterion. ' +
  'They do NOT sum to 1, and a candidate at 0.9 is not "the answer" — the numbers ' +
  'order a shortlist, and nothing more.'

/** The question id one candidate's answer is keyed by. */
export const candidateQuestionId = (index: number): string => `candidate_${index}`

/**
 * The noul one candidate is judged by.
 *
 * The candidate is named by its path in the state, not quoted into the question,
 * so the candidate's own text never becomes question text. See the module header.
 */
export const candidateQuestion = (criterion: string, index: number): JevQuestion =>
  noul(
    `Does \`candidates[${index}].text\` satisfy the criterion in \`query\`? ` +
      `The criterion is: ${criterion}`,
  )

/**
 * Order a ranking: answered candidates by probability, unanswered last.
 *
 * The sort is by `relevance ?? -1` rather than over a filtered list, so a
 * candidate with no answer keeps its place at the end instead of disappearing.
 * Dropping it would be the worst available behaviour: a caller comparing two runs
 * would see a shorter list with no indication that anything was missing, and the
 * core's own rendering rule is the opposite one — a missing answer is reported as
 * missing.
 */
export const orderRanking = (ranking: readonly RankedCandidate[]): readonly RankedCandidate[] =>
  [...ranking].sort((left, right) => (right.relevance ?? -1) - (left.relevance ?? -1))

/**
 * One candidate's entry, read from the raw answer.
 *
 * `relevance` is the answer's own `noul` — the probability of `true` — and not the
 * `probability` a rendered answer carries. Those differ on purpose: a rendering
 * reports `max(noul, 1 - noul)`, which is how *strong* an answer is, while a
 * ranking needs the probability that the candidate satisfies the criterion.
 * Reading the strength here would rank a confidently irrelevant candidate at the
 * top, which is the exact inversion this comment exists to prevent.
 */
const toRankedCandidate = (
  candidate: string,
  index: number,
  answer: { readonly type: string; readonly noul?: number } | undefined,
): RankedCandidate => {
  if (answer === undefined || answer.type !== 'noul' || answer.noul === undefined) {
    return { index, candidate, note: 'no answer returned for this candidate' }
  }
  return { index, candidate, relevance: answer.noul }
}

/** Run `rank`. */
export const runRank = async ({ args, io }: CommandContext): Promise<number> => {
  const query = requireString(args, 'query', 'the task or question being ranked against')
  const candidatesRef = requireString(args, 'candidates', 'the JSON array of candidates')
  const criterion = optionalString(args, 'criterion')?.trim() || DEFAULT_RANK_CRITERION

  const candidates = asStringArray(await readJson(candidatesRef, '--candidates', io), '--candidates')

  // An empty list is answered without a call, and that is not a shortcut: there is
  // no question to ask, so asking one would be a request whose answers are keyed
  // by candidates that do not exist.
  if (candidates.length === 0) {
    if (hasFlag(args, 'json')) {
      io.out(
        toJson({
          ok: true,
          command: 'rank',
          provider: 'none',
          model: '',
          latencyMs: 0,
          data: { query, criterion, ranking: [], note: INDEPENDENCE_NOTE },
        }),
      )
      return EXIT.OK
    }
    io.err('rank: no candidates were given, so there is nothing to rank.')
    return EXIT.OK
  }

  const state = {
    query,
    candidates: candidates.map((candidate, index) => ({ index, text: candidate })),
  }
  const questions: Record<string, JevQuestion> = {}
  candidates.forEach((_candidate, index) => {
    questions[candidateQuestionId(index)] = candidateQuestion(criterion, index)
  })

  const context = await buildContext(args, io, [FEATURE.rank])
  io.err(provenanceLine(context.route))

  const result = await context.service.ask({ feature: FEATURE.rank, state, questions })
  for (const line of egressLines(result.egress)) io.err(line)

  const ranking = orderRanking(
    candidates.map((candidate, index) =>
      toRankedCandidate(candidate, index, result.answers[candidateQuestionId(index)]),
    ),
  )

  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'rank',
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        data: {
          query,
          criterion,
          ranking,
          note: INDEPENDENCE_NOTE,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.egress === undefined ? {} : { egress: result.egress }),
        },
      }),
    )
    return EXIT.OK
  }

  io.out(
    `rank ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} against: ${query}`,
  )
  io.out(`criterion: ${criterion}`)
  ranking.forEach((entry, position) => {
    const score =
      entry.relevance === undefined
        ? 'no answer  '
        : `relevance=${formatProbability(entry.relevance)}`
    io.out(`  ${position + 1}. ${score}  ${entry.candidate}`)
  })
  io.out(INDEPENDENCE_NOTE)
  if (result.provider === 'mock') {
    io.err('provider=mock: this ranking is SYNTHETIC and carries no judgment.')
  }
  return EXIT.OK
}
