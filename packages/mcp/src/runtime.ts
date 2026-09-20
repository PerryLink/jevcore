/**
 * Shared setup for the MCP surface.
 *
 * The MCP server is a second entry point over the same core as the DSH plugin:
 * one decision layer, two transports. Nothing decision-shaped is implemented
 * here — this module only decides which provider to build and which features
 * may transmit.
 */

import {
  DEFAULT_CONFIG,
  EgressContract,
  JevProviderError,
  JevService,
  LiveProvider,
  MockProvider,
  OpenRouterProvider,
  resolveApiKey,
  type EgressFeature,
  type JevConfig,
  type JevProvider,
  type ProviderKind,
} from 'jevcore'

/** Feature switches for the MCP surface. The gates are a DSH concept, not an MCP one. */
const MCP_EGRESS: Record<EgressFeature, boolean> = {
  'tool:jev_ask': true,
  'tool:jev_rank': true,
  'tool:jev_check': true,
  'gate:safety': false,
  'gate:context': false,
}

export interface McpRuntime {
  readonly service: JevService
  readonly egress: EgressContract
  readonly config: JevConfig
  /** One line per feature, for stderr. Never contains payload content. */
  readonly report: readonly string[]
}

/**
 * Which provider to use.
 *
 * `JEV_PROVIDER` wins when set. Otherwise the presence of a credential decides,
 * checking OpenRouter as well as TypeSafe: a server launched with an OpenRouter
 * key but no TypeSafe key should reach Jev rather than quietly answering
 * synthetically. With neither, it stays offline instead of failing every call,
 * which keeps the tool usable for a smoke test.
 */
export const chooseProvider = (env: (name: string) => string | undefined): ProviderKind => {
  const explicit = env('JEV_PROVIDER')?.trim().toLowerCase()
  if (explicit === 'live' || explicit === 'openrouter' || explicit === 'mock') return explicit

  const has = (name: string): boolean => {
    const value = env(name)
    return value !== undefined && value.trim().length > 0
  }
  if (has('TYPESAFE_API_KEY')) return 'live'
  if (has('OPENROUTER_API_KEY')) return 'openrouter'
  return 'mock'
}

export const buildRuntime = async (
  env: (name: string) => string | undefined = (name) => process.env[name],
): Promise<McpRuntime> => {
  const kind = chooseProvider(env)
  const isOpenRouter = kind === 'openrouter'

  const apiKeyRef = 'TYPESAFE_API_KEY'
  const openRouterApiKeyRef = 'OPENROUTER_API_KEY'
  // One default for both routes. OpenRouter maps a bare `jev-*` id onto its own
  // namespace, so `jev-latest` is valid there too. This used to substitute a
  // prefixed id for OpenRouter because the provider rejected bare ones, which is
  // why the MCP server worked while the DSH plugin threw at startup.
  const model =
    env(isOpenRouter ? 'OPENROUTER_MODEL' : 'TYPESAFE_MODEL')?.trim() || DEFAULT_CONFIG.model

  const config: JevConfig = {
    // Spread the shared defaults rather than restating them: the thresholds and
    // transport settings used to be duplicated here, so tuning one entry point
    // silently left the other unchanged.
    ...DEFAULT_CONFIG,
    provider: kind,
    apiKeyRef,
    openRouterApiKeyRef,
    baseURL: undefined,
    openRouterBaseURL: undefined,
    model,
  }

  const egress = new EgressContract(
    { transmitting: kind !== 'mock', enabled: MCP_EGRESS },
    isOpenRouter
      ? env('OPENROUTER_BASE_URL')?.trim() || 'https://openrouter.ai'
      : env('TYPESAFE_BASE_URL')?.trim() || 'https://api.typesafe.ai',
    // No MCP-side config surface for the cap yet, so the per-feature declared
    // caps apply unchanged.
    undefined,
  )

  let provider: JevProvider
  if (kind === 'mock') {
    provider = new MockProvider()
  } else {
    // Resolved once at startup: an MCP server is a long-lived process and its
    // credential does not change mid-session. A missing key is a startup error
    // rather than a per-call surprise.
    const ref = isOpenRouter ? openRouterApiKeyRef : apiKeyRef
    const resolved = await resolveApiKey({ ref, env })
    if (resolved === undefined) {
      throw new JevProviderError(
        `provider "${kind}" was selected but no credential was found for ${ref}. Set the ` +
          `environment variable, or set JEV_PROVIDER=mock to run offline.`,
        'no-credential',
      )
    }
    // Transport settings go to the TypeSafe provider only. They exist to defeat
    // the TypeSafe SDK's environment fallbacks: its `logLevel` defaults to
    // TYPESAFE_LOG_LEVEL and `debug` writes request bodies with credential
    // headers redacted but bodies not, which would log exactly what this
    // package redacts before sending. OpenRouter's own SDK reads no such
    // variable, so it needs none of this.
    provider = isOpenRouter
      ? new OpenRouterProvider({ apiKey: resolved.value, model })
      : new LiveProvider({
          apiKey: resolved.value,
          model,
          logLevel: config.logLevel === 'silent' ? 'off' : config.logLevel,
          timeout: config.requestTimeoutMs,
          retry: { maxRetries: config.requestMaxRetries },
        })
  }

  const service = new JevService({
    provider,
    egress,
    transmitting: kind !== 'mock',
    model,
  })

  return { service, egress, config, report: egress.reportLines() }
}
