import { describe, expect, it, vi } from 'vitest'
import { EGRESS_FEATURES, EgressContract, EgressDeniedError, type EgressFeature } from '../src/egress.js'
import { choice, noul } from '../src/primitives.js'
import { LiveProvider, type SdkModule } from '../src/provider/live.js'
import { MockProvider } from '../src/provider/mock.js'
import { DEFAULT_ASK_MANY_CONCURRENCY, JevService, type JevCallRecord } from '../src/service.js'
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
  onRecord?: (record: JevCallRecord) => void
  historyLimit?: number
} = {}) =>
  new JevService({
    provider: options.provider ?? new MockProvider(),
    egress: options.egress ?? liveContract(),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.onRecord === undefined ? {} : { onRecord: options.onRecord }),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
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

describe('call records', () => {
  it('numbers records from 1 in append order', async () => {
    const svc = service()
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })
    await svc.ask({ feature: 'tool:jev_ask', state: 'b', questions })
    expect(svc.recent().map((record) => record.seq)).toEqual([1, 2])
  })

  it('keeps numbering monotonic across truncation, so seq is not an index', async () => {
    const svc = service({ historyLimit: 3 })
    for (let index = 0; index < 10; index += 1) {
      await svc.ask({ feature: 'tool:jev_ask', state: index, questions })
    }
    const records = svc.recent()
    // The survivors keep the numbers they were given: dropping the oldest record
    // must not renumber the rest, or two different calls would claim one seq.
    expect(records.map((record) => record.seq)).toEqual([8, 9, 10])
    expect(svc.stats().lastCall?.seq).toBe(10)
    expect(svc.stats().lastCall).toBe(records[2])
  })

  it('orders by seq, not by the start timestamp, when calls overlap', async () => {
    let releaseFirst: () => void = () => undefined
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const provider: JevProvider = {
      id: 'paced',
      answer: async (request) => {
        if (JSON.stringify(request.state) === '"first"') await firstMayFinish
        return { model: 'paced', provider: 'paced', latencyMs: 1, answers: {} }
      },
    }
    const svc = service({ provider })

    // `at` is stamped when the call starts, so start order is first, second.
    const first = svc.ask({ feature: 'tool:jev_ask', state: 'first', questions })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = svc.ask({ feature: 'tool:jev_ask', state: 'second', questions })
    await second
    releaseFirst()
    await first

    const records = svc.recent()
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    // The second call finished first, so it is recorded first — while its `at` is
    // the later one. That inversion is exactly why `at` cannot order a history.
    expect(records[0]?.at).toBeGreaterThan(records[1]?.at ?? 0)
  })

  it('hands out a frozen copy, so a caller cannot rewrite the history', async () => {
    const svc = service()
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })
    await svc.ask({ feature: 'tool:jev_ask', state: 'b', questions })
    const records = svc.recent()
    expect(Object.isFrozen(records)).toBe(true)
    // A copy every time, not the service's own array.
    expect(svc.recent()).not.toBe(records)

    const asMutable = records as JevCallRecord[]
    // Two records, so `reverse` has an index to write: on a one-element array it
    // is a no-op that touches nothing and would prove nothing here.
    expect(() => asMutable.reverse()).toThrow(TypeError)
    expect(() => asMutable.push(records[0] as JevCallRecord)).toThrow(TypeError)
    expect(svc.recent().map((record) => record.seq)).toEqual([1, 2])
  })

  it('freezes each record, so a handed-out reference cannot rewrite history either', async () => {
    const svc = service()
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })
    const record = svc.recent()[0]
    expect(record).toBeDefined()
    const asMutable = record as { ok: boolean }
    expect(() => {
      asMutable.ok = false
    }).toThrow(TypeError)
    expect(svc.recent()[0]?.ok).toBe(true)
  })
})

describe('cost honesty', () => {
  /**
   * A route that reports tokens but no cost, which is what the official TypeSafe
   * route does: `SystemOneResult.usage` is `{ input_tokens, output_tokens }` and
   * nothing else (@typesafe-ai/sdk 0.6.0 `dist/index.d.mts:121-126`).
   */
  const uncosted = (): JevProvider => ({
    id: 'uncosted',
    answer: async () => ({
      model: 'm',
      provider: 'uncosted',
      latencyMs: 3,
      answers: {},
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  })

  it('reports cost as unavailable when the route never reports one', async () => {
    const svc = service({ provider: uncosted() })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    const stats = svc.stats()
    // The trap being closed: calls were made, tokens were spent, and this is 0.
    expect(stats.calls).toBe(1)
    expect(stats.totalInputTokens).toBe(100)
    expect(stats.totalCostUsd).toBe(0)
    expect(stats.costAccounting).toBe('unavailable')
    expect(stats.callsWithoutCost).toBe(1)
  })

  it('claims nothing before a call has completed', () => {
    const stats = service().stats()
    expect(stats.calls).toBe(0)
    expect(stats.costAccounting).toBe('unavailable')
    expect(stats.callsWithoutCost).toBe(0)
  })

  it('reports cost as reported when every successful call carried one', async () => {
    const provider: JevProvider = {
      id: 'metered',
      answer: async () => ({
        model: 'm',
        provider: 'metered',
        latencyMs: 1,
        answers: {},
        usage: { inputTokens: 10, costUsd: 0.002 },
      }),
    }
    const svc = service({ provider })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    expect(svc.stats().costAccounting).toBe('reported')
    expect(svc.stats().callsWithoutCost).toBe(0)
    expect(svc.stats().totalCostUsd).toBeCloseTo(0.002)
  })

  it('treats a reported zero as reported, not as missing', async () => {
    // The mock sends `costUsd: 0` explicitly. Reading that as "did not report"
    // would be this same conflation in the opposite direction.
    const svc = service()
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    expect(svc.stats().costAccounting).toBe('reported')
    expect(svc.stats().callsWithoutCost).toBe(0)
  })

  it('turns unavailable as soon as one call reports no cost', async () => {
    let call = 0
    const provider: JevProvider = {
      id: 'intermittent',
      answer: async () => {
        call += 1
        return {
          model: 'm',
          provider: 'intermittent',
          latencyMs: 1,
          answers: {},
          ...(call === 1 ? { usage: { inputTokens: 1, costUsd: 0.001 } } : {}),
        }
      },
    }
    const svc = service({ provider })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    expect(svc.stats().costAccounting).toBe('reported')
    await svc.ask({ feature: 'tool:jev_ask', state: 'y', questions })
    const stats = svc.stats()
    // One silent call is enough: whatever the first reported, the sum is now a
    // lower bound and no longer spend.
    expect(stats.costAccounting).toBe('unavailable')
    expect(stats.callsWithoutCost).toBe(1)
    expect(stats.totalCostUsd).toBeCloseTo(0.001)
  })

  it('reports cost as unavailable for the documented TypeSafe response shape', async () => {
    // The published HTTP API reference's own example response: `usage` carries
    // `input_tokens` and `output_tokens` and nothing else, matching the SDK's
    // `SystemOneResult.usage` (@typesafe-ai/sdk 0.6.0 dist/index.d.mts:121-126).
    // This runs through the real LiveProvider parser rather than a hand-written
    // fake, so it is the production path that is being pinned — and it is the
    // canary if the official route ever starts reporting a cost.
    const sdk: SdkModule = {
      TypeSafeClient: class {
        systemOne(): Promise<unknown> {
          return Promise.resolve({
            model: 'jev-1.13.0',
            answers: { urgent: { type: 'noul', noul: 0.95 } },
            usage: { input_tokens: 296, output_tokens: 20 },
          })
        }
      },
    }
    const svc = service({
      provider: new LiveProvider({ apiKey: 'k', loadSdk: async () => sdk }),
    })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions })
    const stats = svc.stats()
    // Calls were made and tokens were spent. The cost total is 0 all the same.
    expect(stats.calls).toBe(1)
    expect(stats.totalInputTokens).toBe(296)
    expect(stats.totalCostUsd).toBe(0)
    expect(stats.costAccounting).toBe('unavailable')
    expect(stats.callsWithoutCost).toBe(1)
  })

  it('does not count a failed call as a call that withheld a cost', async () => {
    let call = 0
    const provider: JevProvider = {
      id: 'flaky',
      answer: async () => {
        call += 1
        if (call === 1) throw new JevProviderError('nope', 'upstream-unreachable')
        return { model: 'm', provider: 'flaky', latencyMs: 1, answers: {}, usage: { costUsd: 0.5 } }
      },
    }
    const svc = service({ provider })
    await svc.ask({ feature: 'tool:jev_ask', state: 'x', questions }).catch(() => undefined)
    await svc.ask({ feature: 'tool:jev_ask', state: 'y', questions })
    const stats = svc.stats()
    expect(stats.failures).toBe(1)
    expect(stats.callsWithoutCost).toBe(0)
    expect(stats.costAccounting).toBe('reported')
  })
})

describe('askMany', () => {
  /** A provider that records how many calls were ever in flight at once. */
  const countingProvider = (): { provider: JevProvider; peak: () => number } => {
    let inFlight = 0
    let peak = 0
    return {
      provider: {
        id: 'counting',
        answer: async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 1))
          inFlight -= 1
          return { model: 'm', provider: 'counting', latencyMs: 1, answers: {} }
        },
      },
      peak: () => peak,
    }
  }

  const inputsFor = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      feature: 'tool:jev_ask' as const,
      state: index,
      questions,
    }))

  it('bounds the default concurrency below the number of inputs', async () => {
    const { provider, peak } = countingProvider()
    const svc = service({ provider })
    const results = await svc.askMany(inputsFor(9))
    expect(results).toHaveLength(9)
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true)
    // A default that started everything at once would be a self-inflicted 429.
    expect(peak()).toBe(DEFAULT_ASK_MANY_CONCURRENCY)
  })

  it('never exceeds a caller-supplied concurrency', async () => {
    const { provider, peak } = countingProvider()
    const svc = service({ provider })
    const results = await svc.askMany(inputsFor(9), { concurrency: 3 })
    expect(results.map((entry) => entry.status)).toEqual(Array(9).fill('fulfilled'))
    expect(peak()).toBe(3)
  })

  it('clamps a non-positive concurrency instead of leaving the promise pending', async () => {
    const svc = service()
    // Zero workers would never settle; this test would time out rather than fail
    // if the clamp were missing.
    const results = await svc.askMany(inputsFor(2), { concurrency: 0 })
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('settles every input independently, in input order', async () => {
    const provider: JevProvider = {
      id: 'picky',
      answer: async (request) => {
        if (JSON.stringify(request.state) === '"boom"') {
          throw new JevProviderError('this one failed', 'upstream-rejected')
        }
        return { model: 'picky', provider: 'picky', latencyMs: 1, answers: {} }
      },
    }
    const svc = service({ provider })
    const results = await svc.askMany([
      { feature: 'tool:jev_ask', state: 'ok-1', questions },
      { feature: 'tool:jev_ask', state: 'boom', questions },
      { feature: 'tool:jev_ask', state: 'ok-2', questions },
    ])
    // One rejection in the middle must not cancel or reorder its neighbours.
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(svc.stats().calls).toBe(2)
    expect(svc.stats().failures).toBe(1)
  })

  it('reports a denied feature in its own slot rather than failing the batch', async () => {
    const svc = new JevService({
      provider: new MockProvider(),
      egress: liveContract({ 'tool:jev_ask': true, 'tool:jev_rank': false }),
    })
    const results = await svc.askMany([
      { feature: 'tool:jev_ask', state: 'a', questions },
      { feature: 'tool:jev_rank', state: 'b', questions },
    ])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('rejected')
    expect(svc.stats().transmitted).toBe(1)
  })

  it('returns nothing for nothing, without reaching the provider', async () => {
    const answer = vi.fn()
    const svc = service({ provider: { id: 'spy', answer } })
    expect(await svc.askMany([])).toEqual([])
    expect(answer).not.toHaveBeenCalled()
  })
})

describe('the onRecord observer', () => {
  it('sees each record after it is stored, newest last', async () => {
    const seen: JevCallRecord[] = []
    const svc = service({ onRecord: (record) => seen.push(record) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })
    await svc.ask({ feature: 'tool:jev_ask', state: 'b', questions })
    expect(seen.map((record) => record.seq)).toEqual([1, 2])
    // Stored before it is announced, and handed over as the same value: an
    // observer can never be shown a record the service itself does not report.
    expect(seen[1]).toBe(svc.stats().lastCall)
    expect(seen[0]).toBe(svc.recent()[0])
  })

  it('sees counters that already include the record it is handed', async () => {
    const snapshots: number[] = []
    const svc = service({ onRecord: () => snapshots.push(svc.stats().calls) })
    // An observer that read counters one behind would report a lagging number
    // forever, which is the same class of quiet wrongness as a cost total that
    // silently means "unknown".
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })
    await svc.ask({ feature: 'tool:jev_ask', state: 'b', questions })
    expect(snapshots).toEqual([1, 2])
  })

  it('observes failures too', async () => {
    const seen: JevCallRecord[] = []
    const provider: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('nope', 'upstream-unreachable')
      },
    }
    const svc = service({ provider, onRecord: (record) => seen.push(record) })
    await svc.ask({ feature: 'tool:jev_ask', state: 'a', questions }).catch(() => undefined)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.ok).toBe(false)
    expect(seen[0]?.error).toContain('nope')
  })

  it('never fails the call it observes', async () => {
    const svc = service({
      onRecord: () => {
        throw new Error('observer exploded')
      },
    })
    await expect(
      svc.ask({ feature: 'tool:jev_ask', state: 'a', questions }),
    ).resolves.toBeDefined()
    const stats = svc.stats()
    // The observer's throw is dropped, and it is not a Jev failure either: the
    // call succeeded, and counting the observer against it would report a broken
    // provider where there is only a broken dashboard.
    expect(stats.failures).toBe(0)
    expect(stats.calls).toBe(1)
    expect(stats.lastCall?.ok).toBe(true)
    expect(svc.recent()).toHaveLength(1)
  })

  it('does not replace the provider failure it is observing', async () => {
    const provider: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('the real reason', 'upstream-unreachable')
      },
    }
    const svc = service({
      provider,
      onRecord: () => {
        throw new Error('observer exploded')
      },
    })
    // The caller learns why the call failed, not why the observer did.
    await expect(svc.ask({ feature: 'tool:jev_ask', state: 'a', questions })).rejects.toThrow(
      /the real reason/,
    )
    expect(svc.stats().failures).toBe(1)
  })
})
