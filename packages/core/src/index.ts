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
  EntryType,
  JevAnswer,
  JevErrorCode,
  JevProvider,
  JevProviderErrorOptions,
  JevQuestion,
  JevRequest,
  JevResult,
  JevEgressFacts,
  JevUsage,
  JsonValue,
  NoulAnswer,
  NoulCriteria,
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
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  assertValidBatch,
  assertValidQuestion,
  choice,
  isEmptyEntry,
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
  EgressShapeError,
  EgressTooLargeError,
  MIN_TRUNCATED_HEAD_CHARS,
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
  DEFAULT_REQUEST_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SAFETY_SEVERITY_BLOCK,
  SEVERITY_LEVELS,
  resolveConfig,
  type GateInput,
  type GateSettings,
  type JevConfig,
  type JevConfigInput,
  type ProviderKind,
  type SeverityLevel,
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
  armCallBudget,
  classifyProviderFailure,
  classifyStatus,
  isAbortFailure,
  isTimeoutFailure,
  requestIdOf,
  retryAfterOf,
  statusOf,
  type CallBudget,
  type ProviderCallContext,
  type ProviderFailure,
} from './provider/classify.js'
export {
  BODY_SAFE_LOG_LEVEL,
  DEFAULT_CALL_TOTAL_BUDGET_MS,
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MODEL,
  LiveProvider,
  NO_PER_ATTEMPT_TIMEOUT_MS,
  assertUsableEndpoint,
  loadOfficialSdk,
  sdkLogLevelFor,
  timeoutForSdk,
  type LiveProviderOptions,
  type LiveResult,
  type ProviderLogLevel,
} from './provider/live.js'
export {
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODEL_PREFIX,
  OpenRouterProvider,
  assertSystemOneModel,
  assertUsableOpenRouterEndpoint,
  type OpenRouterProviderOptions,
} from './provider/openrouter.js'

// Model catalogue and alias drift.
//
// A pin and an alias are different promises. `jev-1.13.0` names a fixed thing;
// `jev-latest` names whatever the service serves today, and it is the SDK's own
// default when no model is configured -- so "I did not choose a model" silently
// means "whatever is newest". The catalogue shows what the account can see, which
// is not the same as what answered; `checkAliasDrift` therefore needs an observed
// answer and reports `unknown` rather than guessing when it has none.
export {
  checkAliasDrift,
  listModels,
  probeAlias,
  readModelCards,
  resolveAliasFromAnswer,
  type AliasDrift,
  type AliasDriftVerdict,
  type AliasProbeOptions,
  type JevAliasResolution,
  type JevModelCard,
  type ModelCatalogOptions,
} from './provider/models.js'

// Service
export {
  DEFAULT_ASK_MANY_CONCURRENCY,
  JevService,
  type JevAskInput,
  type JevCallRecord,
  type JevServiceOptions,
  type JevStats,
} from './service.js'

// Self-consistency measurement (a diagnostic, not a gate).
//
// Asking one state N times says whether Jev agrees with itself; it says nothing
// about whether the answer is right. The distinction is the whole reason this is
// exported as its own module rather than folded into the service: a small spread
// is easy to over-read as a correctness result, and `runRepeated`'s doc comment
// is emphatic about what it does not measure.
export {
  runRepeated,
  type RepeatedObservation,
  type RepeatedQuestion,
  type RepeatedRun,
  type RepeatedRunOptions,
  type RepeatedSource,
} from './consistency.js'

// Resilience: an optional cache, a hard budget, and a failure breaker.
//
// All three are inert until `JevService` is given one, and that is the design
// rather than an oversight. Each of them can suppress a call, and a layer that
// can suppress a call has to be something an operator switched on deliberately.
//
// The cache in particular refuses to be a general-purpose memo: a feature may be
// protected from caching in code (`gate:safety` is, because a gate verdict is
// about a specific call, not about a reusable input), and a cache with no
// decision configured caches nothing at all.
export {
  AnswerCache,
  CACHE_KEY_SEPARATOR,
  CacheKeyError,
  DEFAULT_CACHE_EXCLUDED,
  DEFAULT_CACHE_MAX_ENTRIES,
  type AnswerCacheOptions,
  type CacheDecision,
  type CacheKey,
  type CachePolicy,
  type CacheStats,
} from './resilience/cache.js'
export {
  JevBudget,
  JevBudgetExceededError,
  ZERO_BUDGET,
  type BudgetDecision,
  type BudgetLimits,
  type BudgetOptions,
  type JevBudgetReport,
  type UnknownCostPolicy,
} from './resilience/budget.js'
export {
  BreakerOpenError,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  FailureBreaker,
  type BreakerOptions,
  type BreakerSnapshot,
  type BreakerState,
} from './resilience/breaker.js'

// Policy
export {
  DEFAULT_MIN_PROBABILITY,
  DEFAULT_POLICY,
  answerOf,
  applyPolicy,
  verdictToAction,
  type PolicyOptions,
  type ThresholdPair,
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

// Composite scoring (pure: answers in, numbers out)
export {
  compositeScore,
  normalizeScore,
  type CompositeScore,
  type Contribution,
} from './compose.js'

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
  SAFETY_QUESTIONS,
  SEVERITY_QUESTION_ID,
  SEVERITY_QUESTIONS,
  createSafetyGate,
  isGated,
  serializeArguments,
  type GateDecision,
  type SafetyGateOptions,
} from './gates/safety.js'
