/**
 * Question builders.
 *
 * These mirror the TypeSafe API primitives (`noul`, `choice`, `score`) and are
 * deliberately tiny: they exist so a caller cannot construct a question Jev
 * would reject, and so the batch shape is readable at the call site.
 */
import type { ChoiceQuestion, JevQuestion, NoulQuestion, ScoreQuestion } from './types.js';
/** Ask a yes/no question. The answer carries the probability of `true`. */
export declare const noul: (instructions: string) => NoulQuestion;
/**
 * Ask Jev to pick one of a fixed set.
 *
 * @param criteria - permitted answers mapped to an optional description.
 *   Keys are what Jev returns; values describe the key for the model.
 */
export declare const choice: (instructions: string, criteria: Readonly<Record<string, string | null>>) => ChoiceQuestion;
/** Ask Jev to place the state on an ordered scale of named levels. */
export declare const score: (instructions: string, criteria: Readonly<Record<string, string | null>>) => ScoreQuestion;
/** Reject a question whose criteria map would make an answer unverifiable. */
export declare const assertValidQuestion: (id: string, question: JevQuestion) => void;
/** Validate every question in one batch, throwing on the first defect. */
export declare const assertValidBatch: (questions: Readonly<Record<string, JevQuestion>>) => void;
/**
 * The top-scoring criterion of a categorical answer, or `undefined` when the
 * probabilities do not single one out.
 *
 * Ties yield `undefined` rather than an arbitrary winner: a caller deciding
 * whether to act should treat "no clear winner" as no answer, not as a win.
 */
export declare const topCriterion: (probabilities: Readonly<Record<string, number>>) => string | undefined;
//# sourceMappingURL=primitives.d.ts.map