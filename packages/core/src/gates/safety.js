/**
 * The safety gate: judge a tool call before it runs.
 *
 * Registered on `tools/pre-execute`, off by default. When enabled, every
 * matching tool call is judged against a published list of hazards before
 * dispatch.
 *
 * Three things this gate deliberately does NOT do, each of which an existing
 * third-party plugin in this ecosystem does:
 *
 *  - **It cannot fail open silently.** An undecided verdict resolves through
 *    `onUndecided`, which defaults to `ask` — the human sees it. A gate that
 *    allows on uncertainty is not a gate.
 *  - **It cannot be reconfigured by the model.** Nothing in this plugin
 *    exposes a tool that changes gate behaviour. The model cannot widen,
 *    narrow, or disable the check that constrains it.
 *  - **It does not trust a probability it did not understand.** The hazards are
 *    declared here as fixed questions; Jev answers them, and local code decides.
 *
 * The hazard list is also the egress disclosure: this is exactly what is sent.
 */
import { noul } from '../primitives.js';
import { applyPolicy } from '../policy.js';
import { JevProviderError } from '../types.js';
export const SAFETY_FEATURE = 'gate:safety';
/**
 * The hazards asked about, in order. Each is a yes/no question; a `true`
 * probability above the policy floor asks the human before the call proceeds.
 *
 * Public because this list is a disclosure: an operator enabling the gate is
 * entitled to know what it looks for, and a test asserts the questions actually
 * sent match this declaration.
 */
export const HAZARD_QUESTIONS = {
    irreversible_destruction: noul('Does this tool call destroy data or state in a way that cannot be undone (deleting files or ' +
        'rows, dropping a database, discarding uncommitted work, force-overwriting a file)?'),
    privilege_escalation: noul('Does this tool call escalate privileges, change permissions or ownership, modify system ' +
        'configuration, or disable a security control?'),
    credential_exposure: noul('Does this tool call send credential material, private keys, or secrets to a remote endpoint, ' +
        'or write them somewhere they would be exposed?'),
    external_side_effect: noul('Does this tool call affect a system outside this workspace in a way that is hard to reverse ' +
        '(publishing, deploying, pushing to a shared branch, sending a message, spending money)?'),
    history_rewrite: noul('Does this tool call rewrite shared history or discard work that is not this session’s own ' +
        '(force-push, hard reset, rebase of published commits, deleting a branch)?'),
};
/**
 * Tools the gate applies to.
 *
 * A denylist of tool-name fragments rather than an allowlist of every tool:
 * a gate that only recognises one naming scheme silently stops applying the
 * moment a new execution tool appears. Matching is prefix/substring based so
 * `pwsh`, `bash`, `shell`, and a `mcp__*__shell` variant are all covered.
 */
export const DEFAULT_GATED_TOOL_PATTERNS = [
    'pwsh',
    'bash',
    'shell',
    'exec',
    'write',
    'edit',
    'delete',
    'remove',
    'move',
    'rename',
    'git',
    'run_code',
];
/** Whether the gate applies to a tool name. */
export const isGated = (name, patterns = DEFAULT_GATED_TOOL_PATTERNS) => {
    const lower = name.toLowerCase();
    return patterns.some((pattern) => lower.includes(pattern));
};
/**
 * Serialize tool arguments for judging.
 *
 * Byte-capped at the call site by the egress contract, and stable-ordered so
 * the same call always produces the same state — which keeps the offline test
 * fixtures meaningful.
 */
export const serializeArguments = (args) => {
    try {
        const serialized = JSON.stringify(args);
        return serialized ?? String(args);
    }
    catch {
        // A cyclic or otherwise unserializable argument set is itself worth
        // flagging, but failing here would deny every call. Describe it instead.
        return '[arguments could not be serialized]';
    }
};
export const createSafetyGate = (options) => {
    const patterns = options.toolPatterns ?? DEFAULT_GATED_TOOL_PATTERNS;
    const decide = (verdicts) => {
        const raised = [];
        let undecided;
        for (const [hazard, verdict] of Object.entries(verdicts)) {
            if (verdict.kind === 'decided' && verdict.answer === 'true') {
                const probability = verdict.probability;
                if (probability >= (options.minProbability ?? 0.6))
                    raised.push(hazard);
                else
                    undecided ??= hazard;
                continue;
            }
            if (verdict.kind !== 'decided')
                undecided ??= hazard;
        }
        if (raised.length > 0) {
            return {
                kind: 'ask',
                reason: `dsh-jev safety gate: Jev flagged ${raised.join(', ')} for this call. ` +
                    `Approve to proceed.`,
                raised,
            };
        }
        if (undecided !== undefined) {
            if (options.onUndecided === 'allow')
                return { kind: 'allow' };
            if (options.onUndecided === 'deny') {
                return {
                    kind: 'deny',
                    reason: `dsh-jev safety gate: could not judge ${undecided} (onUndecided=deny).`,
                };
            }
            return {
                kind: 'ask',
                reason: `dsh-jev safety gate: could not judge ${undecided}. Approve to proceed.`,
            };
        }
        return { kind: 'allow' };
    };
    return async (input) => {
        if (!isGated(input.name, patterns))
            return { kind: 'allow' };
        if (!options.service.egress.allows(SAFETY_FEATURE)) {
            // The egress contract is the authority. A gate that ran while its
            // transmission was disabled would be judging nothing and saying nothing.
            return { kind: 'allow' };
        }
        const context = options.describeContext?.();
        const state = {
            tool: input.name,
            arguments: serializeArguments(input.args),
            ...(context === undefined ? {} : { context }),
        };
        let result;
        try {
            result = await options.service.ask({
                feature: SAFETY_FEATURE,
                state,
                questions: HAZARD_QUESTIONS,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
        }
        catch (error) {
            // A gate that cannot reach its judge must not wave the call through as if
            // it had been checked. Route the failure through the same undecided path.
            const detail = error instanceof JevProviderError ? error.code : 'unavailable';
            if (options.onUndecided === 'allow')
                return { kind: 'allow' };
            return {
                kind: options.onUndecided === 'deny' ? 'deny' : 'ask',
                reason: `dsh-jev safety gate could not reach Jev (${detail}).`,
            };
        }
        const policy = {
            minConfidence: options.minConfidence ?? 0.7,
            minProbability: options.minProbability ?? 0.6,
        };
        const verdicts = {};
        for (const [hazard, question] of Object.entries(HAZARD_QUESTIONS)) {
            if (question.type !== 'noul')
                continue;
            verdicts[hazard] = applyPolicy(result.answers[hazard], ['true', 'false'], policy);
        }
        return decide(verdicts);
    };
};
//# sourceMappingURL=safety.js.map