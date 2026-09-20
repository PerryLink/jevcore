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

import { EgressContract, type EgressFeature } from './egress.js'
import { redact } from './redact.js'
import type { JevProvider, JevQuestion, JevResult, JsonValue } from './types.js'

/** One recorded call, for the status report. Contains no payload content. */
export interface JevCallRecord {
  readonly feature: EgressFeature
  readonly at: number
  readonly latencyMs: number
  readonly ok: boolean
  /** Redaction rules that fired, if any. */
  readonly redactionRules: readonly string[]
  readonly redactions: number
  readonly stateChars: number
  /** Failure message, truncated. Never contains the payload. */
  readonly error?: string
}

export interface JevStats {
  readonly calls: number
  readonly failures: number
  readonly transmitted: number
  readonly totalLatencyMs: number
  readonly totalInputTokens: number
  readonly totalCostUsd: number
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

export class JevService {
  private readonly history: JevCallRecord[] = []
  private readonly historyLimit: number
  private calls = 0
  private failures = 0
  private transmitted = 0
  private totalLatencyMs = 0
  private totalInputTokens = 0
  private totalCostUsd = 0
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
      this.record({
        feature: input.feature,
        at: startedAt,
        latencyMs: result.latencyMs,
        ok: true,
        redactionRules: measured.redactionRules,
        redactions: measured.redactions,
        stateChars: measured.stateChars,
      })
      this.calls += 1
      this.totalLatencyMs += result.latencyMs
      this.totalInputTokens += result.usage?.inputTokens ?? 0
      this.totalCostUsd += result.usage?.costUsd ?? 0
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.record({
        feature: input.feature,
        at: startedAt,
        latencyMs: Date.now() - startedAt,
        ok: false,
        redactionRules: measured.redactionRules,
        redactions: measured.redactions,
        stateChars: measured.stateChars,
        error: message.slice(0, 300),
      })
      this.failures += 1
      throw error
    }
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
      lastCall: this.lastCall,
    }
  }

  /** Recent calls, newest last. */
  recent(): readonly JevCallRecord[] {
    return this.history
  }

  private record(entry: JevCallRecord): void {
    this.history.push(entry)
    if (this.history.length > this.historyLimit) this.history.shift()
    this.lastCall = entry
  }
}
