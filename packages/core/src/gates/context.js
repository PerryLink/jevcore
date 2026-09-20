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
import { noul } from '../primitives.js';
import { applyPolicy } from '../policy.js';
import { JevProviderError } from '../types.js';
export const CONTEXT_FEATURE = 'gate:context';
/**
 * The two questions asked about one large result.
 *
 * `is_relevant` is the blocking question; `restates_goal` distinguishes "this is
 * off-topic" from "this merely repeats what we already knew", which call for
 * different next steps. Both are disclosed here because they are what leaves
 * the machine.
 */
export const CONTEXT_QUESTIONS = {
    is_relevant: noul('Is this tool result relevant to making progress on the task described above? Answer false ' +
        'if it is boilerplate, an error unrelated to the task, navigation or index noise, a listing ' +
        'with no bearing on the task, or content that plainly does not help.'),
    adds_information: noul('Does this tool result add information that was not already stated in the task description ' +
        'above? Answer false if it only restates what was already given.'),
};
/** Flatten a result's content blocks into the text the gate judges. */
export const resultText = (content) => {
    if (content === undefined)
        return '';
    return content
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .filter((text) => text.length > 0)
        .join('\n');
};
const TRUNCATION_NOTE = '\n\n[original result withheld by the dsh-jev context gate; re-run a narrower query if you need it]';
export const createContextGate = (options) => {
    const minChars = options.minChars ?? 4_000;
    const minRelevance = options.minRelevance ?? 0.4;
    return async (input) => {
        const text = resultText(input.content);
        if (text.length < minChars)
            return { block: false };
        if (!options.service.egress.allows(CONTEXT_FEATURE))
            return { block: false };
        const goal = options.describeGoal?.();
        const questions = { ...CONTEXT_QUESTIONS };
        // Without a goal, "is this relevant" has no referent. Ask only what can be
        // answered without one.
        if (goal === undefined || goal.trim().length === 0)
            delete questions.is_relevant;
        let result;
        try {
            result = await options.service.ask({
                feature: CONTEXT_FEATURE,
                state: {
                    tool: input.toolName,
                    ...(goal === undefined ? {} : { task: goal.slice(0, 2_000) }),
                    result: text,
                },
                questions,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
        }
        catch (error) {
            // Fail open: a judge we cannot reach must never cost the model a result.
            const detail = error instanceof JevProviderError ? error.code : 'unavailable';
            return { block: false, reason: `jev unavailable (${detail})` };
        }
        const policy = {
            minConfidence: options.minConfidence ?? 0.7,
            minProbability: minRelevance,
        };
        const relevance = questions.is_relevant
            ? applyPolicy(result.answers.is_relevant, ['true', 'false'], policy)
            : undefined;
        const adds = applyPolicy(result.answers.adds_information, ['true', 'false'], policy);
        // Only a confident "not relevant" blocks. Everything else keeps the result.
        if (relevance?.kind === 'decided' && relevance.answer === 'false') {
            return {
                block: true,
                feedback: `The result from ${input.toolName} was judged not relevant to the task ` +
                    `(relevance ${Math.round((1 - relevance.probability) * 100)}% against). It was withheld ` +
                    `to save context. Try a narrower query, or state what you are looking for.`,
            };
        }
        if (adds.kind === 'decided' && adds.answer === 'false') {
            return {
                block: true,
                feedback: `The result from ${input.toolName} only restated information already given. It was ` +
                    `withheld to save context. Use what you already have, or ask something new.`,
            };
        }
        return { block: false };
    };
};
export { TRUNCATION_NOTE };
//# sourceMappingURL=context.js.map