/**
 * Public types for the Jev decision layer.
 *
 * Jev is TypeSafe's System One model: it does not generate prose. It answers
 * typed questions and returns calibrated probabilities. These types model
 * exactly that surface — three primitives, one state, one batch of questions.
 */

/** A lossless-JSON value. The only thing that may cross the wire as `state`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The shape of a thing that can serve a System One request. */
export interface JevProvider {
  /**
   * Answer one batch of questions over one state.
   *
   * Implementations must honour `signal` and must never invent an answer: a
   * provider that cannot answer returns a {@link JevProviderError}, and the
   * service surfaces that failure instead of a fabricated confidence.
   */
  answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult>
  /** Human-readable provider identity, used by the startup egress report. */
  readonly id: string
}

/** One batch: a state plus the questions asked about it. */
export interface JevRequest {
  /** The evidence Jev judges. Redacted and truncated before it leaves. */
  readonly state: JsonValue
  /** Question id to question. Ids are the keys of {@link JevResult.answers}. */
  readonly questions: Readonly<Record<string, JevQuestion>>
  /** Model name; the provider may override its own default. */
  readonly model?: string
}

/** A yes/no question. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

/** A one-of-N question. Criteria keys are the permitted answers. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string | null>>
}

/**
 * An ordered-scale question.
 *
 * `criteria` is an ordered array, not a keyed map, because a scale is ordered
 * and a map is not: Jev scores position `0..n-1`, so the sequence *is* the
 * rubric. This mirrors `ScoreCriteria` in the official SDK, which types it as
 * `readonly [EntryType, EntryType, ...EntryType[]]`.
 *
 * **Every level must be described, and there must be 2 to 10 of them.** The live
 * API rejects a `null` entry with 422 (`criteria.1.str: Input should be a valid
 * string`) even though the published docs and the SDK type both imply `null` is
 * allowed — verified against the real endpoint. `''` is a legal way to hold a
 * position without describing it. {@link scoreCriteriaArray} enforces all of
 * this, because a level's position is its score and dropping one would silently
 * renumber the rest.
 */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/**
 * Jev's answer to one `noul` question.
 *
 * **There is no `confidence` here, on purpose.** It is tempting to model a
 * yes/no answer as a two-outcome Choice and carry a confidence alongside it, but
 * TypeSafe is explicit that this field does not exist for Noul — twice in the
 * docs ("Noul answers don't carry one"; "no separate `confidence` value for a
 * Noul ... the single `noul` value describes it completely") and in both SDK
 * schemas, where `NoulResponse` declares only `noul` and `type`. Verified against
 * the live API: a noul answer comes back as `{"noul":0.91,"type":"noul"}`.
 *
 * Confidence is a *concentration statistic over a multi-outcome distribution*.
 * A two-outcome distribution has nothing for it to summarise, and the docs warn
 * that a noul and its negation are not even additive across separate questions.
 * So an answer's strength is `max(noul, 1 - noul)` and nothing else.
 */
export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability of `true`, in `[0, 1]`. */
  readonly noul: number
}

/** Jev's answer to one `choice` question. */
export interface CategoricalAnswer {
  readonly type: 'choice'
  /** The selected criterion key. */
  readonly choice: string
  /** Probability per criterion key. */
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
}

/**
 * Jev's answer to one `score` question.
 *
 * The expected score is a number that may fall *between* integer levels, so the
 * rubric travels back with it: `legend` maps each index to the level's
 * description and `probabilities` maps each index to its probability. Keys are
 * stringified indices (`"0"`, `"1"`, …), matching the SDK's `ScoreLegend` and
 * `ScoreResponse`.
 */
export interface ScoreAnswer {
  readonly type: 'score'
  /** Expected score, which may fall between integer rubric levels. */
  readonly score: number
  /** Rubric index to its description, as reported by the provider. */
  readonly legend: Readonly<Record<string, string>>
  /** Probability per rubric index. */
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
}

export type JevAnswer = NoulAnswer | CategoricalAnswer | ScoreAnswer

/**
 * Token and cost accounting as reported by the provider.
 *
 * A type alias rather than an interface, like every other type here that
 * crosses into a tool output: only an alias receives the implicit index
 * signature that makes it assignable to {@link JsonValue}.
 */
export type JevUsage = {
  inputTokens?: number
  outputTokens?: number
  /** Estimated or reported cost in US dollars. */
  costUsd?: number
}

/** One complete System One response. */
export interface JevResult {
  readonly model: string
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage?: JevUsage
  /** Wall-clock duration of the provider call, in milliseconds. */
  readonly latencyMs: number
  /**
   * Which provider produced this result. Always populated, so a caller can
   * never mistake a mock answer for a live one.
   */
  readonly provider: string
}

/**
 * A provider failure. Carries a machine-readable code so gates can fail closed
 * on the reason rather than on a message string.
 */
export class JevProviderError extends Error {
  override readonly name = 'JevProviderError'

  constructor(
    message: string,
    readonly code: JevErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export type JevErrorCode =
  /** No credential could be resolved. */
  | 'no-credential'
  /** The configured provider is not available (e.g. the SDK is not installed). */
  | 'provider-unavailable'
  /** The upstream API rejected the request. */
  | 'upstream-rejected'
  /** The upstream API could not be reached, or the call timed out. */
  | 'upstream-unreachable'
  /** The response was not shaped like a System One response. */
  | 'malformed-response'

/** Redaction rule kinds, mirroring the shipped default ruleset. */
export interface RedactionSummary {
  /** Number of values replaced by a rule during one redaction pass. */
  readonly redactions: number
  /** Rule names that fired, deduplicated. */
  readonly rules: readonly string[]
}

/**
 * The result of redacting one state value: the value that may leave the
 * machine, plus a summary of what was removed.
 */
export interface Redacted<T> {
  readonly value: T
  readonly summary: RedactionSummary
}
