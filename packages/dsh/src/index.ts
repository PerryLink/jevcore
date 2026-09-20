/**
 * dsh-jev —TypeSafe Jev for DeepSeek Harness.
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
  DEFAULT_ENDPOINT,
  EgressContract,
  JevProviderError,
  JevService,
  LiveProvider,
  MockProvider,
  createContextGate,
  createSafetyGate,
  resolveApiKey,
  resolveConfig,
  type JevConfigInput,
  type JevProvider,
} from '@dsh-jev/core'
import { jevAskTool } from './ask.js'
import { jevCheckTool } from './check.js'
import { jevRankTool } from './rank.js'
import { skillRegistration } from './skill.js'

/** Plugin name, also the service key this plugin publishes. */
export const name = 'dsh-jev'

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
export { Config } from '@dsh-jev/core'

/**
 * A description of the config shape, for documentation and the patch file.
 *
 * Kept under a different name from `Config`, which must remain the Standard
 * Schema above.
 */
export const CONFIG_DOC = {
  provider: 'mock',
  apiKeyRef: 'TYPESAFE_API_KEY',
  model: 'jev-latest',
  logLevel: 'warn',
  minConfidence: 0.7,
  minProbability: 0.6,
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
      transmitting: config.provider === 'live',
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
  )

  const provider: JevProvider =
    config.provider === 'live'
      ? new LiveProvider({
          // Resolved lazily per call by the Proxy below; the constructor needs
          // a value, and an empty one surfaces the missing-key error at the
          // first call rather than at load.
          apiKey: '',
          ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
          model: config.model,
        })
      : new MockProvider()

  // The live provider is constructed with an empty key because the credential
  // may not exist yet, or may change while the process runs. Resolve per call,
  // and refuse rather than sending an unauthenticated request.
  const keyedProvider: JevProvider =
    config.provider === 'live'
      ? {
          id: provider.id,
          async answer(request, signal) {
            const resolved = await resolveApiKey({
              ref: config.apiKeyRef,
              credentials,
            })
            if (resolved === undefined) {
              throw new JevProviderError(
                `no credential found for "${config.apiKeyRef}". Store it in the DSH credential ` +
                  `service or set the environment variable, or switch provider back to "mock".`,
                'no-credential',
              )
            }
            const live = new LiveProvider({
              apiKey: resolved.value,
              ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
              model: config.model,
            })
            return live.answer(request, signal)
          },
        }
      : provider

  const service = new JevService({
    provider: keyedProvider,
    egress,
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
      recent: () => runtime.service.recent(),
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
      '[dsh-jev] the skills registry is not available; the bundled skill will not be offered',
    )
  } else {
    try {
      const registration = skillRegistration()
      ctx.effect(() => skills.register(registration))
    } catch (error) {
      logger.warn(
        `[dsh-jev] could not load the bundled skill: ${error instanceof Error ? error.message : String(error)}`,
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
          return { kind: 'deny', reason: decision.reason ?? 'denied by the dsh-jev safety gate' }
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
          feedback: [{ type: 'text', text: decision.feedback ?? 'result withheld by dsh-jev' }],
        }
      }),
    )
  }

  logger.info(
    `[dsh-jev] ready · provider=${config.provider} · gates: safety=${
      config.gates.safety.enabled ? 'on' : 'off'
    } context=${config.gates.context.enabled ? 'on' : 'off'}`,
  )
}

/**
 * The core is re-exported so a consumer of the plugin can reach the primitives,
 * the service, and the egress contract without adding a second dependency.
 * Everything importable here is also importable from `@dsh-jev/core` directly.
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
  choice,
  noul,
  resolveConfig,
  score,
} from '@dsh-jev/core'
export type {
  EgressFeature,
  JevAnswer,
  JevConfig,
  JevConfigInput,
  JevProvider,
  JevQuestion,
  JevResult,
  JsonValue,
} from '@dsh-jev/core'
