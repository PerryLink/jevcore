import { describe, expect, it } from 'vitest'
import { DEFAULT_KEY_RULES, DEFAULT_VALUE_RULES, redact, truncateSerialized } from '../src/redact.js'
import type { JsonValue } from '../src/types.js'

describe('key-based redaction', () => {
  it('replaces values under sensitive field names', () => {
    const result = redact({ user: 'ada', password: 'hunter2' })
    expect(result.value).toEqual({ user: 'ada', password: '[redacted]' })
    expect(result.summary.redactions).toBe(1)
    expect(result.summary.rules).toContain('key-name')
  })

  it('matches sensitive names case-insensitively and as substrings', () => {
    const result = redact({
      API_KEY: 'x',
      userToken: 'y',
      db_password: 'z',
      'x-auth': 'w',
      ordinary: 'keep',
    } as JsonValue)
    const value = result.value as Record<string, JsonValue>
    expect(value.API_KEY).toBe('[redacted]')
    expect(value.userToken).toBe('[redacted]')
    expect(value.db_password).toBe('[redacted]')
    expect(value['x-auth']).toBe('[redacted]')
    expect(value.ordinary).toBe('keep')
  })

  it('redacts at depth', () => {
    const result = redact({ a: { b: { c: { secret: 'shh' } } } })
    expect(JSON.stringify(result.value)).not.toContain('shh')
  })
})

describe('value-based redaction', () => {
  it('removes a bearer token from free text', () => {
    const result = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
    expect(result.value).toBe('Authorization: [redacted]')
    expect(result.summary.rules).toContain('bearer')
  })

  it('removes key-shaped strings regardless of field name', () => {
    for (const secret of [
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'ts_live_abcdefgh1234',
      'ghp_abcdefghijklmnopqrstuvwxyz01',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      const result = redact({ note: `the value is ${secret} ok` })
      expect(JSON.stringify(result.value)).not.toContain(secret)
    }
  })

  it('removes a private key header', () => {
    const result = redact('-----BEGIN RSA PRIVATE KEY-----')
    expect(result.value).toBe('[redacted]')
  })

  it('removes credentials embedded in a connection string', () => {
    const result = redact('postgres://admin:s3cr3tpw@db.internal:5432/app')
    expect(result.value).not.toContain('s3cr3tpw')
  })

  it('applies a global rule repeatedly rather than only once', () => {
    // A rule with the `g` flag carries lastIndex between calls; if that is not
    // reset, the second occurrence survives. This is the regression guard.
    const result = redact('sk-aaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbb')
    expect(result.value).toBe('[redacted] and [redacted]')
    expect(result.summary.redactions).toBe(2)
  })

  it('reports every rule that fired', () => {
    const result = redact({ a: 'sk-aaaaaaaaaaaaaaaaaaaa', b: 'Bearer bbbbbbbbbbbbbbbbbbbb' })
    expect(result.summary.rules).toEqual(expect.arrayContaining(['openai-style-key', 'bearer']))
  })
})

describe('structure handling', () => {
  it('preserves ordinary content unchanged', () => {
    const input: JsonValue = { a: 1, b: [true, null, 'plain text'], c: { d: 'e' } }
    const result = redact(input)
    expect(result.value).toEqual(input)
    expect(result.summary.redactions).toBe(0)
  })

  it('does not mutate its input', () => {
    const input = { password: 'hunter2' }
    redact(input)
    expect(input.password).toBe('hunter2')
  })

  it('caps recursion depth instead of recursing forever', () => {
    let deep: JsonValue = 'leaf'
    for (let index = 0; index < 40; index += 1) deep = { nested: deep }
    const result = redact(deep, { maxDepth: 3 })
    expect(JSON.stringify(result.value)).toContain('[truncated:depth]')
  })

  it('honours a custom replacement string', () => {
    const result = redact({ token: 'x' }, { replacement: '***' })
    expect(result.value).toEqual({ token: '***' })
  })

  it('exposes its default rulesets for callers that extend them', () => {
    expect(DEFAULT_KEY_RULES.length).toBeGreaterThan(0)
    expect(DEFAULT_VALUE_RULES.length).toBeGreaterThan(0)
  })
})

describe('truncateSerialized', () => {
  it('leaves a short value untouched', () => {
    expect(truncateSerialized('{"a":1}', 100)).toEqual({ text: '{"a":1}', truncated: false })
  })

  it('marks a truncated value', () => {
    const result = truncateSerialized('abcdefghij', 4)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('abcd')).toBe(true)
    expect(result.text).toContain('[truncated]')
  })
})
