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

import type {
  JevEgressFacts,
  JevQuestion,
  JevResult,
  JsonValue,
  RedactionSummary,
} from './types.js'

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
  /**
   * The redacted question map, keyed by the ids the caller declared.
   *
   * Only the ids are protocol identifiers — the answer map is keyed by them — so
   * only they are exempt from redaction. Everything *inside* a question is
   * content and is redacted with the full ruleset, key rules included.
   */
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

/**
 * Redaction changed the shape of the question map, which it must never do.
 *
 * The map is redacted one question at a time and re-keyed under the ids it
 * arrived with, so nothing on the ordinary path can raise this: a value rule
 * rewrites strings inside a question, a key rule replaces the value under a
 * secret-named key, and neither touches an id. It is a runtime check rather than
 * a comment because the failure it guards is both silent and severe, and the
 * implementation this replaced produced it twice.
 *
 * The first time, redaction ran over the whole map with the key rules on. One of
 * this package's own hazard ids is `credential_exposure`, which `/credential/i`
 * matches, so that question was replaced by the string `"[redacted]"` before
 * transmission: a malformed request on the live route, a `TypeError` from the
 * offline mock, and in both cases an error the safety gate turns into a
 * conservative `ask`. A gate that had stopped judging anything looked exactly
 * like a gate being careful.
 *
 * The second time, the key rules were withheld from the whole question subtree to
 * keep those ids intact — which left a secret named by its key *inside* a
 * question unredacted. That is why the fix is structural, in {@link
 * EgressContract.measure}: the ids are re-keyed rather than redacted, so no rule
 * needs to be withheld from any part of the payload, and this check is what makes
 * a regression loud rather than silent.
 *
 * What it does **not** cover: a value nested past redaction's own `maxDepth` is
 * replaced by that module's depth marker, which is documented behaviour of
 * `redact` rather than a reshape this contract can see. The question is still an
 * object; an instruction nested that deeply arrives shorter than it was written.
 */
export class EgressShapeError extends Error {
  override readonly name = 'EgressShapeError'

  constructor(
    readonly feature: EgressFeature,
    readonly field: string,
    /**
     * The ids that came back wrong, or — when the map itself was not an object —
     * nothing, because there were no ids to name.
     */
    readonly ids: readonly string[],
  ) {
    super(
      `redaction reshaped "${field}" for "${feature}": ` +
        (ids.length === 0
          ? 'the question map did not come back as a non-null, non-array object'
          : `${ids.join(', ')} did not come back as one question object per declared id`) +
        `. Question ids key the answers, so they have to survive redaction intact, and the ` +
        `contract re-keys every redacted question under the id it arrived with for exactly that ` +
        `reason. A reshaped map is a malformed request on the live route and a type error on the ` +
        `offline mock, and the safety gate turns both into the same \`ask\` a careful gate ` +
        `produces — so the failure would otherwise be invisible.`,
    )
  }
}

/**
 * Redaction, as this contract uses it: the shape of the function it is handed.
 *
 * The optional `keyRules` parameter is part of `redact`'s own signature and is
 * passed through for compatibility with the implementation this replaced.
 * `measure` calls this with no options at all, because no part of the payload
 * needs a rule withheld from it any more — see {@link EgressContract.measure}.
 */
export type EgressRedactor = (
  value: JsonValue,
  options?: { readonly keyRules?: readonly RegExp[] },
) => {
  readonly value: JsonValue
  readonly summary: RedactionSummary
}

/**
 * Whether a value can carry question ids: an object, not `null`, not an array.
 *
 * An array is rejected deliberately. `Object.entries` walks one happily, so an
 * array-shaped map used to pass every check and arrive at the provider as a JSON
 * array where an object belongs.
 */
const isQuestionMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The egress facts to stamp onto anything built from a result, or nothing.
 *
 * `truncated` is written only when it happened and `egress` only when the result
 * carries one, so a result from a provider called directly keeps exactly the
 * shape it had before these fields existed.
 *
 * The two arrays are copied rather than shared. They arrive on a result the
 * service has already returned to someone else, and a consumer that pushed to one
 * in place would otherwise be editing the record of what was sent.
 *
 * Shared by both gates, which rebuild a `JevResult` into a decision and used to
 * drop these fields entirely: a call judged on a `[truncated]` envelope then read
 * exactly like a call judged on the whole state.
 */
export const egressFactsOf = (
  result: JevResult,
): { readonly truncated?: boolean; readonly egress?: JevEgressFacts } => ({
  ...(result.truncated === true ? { truncated: true } : {}),
  ...(result.egress === undefined
    ? {}
    : {
        egress: {
          ...result.egress,
          redactedFields: [...result.egress.redactedFields],
          redactionRules: [...result.egress.redactionRules],
        },
      }),
})

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
    /**
     * Redaction, injected so this module stays free of policy.
     *
     * See {@link EgressRedactor}: the contract now calls it once per question,
     * with no options at all.
     */
    readonly redact: EgressRedactor
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

    // The question map gets the full ruleset too — key rules included — and is
    // re-keyed under the ids it arrived with. Both halves of that are defect
    // fixes, and they were fixes in opposite directions.
    //
    // **Every part of a question is content.** Withholding the key rules from the
    // whole question subtree to keep the ids intact meant a secret named by its
    // key *inside* a question was no longer redacted at all:
    // `noul({ context: 'deploy notes', password: '…' })` reached the provider
    // verbatim and `measured.redactions` counted nothing, while the same string
    // under the same name in `state` was replaced. `dsh/src/ask.ts` passes
    // caller-shaped `instructions`, `criteria` and `boundary` straight through, so
    // that is a live path and not a hypothetical one.
    //
    // **Only the ids are protocol identifiers.** The answer map is keyed by them,
    // and a key rule that matches an id destroys the map: one of this package's
    // own hazard ids is `credential_exposure`, which `/credential/i` matches, so
    // redacting the map as a whole replaced that question with the string
    // `"[redacted]"` before transmission — 160 characters of a declared
    // 1,774-character payload, gone. Both consequences were invisible. The live
    // route is sent a string where a question object belongs; the offline route —
    // the default, and what every test ran against — throws `TypeError: Cannot
    // convert undefined or null to object`. The safety gate catches provider
    // errors and routes them through `onUndecided`, whose default is `ask`, so a
    // gate that had stopped judging anything produced exactly the decision a
    // careful gate produces.
    //
    // Re-keying is what lets both properties hold at once: the id is taken from
    // the input rather than from the redacted output, so no rule has to be
    // withheld from anything.
    if (!isQuestionMap(input.questions)) {
      // Before `Object.entries`, which would otherwise throw a `TypeError` for
      // `null` and quietly return `[]` for `7`. A caller has to be able to tell
      // "your map is not a map" from "something inside this module broke".
      throw new EgressShapeError(input.feature, 'questions', [])
    }
    const declaredIds = Object.keys(input.questions)
    const safeQuestions: Record<string, JevQuestion> = {}
    const malformedIds: string[] = []
    const questionRules = new Set<string>()
    const questionFields = new Set<string>()
    let questionRedactions = 0
    let questionValues = 0
    for (const [id, question] of Object.entries(input.questions)) {
      const { value, summary: one } = input.redact(question as unknown as JsonValue)
      // A question is an object, and stays one: a value rule rewrites strings
      // *inside* it and a key rule replaces the value under a secret-named key,
      // so a question can only come back as something else if the redactor
      // rewrote the payload rather than its content.
      if (!isQuestionMap(value)) malformedIds.push(id)
      safeQuestions[id] = value as unknown as JevQuestion
      questionRedactions += one.redactions
      questionValues += one.values
      for (const rule of one.rules) questionRules.add(rule)
      for (const field of one.fields) questionFields.add(field)
    }

    // The invariant the loop above depends on, checked rather than assumed: the
    // redacted map is a non-null object — not an array — carrying exactly the
    // declared ids, same count and same names. It holds by construction, because
    // the ids are re-keyed from the input; it is checked because the
    // implementation this replaced took the map from the redactor instead, where
    // `Object.entries(7)` is `[]` rather than an error and `measure` returned a
    // payload whose `questions` was the number 7, and where `null` failed as a
    // `TypeError` no caller could branch on. A regression here fails open in the
    // worst way — see {@link EgressShapeError} — so it has to fail here instead.
    const producedIds = isQuestionMap(safeQuestions) ? Object.keys(safeQuestions) : []
    const missingIds = declaredIds.filter((id) => !producedIds.includes(id))
    const addedIds = producedIds.filter((id) => !declaredIds.includes(id))
    if (
      !isQuestionMap(safeQuestions) ||
      malformedIds.length > 0 ||
      missingIds.length > 0 ||
      addedIds.length > 0
    ) {
      throw new EgressShapeError(input.feature, 'questions', [
        ...new Set([...malformedIds, ...missingIds, ...addedIds]),
      ])
    }

    // Per-question summaries aggregated into one, so the caller-facing totals
    // still describe everything removed. Redacting question by question is an
    // implementation detail; dropping a count because of it would not be.
    const questionSummary: RedactionSummary = {
      redactions: questionRedactions,
      rules: [...questionRules].sort(),
      fields: [...questionFields].sort(),
      values: questionValues,
    }

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
