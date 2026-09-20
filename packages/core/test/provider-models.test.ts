/**
 * The model catalogue and the alias-drift check.
 *
 * Two operator questions, and the two different mechanisms that answer them —
 * the distinction this file exists to hold in place:
 *
 *  - "what can I send?" — `GET /v1/models`, reached through the SDK's own
 *    `client.models.list()` (`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:232-237`),
 *    which "returns the names your account can send in the `model` field... It
 *    currently lists the aliases." (https://docs.typesafe.ai/models).
 *  - "where does `jev-latest` point?" — the `model` field of a real answer,
 *    which "reports the versioned ID that answered" (same page). A catalogue
 *    cannot answer this, and anything that claimed to would be inferring.
 *
 * Every test here stubs the transport, following the pattern in
 * `provider.live.test.ts`: no key, no socket, no quota. The SDK itself is never
 * imported, because it is an *optional* dependency — a runtime import would make
 * this suite fail on an install that legitimately does not have it.
 */

import { describe, expect, it } from 'vitest'
import {
  checkAliasDrift,
  listModels,
  probeAlias,
  readModelCards,
  resolveAliasFromAnswer,
} from '../src/provider/models.js'
import { DEFAULT_MODEL } from '../src/provider/live.js'
import { JevProviderError } from '../src/types.js'
import { noul } from '../src/primitives.js'

/** The wire shape documented at https://docs.typesafe.ai/models. */
const catalogue = {
  models: [
    {
      name: 'jev-latest',
      description: 'The most recent stable release',
      release_date: '2025-01-01',
    },
    { name: 'jev-preview', description: 'The most recent release', release_date: '2025-01-01' },
    { name: 'jev-1.13.0', description: 'Jev 1.13', release_date: '2025-01-01' },
  ],
}

interface StubCall {
  readonly config: Record<string, unknown>
  readonly request: Record<string, unknown>
  readonly options: Record<string, unknown> | undefined
}

/**
 * A stub of the official SDK, with both capabilities this module uses.
 *
 * `models.list()` is what the real SDK resolves to a `ModelCard[]` — it unwraps
 * the `{ models: [...] }` envelope itself (`dist/index.mjs:365-371`) — so the
 * stub is given the array, and one test below drives the un-unwrapped envelope
 * through a transport that does not unwrap.
 */
const stubSdk = (options: {
  models?: unknown
  listThrows?: unknown
  answer?: unknown
  answerThrows?: unknown
}) => {
  const calls: StubCall[] = []
  const configs: Record<string, unknown>[] = []
  const listCalls: (Record<string, unknown> | undefined)[] = []
  class StubClient {
    readonly config: Record<string, unknown>
    constructor(config: Record<string, unknown>) {
      this.config = config
      configs.push(config)
    }
    readonly models = {
      list: (callOptions?: Record<string, unknown>) => {
        listCalls.push(callOptions)
        if (options.listThrows !== undefined) return Promise.reject(options.listThrows)
        return Promise.resolve(options.models)
      },
    }
    systemOne(
      request: Record<string, unknown>,
      callOptions?: Record<string, unknown>,
    ): Promise<unknown> {
      calls.push({ config: this.config, request, options: callOptions })
      if (options.answerThrows !== undefined) return Promise.reject(options.answerThrows)
      return Promise.resolve(options.answer)
    }
  }
  return { module: { TypeSafeClient: StubClient as never }, calls, configs, listCalls }
}

describe('reading a catalogue payload', () => {
  it('reads the documented { models: [...] } envelope', () => {
    const cards = readModelCards(catalogue)
    expect(cards.map((card) => card.name)).toEqual(['jev-latest', 'jev-preview', 'jev-1.13.0'])
    expect(cards[0]?.releaseDate).toBe('2025-01-01')
  })

  it('reads the bare array the SDK hands back after unwrapping', () => {
    expect(readModelCards(catalogue.models)).toHaveLength(3)
  })

  it('reads a camelCase release date too, rather than reporting none', () => {
    // Reading the wrong spelling does not throw; it silently reports no release
    // date, which is the failure mode `readUsage` in live.ts already guards.
    expect(readModelCards([{ name: 'a', releaseDate: '2025-02-02' }])[0]?.releaseDate).toBe(
      '2025-02-02',
    )
  })

  it('drops an entry with no usable name instead of keeping a placeholder', () => {
    // A card named "" would make a drift check compare against nothing while
    // looking like it had compared against something.
    const cards = readModelCards([{ description: 'nameless' }, { name: 'ok' }, { name: '' }, 7])
    expect(cards).toEqual([{ name: 'ok' }])
  })

  it('reads a payload of neither shape as no models, leaving the judgement to listModels', () => {
    expect(readModelCards({ unexpected: true })).toEqual([])
    expect(readModelCards(undefined)).toEqual([])
  })
})

describe('listing the catalogue through the SDK', () => {
  it('returns the models the endpoint offers', async () => {
    const sdk = stubSdk({ models: catalogue.models })
    const cards = await listModels({ apiKey: 'k', loadSdk: async () => sdk.module })
    expect(cards.map((card) => card.name)).toContain(DEFAULT_MODEL)
  })

  it('passes the key and log level explicitly, like every other route', async () => {
    const sdk = stubSdk({ models: catalogue.models })
    await listModels({ apiKey: 'ts_live_key', loadSdk: async () => sdk.module })
    // The client is constructed by the same builder the providers use, so an
    // ambient TYPESAFE_API_KEY or TYPESAFE_LOG_LEVEL cannot reach it.
    expect(sdk.configs[0]?.apiKey).toBe('ts_live_key')
    expect(sdk.configs[0]?.logLevel).toBe('warn')
    expect(sdk.configs[0]?.dangerouslyAllowBrowser).toBe(false)
  })

  it('clamps debug so a catalogue listing cannot log bodies either', async () => {
    const captured: { config?: Record<string, unknown> } = {}
    const stub = {
      TypeSafeClient: class {
        constructor(config: Record<string, unknown>) {
          captured.config = config
        }
        readonly models = { list: async () => catalogue.models }
      },
    }
    await listModels({ apiKey: 'k', logLevel: 'debug', loadSdk: async () => stub as never })
    expect(captured.config?.logLevel).toBe('info')
    expect(captured.config?.apiKey).toBe('k')
  })

  it('reports an unshaped payload rather than an empty catalogue', async () => {
    // "I could not ask" and "the answer is nothing" are different facts, and an
    // empty array would be read as the second.
    const sdk = stubSdk({ models: { unexpected: true } })
    const listing = listModels({ apiKey: 'k', loadSdk: async () => sdk.module })
    await expect(listing).rejects.toMatchObject({ code: 'malformed-response' })
  })

  it('accepts an empty catalogue, which is an answer', async () => {
    const sdk = stubSdk({ models: [] })
    expect(await listModels({ apiKey: 'k', loadSdk: async () => sdk.module })).toEqual([])
  })

  it('classifies a transport failure with the shared classifier', async () => {
    const sdk = stubSdk({ listThrows: { status: 401 } })
    const listing = listModels({ apiKey: 'k', loadSdk: async () => sdk.module })
    await expect(listing).rejects.toMatchObject({ code: 'upstream-rejected', status: 401 })
  })

  it('reports a transport with no catalogue instead of pretending it is empty', async () => {
    const stub = { TypeSafeClient: class {} }
    await expect(
      listModels({ apiKey: 'k', loadSdk: async () => stub as never }),
    ).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('reports a client that cannot be built as unavailable, not as unreachable', async () => {
    // The SDK's constructor throws for a missing key or a runtime with no
    // global `fetch`. Classifying that as a transport failure would report a
    // network fault for a configuration problem.
    const stub = {
      TypeSafeClient: class {
        constructor() {
          throw new Error('No API key was provided.')
        }
      },
    }
    const failure = await listModels({ apiKey: 'k', loadSdk: async () => stub as never }).then(
      () => {
        throw new Error('the listing resolved, so there was no failure to inspect')
      },
      (error: unknown) => error as JevProviderError,
    )
    expect(failure.code).toBe('provider-unavailable')
    // The SDK's own words are attached as the cause, never echoed into a message
    // this package would log.
    expect(failure.message).not.toContain('No API key was provided')
    expect((failure.cause as Error).message).toBe('No API key was provided.')
  })

  it('refuses an endpoint that would send the key in cleartext', async () => {
    const sdk = stubSdk({ models: catalogue.models })
    await expect(
      listModels({
        apiKey: 'k',
        baseURL: 'http://api.typesafe.ai',
        loadSdk: async () => sdk.module,
      }),
    ).rejects.toThrow(/must use https/)
  })

  it('cancels the listing through the armed budget, like any other call', async () => {
    const sdk = stubSdk({ models: catalogue.models })
    const controller = new AbortController()
    await listModels({ apiKey: 'k', signal: controller.signal, loadSdk: async () => sdk.module })
    // A caller signal is forwarded, so a listing that hangs can be cancelled
    // rather than occupying a host process until the budget fires.
    const forwarded = sdk.listCalls[0]?.signal as AbortSignal | undefined
    expect(forwarded).toBeInstanceOf(AbortSignal)
    expect(forwarded?.aborted).toBe(false)
    controller.abort()
    expect(forwarded?.aborted).toBe(true)
  })
})

describe('recording what an alias resolved to', () => {
  it('records the model the answer named, with when it was seen', () => {
    const at = new Date('2025-06-01T09:14:00.000Z')
    const resolution = resolveAliasFromAnswer('jev-latest', { model: 'jev-1.13.0' }, at)
    expect(resolution).toEqual({
      alias: 'jev-latest',
      model: 'jev-1.13.0',
      observedAt: '2025-06-01T09:14:00.000Z',
    })
  })

  it('refuses to record a resolution with no model in it', () => {
    expect(resolveAliasFromAnswer('jev-latest', { model: '' })).toBeUndefined()
    expect(resolveAliasFromAnswer('jev-latest', { model: '   ' })).toBeUndefined()
    expect(resolveAliasFromAnswer('', { model: 'jev-1.13.0' })).toBeUndefined()
  })
})

describe('alias drift is a measurement compared exactly', () => {
  const at = new Date('2025-06-01T09:14:00.000Z')
  const resolution = resolveAliasFromAnswer('jev-latest', { model: 'jev-1.13.0' }, at)

  it('reports alignment when the alias resolved to the pin', () => {
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-1.13.0', resolution })
    expect(drift.verdict).toBe('aligned')
    expect(drift.detail).toContain('2025-06-01T09:14:00.000Z')
  })

  it('reports drift when the alias resolved to something else', () => {
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-1.12.0', resolution })
    expect(drift.verdict).toBe('drifted')
    expect(drift.detail).toContain('jev-1.13.0')
    expect(drift.detail).toContain('jev-1.12.0')
  })

  it('reports what an alias points at when no pin was given', () => {
    const drift = checkAliasDrift({ alias: 'jev-latest', resolution })
    expect(drift.verdict).toBe('unpinned')
    expect(drift.resolution?.model).toBe('jev-1.13.0')
  })

  it('compares whole strings, with no normalisation', () => {
    // No prefix stripping, no semver ranges: no TypeSafe source documents those
    // spellings as equivalent, and inventing the equivalence is exactly how a
    // silent difference would be missed.
    for (const pin of ['jev-1.13', 'typesafe/jev-1.13.0', 'jev-1.13.0 ']) {
      expect(checkAliasDrift({ alias: 'jev-latest', pin, resolution }).verdict, pin).toBe('drifted')
    }
  })

  it('says unresolved rather than aligned when nothing has been observed', () => {
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-1.13.0' })
    expect(drift.verdict).toBe('unknown')
    // The reason matters: the catalogue cannot settle this, so a caller must not
    // read "unknown" as "go and list the models".
    expect(drift.detail).toContain('GET /v1/models')
  })

  it('refuses a resolution belonging to a different alias', () => {
    const other = resolveAliasFromAnswer('jev-preview', { model: 'jev-1.13.0' }, at)
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-1.13.0', resolution: other })
    expect(drift.verdict).toBe('unknown')
  })

  it('does not call it alignment when the endpoint named the alias itself', () => {
    // Possible whenever a response omits `model` and the provider falls back to
    // the requested name (`live.ts`), which is not a resolution at all.
    const named = resolveAliasFromAnswer('jev-latest', { model: 'jev-latest' }, at)
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-latest', resolution: named })
    expect(drift.verdict).toBe('unknown')
    expect(drift.detail).toContain('not a resolution')
  })

  it('refuses to compare a moving pin with itself', () => {
    const drift = checkAliasDrift({ alias: 'jev-latest', pin: 'jev-latest', resolution })
    expect(drift.verdict).toBe('unknown')
    expect(drift.detail).toContain('Pin a versioned id')
  })
})

describe('probing an alias with a real call', () => {
  const question = { q: noul('is this a decision?') }

  it('sends the alias as the model and records what answered', async () => {
    const sdk = stubSdk({ answer: { model: 'jev-1.13.0', answers: {} } })
    const resolution = await probeAlias({
      apiKey: 'k',
      alias: 'jev-latest',
      state: 'x',
      questions: question,
      loadSdk: async () => sdk.module,
    })
    expect(sdk.calls[0]?.request.model).toBe('jev-latest')
    expect(resolution.model).toBe('jev-1.13.0')
    expect(resolution.alias).toBe('jev-latest')
  })

  it('feeds straight into a drift check, which is the point of it', async () => {
    const sdk = stubSdk({ answer: { model: 'jev-1.13.0', answers: {} } })
    const resolution = await probeAlias({
      apiKey: 'k',
      alias: 'jev-latest',
      state: 'x',
      questions: question,
      loadSdk: async () => sdk.module,
    })
    expect(checkAliasDrift({ alias: 'jev-latest', pin: 'jev-1.12.0', resolution }).verdict).toBe(
      'drifted',
    )
  })

  it('refuses to report a resolution when nothing named a versioned model', async () => {
    // The response omits `model`, so the provider falls back to the requested
    // name — which would make the probe look like it had resolved the alias to
    // itself. Failing loudly is the only honest option: the caller paid for a
    // call to learn the versioned id and did not get one.
    const sdk = stubSdk({ answer: { answers: {} } })
    const probe = probeAlias({
      apiKey: 'k',
      alias: 'jev-latest',
      state: 'x',
      questions: question,
      loadSdk: async () => sdk.module,
    })
    await expect(probe).rejects.toBeInstanceOf(JevProviderError)
    await expect(probe).rejects.toMatchObject({ code: 'malformed-response' })
    await expect(probe).rejects.toThrow(/naming "jev-latest" itself/)
  })

  it('classifies a probe failure like any other call', async () => {
    const sdk = stubSdk({ answerThrows: { status: 529 } })
    await expect(
      probeAlias({
        apiKey: 'k',
        alias: 'jev-latest',
        state: 'x',
        questions: question,
        loadSdk: async () => sdk.module,
      }),
    ).rejects.toMatchObject({ code: 'overloaded' })
  })
})
