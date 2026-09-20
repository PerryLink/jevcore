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
import { rankingSize, renderResult } from 'jevcore'

const FEATURE: EgressFeature = 'tool:jev_rank'

/** Per-candidate question id, so results can be mapped back to candidates. */
export const candidateQuestionId = (index: number): string => `candidate_${index}`

/** Read a candidate index back out of a question id. */
export const candidateIndex = (questionId: string): number | undefined => {
  const match = /^candidate_(\d+)$/.exec(questionId)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Longest candidate excerpt shown in the one-line summary. */
const SUMMARY_CANDIDATE_CHARS = 60

/** The candidate text, shortened to something that fits one card line. */
const shortCandidate = (candidate: string): string =>
  candidate.length <= SUMMARY_CANDIDATE_CHARS
    ? candidate
    : `${candidate.slice(0, SUMMARY_CANDIDATE_CHARS - 3)}...`

/**
 * The one-line summary a Native tool card shows for `jev_rank`.
 *
 * **This has to be its own function.** The core's `summarize` formats
 * `RenderedResult.answers`, and a rank payload has no `answers` at all — only
 * `ranking` (see the `execute` return below). Handing the payload to it through
 * `asRendered` — a type assertion that adds nothing at runtime — made
 * `summarize` throw on its very first `value.answers.map(...)`, and the registry
 * turns a throw from a presentation callback into a **failed call**:
 *
 *     tool "jev_rank" returned invalid output: output.presentationMeta failed:
 *     Cannot read properties of undefined (reading 'map')
 *
 * The model got zero candidates, so the tool was simply unusable in a real
 * host - while all 410 tests passed, because nothing anywhere called
 * `presentationMeta`. `execute` was covered; the projection the registry runs
 * on **every top-level call** was not. `test/tools.test.ts` now calls it for
 * all three tools.
 *
 * Total by construction, because of the same failure mode: the registry fails
 * the whole call when a presentation callback throws, so `undefined`, a missing
 * `ranking`, and an entry of the wrong shape all have to render rather than
 * throw. `rankingSize` is defensive in the core for exactly this reason.
 */
export const rankSummary = (value: unknown): string => {
  const record = (typeof value === 'object' && value !== null ? value : {}) as {
    ranking?: unknown
    warning?: unknown
    latencyMs?: unknown
  }
  const size = rankingSize(value)
  const headline = `jev_rank (${size} candidate${size === 1 ? '' : 's'})`
  // The synthetic marker keys off `warning` rather than the provider name, the
  // same rule the core's `summarize` documents: a result labelled synthetic is
  // shown as synthetic whichever provider produced it.
  const synthetic = typeof record.warning === 'string' ? ' [synthetic]' : ''
  const ranking = Array.isArray(record.ranking) ? record.ranking : []
  // The ranking arrives sorted with unanswered candidates last, so the first
  // entry carrying a number is the top one. `relevance` absent means "Jev
  // returned nothing for this candidate", which is not a relevance of zero -
  // hence a search for a number rather than reading `ranking[0]`.
  const top = ranking.find(
    (entry): entry is { candidate?: unknown; relevance: number } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { relevance?: unknown }).relevance === 'number',
  )
  const unanswered = ranking.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { relevance?: unknown }).relevance !== 'number',
  ).length
  const best =
    top === undefined
      ? 'no candidate answered'
      : `top: ${typeof top.candidate === 'string' ? shortCandidate(top.candidate) : '?'} ` +
        `(${Math.round(top.relevance * 100)}%)`
  const latency = typeof record.latencyMs === 'number' ? `${record.latencyMs}ms` : '?ms'
  const missing = unanswered === 0 ? '' : ` - ${unanswered} unanswered`
  return `${headline}${synthetic} - ${best} - ${latency}${missing}`
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
      // `rankSummary`, not the core's `summarize`: this payload carries
      // `ranking`, not `answers`. See the note on `rankSummary`.
      presentationMeta: (_args, value) => ({ summary: rankSummary(value) }),
    },
    // Read-only judgment over arguments the caller already holds: no state is
    // mutated, the provider call is independent per candidate batch, and two
    // rankings of different inputs commute. Without this the registry treats
    // every call as `exclusive` (`ToolRuntime` - "if (!tool?.isConcurrencySafe)
    // return { kind: 'exclusive' }"), so N independent rankings ran strictly
    // one after another while the host's parallel pool sat idle.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const typed = args as unknown as RankArgs
      const order = typed.candidates.map((candidate, index) => ({ candidate, index }))

      if (order.length === 0) {
        return { provider: service.providerId, model: '', latencyMs: 0, ranking: [] }
      }

      const criterion =
        typed.criterion?.trim() ||
        'Does the candidate hold information that would help answer the query?'

      // Every candidate travels in `state`, and each question refers to its own by
      // a backticked path.
      //
      // This used to splice each candidate into the question text instead, which
      // the docs name as an anti-pattern outright: "When a value comes from a
      // database, put it in its own field instead of splicing it into a string
      // template." It was also the reason a candidate's contents could reach the
      // wire verbatim — see the redaction note in `EgressContract.measure`.
      //
      // Sending all candidates to every question costs tokens, and there is no way
      // around it while every question shares one state: Jev evaluates a batch
      // against a single state, so a question cannot be given only its own slice.
      // The cost buys the documented shape and a question that names what it is
      // judging rather than paraphrasing it.
      const state = {
        query: typed.query,
        candidates: order.map(({ candidate, index }) => ({
          index,
          text: candidate,
        })),
      }

      const questions: Record<string, ReturnType<typeof noul>> = {}
      for (const { index } of order) {
        questions[candidateQuestionId(index)] = noul(
          `Does \`candidates[${index}].text\` satisfy the criterion in \`query\`? ` +
            `The criterion is: ${criterion}`,
        )
      }

      const result = await service.ask({
        feature: FEATURE,
        state,
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