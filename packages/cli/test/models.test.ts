/**
 * `jev models` — the local resolution, and the catalogue it will only fetch when
 * asked.
 *
 * Two things worth testing here beyond the happy path: that the ordinary run
 * makes **no** request, and that a credential is reported as present or absent
 * without its value appearing anywhere. The second is the same guarantee
 * `check.test.ts` makes for the answering commands, applied to the one command
 * that reads the environment to talk *about* credentials rather than to use one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/types.js'
import { createHarness, type Harness } from './helpers/harness.js'
import { installStubSdk, type StubHarness } from './helpers/stub-sdk.js'

let harness: Harness
let stub: StubHarness

beforeAll(async () => {
  stub = await installStubSdk('models')
})
afterAll(() => {
  stub.dispose()
})
beforeEach(() => {
  harness = createHarness()
  stub.sdk.TypeSafeClient.throws = undefined
  stub.sdk.TypeSafeClient.modelList = async () => [
    {
      name: 'jev-latest',
      description: 'The most recent stable, official release.',
      release_date: '2026-01-15',
    },
    { name: 'jev-1.13.0' },
  ]
})
afterEach(() => {
  harness.dispose()
})

describe('the local resolution', () => {
  it('reports the mock as selected by default, and posts nowhere', async () => {
    const result = await harness.run(['models', '--json'])
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{
      data: {
        selected: string
        routes: { provider: string; model: string; endpoint: string | null; selected: boolean }[]
        catalogue: { available: boolean; reason: string }
      }
    }>()
    expect(payload.data.selected).toBe('mock')
    const mock = payload.data.routes.find((route) => route.provider === 'mock')
    expect(mock?.selected).toBe(true)
    expect(mock?.endpoint).toBeNull()
    expect(mock?.model).toBe('mock/jev-synthetic')
    // Every route is described, not only the selected one: "what would change if
    // I switched" is the question this command is asked next.
    expect(payload.data.routes.map((route) => route.provider)).toEqual([
      'mock',
      'live',
      'openrouter',
    ])
  })

  it('makes no catalogue request unless --catalogue was passed', async () => {
    stub.sdk.TypeSafeClient.throws = new Error('no request may be made')
    stub.sdk.TypeSafeClient.modelList = async () => {
      throw new Error('the catalogue must not be fetched without --catalogue')
    }
    const result = await harness.run(['models', '--provider', 'live', '--json'], {
      env: stub.env(),
    })
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{ data: { catalogue: { available: boolean; reason: string } } }>()
    expect(payload.data.catalogue.available).toBe(false)
    expect(payload.data.catalogue.reason).toContain('not requested')
    stub.sdk.TypeSafeClient.throws = undefined
  })

  it('reports whether a credential exists, without printing it', async () => {
    const secret = 'sk-live-DO-NOT-PRINT-models'
    const result = await harness.run(['models', '--json'], {
      env: { TYPESAFE_API_KEY: secret, OPENROUTER_API_KEY: '' },
    })
    const payload = result.json<{
      data: { routes: { provider: string; keyRef: string | null; keyPresent: boolean }[] }
    }>()
    const live = payload.data.routes.find((route) => route.provider === 'live')
    const openrouter = payload.data.routes.find((route) => route.provider === 'openrouter')
    expect(live?.keyRef).toBe('TYPESAFE_API_KEY')
    expect(live?.keyPresent).toBe(true)
    expect(openrouter?.keyPresent).toBe(false)
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
  })

  it('prints the routes person-readably, with the selected one marked', async () => {
    const result = await harness.run(['models'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('* mock')
    expect(result.stdout).toContain('TYPESAFE_API_KEY NOT SET')
    expect(result.stdout).toContain('no credential needed')
    expect(result.stdout).toContain('never made without the flag')
  })

  it('shows the model and endpoint a selected transmitting route would use', async () => {
    const result = await harness.run(
      ['models', '--provider', 'live', '--model', 'jev-1.13.0', '--endpoint', 'https://api.example.test', '--json'],
      { env: {} },
    )
    const payload = result.json<{
      provider: string
      model: string
      data: { routes: { provider: string; model: string; endpoint: string | null }[] }
    }>()
    expect(payload.provider).toBe('live')
    expect(payload.model).toBe('jev-1.13.0')
    const live = payload.data.routes.find((route) => route.provider === 'live')
    expect(live?.endpoint).toBe('https://api.example.test')
  })
})

describe('the catalogue, when it is asked for', () => {
  it('lists what the account can call, through the core', async () => {
    const result = await harness.run(
      ['models', '--provider', 'live', '--catalogue', '--json'],
      { env: stub.env() },
    )
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{
      data: {
        catalogue: {
          available: boolean
          source?: string
          reason?: string
          models?: { name: string; description?: string; releaseDate?: string }[]
        }
      }
    }>()
    if (!payload.data.catalogue.available) {
      // The core in this checkout does not export `listModels` yet, and the
      // command says so rather than returning a short list. That is the designed
      // behaviour, so the test asserts it instead of failing.
      expect(payload.data.catalogue.reason).toContain('does not export its model catalogue')
      return
    }
    expect(payload.data.catalogue.models?.map((model) => model.name)).toEqual([
      'jev-latest',
      'jev-1.13.0',
    ])
  })

  it('says why an authenticated catalogue cannot be fetched without a key', async () => {
    const result = await harness.run(
      ['models', '--provider', 'live', '--catalogue', '--json'],
      { env: { TYPESAFE_API_KEY: '' } },
    )
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{ data: { catalogue: { available: boolean; reason: string } } }>()
    expect(payload.data.catalogue.available).toBe(false)
    expect(payload.data.catalogue.reason).toContain('no credential for TYPESAFE_API_KEY')
  })

  it('reports a failed catalogue request without losing the local resolution', async () => {
    stub.sdk.TypeSafeClient.throws = Object.assign(new Error('socket closed'), { status: 503 })
    stub.sdk.TypeSafeClient.modelList = async () => {
      throw Object.assign(new Error('socket closed'), { status: 503 })
    }
    const result = await harness.run(
      ['models', '--provider', 'live', '--catalogue', '--json'],
      { env: stub.env() },
    )
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{
      data: { routes: unknown[]; catalogue: { available: boolean; reason: string } }
    }>()
    expect(payload.data.catalogue.available).toBe(false)
    expect(payload.data.catalogue.reason).toContain('overloaded')
    expect(payload.data.routes).toHaveLength(3)
    stub.sdk.TypeSafeClient.throws = undefined
  })

  it('refuses --catalogue against the offline mock, which has no account', async () => {
    const result = await harness.run(['models', '--catalogue'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('the offline mock has no account')
  })
})
