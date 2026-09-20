/**
 * Redaction: what it must still remove, and what it must stop removing.
 *
 * The two halves of this file pull in opposite directions on purpose, because
 * the defect being fixed was a one-sided one. Redaction is a substring match over
 * field names, which is the right default — a credential is usually named for
 * what it is, in a compound (`db_password`, `x-auth-token`, `userToken`) that a
 * whole-name rule would miss. The cost is false positives, and two of the rules
 * were firing on ordinary fields:
 *
 *   `/auth/i`      matched `author`, `authorityScore`, `authorizedBy`, `coauthor`
 *   `/signature/i` matched `signatureDate` — the date a document was signed
 *   `/salt/i`      matched `result`
 *
 * A false positive here is not a harmless extra `[redacted]`. It destroys the
 * evidence: an operator asking "does this record contain a credential?" reads a
 * payload where ordinary fields are blanked, and cannot tell a redacted field
 * from an absent one. It also changes types, because the replacement is a string
 * and the value may have been a number.
 *
 * So the rules are narrowed to match only at the *end* of a name, and every case
 * below is a test: the ordinary words that must survive, and the real credential
 * names that must not — including the compounds the narrowing had to keep
 * working.
 */

import { describe, expect, it } from 'vitest'
import { redact } from '../src/index.js'
import type { JsonValue } from '../src/types.js'

/** Redact one field and read back its value. */
const under = (field: string, value: JsonValue): JsonValue => {
  const result = redact({ [field]: value })
  return (result.value as Record<string, JsonValue>)[field] as JsonValue
}

const isRedacted = (field: string, value: JsonValue = 'ordinary value'): boolean =>
  under(field, value) === '[redacted]'

describe('the narrowed rules stop eating ordinary fields', () => {
  it('keeps every field name that was being destroyed by substring matching', () => {
    // Each of these was replaced before the narrowing, and each one is a field a
    // caller would reasonably be judging a decision about.
    const ordinary: JsonValue[] = [
      { author: 'Ada Lovelace' },
      { authoredAt: '2024-01-01' },
      { authorizedBy: 'ops-team' },
      { coauthor: 'Grace Hopper' },
      { authority: 'the board' },
      { authorityScore: 7 },
      { signatureDate: '2024-01-01' },
      { signatureAlgorithm: 'ES256' },
      { tokenCount: 128 },
      { tokenizer: 'cl100k' },
      { tokenLimit: 4_096 },
      { tokensUsed: 42 },
      { result: { ok: true } },
      { results: ['a', 'b'] },
      { saltValue: 'not the field salt' },
      { authors: ['Ada', 'Grace'] },
    ]
    for (const record of ordinary) {
      const field = Object.keys(record as object)[0] as string
      const value = (record as Record<string, JsonValue>)[field] as JsonValue
      expect(under(field, value), field).not.toBe('[redacted]')
      // And untouched, not merely unredacted: same value, same type.
      expect(under(field, value), field).toEqual(value)
    }
  })

  it('leaves a numeric field a number rather than turning it into a string', () => {
    // The type change was a real consequence of the false positive: a count of
    // tokens became the string "[redacted]", which a downstream reader would
    // take for data.
    expect(under('authorityScore', 7)).toBe(7)
    expect(under('tokenCount', 128)).toBe(128)
    expect(typeof under('tokenCount', 128)).toBe('number')
  })

  it('reports what it actually redacted, so "fired" is not the only signal', () => {
    const result = redact({ author: 'Ada', api_key: 'sk-live-abcdefghijklmnopqrstuvwx' })
    expect(result.summary.fields).not.toContain('author')
    expect(result.summary.fields).toContain('api_key')
    expect(result.summary.redactions).toBe(1)
  })
})

describe('the narrowing does not let real credential names through', () => {
  it('still redacts whole names', () => {
    for (const field of [
      'password',
      'passphrase',
      'secret',
      'token',
      'api_key',
      'apiKey',
      'key',
      'credential',
      'authorization',
      'auth',
      'cookie',
      'sessionId',
      'privateKey',
      'pwd',
      'salt',
      'signature',
      'signatures',
    ]) {
      expect(isRedacted(field), field).toBe(true)
    }
  })

  it('still redacts the compound names that make substring matching worth it', () => {
    // These are the cases a whole-name rule would miss, so the narrowing must
    // not have cost them.
    for (const field of [
      'db_password',
      'userToken',
      'access_token',
      'refresh_token',
      'id-token',
      'x-auth',
      'x-auth-token',
      'authorizationHeader',
      'authHeader',
      'MY_API_KEY',
      'stripeSecret',
      'aws_secret_access_key',
      'passwordHint',
      'session_id',
      'app.signature',
      'app_signature',
      'data.salt',
      'user_pwd',
    ]) {
      expect(isRedacted(field), field).toBe(true)
    }
  })

  it('does not depend on case', () => {
    expect(isRedacted('AUTHOR')).toBe(false)
    expect(isRedacted('AUTH')).toBe(true)
    expect(isRedacted('Token')).toBe(true)
  })
})

describe('an assigned credential keeps its label', () => {
  it('replaces the value and keeps the field name that introduced it', () => {
    // `api_key=` used to be swallowed whole, which removed the one piece of
    // evidence that answers "does this log contain a credential assignment?".
    expect(redact('api_key=sk-live-abcdefghijklmnop').value).toBe('api_key=[redacted]')
    expect(redact('password: hunter2secret').value).toBe('password: [redacted]')
    expect(redact('token = abcdef123456').value).toBe('token = [redacted]')
  })

  it('keeps the label even when the value is also a recognised key shape', () => {
    // Two rules fire here — `assigned-secret` and `openai-style-key` — and the
    // label survives both.
    const result = redact('api_key=sk-abcdefghijklmnopqrstuvwx')
    expect(result.value).toBe('api_key=[redacted]')
    expect(result.summary.rules).toContain('assigned-secret')
    expect(result.summary.rules).toContain('openai-style-key')
  })

  it('leaves a JSON document parseable when the value was quoted', () => {
    // Only the opening delimiter is put back, because the value pattern does not
    // consume the closing one. Dropping the label entirely used to leave a
    // document that no longer parsed.
    const source = '{"api_key":"sk-live-abcdefghijklmnop"}'
    const result = redact(source)
    expect(result.value).toBe('{"api_key":"[redacted]"}')
    expect(() => JSON.parse(String(result.value))).not.toThrow()
  })

  it('honours a custom replacement string, label included', () => {
    expect(redact('api_key=sk-live-abcdefghijklmnop', { replacement: '***' }).value).toBe(
      'api_key=***',
    )
  })

  it('still removes the secret itself, whatever surrounds it', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwx'
    for (const text of [
      `api_key=${secret}`,
      `api_key="${secret}"`,
      `"api_key": "${secret}"`,
      `Authorization: Bearer ${secret}`,
      `token=${secret} and again token=${secret}`,
    ]) {
      expect(String(redact(text).value), text).not.toContain(secret)
    }
  })

  it('records the label as a redacted field when it sits in a named field', () => {
    // `api_key` is redacted by the key rule here, not the value rule, so the
    // field name is the evidence and the value never appears.
    const result = redact({ api_key: 'sk-live-abcdefghijklmnop' })
    expect(result.summary.fields).toContain('api_key')
    expect(JSON.stringify(result.summary)).not.toContain('sk-live-abcdefghijklmnop')
  })

  it('marks a free-text replacement as having no field name', () => {
    const result = redact('the key is sk-abcdefghijklmnopqrstuvwx')
    expect(result.summary.fields).toEqual(['[value]'])
    expect(result.summary.values).toBe(1)
  })

  it('counts repeated free-text replacements rather than deduplicating them', () => {
    const result = redact('sk-aaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbb')
    expect(result.summary.values).toBe(2)
    expect(result.summary.redactions).toBe(2)
    // The field set is a set: `'[value]'` appears once however often it fired.
    expect(result.summary.fields).toEqual(['[value]'])
  })
})
