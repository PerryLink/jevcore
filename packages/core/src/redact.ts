/**
 * Redaction.
 *
 * Two independent passes, because they fail differently:
 *
 *  1. **Key rules** — a value under a field named `password`, `token`,
 *     `apiKey`, … is replaced wholesale. Cheap, exact, and the main defence.
 *  2. **Value rules** — pattern matches applied to every surviving string,
 *     for secrets that appear in free text rather than in a named field.
 *
 * The honest limitation, stated here rather than discovered later: this is a
 * best-effort filter, not a guarantee. A secret that is neither under a
 * recognisable key nor matching a known shape will pass through. That is why
 * the plugin also caps what it sends and lets every egress path be turned off
 * independently — redaction is a mitigation, not a permission.
 */

import type { JsonValue, Redacted, RedactionSummary } from './types.js'

/** A named pattern applied to string values. */
export interface ValueRule {
  readonly name: string
  readonly pattern: RegExp
  /**
   * Optional replacement shaper, for a rule that needs to keep part of what it
   * matched.
   *
   * Receives the matched text and the configured replacement string, and returns
   * what should stand in its place. The assigned-secret rule uses it to keep the
   * field label and any opening quote — see `labelPreservingReplace`. Rules
   * without it replace the whole match, which is what every other rule wants.
   */
  readonly replace?: (match: string, replacement: string) => string
}

/**
 * Matches field names whose value is replaced regardless of its content.
 *
 * These are pattern matches over the whole name and stay that way on purpose: a
 * credential is usually named for what it is (`db_password`, `x-auth-token`,
 * `userToken`) and a rule that only matched whole names would let the compound
 * ones through. The cost of that choice is false positives on ordinary words
 * that merely *contain* a rule's letters, and four of them were burning real
 * fields:
 *
 *  - `/auth/i` matched `author`, `authorityScore`, `authorizedBy` and `coauthor`
 *    — an author's name is not a credential, and replacing it both loses the
 *    evidence and makes "did redaction fire?" unanswerable.
 *  - `/signature/i` matched `signatureDate`, the date a document was signed
 *    rather than the signature itself.
 *  - `/token/i` matched `tokenCount`, `tokenizer` and `tokenLimit` — counters and
 *    component names, not secrets.
 *  - `/salt/i` matched `result`.
 *
 * The narrowings below keep every compound secret name working — `_`, `-`, `.`
 * and a lowercase-to-uppercase boundary are all still boundaries — while
 * dropping the ordinary words. The rule applied throughout: a rule has to end
 * where the name does, or stop at a word boundary inside it, never sit in the
 * middle of an unrelated word.
 *
 * Residual over-redaction is deliberate and stays in the strict direction:
 * `totalTokens` is shaped exactly like `userToken`, so it is still redacted.
 * Losing a usage count is the acceptable side of that trade; leaking a token is
 * not. Nothing here is a permission, either — a genuine secret is still caught
 * by the value rules below whatever its field is called.
 */
export const DEFAULT_KEY_RULES: readonly RegExp[] = [
  /pass(word|phrase)?/i,
  /secret/i,
  // `token`/`tokens` at the end of a name or as a trailing segment.
  /(?:^|[_\-.]|[a-z0-9])tokens?$/i,
  /api[-_]?key/i,
  /^key$/i,
  /credential/i,
  /authorization/i,
  // `auth` as a segment that ends there: `auth`, `x-auth`, `auth_token`,
  // `authHeader`. Not `author`, `authorityScore` or `coauthor` — the next
  // character has to stop the word.
  //
  // Written without the `i` flag on purpose. `[a-z]` under `i` also matches
  // uppercase, so `(?![a-z])` would reject `authHeader` (whose next character is
  // `H`) as well as `author` — the rule would look correct and silently miss
  // every camelCase credential field, which is the more common spelling in JSON.
  // `[Aa]uth` covers the lowercase and capitalized forms; `/^auth$/i` covers the
  // shouty one, and the token rule catches `AUTH_TOKEN`.
  /(?:^|[_\-.]|[a-z0-9])[Aa]uth(?![a-z])/,
  /^auth$/i,
  /cookie/i,
  /session[-_]?id/i,
  /private[-_]?key/i,
  // `pwd` as a whole name or a trailing segment, so `user_pwd` is still caught
  // while an unrelated word that merely contains those letters is not.
  /(?:^|[_\-.]|[a-z0-9])pwd$/i,
  // `salt` only as a whole name or a trailing segment: not `result`.
  /(?:^|[_\-.]|[a-z0-9])salt$/i,
  // `signature` as a whole name or a trailing segment: not `signatureDate`.
  /(?:^|[_\-.]|[a-z0-9])signatures?$/i,
]

/** Matches secret-looking substrings inside otherwise ordinary text. */
export const DEFAULT_VALUE_RULES: readonly ValueRule[] = [
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'typesafe-style-key', pattern: /\bts_(?:live|test)_[A-Za-z0-9_-]{8,}/g },
  { name: 'anthropic-style-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'assigned-secret',
    // The label is captured so it can be put back — see `labelPreservingReplace`.
    pattern: /(\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*)(\S{6,})/gi,
    replace: labelPreservingReplace,
  },
  { name: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
]

const REPLACEMENT = '[redacted]'

/**
 * Replace the *value* of an assignment, keeping the label that named it.
 *
 * This rule used to replace the whole match — label and all — so
 * `"api_key=sk-live-…"` came back as `"[redacted]"` with no trace of which field
 * it had been. That is the wrong half to remove twice over:
 *
 *  - The label is not a secret. `api_key` is a field *name*; the key is what
 *    follows the `=`.
 *  - Losing it destroys the evidence. A question like "does this log contain a
 *    credential assignment?" is answered by the label's presence, and a redactor
 *    that erases the label makes the answer unknowable — the reviewer cannot
 *    distinguish "no credential here" from "a credential was here, and we are
 *    not telling you where".
 *
 * Delimiters are preserved too, so a replacement inside JSON keeps the document
 * parseable: `{"api_key":"sk-abc123"}` becomes `{"api_key":"[redacted]"}`, not
 * `{"api_key":"[redacted]}`. Only the opening delimiter is put back, since the
 * value pattern does not consume the closing one.
 */
function labelPreservingReplace(match: string, replacement: string): string {
  // The pattern's capture groups are dropped by `String.prototype.replace` when a
  // single-argument function is used, so the split is redone here rather than
  // changing the signature every rule has to match.
  const assigned = /^(\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*)(\S{6,})$/i.exec(
    match,
  )
  if (assigned === null) return replacement
  const [, label = '', value = ''] = assigned
  const opening = value[0]
  const quoted = opening === '"' || opening === "'"
  return `${label}${quoted ? opening : ''}${replacement}`
}

export interface RedactOptions {
  readonly keyRules?: readonly RegExp[]
  readonly valueRules?: readonly ValueRule[]
  /** Replacement text for both passes. */
  readonly replacement?: string
  /**
   * Maximum depth to walk. Guards against a pathological or cyclic-looking
   * structure. Values deeper than this are replaced with `[truncated]`.
   */
  readonly maxDepth?: number
}

const DEEP = '[truncated:depth]'

const redactString = (
  input: string,
  rules: readonly ValueRule[],
  replacement: string,
  fired: Set<string>,
  fields: Set<string>,
  counter: { count: number; values: number },
): { text: string; count: number } => {
  let text = input
  let count = 0
  for (const rule of rules) {
    // A `g` regex carries `lastIndex` between calls; reset before each use so
    // repeated redactions do not skip matches.
    rule.pattern.lastIndex = 0
    const replaceWith = rule.replace
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1
      counter.values += 1
      fired.add(rule.name)
      fields.add(FREE_TEXT_FIELD)
      // A rule may need to keep part of what it matched — the label in front of
      // an assigned secret — and hands the matched text back shaped for the same
      // replacement text the caller configured.
      return replaceWith === undefined
        ? replacement
        : replaceWith(String(args[0]), replacement)
    })
  }
  return { text, count }
}

/**
 * Stands in for a field name when a value was replaced inside free text.
 *
 * A replacement in a question body or a state string has no field to name, and
 * inventing one would be worse than saying so.
 */
const FREE_TEXT_FIELD = '[value]'

const walk = (
  value: JsonValue,
  depth: number,
  options: Required<Pick<RedactOptions, 'replacement' | 'maxDepth'>> & {
    keyRules: readonly RegExp[]
    valueRules: readonly ValueRule[]
  },
  fired: Set<string>,
  counter: { count: number; values: number },
  fields: Set<string>,
): JsonValue => {
  if (depth > options.maxDepth) return DEEP

  if (typeof value === 'string') {
    const { text, count } = redactString(
      value,
      options.valueRules,
      options.replacement,
      fired,
      fields,
      counter,
    )
    counter.count += count
    return text
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, options, fired, counter, fields))
  }

  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (options.keyRules.some((rule) => rule.test(key))) {
      out[key] = options.replacement
      counter.count += 1
      fired.add('key-name')
      // The *name* is recorded and the value is not, which is the only half of
      // this pair that is safe to keep. Note that a numeric value under a
      // sensitive name is replaced by a string, so the type changes — that is
      // the honest consequence of treating the whole value as untrustworthy, and
      // `fields` is what lets a caller see it happened.
      fields.add(key)
      continue
    }
    out[key] = walk(item, depth + 1, options, fired, counter, fields)
  }
  return out
}

/**
 * Redact one JSON value, returning the safe copy and a summary of what fired.
 *
 * The input is never mutated.
 */
export const redact = (value: JsonValue, options: RedactOptions = {}): Redacted<JsonValue> => {
  const fired = new Set<string>()
  const counter = { count: 0, values: 0 }
  const fields = new Set<string>()
  const resolved = {
    keyRules: options.keyRules ?? DEFAULT_KEY_RULES,
    valueRules: options.valueRules ?? DEFAULT_VALUE_RULES,
    replacement: options.replacement ?? REPLACEMENT,
    maxDepth: options.maxDepth ?? 12,
  }
  const redactedValue = walk(value, 0, resolved, fired, counter, fields)
  const summary: RedactionSummary = {
    redactions: counter.count,
    rules: [...fired].sort(),
    fields: [...fields].sort(),
    values: counter.values,
  }
  return { value: redactedValue, summary }
}

/**
 * Truncate a serialized value to a byte budget, appending a marker.
 *
 * Operates on the serialized form so the result stays valid JSON: a caller
 * that cuts a string mid-object would otherwise hand Jev malformed input.
 */
export const truncateSerialized = (
  serialized: string,
  maxChars: number,
): { text: string; truncated: boolean } => {
  if (serialized.length <= maxChars) return { text: serialized, truncated: false }
  return { text: `${serialized.slice(0, maxChars)}…[truncated]`, truncated: true }
}
