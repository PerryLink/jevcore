/**
 * Reusing an answer that is a pure function of what was sent.
 *
 * Jev is not a chat model. For a given payload and a given batch of questions it
 * returns the same calibrated numbers, and a caller that asks the same question
 * twice pays twice for one answer. This module exists to stop that, and — more
 * importantly — to stop it in the only case where stopping it is *safe*.
 *
 * Three properties, each of which is a place a naive answer cache goes wrong:
 *
 *  1. **The key is the measured payload, not the caller's input.** What leaves
 *     the machine is `MeasuredPayload`: redacted, capped, possibly replaced by a
 *     truncation envelope. Keying on the raw input would mean a state that
 *     redaction changed and a state that redaction did not change could share a
 *     key, and a caller would be handed an answer about content Jev never saw.
 *     {@link AnswerCache.keyOf} takes the measured payload for that reason, and
 *     the key covers the measurement itself (`truncated`, the character counts,
 *     the redaction count), so two payloads cannot collide merely because the
 *     text they serialized to happens to agree.
 *
 *  2. **A cacheable feature is a decision somebody made.** There is no default.
 *     {@link DEFAULT_CACHE_EXCLUDED} names the features that are *never* cached
 *     whatever anyone configures, and `gate:safety` is the motivating case: its
 *     verdict depends on the workspace the call is running against, so an answer
 *     kept from a previous state of that workspace is not a stale optimisation,
 *     it is a wrong decision delivered confidently. A decision must be supplied
 *     explicitly and unambiguously — an `allow` list or an `exclude` list, never
 *     a bare array whose meaning depends on which way the reader squints. An
 *     instance built with no decision caches nothing; see
 *     {@link CacheDecision}.
 *
 *  3. **It is observable.** Hits, misses, evictions and expiries are counted, and
 *     the key is a readable serialization rather than a hash, so an operator can
 *     see both what the cache is doing and the exact payload identity that
 *     decided it.
 *
 * What it deliberately is not: a cache with a background sweeper. Expiry is
 * checked on read, so nothing here holds a timer, keeps the process alive, or
 * can be observed working asynchronously. The bound is entry count, not bytes —
 * stated plainly because "bounded" without a unit is the kind of claim this
 * project refuses to make.
 */

import type { EgressFeature, MeasuredPayload } from '../egress.js'
import type { JsonValue } from '../types.js'

/**
 * The features that are never cached, whatever a caller configures.
 *
 * A code-level invariant rather than a setting, and it is not overridable by
 * {@link AnswerCacheOptions}: configuration is how an operator opts *in* to
 * reuse, and this list is the floor under that. Editing it means rewriting this
 * comment, which is the point — a protected feature is protected by something a
 * reviewer can see in a diff rather than by a value in a file nobody reads.
 *
 * `gate:safety` is here because its verdict is a function of the session's
 * working directory and the tool call in front of it. Both change constantly
 * within one session, so its answer is only valid for the exact instant it was
 * produced. Caching it would convert "is this action hazardous *now*" into "was
 * it hazardous the last time anyone asked", and the failure mode is a hazard
 * allowed through on the strength of a verdict about a different workspace.
 *
 * `gate:context` is deliberately *not* here. Its payload is a tool result the
 * agent has already received, which is immutable content, so a decision about
 * one exact result is reusable. Enabling it is still excluded in the shipped
 * configuration; it is simply cacheable in principle, and this list is for
 * features that are not.
 */
export const DEFAULT_CACHE_EXCLUDED: readonly EgressFeature[] = ['gate:safety']

/**
 * Which features may be cached. There is no default, and no value of it that
 * means "decide for me".
 *
 * `allow` is the allowlist: reusing an answer is a decision somebody made about
 * each feature that gets it. `exclude` is the denylist half, for a caller who
 * genuinely wants "everything except this", and it still cannot add back a
 * feature named in {@link DEFAULT_CACHE_EXCLUDED}.
 *
 * There is no bare array form. `['tool:jev_ask']` would be an allowlist to one
 * reader and a denylist to another, and the two readings differ by whether every
 * unlisted feature transmits. Guessing here would be guessing about
 * transmission, so {@link AnswerCache} refuses a decision given as a plain array
 * rather than picking a reading.
 *
 * Omitting it altogether is allowed and means nothing is cached; see
 * {@link AnswerCacheOptions.decision}. What is *not* allowed is a decision that
 * has to be interpreted.
 */
export type CacheDecision =
  | {
      /** Allowlist semantics: only these features may be cached. */
      readonly mode: 'allow'
      readonly features: readonly EgressFeature[]
    }
  | {
      /** Denylist semantics: every feature except these may be cached. */
      readonly mode: 'exclude'
      readonly features: readonly EgressFeature[]
    }

export interface AnswerCacheOptions {
  /**
   * Which features may be reused.
   *
   * Optional in the type and inert at runtime: an instance built without one
   * answers `false` from {@link AnswerCache.isCacheable} for every feature and
   * refuses every key, so "I did not decide" and "I decided nothing may be
   * cached" are the same state. Listed first because a caller who wants reuse has
   * to supply it — no value of it means "decide for me".
   */
  readonly decision?: CacheDecision
  /** Maximum entries retained. Defaults to {@link DEFAULT_CACHE_MAX_ENTRIES}. */
  readonly maxEntries?: number
  /**
   * Seconds an entry stays usable. Omitted or `0` means it never expires.
   *
   * Zero is *not* one of the two readings of a small TTL; it is the documented
   * spelling of "no expiry", and a negative value is normalised to the same
   * thing. If a feature must not be reused, the honest expression is to leave it
   * out of the decision, not to give it a TTL of zero and hope.
   */
  readonly ttlMs?: number
  /** Clock, injected so tests are deterministic. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Model name, when it should separate cache entries. Omitted means it does not. */
  readonly model?: string
}

/**
 * A key that a caller can inspect, log, and compare.
 *
 * `key` is the canonical serialization of everything that decided the key. It is
 * used verbatim as the map key, which is why this API has no visible hash and no
 * library of hash functions: two payloads that differ at all produce different
 * keys, and no collision can hand one payload's answer to another. A hashed key
 * would be shorter to store and would be wrong occasionally, which is the wrong
 * trade for a module whose whole purpose is not returning answers to questions
 * nobody asked.
 *
 * `stateChars` and `questionsChars` are the measured character counts carried
 * through from {@link MeasuredPayload}, so an operator comparing two keys can
 * see *why* they differ without decoding the JSON. `bytes` is the key's own
 * length, so the memory a key costs is a number rather than a guess.
 */
export interface CacheKey {
  readonly feature: EgressFeature
  readonly key: string
  readonly model: string | undefined
  readonly stateChars: number
  readonly questionsChars: number
  readonly bytes: number
}

/** Counters for a status surface, plus the entry count the bound actually holds. */
export interface CacheStats {
  readonly hits: number
  readonly misses: number
  readonly inserts: number
  readonly evictions: number
  readonly expiries: number
  /** Entries currently held. Never above `maxEntries`. */
  readonly entries: number
  readonly maxEntries: number
}

/**
 * Thrown when a feature that must not be cached is asked for a key anyway.
 *
 * A throw rather than `undefined`, because at this point the caller has already
 * declared its intent to reuse the answer. Returning nothing would leave the
 * cache silently inert and the caller silently transmitting, which is the
 * opposite of what the module is for.
 */
export class CacheKeyError extends Error {
  override readonly name = 'CacheKeyError'

  constructor(
    readonly feature: EgressFeature,
    reason: string,
  ) {
    super(`"${feature}" cannot be cached: ${reason}`)
  }
}

/**
 * A one-shot decision about whether one answer may be reused.
 *
 * Deliberately not a boolean. A bare `true` reads as "yes, cache everything",
 * and a bare `false` reads as "cache nothing" — and a caller handed one of those
 * has learned nothing about the other four features. The `decided` flag forces
 * the absent case to be visible: an unconfigured cache refuses to store anything
 * rather than storing by accident.
 */
export interface CachePolicy {
  readonly enabled: boolean
  readonly feature: EgressFeature
  readonly ttlMs: number
  readonly reason: string
  /** False when no {@link CacheDecision} was supplied, or `enabled` is false. */
  readonly decided: boolean
}

/** Default entry bound. Small, because this saves calls rather than serving traffic. */
export const DEFAULT_CACHE_MAX_ENTRIES: number = 64

/**
 * The separator between the fields that make up a key.
 *
 * `\u0000`, written as an escape rather than as a literal NUL byte in the source,
 * because a literal one is invisible in a diff. It is not a character JSON can
 * produce: `JSON.stringify` escapes every control character, so a state
 * containing this byte arrives here as the six characters `\u0000` and cannot
 * forge a field boundary.
 */
export const CACHE_KEY_SEPARATOR: string = '\u0000'

/**
 * The JSON a key is built from: object keys sorted, so equivalent payloads agree.
 *
 * `JSON.stringify` is insertion-order sensitive. Two `questions` records built by
 * different code paths with the same content would serialize differently and
 * miss each other — a cache that works for one caller and not another for no
 * reason an operator could see. Sorting by code unit makes the serialization a
 * function of the *content*.
 *
 * Arrays keep their order. Order is content: the levels of a score question are
 * an ordered rubric, and reordering a ranking's candidates changes what was
 * asked. Sorting those would be a correctness bug rather than a tidy-up.
 */
const canonicalJson = (value: JsonValue): string => {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value).sort()
  const parts = entries.map(
    (name) => `${JSON.stringify(name)}:${canonicalJson(value[name] as JsonValue)}`,
  )
  return `{${parts.join(',')}}`
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

/** A stored answer. `at` and `expiresAt` come from the injected clock. */
interface Entry {
  readonly result: JsonValue
  readonly at: number
  /**
   * When the entry stops being usable, or `undefined` for one that never expires.
   *
   * Required-and-possibly-undefined rather than optional, so an entry is always
   * built with the decision written down instead of left to a spread that a later
   * edit could drop. `exactOptionalPropertyTypes` is on in this package, which
   * makes that difference a compile error rather than a silent one.
   */
  readonly expiresAt: number | undefined
}

/**
 * A bounded, opt-in cache of measured payloads to answers.
 *
 * The value type is `JsonValue`, not `JevResult`, and that is not a shortcut.
 * This module cannot import `service.js` — the integrator wires the two together
 * — and typing the stored value as JSON keeps the cache honest about what it
 * does: it stores whatever the caller hands it and returns it unchanged. It does
 * not validate that the value is an answer, and it makes no attempt to check
 * that an entry it is about to return is still true.
 */
export class AnswerCache {
  private readonly decision: CacheDecision | undefined
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly model: string | undefined
  private readonly entries = new Map<string, Entry>()
  private hits = 0
  private misses = 0
  private inserts = 0
  private evictions = 0
  private expiries = 0

  /**
   * @param options - the decision and the bound. Omitting the decision leaves the
   *   cache inert rather than permissive: it constructs, every `store` refuses,
   *   and nothing is remembered. Constructing none of this module at all is
   *   still the cheapest way to be off.
   * @throws TypeError when a `decision` was supplied but is not one of the two
   *   unambiguous forms, and RangeError when `maxEntries` is not a positive
   *   integer. Neither is defaulted: a silent fallback would decide what may be
   *   reused on the caller's behalf.
   */
  constructor(options: AnswerCacheOptions = {}) {
    const decision: unknown = options.decision as unknown
    if (decision !== undefined && !isDecision(decision)) {
      throw new TypeError(
        '`decision` must be `{ mode: "allow", features: [...] }` or `{ mode: "exclude", ' +
          'features: [...] }`, saying which features may be cached. A plain array is refused ' +
          'because the same array reads as an allowlist to one reader and a denylist to ' +
          'another, and the two readings differ by whether every unlisted feature transmits.',
      )
    }
    const maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${String(maxEntries)}`)
    }
    this.decision = decision === undefined ? undefined : (decision as CacheDecision)
    // Deliberately the raw number, not `?? 0`: `ttlMs: 0` means "never expires"
    // (see `AnswerCacheOptions.ttlMs`) and every non-positive value is the same
    // statement. A negative TTL is never read as "already expired", because that
    // would make an option a feature can be turned off with by accident.
    const ttlMs = options.ttlMs ?? 0
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0
    this.maxEntries = maxEntries
    this.now = options.now ?? Date.now
    this.model = options.model
  }

  /**
   * Whether an answer for this feature may be reused at all.
   *
   * The exclusion list is consulted first, so this returns false for a protected
   * feature under every configuration, including `mode: 'exclude'` with that
   * feature absent from its list. A feature with no decision is not cacheable.
   */
  isCacheable(feature: EgressFeature): boolean {
    if (DEFAULT_CACHE_EXCLUDED.includes(feature)) return false
    if (this.decision === undefined) return false
    if (this.decision.mode === 'allow') return this.decision.features.includes(feature)
    return !this.decision.features.includes(feature)
  }

  /**
   * The reason a feature is or is not cacheable, in operator-facing language.
   *
   * Exists because a cache that is merely silent about itself cannot be
   * interrogated: "why did this call transmit?" is answered by a sentence, not
   * by `false`.
   */
  decide(feature: EgressFeature): CachePolicy {
    if (DEFAULT_CACHE_EXCLUDED.includes(feature)) {
      return {
        enabled: false,
        feature,
        ttlMs: 0,
        decided: true,
        reason: `"${feature}" is protected from caching at the code level and cannot be enabled`,
      }
    }
    if (this.decision === undefined) {
      return {
        enabled: false,
        feature,
        ttlMs: 0,
        decided: false,
        reason: 'no cache decision was supplied, so nothing is reused',
      }
    }
    const listed = this.decision.features.includes(feature)
    const enabled = this.decision.mode === 'allow' ? listed : !listed
    return {
      enabled,
      feature,
      ttlMs: this.ttlMs,
      decided: true,
      reason: enabled
        ? `"${feature}" is reuse-eligible under mode "${this.decision.mode}"`
        : `"${feature}" is not reuse-eligible under mode "${this.decision.mode}"`,
    }
  }

  /**
   * Derive the key for one measured payload.
   *
   * `model` may be passed here as well as configured, so one payload can be
   * keyed against a model chosen per call. When both are given they must agree:
   * a key whose identity contradicts the cache's own configuration is exactly
   * the confusion this function exists to prevent, and silently preferring one
   * of them would make the mismatch invisible.
   *
   * @throws CacheKeyError when the feature is not cacheable, and TypeError when
   *   a per-call model contradicts the configured one.
   */
  keyOf(measured: MeasuredPayload, model?: string): CacheKey {
    const policy = this.decide(measured.feature)
    if (!policy.enabled) throw new CacheKeyError(measured.feature, policy.reason)
    if (model !== undefined && this.model !== undefined && model !== this.model) {
      throw new TypeError(
        `keyOf was given model "${model}" but this cache is configured for ` +
          `"${this.model}". Pass the model in one place, or they will disagree invisibly.`,
      )
    }
    const effective = model ?? this.model
    const parts = [
      measured.feature,
      effective ?? '',
      measured.truncated ? 'truncated' : 'whole',
      String(measured.stateChars),
      String(measured.questionsChars),
      String(measured.redactions),
      canonicalJson(measured.state),
      canonicalJson(measured.questions as unknown as JsonValue),
    ]
    const key = parts.join(CACHE_KEY_SEPARATOR)
    return {
      feature: measured.feature,
      key,
      model: effective,
      stateChars: measured.stateChars,
      questionsChars: measured.questionsChars,
      bytes: byteLength(key),
    }
  }

  /**
   * The stored value, or `undefined`.
   *
   * An expired entry is dropped and counted rather than returned, and a hit
   * refreshes the entry's recency — that is what makes the bound LRU rather than
   * FIFO. Whether reuse is *correct* for the feature is the caller's decision and
   * is not re-checked here: by the time this is called, the caller has already
   * decided to reuse, and second-guessing that would produce a silent miss where
   * a refusal belongs. See {@link AnswerCache.decide} before relying on it, or
   * {@link AnswerCache.isCacheable} before calling it at all.
   */
  lookup(key: CacheKey): JsonValue | undefined {
    const entry = this.entries.get(key.key)
    if (entry === undefined) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key.key)
      this.expiries += 1
      this.misses += 1
      return undefined
    }
    // Re-inserting moves the entry to the most-recent end of the map's insertion
    // order, which is the whole of the LRU bookkeeping.
    this.entries.delete(key.key)
    this.entries.set(key.key, entry)
    this.hits += 1
    return entry.result
  }

  /**
   * Remember one answer, and evict if that put the cache over its bound.
   *
   * Refuses quietly — without throwing — when the key's feature is not cacheable,
   * because by that point the caller has already been told so by {@link keyOf} or
   * {@link decide} and a second throw would only add a way for a cache miss to
   * become a failed call. It does **not** verify that `key` was derived from the
   * payload that produced `result`: only the caller holds both, and a cache that
   * silently stored an answer under an unrelated key would hand it out later as
   * though it were about the payload that key describes. That is why the intended
   * use is to derive the key and store the answer in the same step, never to keep
   * a key in one place and a result in another.
   */
  store(key: CacheKey, result: JsonValue): void {
    const policy = this.decide(key.feature)
    if (!policy.enabled) return
    const at = this.now()
    const expiresAt = this.ttlMs > 0 ? at + this.ttlMs : undefined
    this.entries.delete(key.key)
    this.entries.set(key.key, { result, at, expiresAt })
    this.inserts += 1
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
      this.evictions += 1
    }
  }

  /** Drop everything retained. Counters are lifetime totals and are not reset. */
  clear(): void {
    this.entries.clear()
  }

  /**
   * Counters plus the live entry count.
   *
   * Returned as a copy so a caller cannot reach into the cache through it.
   * `entries` is reported alongside `maxEntries` because a bound with only one
   * of the two numbers is not checkable by the operator reading it.
   */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      inserts: this.inserts,
      evictions: this.evictions,
      expiries: this.expiries,
      entries: this.entries.size,
      maxEntries: this.maxEntries,
    }
  }
}

/**
 * Whether a value is a {@link CacheDecision}, including that its feature list is
 * one.
 *
 * Checks the list as well as the tag. A decision carrying a non-array would
 * otherwise pass construction and throw on the first call, which reports a
 * configuration mistake at the worst possible moment — after the payload has
 * been prepared and the caller believes it is about to reuse something.
 */
const isDecision = (value: unknown): value is CacheDecision => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { mode?: unknown; features?: unknown }
  if (candidate.mode !== 'allow' && candidate.mode !== 'exclude') return false
  return Array.isArray(candidate.features)
}
