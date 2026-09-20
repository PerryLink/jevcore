/**
 * Public types for the Jev decision layer.
 *
 * Jev is TypeSafe's System One model: it does not generate prose. It answers
 * typed questions and returns calibrated probabilities. These types model
 * exactly that surface — three primitives, one state, one batch of questions.
 */
/**
 * A provider failure. Carries a machine-readable code so gates can fail closed
 * on the reason rather than on a message string.
 */
export class JevProviderError extends Error {
    code;
    name = 'JevProviderError';
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
    }
}
//# sourceMappingURL=types.js.map