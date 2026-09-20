/**
 * The safety gate: judge a tool call before it runs.
 *
 * Registered on `tools/pre-execute`, off by default. When enabled, every
 * matching tool call is judged against a published list of hazards before
 * dispatch.
 *
 * Three things this gate deliberately does NOT do, each of which an existing
 * third-party plugin in this ecosystem does:
 *
 *  - **It cannot fail open silently.** An undecided verdict resolves through
 *    `onUndecided`, which defaults to `ask` — the human sees it. A gate that
 *    allows on uncertainty is not a gate.
 *  - **It cannot be reconfigured by the model.** Nothing in this plugin
 *    exposes a tool that changes gate behaviour. The model cannot widen,
 *    narrow, or disable the check that constrains it.
 *  - **It does not trust a probability it did not understand.** The hazards are
 *    declared here as fixed questions; Jev answers them, and local code decides.
 *
 * The hazard list is also the egress disclosure: this is exactly what is sent.
 */
import type { EgressFeature } from '../egress.js';
import type { JevService } from '../service.js';
import { type JevQuestion } from '../types.js';
export declare const SAFETY_FEATURE: EgressFeature;
/**
 * The hazards asked about, in order. Each is a yes/no question; a `true`
 * probability above the policy floor asks the human before the call proceeds.
 *
 * Public because this list is a disclosure: an operator enabling the gate is
 * entitled to know what it looks for, and a test asserts the questions actually
 * sent match this declaration.
 */
export declare const HAZARD_QUESTIONS: Readonly<Record<string, JevQuestion>>;
/**
 * Tools the gate applies to.
 *
 * A denylist of tool-name fragments rather than an allowlist of every tool:
 * a gate that only recognises one naming scheme silently stops applying the
 * moment a new execution tool appears. Matching is prefix/substring based so
 * `pwsh`, `bash`, `shell`, and a `mcp__*__shell` variant are all covered.
 */
export declare const DEFAULT_GATED_TOOL_PATTERNS: readonly string[];
export interface GateDecision {
    readonly kind: 'allow' | 'deny' | 'ask';
    readonly reason?: string;
    /** Hazards whose probability crossed the threshold. */
    readonly raised?: readonly string[];
}
export interface SafetyGateOptions {
    readonly service: JevService;
    /** What to do when the policy cannot decide. */
    readonly onUndecided: 'ask' | 'allow' | 'deny';
    /** Minimum probability for a hazard to be considered raised. */
    readonly minProbability?: number;
    /** Minimum Jev confidence for an answer to count. */
    readonly minConfidence?: number;
    /** Tool-name fragments this gate applies to. */
    readonly toolPatterns?: readonly string[];
    /** Extra context appended to the judged state, e.g. the workspace root. */
    readonly describeContext?: () => string | undefined;
}
/** Whether the gate applies to a tool name. */
export declare const isGated: (name: string, patterns?: readonly string[]) => boolean;
/**
 * Serialize tool arguments for judging.
 *
 * Byte-capped at the call site by the egress contract, and stable-ordered so
 * the same call always produces the same state — which keeps the offline test
 * fixtures meaningful.
 */
export declare const serializeArguments: (args: unknown) => string;
export declare const createSafetyGate: (options: SafetyGateOptions) => (input: {
    readonly name: string;
    readonly args: unknown;
    readonly signal?: AbortSignal;
}) => Promise<GateDecision>;
//# sourceMappingURL=safety.d.ts.map