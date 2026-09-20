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
import type { JsonValue, Redacted } from './types.js';
/** A named pattern applied to string values. */
export interface ValueRule {
    readonly name: string;
    readonly pattern: RegExp;
}
/** Matches field names whose value is replaced regardless of its content. */
export declare const DEFAULT_KEY_RULES: readonly RegExp[];
/** Matches secret-looking substrings inside otherwise ordinary text. */
export declare const DEFAULT_VALUE_RULES: readonly ValueRule[];
export interface RedactOptions {
    readonly keyRules?: readonly RegExp[];
    readonly valueRules?: readonly ValueRule[];
    /** Replacement text for both passes. */
    readonly replacement?: string;
    /**
     * Maximum depth to walk. Guards against a pathological or cyclic-looking
     * structure. Values deeper than this are replaced with `[truncated]`.
     */
    readonly maxDepth?: number;
}
/**
 * Redact one JSON value, returning the safe copy and a summary of what fired.
 *
 * The input is never mutated.
 */
export declare const redact: (value: JsonValue, options?: RedactOptions) => Redacted<JsonValue>;
/**
 * Truncate a serialized value to a byte budget, appending a marker.
 *
 * Operates on the serialized form so the result stays valid JSON: a caller
 * that cuts a string mid-object would otherwise hand Jev malformed input.
 */
export declare const truncateSerialized: (serialized: string, maxChars: number) => {
    text: string;
    truncated: boolean;
};
//# sourceMappingURL=redact.d.ts.map