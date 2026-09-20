/**
 * `jev_rank` - order a set of candidates by relevance.
 *
 * Ranking is the second most common judgment after a straight classification,
 * and it has a shape worth its own schema: one question per candidate, all
 * against the same query. Asking Jev once per candidate would be correct but
 * wasteful - the batch is answered in one round-trip.
 *
 * The scores are independent judgments, not a normalized distribution. That is
 * deliberate and is stated in the tool description: Jev is asked "is this one
 * relevant", not "which of these is most relevant", so the numbers are
 * comparable but do not sum to one.
 *
 * The payload types are aliases rather than interfaces for the same reason as
 * the render helpers: they must be assignable to lossless JSON.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EgressFeature } from 'jevcore'
import { noul } from 'jevcore'
import type { JevService } from 'jevcore'
import { asRendered, rankingSize, renderResult, summarize } from 'jevcore'

const FEATURE: EgressFeature = 'tool:jev_rank'

/** Per-candidate question id, so results can be mapped back to candidates. */
export const candidateQuestionId = (index: number): string => `candidate_${index}`

/** Read a candidate index back out of a question id. */
export const candidateIndex = (questionId: string): number | undefined => {
  const match = /^candidate_(\d+)$/.exec(questionId)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

type RankArgs = {
  query: string
  candidates: string[]
  criterion?: string
}

type RankedCandidate = {
  index: number
  candidate: string
  /** Absent when Jev returned no answer for this candidate. */
  relevance?: number
  confidence?: number
  note?: string
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    provider: { type: 'string' as const, required: true as const },
    model: { type: 'string' as const, required: true as const },
    latencyMs: { type: 'number' as const, required: true as const },
    ranking: { type: 'json' as const, required: true as const },
    usage: { type: 'json' as const },
    warning: { type: 'string' as const },
  },
  additionalProperties: false,
}

export const jevRankTool = (service: JevService) =>
  defineTool({
    name: 'jev_rank',
    description:
      'Rank a list of candidates by how well each satisfies one stated criterion, using TypeSafe ' +
      'Jev. Returns every candidate with an independent relevance probability and a sorted ' +
      'ranking.\n\n' +
      'Use it to order search hits, triage a backlog, pick which file to read first, or find the ' +
      'one item that answers a question. Prefer this over reading every candidate yourself when ' +
      'the list is longer than a handful.\n\n' +
      'The probabilities are independent per-candidate judgments, NOT a distribution that sums to ' +
      '1 - a candidate scoring 0.5 is not "half the total relevance". Compare them against your ' +
      'own threshold, and treat a flat set of scores as "none of these stands out" rather than as ' +
      'a fine-grained ordering.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The task, question, or need the candidates are being ranked against.',
      },
      candidates: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description:
          'The candidates, one string each. Include enough of each item for Jev to judge it. ' +
          'These strings are transmitted to TypeSafe when the live provider is configured.',
      },
      criterion: {
        type: 'string',
        description:
          'What "relevant" means here, as a yes/no question about one candidate. Defaults to ' +
          'asking whether the candidate helps accomplish the query.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        summary: summarize(asRendered(value), `jev_rank (${rankingSize(value)} candidates)`),
      }),
    },
    execute: async (args, exec) => {
      const typed = args as unknown as RankArgs
      const order = typed.candidates.map((candidate, index) => ({ candidate, index }))

      if (order.length === 0) {
        return { provider: service.providerId, model: '', latencyMs: 0, ranking: [] }
      }

      const criterion =
        typed.criterion?.trim() ||
        'Does this candidate help accomplish the query it is being ranked against?'

      // One noul question per candidate, all against the same state.
      const questions: Record<string, ReturnType<typeof noul>> = {}
      for (const { candidate, index } of order) {
        questions[candidateQuestionId(index)] = noul(
          `Candidate: ${candidate}\n\nQuestion: ${criterion}`,
        )
      }

      const result = await service.ask({
        feature: FEATURE,
        state: { query: typed.query },
        questions,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })

      const rendered = renderResult(result, Object.keys(questions))
      const judged: RankedCandidate[] = order.map(({ candidate, index }): RankedCandidate => {
        const answer = result.answers[candidateQuestionId(index)]
        if (answer?.type !== 'noul') {
          return { index, candidate, note: 'no answer returned for this candidate' }
        }
        return {
          index,
          candidate,
          relevance: answer.noul,
          // No `confidence` alongside: a noul answer has none. The ranking tool
          // used to offer one per candidate, which told the model to compare a
          // field that never arrives and invited it to treat "absent" as "low".
          // Relevance is `noul` — the probability the criterion holds — and that
          // is the whole signal for sorting.
        }
      })
      // A candidate Jev did not answer sorts last rather than being treated as
      // irrelevant: absent and irrelevant are different findings.
      const ranking = judged.sort(
        (left, right) => (right.relevance ?? -1) - (left.relevance ?? -1),
      )

      return {
        provider: rendered.provider,
        model: rendered.model,
        latencyMs: rendered.latencyMs,
        ranking,
        ...(rendered.usage === undefined ? {} : { usage: rendered.usage }),
        ...(rendered.warning === undefined ? {} : { warning: rendered.warning }),
      }
    },
  })