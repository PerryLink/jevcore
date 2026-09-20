/**
 * jevcore — TypeSafe Jev for DeepSeek Harness.
 *
 * Composition of this plugin:
 *
 *   - one service, `ctx.jev`, so other plugins and Host code can ask Jev
 *     directly without a model round-trip;
 *   - three model-visible tools built on that service;
 *   - two opt-in gates on real DSH interception points.
 *
 * Everything is off the network by default. The provider defaults to the
 * offline mock, and both gates default to disabled, so a fresh install makes no
 * network call and reads no tool result.
 *
 * The startup log is the contract: one line per feature says whether it will
 * transmit and which fields it would send. Read it rather than the README.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_CONFIG,
  DEFAULT_ENDPOINT,
  EgressContract,
  JevProviderError,
  JevService,
  LiveProvider,
  MockProvider,
  OpenRouterProvider,
  createContextGate,
  createSafetyGate,
  resolveApiKey,
  resolveConfig,
  type JevConfigInput,
  type JevProvider,
} from 'jevcore'
import type { JevCallRecord } from 'jevcore'
import { jevAskTool } from './ask.js'
import { jevCheckTool } from './check.js'
import { jevRankTool } from './rank.js'
import { skillRegistration } from './skill.js'

/** Plugin name, also the service key this plugin publishes. */
export const name = 'jevcore'

/**
 * Host services this plugin consumes.
 *
 * Only the two it cannot work without. `tools` is where the three tools are
 * registered; `credentials` is how a key is resolved.
 *
 * `skills` is deliberately absent. Every key in `inject` makes the fiber wait
 * for that service, so listing it would leave the plugin `pending` forever in a
 * profile that does not compose the skill subsystem — which is most of them, and
 * which is exactly what happened here. The registry is looked up at runtime
 * through `ctx.get('skills')` instead, and its absence is a warning rather than a
 * failure.
 */
export const inject = ['tools', 'credentials']

/**
 * The configuration schema, as Cordis consumes it.
 *
 * This export is load-bearing. Cordis treats a plugin's `Config` as a Standard
 * Schema and calls `Config['~standard'].validate(config)` before the plugin
 * starts (`vendor/cordis/src/fiber.ts:53`), so a plugin exporting anything else
 * under this name - documentation, a plain default object - fails activation
 * with `Cannot read properties of undefined (reading 'validate')`.
 *
 * It delegates to the same `resolveConfig` the plugin uses at runtime, so the
 * Loader's validation and the plugin's own can never disagree.
 */
export { Config } from 'jevcore'

/**
 * A description of the config shape, for documentation and the patch file.
 *
 * Kept under a different name from `Config`, which must remain the Standard
 * Schema above.
 *
 * Derived from `DEFAULT_CONFIG` rather than restated. This is the copy a user
 * reads to decide what to set, so it is the worst one to let drift: it held its
 * own literals for the model, the log level and both thresholds, which meant a
 * change to the real defaults would leave the documentation confidently wrong.
 */
export const CONFIG_DOC = {
  provider: DEFAULT_CONFIG.provider,
  apiKeyRef: DEFAULT_CONFIG.apiKeyRef,
  model: DEFAULT_CONFIG.model,
  logLevel: DEFAULT_CONFIG.logLevel,
  requestTimeoutMs: DEFAULT_CONFIG.requestTimeoutMs,
  requestMaxRetries: DEFAULT_CONFIG.requestMaxRetries,
  minConfidence: DEFAULT_CONFIG.minConfidence,
  minProbability: DEFAULT_CONFIG.minProbability,
  gates: {
    safety: { enabled: false, onUndecided: 'ask' },
    context: { enabled: false, onUndecided: 'ask' },
  },
} as const

type Level = 'silent' | 'warn' | 'info' | 'debug'
const ORDER: Record<Level, number> = { silent: 0, warn: 1, info: 2, debug: 3 }

interface Logger {
  warn: (message: string) => void
  info: (message: string) => void
  debug: (message: string) => void
}

const makeLogger = (ctx: Context, level: Level): Logger => {
  const emit = (at: Level, method: 'warn' | 'info' | 'debug', message: string): void => {
    if (ORDER[level] < ORDER[at]) return
    const sink = (ctx as unknown as { logger?: Record<string, (m: string) => void> }).logger
    const fn = sink?.[method]
    if (typeof fn === 'function') fn.call(sink, message)
    else if (method === 'warn') console.warn(message)
    else console.log(message)
  }
  return {
    warn: (message) => emit('warn', 'warn', message),
    info: (message) => emit('info', 'info', message),
    debug: (message) => emit('debug', 'debug', message),
  }
}

/** Everything the plugin builds, returned so a test can assert on it. */
export interface JevPluginRuntime {
  readonly service: JevService
  readonly egress: EgressContract
  readonly provider: JevProvider
  readonly config: ReturnType<typeof resolveConfig>
}

/** The minimal slice of the DSH credentials service this plugin uses. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>
}

const readCredentials = (ctx: Context): CredentialsLike | undefined => {
  const service = (ctx as unknown as { credentials?: CredentialsLike }).credentials
  return typeof service?.resolve === 'function' ? service : undefined
}

/**
 * Order recorded calls by the time each one was sent.
 *
 * `JevService.history` is appended in `record()`, which runs when a call
 * *finishes*, not when it starts. Two concurrent judgments therefore land in
 * completion order, and `recent()` handed that order straight to callers: a call
 * that started first is reported after one that started later. With the three
 * tools now opted into the host's parallel pool (each declares
 * `isConcurrencySafe`), that ordering is reachable in ordinary use rather than
 * theoretical.
 *
 * Where the fix belongs: a monotonic `seq` stamped in `record()` and sorted
 * before the history is truncated. `JevCallRecord` has no such field and
 * `JevService.record` lives in the core, which this package does not own, so
 * `at` - the send time, stamped before the provider call - is the only ordering
 * key available at this call site. Sorting by it restores send order; calls that
 * share a millisecond keep the order they were recorded in, because
 * `Array.prototype.sort` is stable. Truncation still happens inside the core,
 * *before* anything here can reorder it, so with more concurrent calls than
 * `historyLimit` **which** records survive remains scheduling-dependent. That is
 * the part this package cannot fix, and it is recorded as an upstream item.
 *
 * The copy is not a nicety: `recent()` returns the service's own array, so
 * sorting it in place would rewrite the service's history.
 */
export const orderRecent = (records: readonly JevCallRecord[]): JevCallRecord[] =>
  [...records].sort((left, right) => left.at - right.at)

/**
 * Build the runtime without registering it.
 *
 * Exported so the wiring can be tested against a fake context, and so an
 * embedding host can reuse the composition.
 */
export const buildRuntime = (
  ctx: Context,
  input: JevConfigInput | undefined,
  logger: Logger,
): JevPluginRuntime => {
  const config = resolveConfig(input)

  const credentials = readCredentials(ctx)
  const egress = new EgressContract(
    {
      // Any provider other than the mock can reach the network. `openrouter`
      // routes to OpenRouter rather than TypeSafe, which the report's endpoint
      // line names — the destination is not implied by the provider's name.
      transmitting: config.provider !== 'mock',
      enabled: {
        'tool:jev_ask': true,
        'tool:jev_rank': true,
        'tool:jev_check': true,
        // Gates are opt-in. Everything else is reachable only when the model
        // calls the tool; a gate would run on every matching call, so it needs
        // an explicit decision.
        'gate:safety': config.gates.safety.enabled,
        'gate:context': config.gates.context.enabled,
      },
    },
    config.baseURL ?? DEFAULT_ENDPOINT,
    // The operator's state cap, if one was set. Without forwarding it the
    // configured value would be parsed, typed, documented and then ignored.
    config.maxStateChars,
  )

  // The live providers are constructed with an empty key because the credential
  // may not exist yet, or may change while the process runs. Each call resolves
  // it and refuses rather than sending an unauthenticated request.
  const needsCredential = config.provider === 'live' || config.provider === 'openrouter'

  /**
   * Build the provider for the configured route.
   *
   * One function rather than two inline literals: the startup path and the
   * per-call rebuild had drifted apart, and only one of them carried the
   * transport settings. The TypeSafe route gets them because the SDK otherwise
   * reads `TYPESAFE_LOG_LEVEL` from the environment, and its `debug` level logs
   * request bodies with credential headers redacted but **bodies not** — which
   * would write exactly the state this package redacts before sending. The
   * OpenRouter SDK reads no such variable, so it needs none of it.
   */
  const buildProvider = (apiKey: string): JevProvider =>
    config.provider === 'openrouter'
      ? new OpenRouterProvider({
          apiKey,
          ...(config.openRouterBaseURL === undefined ? {} : { baseURL: config.openRouterBaseURL }),
          model: config.model,
        })
      : new LiveProvider({
          apiKey,
          ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
          model: config.model,
          logLevel: config.logLevel === 'silent' ? 'off' : config.logLevel,
          timeout: config.requestTimeoutMs,
          retry: { maxRetries: config.requestMaxRetries },
        })

  const provider: JevProvider = needsCredential ? buildProvider('') : new MockProvider()

  const keyedProvider: JevProvider = !needsCredential
    ? provider
    : {
        id: provider.id,
        async answer(request, signal) {
          const isOpenRouter = config.provider === 'openrouter'
          const ref = isOpenRouter ? config.openRouterApiKeyRef : config.apiKeyRef
          const resolved = await resolveApiKey({ ref, credentials })
          if (resolved === undefined) {
            throw new JevProviderError(
              `no credential found for "${ref}". Store it in the DSH credential service or set ` +
                `the environment variable, or switch provider back to "mock".`,
              'no-credential',
            )
          }
          // Rebuilt per call so a rotated key is picked up without a restart.
          return buildProvider(resolved.value).answer(request, signal)
        },
      }

  const service = new JevService({
    provider: keyedProvider,
    egress,
    // A fact about the provider, so a status surface cannot imply the mock is
    // reaching the network when it is not.
    transmitting: needsCredential,
    model: config.model,
  })

  for (const line of egress.reportLines()) logger.info(line)

  return { service, egress, provider: keyedProvider, config }
}

/** Cordis plugin entry: register the service, the tools, and any enabled gates. */
export function apply(ctx: Context, input?: JevConfigInput): void {
  const config = resolveConfig(input)
  const logger = makeLogger(ctx, config.logLevel)
  const runtime = buildRuntime(ctx, input, logger)

  // The service. Published under `jev` so any plugin or Host code can
  // `ctx.get('jev')` and ask without involving the model.
  ctx.effect(() =>
    ctx.provide('jev', {
      ask: runtime.service.ask.bind(runtime.service),
      stats: () => runtime.service.stats(),
      // Ordered, and a fresh array: see `orderRecent` for why both matter.
      recent: () => orderRecent(runtime.service.recent()),
      providerId: runtime.service.providerId,
      transmitting: runtime.service.transmitting,
      egress: runtime.egress,
    }),
  )

  // The three model-visible tools.
  const tools = (ctx as unknown as { tools: { register(definition: unknown): () => void } }).tools
  for (const definition of [
    jevAskTool(runtime.service),
    jevRankTool(runtime.service),
    jevCheckTool(runtime.service),
  ]) {
    ctx.effect(() => tools.register(definition))
  }

  // The bundled skill.
  //
  // Registered through the registry rather than shipped as a directory for a
  // skill provider to discover: one registration, no dependency on where a
  // profile keeps its skills, and it disappears cleanly with the plugin.
  //
  // A load failure is reported and skipped rather than thrown. The skill teaches
  // an agent how to use the tools; losing it degrades the guidance but must not
  // take the tools down with it. Failing loudly here would mean a packaging
  // mistake disables the whole plugin.
  const skills = ctx.get('skills') as
    | { register: (registration: unknown) => () => void }
    | undefined
  if (skills === undefined) {
    logger.warn(
      '[jevcore] the skills registry is not available; the bundled skill will not be offered',
    )
  } else {
    try {
      const registration = skillRegistration()
      ctx.effect(() => skills.register(registration))
    } catch (error) {
      logger.warn(
        `[jevcore] could not load the bundled skill: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // Gate: judge tool calls before dispatch. Off by default.
  if (config.gates.safety.enabled) {
    const gate = createSafetyGate({
      service: runtime.service,
      onUndecided: config.gates.safety.onUndecided,
      minConfidence: config.minConfidence,
      minProbability: config.minProbability,
      describeContext: () => {
        const cwd = (ctx as unknown as { cwd?: string }).cwd
        return cwd === undefined ? undefined : `workspace: ${cwd}`
      },
    })
    const events = (ctx as unknown as {
      on(event: string, listener: (...args: never[]) => unknown): () => void
    }).on
    ctx.effect(() =>
      events.call(ctx, 'tools/pre-execute', async (exec: unknown, next: unknown) => {
        const call = exec as { name?: string; arguments?: unknown; signal?: AbortSignal }
        const decision = await gate({
          name: call.name ?? '',
          args: call.arguments,
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        })
        if (decision.kind === 'allow') return (next as () => Promise<unknown>)()
        if (decision.kind === 'deny') {
          return { kind: 'deny', reason: decision.reason ?? 'denied by the jevcore safety gate' }
        }
        return { kind: 'ask', ...(decision.reason === undefined ? {} : { reason: decision.reason }) }
      }),
    )
  }

  // Gate: withhold a large, uninformative tool result. Off by default.
  if (config.gates.context.enabled) {
    const gate = createContextGate({
      service: runtime.service,
      minConfidence: config.minConfidence,
    })
    const events = (ctx as unknown as {
      on(event: string, listener: (...args: never[]) => unknown): () => void
    }).on
    ctx.effect(() =>
      events.call(ctx, 'tools/post-execute', async (exec: unknown, result: unknown, next: unknown) => {
        const call = exec as { name?: string; signal?: AbortSignal }
        const outcome = result as { content?: readonly { type?: string; text?: string }[] }
        const decision = await gate({
          toolName: call.name ?? '',
          content: outcome.content,
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        })
        if (!decision.block) return (next as () => Promise<unknown>)()
        return {
          kind: 'block',
          feedback: [{ type: 'text', text: decision.feedback ?? 'result withheld by jevcore' }],
        }
      }),
    )
  }

  logger.info(
    `[jevcore] ready · provider=${config.provider} · gates: safety=${
      config.gates.safety.enabled ? 'on' : 'off'
    } context=${config.gates.context.enabled ? 'on' : 'off'}`,
  )
}

/**
 * The core is re-exported so a consumer of the plugin can reach the primitives,
 * the service, and the egress contract without adding a second dependency.
 * Everything importable here is also importable from `jevcore` directly.
 */
export {
  EGRESS_FEATURES,
  EGRESS_FIELDS,
  EgressContract,
  EgressDeniedError,
  JevProviderError,
  JevService,
  LiveProvider,
  MockProvider,
  OpenRouterProvider,
  choice,
  noul,
  resolveConfig,
  score,
} from 'jevcore'
export type {
  EgressFeature,
  JevAnswer,
  JevConfig,
  JevConfigInput,
  JevProvider,
  JevQuestion,
  JevResult,
  JsonValue,
} from 'jevcore'
