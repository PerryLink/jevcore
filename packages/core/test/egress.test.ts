import { describe, expect, it, vi } from 'vitest'
import {
  EGRESS_FEATURES,
  EGRESS_FIELDS,
  EgressContract,
  EgressDeniedError,
  type EgressFeature,
} from '../src/egress.js'
import { noul } from '../src/primitives.js'
import { redact } from '../src/redact.js'

const everyFeatureOff = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, false])) as Record<
    EgressFeature,
    boolean
  >

const everyFeatureOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<
    EgressFeature,
    boolean
  >

// Offline means two independent things: the provider cannot reach the
// network, and no feature is enabled. Both are asserted separately below.
const offline = () =>
  new EgressContract({ transmitting: false, enabled: everyFeatureOff() }, 'none')

const live = (enabled: Record<EgressFeature, boolean>, endpoint = 'https://api.typesafe.ai') =>
  new EgressContract({ transmitting: true, enabled }, endpoint)

describe('default posture', () => {
  it('reports that an offline provider cannot reach the network', () => {
    // `transmitting` is a fact about the provider, reported to the operator;
    // the mock never opens a socket whatever the feature switches say.
    expect(offline().reportLines().join('\n')).toContain('egress=OFF')
  })

  it('marks an enabled feature as armed rather than transmitting while offline', () => {
    // The real case: a feature switched on in config while the provider is
    // still the offline mock. The report must not claim it is sending.
    const contract = new EgressContract(
      { transmitting: false, enabled: { ...everyFeatureOff(), 'gate:safety': true } },
      'none',
    )
    const report = contract.reportLines().join('\n')
    expect(report).toContain('armed')
    expect(report).toContain('gate:safety')
    expect(report).not.toContain('SENDS')
  })

  it('transmits nothing when every feature is off', () => {
    const contract = live(everyFeatureOff())
    for (const feature of EGRESS_FEATURES) {
      expect(contract.allows(feature)).toBe(false)
    }
  })

  it('says plainly that no network call will be made', () => {
    const report = offline().reportLines().join('\n')
    expect(report).toContain('egress=OFF')
    expect(report).toContain('no network calls will be made')
  })
})

describe('per-feature gating', () => {
  it('allows only the enabled feature', () => {
    const contract = live({ ...everyFeatureOff(), 'tool:jev_ask': true })
    expect(contract.allows('tool:jev_ask')).toBe(true)
    expect(contract.allows('gate:safety')).toBe(false)
    expect(contract.allows('gate:context')).toBe(false)
  })

  it('refuses to measure a disabled feature', () => {
    const contract = live(everyFeatureOff())
    expect(() =>
      contract.measure({
        feature: 'gate:context',
        state: 'anything',
        questions: { q: noul('ok?') },
        redact,
      }),
    ).toThrow(EgressDeniedError)
  })

  it('names the refused feature in the error', () => {
    const contract = live(everyFeatureOff())
    try {
      contract.assert('gate:safety')
      throw new Error('expected assert to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(EgressDeniedError)
      expect((error as EgressDeniedError).feature).toBe('gate:safety')
      expect((error as Error).message).toContain('gate:safety')
    }
  })
})

describe('the startup report', () => {
  it('marks every feature off when none are enabled', () => {
    const report = live(everyFeatureOff()).reportLines().join('\n')
    for (const feature of EGRESS_FEATURES) {
      expect(report).toContain(`off    ${feature}`)
    }
    expect(report).not.toContain('SENDS')
  })

  it('lists the fields and caps for each enabled feature', () => {
    const report = live({ ...everyFeatureOff(), 'gate:context': true }).reportLines().join('\n')
    expect(report).toContain('SENDS  gate:context')
    expect(report).toContain('state<=6000c')
  })

  it('states the redaction limitation instead of implying a guarantee', () => {
    const report = live({ ...everyFeatureOff(), 'tool:jev_ask': true }).reportLines().join('\n')
    expect(report).toContain('best-effort')
  })
})

describe('measurement', () => {
  const contract = live(everyFeatureOn())

  it('redacts before measuring, so reported sizes are the transmitted sizes', () => {
    const payload = contract.measure({
      feature: 'tool:jev_ask',
      state: { password: 'hunter2', note: 'hello' },
      questions: { q: noul('ok?') },
      redact,
    })
    expect(JSON.stringify(payload.state)).not.toContain('hunter2')
    expect(payload.redactions).toBe(1)
    expect(payload.redactionRules).toContain('key-name')
  })

  it('caps an oversized state into something still valid JSON', () => {
    const huge = 'x'.repeat(50_000)
    const payload = contract.measure({
      feature: 'tool:jev_ask',
      state: { body: huge },
      questions: { q: noul('ok?') },
      redact,
    })
    expect(payload.truncated).toBe(true)
    expect(payload.stateChars).toBeLessThanOrEqual(EGRESS_FIELDS['tool:jev_ask'][0]!.maxChars + 200)
    // The cap must not produce a document Jev cannot parse.
    expect(() => JSON.parse(JSON.stringify(payload.state))).not.toThrow()
    expect(payload.state).toMatchObject({ '[truncated]': true })
  })

  it('does not mark a small payload as truncated', () => {
    const payload = contract.measure({
      feature: 'tool:jev_check',
      state: { claim: 'a', evidence: 'b' },
      questions: { q: noul('ok?') },
      redact,
    })
    expect(payload.truncated).toBe(false)
  })

  it('declares fields for every feature', () => {
    for (const feature of EGRESS_FEATURES) {
      expect(EGRESS_FIELDS[feature].length).toBeGreaterThan(0)
      for (const field of EGRESS_FIELDS[feature]) {
        expect(field.maxChars).toBeGreaterThan(0)
        expect(field.carries.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('no implicit egress', () => {
  it('does not touch global fetch while constructing or measuring offline', () => {
    // The plugin's central promise is that the default path makes no network
    // call. Any accidental fetch on this path trips this spy.
    const spy = vi.fn(() => {
      throw new Error('offline path must not call fetch')
    })
    const original = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const contract = offline()
      contract.reportLines()
      expect(contract.allows('tool:jev_ask')).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})
