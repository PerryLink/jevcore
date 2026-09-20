/**
 * Tool output formatting.
 *
 * Kept separate so the tools themselves stay about decisions, and so the shape
 * the model sees is reviewable in one place.
 *
 * Two rules hold across every tool here:
 *
 *  - **A missing answer is reported as missing.** Nothing is filled in, and no
 *    default confidence is invented. A model that cannot see an answer knows to
 *    ask again; a model shown a fabricated one will act on it.
 *  - **The provider is named.** When the mock answers, the model is told so, so
 *    a synthetic value cannot be mistaken for a real judgment.
 */
import type { JevAnswer, JevResult, JevUsage } from './types.js';
/**
 * Declared as a type alias rather than an interface on purpose: the tool-output
 * schema validates this as lossless JSON, and only an alias receives the
 * implicit index signature that makes it assignable to `JsonValue`.
 */
export type RenderedAnswer = {
    question: string;
    type: JevAnswer['type'];
    /** Selected key: `"true"`/`"false"` for noul, the criterion otherwise. */
    answer?: string;
    /** Probability of the selected key. */
    probability?: number;
    /** Probability of `true`, for noul answers only. */
    noul?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
    /** Present when the question was asked and Jev returned nothing for it. */
    note?: string;
};
/** One answer, flattened for the model. */
export declare const renderAnswer: (questionId: string, answer: JevAnswer | undefined) => RenderedAnswer;
/** Type alias for the same reason as {@link RenderedAnswer}. */
export type RenderedResult = {
    provider: string;
    model: string;
    latencyMs: number;
    answers: RenderedAnswer[];
    usage?: JevUsage;
    /**
     * Present only for the mock provider. Stated in the result itself so the
     * model cannot treat a synthetic answer as a real judgment.
     */
    warning?: string;
};
/** Build the canonical value every tool returns. */
export declare const renderResult: (result: JevResult, questionIds: readonly string[]) => RenderedResult;
/**
 * Adapt a schema-inferred value back to the shape this module produced.
 *
 * The output schema declares fields as JSON nodes, so the registry infers
 * `JsonValue` for them and a presenter receives that wider type. This narrows
 * it for display without asserting anything the schema did not guarantee — the
 * value came from {@link renderResult}, which always produces this shape.
 */
export declare const asRendered: (value: unknown) => RenderedResult;
/** A short human-readable line for a Native tool card. */
export declare const summarize: (value: RenderedResult, headline: string) => string;
/** How many candidates a rank payload carries, defensively. */
export declare const rankingSize: (value: unknown) => number;
//# sourceMappingURL=render.d.ts.map