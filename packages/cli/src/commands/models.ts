/**
 * `jev models` — which models and endpoints this tool would use, and what the
 * account can actually call.
 *
 * Two different questions, answered separately because they cost different
 * things:
 *
 *  - **The local resolution** answers "what would this invocation send, and is
 *    there a credential for it" from the environment alone. No network call, no
 *    key needed, and it runs on a machine that has never seen TypeSafe.
 *  - **The catalogue** answers "what can this account name in a `model` field"
 *    and costs one authenticated request. It is therefore opt-in through
 *    `--catalogue`: a command whose ordinary run opened a socket would be a
 *    command that transmits, and this project's rule is that transmission is
 *    something an operator chose.
 *
 * The catalogue is reached through `jevcore`'s own `listModels`, never through a
 * reimplementation of the vendor call. That module is newer than this one and may
 * not be exported by the installed core yet, so the call is resolved at run time
 * and its absence is *reported* — with the reason and the remedy — instead of
 * being either a crash or a silently short list. A consumer branching on
 * `catalogue.available` starts working the moment the core exports it.
 */

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  MOCK_MODEL,
  resolveApiKey,
  type JevProviderError,
  type ProviderKind,
} from 'jevcore'
import { hasFlag } from './../args.js'
import { toJson } from './../format.js'
import {
  BUDGET_OVERRIDE_ENV,
  SDK_OVERRIDE_ENV,
  chooseProvider,
  loadStubSdk,
  resolveEndpoint,
  resolveModel,
} from './../runtime.js'
import { EXIT, type CliEnv, type CommandContext } from './../types.js'
import { PROGRAM, UsageError } from './../usage.js'

/** One route, as the local resolution reports it. */
interface ModelRoute {
  readonly provider: ProviderKind
  /** The model this route would send. */
  readonly model: string
  /** `null` for the offline mock, which posts nowhere. */
  readonly endpoint: string | null
  /** The environment variable this route reads, or `null` when it reads none. */
  readonly keyRef: string | null
  /** Whether a credential for that reference exists, without revealing it. */
  readonly keyPresent: boolean
  /** Whether this route is the one the current flags select. */
  readonly selected: boolean
}

/** The credential reference each transmitting route reads. */
const KEY_REF: Readonly<Record<'live' | 'openrouter', string>> = {
  live: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/** One catalogue entry, as this command reports it. */
interface CatalogModel {
  readonly name: string
  readonly description?: string
  readonly releaseDate?: string
}

/**
 * What the catalogue half of the report can say.
 *
 * A closed shape with a reason for each closed door, so a consumer never has to
 * infer "no models" from an empty array — an unavailable catalogue and an empty
 * one are different facts, and the core's own `listModels` refuses to conflate
 * them for the same reason.
 */
type CatalogueReport =
  | { readonly available: true; readonly source: string; readonly models: readonly CatalogModel[] }
  | { readonly available: false; readonly reason: string }

/** Whether a credential exists for a reference. Never returns the value. */
const keyPresent = async (ref: string | null, env: CliEnv['env']): Promise<boolean> => {
  if (ref === null) return false
  const resolved = await resolveApiKey({ ref, env: (name) => env[name] })
  return resolved !== undefined
}

/**
 * The core's `listModels`, when the installed core exports it.
 *
 * Resolved by dynamic import rather than a named import so that a core without
 * the export is a *runtime* report instead of a compile error in this package:
 * the two are developed against each other, and a CLI that refuses to build
 * because the core is one release behind is a CLI nobody can ship.
 *
 * The shape is checked rather than assumed. `typeof === 'function'` is the whole
 * test, because the alternative is a duck-typed guess at a function signature —
 * and a wrong guess here would send a request with no key rather than fail.
 */
const loadListModels = async (): Promise<
  | ((options: {
      readonly apiKey: string
      readonly baseURL?: string
      readonly totalBudgetMs?: number
      readonly loadSdk?: () => Promise<unknown>
    }) => Promise<readonly CatalogModel[]>)
  | undefined
> => {
  const core = (await import('jevcore')) as unknown as Record<string, unknown>
  const candidate = core.listModels
  if (typeof candidate !== 'function') return undefined
  return candidate as never
}

/**
 * Fetch the catalogue, or say why it could not be fetched.
 *
 * Every failure is reported rather than thrown: this is the second half of a
 * report whose first half already succeeded, and losing the local resolution
 * because the network is down would be the wrong trade. The one thing that is
 * *not* swallowed is a missing credential, which is returned as a reason — the
 * caller asked for a catalogue from a route that has no key, and that is an
 * answer about their configuration, not an error in this command.
 */
const fetchCatalogue = async (
  kind: ProviderKind,
  route: { readonly endpoint: string | null },
  io: CliEnv,
): Promise<CatalogueReport> => {
  const listModels = await loadListModels()
  if (listModels === undefined) {
    return {
      available: false,
      reason:
        'the installed jevcore does not export its model catalogue, so this build of the CLI ' +
        'cannot reach GET /v1/models. Upgrade jevcore to a version that exports `listModels`.',
    }
  }

  const ref = KEY_REF[kind as 'live' | 'openrouter']
  const resolved = await resolveApiKey({ ref, env: (name) => io.env[name] })
  if (resolved === undefined) {
    return {
      available: false,
      reason: `provider "${kind}" has no credential for ${ref}, and GET /v1/models is an authenticated call.`,
    }
  }

  const budgetRaw = io.env[BUDGET_OVERRIDE_ENV]?.trim()
  const budget = budgetRaw === undefined || budgetRaw.length === 0 ? undefined : Number(budgetRaw)
  const override = io.env[SDK_OVERRIDE_ENV]?.trim()

  try {
    const models = await listModels({
      apiKey: resolved.value,
      ...(route.endpoint === null ? {} : { baseURL: route.endpoint }),
      ...(budget === undefined || !Number.isFinite(budget) ? {} : { totalBudgetMs: budget }),
      ...(override === undefined || override.length === 0
        ? {}
        : { loadSdk: loadStubSdk(override) }),
    })
    return { available: true, source: route.endpoint ?? DEFAULT_ENDPOINT, models }
  } catch (error) {
    const code = (error as Partial<JevProviderError>).code
    return {
      available: false,
      reason:
        `the catalogue request failed${code === undefined ? '' : ` (${code})`}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Run `models`. */
export const runModels = async ({ args, io }: CommandContext): Promise<number> => {
  const selected = chooseProvider(args, io.env)
  const configuredModel = resolveModel(selected, args, io.env)
  const configuredEndpoint = resolveEndpoint(selected, args, io.env)
  const wanted = hasFlag(args, 'catalogue')

  if (wanted && selected === 'mock') {
    throw new UsageError(
      '--catalogue lists the models an account can call, and the offline mock has no account. ' +
        'Pass --provider live or --provider openrouter to ask the API, or drop --catalogue for ' +
        'the local resolution alone.',
    )
  }

  const routes: ModelRoute[] = []
  for (const provider of ['mock', 'live', 'openrouter'] as const) {
    const ref = provider === 'mock' ? null : KEY_REF[provider]
    // The selected route reports what the flags and environment actually
    // resolved; the others report the model they would use if selected, which is
    // the question "what would change if I switched".
    const model =
      provider === selected
        ? configuredModel
        : provider === 'mock'
          ? MOCK_MODEL
          : provider === 'live'
            ? DEFAULT_MODEL
            : DEFAULT_OPENROUTER_MODEL
    routes.push({
      provider,
      model,
      endpoint:
        provider === 'mock'
          ? null
          : provider === selected
            ? (configuredEndpoint ?? null)
            : provider === 'live'
              ? DEFAULT_ENDPOINT
              : DEFAULT_OPENROUTER_ENDPOINT,
      keyRef: ref,
      keyPresent: await keyPresent(ref, io.env),
      selected: provider === selected,
    })
  }

  const catalogue: CatalogueReport | undefined = wanted
    ? await fetchCatalogue(selected, { endpoint: configuredEndpoint ?? null }, io)
    : undefined

  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'models',
        provider: selected,
        model: configuredModel,
        latencyMs: 0,
        data: {
          selected,
          routes,
          catalogue:
            catalogue ?? {
              available: false,
              reason:
                'not requested. Pass --catalogue to ask the API what this account can call; the ' +
                'request is authenticated and is never made without this flag.',
            },
        },
      }),
    )
    return EXIT.OK
  }

  io.out(`${PROGRAM} models - what this tool would use`)
  io.out('')
  for (const route of routes) {
    io.out(`${route.selected ? '*' : ' '} ${route.provider.padEnd(11)} model=${route.model}`)
    io.out(`  ${' '.repeat(11)} posts to ${route.endpoint ?? 'nowhere (offline)'}`)
    io.out(
      `  ${' '.repeat(11)} ` +
        (route.keyRef === null
          ? 'no credential needed'
          : `${route.keyRef} ${route.keyPresent ? 'present' : 'NOT SET'}`),
    )
  }
  io.out('')
  io.out('* is the route the current flags select. The offline mock is the default.')

  if (catalogue === undefined) {
    io.out(
      'The model catalogue was not requested. `--catalogue` asks the API what this account can ' +
        'call; it is an authenticated request, so it is never made without the flag.',
    )
    return EXIT.OK
  }
  if (!catalogue.available) {
    io.out(`The catalogue is unavailable: ${catalogue.reason}`)
    return EXIT.OK
  }

  io.out('')
  io.out(`Catalogue from ${catalogue.source} - ${catalogue.models.length} model(s):`)
  for (const model of catalogue.models) {
    const released = model.releaseDate === undefined ? '' : `  released ${model.releaseDate}`
    io.out(`  ${model.name}${released}`)
    if (model.description !== undefined && model.description.length > 0) {
      io.out(`    ${model.description}`)
    }
  }
  return EXIT.OK
}
