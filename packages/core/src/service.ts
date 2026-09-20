/**
 * The `ctx.jev` service.
 *
 * This is the plugin's primary surface, and the reason it exists as a plugin
 * rather than only as model-visible tools: other plugins and Host code can call
 * Jev directly, with no model turn in between. A routing decision, a gate, or a
 * background classifier should not cost a model round-trip.
 *
 * The service owns three things the rest of the plugin must not duplicate:
 * redaction before transmission, the egress check, and the honest record of
 * what actually happened.
 */

import { EgressContract, type EgressFeature, type MeasuredPayload } from './egress.js'
import { redact } from './redact.js'
import type { JevBudget } from './resilience/budget.js'
import type { FailureBreaker } from './resilience/breaker.js'
import type { AnswerCache } from './resilience/cache.js'
import type { JevEgressFacts, JevProvider, JevQuestion, JevResult, JsonValue } from './types.js'

/**
 * One recorded call, for the status report. Contains no payload content.
 *
 * Frozen when stored, so this is an immutable value rather than an
 * immutable-looking one: the same object is handed to `recent()`,
 * `stats().lastCall`, and the `onRecord` observer, and a mutable record would let
 * any one of those readers rewrite what the others are shown.
 */
export interface JevCallRecord {
  /**
   * Append order, assigned from 1 in `record()`. Never reused, never reordered.
   *
   * This — not {@link JevCallRecord.at} — is the key that makes a history order
   * well defined. `at` is stamped when a call *starts*, but `record()` runs when
   * one *finishes*, so the history is appended in completion order: two
   * concurrent calls are recorded in the opposite order to their `at` values.
   * `at` also has millisecond resolution, which for a fast provider is routinely
   * the same value for both calls. `seq` strictly increases in append order, so
   * it is the only field here that can order the history as recorded.
   */
  readonly seq: number
  readonly feature: EgressFeature
  readonly at: number
  readonly latencyMs: number
  readonly ok: boolean
  /** Redaction rules that fired, if any. */
  readonly redactionRules: readonly string[]
  readonly redactions: number
  readonly stateChars: number
  /** True when the state was capped before it was sent. */
  readonly truncated: boolean
  /** Failure message, truncated. Never contains the payload. */
  readonly error?: string
  /**
   * The answer was served from the cache and nothing was transmitted.
   *
   * Present only when true, like `truncated` on a result: an ordinary call keeps
   * the shape it had before this field existed. It is on the record rather than
   * inferred from `transmitted < calls` because that inequality is also what a
   * denied call would produce, and the two are not the same event.
   */
  readonly cached?: boolean
}

/** Counters for a status surface. Contains no payloads. */
export interface JevStats {
  readonly calls: number
  readonly failures: number
  readonly transmitted: number
  readonly totalLatencyMs: number
  readonly totalInputTokens: number
  /**
   * The sum of the costs the provider actually reported. **Not necessarily
   * spend.**
   *
   * The official TypeSafe route reports no cost at all: the SDK declares
   * `SystemOneResult.usage` as `{ input_tokens, output_tokens }` and nothing else
   * (`@typesafe-ai/sdk` 0.6.0, `dist/index.d.mts:121-126`), and the published
   * HTTP API reference documents the same two properties for the response
   * `usage` object. `LiveProvider` reads a `cost_usd`/`costUsd` field anyway, so
   * a route that does send one — OpenRouter's usage carries `cost` — is accounted
   * correctly; on the official route that branch simply never fires, and every
   * call contributes `0` while calls are being made and billed.
   *
   * So a `0` here means one of two entirely different things, and this number
   * cannot tell them apart on its own. {@link JevStats.costAccounting} does:
   *
   *  - `'reported'` — every call that succeeded reported a cost, so the sum is
   *    complete and may be read as spend.
   *  - `'unavailable'` — at least one successful call reported none, or no call
   *    has completed yet. The sum is then a lower bound and must not be read as
   *    spend. On the live route it is a confident-looking `0` that means
   *    "unknown", which is precisely the misreading this field exists to stop.
   */
  readonly totalCostUsd: number
  /**
   * Whether {@link JevStats.totalCostUsd} is complete. See that field for the
   * contract it carries.
   *
   * Reported by the service rather than inferred by the caller: a caller deciding
   * this from `providerId` would have to hard-code which routes bill and which
   * report, and would be wrong the first time a route changed.
   */
  readonly costAccounting: 'reported' | 'unavailable'
  /**
   * Successful calls whose result carried no `usage.costUsd`.
   *
   * Counted on success only, and separately from {@link JevStats.failures}: these
   * calls worked, and folding them into the failure count would report a healthy
   * route as a broken one. The number is worth reading on its own — equal to
   * `calls` it says the provider never reports cost, while a value that starts
   * climbing partway through says the route used to report it and stopped.
   */
  readonly callsWithoutCost: number
  readonly lastCall: JevCallRecord | undefined
}

export interface JevServiceOptions {
  readonly provider: JevProvider
  readonly egress: EgressContract
  /**
   * Whether the provider can reach the network.
   *
   * A fact about the provider, not a permission: the offline mock answers
   * through this same service without transmitting anything, and this stays
   * false so a status surface cannot imply otherwise.
   */
  readonly transmitting?: boolean
  /** Model override for every call from this service. */
  readonly model?: string
  /** Recent calls retained for the status report. */
  readonly historyLimit?: number
  /**
   * Called after each call record is stored, for a metrics or logging surface.
   *
   * Handed the same frozen record that `recent()` and `stats().lastCall` return,
   * so an observer cannot rewrite the history it is being told about. The counters
   * are already settled when it runs, so an observer that reads `stats()` sees the
   * call it is being told about included rather than one behind.
   *
   * **An observer that throws never fails the Jev call.** The exception is caught
   * and dropped. This hook is diagnostic, and a diagnostic that can fail the thing
   * it observes turns a broken dashboard into a broken decision path — the call
   * already succeeded, and its answer is still returned. The price of that choice
   * is real and worth stating plainly: the throw is swallowed with no log line and
   * does not increment `failures`, because this service has no logger and
   * `failures` counts Jev calls, not observers. An observer that can fail must do
   * its own error handling and must not expect this service to report it.
   */
  readonly onRecord?: (record: JevCallRecord) => void
  /**
   * Reuse an identical request instead of transmitting it again.
   *
   * Absent by default, and a cache built without an explicit allow/exclude
   * decision caches nothing either: reusing an answer is a decision about
   * correctness, and this project does not make those on an operator's behalf.
   * `gate:safety` is protected at the code level inside `AnswerCache` and cannot
   * be cached even when asked, because a gate verdict is about one call rather
   * than about a reusable input.
   */
  readonly cache?: AnswerCache
  /**
   * A hard ceiling on calls and spend within a window.
   *
   * A refusal is thrown **before** the provider is touched and is not recorded as
   * a provider failure — the same treatment an egress denial gets, and for the
   * same reason: nothing was transmitted, so nothing has been learned about the
   * provider's health.
   */
  readonly budget?: JevBudget
  /**
   * Stop calling a provider that has been failing.
   *
   * Only provider errors count against it. A budget refusal, an egress denial and
   * a payload over its cap all happen before the call, so none of them is
   * evidence that the provider is unhealthy.
   */
  readonly breaker?: FailureBreaker
}

/**
 * Call Jev for one feature.
 *
 * `feature` is required rather than defaulted on purpose: it is what selects
 * the egress switch and the declared field caps, so an implicit default could
 * silently route a call through the wrong contract.
 */
export interface JevAskInput {
  readonly feature: EgressFeature
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, JevQuestion>>
  readonly signal?: AbortSignal
}

/**
 * Attach what egress did to the payload, without disturbing what the provider
 * answered.
 *
 * Copies rather than mutates: a provider is free to hand back a shared or frozen
 * object, and a result is a value the caller owns.
 *
 * `truncated` is written as an explicit `true` only when it happened, so the
 * shape of a result from an ordinary call is exactly what it was before these
 * fields existed.
 */
const withEgressFacts = (result: JevResult, measured: MeasuredPayload): JevResult => {
  const egress: JevEgressFacts = {
    truncated: measured.truncated,
    stateChars: measured.stateChars,
    questionsChars: measured.questionsChars,
    redactedFields: measured.redactedFields,
    redactedValues: measured.redactedValues,
    redactionRules: measured.redactionRules,
    redactions: measured.redactions,
  }
  return {
    ...result,
    ...(measured.truncated ? { truncated: true } : {}),
    egress,
  }
}

/**
 * Requests in flight when {@link JevService.askMany} is not given a bound.
 *
 * Small on purpose. Each input is a separate state and therefore a separate
 * request against one account's rate limit, so this number is how many calls a
 * convenience method is willing to have outstanding. A large default would turn
 * that convenience into a self-inflicted 429.
 */
export const DEFAULT_ASK_MANY_CONCURRENCY = 4

export class JevService {
  private readonly history: JevCallRecord[] = []
  private readonly historyLimit: number
  private calls = 0
  private failures = 0
  private transmitted = 0
  private totalLatencyMs = 0
  private totalInputTokens = 0
  private totalCostUsd = 0
  private callsWithoutCost = 0
  private nextSeq = 1
  private lastCall: JevCallRecord | undefined

  constructor(private readonly options: JevServiceOptions) {
    this.historyLimit = options.historyLimit ?? 20
  }

  /** Provider identity, for reports. */
  get providerId(): string {
    return this.options.provider.id
  }

  /** Whether the configured provider can reach the network. */
  get transmitting(): boolean {
    return this.options.transmitting ?? false
  }

  /** The egress contract, exposed so other plugins can inspect it. */
  get egress(): EgressContract {
    return this.options.egress
  }

  /**
   * Answer one batch of questions.
   *
   * Redaction runs before the egress measurement, so the reported sizes are
   * the sizes that actually leave, not the sizes of the raw input.
   *
   * What egress did to the payload is stamped onto the result as well as onto
   * the call record. It used to live on the record alone, which meant a result
   * produced from a truncated state was indistinguishable from one produced from
   * the whole state: `MeasuredPayload.truncated` was computed, stored, and never
   * reached the caller. The answer is about the state Jev saw, so the caller has
   * to be able to see what that was.
   */
  async ask(input: JevAskInput): Promise<JevResult> {
    // `measure` performs the egress check and throws before anything leaves.
    // The transmission counter is incremented only after it returns, so a
    // denied call is never reported as transmitted.
    const measured = this.options.egress.measure({
      feature: input.feature,
      state: input.state,
      questions: input.questions,
      redact,
    })

    // The cache is consulted BEFORE the budget and the breaker, and that order is
    // deliberate. A hit transmits nothing, so charging it against a spend ceiling
    // would bill a caller for a call that was never made, and gating it behind the
    // breaker would let a provider outage hide an answer this process already
    // holds. Both of those layers govern transmission; a hit is not one.
    const cache = this.options.cache
    const cacheable = cache !== undefined && cache.isCacheable(input.feature)
    if (cache !== undefined && cacheable) {
      const hit = cache.lookup(cache.keyOf(measured, this.options.model))
      if (hit !== undefined) {
        // The cache is typed in plain JSON so it stays independent of this
        // module; the value stored here is always a `JevResult`. The key covers
        // the measurement — both character counts, `truncated`, and the redacted
        // payload — so a hit is by construction a request identical to the one
        // that produced the value.
        const stored = hit as unknown as JevResult
        // Rebuilt rather than spread, because two of the stored fields cannot be
        // carried over honestly: `latencyMs` measured the call that filled the
        // cache rather than this one, and `usage` reports tokens this call did not
        // spend. Leaving either in place would let a caller total up work that
        // never happened. The egress facts are re-stamped below from *this*
        // measurement, which the key says is the same one.
        const reused: JevResult = {
          provider: stored.provider,
          model: stored.model,
          answers: stored.answers,
          latencyMs: 0,
        }
        this.calls += 1
        // `transmitted` is deliberately NOT incremented: it counts what left the
        // machine, and nothing did.
        this.record({
          feature: input.feature,
          at: Date.now(),
          latencyMs: 0,
          ok: true,
          redactionRules: measured.redactionRules,
          redactions: measured.redactions,
          stateChars: measured.stateChars,
          truncated: measured.truncated,
          cached: true,
        })
        return withEgressFacts(reused, measured)
      }
    }

    // After the cache, before the provider. Both of these throw, and both throw
    // outside the `try` below on purpose: a budget refusal and an open breaker are
    // not provider failures, and recording them as such would make an ordinary
    // spending stop look like an unhealthy endpoint. An egress denial already gets
    // exactly this treatment, one step earlier.
    this.options.budget?.reserve()
    this.options.breaker?.assert()

    const startedAt = Date.now()
    this.transmitted += 1
    try {
      const result = await this.options.provider.answer(
        {
          state: measured.state,
          questions: measured.questions,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
        },
        input.signal,
      )
      const costUsd = result.usage?.costUsd
      this.calls += 1
      this.totalLatencyMs += result.latencyMs
      this.totalInputTokens += result.usage?.inputTokens ?? 0
      this.totalCostUsd += costUsd ?? 0
      // Counted on success only. A failed call reported no usage because it
      // returned nothing at all, which is what `failures` already records;
      // counting it here too would say the provider withheld a cost it was never
      // given the chance to send.
      if (costUsd === undefined) this.callsWithoutCost += 1
      // `undefined` is passed through rather than defaulted to zero. The budget
      // treats "this route never reports cost" and "this call cost nothing" as
      // different facts, and substituting a zero here is exactly how a spend
      // ceiling quietly stops bounding anything.
      this.options.budget?.recordCost(costUsd)
      this.options.breaker?.recordSuccess()
      if (cache !== undefined && cacheable) {
        cache.store(
          cache.keyOf(measured, this.options.model),
          withEgressFacts(result, measured) as unknown as JsonValue,
        )
      }
      // Accounting is settled before the record is announced, so an `onRecord`
      // observer that reads `stats()` sees the call it is being told about
      // included rather than one behind. The record is still stored before the
      // hook runs, which is what the hook is defined to mean.
      this.record({
        feature: input.feature,
        at: startedAt,
        latencyMs: result.latencyMs,
        ok: true,
        redactionRules: measured.redactionRules,
        redactions: measured.redactions,
        stateChars: measured.stateChars,
        truncated: measured.truncated,
      })
      return withEgressFacts(result, measured)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Only a provider failure can reach here, which is what makes this the
      // right place to count one: the breaker's whole question is whether the
      // endpoint is healthy, and nothing above this line touches the endpoint.
      this.options.breaker?.recordFailure(error)
      this.failures += 1
      this.record({
        feature: input.feature,
        at: startedAt,
        latencyMs: Date.now() - startedAt,
        ok: false,
        redactionRules: measured.redactionRules,
        redactions: measured.redactions,
        stateChars: measured.stateChars,
        truncated: measured.truncated,
        error: message.slice(0, 300),
      })
      throw error
    }
  }

  /**
   * Ask about several independent states, with bounded concurrency.
   *
   * **This is not a batch discount, and it cannot be one.** A System One request
   * carries exactly one `state` — the HTTP API reference documents `state` as a
   * single required field of the request body — so N independent states can never
   * be folded into one call. The saving the docs do advertise, "batching every
   * question into one TypeSafe call is 12.2x cheaper and 10.0x faster"
   * (docs.typesafe.ai/cookbooks/parallel_questions), is about many *questions over
   * one state*, which {@link JevService.ask} already gets for free from its
   * question map. `askMany` sends one request per input and costs what N separate
   * calls cost; what it adds is the concurrency bound and the per-item failure
   * handling, so callers stop hand-rolling both.
   *
   * Every input settles independently, exactly like `Promise.allSettled`: a denied
   * feature, a provider failure, or one timeout is reported in its own slot and
   * never cancels the others. That is why the return type is a settled result
   * rather than a result array — a single rejection would empty the latter.
   *
   * @param options.concurrency Requests in flight. Defaults to
   * {@link DEFAULT_ASK_MANY_CONCURRENCY}. A value below 1, or a non-finite one, is
   * clamped to 1 instead of being honoured: zero workers would leave the returned
   * promise pending forever, and a caller waiting on a promise that can never
   * settle is a worse failure mode than a caller waiting in line.
   */
  async askMany(
    inputs: readonly JevAskInput[],
    options?: { readonly concurrency?: number },
  ): Promise<readonly PromiseSettledResult<JevResult>[]> {
    // Paired up front so the worker loop has no `undefined` slot to skip: with
    // `noUncheckedIndexedAccess` a raw index read is `JevAskInput | undefined`,
    // and a `continue` on that branch would leave a hole in `results` rather than
    // a settled entry.
    const jobs = inputs.map((input, index) => ({ index, input }))
    const results = new Array<PromiseSettledResult<JevResult>>(jobs.length)
    const total = jobs.length
    if (total === 0) return results

    const requested = options?.concurrency
    const workers =
      requested === undefined || !Number.isFinite(requested)
        ? Math.min(DEFAULT_ASK_MANY_CONCURRENCY, total)
        : Math.max(1, Math.min(Math.floor(requested), total))

    // The cursor is read and advanced in one synchronous step before the first
    // `await` below, so two workers can never claim the same job.
    let cursor = 0
    const drain = async (): Promise<void> => {
      for (;;) {
        const job = jobs[cursor]
        cursor += 1
        if (job === undefined) return
        try {
          results[job.index] = { status: 'fulfilled', value: await this.ask(job.input) }
        } catch (reason) {
          results[job.index] = { status: 'rejected', reason }
        }
      }
    }

    await Promise.all(Array.from({ length: workers }, () => drain()))
    return results
  }

  /** Counters for a status surface. Contains no payloads. */
  stats(): JevStats {
    return {
      calls: this.calls,
      failures: this.failures,
      transmitted: this.transmitted,
      totalLatencyMs: this.totalLatencyMs,
      totalInputTokens: this.totalInputTokens,
      totalCostUsd: this.totalCostUsd,
      // Vacuously complete is not complete. With no completed call there is no
      // evidence that this provider reports cost at all, so nothing is claimed:
      // a status surface showing "reported, $0.00" before the first call would be
      // the same silent-zero lie this field exists to prevent, just earlier.
      costAccounting: this.calls > 0 && this.callsWithoutCost === 0 ? 'reported' : 'unavailable',
      callsWithoutCost: this.callsWithoutCost,
      lastCall: this.lastCall,
    }
  }

  /**
   * Recent calls, newest last.
   *
   * Ordered by {@link JevCallRecord.seq} — append order. See that field for why
   * `at` cannot order the history: it is a start timestamp, and records are
   * appended on completion.
   *
   * Returns a frozen **copy**, and every record in it is frozen as well. This
   * getter used to hand back the service's own array, which made the history
   * writable from outside: a caller could `push`, `shift`, or `reverse` it and
   * change what every other reader — including `stats().lastCall` — was shown.
   * The copy is what makes the returned array safe to sort in place, and the
   * freezes are what make its elements safe to hand out at all, since `readonly`
   * is a compile-time claim that any plain-JavaScript consumer ignores.
   */
  recent(): readonly JevCallRecord[] {
    return Object.freeze([...this.history])
  }

  /**
   * Store one record, stamped with its sequence number and frozen.
   *
   * Frozen rather than only `readonly`-typed because the same object is handed to
   * `recent()`, `stats().lastCall`, and the `onRecord` observer; without the
   * freeze, one of those readers could rewrite the history the others see.
   */
  private record(entry: Omit<JevCallRecord, 'seq'>): void {
    const record: JevCallRecord = Object.freeze({ ...entry, seq: this.nextSeq })
    this.nextSeq += 1
    this.history.push(record)
    if (this.history.length > this.historyLimit) this.history.shift()
    this.lastCall = record
    this.notify(record)
  }

  /**
   * Hand a stored record to the observer, dropping anything it throws.
   *
   * See {@link JevServiceOptions.onRecord} for why the throw is swallowed rather
   * than propagated. It is not counted as a failure either: `failures` counts Jev
   * calls that failed, and an observer is not a Jev call.
   */
  private notify(record: JevCallRecord): void {
    const observer = this.options.onRecord
    if (observer === undefined) return
    try {
      observer(record)
    } catch {
      // Deliberately dropped, and deliberately not re-thrown: the call this
      // observes has already succeeded and its answer is still returned.
    }
  }
}
