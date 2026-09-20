/**
 * Reading a noul answer: the three-band rule.
 *
 * A noul is a calibrated probability, not a decision. `renderAnswer` used to
 * force it into `noul >= 0.5 ? 'true' : 'false'`, which presents 0.51 as a settled
 * `true` and invites a caller to branch on what is effectively a coin toss.
 *
 * The official self-consistency cookbook gives the band explicitly:
 *
 *   `no` below `0.30`; `uncertain` from `0.30` through `0.70`, including both
 *   boundaries; `yes` above `0.70`.
 *
 * and says why: "probabilities 0.49 and 0.51 cause opposite actions even though
 * both express substantial uncertainty." The same page notes the band is
 * illustrative rather than calibrated, which is why the thresholds are parameters
 * here and not buried in the renderer.
 *
 * This is additive. The underlying probability is still reported unchanged, and a
 * caller who wants the old binary reading can compare `noul` themselves — the
 * point is that the *default* reading stops inventing certainty.
 *
 * @see https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_NOUL_BAND, noulBand, renderAnswer } from '../src/render.js'
import type { NoulAnswer } from '../src/types.js'

const answer = (value: number): NoulAnswer => ({ type: 'noul', noul: value })

describe('noulBand', () => {
  it('uses the documented band', () => {
    expect(DEFAULT_NOUL_BAND).toEqual({ low: 0.3, high: 0.7 })
  })

  it('calls the ends no and yes', () => {
    expect(noulBand(0)).toBe('no')
    expect(noulBand(0.02)).toBe('no')
    expect(noulBand(0.99)).toBe('yes')
    expect(noulBand(1)).toBe('yes')
  })

  it('treats both boundaries as uncertain, as the cookbook says', () => {
    // "from 0.30 through 0.70, including both boundaries" — an off-by-one here
    // would reinstate exactly the knife-edge the band exists to remove.
    expect(noulBand(0.3)).toBe('uncertain')
    expect(noulBand(0.7)).toBe('uncertain')
  })

  it('makes 0.49 and 0.51 agree instead of opposing', () => {
    // The concrete failure the band prevents: these two used to render as
    // `false` and `true`, opposite decisions from near-identical evidence.
    expect(noulBand(0.49)).toBe('uncertain')
    expect(noulBand(0.51)).toBe('uncertain')
  })

  it('accepts an operator band', () => {
    expect(noulBand(0.5, { low: 0.2, high: 0.8 })).toBe('uncertain')
    expect(noulBand(0.85, { low: 0.2, high: 0.8 })).toBe('yes')
    expect(noulBand(0.15, { low: 0.2, high: 0.8 })).toBe('no')
  })

  it('refuses a band that cannot mean anything', () => {
    expect(() => noulBand(0.5, { low: 0.8, high: 0.2 })).toThrow(/low.*greater|inverted|ordered/i)
    expect(() => noulBand(0.5, { low: -0.1, high: 0.7 })).toThrow(/0 and 1|fraction/i)
    expect(() => noulBand(0.5, { low: 0.2, high: 1.4 })).toThrow(/0 and 1|fraction/i)
  })
})

describe('renderAnswer reports the band', () => {
  it('says uncertain rather than picking a side', () => {
    const rendered = renderAnswer('q', answer(0.51))
    expect(rendered.band).toBe('uncertain')
    // The old behaviour, kept visible so the change is legible.
    expect(rendered.answer).toBe('true')
  })

  it('still reports the probability unchanged', () => {
    const rendered = renderAnswer('q', answer(0.51))
    expect(rendered.noul).toBe(0.51)
    expect(rendered.probability).toBeCloseTo(0.51)
  })

  it('agrees with the binary reading when the answer is decisive', () => {
    expect(renderAnswer('q', answer(0.95)).band).toBe('yes')
    expect(renderAnswer('q', answer(0.95)).answer).toBe('true')
    expect(renderAnswer('q', answer(0.05)).band).toBe('no')
    expect(renderAnswer('q', answer(0.05)).answer).toBe('false')
  })
})
