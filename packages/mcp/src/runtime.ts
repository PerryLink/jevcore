/**
 * Shared setup for the MCP surface.
 *
 * The MCP server is a second entry point over the same core as the DSH plugin:
 * one decision layer, two transports. Nothing decision-shaped is implemented
 * here — this module only decides which provider to build and which features
 * may transmit.
 */

import {
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
  const model =
    env(isOpenRouter ? 'OPENROUTER_MODEL' : 'TYPESAFE_MODEL')?.trim() ||
    (isOpenRouter ? 'typesafe/jev-1.13' : 'jev-latest')

  const config: JevConfig = {
    provider: kind,
    apiKeyRef,
    openRouterApiKeyRef,
    baseURL: undefined,
    openRouterBaseURL: undefined,
    model,
    logLevel: 'warn',
    minConfidence: 0.7,
    minProbability: 0.6,
    maxStateChars: undefined,
    gates: {
      safety: { enabled: false, onUndecided: 'ask' },
      context: { enabled: false, onUndecided: 'ask' },
    },
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
    provider = isOpenRouter
      ? new OpenRouterProvider({ apiKey: resolved.value, model })
      : new LiveProvider({ apiKey: resolved.value, model })
  }

  const service = new JevService({
    provider,
    egress,
    transmitting: kind !== 'mock',
    model,
  })

  return { service, egress, config, report: egress.reportLines() }
}
