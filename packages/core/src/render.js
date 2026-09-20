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
/** One answer, flattened for the model. */
export const renderAnswer = (questionId, answer) => {
    if (answer === undefined) {
        return { question: questionId, type: 'noul', note: 'no answer returned for this question' };
    }
    if (answer.type === 'noul') {
        return {
            question: questionId,
            type: 'noul',
            answer: answer.noul >= 0.5 ? 'true' : 'false',
            noul: answer.noul,
            probability: Math.max(answer.noul, 1 - answer.noul),
            ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        };
    }
    const probability = answer.probabilities[answer.choice];
    return {
        question: questionId,
        type: answer.type,
        answer: answer.choice,
        ...(probability === undefined ? {} : { probability }),
        probabilities: { ...answer.probabilities },
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    };
};
const MOCK_WARNING = 'These answers are SYNTHETIC. The mock provider derived them from a hash of the input; ' +
    'they carry no judgment. Set provider to "live" and configure a TypeSafe credential for real answers.';
/** Build the canonical value every tool returns. */
export const renderResult = (result, questionIds) => ({
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    answers: questionIds.map((id) => renderAnswer(id, result.answers[id])),
    ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
    ...(result.provider === 'mock' ? { warning: MOCK_WARNING } : {}),
});
/**
 * Adapt a schema-inferred value back to the shape this module produced.
 *
 * The output schema declares fields as JSON nodes, so the registry infers
 * `JsonValue` for them and a presenter receives that wider type. This narrows
 * it for display without asserting anything the schema did not guarantee — the
 * value came from {@link renderResult}, which always produces this shape.
 */
export const asRendered = (value) => value;
/** A short human-readable line for a Native tool card. */
export const summarize = (value, headline) => {
    const parts = value.answers.map((answer) => {
        if (answer.note !== undefined)
            return `${answer.question}=?`;
        const probability = answer.probability === undefined ? '' : ` (${Math.round(answer.probability * 100)}%)`;
        return `${answer.question}=${answer.answer ?? '?'}${probability}`;
    });
    const synthetic = value.provider === 'mock' ? ' [synthetic]' : '';
    return `${headline}${synthetic} - ${parts.join(' ')} - ${value.latencyMs}ms`;
};
/** How many candidates a rank payload carries, defensively. */
export const rankingSize = (value) => {
    const ranking = value.ranking;
    return Array.isArray(ranking) ? ranking.length : 0;
};
//# sourceMappingURL=render.js.map