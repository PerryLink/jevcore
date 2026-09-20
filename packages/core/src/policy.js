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
import { topCriterion } from './primitives.js';
export const DEFAULT_POLICY = {
    minConfidence: 0.7,
    minProbability: 0.6,
};
/**
 * Apply a policy to one answer.
 *
 * `criteria` is the set the caller declared. An answer naming anything else is
 * `invalid` rather than trusted — the whole promise of a typed decision model
 * is that it cannot return an undeclared value, so a violation means something
 * upstream is wrong and acting on it would be unsafe.
 */
export const applyPolicy = (answer, criteria, options = DEFAULT_POLICY) => {
    if (answer === undefined)
        return { kind: 'undecided', reason: 'no-answer' };
    if (answer.type === 'noul') {
        const confidence = answer.confidence;
        if (confidence !== undefined && confidence < options.minConfidence) {
            return { kind: 'undecided', reason: 'below-confidence' };
        }
        const probability = answer.noul;
        const key = probability >= 0.5 ? 'true' : 'false';
        const strength = Math.max(probability, 1 - probability);
        if (strength < options.minProbability)
            return { kind: 'undecided', reason: 'below-confidence' };
        if (criteria.length > 0 && !criteria.includes(key)) {
            return { kind: 'invalid', reason: `noul resolved to "${key}", which is not a declared criterion` };
        }
        return { kind: 'decided', answer: key, probability: strength };
    }
    if (criteria.length > 0 && !criteria.includes(answer.choice)) {
        return {
            kind: 'invalid',
            reason: `answer "${answer.choice}" is not one of the declared criteria`,
        };
    }
    // Resolve which key the answer actually selects before judging its strength.
    // The reported `choice` wins when the distribution corroborates it; otherwise
    // the argmax does. Only then is the confidence floor applied, so a weak
    // reported choice cannot mask a strong distribution.
    const reported = answer.probabilities[answer.choice];
    const selected = reported !== undefined ? answer.choice : topCriterion(answer.probabilities);
    if (selected === undefined)
        return { kind: 'undecided', reason: 'no-answer' };
    const probability = answer.probabilities[selected] ?? reported ?? 0;
    const confidence = answer.confidence;
    if (confidence !== undefined && confidence < options.minConfidence) {
        return { kind: 'undecided', reason: 'below-confidence' };
    }
    if (probability < options.minProbability)
        return { kind: 'undecided', reason: 'below-confidence' };
    return { kind: 'decided', answer: selected, probability };
};
/** Convenience: apply a policy and reduce it to the tri-state a gate needs. */
export const verdictToAction = (verdict, options = DEFAULT_POLICY) => {
    if (verdict.kind === 'invalid')
        return 'deny';
    if (verdict.kind === 'undecided')
        return 'ask';
    const accepted = options.accept?.[verdict.answer];
    if (accepted === undefined)
        return 'ask';
    return accepted ? 'allow' : 'deny';
};
/** Read one answer out of a result, or `undefined` when it is absent. */
export const answerOf = (result, questionId) => result.answers[questionId];
//# sourceMappingURL=policy.js.map