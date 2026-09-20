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
/** Matches field names whose value is replaced regardless of its content. */
export const DEFAULT_KEY_RULES = [
    /pass(word|phrase)?/i,
    /secret/i,
    /token/i,
    /api[-_]?key/i,
    /^key$/i,
    /credential/i,
    /authorization/i,
    /auth/i,
    /cookie/i,
    /session[-_]?id/i,
    /private[-_]?key/i,
    /^pwd$/i,
    /salt/i,
    /signature/i,
];
/** Matches secret-looking substrings inside otherwise ordinary text. */
export const DEFAULT_VALUE_RULES = [
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
        pattern: /\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*\S{6,}/gi,
    },
    { name: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
];
const REPLACEMENT = '[redacted]';
const DEEP = '[truncated:depth]';
const redactString = (input, rules, replacement, fired) => {
    let text = input;
    let count = 0;
    for (const rule of rules) {
        // A `g` regex carries `lastIndex` between calls; reset before each use so
        // repeated redactions do not skip matches.
        rule.pattern.lastIndex = 0;
        text = text.replace(rule.pattern, () => {
            count += 1;
            fired.add(rule.name);
            return replacement;
        });
    }
    return { text, count };
};
const walk = (value, depth, options, fired, counter) => {
    if (depth > options.maxDepth)
        return DEEP;
    if (typeof value === 'string') {
        const { text, count } = redactString(value, options.valueRules, options.replacement, fired);
        counter.count += count;
        return text;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, depth + 1, options, fired, counter));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (options.keyRules.some((rule) => rule.test(key))) {
            out[key] = options.replacement;
            counter.count += 1;
            fired.add('key-name');
            continue;
        }
        out[key] = walk(item, depth + 1, options, fired, counter);
    }
    return out;
};
/**
 * Redact one JSON value, returning the safe copy and a summary of what fired.
 *
 * The input is never mutated.
 */
export const redact = (value, options = {}) => {
    const fired = new Set();
    const counter = { count: 0 };
    const resolved = {
        keyRules: options.keyRules ?? DEFAULT_KEY_RULES,
        valueRules: options.valueRules ?? DEFAULT_VALUE_RULES,
        replacement: options.replacement ?? REPLACEMENT,
        maxDepth: options.maxDepth ?? 12,
    };
    const redactedValue = walk(value, 0, resolved, fired, counter);
    const summary = {
        redactions: counter.count,
        rules: [...fired].sort(),
    };
    return { value: redactedValue, summary };
};
/**
 * Truncate a serialized value to a byte budget, appending a marker.
 *
 * Operates on the serialized form so the result stays valid JSON: a caller
 * that cuts a string mid-object would otherwise hand Jev malformed input.
 */
export const truncateSerialized = (serialized, maxChars) => {
    if (serialized.length <= maxChars)
        return { text: serialized, truncated: false };
    return { text: `${serialized.slice(0, maxChars)}…[truncated]`, truncated: true };
};
//# sourceMappingURL=redact.js.map