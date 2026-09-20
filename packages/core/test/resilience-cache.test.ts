/**
 * The cache has to be wrong in no direction at all.
 *
 * Three claims are under test, and each is a way a payload-to-answer cache
 * silently hands back an answer to a question nobody asked:
 *
 *  1. The key is derived from the *measured* payload. Redaction and truncation
 *     change what leaves, so they must change the key; two payloads that differ
 *     only in something that never crossed the wire must not be able to collide.
 *  2. A protected feature cannot be cached under any configuration, including one
 *     that names it explicitly. `gate:safety` is the case: its verdict depends on
 *     the workspace in front of it, so a reused verdict is a wrong decision
 *     rather than a stale optimisation.
 *  3. The bound is real, and it is LRU rather than FIFO — an entry that is
 *     actually being used survives an entry that was merely inserted later.
 *
 * Every test here drives an injected clock. None of them sleeps.
 */

import { describe, expect, it } from 'vitest'
import {
  AnswerCache,
  CacheKeyError,
  DEFAULT_CACHE_EXCLUDED,
  type AnswerCacheOptions,
  type CacheDecision,
} from '../src/resilience/index.js'
import type { EgressFeature, MeasuredPayload } from '../src/egress.js'
import type { JevQuestion } from '../src/types.js'

/** A measured payload, with everything the key reads able to be varied. */
const measured = (
  feature: EgressFeature,
  overrides: Partial<MeasuredPayload> = {},
): MeasuredPayload => ({
  feature,
  state: { claim: 'the deploy succeeded' },
  questions: { q: { type: 'noul', instructions: 'is it supported?' } as JevQuestion },
  stateChars: 30,
  questionsChars: 45,
  truncated: false,
  redactionRules: [],
  redactions: 0,
  redactedFields: [],
  redactedValues: 0,
  ...overrides,
})

const allow = (features: readonly EgressFeature[]): CacheDecision => ({
  mode: 'allow',
  features,
})

/** A clock a test moves by hand. Nothing here reads the real one. */
const clock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let at = start
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

describe('the cache key is a function of what would actually be sent', () => {
  const cache = new AnswerCache({ decision: allow(['tool:jev_check']) })

  it('keys on the redacted state, so a redaction changes the key', () => {
    // The same input before and after redaction is exactly the case the key must
    // separate: if it did not, a caller could be handed back an answer about the
    // credential the redaction removed.
    const before = measured('tool:jev_check', {
      state: { credential: 'sk-live-abc123', claim: 'x' },
    })
    const after = measured('tool:jev_check', {
      state: { credential: '[redacted:assigned-secret]', claim: 'x' },
      redactionRules: ['assigned-secret'],
      redactions: 1,
      redactedFields: ['credential'],
      stateChars: 46,
    })
    expect(cache.keyOf(after).key).not.toBe(cache.keyOf(before).key)
  })

  it('separates two payloads whose content differs only by a redaction count', () => {
    // Content identical, one rule fired. The key still has to differ, because the
    // measurement recorded that something was removed *inside* that content.
    const clean = measured('tool:jev_check', { redactions: 0 })
    const touched = measured('tool:jev_check', { redactions: 1, redactionRules: ['assigned-key'] })
    expect(cache.keyOf(touched).key).not.toBe(cache.keyOf(clean).key)
  })

  it('keys on truncation, so a capped state cannot collide with the whole one', () => {
    const whole = measured('tool:jev_check', { stateChars: 9_000_000 })
    const capped = measured('tool:jev_check', {
      state: {
        '[truncated]': true,
        '[originalChars]': 9_000_000,
        '[maxChars]': 16_000,
        '[head]': '{',
      },
      stateChars: 97,
      truncated: true,
      stateCharsDropped: 8_999_903,
    })
    expect(cache.keyOf(capped).key).not.toBe(cache.keyOf(whole).key)
    expect(cache.keyOf(capped).stateChars).toBe(97)
  })

  it('keys on the measured character counts as well as the content', () => {
    const short = measured('tool:jev_check', { questionsChars: 45 })
    const long = measured('tool:jev_check', { questionsChars: 46 })
    expect(cache.keyOf(long).key).not.toBe(cache.keyOf(short).key)
  })

  it('agrees on two payloads built with the same content in a different key order', () => {
    // `JSON.stringify` is insertion-order sensitive, so a naive key would miss
    // here: the same question map assembled by two code paths is one question
    // map, and a cache that disagrees with itself is a cache nobody can reason
    // about.
    const first = measured('tool:jev_check', {
      state: { a: 1, b: { x: 'yes', y: 'no' } },
      questions: {
        alpha: { type: 'noul', instructions: 'first?' },
        beta: { type: 'noul', instructions: 'second?' },
      },
    })
    const second = measured('tool:jev_check', {
      state: { b: { y: 'no', x: 'yes' }, a: 1 },
      questions: {
        beta: { type: 'noul', instructions: 'second?' },
        alpha: { type: 'noul', instructions: 'first?' },
      },
    })
    expect(cache.keyOf(second).key).toBe(cache.keyOf(first).key)
  })

  it('keeps array order, because a rubric is its order', () => {
    const one = measured('tool:jev_check', {
      questions: { s: { type: 'score', instructions: 'how bad?', criteria: ['low', 'high'] } },
    })
    const two = measured('tool:jev_check', {
      questions: { s: { type: 'score', instructions: 'how bad?', criteria: ['high', 'low'] } },
    })
    expect(cache.keyOf(two).key).not.toBe(cache.keyOf(one).key)
  })

  it('reports the size of the key it will use', () => {
    const key = cache.keyOf(measured('tool:jev_check'))
    expect(key.bytes).toBeGreaterThan(key.key.length - 1)
    expect(key.feature).toBe('tool:jev_check')
    expect(key.model).toBeUndefined()
  })

  it('separates two models when a model is configured', () => {
    const withModel = new AnswerCache({
      decision: allow(['tool:jev_check']),
      model: 'jev-latest',
    })
    const other = new AnswerCache({
      decision: allow(['tool:jev_check']),
      model: 'jev-small',
    })
    expect(withModel.keyOf(measured('tool:jev_check')).key).not.toBe(
      other.keyOf(measured('tool:jev_check')).key,
    )
  })

  it('refuses a per-call model that contradicts the configured one', () => {
    const withModel = new AnswerCache({
      decision: allow(['tool:jev_check']),
      model: 'jev-latest',
    })
    expect(() => withModel.keyOf(measured('tool:jev_check'), 'jev-small')).toThrow(TypeError)
  })
})

describe('a protected feature cannot be cached by any configuration', () => {
  it('names the safety gate as protected', () => {
    expect(DEFAULT_CACHE_EXCLUDED).toContain('gate:safety')
  })

  it('refuses a key for the safety gate even when an allowlist names it', () => {
    const cache = new AnswerCache({ decision: allow(['gate:safety', 'tool:jev_check']) })
    expect(cache.isCacheable('gate:safety')).toBe(false)
    expect(cache.decide('gate:safety').enabled).toBe(false)
    expect(cache.decide('gate:safety').reason).toMatch(/protected from caching/)
    expect(() => cache.keyOf(measured('gate:safety'))).toThrow(CacheKeyError)
  })

  it('refuses a key for the safety gate when excluded-mode also names it', () => {
    // `mode: 'exclude'` with the protected feature in the exclusion list is the
    // one configuration where a naive implementation would say "not excluded, so
    // cacheable".
    const cache = new AnswerCache({
      decision: { mode: 'exclude', features: ['gate:safety'] },
    })
    expect(cache.isCacheable('gate:safety')).toBe(false)
    expect(() => cache.keyOf(measured('gate:safety'))).toThrow(CacheKeyError)
  })

  it('lets exclude-mode cover every other feature', () => {
    const cache = new AnswerCache({ decision: { mode: 'exclude', features: ['gate:context'] } })
    expect(cache.isCacheable('tool:jev_ask')).toBe(true)
    expect(cache.isCacheable('gate:context')).toBe(false)
    expect(cache.isCacheable('gate:safety')).toBe(false)
  })

  it('is inert when no decision was configured, and says so', () => {
    // Constructing the cache without deciding anything must not be a way to
    // decide everything. `store` is a no-op and nothing is ever remembered.
    const cache = new AnswerCache({})
    const policy = cache.decide('tool:jev_check')
    expect(policy.enabled).toBe(false)
    expect(policy.decided).toBe(false)
    expect(policy.reason).toMatch(/no cache decision/)
    expect(cache.isCacheable('tool:jev_check')).toBe(false)
  })

  it('refuses a plain array as a decision instead of guessing its reading', () => {
    // `['tool:jev_ask']` reads as an allowlist to one reader and a denylist to
    // another, and the two readings differ by whether every unlisted feature
    // transmits. Guessing here would be guessing about transmission.
    expect(() => new AnswerCache({ decision: [] } as unknown as AnswerCacheOptions)).toThrow(
      TypeError,
    )
    expect(() => new AnswerCache({ decision: [] } as unknown as AnswerCacheOptions)).toThrow(
      /plain array is refused/,
    )
  })

  it('refuses a decision whose feature list is not a list', () => {
    const malformed = () =>
      new AnswerCache({
        decision: { mode: 'allow', features: 'all' } as unknown as CacheDecision,
      })
    expect(malformed).toThrow(TypeError)
  })
})

describe('the bound is a real LRU', () => {
  const keyFor = (cache: AnswerCache, label: string) =>
    cache.keyOf(measured('tool:jev_check', { state: { label } }))

  it('evicts the entry that was least recently used, not the one inserted first', () => {
    const cache = new AnswerCache({ decision: allow(['tool:jev_check']), maxEntries: 3 })
    const k0 = keyFor(cache, 'k0')
    const k1 = keyFor(cache, 'k1')
    const k2 = keyFor(cache, 'k2')
    cache.store(k0, 'answer-0')
    cache.store(k1, 'answer-1')
    cache.store(k2, 'answer-2')
    expect(cache.stats().entries).toBe(3)

    // Touch k0 and k1, so k2 is now the least recently used.
    expect(cache.lookup(k0)).toBe('answer-0')
    expect(cache.lookup(k1)).toBe('answer-1')

    const before = cache.stats().misses
    cache.store(keyFor(cache, 'k3'), 'answer-3')
    expect(cache.stats().entries).toBe(3)
    expect(cache.stats().evictions).toBe(1)
    expect(cache.lookup(k2)).toBeUndefined()
    expect(cache.stats().misses).toBe(before + 1)
    // The two that were touched are still there, which is the whole difference
    // between LRU and FIFO.
    expect(cache.lookup(k0)).toBe('answer-0')
    expect(cache.lookup(k1)).toBe('answer-1')
  })

  it('refuses a bound that is not a positive integer', () => {
    expect(() => new AnswerCache({ decision: allow(['tool:jev_check']), maxEntries: 0 })).toThrow(
      RangeError,
    )
    expect(() => new AnswerCache({ decision: allow(['tool:jev_check']), maxEntries: 2.5 })).toThrow(
      RangeError,
    )
  })

  it('counts hits and misses, because a cache you cannot observe is not one', () => {
    const cache = new AnswerCache({ decision: allow(['tool:jev_check']), maxEntries: 4 })
    const key = keyFor(cache, 'only')
    expect(cache.lookup(key)).toBeUndefined()
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, inserts: 0, entries: 0 })
    cache.store(key, 'answer')
    expect(cache.lookup(key)).toBe('answer')
    cache.clear()
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, inserts: 1, entries: 0 })
    expect(cache.lookup(key)).toBeUndefined()
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, entries: 0 })
  })

  it('never stores under a feature that is not cacheable', () => {
    const cache = new AnswerCache({ decision: allow(['gate:safety']) })
    expect(() => cache.keyOf(measured('gate:safety'))).toThrow(CacheKeyError)
    expect(cache.stats().inserts).toBe(0)
    expect(cache.stats().entries).toBe(0)
  })
})

describe('expiry is checked on read and configured once', () => {
  it('returns an entry before the TTL and drops it after', () => {
    const at = clock()
    const cache = new AnswerCache({
      decision: allow(['tool:jev_check']),
      ttlMs: 500,
      now: at.now,
    })
    const key = cache.keyOf(measured('tool:jev_check'))
    cache.store(key, 'answer')

    at.advance(499)
    expect(cache.lookup(key)).toBe('answer')
    at.advance(1)
    expect(cache.lookup(key)).toBeUndefined()
    expect(cache.stats()).toMatchObject({ expiries: 1, entries: 0 })
  })

  it('treats a TTL of zero as no expiry rather than already expired', () => {
    // Zero is the documented spelling of "never expires"; the alternative reading
    // would make an option into a feature switch by accident.
    const at = clock()
    const cache = new AnswerCache({ decision: allow(['tool:jev_check']), ttlMs: 0, now: at.now })
    const key = cache.keyOf(measured('tool:jev_check'))
    cache.store(key, 'answer')
    at.advance(60 * 60 * 1_000)
    expect(cache.lookup(key)).toBe('answer')
    expect(cache.stats().expiries).toBe(0)
  })
})
