/**
 * The `ctx.jev` service.
 *
 * This is the plugin's primary surface, and the reason it exists as a plugin
 * rather than only as model-visible tools: other plugins and Host code can call
 * Jev directly, with no model turn in between. A routing decision, a gate, or a
 * background classifier should not cost a model round-trip.
 *
 * The service owns three things the rest of the plugin must not duplicate:
 * redaction before transmission, the egress check, and the honest record of
 * what actually happened.
 */
import { EgressContract } from './egress.js';
import { redact } from './redact.js';
export class JevService {
    options;
    history = [];
    historyLimit;
    calls = 0;
    failures = 0;
    transmitted = 0;
    totalLatencyMs = 0;
    totalInputTokens = 0;
    totalCostUsd = 0;
    lastCall;
    constructor(options) {
        this.options = options;
        this.historyLimit = options.historyLimit ?? 20;
    }
    /** Provider identity, for reports. */
    get providerId() {
        return this.options.provider.id;
    }
    /** Whether the configured provider can reach the network. */
    get transmitting() {
        return this.options.transmitting ?? false;
    }
    /** The egress contract, exposed so other plugins can inspect it. */
    get egress() {
        return this.options.egress;
    }
    /**
     * Answer one batch of questions.
     *
     * Redaction runs before the egress measurement, so the reported sizes are
     * the sizes that actually leave, not the sizes of the raw input.
     */
    async ask(input) {
        // `measure` performs the egress check and throws before anything leaves.
        // The transmission counter is incremented only after it returns, so a
        // denied call is never reported as transmitted.
        const measured = this.options.egress.measure({
            feature: input.feature,
            state: input.state,
            questions: input.questions,
            redact,
        });
        const startedAt = Date.now();
        this.transmitted += 1;
        try {
            const result = await this.options.provider.answer({
                state: measured.state,
                questions: measured.questions,
                ...(this.options.model === undefined ? {} : { model: this.options.model }),
            }, input.signal);
            this.record({
                feature: input.feature,
                at: startedAt,
                latencyMs: result.latencyMs,
                ok: true,
                redactionRules: measured.redactionRules,
                redactions: measured.redactions,
                stateChars: measured.stateChars,
            });
            this.calls += 1;
            this.totalLatencyMs += result.latencyMs;
            this.totalInputTokens += result.usage?.inputTokens ?? 0;
            this.totalCostUsd += result.usage?.costUsd ?? 0;
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.record({
                feature: input.feature,
                at: startedAt,
                latencyMs: Date.now() - startedAt,
                ok: false,
                redactionRules: measured.redactionRules,
                redactions: measured.redactions,
                stateChars: measured.stateChars,
                error: message.slice(0, 300),
            });
            this.failures += 1;
            throw error;
        }
    }
    /** Counters for a status surface. Contains no payloads. */
    stats() {
        return {
            calls: this.calls,
            failures: this.failures,
            transmitted: this.transmitted,
            totalLatencyMs: this.totalLatencyMs,
            totalInputTokens: this.totalInputTokens,
            totalCostUsd: this.totalCostUsd,
            lastCall: this.lastCall,
        };
    }
    /** Recent calls, newest last. */
    recent() {
        return this.history;
    }
    record(entry) {
        this.history.push(entry);
        if (this.history.length > this.historyLimit)
            this.history.shift();
        this.lastCall = entry;
    }
}
//# sourceMappingURL=service.js.map