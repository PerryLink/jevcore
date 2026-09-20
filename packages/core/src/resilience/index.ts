/**
 * The resilience layer, as one surface.
 *
 * Three modules that a caller reaches for at three different moments in one call
 * path, and that share one property worth naming here rather than three times:
 * **each is inert until it is constructed, and each is a pure state machine over
 * an injected clock.** No timers, no background work, no module-level state. A
 * process that constructs none of them behaves exactly as it did before this
 * directory existed, which is the only defensible default for machinery whose
 * subject is whether to transmit.
 *
 * The order they sit in on the call path, and why:
 *
 *  1. {@link JevBudget} — may this process afford another call at all? Asked
 *     first because a refusal here means nothing is prepared, measured, or sent.
 *  2. {@link FailureBreaker} — is the upstream in a state where asking is
 *     pointless? Asked second, and it consumes the same failure codes the
 *     classifier produces rather than forming its own opinion.
 *  3. {@link AnswerCache} — has this exact measured payload already been answered?
 *     Last, because it is the only one of the three that answers by returning
 *     something other than a refusal, and because its key is derived from the
 *     measurement the egress contract performed.
 *
 * Nothing here imports the service, and nothing here is imported by it. The
 * integrator wires them; keeping the direction one-way is what makes these
 * modules testable without a provider and a service.
 */

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
} from './cache.js'

export {
  JevBudget,
  JevBudgetExceededError,
  ZERO_BUDGET,
  type BudgetDecision,
  type BudgetLimits,
  type BudgetOptions,
  type JevBudgetReport,
  type UnknownCostPolicy,
} from './budget.js'

export {
  BreakerOpenError,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  FailureBreaker,
  type BreakerOptions,
  type BreakerSnapshot,
  type BreakerState,
} from './breaker.js'
