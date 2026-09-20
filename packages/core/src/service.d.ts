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
import { EgressContract, type EgressFeature } from './egress.js';
import type { JevProvider, JevQuestion, JevResult, JsonValue } from './types.js';
/** One recorded call, for the status report. Contains no payload content. */
export interface JevCallRecord {
    readonly feature: EgressFeature;
    readonly at: number;
    readonly latencyMs: number;
    readonly ok: boolean;
    /** Redaction rules that fired, if any. */
    readonly redactionRules: readonly string[];
    readonly redactions: number;
    readonly stateChars: number;
    /** Failure message, truncated. Never contains the payload. */
    readonly error?: string;
}
export interface JevStats {
    readonly calls: number;
    readonly failures: number;
    readonly transmitted: number;
    readonly totalLatencyMs: number;
    readonly totalInputTokens: number;
    readonly totalCostUsd: number;
    readonly lastCall: JevCallRecord | undefined;
}
export interface JevServiceOptions {
    readonly provider: JevProvider;
    readonly egress: EgressContract;
    /**
     * Whether the provider can reach the network.
     *
     * A fact about the provider, not a permission: the offline mock answers
     * through this same service without transmitting anything, and this stays
     * false so a status surface cannot imply otherwise.
     */
    readonly transmitting?: boolean;
    /** Model override for every call from this service. */
    readonly model?: string;
    /** Recent calls retained for the status report. */
    readonly historyLimit?: number;
}
/**
 * Call Jev for one feature.
 *
 * `feature` is required rather than defaulted on purpose: it is what selects
 * the egress switch and the declared field caps, so an implicit default could
 * silently route a call through the wrong contract.
 */
export interface JevAskInput {
    readonly feature: EgressFeature;
    readonly state: JsonValue;
    readonly questions: Readonly<Record<string, JevQuestion>>;
    readonly signal?: AbortSignal;
}
export declare class JevService {
    private readonly options;
    private readonly history;
    private readonly historyLimit;
    private calls;
    private failures;
    private transmitted;
    private totalLatencyMs;
    private totalInputTokens;
    private totalCostUsd;
    private lastCall;
    constructor(options: JevServiceOptions);
    /** Provider identity, for reports. */
    get providerId(): string;
    /** Whether the configured provider can reach the network. */
    get transmitting(): boolean;
    /** The egress contract, exposed so other plugins can inspect it. */
    get egress(): EgressContract;
    /**
     * Answer one batch of questions.
     *
     * Redaction runs before the egress measurement, so the reported sizes are
     * the sizes that actually leave, not the sizes of the raw input.
     */
    ask(input: JevAskInput): Promise<JevResult>;
    /** Counters for a status surface. Contains no payloads. */
    stats(): JevStats;
    /** Recent calls, newest last. */
    recent(): readonly JevCallRecord[];
    private record;
}
//# sourceMappingURL=service.d.ts.map