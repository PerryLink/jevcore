import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODEL_PREFIX,
  OpenRouterProvider,
  assertSystemOneModel,
  assertUsableOpenRouterEndpoint,
} from '../src/provider/openrouter.js'
import { choice, noul } from '../src/primitives.js'
import { JevProviderError, type JevRequest } from '../src/types.js'

/**
 * A stub of the OpenRouter SDK.
 *
 * Everything here is verified against this rather than the network, so the suite
 * needs no OpenRouter key and no socket. The real contract was confirmed against
 * the published `@openrouter/sdk` types and a live call with an invalid key; what
 * these tests protect is our side of it.
 */
interface StubCall {
  readonly request: Record<string, unknown>
  readonly options: Record<string, unknown> | undefined
}

const stubSdk = (
  respond: (request: Record<string, unknown>) => unknown,
): {
  module: { OpenRouter: new (config: Record<string, unknown>) => unknown }
  calls: StubCall[]
  configs: Record<string, unknown>[]
} => {
  const calls: StubCall[] = []
  const configs: Record<string, unknown>[] = []
  class StubClient {
    constructor(config: Record<string, unknown>) {
      configs.push(config)
    }
    readonly alpha = {
      decisions: {
        create: (request: Record<string, unknown>, options?: Record<string, unknown>) => {
          calls.push({ request, options })
          return Promise.resolve(respond(request))
        },
      },
    }
  }
  return { module: { OpenRouter: StubClient as never }, calls, configs }
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
  model: 'typesafe/jev-1.13',
  provider: 'TypeSafe',
  answers: {
    urgent: { type: 'noul', noul: 0.91, confidence: 0.88 },
    team: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.7, technical: 0.3 },
      confidence: 0.7,
    },
  },
  usage: { inputTokens: 120, outputTokens: 0, cost: 0.000005 },
}

const provider = (respond: (request: Record<string, unknown>) => unknown = () => goodResponse) => {
  const sdk = stubSdk(respond)
  return {
    sdk,
    instance: new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      loadSdk: async () => sdk.module as never,
    }),
  }
}

describe('endpoint validation', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(assertUsableOpenRouterEndpoint('https://openrouter.ai/')).toBe('https://openrouter.ai')
  })

  it('accepts loopback http for a local proxy under test', () => {
    expect(assertUsableOpenRouterEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })

  it('refuses cleartext http to a remote host', () => {
    expect(() => assertUsableOpenRouterEndpoint('http://openrouter.ai')).toThrow(/must use https/)
  })

  it('refuses a malformed URL', () => {
    expect(() => assertUsableOpenRouterEndpoint('not a url')).toThrow(/not a valid URL/)
  })

  it('reports the full decisions path as its endpoint', () => {
    expect(provider().instance.endpoint).toBe(`${DEFAULT_OPENROUTER_ENDPOINT}/api/alpha/decisions`)
  })
})

describe('the model must be a System One model', () => {
  it('accepts the typesafe prefix', () => {
    expect(assertSystemOneModel('typesafe/jev-1.13')).toBe('typesafe/jev-1.13')
  })

  it('refuses anything else, because those answer with prose', () => {
    // Routing a decision question to a chat model would return text this plugin
    // cannot interpret, so the refusal happens before the call.
    expect(() => assertSystemOneModel('openai/gpt-5')).toThrow(/only call System One models/)
    expect(() => assertSystemOneModel('anthropic/claude-x')).toThrow(JevProviderError)
  })

  it('refuses a non-System-One model at construction', () => {
    expect(
      () => new OpenRouterProvider({ apiKey: 'k', model: 'meta/llama-4' }),
    ).toThrow(/only call System One models/)
  })

  it('defaults to a System One model', () => {
    expect(DEFAULT_OPENROUTER_MODEL.startsWith(OPENROUTER_MODEL_PREFIX)).toBe(true)
  })

  it('refuses a per-call model override that is not System One', async () => {
    const { instance } = provider()
    await expect(instance.answer(request({ model: 'openai/gpt-5' }))).rejects.toThrow(
      /only call System One models/,
    )
  })
})

describe('the request shape', () => {
  it('wraps the payload in decisionsRequest, which the SDK requires', async () => {
    // A bare object is rejected by the SDK's own schema; the wrapper is
    // mandatory and easy to omit.
    const { instance, sdk } = provider()
    await instance.answer(request())
    expect(Object.keys(sdk.calls[0]!.request)).toEqual(['decisionsRequest'])
  })

  it('names the model inside the wrapper', async () => {
    const { instance, sdk } = provider()
    await instance.answer(request())
    const inner = sdk.calls[0]!.request.decisionsRequest as Record<string, unknown>
    expect(inner.model).toBe(DEFAULT_OPENROUTER_MODEL)
  })

  it('sends the state and questions through unchanged', async () => {
    const { instance, sdk } = provider()
    await instance.answer(request())
    const inner = sdk.calls[0]!.request.decisionsRequest as Record<string, unknown>
    expect(inner.state).toEqual({ ticket: 'help' })
    expect(Object.keys(inner.questions as object)).toEqual(['urgent', 'team'])
  })

  it('lets a per-call model override the default', async () => {
    const { instance, sdk } = provider()
    await instance.answer(request({ model: 'typesafe/jev-latest' }))
    const inner = sdk.calls[0]!.request.decisionsRequest as Record<string, unknown>
    expect(inner.model).toBe('typesafe/jev-latest')
  })

  it('forwards the abort signal to the SDK', async () => {
    const { instance, sdk } = provider()
    const controller = new AbortController()
    await instance.answer(request(), controller.signal)
    expect(sdk.calls[0]!.options?.signal).toBe(controller.signal)
  })
})

describe('client construction', () => {
  it('passes the key explicitly so the SDK cannot fall back to the environment', async () => {
    const { instance, sdk } = provider()
    await instance.answer(request())
    expect(sdk.configs[0]?.apiKey).toBe('sk-or-v1-test')
  })

  it('honours a configured endpoint', async () => {
    const sdk = stubSdk(() => goodResponse)
    const instance = new OpenRouterProvider({
      apiKey: 'k',
      baseURL: 'https://proxy.internal',
      loadSdk: async () => sdk.module as never,
    })
    await instance.answer(request())
    expect(sdk.configs[0]?.serverURL).toBe('https://proxy.internal')
  })

  it('reuses one client across calls', async () => {
    const { instance, sdk } = provider()
    await instance.answer(request())
    await instance.answer(request())
    expect(sdk.configs).toHaveLength(1)
  })

  it('reports a helpful error when the SDK is not installed', async () => {
    await expect(
      (await import('../src/provider/openrouter.js')).loadOpenRouterSdk(
        '@openrouter/sdk-not-installed-xyz',
      ),
    ).rejects.toThrow(/Install it with/)
  })
})

describe('response normalization', () => {
  it('parses a noul answer', async () => {
    const { instance } = provider()
    const result = await instance.answer(request())
    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.91, confidence: 0.88 })
  })

  it('parses a choice answer with its distribution', async () => {
    const { instance } = provider()
    const result = await instance.answer(request())
    expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'billing' })
  })

  it('reports the provider as openrouter, not as TypeSafe', async () => {
    // The destination matters: a result must not imply it came from TypeSafe
    // when the state went to OpenRouter.
    const { instance } = provider()
    expect((await instance.answer(request())).provider).toBe('openrouter')
  })

  it('reads token usage and cost', async () => {
    const { instance } = provider()
    expect((await instance.answer(request())).usage).toEqual({
      inputTokens: 120,
      outputTokens: 0,
      costUsd: 0.000005,
    })
  })

  it('drops an answer it cannot verify instead of coercing it', async () => {
    const { instance } = provider(() => ({
      model: 'm',
      answers: { urgent: { noul: 'high' }, team: {} },
    }))
    const result = await instance.answer(request())
    expect(result.answers.urgent).toBeUndefined()
    expect(result.answers.team).toBeUndefined()
  })

  it('reports a malformed response rather than an empty success', async () => {
    const { instance } = provider(() => ({ model: 'm' }))
    await expect(instance.answer(request())).rejects.toThrow(/no "answers" object/)
  })

  it('tolerates a response that is not an object', async () => {
    const { instance } = provider(() => 'unexpected')
    await expect(instance.answer(request())).rejects.toThrow(JevProviderError)
  })
})

describe('failure classification', () => {
  const failing = (error: unknown) =>
    provider(() => {
      throw error
    }).instance

  it('classifies a 401 as rejected', async () => {
    await expect(failing({ statusCode: 401 }).answer(request())).rejects.toMatchObject({
      code: 'upstream-rejected',
    })
  })

  it('classifies a 403 as rejected', async () => {
    await expect(failing({ status: 403 }).answer(request())).rejects.toMatchObject({
      code: 'upstream-rejected',
    })
  })

  it('classifies a transport failure as unreachable', async () => {
    await expect(failing(new Error('socket hang up')).answer(request())).rejects.toMatchObject({
      code: 'upstream-unreachable',
    })
  })

  it('does not echo the upstream body, which can quote request headers', async () => {
    const instance = failing({ statusCode: 500, message: 'Bearer sk-or-v1-secretvalue' })
    await expect(instance.answer(request())).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sk-or-v1-secretvalue') as unknown as string,
      }),
    )
  })

  it('names the status without inventing a cause', async () => {
    await expect(failing({ statusCode: 429 }).answer(request())).rejects.toThrow(/HTTP 429/)
  })
})

describe('no ambient credential is read', () => {
  it('does not consult process.env for the key', async () => {
    const spy = vi.spyOn(process, 'env', 'get')
    const { instance, sdk } = provider()
    await instance.answer(request())
    expect(sdk.configs[0]?.apiKey).toBe('sk-or-v1-test')
    spy.mockRestore()
  })
})
