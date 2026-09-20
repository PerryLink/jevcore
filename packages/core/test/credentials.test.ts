import { describe, expect, it } from 'vitest'
import { resolveApiKey, describeKeySource } from '../src/credentials.js'

const env = (values: Record<string, string | undefined>) => (name: string) => values[name]

describe('environment fallback', () => {
  it('reads the key from the environment', async () => {
    const result = await resolveApiKey({
      ref: 'TYPESAFE_API_KEY',
      env: env({ TYPESAFE_API_KEY: 'ts_live_fromenv' }),
    })
    expect(result).toEqual({ value: 'ts_live_fromenv', source: 'environment' })
  })

  it('trims surrounding whitespace', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      env: env({ K: '  spaced  ' }),
    })
    expect(result?.value).toBe('spaced')
  })

  it('treats a blank value as absent', async () => {
    expect(await resolveApiKey({ ref: 'K', env: env({ K: '   ' }) })).toBeUndefined()
    expect(await resolveApiKey({ ref: 'K', env: env({ K: '' }) })).toBeUndefined()
  })

  it('returns undefined rather than throwing when nothing has a key', async () => {
    expect(await resolveApiKey({ ref: 'K', env: env({}) })).toBeUndefined()
  })

  it('resolves lazily, so a key set after load is still found', async () => {
    const store: Record<string, string | undefined> = {}
    const lookup = (name: string) => store[name]
    expect(await resolveApiKey({ ref: 'K', env: lookup })).toBeUndefined()
    store.K = 'added-later'
    expect((await resolveApiKey({ ref: 'K', env: lookup }))?.value).toBe('added-later')
  })
})

describe('credential service precedence', () => {
  it('prefers the credential service over the environment', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      credentials: { resolve: async () => ({ value: 'from-store' }) },
      env: env({ K: 'from-env' }),
    })
    expect(result).toEqual({ value: 'from-store', source: 'credential' })
  })

  it('falls back to the environment when the store has nothing', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      credentials: { resolve: async () => undefined },
      env: env({ K: 'from-env' }),
    })
    expect(result?.source).toBe('environment')
  })

  it('falls back when the store returns an empty value', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      credentials: { resolve: async () => ({ value: '   ' }) },
      env: env({ K: 'from-env' }),
    })
    expect(result?.source).toBe('environment')
  })

  it('survives a credential provider that throws', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      credentials: {
        resolve: async () => {
          throw new Error('credential backend offline')
        },
      },
      env: env({ K: 'from-env' }),
    })
    expect(result?.value).toBe('from-env')
  })

  it('reports no source when a throwing provider is the only option', async () => {
    const result = await resolveApiKey({
      ref: 'K',
      credentials: {
        resolve: async () => {
          throw new Error('down')
        },
      },
      env: env({}),
    })
    expect(result).toBeUndefined()
  })
})

describe('describeKeySource', () => {
  it('names where a key came from without exposing it', async () => {
    expect(
      await describeKeySource({
        ref: 'K',
        credentials: { resolve: async () => ({ value: 'x' }) },
        env: env({}),
      }),
    ).toBe('credential')
    expect(await describeKeySource({ ref: 'K', env: env({ K: 'y' }) })).toBe('environment')
    expect(await describeKeySource({ ref: 'K', env: env({}) })).toBe('none')
  })

  it('never returns the key itself', async () => {
    const source = await describeKeySource({ ref: 'K', env: env({ K: 'ts_live_supersecret' }) })
    expect(source).not.toContain('ts_live_supersecret')
  })
})
