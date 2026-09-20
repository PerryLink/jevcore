/**
 * `jevcore` — TypeSafe Jev decisions, with no framework attached.
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

// Types
export type {
  CategoricalAnswer,
  JevAnswer,
  JevErrorCode,
  JevProvider,
  JevQuestion,
  JevRequest,
  JevResult,
  JevUsage,
  JsonValue,
  NoulAnswer,
  NoulQuestion,
  ChoiceQuestion,
  ScoreAnswer,
  ScoreQuestion,
  Redacted,
  RedactionSummary,
} from './types.js'
export { JevProviderError } from './types.js'

// Primitives
export {
  assertValidBatch,
  assertValidQuestion,
  choice,
  noul,
  score,
  scoreCriteriaArray,
  topCriterion,
} from './primitives.js'

// Answer normalization, shared by every route so they cannot drift apart
export { isRecord, normalizeAnswer } from './answers.js'

// Redaction
export {
  DEFAULT_KEY_RULES,
  DEFAULT_VALUE_RULES,
  redact,
  truncateSerialized,
  type RedactOptions,
  type ValueRule,
} from './redact.js'

// Egress
export {
  EGRESS_FEATURES,
  EGRESS_FIELDS,
  EgressContract,
  EgressDeniedError,
  EgressTooLargeError,
  type EgressFeature,
  type EgressField,
  type EgressLine,
  type EgressSettings,
  type MeasuredPayload,
} from './egress.js'

// Configuration
export {
  ConfigError,
  DEFAULT_CONFIG,
  resolveConfig,
  type GateInput,
  type GateSettings,
  type JevConfig,
  type JevConfigInput,
  type ProviderKind,
} from './config.js'
export { Config, validateConfig } from './schema.js'

// Credentials
export {
  describeKeySource,
  resolveApiKey,
  type CredentialResolver,
  type KeySource,
  type ResolveKeyOptions,
  type ResolvedKey,
} from './credentials.js'

// Providers
export { MOCK_CONFIDENCE, MOCK_MODEL, MockProvider, fnv1a } from './provider/mock.js'
export {
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MODEL,
  LiveProvider,
  assertUsableEndpoint,
  loadOfficialSdk,
  type LiveProviderOptions,
  type ProviderLogLevel,
} from './provider/live.js'
export {
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODEL_PREFIX,
  OpenRouterProvider,
  assertSystemOneModel,
  assertUsableOpenRouterEndpoint,
  loadOpenRouterSdk,
  type OpenRouterProviderOptions,
} from './provider/openrouter.js'

// Service
export { JevService, type JevAskInput, type JevCallRecord, type JevServiceOptions, type JevStats } from './service.js'

// Policy
export {
  DEFAULT_POLICY,
  answerOf,
  applyPolicy,
  verdictToAction,
  type PolicyOptions,
  type Verdict,
} from './policy.js'

// Claim verification (pure resolution; the DSH tool is a thin adapter over it)
export {
  DEFAULT_CHECK_THRESHOLDS,
  VERDICT_QUESTION,
  resolveCheck,
  type CheckResolution,
  type CheckThresholds,
  type CheckVerdict,
} from './check.js'

// Rendering helpers (framework-agnostic: they produce plain objects)
export {
  DEFAULT_NOUL_BAND,
  asRendered,
  noulBand,
  rankingSize,
  renderAnswer,
  renderResult,
  summarize,
  type NoulBand,
  type NoulBandBounds,
  type RenderedAnswer,
  type RenderedResult,
} from './render.js'

// Gates (framework-agnostic: they take a plain input and return a decision)
export {
  CONTEXT_QUESTIONS,
  CONTEXT_FEATURE,
  createContextGate,
  resultText,
  type ResultBlock,
  type ContextGateDecision,
  type ContextGateOptions,
} from './gates/context.js'
export {
  DEFAULT_GATED_TOOL_PATTERNS,
  HAZARD_QUESTIONS,
  SAFETY_FEATURE,
  createSafetyGate,
  isGated,
  serializeArguments,
  type GateDecision,
  type SafetyGateOptions,
} from './gates/safety.js'
