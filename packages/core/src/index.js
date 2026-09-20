/**
 * `@dsh-jev/core` — TypeSafe Jev decisions, with no framework attached.
 *
 * Nothing here imports DeepSeek Harness, Cordis, or any plugin runtime. The
 * package is usable from a plain Node script, an MCP server, a CLI, or an
 * agent harness adapter, which is why the DSH plugin is a thin layer over it
 * rather than the other way around.
 *
 * The two ideas worth knowing before reading further:
 *
 *  - **The egress contract** ({@link EgressContract}) is the single place that
 *    decides what may leave the machine. Every feature declares the fields it
 *    would send and the cap on each, no feature transmits unless it is enabled,
 *    and the contract can describe itself as a human-readable report.
 *  - **A probability is not a permission.** {@link applyPolicy} turns Jev's
 *    calibrated numbers into `allow`/`ask`/`deny` against thresholds that live
 *    in your configuration, never in model output.
 */
export { JevProviderError } from './types.js';
// Primitives
export { assertValidBatch, assertValidQuestion, choice, noul, score, topCriterion } from './primitives.js';
// Redaction
export { DEFAULT_KEY_RULES, DEFAULT_VALUE_RULES, redact, truncateSerialized, } from './redact.js';
// Egress
export { EGRESS_FEATURES, EGRESS_FIELDS, EgressContract, EgressDeniedError, } from './egress.js';
// Configuration
export { ConfigError, DEFAULT_CONFIG, resolveConfig, } from './config.js';
export { Config, validateConfig } from './schema.js';
// Credentials
export { describeKeySource, resolveApiKey, } from './credentials.js';
// Providers
export { MOCK_CONFIDENCE, MOCK_MODEL, MockProvider, fnv1a } from './provider/mock.js';
export { DEFAULT_ENDPOINT, DEFAULT_MODEL, LiveProvider, assertUsableEndpoint, loadOfficialSdk, } from './provider/live.js';
// Service
export { JevService } from './service.js';
// Policy
export { DEFAULT_POLICY, answerOf, applyPolicy, verdictToAction, } from './policy.js';
// Rendering helpers (framework-agnostic: they produce plain objects)
export { asRendered, rankingSize, renderAnswer, renderResult, summarize, } from './render.js';
// Gates (framework-agnostic: they take a plain input and return a decision)
export { CONTEXT_QUESTIONS, CONTEXT_FEATURE, createContextGate, resultText, } from './gates/context.js';
export { DEFAULT_GATED_TOOL_PATTERNS, HAZARD_QUESTIONS, SAFETY_FEATURE, createSafetyGate, isGated, serializeArguments, } from './gates/safety.js';
//# sourceMappingURL=index.js.map