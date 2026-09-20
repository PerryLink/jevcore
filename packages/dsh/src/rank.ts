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
import { EGRESS_FIELDS, noul } from 'jevcore'
import type { JevQuestion, JevService } from 'jevcore'
import { rankingSize, renderResult } from 'jevcore'

const FEATURE: EgressFeature = 'tool:jev_rank'

/** Per-candidate question id, so results can be mapped back to candidates. */
export const candidateQuestionId = (index: number): string => `candidate_${index}`

/** Read a candidate index back out of a question id. */
export const candidateIndex = (questionId: string): number | undefined => {
  const match = /^candidate_(\d+)$/.exec(questionId)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * The criterion this tool falls back to when the caller declares none, or
 * declares only whitespace.
 *
 * Exported because the cap note below is measured from it: the default criterion
 * is what makes the candidate budget a number the model can hold on to.
 */
export const DEFAULT_CRITERION =
  'Does the candidate hold information that would help answer the query?'

/**
 * The question asked about one candidate.
 *
 * The candidate's own text stays in `state`; the question *names the path* to it
 * in backticks, which is what upstream prescribes. The criterion is repeated into
 * every question because Jev evaluates a whole batch against one state — and that
 * repetition is why the criterion's length is charged against the question
 * budget once per candidate rather than once per call.
 */
const candidateQuestion = (index: number, criterion: string): string =>
  `Does \`candidates[${index}].text\` satisfy the criterion in \`query\`? ` +
  `The criterion is: ${criterion}`

/**
 * The question map `jev_rank` sends: one noul per candidate, all naming the same
 * criterion.
 *
 * Extracted so that `execute`, the cap note in the description, and the test that
 * ties them together all measure the *same* bytes. A description computed from a
 * second copy of this construction would drift from the construction the first
 * time either one moved — which is the whole failure this extraction prevents.
 *
 * Takes a count rather than the candidate texts: a candidate's own text reaches
 * Jev through `state` and never appears in its question, so the question block's
 * size does not depend on it.
 */
export const rankQuestions = (
  candidateCount: number,
  criterion: string,
): Record<string, JevQuestion> => {
  const questions: Record<string, JevQuestion> = {}
  for (let index = 0; index < candidateCount; index += 1) {
    questions[candidateQuestionId(index)] = noul(candidateQuestion(index, criterion))
  }
  return questions
}

/** Serialized size of the question block, which is what the egress cap measures. */
const questionChars = (candidateCount: number, criterion: string): number =>
  JSON.stringify(rankQuestions(candidateCount, criterion)).length

/**
 * The declared egress cap on this tool's `questions` field.
 *
 * Read out of the core's contract rather than restated here, so the number the
 * model is told is the number `EgressContract.measure` enforces. The `??` mirrors
 * the fallback that contract's own `measure` uses when a feature declares no such
 * field; a number written down here instead would be one nothing enforces.
 */
export const QUESTION_CHAR_CAP: number =
  EGRESS_FIELDS[FEATURE].find((field) => field.field === 'questions')?.maxChars ?? 4_000

/**
 * The declared egress cap on this tool's `state` field, which carries the query
 * and every candidate.
 *
 * Declared, not effective: `maxStateChars` lets an operator override this one, and
 * nothing at this call site can see those settings. That is why the description
 * calls it the declared cap and why the test below asserts the *refusal* for the
 * question budget, which no configuration moves.
 */
export const STATE_CHAR_CAP: number =
  EGRESS_FIELDS[FEATURE].find((field) => field.field === 'state')?.maxChars ?? 16_000

/**
 * Characters one candidate adds to the question block before its criterion text.
 *
 * Measured from {@link questionChars} rather than written down as a literal: it is
 * the question key, the JSON envelope, and the fixed wording, and a hand-copied
 * number would be one nothing enforces. Measured between one and two candidates,
 * where both keys are the same width; past index 9 the key grows a character, so
 * {@link candidateCap} counts instead of dividing.
 */
export const CANDIDATE_QUESTION_OVERHEAD: number = questionChars(2, '') - questionChars(1, '')

/**
 * The largest candidate list whose question block still fits the declared cap.
 *
 * Counted rather than computed, because the per-candidate cost grows by a
 * character once indices reach double digits — `cap / cost` would then overstate
 * the boundary this number exists to describe. An empty criterion is measured as
 * empty; `execute` substitutes {@link DEFAULT_CRITERION} for one, so the effective
 * cap for `criterion: ""` is {@link DEFAULT_CANDIDATE_CAP}.
 */
export const candidateCap = (criterion: string): number => {
  let fits = 0
  while (questionChars(fits + 1, criterion) <= QUESTION_CHAR_CAP) fits += 1
  return fits
}

/** The cap at the criterion this tool uses when the caller declares none. */
export const DEFAULT_CANDIDATE_CAP: number = candidateCap(DEFAULT_CRITERION)

/**
 * A criterion long enough to show how sharply the cap falls, and the cap there.
 *
 * Both exist for the description alone. A formula is harder to act on than two
 * concrete points, and these two are measured rather than chosen: the length is
 * arbitrary, the count that comes back from it is not.
 */
const LONG_CRITERION_SAMPLE_CHARS = 400
const LONG_CRITERION_CANDIDATE_CAP: number = candidateCap('x'.repeat(LONG_CRITERION_SAMPLE_CHARS))

/** Group thousands, so the description reads "4,000" rather than "4000". */
const grouped = (value: number): string => value.toLocaleString('en-US')

/**
 * What the model is told about the two character budgets, and what it is told to
 * do about them.
 *
 * This note exists because both budgets were invisible: a model that passed fifty
 * candidates got an error naming sizes it had no way to anticipate and no way to
 * stay under, and a model whose candidate *text* was long got no error at all —
 * the state was replaced by a truncation envelope and the ranking came back as
 * though the candidates had been judged. Every number here is measured from the
 * construction above, and the test in `test/tools.test.ts` drives the real tool
 * to prove the advertised cap and the enforced cap are the same cap.
 */
const CAP_NOTE =
  'What you send is capped in characters, not in candidates, and the two caps fail differently. ' +
  `Every candidate adds one question that repeats your criterion verbatim, the questions must fit ` +
  `${grouped(QUESTION_CHAR_CAP)} characters, and a batch over that is REFUSED: the call fails with ` +
  'an error naming both sizes, no candidate is ranked, and retrying the same call cannot help. ' +
  `Each candidate costs ${CANDIDATE_QUESTION_OVERHEAD} characters plus your criterion's length, so ` +
  `the default criterion leaves about ${DEFAULT_CANDIDATE_CAP} candidates and a ` +
  `${LONG_CRITERION_SAMPLE_CHARS}-character criterion about ${LONG_CRITERION_CANDIDATE_CAP} — send ` +
  'fewer candidates, split the list across calls, or shorten the criterion. ' +
  `The candidate list itself must serialise inside ${grouped(STATE_CHAR_CAP)} characters (an ` +
  'operator can change that), and that budget is not refused but truncated: past it the whole state ' +
  'is replaced by a "[truncated]" envelope, so Jev judges a fragment of your own JSON rather than ' +
  'the list, the ranking that comes back says nothing about your candidates, and the result ' +
  'carries "truncated": true to say so. Keep the total candidate text well inside it.'

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
    truncated?: unknown
    latencyMs?: unknown
  }
  const size = rankingSize(value)
  const headline = `jev_rank (${size} candidate${size === 1 ? '' : 's'})`
  // The synthetic marker keys off `warning` rather than the provider name, the
  // same rule the core's `summarize` documents: a result labelled synthetic is
  // shown as synthetic whichever provider produced it.
  const synthetic = typeof record.warning === 'string' ? ' [synthetic]' : ''
  // Same rule again for a state that lost content to the size cap: the ranking
  // beside it was made from less than the caller sent, and a card that does not
  // say so presents a judgment about a truncated state as a judgment about the
  // whole one. Only an explicit `true` marks it — `undefined` means the state
  // arrived whole, which is the overwhelmingly common case.
  const truncated = record.truncated === true ? ' [truncated]' : ''
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
  return `${headline}${synthetic}${truncated} - ${best} - ${latency}${missing}`
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
    // Declared because `execute` returns them. They were computed by the core's
    // `renderResult` and then dropped here, which made a state that lost the
    // candidate list to the size cap indistinguishable from one judged whole.
    truncated: { type: 'boolean' as const },
    egress: { type: 'json' as const },
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
      'a fine-grained ordering.\n\n' +
      CAP_NOTE,
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
          'The list is bounded by two character budgets rather than a count, and both are in ' +
          'the tool description: the default criterion fits about ' +
          `${DEFAULT_CANDIDATE_CAP}, and candidate text is capped too. ` +
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

      const criterion = typed.criterion?.trim() || DEFAULT_CRITERION

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

      // `rankQuestions` rather than a loop here: the cap note in the description
      // and the test that holds it to the enforcement both measure this builder,
      // so the advertised bound cannot drift from the sent one.
      const questions = rankQuestions(order.length, criterion)

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
        // Forwarded for the reason the core's `RenderedResult.truncated` gives:
        // they change how the ranking has to be read. `renderResult` computed them
        // and this return dropped them, so a state whose candidate list was
        // replaced by a `[truncated]` envelope produced exactly the payload of a
        // state that was judged whole — measured at 20 candidates of 800
        // characters, which is an ordinary workload of file excerpts.
        ...(rendered.truncated === true ? { truncated: true } : {}),
        // Spread, and the two arrays copied, so the value is lossless JSON: the
        // core's `JevEgressFacts` is an interface (no implicit index signature)
        // whose array members are `readonly`, which the output schema's inferred
        // `JsonValue` refuses. `renderResult` spreads `usage` for the first half
        // of that reason; the copies cover the second.
        ...(rendered.egress === undefined ? {} : {
          egress: {
            ...rendered.egress,
            redactedFields: [...rendered.egress.redactedFields],
            redactionRules: [...rendered.egress.redactionRules],
          },
        }),
      }
    },
  })