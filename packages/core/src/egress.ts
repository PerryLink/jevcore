/**
 * The egress contract.
 *
 * Every existing third-party Jev plugin for DSH has the same failure: a module
 * labelled "guard" or "gate" quietly ships prompts, tool arguments, or tool
 * results to a third party, and the README does not say so. Operators discover
 * it by reading source.
 *
 * This module exists to make that impossible here. It is the single place that
 * decides what may leave the machine, and it can answer, at any moment:
 *
 *   - which features transmit, and which are merely available;
 *   - for each transmitting feature, which fields leave and under which caps;
 *   - what a specific request is about to send, measured before it is sent.
 *
 * Nothing in this plugin may call a provider without first passing through
 * {@link measure}. The tests assert that.
 */

import type { JevQuestion, JsonValue } from './types.js'

/** Stable feature identifiers. These appear in the startup report and metrics. */
export const EGRESS_FEATURES = [
  'tool:jev_ask',
  'tool:jev_rank',
  'tool:jev_check',
  'gate:safety',
  'gate:context',
] as const

export type EgressFeature = (typeof EGRESS_FEATURES)[number]

/** One field a feature would send, and the cap applied to it. */
export interface EgressField {
  /** Field name as it appears in the System One request. */
  readonly field: string
  /** Character cap applied before sending. */
  readonly maxChars: number
  /** What this field carries, in operator-facing language. */
  readonly carries: string
}

/**
 * What each feature is capable of sending.
 *
 * These are declarations, not switches — {@link EgressContract.enabled} decides
 * whether a feature may run at all. Keeping them separate means the report can
 * tell an operator what a feature *would* send before they turn it on.
 */
export const EGRESS_FIELDS: Readonly<Record<EgressFeature, readonly EgressField[]>> = {
  'tool:jev_ask': [
    {
      field: 'state',
      maxChars: 16_000,
      carries: 'the arguments the model passed to jev_ask, after redaction',
    },
    {
      field: 'questions',
      maxChars: 4_000,
      carries: 'the question text the model wrote',
    },
  ],
  'tool:jev_rank': [
    {
      field: 'state',
      maxChars: 16_000,
      carries: 'the query plus every candidate the model passed, after redaction',
    },
    { field: 'questions', maxChars: 4_000, carries: 'the ranking criterion the model wrote' },
  ],
  'tool:jev_check': [
    {
      field: 'state',
      maxChars: 16_000,
      carries: 'the claim and its evidence, after redaction',
    },
    { field: 'questions', maxChars: 4_000, carries: 'the fixed verification questions' },
  ],
  'gate:safety': [
    {
      field: 'state',
      maxChars: 8_000,
      carries: 'the tool name, its arguments, and the session working directory',
    },
    { field: 'questions', maxChars: 2_000, carries: 'the fixed hazard questions' },
  ],
  'gate:context': [
    {
      field: 'state',
      maxChars: 6_000,
      carries: 'a tool result the agent just received, after redaction',
    },
    { field: 'questions', maxChars: 2_000, carries: 'the fixed relevance questions' },
  ],
}

/** A startup-report row: one feature and whether it will transmit. */
export interface EgressLine {
  readonly feature: EgressFeature
  readonly enabled: boolean
  readonly fields: readonly EgressField[]
}

/** A measured, ready-to-send payload. Produced only by {@link EgressContract.measure}. */
export interface MeasuredPayload {
  readonly feature: EgressFeature
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, JevQuestion>>
  /** Serialized size of `state`, after redaction and capping. */
  readonly stateChars: number
  /** Serialized size of `questions`, after capping. */
  readonly questionsChars: number
  /** True when a cap actually removed content. */
  readonly truncated: boolean
  /**
   * Characters of `state` discarded by the cap, when it fired.
   *
   * Reported so a caller can say how much Jev did not see, rather than only
   * that something was missing.
   */
  readonly stateCharsDropped?: number
  /** Redaction rules that fired while preparing this payload. */
  readonly redactionRules: readonly string[]
  /** Count of values replaced while preparing this payload. */
  readonly redactions: number
  /**
   * Field names whose values were replaced, deduplicated and sorted.
   *
   * `'[value]'` stands for a replacement made inside free text. Carried here
   * because `redactionRules` answers "which rule fired" and an operator usually
   * needs "what was removed" — those are different questions.
   */
  readonly redactedFields: readonly string[]
  /** Replacements made inside free text, where no field name applies. */
  readonly redactedValues: number
}

/** Everything the contract needs to decide what may leave. */
export interface EgressSettings {
  /**
   * Whether the configured provider can reach the network.
   *
   * This is a *fact about the provider*, reported to the operator, not a gate:
   * the offline mock answers through the same service without transmitting
   * anything. Transmission is governed by {@link EgressSettings.enabled}, which
   * is false for every gated feature unless configuration turns it on.
   */
  readonly transmitting: boolean
  /** Feature to whether it may transmit content. */
  readonly enabled: Readonly<Record<EgressFeature, boolean>>
}

/** The endpoint a live provider posts to, for the report. */
export type EndpointLabel = string

/** Thrown when a feature is asked to transmit while it is not enabled. */
export class EgressDeniedError extends Error {
  override readonly name = 'EgressDeniedError'

  constructor(readonly feature: EgressFeature) {
    super(
      `egress for "${feature}" is not enabled. This feature would send content to a third ` +
        `party. Enable it in the plugin config if that is what you want.`,
    )
  }
}

/**
 * A payload field exceeded its declared cap and could not be reduced safely.
 *
 * `state` is truncated rather than refused, because a shorter state is still a
 * valid state — but only when the truncation leaves something behind. A cap so
 * small that even the truncation envelope cannot fit inside it is refused, since
 * the alternative is sending a document whose only content is the word
 * "truncated": a payload with no state in it, presented to the model as if it
 * were one.
 *
 * `questions` is refused at any size, because the question map is what answers
 * are keyed by — a truncated map would yield answers that cannot be mapped back
 * to the questions that produced them.
 */
export class EgressTooLargeError extends Error {
  override readonly name = 'EgressTooLargeError'

  constructor(
    readonly feature: EgressFeature,
    readonly field: string,
    readonly maxChars: number,
    readonly actualChars: number,
    /**
     * Why this exceeded the cap. Defaults to the questions explanation, which is
     * what every existing throw site meant; the state cap passes its own.
     */
    reason?: string,
  ) {
    super(
      reason ??
        `"${field}" for "${feature}" is ${actualChars} characters, over the declared limit of ` +
          `${maxChars}. Send fewer or smaller questions. This is refused rather than truncated ` +
          `because answers are keyed by question, so a shortened question map would return ` +
          `answers that cannot be matched to what was asked.`,
    )
  }
}

export class EgressContract {
  /**
   * @param settings - which features may transmit, and whether the provider can
   *   reach the network at all.
   * @param endpoint - the host a live provider posts to, for the report.
   * @param maxStateChars - optional operator override for the per-feature
   *   `state` cap. Without this, a configured limit would be parsed, typed,
   *   documented, and then ignored — the exact defect this project exists to
   *   avoid in other plugins. `undefined` leaves each feature's declared cap.
   */
  constructor(
    private readonly settings: EgressSettings,
    private readonly endpoint: EndpointLabel,
    private readonly maxStateChars?: number | undefined,
  ) {}

  /**
   * Whether a feature may run and transmit content right now.
   *
   * Deliberately does not consult `transmitting`: an offline provider makes no
   * network call whatever this returns, and gating the mock behind it would
   * leave the service unusable in exactly the configuration that is safest.
   */
  allows(feature: EgressFeature): boolean {
    return this.settings.enabled[feature] === true
  }

  /** Throw unless `feature` may transmit. Call before any provider invocation. */
  assert(feature: EgressFeature): void {
    if (!this.allows(feature)) throw new EgressDeniedError(feature)
  }

  /**
   * The effective field set for a feature: the declared fields, with the
   * operator's state cap applied when one was configured.
   */
  fieldsOf(feature: EgressFeature): readonly EgressField[] {
    const declared = EGRESS_FIELDS[feature]
    if (this.maxStateChars === undefined) return declared
    return declared.map((field) =>
      field.field === 'state' ? { ...field, maxChars: this.maxStateChars as number } : field,
    )
  }

  /** One row per feature, in stable order, using the effective caps. */
  lines(): readonly EgressLine[] {
    return EGRESS_FEATURES.map((feature) => ({
      feature,
      enabled: this.allows(feature),
      fields: this.fieldsOf(feature),
    }))
  }

  /**
   * Prepare and measure one payload.
   *
   * Returns the capped, redacted values alongside their measured sizes so the
   * caller can log exactly what is leaving rather than describing it from
   * memory. `redact` is injected so this module stays free of policy.
   */
  measure(input: {
    readonly feature: EgressFeature
    readonly state: JsonValue
    readonly questions: Readonly<Record<string, JevQuestion>>
    readonly redact: (value: JsonValue) => {
      readonly value: JsonValue
      readonly summary: {
        readonly redactions: number
        readonly rules: readonly string[]
        readonly fields: readonly string[]
        readonly values: number
      }
    }
  }): MeasuredPayload {
    this.assert(input.feature)
    // The effective caps, so a configured `maxStateChars` actually bounds what
    // leaves and not merely what the report claims.
    const limits = this.fieldsOf(input.feature)
    const stateLimit = limits.find((field) => field.field === 'state')?.maxChars ?? 16_000
    const questionsLimit = limits.find((field) => field.field === 'questions')?.maxChars ?? 4_000

    // Redaction runs over **everything that leaves**, not just `state`.
    //
    // It used to cover `state` alone, which was a real leak: the ranking tool
    // builds one question per candidate, and candidate text is model-authored, so
    // a caller passing a record containing a credential had it transmitted
    // verbatim from inside a question. Verified before the fix — the same string
    // was redacted in `state` and left intact in `questions`. The contract's whole
    // claim is that what leaves is the redacted content, and a question is content.
    const { value: safeState, summary } = input.redact(input.state)
    const { value: safeQuestions, summary: questionSummary } = input.redact(
      input.questions as unknown as JsonValue,
    )
    const stateText = JSON.stringify(safeState) ?? 'null'
    const questionsText = JSON.stringify(safeQuestions) ?? '{}'

    // `state` is capped by truncation; `questions` is refused instead. The
    // difference is what truncation would cost: a shortened state is still a
    // state, but the question map is what the *answers* are keyed by, so cutting
    // it down would produce a response this package could not map back — answers
    // for questions that were never asked, in place of the ones that were.
    // Refusing is the only option that does not quietly change the meaning of the
    // result. The declared limit used to be measured and reported without ever
    // being enforced, which is the exact defect this module's header names.
    if (questionsText.length > questionsLimit) {
      throw new EgressTooLargeError(input.feature, 'questions', questionsLimit, questionsText.length)
    }

    const cappedState = capJsonText(stateText, stateLimit, input.feature)

    return {
      feature: input.feature,
      state: cappedState.value,
      questions: safeQuestions as unknown as Readonly<Record<string, JevQuestion>>,
      stateChars: cappedState.text.length,
      questionsChars: questionsText.length,
      truncated: cappedState.truncated,
      ...(cappedState.dropped === undefined ? {} : { stateCharsDropped: cappedState.dropped }),
      // Both fields contribute, so the report reflects everything removed rather
      // than only what was removed from the state.
      redactionRules: [...new Set([...summary.rules, ...questionSummary.rules])],
      redactions: summary.redactions + questionSummary.redactions,
      redactedFields: [...new Set([...summary.fields, ...questionSummary.fields])].sort(),
      // Counted rather than derived from `fields`: `'[value]'` appears once in
      // that set however many free-text replacements happened.
      redactedValues: summary.values + questionSummary.values,
    }
  }

  /**
   * The human-readable audit line.
   *
   * This is printed once at load and is the plugin's central promise: an
   * operator can read one line and know whether anything leaves their machine.
   */
  reportLines(): readonly string[] {
    const lines: string[] = []
    if (!this.settings.transmitting) {
      lines.push(
        `[jevcore] provider=mock  endpoint=none  egress=OFF  ` +
          `(no network calls will be made; every answer is synthetic)`,
      )
      // Features may still be switched on in configuration. Saying so keeps
      // the report honest about what would happen if the provider changed.
      for (const line of this.lines()) {
        if (line.enabled) {
          lines.push(
            `[jevcore]   armed  ${line.feature}  ` +
              `(runs against the offline mock; would transmit if the provider became "live" or "openrouter")`,
          )
        }
      }
      return lines
    }

    lines.push(`[jevcore] provider=live  endpoint=${this.endpoint}  egress=ON`)
    for (const line of this.lines()) {
      if (!line.enabled) {
        lines.push(`[jevcore]   off    ${line.feature}`)
        continue
      }
      const fields = line.fields.map((field) => `${field.field}<=${field.maxChars}c`).join(' ')
      lines.push(`[jevcore]   SENDS  ${line.feature}  { ${fields} }`)
    }
    lines.push(
      `[jevcore]   redaction is best-effort; it removes named fields and known secret ` +
        `shapes, and cannot recognise an unrecognised secret in free text`,
    )
    return lines
  }
}

/**
 * Cap a serialized JSON document.
 *
 * A hard character slice would produce invalid JSON, so an over-long value is
 * replaced by a syntactically valid truncation envelope carrying the original
 * size. Jev then judges a smaller state rather than receiving a parse error.
 *
 * Three properties, each of which the previous implementation only appeared to
 * have:
 *
 *  1. **The envelope fits inside the cap.** It used to reserve 20 characters for
 *     its own markers, which can be longer than that, so `state<=16000c` in the
 *     startup report was not true of what left the machine.
 *  2. **The envelope still holds content.** When the cap was smaller than the
 *     envelope, the head was sliced to zero characters and the payload that left
 *     was `{"[truncated]":true,…,"[head]":""}` — a document whose entire "state"
 *     is the word *truncated*. Jev would answer a question about that and the
 *     answer would be reported as though it were about the caller's state. That
 *     is refused instead.
 *  3. **The cap holds for escape-heavy content too.** This is the subtle one. The
 *     head is a slice of the *serialized* text, so a head full of backslashes —
 *     Windows paths, a code snippet, JSON-in-JSON — has every backslash escaped
 *     *again* when the envelope is serialized. Slicing the head to
 *     `maxChars - overhead` characters therefore produced envelopes well over the
 *     cap: measured at 692 characters for a cap of 500, and 23_344 for a cap of
 *     16_000. The head length is found by bisection on the *serialized* envelope
 *     instead, so the number that leaves is the number the cap promised.
 */
const capJsonText = (
  text: string,
  maxChars: number,
  feature: EgressFeature,
): { text: string; value: JsonValue; truncated: boolean; dropped?: number } => {
  if (text.length <= maxChars) {
    return { text, value: JSON.parse(text) as JsonValue, truncated: false }
  }

  const envelopeFor = (head: string): JsonValue => ({
    '[truncated]': true,
    '[originalChars]': text.length,
    '[maxChars]': maxChars,
    '[head]': head,
  })
  const sizeOfHead = (headChars: number): number =>
    JSON.stringify(envelopeFor(text.slice(0, headChars))).length

  // How small a cap this payload can be truncated into at all, given that the
  // head carries whatever the content's own escaping costs.
  const minimumViableCap = sizeOfHead(MIN_TRUNCATED_HEAD_CHARS)
  if (minimumViableCap > maxChars) {
    throw new EgressTooLargeError(
      feature,
      'state',
      maxChars,
      text.length,
      `"state" for "${feature}" is ${text.length} characters, and the limit of ${maxChars} is ` +
        `too small to hold even a truncated state: an envelope carrying one character of content ` +
        `needs ${minimumViableCap} characters for this payload, leaving nothing to judge. Raise ` +
        `maxStateChars to at least ${minimumViableCap}, or send a smaller state. This is refused ` +
        `rather than truncated because a payload whose only content is the word "truncated" is ` +
        `not a shorter state — it is no state at all, and Jev would answer about it as though it ` +
        `were the real one.`,
    )
  }

  // The largest head that still fits. Serialized size grows with head length, so
  // bisection finds it exactly; a head longer than the cap can never fit, which
  // bounds the search.
  let low = MIN_TRUNCATED_HEAD_CHARS
  let high = Math.min(text.length, maxChars)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (sizeOfHead(mid) <= maxChars) low = mid
    else high = mid - 1
  }

  const headChars = low
  const value = envelopeFor(text.slice(0, headChars))
  const serialized = JSON.stringify(value)
  return {
    text: serialized,
    value,
    truncated: true,
    // What did not fit, which is not quite `text.length - maxChars`: the
    // envelope's own markers are part of what was sent, and the cap is a
    // character count rather than a content count.
    dropped: text.length - headChars,
  }
}

/**
 * The fewest characters of original content a truncation envelope must carry to
 * be worth sending.
 *
 * One. The envelope's whole purpose is to hand Jev *some* of the state while
 * saying that it is not all of it; a head of zero characters hands it nothing,
 * and the payload stops being a state. See {@link capJsonText}.
 */
export const MIN_TRUNCATED_HEAD_CHARS: number = 1
