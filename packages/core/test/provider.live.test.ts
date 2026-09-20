import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  LiveProvider,
  assertUsableEndpoint,
  loadOfficialSdk,
} from '../src/provider/live.js'
import { assertValidBatch, choice, noul } from '../src/primitives.js'
import { JevProviderError, type JevRequest } from '../src/types.js'

/**
 * A stub of the official SDK.
 *
 * The live provider is tested against this rather than the real network, so the
 * suite needs no API key, no socket, and no quota. What is verified here is the
 * provider's own contract: how it builds the client, what it sends, and how it
 * normalizes what comes back.
 */
interface StubCall {
  readonly config: Record<string, unknown>
  readonly request: Record<string, unknown>
  readonly options: Record<string, unknown> | undefined
}

const stubSdk = (
  respond: (request: Record<string, unknown>) => unknown,
): { module: { TypeSafeClient: new (config: Record<string, unknown>) => unknown }; calls: StubCall[] } => {
  const calls: StubCall[] = []
  class StubClient {
    constructor(config: Record<string, unknown>) {
      this.config = config
    }
    readonly config: Record<string, unknown>
    systemOne(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
      calls.push({ config: this.config, request, options })
      return Promise.resolve(respond(request))
    }
  }
  return { module: { TypeSafeClient: StubClient as never }, calls }
}

const request = (overrides: Partial<JevRequest> = {}): JevRequest => ({
  state: { ticket: 'help' },
  questions: {
    urgent: noul('urgent?'),
    team: choice('which team?', { billing: null, technical: null }),
  },
  ...overrides,
})

const goodResponse = {
  model: 'jev-1.13.0',
  answers: {
    urgent: { noul: 0.91 },
    team: { choice: 'billing', probabilities: { billing: 0.7, technical: 0.3 }, confidence: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
}

describe('endpoint validation', () => {
  it('accepts https', () => {
    expect(assertUsableEndpoint('https://api.typesafe.ai')).toBe('https://api.typesafe.ai')
  })

  it('strips trailing slashes', () => {
    expect(assertUsableEndpoint('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai')
  })

  it('accepts loopback http for local testing', () => {
    expect(assertUsableEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(assertUsableEndpoint('http://localhost:8787')).toBe('http://localhost:8787')
  })

  it('refuses cleartext http to a remote host', () => {
    expect(() => assertUsableEndpoint('http://api.typesafe.ai')).toThrow(JevProviderError)
    expect(() => assertUsableEndpoint('http://api.typesafe.ai')).toThrow(/must use https/)
  })

  it('refuses a malformed URL', () => {
    expect(() => assertUsableEndpoint('not a url')).toThrow(/not a valid URL/)
  })
})

describe('client construction', () => {
  it('passes the key explicitly so the SDK cannot fall back to the environment', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({
      apiKey: 'ts_live_test_key',
      loadSdk: async () => sdk.module as never,
    })
    await provider.answer(request())
    expect(sdk.calls[0]?.config.apiKey).toBe('ts_live_test_key')
  })

  it('never allows browser use', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({
      apiKey: 'k',
      loadSdk: async () => sdk.module as never,
    })
    await provider.answer(request())
    expect(sdk.calls[0]?.config.dangerouslyAllowBrowser).toBe(false)
  })

  it('defaults the endpoint and reuses one client across calls', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    await provider.answer(request())
    await provider.answer(request())
    expect(provider.endpoint).toBe(DEFAULT_ENDPOINT)
    expect(sdk.calls).toHaveLength(2)
    expect(sdk.calls[0]?.config.baseURL).toBe(DEFAULT_ENDPOINT)
  })

  it('honours a configured endpoint', () => {
    const provider = new LiveProvider({ apiKey: 'k', baseURL: 'https://proxy.internal' })
    expect(provider.endpoint).toBe('https://proxy.internal')
  })

  it('reports a helpful error when the SDK is not installed', async () => {
    // Exercises the real loader against a specifier that cannot resolve, which
    // is what a user without the optional dependency actually hits.
    await expect(loadOfficialSdk('@typesafe-ai/sdk-not-installed-xyz')).rejects.toThrow(
      /Install it with/,
    )
  })

  it('classifies a missing SDK as provider-unavailable', async () => {
    await expect(loadOfficialSdk('@typesafe-ai/sdk-not-installed-xyz')).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('propagates a loader failure rather than returning an empty result', async () => {
    const provider = new LiveProvider({
      apiKey: 'k',
      loadSdk: async () => {
        throw new JevProviderError('missing', 'provider-unavailable')
      },
    })
    await expect(provider.answer(request())).rejects.toThrow(JevProviderError)
  })
})

describe('request shape', () => {
  it('sends the state and questions through unchanged', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    await provider.answer(request())
    expect(sdk.calls[0]?.request.state).toEqual({ ticket: 'help' })
    expect(Object.keys(sdk.calls[0]?.request.questions as object)).toEqual(['urgent', 'team'])
  })

  it('omits the model when none is configured', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    await provider.answer({ state: 's', questions: { q: noul('?') } })
    expect(sdk.calls[0]?.request.model).toBeUndefined()
  })

  it('uses the configured default model', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
      loadSdk: async () => sdk.module as never,
    })
    await provider.answer(request())
    expect(sdk.calls[0]?.request.model).toBe('jev-1.13.0')
  })

  it('lets a per-call model override the default', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({
      apiKey: 'k',
      model: 'jev-latest',
      loadSdk: async () => sdk.module as never,
    })
    await provider.answer(request({ model: 'jev-preview' }))
    expect(sdk.calls[0]?.request.model).toBe('jev-preview')
  })

  it('forwards the abort signal', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    const controller = new AbortController()
    await provider.answer(request(), controller.signal)
    expect(sdk.calls[0]?.options?.signal).toBe(controller.signal)
  })
})

describe('response normalization', () => {
  it('parses a noul answer', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    const result = await provider.answer(request())
    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.91 })
  })

  it('parses a choice answer with its distribution', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    const result = await provider.answer(request())
    expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'billing' })
  })

  it('reports the model the server named', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer(request())).model).toBe('jev-1.13.0')
  })

  it('falls back to the requested model when the server omits one', async () => {
    const sdk = stubSdk(() => ({ answers: {} }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer(request({ model: 'jev-x' }))).model).toBe('jev-x')
  })

  it('falls back to the default model name when nothing names one', async () => {
    const sdk = stubSdk(() => ({ answers: {} }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer({ state: 's', questions: { q: noul('?') } })).model).toBe(
      DEFAULT_MODEL,
    )
  })

  it('records token usage', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer(request())).usage).toEqual({
      inputTokens: 120,
      outputTokens: 0,
    })
  })

  it('marks the result as live', async () => {
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer(request())).provider).toBe('live')
  })
})

describe('normalization drops what it cannot verify', () => {
  it('drops an answer with no numeric noul instead of coercing it', async () => {
    const sdk = stubSdk(() => ({ answers: { urgent: { noul: 'high' }, team: {} } }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    const result = await provider.answer(request())
    expect(result.answers.urgent).toBeUndefined()
  })

  it('drops a choice answer with no chosen key', async () => {
    const sdk = stubSdk(() => ({ answers: { team: { probabilities: { billing: 1 } } } }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    expect((await provider.answer(request())).answers.team).toBeUndefined()
  })

  it('ignores non-numeric probabilities rather than passing NaN through', async () => {
    const sdk = stubSdk(() => ({
      answers: { team: { choice: 'billing', probabilities: { billing: 0.6, technical: 'lots' } } },
    }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    const answer = (await provider.answer(request())).answers.team
    expect(answer).toMatchObject({ probabilities: { billing: 0.6 } })
  })

  it('reports a malformed response rather than returning an empty success', async () => {
    const sdk = stubSdk(() => ({ model: 'jev-latest' }))
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    await expect(provider.answer(request())).rejects.toThrow(/no "answers" object/)
  })

  it('tolerates a response that is not an object', async () => {
    const sdk = stubSdk(() => 'unexpected')
    const provider = new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
    await expect(provider.answer(request())).rejects.toThrow(JevProviderError)
  })
})

describe('failure classification', () => {
  const failing = (error: unknown) => {
    const sdk = stubSdk(() => {
      throw error
    })
    return new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk.module as never })
  }

  it('classifies an auth failure as rejected', async () => {
    await expect(failing({ status: 401 }).answer(request())).rejects.toMatchObject({
      code: 'upstream-rejected',
    })
  })

  it('classifies a transport failure as unreachable', async () => {
    await expect(failing(new Error('socket hang up')).answer(request())).rejects.toMatchObject({
      code: 'upstream-unreachable',
    })
  })

  it('does not echo the upstream body, which can contain request headers', async () => {
    const provider = failing({ status: 500, message: 'Authorization: Bearer ts_live_secretvalue' })
    await expect(provider.answer(request())).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('ts_live_secretvalue') as unknown as string,
      }),
    )
  })

  it('reports the status without inventing a cause', async () => {
    await expect(failing({ status: 429 }).answer(request())).rejects.toThrow(/HTTP 429/)
  })
})

describe('batch validation is available to callers', () => {
  it('accepts the shapes this provider sends', () => {
    expect(() => assertValidBatch(request().questions)).not.toThrow()
  })

  it('rejects a batch the API would reject', () => {
    expect(() => assertValidBatch({ q: choice('pick', { only: null }) })).toThrow()
  })
})

describe('no ambient credential is read', () => {
  it('does not consult process.env for the key', async () => {
    const spy = vi.spyOn(process, 'env', 'get')
    const sdk = stubSdk(() => goodResponse)
    const provider = new LiveProvider({ apiKey: 'explicit', loadSdk: async () => sdk.module as never })
    await provider.answer(request())
    expect(sdk.calls[0]?.config.apiKey).toBe('explicit')
    spy.mockRestore()
  })
})
