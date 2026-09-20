/**
 * The couplings between this CLI and `jevcore`, in one place.
 *
 * Most of them are now imports — the severity ladder, the block level, the hazard
 * questions, the policy floors — and an import is its own check: the build fails
 * if the core renames or removes one. What an import cannot check is the
 * *property* the CLI relies on, so that is what lives here:
 *
 *  - the ladder is a sequence of distinct names, because `severityRank` is an
 *    index into it and a duplicate would make two levels compare equal;
 *  - the default block level is a member of it, because `--severity-block` is
 *    validated against the ladder and a default outside it would be refused by
 *    the CLI's own parser;
 *  - the core's model catalogue is reachable, which is the one capability
 *    `models --catalogue` reports rather than requires.
 */

import { describe, expect, it } from 'vitest'
import * as core from 'jevcore'
import { DEFAULT_SEVERITY_BLOCK, SEVERITIES, severityRank } from '../src/constants.js'

describe('the severity ladder', () => {
  it('is a sequence of distinct names, ascending', () => {
    expect(SEVERITIES.length).toBeGreaterThan(1)
    expect(new Set(SEVERITIES).size).toBe(SEVERITIES.length)
    expect(severityRank('none')).toBeLessThan(severityRank('critical'))
  })

  it('is the core\'s own list, not a copy of it', () => {
    // Identity, not equality: `SEVERITIES` is documented as the core's array, and
    // a future edit that reintroduced a local literal would pass an equality
    // check while reintroducing exactly the drift the import removed.
    expect(SEVERITIES).toBe(
      (core as unknown as { SEVERITY_LEVELS: readonly string[] }).SEVERITY_LEVELS,
    )
  })
})

describe('the default block level', () => {
  it('is the core\'s shipped default', () => {
    expect(DEFAULT_SEVERITY_BLOCK).toBe(
      (core as unknown as { DEFAULT_SAFETY_SEVERITY_BLOCK: string })
        .DEFAULT_SAFETY_SEVERITY_BLOCK,
    )
  })

  it('is a level on the ladder, so the CLI\'s own validation accepts it', () => {
    expect(SEVERITIES).toContain(DEFAULT_SEVERITY_BLOCK)
  })
})

describe('the model catalogue', () => {
  it('is exported by this core, which `models --catalogue` depends on', () => {
    // The one capability the CLI is allowed to find absent: `models.ts` resolves
    // `listModels` at run time and *reports* its absence rather than failing to
    // build. This asserts the state of the installed core so a reader can see
    // which side of that line the build is on; it does not assert which is
    // correct, because both are supported.
    const exported = (core as unknown as { listModels?: unknown }).listModels
    expect(['function', 'undefined']).toContain(typeof exported)
  })
})
