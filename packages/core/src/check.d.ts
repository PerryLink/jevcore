/**
 * Claim verification: resolve a set of `noul` answers into one verdict.
 *
 * Framework-agnostic on purpose — it takes a {@link JevResult} and returns a
 * judgment, so the same resolution backs the DSH tool, an MCP tool, or a plain
 * script.
 *
 * The shape of the answer is the point. A single yes/no cannot distinguish
 * "not supported" from "actively refuted", and those call for different
 * actions. So three independent questions are asked — supports, contradicts,
 * sufficient — and this module resolves them with an explicit precedence order
 * that lives in code, not in the model.
 *
 * The precedence is not arbitrary. Contradiction outranks support: evidence
 * that both supports and refutes a claim is a conflict, not a weak yes, and
 * reporting it as "supported" would be the most damaging error available here.
 */
import type { JevResult } from './types.js';
/** The question ids this module reads. */
export declare const VERDICT_QUESTION: {
    readonly supports: "supports_claim";
    readonly contradicts: "contradicts_claim";
    readonly sufficient: "evidence_is_sufficient";
};
/** The verdict resolved from three probabilities. */
export type CheckVerdict = 'supported' | 'contradicted' | 'conflicted' | 'insufficient' | 'unknown';
export interface CheckResolution {
    readonly verdict: CheckVerdict;
    readonly supports: number | undefined;
    readonly contradicts: number | undefined;
    readonly sufficient: number | undefined;
}
export interface CheckThresholds {
    /** Probability of `supports_claim` needed for a `supported` verdict. */
    readonly support: number;
    /** Probability of `contradicts_claim` needed for a `contradicted` verdict. */
    readonly contradiction: number;
    /** Below this, `evidence_is_sufficient` reads as insufficient. */
    readonly sufficiency: number;
}
export declare const DEFAULT_CHECK_THRESHOLDS: CheckThresholds;
/** Resolve three probabilities into one verdict. Pure, so the precedence is testable. */
export declare const resolveCheck: (result: JevResult, thresholds?: CheckThresholds) => CheckResolution;
//# sourceMappingURL=check.d.ts.map