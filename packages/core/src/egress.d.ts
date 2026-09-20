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
import type { JevQuestion, JsonValue } from './types.js';
/** Stable feature identifiers. These appear in the startup report and metrics. */
export declare const EGRESS_FEATURES: readonly ["tool:jev_ask", "tool:jev_rank", "tool:jev_check", "gate:safety", "gate:context"];
export type EgressFeature = (typeof EGRESS_FEATURES)[number];
/** One field a feature would send, and the cap applied to it. */
export interface EgressField {
    /** Field name as it appears in the System One request. */
    readonly field: string;
    /** Character cap applied before sending. */
    readonly maxChars: number;
    /** What this field carries, in operator-facing language. */
    readonly carries: string;
}
/**
 * What each feature is capable of sending.
 *
 * These are declarations, not switches — {@link EgressContract.enabled} decides
 * whether a feature may run at all. Keeping them separate means the report can
 * tell an operator what a feature *would* send before they turn it on.
 */
export declare const EGRESS_FIELDS: Readonly<Record<EgressFeature, readonly EgressField[]>>;
/** A startup-report row: one feature and whether it will transmit. */
export interface EgressLine {
    readonly feature: EgressFeature;
    readonly enabled: boolean;
    readonly fields: readonly EgressField[];
}
/** A measured, ready-to-send payload. Produced only by {@link EgressContract.measure}. */
export interface MeasuredPayload {
    readonly feature: EgressFeature;
    readonly state: JsonValue;
    readonly questions: Readonly<Record<string, JevQuestion>>;
    /** Serialized size of `state`, after redaction and capping. */
    readonly stateChars: number;
    /** Serialized size of `questions`, after capping. */
    readonly questionsChars: number;
    /** True when a cap actually removed content. */
    readonly truncated: boolean;
    /** Redaction rules that fired while preparing this payload. */
    readonly redactionRules: readonly string[];
    /** Count of values replaced while preparing this payload. */
    readonly redactions: number;
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
    readonly transmitting: boolean;
    /** Feature to whether it may transmit content. */
    readonly enabled: Readonly<Record<EgressFeature, boolean>>;
}
/** The endpoint a live provider posts to, for the report. */
export type EndpointLabel = string;
/** Thrown when a feature is asked to transmit while it is not enabled. */
export declare class EgressDeniedError extends Error {
    readonly feature: EgressFeature;
    readonly name = "EgressDeniedError";
    constructor(feature: EgressFeature);
}
export declare class EgressContract {
    private readonly settings;
    private readonly endpoint;
    constructor(settings: EgressSettings, endpoint: EndpointLabel);
    /**
     * Whether a feature may run and transmit content right now.
     *
     * Deliberately does not consult `transmitting`: an offline provider makes no
     * network call whatever this returns, and gating the mock behind it would
     * leave the service unusable in exactly the configuration that is safest.
     */
    allows(feature: EgressFeature): boolean;
    /** Throw unless `feature` may transmit. Call before any provider invocation. */
    assert(feature: EgressFeature): void;
    /** The declared field set for a feature, for reports and documentation. */
    fieldsOf(feature: EgressFeature): readonly EgressField[];
    /** One row per feature, in stable order. */
    lines(): readonly EgressLine[];
    /**
     * Prepare and measure one payload.
     *
     * Returns the capped, redacted values alongside their measured sizes so the
     * caller can log exactly what is leaving rather than describing it from
     * memory. `redact` is injected so this module stays free of policy.
     */
    measure(input: {
        readonly feature: EgressFeature;
        readonly state: JsonValue;
        readonly questions: Readonly<Record<string, JevQuestion>>;
        readonly redact: (value: JsonValue) => {
            readonly value: JsonValue;
            readonly summary: {
                readonly redactions: number;
                readonly rules: readonly string[];
            };
        };
    }): MeasuredPayload;
    /**
     * The human-readable audit line.
     *
     * This is printed once at load and is the plugin's central promise: an
     * operator can read one line and know whether anything leaves their machine.
     */
    reportLines(): readonly string[];
}
//# sourceMappingURL=egress.d.ts.map