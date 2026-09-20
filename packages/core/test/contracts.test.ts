/**
 * Contract tests for the public surface that had no coverage.
 *
 * These are not unit tests of behaviour — the behaviour is covered elsewhere.
 * They pin the *identifiers* that bind the pieces together, because a wrong
 * identifier here is silently accepted by the type system and only misbehaves
 * at runtime.
 *
 * The clearest example: `SAFETY_FEATURE` is typed `EgressFeature`, so
 * `'tool:jev_ask'` would compile. The safety gate would then read and write the
 * ask tool's egress switch, and enabling the safety gate would silently disable
 * `jev_ask`. Nothing would fail to build, and no existing test would notice.
 */

import { describe, expect, it } from 'vitest'
import {
  CONTEXT_FEATURE,
  CONTEXT_QUESTIONS,
  DEFAULT_CHECK_THRESHOLDS,
  EGRESS_FEATURES,
  EGRESS_FIELDS,
  HAZARD_QUESTIONS,
  SAFETY_FEATURE,
  VERDICT_QUESTION,
  answerOf,
  asRendered,
  rankingSize,
  renderAnswer,
  renderResult,
  resolveCheck,
  summarize,
} from '../src/index.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import type { JevResult } from '../src/types.js'

describe('egress feature identifiers are pinned', () => {
  it('binds the safety gate to the safety feature, not to some other switch', () => {
    // The whole point: these must be distinct switches. Sharing one would make
    // enabling the gate silently disable a tool, or worse, let the gate run
    // under a switch an operator turned on for something else.
    expect(SAFETY_FEATURE).toBe('gate:safety')
    expect(CONTEXT_FEATURE).toBe('gate:context')
  })

  it('keeps the two gates on separate switches', () => {
    expect(SAFETY_FEATURE).not.toBe(CONTEXT_FEATURE)
  })

  it('keeps each gate off the tool switches', () => {
    const toolFeatures = EGRESS_FEATURES.filter((feature) => feature.startsWith('tool:'))
    expect(toolFeatures.length).toBeGreaterThan(0)
    for (const feature of toolFeatures) {
      expect(SAFETY_FEATURE).not.toBe(feature)
      expect(CONTEXT_FEATURE).not.toBe(feature)
    }
  })

  it('names a feature that actually exists in the contract', () => {
    for (const feature of [SAFETY_FEATURE, CONTEXT_FEATURE]) {
      expect(EGRESS_FEATURES).toContain(feature)
      expect(EGRESS_FIELDS[feature]).toBeDefined()
      expect(EGRESS_FIELDS[feature].length).toBeGreaterThan(0)
    }
  })

  it('defaults both gates to disabled, so the shipped posture is offline', () => {
    expect(DEFAULT_CONFIG.gates.safety.enabled).toBe(false)
    expect(DEFAULT_CONFIG.gates.context.enabled).toBe(false)
  })
})

describe('the verdict question ids are pinned', () => {
  it('names exactly the three questions resolveCheck reads', () => {
    expect(VERDICT_QUESTION).toEqual({
      supports: 'supports_claim',
      contradicts: 'contradicts_claim',
      sufficient: 'evidence_is_sufficient',
    })
  })

  it('reads the ids it declares, so a renamed id cannot silently return unknown', () => {
    // A mismatch between these ids and the ones asked would make every check
    // return "unknown" while looking like it ran.
    const answers = {
      [VERDICT_QUESTION.supports]: { type: 'noul' as const, noul: 0.95 },
      [VERDICT_QUESTION.contradicts]: { type: 'noul' as const, noul: 0.02 },
      [VERDICT_QUESTION.sufficient]: { type: 'noul' as const, noul: 0.9 },
    }
    const result: JevResult = {
      model: 'fixed',
      provider: 'fixed',
      latencyMs: 1,
      answers,
    }
    expect(resolveCheck(result).verdict).toBe('supported')
  })

  it('ships thresholds that require more than a coin flip', () => {
    expect(DEFAULT_CHECK_THRESHOLDS.support).toBeGreaterThan(0.5)
    expect(DEFAULT_CHECK_THRESHOLDS.contradiction).toBeGreaterThan(0.5)
    expect(DEFAULT_CHECK_THRESHOLDS.sufficiency).toBeGreaterThan(0)
    expect(DEFAULT_CHECK_THRESHOLDS.sufficiency).toBeLessThanOrEqual(1)
  })
})

describe('gate question sets are declared and stable', () => {
  it('declares a hazard question for each safety concern', () => {
    const names = Object.keys(HAZARD_QUESTIONS)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const question = HAZARD_QUESTIONS[name]
      expect(question?.type).toBe('noul')
      // Instructions are an EntryType, so this asserts the shape rather than
      // assuming a string: the gate questions are written as prose today, and a
      // hazard phrased as an empty object would be no question at all.
      expect(typeof question?.instructions).toBe('string')
      expect(String(question?.instructions).length).toBeGreaterThan(20)
    }
  })

  it('asks the two context questions, relevance only when a goal exists', () => {
    expect(Object.keys(CONTEXT_QUESTIONS).sort()).toEqual(['adds_information', 'is_relevant'])
    for (const question of Object.values(CONTEXT_QUESTIONS)) {
      expect(question.type).toBe('noul')
    }
  })
})

describe('render helpers produce the documented shapes', () => {
  const result = (answers: JevResult['answers'], provider = 'mock'): JevResult => ({
    model: 'm',
    provider,
    latencyMs: 7,
    answers,
  })

  it('flattens a noul answer to true/false with the strength of the call', () => {
    expect(renderAnswer('q', { type: 'noul', noul: 0.9 })).toMatchObject({
      answer: 'true',
      probability: 0.9,
      noul: 0.9,
    })
    expect(renderAnswer('q', { type: 'noul', noul: 0.1 })).toMatchObject({
      answer: 'false',
      probability: 0.9,
    })
  })

  it('reports an absent answer as absent rather than inventing one', () => {
    const rendered = renderAnswer('q', undefined)
    expect(rendered.note).toBeDefined()
    expect(rendered.answer).toBeUndefined()
    expect(rendered.probability).toBeUndefined()
  })

  it('labels a mock result as synthetic and a live one as not', () => {
    expect(renderResult(result({}, 'mock'), []).warning).toBeDefined()
    expect(renderResult(result({}, 'live'), []).warning).toBeUndefined()
  })

  it('preserves question order in the rendered answers', () => {
    const rendered = renderResult(
      result({ a: { type: 'noul', noul: 0.6 }, b: { type: 'noul', noul: 0.4 } }),
      ['b', 'a'],
    )
    expect(rendered.answers.map((answer) => answer.question)).toEqual(['b', 'a'])
  })

  it('narrows a schema-inferred value back to the rendered shape', () => {
    expect(asRendered({ provider: 'x', answers: [] }).provider).toBe('x')
  })

  it('counts ranking entries defensively rather than throwing on a bad shape', () => {
    expect(rankingSize({ ranking: [1, 2, 3] })).toBe(3)
    expect(rankingSize({ ranking: null })).toBe(0)
    expect(rankingSize({})).toBe(0)
    expect(rankingSize(undefined)).toBe(0)
    expect(rankingSize(null)).toBe(0)
    expect(rankingSize('not a payload')).toBe(0)
    expect(rankingSize(42)).toBe(0)
  })

  it('summarizes in one line and marks synthetic answers', () => {
    const value = renderResult(result({ q: { type: 'noul', noul: 0.8 } }), ['q'])
    const line = summarize(value, 'jev_ask')
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('jev_ask')
    expect(line).toContain('synthetic')
    expect(line).toContain('80%')
  })

  it('does not mark a live result as synthetic', () => {
    const value = renderResult(result({ q: { type: 'noul', noul: 0.8 } }, 'live'), ['q'])
    expect(summarize(value, 'jev_ask')).not.toContain('synthetic')
  })

  it('marks an unanswered question in the summary instead of printing a value', () => {
    const value = renderResult(result({}), ['missing'])
    expect(summarize(value, 'x')).toContain('missing=?')
  })
})

describe('answerOf reads a named answer only', () => {
  it('returns the answer for a present id and undefined otherwise', () => {
    const r: JevResult = {
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: { present: { type: 'noul', noul: 0.5 } },
    }
    expect(answerOf(r, 'present')).toBeDefined()
    expect(answerOf(r, 'absent')).toBeUndefined()
  })
})
