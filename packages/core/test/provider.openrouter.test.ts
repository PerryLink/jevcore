import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterProvider,
  assertSystemOneModel,
  assertUsableOpenRouterEndpoint,
} from '../src/provider/openrouter.js'
import { DEFAULT_MODEL, loadOfficialSdk } from '../src/provider/live.js'
import { assertValidBatch, choice, noul } from '../src/primitives.js'
import { JevProviderError, type JevRequest } from '../src/types.js'

/**
 * A stub of the official SDK.
 *
 * This provider shares \`@typesafe-ai/sdk\` with the TypeSafe route -- only the
 * \`baseURL\` and the key differ -- so the stub is deliberately the same shape as the
 * one in \`provider.live.test.ts\`. That is the point of the design: the two routes
 * cannot drift on request shape or answer normalization if they run one client.
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

/** A provider over a stub, plus the calls it made. */
const provider = (respond: (request: Record<string, unknown>) => unknown = () => ({ answers: {} })) => {
  const sdk = stubSdk(respond)
  const instance = new OpenRouterProvider({
    apiKey: 'sk-or-v1-test',
    loadSdk: async () => sdk.module as never,
  })
  return { instance, calls: sdk.calls }
}

describe('endpoint', () => {
  it('is the documented System One path, not the alpha route', () => {
    const { instance } = provider()
    // OpenRouter serves System One at the same path TypeSafe does, one level below
    // its /api root. The alpha route this used to call is named alpha by
    // OpenRouter's own SDK.
    expect(DEFAULT_OPENROUTER_ENDPOINT).toBe('https://openrouter.ai/api')
    expect(instance.endpoint).toBe('https://openrouter.ai/api/v1/systemone')
  })

  it('refuses a cleartext endpoint away from loopback', () => {
    expect(() => assertUsableOpenRouterEndpoint('http://openrouter.ai/api')).toThrow(JevProviderError)
    expect(() => assertUsableOpenRouterEndpoint('http://127.0.0.1:8080')).not.toThrow()
    expect(() => assertUsableOpenRouterEndpoint('not a url')).toThrow(JevProviderError)
  })
})

describe('the model must be a System One model', () => {
  it('defaults to the same id the TypeSafe route uses', () => {
    // One default for both routes. They disagreed before: the guard rejected bare
    // ids, so the MCP runtime substituted a prefixed one while the DSH plugin
    // passed jev-latest through and threw at startup.
    expect(DEFAULT_OPENROUTER_MODEL).toBe(DEFAULT_MODEL)
    expect(DEFAULT_OPENROUTER_MODEL).toBe('jev-latest')
    expect(() => new OpenRouterProvider({ apiKey: 'k' })).not.toThrow()
  })

  it('accepts a bare id and a prefixed one, both verified live', () => {
    expect(assertSystemOneModel('jev-latest')).toBe('jev-latest')
    expect(assertSystemOneModel('jev-1.13')).toBe('jev-1.13')
    expect(assertSystemOneModel('typesafe/jev-1.13')).toBe('typesafe/jev-1.13')
  })

  it('refuses other families, which answer with prose', () => {
    for (const model of ['gpt-4o', 'claude-3', 'openai/gpt-4o', 'typesafe/other', 'meta/llama-3']) {
      expect(() => assertSystemOneModel(model), model).toThrow(JevProviderError)
    }
  })

  it('refuses an empty id rather than sending it', () => {
    expect(() => assertSystemOneModel('   ')).toThrow(/empty/)
  })

  it('applies the guard to a per-call override too', async () => {
    const { instance } = provider()
    await expect(instance.answer(request({ model: 'gpt-4o' }))).rejects.toThrow(JevProviderError)
  })
})

describe('the request is the same shape the TypeSafe route sends', () => {
  it('sends state, questions and model, with no OpenRouter-specific wrapper', async () => {
    // The old implementation wrapped the payload in decisionsRequest, a shape only
    // the alpha route wanted. The documented route takes the plain body.
    const { instance, calls } = provider()
    await instance.answer(request())
    expect(Object.keys(calls[0]?.request ?? {}).sort()).toEqual(['model', 'questions', 'state'])
    expect(calls[0]?.request).not.toHaveProperty('decisionsRequest')
  })

  it('sends the state and questions through unchanged', async () => {
    const { instance, calls } = provider()
    const sent = request()
    await instance.answer(sent)
    expect(calls[0]?.request.state).toEqual(sent.state)
    expect(calls[0]?.request.questions).toEqual(sent.questions)
  })

  it('lets a per-call model override the default', async () => {
    const { instance, calls } = provider()
    await instance.answer(request({ model: 'typesafe/jev-1.13' }))
    expect(calls[0]?.request.model).toBe('typesafe/jev-1.13')
  })

  it('forwards the abort signal', async () => {
    const { instance, calls } = provider()
    const controller = new AbortController()
    await instance.answer(request(), controller.signal)
    expect(calls[0]?.options).toEqual({ signal: controller.signal })
  })
})

describe('client construction', () => {
  it('points the SDK at OpenRouter and passes the key explicitly', async () => {
    const { instance, calls } = provider()
    await instance.answer(request())
    expect(calls[0]?.config.apiKey).toBe('sk-or-v1-test')
    expect(calls[0]?.config.baseURL).toBe(DEFAULT_OPENROUTER_ENDPOINT)
    // Never left to the environment: the SDK would otherwise read TYPESAFE_API_KEY.
    expect(calls[0]?.config.dangerouslyAllowBrowser).toBe(false)
  })

  it('passes logLevel, so the environment cannot raise it', async () => {
    const { instance, calls } = provider()
    await instance.answer(request())
    // The SDK's debug level logs request bodies with credential headers redacted
    // but bodies not, which would defeat this package's redaction.
    expect(calls[0]?.config).toHaveProperty('logLevel')
    expect(calls[0]?.config.logLevel).toBe('warn')
  })

  it('honours a configured endpoint and strips a trailing slash', async () => {
    const sdk = stubSdk(() => ({ answers: {} }))
    const instance = new OpenRouterProvider({
      apiKey: 'k',
      baseURL: 'https://openrouter.ai/api/',
      loadSdk: async () => sdk.module as never,
    })
    await instance.answer(request())
    // Left on, the SDK would build //v1/systemone.
    expect(sdk.calls[0]?.config.baseURL).toBe('https://openrouter.ai/api')
  })

  it('reuses one client across calls', async () => {
    const { instance, calls } = provider()
    await instance.answer(request())
    await instance.answer(request())
    expect(calls).toHaveLength(2)
    expect(calls[0]?.config).toBe(calls[1]?.config)
  })

  it('names the SDK to install when it is missing', async () => {
    await expect(loadOfficialSdk('@typesafe-ai/sdk-does-not-exist')).rejects.toThrow(/npm install/)
  })
})

describe('response normalization', () => {
  it('parses a noul answer, which carries no confidence', async () => {
    const { instance } = provider(() => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: { urgent: { type: 'noul', noul: 0.91 } },
    }))
    const result = await instance.answer(request())
    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.91 })
    expect(result.model).toBe('typesafe/jev-1.13-20260917')
    expect(result.provider).toBe('openrouter')
  })

  it('parses a choice answer with its distribution', async () => {
    const { instance } = provider(() => ({
      answers: {
        team: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.7, technical: 0.3 },
          confidence: 0.9,
        },
      },
    }))
    const result = await instance.answer(request())
    expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'billing', confidence: 0.9 })
  })

  it('reads usage from the wire spelling, and the cost OpenRouter adds', async () => {
    // The wire shape is snake_case while the SDK type is camelCase, and reading the
    // wrong one reports no usage rather than failing. OpenRouter additionally
    // returns a cost, which TypeSafe's own route does not.
    const { instance } = provider(() => ({
      answers: {},
      usage: { input_tokens: 275, output_tokens: 20, cost: 0.00001155 },
    }))
    const result = await instance.answer(request())
    expect(result.usage).toEqual({ inputTokens: 275, outputTokens: 20, costUsd: 0.00001155 })
  })

  it('refuses a response with no answers object', async () => {
    const { instance } = provider(() => ({ model: 'm' }))
    await expect(instance.answer(request())).rejects.toThrow(/no "answers"/)
  })

  it('drops an answer whose shape does not match the question', async () => {
    const { instance } = provider(() => ({ answers: { urgent: { type: 'noul', noul: 'high' } } }))
    const result = await instance.answer(request())
    expect(result.answers.urgent).toBeUndefined()
  })
})

describe('failure classification', () => {
  const failing = (error: unknown) =>
    new OpenRouterProvider({
      apiKey: 'k',
      loadSdk: async () =>
        ({
          TypeSafeClient: class {
            async systemOne(): Promise<unknown> {
              throw error
            }
          },
        }) as never,
    }).answer(request())

  it('reports a 401 as rejected', async () => {
    await expect(failing({ status: 401 })).rejects.toMatchObject({ code: 'upstream-rejected' })
  })

  it('reports a transport failure as unreachable', async () => {
    await expect(failing(new Error('socket hang up'))).rejects.toMatchObject({
      code: 'upstream-unreachable',
    })
  })

  it('never echoes the upstream body, which can quote request headers', async () => {
    const secret = 'sk-or-v1-should-never-appear'
    const error = (await failing(
      Object.assign(new Error('bad'), { status: 403, body: secret }),
    ).catch((caught: unknown) => caught)) as Error
    expect(error.message).not.toContain(secret)
  })
})

describe('question validation still applies on this route', () => {
  it('rejects a batch the API would reject', () => {
    expect(() => assertValidBatch({})).toThrow()
    expect(() => assertValidBatch({ q: choice('pick', { only: 'one' }) })).toThrow()
  })
})
