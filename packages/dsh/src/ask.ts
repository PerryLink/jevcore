/**
 * `jev_ask` — the primitive tool.
 *
 * This is the one tool that exposes Jev's raw surface: a batch of typed
 * questions over one state. The other two tools are conveniences built on the
 * same service and exist because two shapes are common enough to deserve their
 * own schema. A caller that needs something else uses this.
 *
 * The description matters as much as the code: it tells the model when *not* to
 * reach for Jev. A decision model asked to write prose produces nothing useful,
 * and a model that does not know that will keep trying.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EgressFeature } from 'jevcore'
import { assertValidBatch, choice, noul, score } from 'jevcore'
import type { JevService } from 'jevcore'
import type { EntryType, JevQuestion, JsonValue, NoulCriteria } from 'jevcore'
import { asRendered, renderResult, summarize } from 'jevcore'

const FEATURE: EgressFeature = 'tool:jev_ask'

interface QuestionInput {
  readonly type: 'noul' | 'choice' | 'score'
  /**
   * The question itself.
   *
   * Typed as `EntryType` — the core's own type for written guidance — because
   * that is what actually reaches `noul`/`choice`/`score`: the `questions`
   * parameter is an opaque object, so nothing here narrows `instructions`, and
   * the upstream docs recommend an object or array of named fields whenever
   * definitions, contrasts or examples clarify the question. Claiming `string`
   * was a narrower promise than the code kept.
   */
  readonly instructions: EntryType
  /** choice/score only: the permitted answers, or the ordered scale levels. */
  readonly criteria?: Readonly<Record<string, string | null>>
  /**
   * noul only: what "true" and what "false" mean.
   *
   * This is the field the tool was missing. `criteria` was declared with the
   * choice/score shape and then dropped for nouls, so the upstream boundary
   * definition (new in API v1, and the thing that makes a 0.5 interpretable)
   * had a **usage rate of zero** here. `NoulCriteria` is the core's own type
   * for it, so a boundary that typechecks at this boundary cannot be rejected
   * by `noul` on the other side.
   */
  readonly boundary?: NoulCriteria
}

interface AskArgs {
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, QuestionInput>>
}

/**
 * The boundary a noul declared, under either spelling this tool has accepted.
 *
 * Two spellings, because `criteria` came first: a caller could declare
 * `criteria: { true: ..., false: ... }` — the upstream `NoulCriteria` shape
 * exactly — and have it silently ignored. That is the defect the core fixed on
 * its own side ("it accepted the field at the tool boundary and never forwarded
 * it"); this is the same fix at this boundary. `boundary` is the documented
 * spelling and wins when both are present.
 */
const noulBoundary = (id: string, question: QuestionInput): NoulCriteria | undefined => {
  const declared = question.boundary ?? fromOutcomeCriteria(id, question.criteria)
  if (declared === undefined) return undefined
  if (declared.true === undefined && declared.false === undefined) {
    throw new Error(
      `question "${id}" is a noul whose boundary describes neither outcome. Describe what "true" ` +
        'means, what "false" means, or both; with neither, the probability cannot be read.',
    )
  }
  return declared
}

/**
 * Read the upstream `NoulCriteria` spelling out of a noul's `criteria` map.
 *
 * A key that names no outcome is refused rather than dropped: for a noul,
 * `criteria` can only mean the two outcomes, so a map keyed by anything else is
 * a caller bug, and forwarding it would put a key on the wire that means
 * nothing. An empty map declares nothing and stays legal.
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

/** Convert the model-facing question shape into the request shape. */
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

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    provider: { type: 'string' as const, required: true as const },
    model: { type: 'string' as const, required: true as const },
    latencyMs: { type: 'number' as const, required: true as const },
    answers: { type: 'json' as const, required: true as const },
    usage: { type: 'json' as const },
    warning: { type: 'string' as const },
  },
  additionalProperties: false,
}

export const jevAskTool = (service: JevService) =>
  defineTool({
    name: 'jev_ask',
    description:
      'Ask TypeSafe Jev one or more typed questions about a single piece of state. Jev does not ' +
      'generate text: it returns a selected option and calibrated probabilities. Use it for ' +
      'judgments the rest of the work branches on — routing, classifying, scoring, deciding, ' +
      'triaging. Do NOT use it to write prose, explain, summarize, or generate code.\n\n' +
      'Question types: "noul" is yes/no and returns the probability of true; "choice" picks one ' +
      'of the criteria keys you declare; "score" places the state on an ordered scale whose levels ' +
      'you declare in ascending order. A noul may also declare "boundary" - what true means and ' +
      'what false means - which is worth supplying whenever the line between them is not obvious. ' +
      'Several questions in one call are answered against the same state and cost one round-trip, ' +
      'so batch what you need.\n\n' +
      'Put the evidence in "state" and the question in "instructions". For "choice", every key you ' +
      'declare in criteria is a value Jev may return, so declare exactly the outcomes you can act ' +
      'on. For "score", criteria is a map of level name to its description, written in ascending ' +
      'scale order, and it answers with a numeric "score" that may fall between levels, a "legend" ' +
      'mapping each level index to its description, and probabilities per level. ' +
      'This tool returns probabilities, not decisions — apply your own confidence threshold before ' +
      'acting, and treat a low-confidence answer as "unknown" rather than picking for it.',
    parameters: {
      state: {
        type: 'json',
        required: true,
        description:
          'The evidence Jev should judge: the text, record, or facts the questions are about. ' +
          'Be aware this is transmitted to TypeSafe when the live provider is configured.',
      },
      questions: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description:
          'Map of question id to question. Each question is { type, instructions, criteria?, ' +
          'boundary? }. `instructions` may be a string, or an object/array of named fields when ' +
          'definitions, contrasts or examples clarify the question. criteria is required for ' +
          'choice and score. For choice it is a map of permitted answer ' +
          'key to an optional description of that key. For score it is a map of scale level to its ' +
          'description, written in ascending order, with at least two levels: the order written is ' +
          'the scale, and reversing it reverses the meaning of every score. A noul may declare ' +
          '`boundary`, its description of what true and what false mean: true and false are the ' +
          'two possible values, each a string or a structured value. Declare one whenever the ' +
          'boundary between yes and no is not self-evident - including what silence in the ' +
          'evidence does NOT count as - because a noul whose boundary is unstated is one whose ' +
          '0.5 cannot be interpreted.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      // The one tool whose payload really is a `RenderedResult`: it returns
      // `renderResult(...)`, so the core's `summarize` reads the `answers` it
      // expects. `test/tools.test.ts` calls this projection for all three tools
      // - `jev_rank` shipped broken precisely because nothing did.
      presentationMeta: (_args, value) => ({ summary: summarize(asRendered(value), 'jev_ask') }),
    },
    // Read-only judgment: the questions are built from the arguments, the
    // provider call returns a value, and nothing here mutates shared state. Two
    // batches of questions commute - `JevService` only increments counters (and
    // records into a history, see the note in `index.ts`). Without this the
    // registry classifies every call `exclusive` and N independent judgments run
    // strictly one after another instead of in the host's parallel pool.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const typed = args as unknown as AskArgs
      const questions = toQuestions(typed.questions)
      // Validate locally before spending a call: a malformed batch is a caller
      // bug, and Jev rejecting it would look like an upstream failure.
      assertValidBatch(questions)
      const result = await service.ask({
        feature: FEATURE,
        state: typed.state,
        questions,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      return renderResult(result, Object.keys(questions))
    },
  })
