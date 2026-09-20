/**
 * Choosing a provider, and building the one service every command talks to.
 *
 * This module is where the egress contract becomes real. Three properties hold
 * here, and each of them is the reason a line below exists:
 *
 *  1. **`mock` is the default and the only provider that needs no arithmetic to
 *     justify.** The core's own posture is that out of the box nothing resolves a
 *     credential and no socket opens. A CLI whose default was "transmit if a key
 *     happens to be in the environment" would invert that, so transmission is
 *     opt-in through `--provider live`, `--provider openrouter`, or the
 *     `JEV_PROVIDER` variable — never inferred from the presence of a credential.
 *  2. **The credential is resolved, never read.** `resolveApiKey` and
 *     `describeKeySource` from the core do the reading; this module receives a
 *     value, hands it to a provider constructor, and reports only *which source*
 *     it came from. Nothing here prints, logs, echoes or interpolates the key,
 *     and a test asserts that by putting a key in the environment and grepping
 *     the entire output for it.
 *  3. **A feature that was not declared cannot be sent under.** `--feature`
 *     selects from `EGRESS_FEATURES`, and anything else is a hard error listing
 *     what is declared. The contract is the authority; this module is not
 *     allowed to widen it.
 */

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  EGRESS_FEATURES,
  EgressContract,
  JevProviderError,
  JevService,
  LiveProvider,
  MockProvider,
  MOCK_MODEL,
  OpenRouterProvider,
  describeKeySource,
  loadOfficialSdk,
  resolveApiKey,
  type EgressFeature,
  type JevProvider,
  type KeySource,
  type ProviderKind,
} from 'jevcore'
import { hasFlag, optionalString } from './args.js'
import type { CliEnv, ParsedArgs } from './types.js'
import { PROGRAM, UsageError } from './usage.js'

/**
 * The SDK module shape the live routes load, inferred from the core's own loader.
 *
 * `SdkModule` is declared in `packages/core/src/provider/live.ts` but is not part
 * of the core's public export list, and this is the one place the CLI needs it —
 * to type the test seam below. Inferring it from `loadOfficialSdk`'s return type
 * keeps the CLI on the core's public surface rather than reaching into a module
 * path, and keeps the two in step automatically if the shape changes.
 */
type SdkModule = Awaited<ReturnType<typeof loadOfficialSdk>>

/** The credential reference each transmitting route reads. */
const KEY_REFS: Readonly<Record<'live' | 'openrouter', string>> = {
  live: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/** The model-id environment variable each transmitting route honours. */
const MODEL_REFS: Readonly<Record<'live' | 'openrouter', string>> = {
  live: 'TYPESAFE_MODEL',
  openrouter: 'OPENROUTER_MODEL',
}

/** The endpoint environment variable each transmitting route honours. */
const ENDPOINT_REFS: Readonly<Record<'live' | 'openrouter', string>> = {
  live: 'TYPESAFE_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
}

/**
 * Where each route posts, when nothing overrides it.
 *
 * Read from the core rather than restated: the egress report names the host that
 * content would go to, and a report that disagreed with the request would be the
 * defect the report exists to prevent. The OpenRouter root carries `/api` because
 * the SDK appends `/v1/systemone` to it.
 */
export const DEFAULT_ENDPOINTS: Readonly<Record<ProviderKind, string | undefined>> = {
  mock: undefined,
  live: DEFAULT_ENDPOINT,
  openrouter: DEFAULT_OPENROUTER_ENDPOINT,
}

/**
 * The environment variable that substitutes a stub SDK, for tests only.
 *
 * The live route's only real work is a call into `@typesafe-ai/sdk`, and the core
 * already accepts an injected loader for exactly this reason. The CLI is a
 * process, so the injection point has to be named somewhere outside it, and an
 * environment variable is the smallest such seam.
 *
 * It is **not** a general plugin mechanism, and the loader refuses anything that
 * does not look like a local path: a value such as `some-package` is rejected
 * rather than resolved from `node_modules`. A CLI that could be pointed at an
 * arbitrary module by an environment variable would be a worse tool than one that
 * could not, whatever the convenience.
 */
export const SDK_OVERRIDE_ENV = 'JEV_CLI_SDK'

/**
 * The environment variable that removes the whole-call budget, for tests only.
 *
 * A provider call is bounded by a 40s total budget, which is the right number for
 * a person and the wrong one for a unit test that has just made its stub throw.
 * Setting this to `0` removes the ceiling entirely, matching the core's own test
 * seam (`totalBudgetMs: 0`). It does not disable the call, only its deadline.
 */
export const BUDGET_OVERRIDE_ENV = 'JEV_CLI_TOTAL_BUDGET_MS'

/** The stub loader, when {@link SDK_OVERRIDE_ENV} names a local module. */
export const loadStubSdk = (specifier: string): (() => Promise<SdkModule>) => {
  const looksLocal =
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(specifier) ||
    specifier.startsWith('file:')
  if (!looksLocal) {
    throw new JevProviderError(
      `${SDK_OVERRIDE_ENV} must name a local module (a path starting with "./", "../", "/", or ` +
        `a drive letter); got "${specifier}". It exists so a test can substitute a stub SDK, not ` +
        'so a package can be loaded from the environment.',
      'provider-unavailable',
    )
  }
  return () => loadOfficialSdk(specifier)
}

/**
 * Which provider an invocation selected, and the transport settings for it.
 *
 * This is resolved without touching a credential, and that split is deliberate.
 * `egress` and `models` have to describe a route — where it would post, whether it
 * transmits, which variable holds its key — and none of those questions needs the
 * key's value. Requiring one would make those two commands fail on exactly the
 * machine where the question matters most: the one that has not been configured
 * yet. Only {@link buildRoute} resolves a credential, and only a command that is
 * about to call a provider uses it.
 */
export interface RoutePlan {
  readonly kind: ProviderKind
  /** True for every kind but `mock`. A fact about the provider, not a permission. */
  readonly transmitting: boolean
  readonly model: string
  /** The endpoint content would go to, or `undefined` for the offline mock. */
  readonly endpoint: string | undefined
  /** Which credential reference this route reads. */
  readonly apiKeyRef: string
}

/** A route that has been built, with its credential resolved and provider ready. */
export interface Route extends RoutePlan {
  readonly provider: JevProvider
  /**
   * Where the credential came from, or `'none'`.
   *
   * A source, never a value. Reported so an operator can answer "is this CLI
   * about to use a key at all, and did it come from the environment or from a
   * credential service" without the answer containing the key.
   */
  readonly keySource: KeySource | 'none'
}

/** A route and the payload contract that bounds it. */
export interface ServiceContext {
  readonly route: Route
  readonly egress: EgressContract
  readonly service: JevService
}

/**
 * Which provider this invocation should use.
 *
 * Precedence is flag, then environment, then the offline default. The
 * environment step is what lets a CI job set one variable instead of editing
 * every command line, and it is deliberately the *only* thing besides a flag:
 * the presence of a credential is not consulted, so a shell that happens to have
 * `TYPESAFE_API_KEY` exported does not silently start transmitting.
 *
 * An unrecognised `JEV_PROVIDER` is a usage error rather than a fallback. A
 * variable that says `Live` or `type-safe` and is quietly ignored would mean the
 * operator believes they configured something they did not.
 */
export const chooseProvider = (args: ParsedArgs, env: CliEnv['env']): ProviderKind => {
  if (hasFlag(args, 'mock')) return 'mock'
  const flag = optionalString(args, 'provider')?.trim().toLowerCase()
  if (flag !== undefined) {
    if (flag === 'mock' || flag === 'live' || flag === 'openrouter') return flag
    throw new UsageError(
      `--provider must be mock, live or openrouter, got "${flag}". ` +
        '"mock" is offline and returns synthetic answers; the other two transmit.',
    )
  }
  const configured = env.JEV_PROVIDER?.trim().toLowerCase()
  if (configured === undefined || configured.length === 0) return 'mock'
  if (configured === 'mock' || configured === 'live' || configured === 'openrouter') {
    return configured
  }
  throw new UsageError(
    `JEV_PROVIDER is "${configured}", which is not a provider. Set it to mock, live or ` +
      'openrouter, or unset it to use the offline mock.',
  )
}

/**
 * The model this invocation would name.
 *
 * One flag, then the route's own variable, then the provider's own default. The
 * two transmitting routes share a default on purpose — a bare `jev-*` id works on
 * both — so the only reason to read a per-route variable is that an operator may
 * want a different model on each without rewriting their command lines.
 *
 * The mock's default is its own synthetic id, not the shared one. Reporting
 * `jev-latest` for a run that will answer from a hash would name a model that is
 * never called, and this value is what `models` prints and what the provenance
 * line shows — two places an operator reads to find out what answered.
 */
export const resolveModel = (
  kind: ProviderKind,
  args: ParsedArgs,
  env: CliEnv['env'],
): string => {
  const flag = optionalString(args, 'model')?.trim()
  if (flag !== undefined && flag.length > 0) return flag
  if (kind === 'mock') return MOCK_MODEL
  const fromEnv = env[MODEL_REFS[kind]]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return kind === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL
}

/** The endpoint this invocation would post to, or `undefined` for the mock. */
export const resolveEndpoint = (
  kind: ProviderKind,
  args: ParsedArgs,
  env: CliEnv['env'],
): string | undefined => {
  if (kind === 'mock') return undefined
  const flag = optionalString(args, 'endpoint')?.trim()
  if (flag !== undefined && flag.length > 0) return flag
  const fromEnv = env[ENDPOINT_REFS[kind]]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return DEFAULT_ENDPOINTS[kind]
}

/**
 * The total budget for one provider call, or `undefined` for the core's default.
 *
 * Only the test override is read here; everything else leaves the core's own
 * ceiling in place. See {@link BUDGET_OVERRIDE_ENV}.
 */
const totalBudgetFor = (env: CliEnv['env']): number | undefined => {
  const raw = env[BUDGET_OVERRIDE_ENV]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Build one transmitting provider, resolving its credential first.
 *
 * A credential that cannot be found is a startup failure rather than a per-call
 * surprise, and the failure names the variable to set. It deliberately does not
 * fall back to the mock: a caller who asked for live answers and silently
 * received synthetic ones would be the exact confusion this project spends its
 * time removing, and the fallback would be invisible in a CI log.
 */
const transmittingProvider = async (
  kind: 'live' | 'openrouter',
  options: {
    readonly model: string
    readonly endpoint: string | undefined
    readonly env: CliEnv['env']
    readonly budgetMs: number | undefined
  },
): Promise<{ provider: JevProvider; keySource: KeySource | 'none'; apiKeyRef: string }> => {
  const apiKeyRef = KEY_REFS[kind]
  // `env` is passed explicitly, so a test's environment object is what is read
  // and never the ambient process's.
  const lookup = (name: string): string | undefined => options.env[name]
  const resolved = await resolveApiKey({ ref: apiKeyRef, env: lookup })
  if (resolved === undefined) {
    throw new JevProviderError(
      `provider "${kind}" was selected but no credential was found for ${apiKeyRef}. Set the ` +
        `environment variable, pass --mock, or leave the provider unset to run offline.`,
      'no-credential',
    )
  }
  // Reported from the same resolution rather than by a second call, so the two
  // cannot disagree about where the key came from.
  const keySource = await describeKeySource({ ref: apiKeyRef, env: lookup })

  const override = options.env[SDK_OVERRIDE_ENV]?.trim()
  const loadSdk =
    override === undefined || override.length === 0 ? undefined : loadStubSdk(override)

  const provider: JevProvider =
    kind === 'openrouter'
      ? new OpenRouterProvider({
          apiKey: resolved.value,
          model: options.model,
          // Absent rather than `undefined`: `exactOptionalPropertyTypes` keeps the
          // two apart, and absent is what "use the core's default" means.
          ...(options.endpoint === undefined ? {} : { baseURL: options.endpoint }),
          ...(loadSdk === undefined ? {} : { loadSdk }),
          ...(options.budgetMs === undefined ? {} : { totalBudgetMs: options.budgetMs }),
        })
      : new LiveProvider({
          apiKey: resolved.value,
          model: options.model,
          ...(options.endpoint === undefined ? {} : { baseURL: options.endpoint }),
          ...(loadSdk === undefined ? {} : { loadSdk }),
          ...(options.budgetMs === undefined ? {} : { totalBudgetMs: options.budgetMs }),
        })

  return { provider, keySource, apiKeyRef }
}

/**
 * Resolve a route: which provider, which model, which endpoint, which key
 * reference. Reads the flags and the environment; resolves no credential.
 */
export const resolveRoute = (args: ParsedArgs, io: CliEnv): RoutePlan => {
  const kind = chooseProvider(args, io.env)
  const model = resolveModel(kind, args, io.env)
  const endpoint = resolveEndpoint(kind, args, io.env)
  return {
    kind,
    transmitting: kind !== 'mock',
    model,
    endpoint: kind === 'mock' ? undefined : (endpoint ?? DEFAULT_ENDPOINTS[kind]),
    apiKeyRef: KEY_REFS.live,
  }
}

/**
 * Resolve a route and build its provider.
 *
 * The credential is resolved *once*, here, and reported only as a source. A
 * transmitting route with no credential throws: a caller who asked for live
 * answers and silently received synthetic ones would be the exact confusion this
 * project spends its time removing, and the substitution would be invisible in a
 * CI log.
 */
export const buildRoute = async (args: ParsedArgs, io: CliEnv): Promise<Route> => {
  const plan = resolveRoute(args, io)

  if (plan.kind === 'mock') {
    return { ...plan, provider: new MockProvider(), apiKeyRef: KEY_REFS.live, keySource: 'none' }
  }

  const built = await transmittingProvider(plan.kind, {
    model: plan.model,
    endpoint: plan.endpoint,
    env: io.env,
    budgetMs: totalBudgetFor(io.env),
  })
  return { ...plan, provider: built.provider, apiKeyRef: built.apiKeyRef, keySource: built.keySource }
}

/**
 * A feature name from the command line, checked against the declaration.
 *
 * The contract owns the list; this function only reads it. A name that is not on
 * it is a usage error rather than something to forward, because forwarding it
 * would ask the contract to decide about a feature it has never heard of — and
 * the one thing the contract must never do is invent a permission.
 */
export const asFeature = (name: string): EgressFeature => {
  const declared: readonly string[] = EGRESS_FEATURES
  if (!declared.includes(name)) {
    throw new UsageError(
      `"${name}" is not a declared egress feature. Declared features: ` +
        `${EGRESS_FEATURES.join(', ')}. A feature this tool does not declare cannot be sent ` +
        'under, because the egress contract is what decides what may leave the machine.',
    )
  }
  return name as EgressFeature
}

/**
 * Turn a list of feature names into the enabled map the contract takes.
 *
 * An empty request means "arm everything declared", which is what `egress` with
 * no `--feature` asks for. Every other case is exact: a name that is not declared
 * is refused by {@link asFeature} with the list of names that are.
 */
export const enabledFeatures = (requested: readonly string[]): Record<EgressFeature, boolean> => {
  const enabled = {} as Record<EgressFeature, boolean>
  for (const feature of EGRESS_FEATURES) enabled[feature] = requested.length === 0
  for (const feature of requested) enabled[asFeature(feature)] = true
  return enabled
}

/**
 * The contract for one invocation, with exactly the features it will use enabled.
 *
 * `transmitting` is a fact about the provider and is passed through honestly: the
 * mock reports `false` even when features are armed, so its report says the
 * features are armed against an offline provider rather than claiming a
 * transmission that cannot happen.
 */
export const egressFor = (route: RoutePlan, features: readonly string[]): EgressContract =>
  new EgressContract(
    { transmitting: route.transmitting, enabled: enabledFeatures(features) },
    route.endpoint ?? 'none',
    // No CLI-side cap override yet, so each feature's declared cap applies
    // unchanged. Passing `undefined` is what says so.
    undefined,
  )

/**
 * Which features a request arms, as a map, read back through the contract.
 *
 * `egress` prints a row per declared feature and needs to know which ones are on.
 * `EgressContract` exposes `allows(feature)` rather than its settings object, so
 * this asks it the same question every caller asks: the settings stay private,
 * and the report cannot become a second interpretation of them.
 */
export const armedFeatures = (
  egress: EgressContract,
): Readonly<Record<EgressFeature, boolean>> => {
  const armed = {} as Record<EgressFeature, boolean>
  for (const feature of EGRESS_FEATURES) armed[feature] = egress.allows(feature)
  return armed
}

/** Build the service one command will use, under the features it names. */
export const buildContext = async (
  args: ParsedArgs,
  io: CliEnv,
  features: readonly string[],
): Promise<ServiceContext> => {
  const route = await buildRoute(args, io)
  const egress = egressFor(route, features)
  const service = new JevService({
    provider: route.provider,
    egress,
    transmitting: route.transmitting,
    model: route.model,
  })
  return { route, egress, service }
}

/**
 * The one-line description of where answers will come from.
 *
 * Printed on stderr by every command that answers, including the offline ones.
 * A synthetic answer that arrived without a word about it being synthetic is the
 * failure the mock provider's own warning exists to prevent, and a CLI is where
 * it would be easiest to reintroduce: the operator sees a probability and no
 * provenance.
 */
export const provenanceLine = (route: Route): string => {
  if (!route.transmitting) {
    return (
      `${PROGRAM}: provider=mock — OFFLINE, no network call will be made, and every answer below ` +
      'is SYNTHETIC (derived from a hash of the input). Use --provider live for real answers.'
    )
  }
  return (
    `${PROGRAM}: provider=${route.kind} — TRANSMITTING to ${route.endpoint ?? 'an unknown endpoint'}` +
    `, model=${route.model}, credential from ${route.keySource === 'none' ? 'nowhere' : route.keySource}.`
  )
}
