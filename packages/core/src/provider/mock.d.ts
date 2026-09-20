/**
 * The mock provider: deterministic, offline, and unmistakably synthetic.
 *
 * This is the default. Every answer is derived from a hash of the question and
 * state, so a test can assert an exact value, and no network call is possible
 * because this module contains no fetch and imports no client.
 *
 * Two deliberate properties:
 *
 *  - **Answers are never passed off as real.** {@link MOCK_MODEL} names itself
 *    a mock, and `JevResult.provider` says `mock`. A caller cannot confuse the
 *    two.
 *  - **Confidence is reported honestly.** A mock has no basis for confidence,
 *    so it reports a fixed low value rather than a plausible-looking high one.
 *    Silently confident synthetic answers are exactly how a "fabricated 1.0
 *    probability" bug reaches production.
 */
import type { JevProvider, JevRequest, JevResult } from '../types.js';
export declare const MOCK_MODEL = "mock/jev-synthetic";
/** Confidence reported by the mock. Fixed and low, because it is meaningless. */
export declare const MOCK_CONFIDENCE = 0.5;
/** FNV-1a over a string, as an unsigned 32-bit integer. */
export declare const fnv1a: (input: string) => number;
/** A provider that answers offline and deterministically. */
export declare class MockProvider implements JevProvider {
    readonly id = "mock";
    answer(request: JevRequest, signal?: AbortSignal): Promise<JevResult>;
}
//# sourceMappingURL=mock.d.ts.map