import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

describe('defaults are the security posture', () => {
  it('defaults to the offline mock provider', () => {
    expect(DEFAULT_CONFIG.provider).toBe('mock')
    expect(resolveConfig(undefined).provider).toBe('mock')
    expect(resolveConfig({}).provider).toBe('mock')
  })

  it('defaults both gates to disabled', () => {
    const config = resolveConfig({})
    expect(config.gates.safety.enabled).toBe(false)
    expect(config.gates.context.enabled).toBe(false)
  })

  it('keeps a confidence floor above a coin flip', () => {
    expect(resolveConfig({}).minConfidence).toBeGreaterThan(0.5)
    expect(resolveConfig({}).minProbability).toBeGreaterThan(0.5)
  })

  it('names a credential reference rather than holding a key', () => {
    const config = resolveConfig({})
    expect(config.apiKeyRef).toBe('TYPESAFE_API_KEY')
    expect(JSON.stringify(config)).not.toMatch(/ts_live_|sk-/)
  })

  it('has no baseURL until one is set', () => {
    expect(resolveConfig({}).baseURL).toBeUndefined()
  })
})

describe('validation', () => {
  it('accepts a full valid configuration', () => {
    const config = resolveConfig({
      provider: 'live',
      apiKeyRef: 'MY_KEY',
      baseURL: 'https://api.typesafe.ai',
      model: 'jev-1.13.0',
      logLevel: 'info',
      minConfidence: 0.9,
      minProbability: 0.8,
      gates: { safety: { enabled: true, onUndecided: 'deny' } },
    })
    expect(config.provider).toBe('live')
    expect(config.model).toBe('jev-1.13.0')
    expect(config.gates.safety).toEqual({ enabled: true, onUndecided: 'deny' })
    // An unspecified gate keeps its own default rather than inheriting the other's.
    expect(config.gates.context.enabled).toBe(false)
  })

  it('rejects an unknown provider', () => {
    expect(() => resolveConfig({ provider: 'openai' as never })).toThrow(ConfigError)
    expect(() => resolveConfig({ provider: 'openai' as never })).toThrow(/must be "mock" or "live"/)
  })

  it('rejects an out-of-range confidence floor', () => {
    expect(() => resolveConfig({ minConfidence: 1.5 })).toThrow(/between 0 and 1/)
    expect(() => resolveConfig({ minConfidence: -0.1 })).toThrow(/between 0 and 1/)
    expect(() => resolveConfig({ minProbability: Number.NaN })).toThrow(/between 0 and 1/)
  })

  it('accepts a bare boolean as gate shorthand', () => {
    // A patch file most naturally writes `safety: false`, so accept it rather
    // than throwing at load.
    expect(resolveConfig({ gates: { safety: false } }).gates.safety.enabled).toBe(false)
    expect(resolveConfig({ gates: { safety: true } }).gates.safety.enabled).toBe(true)
    expect(resolveConfig({ gates: { safety: true } }).gates.safety.onUndecided).toBe('ask')
  })

  it('rejects a gate value that is neither object nor boolean', () => {
    expect(() => resolveConfig({ gates: { safety: 'yes' as never } })).toThrow(/object or a boolean/)
  })
  it('rejects a non-boolean gate switch', () => {
    expect(() => resolveConfig({ gates: { safety: { enabled: 'yes' as never } } })).toThrow(
      /must be a boolean/,
    )
  })

  it('rejects an unknown onUndecided policy', () => {
    expect(() => resolveConfig({ gates: { context: { onUndecided: 'maybe' as never } } })).toThrow(
      /must be "ask", "allow", or "deny"/,
    )
  })

  it('rejects an unknown log level', () => {
    expect(() => resolveConfig({ logLevel: 'verbose' as never })).toThrow(/silent, warn, info, or debug/)
  })

  it('rejects a negative maxStateChars', () => {
    expect(() => resolveConfig({ maxStateChars: -1 })).toThrow(/non-negative integer/)
    expect(() => resolveConfig({ maxStateChars: 1.5 })).toThrow(/non-negative integer/)
  })

  it('treats maxStateChars 0 as "use the feature default"', () => {
    expect(resolveConfig({ maxStateChars: 0 }).maxStateChars).toBeUndefined()
    expect(resolveConfig({ maxStateChars: 4096 }).maxStateChars).toBe(4096)
  })

  it('falls back for blank strings rather than accepting them', () => {
    const config = resolveConfig({ model: '   ', apiKeyRef: '', baseURL: '  ' })
    expect(config.model).toBe(DEFAULT_CONFIG.model)
    expect(config.apiKeyRef).toBe(DEFAULT_CONFIG.apiKeyRef)
    expect(config.baseURL).toBeUndefined()
  })
})
