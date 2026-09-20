/**
 * The model catalogue, and the one question an operator actually asks of it.
 *
 * An operator who pins `jev-1.13.0` and an operator who writes `jev-latest` are
 * running different things, and nothing in this package used to be able to tell
 * them so. TypeSafe documents two mechanisms, and they answer *different*
 * questions — which is the fact this module is built around:
 *
 *  - **`GET /v1/models` is a catalogue, not a resolution.** "returns the names
 *    your account can send in the `model` field, with a description and release
 *    date for each. **It currently lists the aliases.** Versioned IDs such as
 *    `jev-1.13.0` are accepted by the `model` field whether or not they appear in
 *    the list." (https://docs.typesafe.ai/models). The SDK reaches it as
 *    `client.models.list()` (`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:232-237`,
 *    `client.models` at `:269`) and unwraps its `{ models: [...] }` envelope into
 *    a `ModelCard[]` (`dist/index.mjs:365-371`). So the catalogue says what
 *    exists. It does **not** say where an alias points, and this module never
 *    pretends that it does.
 *  - **The `model` field of a real answer is a resolution.** "The response's
 *    `model` field reports the versioned ID that answered, so you can log which
 *    model produced each result." (same page). That is a measurement of what
 *    actually ran, and it is the only way to learn where an alias currently
 *    points. {@link resolveAliasFromAnswer} records one from a call already
 *    made; {@link probeAlias} makes one on purpose.
 *
 * What none of this can see, and what the doc comments below say again where it
 * matters: a resolution is a **point-in-time observation**, not a promise.
 * `jev-latest` is a moving target by design — the docs say so plainly, "an alias
 * moves when a new release ships, so the answers behind it can change without a
 * change on your side" — so a drift check answers "was it different when I
 * looked", and nothing about the future.
 *
 * Everything here is injectable through `loadSdk` (and through the transport the
 * catalogue and the probe are given), so the whole module is testable with no
 * network, no key and no socket. No dependency is added: the listings come from
 * the SDK this package already optionally loads.
 */

import { isRecord } from '../answers.js'
import { JevProviderError, type JevQuestion, type JsonValue } from '../types.js'
import { armCallBudget, classifyProviderFailure, requestIdOf } from './classify.js'
import {
  DEFAULT_CALL_TOTAL_BUDGET_MS,
  DEFAULT_ENDPOINT,
  LiveProvider,
  assertUsableEndpoint,
  loadOfficialSdk,
  sdkClientConfig,
  type ProviderLogLevel,
  type SdkModule,
  type SystemOneClient,
} from './live.js'

/**
 * One entry from `GET /v1/models`.
 *
 * `name` is the only field a caller can act on — it is what goes in a request's
 * `model` field — so it is the only one that is required. The other two are
 * documented as always present on the wire
 * (https://docs.typesafe.ai/models); they are optional here because a proxy in
 * front of the API is free to drop them, and a card that arrived without a
 * description is still a usable name.
 */
export interface JevModelCard {
  /** The model id or alias, as accepted by a request's `model` field. */
  readonly name: string
  /** What the model is for, when the endpoint described it. */
  readonly description?: string | undefined
  /** When the model or alias was released, in the endpoint's own format. */
  readonly releaseDate?: string | undefined
}

/**
 * Read a `GET /v1/models` payload.
 *
 * Two shapes are accepted, and the reason is not defensiveness for its own sake:
 *
 *  - a **bare array**, which is what `client.models.list()` resolves to, because
 *    the SDK unwraps the envelope for us (`dist/index.mjs:365-371`);
 *  - **`{ models: [...] }`**, the documented wire shape, for a caller who reads
 *    the endpoint through their own transport or a proxy.
 *
 * `release_date` is read in both spellings — this package has been bitten by
 * that before (`readUsage` in `live.ts` reads `input_tokens` and `inputTokens`
 * for the same reason) — and a camelCase `releaseDate` is accepted alongside it.
 *
 * An entry with no usable `name` is **dropped rather than kept**. The name is
 * the only field anything downstream can compare or request, and a card whose
 * name is `""` would make a drift check compare against nothing while looking
 * like it had compared against something.
 *
 * A payload of neither shape reads as **no models**, not as an error: this is a
 * reader, and {@link listModels} is where the shape is insisted on. Callers who
 * need the distinction should use that.
 */
export const readModelCards = (value: unknown): readonly JevModelCard[] => {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : []
  const cards: JevModelCard[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const name = entry.name
    if (typeof name !== 'string' || name.length === 0) continue
    const description = entry.description
    const releaseDate = entry.release_date ?? entry.releaseDate
    cards.push({
      name,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof releaseDate === 'string' ? { releaseDate } : {}),
    })
  }
  return cards
}

/** Whether a payload is recognisably a model list, in either accepted shape. */
const isCatalogueShape = (value: unknown): boolean =>
  Array.isArray(value) || (isRecord(value) && Array.isArray(value.models))

/**
 * What {@link listModels} needs in order to reach the endpoint.
 *
 * The transport fields repeat {@link LiveProviderOptions} deliberately: the
 * catalogue is the same client talking to the same endpoint, so it must be built
 * from the same decisions — key supplied explicitly, log level supplied
 * explicitly, `debug` clamped. They are passed through {@link sdkClientConfig},
 * which is the one place those decisions live.
 */
export interface ModelCatalogOptions {
  /** Resolved API key. Never sourced from the environment by this module. */
  readonly apiKey: string
  /** API root. Defaults to {@link DEFAULT_ENDPOINT}. */
  readonly baseURL?: string
  /** SDK log level. Defaults to `warn`, and `debug` is clamped; see `live.ts`. */
  readonly logLevel?: ProviderLogLevel
  /** Milliseconds per attempt, or the SDK default when omitted. */
  readonly timeout?: number
  /** Ceiling on the whole listing call. Defaults to the shared total budget. */
  readonly totalBudgetMs?: number
  /** Retry overrides; omitted fields use the SDK's own defaults. */
  readonly retry?: Readonly<Record<string, unknown>>
  /**
   * Let the SDK print response bodies, which for this call is the catalogue
   * itself. Off by default, and it changes nothing about what is sent.
   */
  readonly allowSdkBodyLogging?: boolean
  /** Cancels the listing, exactly as it would cancel an answer. */
  readonly signal?: AbortSignal
  /** Injectable for tests, so no test needs a real key or a real socket. */
  readonly loadSdk?: () => Promise<SdkModule>
}

/**
 * List the models this account can name, through the SDK's own resource.
 *
 * Refuses rather than guesses in three places, each for its own reason:
 *
 *  - an endpoint that is not `https:` (or loopback `http:`) is refused by the
 *    same {@link assertUsableEndpoint} the providers use, so a typo cannot send
 *    a key in cleartext;
 *  - a transport with no `models` resource reports `provider-unavailable`
 *    instead of returning an empty catalogue, because "I could not ask" and "the
 *    answer is nothing" are different facts and an empty list would be read as
 *    the second;
 *  - a payload in neither accepted shape reports `malformed-response` rather
 *    than an empty list, for the same reason.
 *
 * A genuine empty catalogue — `{ models: [] }` — is returned as an empty array.
 * That one *is* an answer.
 *
 * The call is bounded by the same total budget as an answer
 * ({@link DEFAULT_CALL_TOTAL_BUDGET_MS}), because `timeout` is per attempt and
 * the SDK has no total retry budget. The SDK's own retry policy still applies
 * inside that ceiling.
 */
export const listModels = async (
  options: ModelCatalogOptions,
): Promise<readonly JevModelCard[]> => {
  const baseURL = assertUsableEndpoint(options.baseURL ?? DEFAULT_ENDPOINT)
  const load = options.loadSdk ?? loadOfficialSdk

  let client: SystemOneClient
  try {
    const sdk = await load()
    client = new sdk.TypeSafeClient(
      sdkClientConfig({
        apiKey: options.apiKey,
        baseURL,
        logLevel: options.logLevel,
        timeout: options.timeout,
        retry: options.retry,
        allowSdkBodyLogging: options.allowSdkBodyLogging,
      }),
    )
  } catch (cause) {
    // A construction failure is not a transport failure, so it is deliberately
    // **not** pushed through {@link classifyProviderFailure}: with no response
    // and no status, that classifier's honest answer would be
    // `upstream-unreachable`, which sends an operator looking for a network
    // fault that does not exist. The SDK throws here for a missing key, a
    // runtime with no global `fetch`, or a browser page — all of which are
    // `provider-unavailable`. The cause is attached and its message is not
    // echoed, for the same reason the providers never echo an upstream body.
    throw cause instanceof JevProviderError
      ? cause
      : new JevProviderError(
          'the TypeSafe client for the model catalogue could not be built, so the catalogue ' +
            'cannot be listed.',
          'provider-unavailable',
          { cause },
        )
  }

  const models = client.models
  if (models === undefined) {
    throw new JevProviderError(
      'the installed TypeSafe SDK exposes no model catalogue, so `GET /v1/models` cannot be ' +
        'reached through it. `client.models.list()` is documented on @typesafe-ai/sdk from ' +
        '0.5.7 (https://docs.typesafe.ai/sdk/javascript/api/interfaces/Models).',
      'provider-unavailable',
    )
  }

  const budget = armCallBudget(
    options.totalBudgetMs ?? DEFAULT_CALL_TOTAL_BUDGET_MS,
    options.signal,
  )
  let payload: unknown
  try {
    payload = await models.list(budget.signal === undefined ? {} : { signal: budget.signal })
  } catch (cause) {
    throw classifyProviderFailure(cause, {
      providerId: 'live',
      label: 'TypeSafe',
      signal: options.signal,
      requestId: requestIdOf(cause),
    })
  } finally {
    budget.dispose()
  }

  if (!isCatalogueShape(payload)) {
    throw new JevProviderError(
      'TypeSafe returned a model list that is neither an array nor an object with a "models" ' +
        'array, so nothing can be said about what this account can call.',
      'malformed-response',
    )
  }
  return readModelCards(payload)
}

/**
 * Where an alias pointed, as observed once.
 *
 * A record of one measurement rather than a property of the alias: `model` is
 * what an answer said had produced it, and `observedAt` is when that answer
 * arrived. Keeping the two together is what stops a resolution from ageing into
 * a belief — a resolution with no timestamp cannot be told apart from a current
 * fact, and the docs are explicit that an alias moves.
 */
export interface JevAliasResolution {
  /** The alias that was sent in the request's `model` field. */
  readonly alias: string
  /** The model the response's own `model` field named. */
  readonly model: string
  /** When this was observed, ISO-8601, from the caller's clock. */
  readonly observedAt: string
}

/**
 * Record what an alias resolved to, from an answer you already have.
 *
 * This is the cheap half of a drift check: any call the service has already made
 * carries the id of the model that answered it, so an operator who wants to know
 * where `jev-latest` pointed at 09:14 can read it off that call rather than
 * paying for another one. {@link probeAlias} is for when there is no such call.
 *
 * Returns `undefined` when the answer named no model, so a caller reports "not
 * known" instead of recording an empty resolution. Note that a provider falls
 * back to the *requested* name when a response omits `model` (`live.ts`), so an
 * answer naming the alias itself is possible — {@link checkAliasDrift} treats
 * that as unresolved rather than as alignment, and says why.
 */
export const resolveAliasFromAnswer = (
  alias: string,
  answered: { readonly model: string },
  observedAt: Date = new Date(),
): JevAliasResolution | undefined => {
  if (alias.trim().length === 0 || answered.model.trim().length === 0) return undefined
  return { alias, model: answered.model, observedAt: observedAt.toISOString() }
}

/**
 * What a drift check concluded. Four outcomes, because three would have to lie
 * about one of the cases below.
 */
export type AliasDriftVerdict =
  /** The alias resolved to exactly the pinned model, when it was looked at. */
  | 'aligned'
  /** The alias resolved to something other than the pin. */
  | 'drifted'
  /** The alias alone was asked about: what it points at, with nothing to compare. */
  | 'unpinned'
  /** Nothing can be concluded — see `detail` for which of the four reasons. */
  | 'unknown'

/**
 * The result of comparing a pin against an observed resolution.
 *
 * `detail` is prose on purpose. A verdict is a decision an operator acts on, and
 * every one of the four carries a different action; the sentence is what tells
 * them which, without their having to reconstruct the reasoning from the fields.
 */
export interface AliasDrift {
  /** The alias that was checked. */
  readonly alias: string
  /** The model the caller pinned, when they pinned one. */
  readonly pin?: string | undefined
  /** The observation the verdict was reached from, when there was one. */
  readonly resolution?: JevAliasResolution | undefined
  readonly verdict: AliasDriftVerdict
  /** What the verdict means, in one sentence, including why it is `unknown`. */
  readonly detail: string
}

/**
 * Compare a pinned model against what an alias was last seen resolving to.
 *
 * **The comparison is exact string equality, and nothing is normalised.** No
 * prefix handling, no semantic-version ranges, no "close enough":
 * `jev-1.13`, `jev-1.13.0` and `typesafe/jev-1.13.0` are three different pins
 * here, because no TypeSafe source documents any equivalence between those
 * spellings — the docs describe `model` values as opaque names the endpoint
 * accepts. A comparison that invented an equivalence would turn a check an
 * operator can rely on into a guess, and this is precisely the check whose whole
 * purpose is to catch a silent difference.
 *
 * The four outcomes, and what each one is actually entitled to say:
 *
 *  - `unpinned` — no pin was supplied. The alias resolved to `resolution.model`
 *    at `resolution.observedAt`; there is nothing to compare it against.
 *  - `aligned` / `drifted` — the pin and the observed resolution differ, or do
 *    not, as whole strings. This is a statement about the moment of observation
 *    and nothing more: `jev-latest` is documented to move when a release ships,
 *    so `aligned` today is not a promise about tomorrow.
 *  - `unknown` — one of four things, all of them stated in `detail`: no
 *    resolution was observed (`GET /v1/models` lists aliases, not their
 *    targets, so a catalogue alone can never settle this); the resolution is for
 *    a different alias; the endpoint named the alias itself rather than a
 *    versioned id, which is not a resolution; or the pin is the alias, so the
 *    comparison would be a moving target against itself.
 */
export const checkAliasDrift = (options: {
  readonly alias: string
  readonly pin?: string | undefined
  readonly resolution?: JevAliasResolution | undefined
}): AliasDrift => {
  const { alias, pin, resolution } = options
  const report = (
    verdict: AliasDriftVerdict,
    detail: string,
  ): AliasDrift => ({
    alias,
    ...(pin === undefined ? {} : { pin }),
    ...(resolution === undefined ? {} : { resolution }),
    verdict,
    detail,
  })

  if (resolution === undefined) {
    return report(
      'unknown',
      `no resolution of "${alias}" has been observed. \`GET /v1/models\` lists the aliases ` +
        'themselves, not what they point at, so a resolution requires a real call whose response ' +
        'names the model that answered.',
    )
  }
  if (resolution.alias !== alias) {
    return report(
      'unknown',
      `the resolution on hand is for "${resolution.alias}", not "${alias}", so it says nothing ` +
        `about "${alias}".`,
    )
  }
  if (resolution.model === alias) {
    return report(
      'unknown',
      `the endpoint named "${alias}" itself rather than a versioned id, which is not a ` +
        'resolution. Either the response carried no model and the provider fell back to the ' +
        'requested name, or the alias did not resolve; neither settles the question.',
    )
  }
  if (pin === undefined) {
    return report(
      'unpinned',
      `"${alias}" resolved to "${resolution.model}" at ${resolution.observedAt}. No pin was ` +
        'supplied, so there is nothing to compare against.',
    )
  }
  if (pin === alias) {
    return report(
      'unknown',
      `the pin is "${alias}" itself, so this would compare a moving target with itself. Pin a ` +
        'versioned id instead — the docs name jev-1.13.0 — and the comparison starts to mean ' +
        'something.',
    )
  }
  if (pin === resolution.model) {
    return report(
      'aligned',
      `"${alias}" resolved to "${pin}" at ${resolution.observedAt}, the model you pinned. This ` +
        'is what was observed then: the alias is documented to move when a new release ships, so ' +
        'it is not a promise about the next call.',
    )
  }
  return report(
    'drifted',
    `"${alias}" resolved to "${resolution.model}" at ${resolution.observedAt}, not to your pin ` +
      `"${pin}", so the two names were running different models.`,
  )
}

/**
 * What {@link probeAlias} needs: a real question to ask, and a transport to ask
 * it through.
 *
 * The question is the caller's, not a canned one, because a probe is a real call
 * on a real account: inventing a question would spend someone's tokens on
 * something they did not ask, and a trivially cheap question would make the
 * answer's meaning depend on a payload nobody chose.
 */
export interface AliasProbeOptions extends ModelCatalogOptions {
  /** The alias to send, e.g. `jev-latest`. */
  readonly alias: string
  /** The state to send with the probe. Redacted by the caller the same way any state is. */
  readonly state: JsonValue
  /** The questions to ask. One is enough; the answers are discarded. */
  readonly questions: Readonly<Record<string, JevQuestion>>
}

/**
 * Resolve an alias by asking the endpoint, once.
 *
 * The measurement the drift check needs, when no answer is already in hand: the
 * call sends the alias as its `model`, and the response names the versioned id
 * that answered. It goes through {@link LiveProvider}, so the probe inherits the
 * same endpoint validation, the same explicit key and log level, and the same
 * total budget as any other call this package makes — a second client built here
 * would be a second place for those to drift.
 *
 * Two things it is honest to be clear about: **it costs input tokens**, because
 * it is a real System One request, and it returns what was true at that moment.
 * It also discards the answers it paid for, which is the reason
 * {@link resolveAliasFromAnswer} exists — if a call is going to be made anyway,
 * reading its `model` field is free.
 *
 * It refuses one outcome rather than returning it. A response that omits `model`
 * makes the provider fall back to the requested name (`live.ts`), so a probe can
 * come back naming the alias itself — which is not a resolution, and a caller
 * who probed precisely to learn the versioned id would otherwise be handed a
 * value that looks like an answer and is not one. That case reports
 * `malformed-response` instead.
 */
export const probeAlias = async (options: AliasProbeOptions): Promise<JevAliasResolution> => {
  const provider = new LiveProvider({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    model: options.alias,
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.totalBudgetMs === undefined ? {} : { totalBudgetMs: options.totalBudgetMs }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.allowSdkBodyLogging === undefined
      ? {}
      : { allowSdkBodyLogging: options.allowSdkBodyLogging }),
    ...(options.loadSdk === undefined ? {} : { loadSdk: options.loadSdk }),
  })

  const result = await provider.answer(
    { state: options.state, questions: options.questions, model: options.alias },
    options.signal,
  )
  const resolution = resolveAliasFromAnswer(options.alias, result)
  if (resolution === undefined) {
    throw new JevProviderError(
      `the probe of "${options.alias}" completed without naming a model, so where the alias ` +
        'points is still not known.',
      'malformed-response',
    )
  }
  if (resolution.model === options.alias) {
    throw new JevProviderError(
      `the probe of "${options.alias}" came back naming "${options.alias}" itself rather than a ` +
        'versioned id, which is not a resolution: either the response carried no model and the ' +
        'provider fell back to the requested name, or the endpoint echoed the alias.',
      'malformed-response',
    )
  }
  return resolution
}
