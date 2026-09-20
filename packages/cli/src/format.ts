/**
 * Formatting, and the JSON envelope every `--json` run prints.
 *
 * The envelope exists so a consumer needs one parser and one shape. A GitHub
 * Action, a `jq` pipeline and a shell script all read the same four guaranteed
 * fields — `ok`, `command`, `provider`, `model` — and find what a command has to
 * say under `data`. Without it every command would invent its own top level, and
 * the first thing a consumer would have to write is a per-command special case.
 *
 * Field names here are a contract. They are as stable as the exit codes: a
 * consumer branches on `data.verdict` or `data.decision`, so renaming either is a
 * breaking change to this package.
 */

import {
  summarize,
  type JevCallRecord,
  type JevEgressFacts,
  type RenderedAnswer,
  type RenderedResult,
} from 'jevcore'
import type { CliEnv } from './types.js'

/** The fields every `--json` document carries, whatever the command. */
export interface Envelope {
  /** Whether the command completed. `false` accompanies a non-zero exit code. */
  readonly ok: boolean
  readonly command: string
  /** Which provider answered, or `'none'` for a command that answered nothing. */
  readonly provider: string
  readonly model: string
  /** Wall-clock duration of the provider call, `0` when there was none. */
  readonly latencyMs: number
  /** Human-readable error, present only when `ok` is `false`. */
  readonly error?: string
  /** Machine-readable error code, present when one exists. */
  readonly errorCode?: string
  /** How to get out of this state, when there is a way. */
  readonly hint?: string
  /** The command's own payload. */
  readonly data?: unknown
}

/**
 * A JSON stringifier that omits keys whose value is `undefined`.
 *
 * `JSON.stringify` already drops `undefined` values, and the reason this is a
 * function at all is `JSON.stringify(value, null, 2)`'s interaction with it: the
 * replacer is called for array entries too, where `undefined` would otherwise
 * become `null` and change an array's length. Every array this CLI emits is built
 * with explicit entries, so nothing here relies on that difference — the helper
 * exists so each command can build an object with optional keys and not care.
 */
export const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/** One decimal place, so a probability reads as a number rather than as noise. */
export const formatProbability = (value: number | undefined): string =>
  value === undefined ? '?' : value.toFixed(2)

/** A percentage for the one-line summary, rounded to whole points. */
export const formatPercent = (value: number | undefined): string =>
  value === undefined ? '?' : `${Math.round(value * 100)}%`

/**
 * One rendered answer as a line of text.
 *
 * Leads with the probability because that is the number a reader came for, and
 * carries the band when the core reported one: a noul at 0.51 and a noul at 0.99
 * are both `true`, and the band is the difference between them. A question that
 * came back unanswered says so rather than showing a zero, which is the core's
 * own rule (`renderAnswer`) restated at the presentation layer.
 */
export const answerLine = (answer: RenderedAnswer): string => {
  if (answer.note !== undefined) return `${answer.question}: no answer (${answer.note})`
  const band = answer.band === undefined ? '' : ` band=${answer.band}`
  const payload =
    answer.score !== undefined
      ? `score=${answer.score} level=${answer.answer ?? '?'}`
      : `${answer.answer ?? '?'}`
  return (
    `${answer.question}: ${payload}  probability=${formatProbability(answer.probability)}` +
    ` (${formatPercent(answer.probability)})${band}`
  )
}

/**
 * A rendered result as text: what the core's `summarize` says, then each answer.
 *
 * `summarize` is called rather than replaced because it is the same line a
 * DeepSeek Harness tool card shows, so a reader moving between the two sees the
 * same sentence. It throws on a payload with no `answers` array, which is why
 * only an `ask` result may be passed here.
 */
export const resultLines = (headline: string, value: RenderedResult): readonly string[] => [
  summarize(value, headline),
  ...value.answers.map((answer) => `  ${answerLine(answer)}`),
]

/**
 * The single line that says what the mock means, for a human run.
 *
 * Printed whenever the provider is not transmitting. It restates the core's own
 * `warning` in the tool's own voice rather than inventing a second sentence: the
 * two are read side by side, and a CLI that paraphrased it would look like a
 * different claim.
 */
export const syntheticLine = (value: RenderedResult): string =>
  value.warning ?? 'provider=mock: these answers are synthetic and carry no judgment.'

/** Write one line, or nothing at all when the line is empty. */
export const write = (
  stream: CliEnv['out'],
  line: string,
): void => {
  // An empty write is skipped so a command that has nothing extra to say does
  // not emit a blank line a consumer would have to filter.
  if (line.length > 0) stream(line)
}

/** Write a blank line. Separators are explicit, so nobody counts them. */
export const blank = (stream: CliEnv['out']): void => stream('')

/**
 * What the egress layer did to one payload, for stderr.
 *
 * Reported on **every** answering command, not only when a cap fired. The
 * interesting case is the ordinary one: an operator who can see
 * `state=412c redactions=0` on a normal run learns what a normal run looks like,
 * and is therefore able to notice the run where the number is not normal. A note
 * that appears only when something was truncated is a note nobody has a baseline
 * for.
 *
 * Returns an empty array for a payload no service prepared, which is not a gap:
 * a provider called directly has no egress layer to report on, and inventing
 * zeroes for it would claim a measurement nobody made.
 */
export const egressLines = (facts: JevEgressFacts | undefined): readonly string[] => {
  if (facts === undefined) return []
  const redactions =
    facts.redactions === 0
      ? 'redactions=0'
      : `redactions=${facts.redactions} fields=[${facts.redactedFields.join(', ')}]`
  return [
    `egress: state=${facts.stateChars}c questions=${facts.questionsChars}c ${redactions}` +
      (facts.truncated ? ' TRUNCATED: Jev judged less than you sent' : ''),
  ]
}

/**
 * What egress did, read from a service's own call history.
 *
 * The gate is the one command that does not hold a result: `createSafetyGate`
 * returns a decision and keeps the result to itself, so the facts have to come
 * from the service's record of the call. That record is a summary rather than the
 * `JevEgressFacts` the other commands read, which is why this is a second
 * function rather than an argument to {@link egressLines} — the two shapes are
 * genuinely different, and flattening them would mean guessing at fields the
 * record does not carry.
 *
 * Returns an empty array when the gate made no call at all, which is the common
 * case: a call to a tool the gate does not recognise never reaches a provider, and
 * reporting zeroes for it would claim a measurement nobody made.
 */
export const callEgressLines = (record: JevCallRecord | undefined): readonly string[] => {
  if (record === undefined) return []
  const redactions =
    record.redactions === 0
      ? 'redactions=0'
      : `redactions=${record.redactions} rules=[${record.redactionRules.join(', ')}]`
  return [
    `egress: ${record.feature} state=${record.stateChars}c ${redactions} ok=${record.ok}` +
      (record.truncated ? ' TRUNCATED: Jev judged less than you sent' : ''),
  ]
}
