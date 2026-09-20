/**
 * `resolveCheck`: the verdict may not contradict the numbers printed beside it.
 *
 * Two defects, both reproduced against the published package before the fix, and
 * both visible in the resolver's own output shape:
 *
 *  1. **A missing answer bought support.**
 *     `resolveCheck({supports_claim: 0.95})` returned `supported`. The
 *     sufficiency guard read `sufficient !== undefined && sufficient <
 *     thresholds.sufficiency`, so an *unanswered* sufficiency question skipped
 *     the check entirely. Fail-open is the wrong direction here: a provider that
 *     returns fewer answers than were asked must not thereby earn a stronger
 *     verdict, and this package's own rendering rule says the opposite — "a
 *     missing answer is reported as missing; nothing is filled in".
 *
 *  2. **`insufficient` contradicted its own sufficiency probability.**
 *     `{supports: 0.0524, contradicts: 0.5173, sufficient: 0.9895}` returned
 *     `insufficient`, in a payload that also carried `sufficient: 0.9895`. One
 *     word was naming two different findings: "the evidence cannot settle this"
 *     and "the evidence settles it, but points nowhere". The second now has its
 *     own value, `undecided`.
 *
 * `unknown` keeps its meaning throughout: *no answer came back at all*. A missing
 * sufficiency answer is not that — support was measured, so there is a finding
 * about it, and the finding is `insufficient`.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHECK_THRESHOLDS,
  VERDICT_QUESTION,
  resolveCheck,
  type CheckVerdict,
  type JevResult,
} from '../src/index.js'

/** Build a result whose answers are the named nouls. */
const result = (answers: Record<string, number>): JevResult => ({
  model: 'fixed',
  provider: 'fixed',
  latencyMs: 1,
  answers: Object.fromEntries(
    Object.entries(answers).map(([id, noul]) => [id, { type: 'noul' as const, noul }]),
  ),
})

const S = VERDICT_QUESTION.supports
const C = VERDICT_QUESTION.contradicts
const E = VERDICT_QUESTION.sufficient

const verdictOf = (answers: Record<string, number>): CheckVerdict =>
  resolveCheck(result(answers)).verdict

describe('the three reproduced payloads', () => {
  it('fails closed when the sufficiency question went unanswered', () => {
    // Was `supported`. `supports: 0.95` alone is not evidence that the evidence
    // settles the claim — it is evidence that one of the three questions was
    // answered.
    expect(verdictOf({ [S]: 0.95 })).toBe('insufficient')
  })

  it('never says insufficient while its own sufficiency probability says otherwise', () => {
    // The analysis report's experiment C, exactly as observed.
    expect(verdictOf({ [S]: 0.0524, [C]: 0.5173, [E]: 0.9895 })).toBe('undecided')
  })

  it('still reports unknown only when nothing was answered', () => {
    expect(verdictOf({})).toBe('unknown')
    // A missing *sufficiency* answer is not "nothing was answered".
    expect(verdictOf({ [S]: 0.1 })).not.toBe('unknown')
    expect(verdictOf({ [C]: 0.1 })).not.toBe('unknown')
  })
})

describe('the precedence order', () => {
  it('reports support only when sufficiency backs it', () => {
    expect(verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.9 })).toBe('supported')
    expect(verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.1 })).toBe('insufficient')
    expect(verdictOf({ [S]: 0.9, [C]: 0.05 })).toBe('insufficient')
  })

  it('puts conflict above everything', () => {
    expect(verdictOf({ [S]: 0.9, [C]: 0.9, [E]: 0.9 })).toBe('conflicted')
    expect(verdictOf({ [S]: 0.9, [C]: 0.9, [E]: 0.1 })).toBe('conflicted')
  })

  it('puts a strong contradiction above weak evidence', () => {
    // "This is false" is more useful to a caller than "this is unsettled", so
    // contradiction is reported even when the evidence was judged unable to
    // settle the question.
    expect(verdictOf({ [S]: 0.1, [C]: 0.95, [E]: 0.1 })).toBe('contradicted')
    expect(verdictOf({ [S]: 0.1, [C]: 0.95, [E]: 0.9 })).toBe('contradicted')
    expect(verdictOf({ [C]: 0.95 })).toBe('contradicted')
  })

  it('distinguishes "the evidence settles nothing" from "the evidence settles it, inconclusively"', () => {
    // The distinction `undecided` was added for. Both have sufficient evidence
    // and neither side strong; both used to read `insufficient`.
    expect(verdictOf({ [S]: 0.4, [C]: 0.3, [E]: 0.9 })).toBe('undecided')
    expect(verdictOf({ [S]: 0.4, [C]: 0.3 })).toBe('insufficient')
    expect(verdictOf({ [S]: 0.4, [C]: 0.3, [E]: 0.1 })).toBe('insufficient')
  })

  it('treats the thresholds as inclusive, on both edges', () => {
    const { support, contradiction, sufficiency } = DEFAULT_CHECK_THRESHOLDS
    expect(verdictOf({ [S]: support, [E]: sufficiency })).toBe('supported')
    expect(verdictOf({ [C]: contradiction })).toBe('contradicted')
    expect(verdictOf({ [S]: 0.1, [C]: 0.1, [E]: sufficiency })).toBe('undecided')
    // One hair below the sufficiency threshold: not sufficient.
    expect(verdictOf({ [S]: support, [E]: sufficiency - 0.001 })).toBe('insufficient')
  })

  it('honours custom thresholds', () => {
    const lenient = { ...DEFAULT_CHECK_THRESHOLDS, support: 0.5 }
    const strict = { ...DEFAULT_CHECK_THRESHOLDS, sufficiency: 0.95 }
    const answered = result({ [S]: 0.6, [E]: 0.9 })
    expect(resolveCheck(answered, lenient).verdict).toBe('supported')
    expect(resolveCheck(answered, strict).verdict).toBe('insufficient')
  })

  it('reads the question ids it declares', () => {
    // Guards the test itself: a typo in a fixture would make every assertion
    // above pass for the wrong reason.
    expect(Object.values(VERDICT_QUESTION)).toEqual([
      'supports_claim',
      'contradicts_claim',
      'evidence_is_sufficient',
    ])
  })
})

describe('the verdict vocabulary', () => {
  const EXPECTED: readonly CheckVerdict[] = [
    'supported',
    'contradicted',
    'conflicted',
    'insufficient',
    'undecided',
    'unknown',
  ]

  it('is exactly these six words, and produces every one of them', () => {
    const produced = new Set<CheckVerdict>([
      verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.9 }),
      verdictOf({ [C]: 0.95 }),
      verdictOf({ [S]: 0.9, [C]: 0.9, [E]: 0.9 }),
      verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.1 }),
      verdictOf({ [S]: 0.4, [C]: 0.3, [E]: 0.9 }),
      verdictOf({}),
    ])
    expect([...produced].sort()).toEqual([...EXPECTED].sort())
  })

  it('keeps the five original words meaning what they meant', () => {
    // Each of these inputs produced its verdict before the change, and must
    // still: only the two defective cases above moved.
    expect(verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.9 })).toBe('supported')
    expect(verdictOf({ [C]: 0.95 })).toBe('contradicted')
    expect(verdictOf({ [S]: 0.9, [C]: 0.9, [E]: 0.9 })).toBe('conflicted')
    expect(verdictOf({ [S]: 0.9, [C]: 0.05, [E]: 0.1 })).toBe('insufficient')
    expect(verdictOf({})).toBe('unknown')
  })
})

describe('no verdict can contradict the probabilities beside it', () => {
  /** A grid wide enough to cross every threshold on every axis. */
  const VALUES: ReadonlyArray<number | undefined> = [undefined, 0, 0.3, 0.49, 0.5, 0.7, 0.9, 1]

  it('holds across every combination of the three answers', () => {
    const { support, contradiction, sufficiency } = DEFAULT_CHECK_THRESHOLDS
    const strong = (value: number | undefined, threshold: number): boolean =>
      value !== undefined && value >= threshold

    let checked = 0
    for (const supports of VALUES) {
      for (const contradicts of VALUES) {
        for (const sufficient of VALUES) {
          const answers: Record<string, number> = {}
          if (supports !== undefined) answers[S] = supports
          if (contradicts !== undefined) answers[C] = contradicts
          if (sufficient !== undefined) answers[E] = sufficient

          const resolved = resolveCheck(result(answers))
          const where = `supports=${supports} contradicts=${contradicts} sufficient=${sufficient}`
          checked += 1

          // A verdict that reports a probability must agree with it.
          if (resolved.verdict === 'insufficient') {
            expect(strong(sufficient, sufficiency), where).toBe(false)
          }
          if (resolved.verdict === 'supported') {
            expect(strong(sufficient, sufficiency), where).toBe(true)
            expect(strong(supports, support), where).toBe(true)
          }
          if (resolved.verdict === 'undecided') {
            expect(strong(sufficient, sufficiency), where).toBe(true)
            expect(strong(supports, support), where).toBe(false)
            expect(strong(contradicts, contradiction), where).toBe(false)
          }
          if (resolved.verdict === 'contradicted') {
            expect(strong(contradicts, contradiction), where).toBe(true)
            expect(strong(supports, support), where).toBe(false)
          }
          if (resolved.verdict === 'conflicted') {
            expect(strong(supports, support), where).toBe(true)
            expect(strong(contradicts, contradiction), where).toBe(true)
          }
          // `unknown` means exactly one thing, and only one input produces it.
          expect(resolved.verdict === 'unknown', where).toBe(
            supports === undefined && contradicts === undefined,
          )
          // And the probabilities are reported through untouched, whichever
          // verdict they produced.
          expect(resolved.supports, where).toBe(supports)
          expect(resolved.contradicts, where).toBe(contradicts)
          expect(resolved.sufficient, where).toBe(sufficient)
        }
      }
    }
    // Guards the sweep: an empty grid would pass every assertion above.
    expect(checked).toBe(VALUES.length ** 3)
  })
})
