/**
 * The MCP surface must say when it truncated.
 *
 * `EgressContract` caps `state` by truncating it, deliberately: a shorter state is
 * still a state, and the alternative — refusing — would make a large-but-valid
 * call impossible. `questions` is refused instead, because answers are keyed by
 * question and a shortened question map cannot be matched back to what was asked.
 *
 * The three handlers below build their own result objects rather than going
 * through the core's `renderResult`, and all three used to drop the two fields
 * that report this. The failure that made it worth a test file: ten candidates of
 * 4,000 characters each are 40,271 characters of state, 16,000 of them are sent,
 * and `runRank` returned all ten original strings beside their scores with no
 * indication that six of them had been reduced to fragments. A caller cannot
 * compensate for a cut it is not told about.
 *
 * These assertions are deliberately about *observable* facts — the flag, the
 * reported character count — and not about the internal shape of the truncated
 * envelope, which `packages/core/test/truncation-reporting.test.ts` already owns.
 */

import { describe, expect, it } from 'vitest'
import { buildRuntime } from '../src/runtime.js'
import { runAsk, runCheck, runRank } from '../src/tools.js'

/** The production wiring, in its offline mode: no key, no network. */
const runtime = async () => (await buildRuntime(() => undefined)).service

/** Long enough to exceed `tool:*`'s declared 16,000-character `state` cap. */
const OVERSIZED = 'x'.repeat(40_000)

describe('MCP tool results report truncation', () => {
  it('jev_ask carries the flag when its state was capped', async () => {
    const service = await runtime()
    const result = await runAsk(service, {
      state: { note: OVERSIZED },
      questions: { relevant: { type: 'noul', instructions: 'Does this matter?' } },
    })

    expect(result.truncated).toBe(true)
    expect(result.egress?.truncated).toBe(true)
    expect(result.egress?.stateChars).toBeLessThanOrEqual(16_000)
  })

  it('jev_rank carries the flag, and still reports the candidates it was given', async () => {
    const service = await runtime()
    const candidates = Array.from({ length: 10 }, () => 'y'.repeat(4_000))
    const result = await runRank(service, { query: 'Which matter?', candidates })

    expect(result.truncated).toBe(true)
    expect(result.egress?.truncated).toBe(true)

    // The asymmetry that made this a defect rather than a cosmetic omission: the
    // ranking echoes every candidate at full length, so the reply reads as if the
    // whole list had been judged. The flag is the only thing that says otherwise.
    expect(result.ranking).toHaveLength(10)
    expect(result.ranking[0]?.candidate).toHaveLength(4_000)
  })

  it('jev_check carries the flag when the evidence was capped', async () => {
    const service = await runtime()
    const result = await runCheck(service, { claim: 'The flag is honest.', evidence: OVERSIZED })

    expect(result.truncated).toBe(true)
    expect(result.egress?.truncated).toBe(true)
  })

  it('leaves an ordinary result exactly as it was', async () => {
    const service = await runtime()
    const result = await runRank(service, {
      query: 'Which matter?',
      candidates: ['alpha', 'beta'],
    })

    // Absent, not `false`: adding a `truncated: false` to every reply would be a
    // shape change for every existing caller in exchange for nothing.
    expect('truncated' in result).toBe(false)
    expect(result.egress?.truncated).toBe(false)
    expect(result.egress?.stateChars).toBeLessThan(16_000)
  })
})

describe('the rank candidate bound is the one the description states', () => {
  /**
   * The tool description tells the model that an ordinary criterion fits 20
   * candidates and that the 21st is refused rather than dropped. These numbers
   * come from the question template and the declared `questions` cap, so editing
   * either without editing the description is exactly the drift this test exists
   * to catch.
   */
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => `candidate ${i} `.padEnd(40, 'x').slice(0, 40))

  it('accepts 20 candidates under the default criterion and refuses the 21st', async () => {
    const service = await runtime()

    await expect(runRank(service, { query: 'Which matter?', candidates: candidates(20) })).resolves.toBeDefined()

    await expect(runRank(service, { query: 'Which matter?', candidates: candidates(21) })).rejects.toThrow(
      /over the declared limit/,
    )
  })

  it('refuses far sooner when the criterion is long, because it is repeated per candidate', async () => {
    const service = await runtime()
    const criterion = 'y'.repeat(400)

    await expect(
      runRank(service, { query: 'Which matter?', candidates: candidates(7), criterion }),
    ).resolves.toBeDefined()

    await expect(
      runRank(service, { query: 'Which matter?', candidates: candidates(8), criterion }),
    ).rejects.toThrow(/over the declared limit/)
  })
})
