/**
 * Question builders.
 *
 * These mirror the TypeSafe API primitives (`noul`, `choice`, `score`) and are
 * deliberately tiny: they exist so a caller cannot construct a question Jev
 * would reject, and so the batch shape is readable at the call site.
 */
/** Ask a yes/no question. The answer carries the probability of `true`. */
export const noul = (instructions) => ({
    type: 'noul',
    instructions,
});
/**
 * Ask Jev to pick one of a fixed set.
 *
 * @param criteria - permitted answers mapped to an optional description.
 *   Keys are what Jev returns; values describe the key for the model.
 */
export const choice = (instructions, criteria) => ({
    type: 'choice',
    instructions,
    criteria,
});
/** Ask Jev to place the state on an ordered scale of named levels. */
export const score = (instructions, criteria) => ({
    type: 'score',
    instructions,
    criteria,
});
/** Reject a question whose criteria map would make an answer unverifiable. */
export const assertValidQuestion = (id, question) => {
    if (question.instructions.trim().length === 0) {
        throw new Error(`question "${id}" has empty instructions`);
    }
    if (question.type === 'noul')
        return;
    const keys = Object.keys(question.criteria);
    if (keys.length < 2) {
        throw new Error(`question "${id}" is ${question.type} but declares ${keys.length} criteria`);
    }
};
/** Validate every question in one batch, throwing on the first defect. */
export const assertValidBatch = (questions) => {
    const ids = Object.keys(questions);
    if (ids.length === 0)
        throw new Error('a Jev request needs at least one question');
    for (const id of ids) {
        const question = questions[id];
        if (question === undefined)
            throw new Error(`question "${id}" is undefined`);
        assertValidQuestion(id, question);
    }
};
/**
 * The top-scoring criterion of a categorical answer, or `undefined` when the
 * probabilities do not single one out.
 *
 * Ties yield `undefined` rather than an arbitrary winner: a caller deciding
 * whether to act should treat "no clear winner" as no answer, not as a win.
 */
export const topCriterion = (probabilities) => {
    let best;
    let bestValue = Number.NEGATIVE_INFINITY;
    let tied = false;
    for (const [key, value] of Object.entries(probabilities)) {
        if (value > bestValue) {
            best = key;
            bestValue = value;
            tied = false;
        }
        else if (value === bestValue) {
            tied = true;
        }
    }
    return tied ? undefined : best;
};
//# sourceMappingURL=primitives.js.map