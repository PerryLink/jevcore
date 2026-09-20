/**
 * Local decision policy.
 *
 * Jev returns calibrated probabilities. It does not return permission. This
 * module is where a probability becomes an action, and the split is deliberate:
 *
 *  - the thresholds are local configuration, not model output;
 *  - nothing the model can say changes them;
 *  - an answer below the confidence floor yields `undecided`, never a default
 *    allow.
 *
 * That last point is the one that matters. A gate that defaults to "allow" when
 * it is unsure is not a gate. A gate that decides from a probability it did not
 * understand is worse — it looks like one.
 */
import type { JevAnswer, JevResult } from './types.js';
/** The outcome of applying a local policy to one Jev answer. */
export type Verdict = 
/** The answer was clear enough and crossed the threshold. */
{
    readonly kind: 'decided';
    readonly answer: string;
    readonly probability: number;
}
/** Jev answered, but not confidently enough for this threshold. */
 | {
    readonly kind: 'undecided';
    readonly reason: 'below-confidence' | 'no-answer';
}
/** The answer selected a value outside the declared criteria. */
 | {
    readonly kind: 'invalid';
    readonly reason: string;
};
export interface PolicyOptions {
    /**
     * Minimum `confidence` for an answer to be acted upon. Jev's own calibration
     * is the point of the model, so this is a floor on trusting it, not a
     * substitute for it.
     */
    readonly minConfidence: number;
    /**
     * Minimum probability of the selected criterion. Guards the case where Jev
     * is confident but the distribution is nearly flat.
     */
    readonly minProbability: number;
    /**
     * Optional per-verdict mapping from criterion key to whether the caller
     * should act. Keys absent from the map yield `undecided`.
     */
    readonly accept?: Readonly<Record<string, boolean>>;
}
export declare const DEFAULT_POLICY: PolicyOptions;
/**
 * Apply a policy to one answer.
 *
 * `criteria` is the set the caller declared. An answer naming anything else is
 * `invalid` rather than trusted — the whole promise of a typed decision model
 * is that it cannot return an undeclared value, so a violation means something
 * upstream is wrong and acting on it would be unsafe.
 */
export declare const applyPolicy: (answer: JevAnswer | undefined, criteria: readonly string[], options?: PolicyOptions) => Verdict;
/** Convenience: apply a policy and reduce it to the tri-state a gate needs. */
export declare const verdictToAction: (verdict: Verdict, options?: PolicyOptions) => "allow" | "deny" | "ask";
/** Read one answer out of a result, or `undefined` when it is absent. */
export declare const answerOf: (result: JevResult, questionId: string) => JevAnswer | undefined;
//# sourceMappingURL=policy.d.ts.map