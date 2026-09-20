import { describe, expect, it, vi } from 'vitest'
import { EGRESS_FEATURES, EgressContract, EgressDeniedError, type EgressFeature } from '../src/egress.js'
import { choice, noul } from '../src/primitives.js'
import { MockProvider } from '../src/provider/mock.js'
import { JevService } from '../src/service.js'
import { JevProviderError, type JevProvider, type JevResult } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

// The shipped default: an offline provider and no feature enabled.
const offlineContract = () =>
  new EgressContract({ transmitting: false, enabled: {} as Record<EgressFeature, boolean> }, 'none')
const liveContract = (enabled: Partial<Record<EgressFeature, boolean>> = {}) =>
  new EgressContract(
    { transmitting: true, enabled: { ...allOn(), ...enabled } },
    'https://api.typesafe.ai',
  )

/**
 * A service whose calls reach the provider. The provider is the mock unless a
 * test injects another, so "reaches the provider" still means "makes no
 * network call" — the egress contract governs permission, not transport.
 */
const service = (options: {
  provider?: JevProvider
  egress?: EgressContract
  model?: string
} = {}) =>
  new JevService({
    provider: options.provider ?? new MockProvider(),
    egress: options.egress ?? liveContract(),
    ...(options.model === undefined ? {} : { model: options.model }),
  })

/** A service with the shipped default posture: offline, so every call is denied. */
const offlineService = (provider?: JevProvider) =>
  new JevService({ provider: provider ?? new MockProvider(), egress: offlineContract() })

const questions = { urgent: noul('urgent?'), team: choice('team?', { a: null, b: null }) }

describe('the offline default', () => {
  it('denies every feature while offline, even ones marked enabled', async () => {
    const svc = offlineService()
    for (const feature of EGRESS_FEATURES) {
      await expect(svc.ask({ feature, state: 'x', questions })).rejects.toThrow(EgressDeniedError)
    }
  })

  it('reports itself as not transmitting', () => {
    expect(offlineService().transmitting).toBe(false)
  })

  it('never reaches the provider, so a mock answer cannot be mistaken for a call', async () => {
    const answer = vi.fn()
    const svc = offlineService({ id: 'spy', answer })
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })).rejects.toThrow(
      EgressDeniedError,
    )
    expect(answer).not.toHaveBeenCalled()
  })

  it('counts nothing as transmitted when a call is denied', async () => {
    const svc = offlineService()
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions }).catch(() => undefined)
    expect(svc.stats().transmitted).toBe(0)
    expect(svc.stats().calls).toBe(0)
  })
})

describe('a permitted call', () => {
  it('answers through the mock provider with no network', async () => {
    const result = await service().ask({ feature: 'tool:jev_ask', state: 'help', questions })
    expect(result.provider).toBe('mock')
    expect(Object.keys(result.answers).sort()).toEqual(['team', 'urgent'])
  })

  it('counts the call as transmitted', async () => {
    const svc = service()
    await svc.ask({ feature: 'tool:jev_ask', state: 'help', questions })
    expect(svc.stats().transmitted).toBe(1)
  })
})

describe('per-feature egress enforcement', () => {
  it('denies a feature the contract does not allow', async () => {
    const svc = new JevService({
      provider: new MockProvider(),
      egress: liveContract({ 'tool:jev_ask': false }),
    })
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })).rejects.toThrow(
      EgressDeniedError,
    )
  })

  it('allows one feature while denying another in the same contract', async () => {
    const svc = service({ egress: liveContract({ 'tool:jev_ask': false, 'gate:context': true }) })
    await expect(
      svc.ask({ feature: 'gate:context', state: 'x', questions }),
    ).resolves.toBeDefined()
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })).rejects.toThrow(
      EgressDeniedError,
    )
  })
})

describe('redaction happens before the provider sees anything', () => {
  it('redacts the state the provider receives', async () => {
    let seen: unknown
    const provider: JevProvider = {
      id: 'capture',
      answer: async (request): Promise<JevResult> => {
        seen = request.state
        return { model: 'm', provider: 'capture', latencyMs: 1, answers: {} }
      },
    }
    const svc = service({ provider })
    await svc.ask({
      feature: 'tool:jev_ask',
      state: { password: 'hunter2', note: 'sk-abcdefghijklmnopqrstuvwxyz' },
      questions,
    })
    const serialized = JSON.stringify(seen)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('reports what redaction removed', async () => {
    const svc = service({ egress: liveContract({ 'tool:jev_ask': true }) })
    await svc.ask({ feature: 'tool:jev_ask', state: { token: 'x' }, questions })
    const last = svc.stats().lastCall
    expect(last?.redactions).toBe(1)
    expect(last?.redactionRules).toContain('key-name')
  })
})

describe('statistics', () => {
  it('counts calls and records latency', async () => {
    const svc = service({ egress: liveContract({ 'tool:jev_ask': true }) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    const stats = svc.stats()
    expect(stats.calls).toBe(1)
    expect(stats.transmitted).toBe(1)
    expect(stats.failures).toBe(0)
  })

  it('records a failure and rethrows it', async () => {
    const provider: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('nope', 'upstream-rejected')
      },
    }
    const svc = service({ provider, egress: liveContract({ 'tool:jev_ask': true }) })
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })).rejects.toThrow('nope')
    const stats = svc.stats()
    expect(stats.failures).toBe(1)
    expect(stats.calls).toBe(0)
  })

  it('truncates a long failure message so a status surface cannot leak a payload', async () => {
    const provider: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new Error('x'.repeat(2_000))
      },
    }
    const svc = service({ provider, egress: liveContract({ 'tool:jev_ask': true }) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions }).catch(() => undefined)
    expect(svc.stats().lastCall?.error?.length).toBeLessThanOrEqual(300)
  })

  it('keeps its history bounded', async () => {
    const svc = new JevService({
      provider: new MockProvider(),
      egress: liveContract({ 'tool:jev_ask': true }),
      historyLimit: 3,
    })
    for (let index = 0; index < 10; index += 1) {
      await svc.ask({ feature: 'tool:jev_ask', state: index, questions })
    }
    expect(svc.recent()).toHaveLength(3)
  })

  it('accumulates usage reported by the provider', async () => {
    const provider: JevProvider = {
      id: 'metered',
      answer: async () => ({
        model: 'm',
        provider: 'metered',
        latencyMs: 5,
        answers: {},
        usage: { inputTokens: 100, costUsd: 0.001 },
      }),
    }
    const svc = service({ provider, egress: liveContract({ 'tool:jev_ask': true }) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    await svc.ask({ feature: 'tool:jev_ask', state: 'y', questions })
    expect(svc.stats().totalInputTokens).toBe(200)
    expect(svc.stats().totalCostUsd).toBeCloseTo(0.002)
  })

  it('exposes the egress contract for other plugins to inspect', () => {
    expect(offlineService().egress.reportLines().join('\n')).toContain('egress=OFF')
    expect(service().egress.reportLines().join('\n')).toContain('egress=ON')
  })
})

describe('cancellation', () => {
  it('forwards the signal to the provider', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const provider: JevProvider = {
      id: 'spy',
      answer: async (_request, signal): Promise<JevResult> => {
        received = signal
        return { model: 'm', provider: 'spy', latencyMs: 1, answers: {} }
      },
    }
    const svc = service({ provider, egress: liveContract({ 'tool:jev_ask': true }) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions, signal: controller.signal })
    expect(received).toBe(controller.signal)
  })
})

describe('the service never invents an answer', () => {
  it('propagates a provider failure instead of substituting a default', async () => {
    const provider: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('upstream down', 'upstream-unreachable')
      },
    }
    const svc = service({ provider, egress: liveContract({ 'tool:jev_ask': true }) })
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })).rejects.toThrow(
      /upstream down/,
    )
  })
})
