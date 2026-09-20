/**
 * The context gate: keep the turn from filling with results that say nothing.
 *
 * Registered on `tools/post-execute`, off by default. Its job is narrow on
 * purpose, because a post-execute gate can block but cannot remove what is
 * already in context — pretending otherwise would be the kind of overclaim this
 * project exists to avoid.
 *
 * What it actually does: when a tool result is large but judged uninformative,
 * it is replaced with a short corrective note that tells the model what to do
 * differently. What it does *not* do: recover context already spent, or re-judge
 * earlier results.
 *
 * Two guards keep it from becoming a nuisance, which is the failure mode of
 * every context-pruning plugin in this ecosystem:
 *
 *  - **Small results are never judged.** Below `minChars` the gate does not run
 *    at all — no call, no transmission, no opinion. Most results are small.
 *  - **It fails open.** If Jev is unreachable or undecided, the result is kept.
 *    Losing a real result to a phantom "irrelevant" verdict is worse than
 *    keeping an uninformative one, and the model can still ask again.
 */
import type { EgressFeature } from '../egress.js';
import type { JevService } from '../service.js';
import { type JevQuestion } from '../types.js';
export declare const CONTEXT_FEATURE: EgressFeature;
/**
 * The two questions asked about one large result.
 *
 * `is_relevant` is the blocking question; `restates_goal` distinguishes "this is
 * off-topic" from "this merely repeats what we already knew", which call for
 * different next steps. Both are disclosed here because they are what leaves
 * the machine.
 */
export declare const CONTEXT_QUESTIONS: Readonly<Record<string, JevQuestion>>;
export interface ContextGateOptions {
    readonly service: JevService;
    /**
     * Minimum result size before the gate judges anything. Default 4000
     * characters: below this, judging costs more than the context it could save.
     */
    readonly minChars?: number;
    /** Below this relevance probability the result is blocked. */
    readonly minRelevance?: number;
    /** Minimum Jev confidence for its answer to count. */
    readonly minConfidence?: number;
    /**
     * Supplies the task description the result is judged against. When absent,
     * only `adds_information` is asked — judging relevance without knowing the
     * goal would be guessing.
     */
    readonly describeGoal?: () => string | undefined;
}
export interface ContextGateDecision {
    /** True when the caller should replace the result content. */
    readonly block: boolean;
    readonly feedback?: string;
    readonly reason?: string;
}
/** Flatten a result's content blocks into the text the gate judges. */
export declare const resultText: (content: readonly {
    type?: string;
    text?: string;
}[] | undefined) => string;
declare const TRUNCATION_NOTE = "\n\n[original result withheld by the dsh-jev context gate; re-run a narrower query if you need it]";
export declare const createContextGate: (options: ContextGateOptions) => (input: {
    readonly toolName: string;
    readonly content: readonly {
        type?: string;
        text?: string;
    }[] | undefined;
    readonly signal?: AbortSignal;
}) => Promise<ContextGateDecision>;
export { TRUNCATION_NOTE };
//# sourceMappingURL=context.d.ts.map