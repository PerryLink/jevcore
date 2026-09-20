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
  resolveApiKey,
  type EgressFeature,
  type JevConfig,
  type JevProvider,
} from '@dsh-jev/core'

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
 * `JEV_PROVIDER` wins when set. Otherwise the presence of a credential decides:
 * a server launched with no key stays offline and answers synthetically rather
 * than failing every call, which makes the tool usable for a smoke test before
 * anyone has a key.
 */
export const chooseProvider = (env: (name: string) => string | undefined): 'mock' | 'live' => {
  const explicit = env('JEV_PROVIDER')?.trim().toLowerCase()
  if (explicit === 'live') return 'live'
  if (explicit === 'mock') return 'mock'
  const ref = env('TYPESAFE_API_KEY')
  return ref !== undefined && ref.trim().length > 0 ? 'live' : 'mock'
}

export const buildRuntime = async (
  env: (name: string) => string | undefined = (name) => process.env[name],
): Promise<McpRuntime> => {
  const kind = chooseProvider(env)

  const config: JevConfig = {
    provider: kind,
    apiKeyRef: 'TYPESAFE_API_KEY',
    baseURL: undefined,
    model: env('TYPESAFE_MODEL')?.trim() || 'jev-latest',
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
    { transmitting: kind === 'live', enabled: MCP_EGRESS },
    env('TYPESAFE_BASE_URL')?.trim() || 'https://api.typesafe.ai',
    // No MCP-side config surface for the cap yet, so the per-feature declared
    // caps apply unchanged.
    undefined,
  )

  let provider: JevProvider
  if (kind === 'live') {
    // Resolved once at startup: an MCP server is a long-lived process and its
    // credential does not change mid-session. A missing key is a startup error
    // rather than a per-call surprise.
    const resolved = await resolveApiKey({
      ref: config.apiKeyRef,
      env,
    })
    if (resolved === undefined) {
      throw new JevProviderError(
        'JEV_PROVIDER=live but no credential was found for TYPESAFE_API_KEY. Set the ' +
          'environment variable, or unset JEV_PROVIDER to run offline.',
        'no-credential',
      )
    }
    provider = new LiveProvider({
      apiKey: resolved.value,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      model: config.model,
    })
  } else {
    provider = new MockProvider()
  }

  const service = new JevService({ provider, egress, model: config.model, transmitting: kind === 'live' })

  return { service, egress, config, report: egress.reportLines() }
}
