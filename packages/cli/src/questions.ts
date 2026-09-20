/**
 * The `--questions` payload: a JSON object of question definitions, turned into
 * the batch `JevService` takes.
 *
 * **This is a deliberate second copy of `packages/mcp/src/tools.ts`'s
 * conversion**, and the duplication is worth stating rather than hiding. There
 * are three ways to avoid it and all three are worse:
 *
 *  - depend on `jevcore-mcp`, which would pull an MCP server and its transport
 *    into a command-line tool's dependency tree for one pure function;
 *  - lift it into `jevcore`, which is a change to a package that is not this
 *    one's to make, for a conversion only two adapters need;
 *  - accept a slightly different JSON shape here, which is the worst option: the
 *    same capability behind two entry points must not accept two spellings, and a
 *    caller who moves a question file from an MCP client to this CLI would
 *    discover the difference by getting wrong answers rather than an error.
 *
 * So the shape is identical and a test asserts it against the MCP server's own
 * accepted documents. The rules, both of which exist because the alternative was
 * a silent misreading:
 *
 *  - a noul's two outcomes may be spelled `boundary` (documented) or `criteria`
 *    (the earlier spelling), and `boundary` wins;
 *  - a `criteria` map on a noul that names anything other than `true`/`false` is
 *    refused, because for a noul `criteria` can only mean the two outcomes.
 */

import {
  assertValidBatch,
  choice,
  noul,
  score,
  type EntryType,
  type JevQuestion,
  type JsonValue,
  type NoulCriteria,
} from 'jevcore'
import { asObject, describe } from './input.js'
import { UsageError } from './usage.js'

/**
 * The `EntryType` position of a question, validated at this boundary.
 *
 * Upstream accepts a string, an array of JSON values, an object, or `null` — the
 * same set `jevcore`'s `EntryType` models. A bare number or boolean is not one of
 * them, so it is refused here with the offending question named rather than sent
 * and rejected by the API after a round trip.
 */
const asEntry = (value: JsonValue | undefined, where: string): EntryType => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value as { readonly [key: string]: JsonValue }
  throw new UsageError(
    `${where} must be a string, an array, an object or null — got ${describe(value)}. ` +
      'Structured guidance is worth using when definitions, contrasts or examples clarify the ' +
      'question; a bare number or boolean is not guidance.',
  )
}

/** The two outcomes of a noul, from whichever spelling declared them. */
const boundaryOf = (id: string, question: Record<string, JsonValue>): NoulCriteria | undefined => {
  const explicit = question.boundary
  if (explicit !== undefined && explicit !== null) {
    const map = asObject(explicit, `question "${id}" boundary`)
    const criteria: { true?: EntryType; false?: EntryType } = {}
    if (map.true !== undefined) criteria.true = asEntry(map.true, `question "${id}" boundary.true`)
    if (map.false !== undefined) criteria.false = asEntry(map.false, `question "${id}" boundary.false`)
    return criteria
  }

  const legacy = question.criteria
  if (legacy === undefined || legacy === null) return undefined
  const map = asObject(legacy, `question "${id}" criteria`)
  const keys = Object.keys(map)
  if (keys.length === 0) return undefined
  const alien = keys.filter((key) => key !== 'true' && key !== 'false')
  if (alien.length > 0) {
    throw new UsageError(
      `question "${id}" is a noul but its criteria keys (${alien.join(', ')}) name no outcome. A ` +
        'noul boundary says what "true" and what "false" mean: declare it as ' +
        '`"boundary": { "true": ..., "false": ... }` (or `"criteria": { "true": ..., "false": ... }`). ' +
        'A keyed criteria map is for choice and score.',
    )
  }
  const criteria: { true?: EntryType; false?: EntryType } = {}
  if (map.true !== undefined) criteria.true = asEntry(map.true, `question "${id}" criteria.true`)
  if (map.false !== undefined) criteria.false = asEntry(map.false, `question "${id}" criteria.false`)
  return criteria
}

/** One question definition to one core question. */
const toQuestion = (id: string, raw: JsonValue): JevQuestion => {
  const question = asObject(raw, `question "${id}"`)
  const type = question.type
  const instructions = asEntry(question.instructions, `question "${id}" instructions`)

  if (type === 'noul') {
    return noul(instructions, boundaryOf(id, question))
  }
  if (type === 'choice') {
    if (question.boundary !== undefined) {
      throw new UsageError(
        `question "${id}" is a choice but declares a noul "boundary". A boundary says what "true" ` +
          'and what "false" mean and exists only for a noul; a choice declares its permitted ' +
          'answers, and a score its ordered levels, both in "criteria".',
      )
    }
    return choice(instructions, asObject(question.criteria ?? {}, `question "${id}" criteria`) as Readonly<Record<string, EntryType>>)
  }
  if (type === 'score') {
    if (question.boundary !== undefined) {
      throw new UsageError(
        `question "${id}" is a score but declares a noul "boundary". A score declares its ordered ` +
          'levels in "criteria", where position in the map is the score.',
      )
    }
    const criteria = asObject(question.criteria ?? {}, `question "${id}" criteria`)
    const levels: Record<string, string | null | undefined> = {}
    for (const [level, description] of Object.entries(criteria)) {
      // `null` is deliberately passed through rather than refused here: the core
      // refuses it with the message that explains why (a level's position is its
      // score, so dropping one renumbers the rest), and a second message saying
      // the same thing would be a second place to keep in step.
      levels[level] = typeof description === 'string' ? description : null
    }
    return score(instructions, levels)
  }

  throw new UsageError(
    `question "${id}" has type ${describe(type)}, which is not a question type. Use "noul" for a ` +
      'yes/no question, "choice" to pick one of a fixed set, or "score" to place the state on an ' +
      'ordered scale.',
  )
}

/**
 * Convert the whole document, then validate the batch.
 *
 * Validation is the core's own `assertValidBatch`, so a batch this CLI accepts is
 * a batch the API accepts: an empty batch, a level map with one level, an
 * undeclared criteria value and an empty instruction are all refused here with
 * the core's wording rather than sent and rejected after a round trip.
 */
export const toQuestions = (
  document: Readonly<Record<string, JsonValue>>,
): Record<string, JevQuestion> => {
  const questions: Record<string, JevQuestion> = {}
  for (const [id, raw] of Object.entries(document)) {
    questions[id] = toQuestion(id, raw)
  }
  assertValidBatch(questions)
  return questions
}
