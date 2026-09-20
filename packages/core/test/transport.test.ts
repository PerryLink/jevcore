/**
 * Transport and model-id regressions.
 *
 * Two live-confirmed defects, each locked here so they cannot come back:
 *
 *  1. `TYPESAFE_LOG_LEVEL=debug` in the ambient environment made the SDK print
 *     request bodies with credential headers redacted but **bodies not** —
 *     reproduced against the live API, and it logged the very state this package
 *     redacts before sending. The provider must pass `logLevel` explicitly.
 *  2. `assertSystemOneModel` rejected bare `jev-*` ids, so `provider: openrouter`
 *     with the default model threw at startup, while the MCP runtime dodged it by
 *     substituting a prefixed id. Verified live: the route accepts `jev-latest`
 *     and `jev-1.13`, and accepts `typesafe/jev-1.13` but *not*
 *     `typesafe/jev-latest` — so "must carry the prefix" was never the real rule.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DEFAULT_LOG_LEVEL,
  LiveProvider,
  OpenRouterProvider,
  assertSystemOneModel,
} from '../src/index.js'

/**
 * Capture what a provider hands to the SDK constructor.
 *
 * The capture is created fresh per call, so tests cannot observe a previous
 * test's client: `LiveProvider` caches the client it builds, which made an
 * earlier version of this helper assert against a stale object.
 */
const captureClientConfig = async (options: Record<string, unknown>) => {
  const captured: { config?: Record<string, unknown> } = {}
  const stub = {
    TypeSafeClient: class {
      constructor(config: Record<string, unknown>) {
        captured.config = config
      }
      async systemOne() {
        return { model: 'stub', answers: {} }
      }
    },
  }
  const provider = new LiveProvider({
    apiKey: 'test-key',
    loadSdk: async () => stub as never,
    ...options,
  } as never)
  await provider.answer({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } })
  if (captured.config === undefined) throw new Error('the SDK client was never constructed')
  return captured.config
}

describe('transport settings are passed explicitly', () => {
  it('always passes a logLevel, so TYPESAFE_LOG_LEVEL cannot raise it', async () => {
    const seen = await captureClientConfig({})
    // The point is that the key is present at all: absent, the SDK falls back to
    // the environment, and `debug` logs unredacted bodies.
    expect(seen).toHaveProperty('logLevel')
    expect(seen?.logLevel).toBe(DEFAULT_LOG_LEVEL)
  })

  it('honours an explicit logLevel', async () => {
    const seen = await captureClientConfig({ logLevel: 'error' })
    expect(seen?.logLevel).toBe('error')
  })

  it('passes timeout and retry only when configured, never inventing them', async () => {
    const bare = await captureClientConfig({})
    expect(bare).not.toHaveProperty('timeout')
    expect(bare).not.toHaveProperty('retry')

    const configured = await captureClientConfig({ timeout: 5000, retry: { maxRetries: 0 } })
    expect(configured?.timeout).toBe(5000)
    expect(configured?.retry).toEqual({ maxRetries: 0 })
  })

  it('never lets the SDK fall back to the environment for the api key', async () => {
    const seen = await captureClientConfig({})
    expect(seen?.apiKey).toBe('test-key')
  })

  it('ships transport defaults in the shared config', () => {
    expect(DEFAULT_CONFIG.requestTimeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.requestMaxRetries).toBe(2)
  })
})

describe('System One model ids', () => {
  it('accepts bare jev ids, which is what the route expects', () => {
    // Verified live: `jev-latest` and `jev-1.13` are both accepted and resolve
    // to a versioned typesafe/ id in the response.
    expect(assertSystemOneModel('jev-latest')).toBe('jev-latest')
    expect(assertSystemOneModel('jev-1.13')).toBe('jev-1.13')
  })

  it('accepts a prefixed id', () => {
    expect(assertSystemOneModel('typesafe/jev-1.13')).toBe('typesafe/jev-1.13')
  })

  it('refuses models from other families, which answer with prose', () => {
    for (const model of ['gpt-4o', 'claude-3-opus', 'openai/gpt-4o', 'llama-3', 'typesafe/other']) {
      expect(() => assertSystemOneModel(model), model).toThrow()
    }
  })

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(assertSystemOneModel('  jev-latest  ')).toBe('jev-latest')
  })

  it('the default model works on the OpenRouter route', () => {
    // The regression: constructing with the shared default used to throw, which
    // made `provider: openrouter` unusable out of the box.
    expect(() => new OpenRouterProvider({ apiKey: 'x', model: DEFAULT_CONFIG.model })).not.toThrow()
  })
})
