/**
 * Plugin configuration and its validation.
 *
 * Hand-written rather than schema-library-driven on purpose: this package's
 * core must stay dependency-free so its tests run with nothing installed, and
 * the config surface is small enough that an explicit validator is clearer
 * than a schema plus its inference.
 *
 * The defaults are the security posture, not an afterthought. Out of the box
 * this plugin resolves no credential, opens no socket, and reads no tool
 * result:
 *
 *   provider            'mock'      — nothing to reach
 *   gates.safety        false       — does not judge tool calls
 *   gates.context       false       — does not read tool results
 *   defaultModel        'jev-latest'
 *   maxConfidenceFloor  0.7         — an unsure Jev produces `ask`, not `allow`
 */
/** Which provider serves System One requests. */
export type ProviderKind = 'mock' | 'live';
/** Configuration for one gate: an object, or a bare boolean shorthand. */
export type GateInput = GateSettings | boolean;
export interface GateSettings {
    /**
     * Enable the gate. When false the gate registers nothing, so it cannot
     * transmit. Default false.
     */
    readonly enabled?: boolean;
    /**
     * What to do when the policy cannot decide.
     *  - `ask`  (default) surface the question to the human approval path
     *  - `allow` fail open
     *  - `deny`  fail closed
     */
    readonly onUndecided?: 'ask' | 'allow' | 'deny';
}
export interface JevConfigInput {
    readonly provider?: ProviderKind;
    /**
     * Credential reference resolved through DSH's credential service. The key
     * itself is never written to configuration.
     */
    readonly apiKeyRef?: string;
    /** API root for the live provider. */
    readonly baseURL?: string;
    /** Model name sent with every request. */
    readonly model?: string;
    /** Log level for this plugin's own diagnostics. */
    readonly logLevel?: 'silent' | 'warn' | 'info' | 'debug';
    /** Minimum Jev `confidence` before an answer is acted upon. */
    readonly minConfidence?: number;
    /** Minimum probability of the selected criterion. */
    readonly minProbability?: number;
    /** Maximum characters of `state` sent per call. `0` uses the feature default. */
    readonly maxStateChars?: number;
    readonly gates?: {
        readonly safety?: GateInput;
        readonly context?: GateInput;
    };
}
/** Resolved configuration: every field present and validated. */
export interface JevConfig {
    readonly provider: ProviderKind;
    readonly apiKeyRef: string;
    readonly baseURL: string | undefined;
    readonly model: string;
    readonly logLevel: 'silent' | 'warn' | 'info' | 'debug';
    readonly minConfidence: number;
    readonly minProbability: number;
    readonly maxStateChars: number | undefined;
    readonly gates: {
        readonly safety: Required<GateSettings>;
        readonly context: Required<GateSettings>;
    };
}
export declare const DEFAULT_CONFIG: JevConfig;
export declare class ConfigError extends Error {
    readonly name = "ConfigError";
}
/** Validate and resolve a raw config object. Throws {@link ConfigError}. */
export declare const resolveConfig: (input: JevConfigInput | undefined) => JevConfig;
//# sourceMappingURL=config.d.ts.map