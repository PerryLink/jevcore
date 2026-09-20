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
import { BODY_SAFE_LOG_LEVEL, sdkLogLevelFor } from '../src/provider/live.js'

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

/**
 * The debug path, which used to be a privacy hole.
 *
 * The SDK's `debug` level writes request bodies verbatim, headers redacted and
 * bodies not — its own source, `@typesafe-ai/sdk@0.6.0` `dist/index.mjs:596-599`:
 *
 * ```js
 * this.logger.debug(`${tag} -> ${url}`, {
 *   headers: redactHeaders(attemptHeaders),
 *   body: req.body
 * })
 * ```
 *
 * and the same level prints the parsed response body (`:573`) and an error body
 * (`:618`). `LiveProviderOptions.logLevel` accepted `'debug'` and forwarded it,
 * and the DSH and MCP wiring both pass `config.logLevel` straight through
 * (`packages/dsh/src/index.ts:235`, `packages/mcp/src/runtime.ts:148`), so a
 * single `logLevel: 'debug'` in configuration wrote the state this package
 * redacts — after redaction, but to a log the caller believed was safe — with no
 * warning anywhere on the path. The fix is that `debug` is not forwarded unless
 * the caller asks for body logging by name.
 */
describe('a request body cannot reach the log by configuration alone', () => {
  it('maps only debug, and only when the caller allows bodies', () => {
    expect(sdkLogLevelFor('debug')).toBe(BODY_SAFE_LOG_LEVEL)
    expect(sdkLogLevelFor('debug', false)).toBe(BODY_SAFE_LOG_LEVEL)
    expect(sdkLogLevelFor('debug', true)).toBe('debug')
    // Nothing else is touched: `allowSdkBodyLogging` is an opt-in to bodies, not
    // a licence to raise verbosity past what was asked for.
    for (const level of ['info', 'warn', 'error', 'off'] as const) {
      expect(sdkLogLevelFor(level), level).toBe(level)
      expect(sdkLogLevelFor(level, true), level).toBe(level)
    }
    expect(BODY_SAFE_LOG_LEVEL).not.toBe('debug')
  })

  it('never hands the SDK a level that prints bodies, from configuration alone', async () => {
    const seen = await captureClientConfig({ logLevel: 'debug' })
    expect(seen.logLevel).not.toBe('debug')
    expect(seen.logLevel).toBe(BODY_SAFE_LOG_LEVEL)
  })

  it('forwards debug only behind the option named after its consequence', async () => {
    const seen = await captureClientConfig({ logLevel: 'debug', allowSdkBodyLogging: true })
    expect(seen.logLevel).toBe('debug')
  })

  it('cannot reach debug when nothing is configured', async () => {
    const seen = await captureClientConfig({})
    expect(seen.logLevel).toBe(DEFAULT_LOG_LEVEL)
  })

  it('applies the same clamp on the OpenRouter route, which shares the client', async () => {
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
    const provider = new OpenRouterProvider({
      apiKey: 'test-key',
      logLevel: 'debug',
      loadSdk: async () => stub as never,
    })
    await provider.answer({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } })
    expect(captured.config?.logLevel).toBe(BODY_SAFE_LOG_LEVEL)

    const allowed: { config?: Record<string, unknown> } = {}
    const optInStub = {
      TypeSafeClient: class {
        constructor(config: Record<string, unknown>) {
          allowed.config = config
        }
        async systemOne() {
          return { model: 'stub', answers: {} }
        }
      },
    }
    const opted = new OpenRouterProvider({
      apiKey: 'test-key',
      logLevel: 'debug',
      allowSdkBodyLogging: true,
      loadSdk: async () => optInStub as never,
    })
    await opted.answer({ state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } })
    expect(allowed.config?.logLevel).toBe('debug')
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
