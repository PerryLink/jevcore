/**
 * The fixed vocabulary this CLI shares with the rest of the project.
 *
 * Every constant here is either read from `jevcore` or derived from a core
 * export. Nothing is restated, and that is the point: the ranking default
 * criterion and the check question wording already exist in
 * `packages/mcp/src/tools.ts`, and the hazard questions and policy floors live in
 * `packages/core/src/gates/safety.ts`. A CLI that wrote its own copies would be
 * the third place a change has to be made, and the first place it is forgotten.
 */

import {
  DEFAULT_CHECK_THRESHOLDS,
  DEFAULT_NOUL_BAND,
  DEFAULT_POLICY,
  DEFAULT_SAFETY_SEVERITY_BLOCK,
  HAZARD_QUESTIONS,
  SEVERITY_LEVELS,
  type CheckThresholds,
  type EgressFeature,
  type PolicyOptions,
  type SeverityLevel,
} from 'jevcore'

/** The egress feature each command transmits under. */
export const FEATURE: Readonly<Record<'ask' | 'rank' | 'check' | 'gate', EgressFeature>> = {
  ask: 'tool:jev_ask',
  rank: 'tool:jev_rank',
  check: 'tool:jev_check',
  gate: 'gate:safety',
}

/**
 * The ranking criterion used when `--criterion` is omitted.
 *
 * Byte-identical to the MCP server's own default (`packages/mcp/src/tools.ts`),
 * and that is deliberate rather than coincidental: the same capability behind two
 * entry points must not rank by two different questions, because the comparison
 * between an MCP run and a CLI run is exactly what a reader would do next.
 */
export const DEFAULT_RANK_CRITERION =
  'Does the candidate hold information that would help answer the query?'

/**
 * The claim-verification thresholds.
 *
 * The core's own defaults, referenced rather than restated. They are the numbers
 * that decide which of the six verdicts a caller gets, so a second copy here
 * would be a second answer to the same question.
 */
export const CHECK_THRESHOLDS: CheckThresholds = DEFAULT_CHECK_THRESHOLDS

/**
 * The policy the `gate` command judges individual hazards with.
 *
 * The core defaults, with one addition a dry run needs: `accept: { true: false,
 * false: true }`. It states what the safety gate already means in code — a hazard
 * that resolved to `true` is the bad outcome, one that resolved to `false` is not
 * — as policy, so each hazard's own reading can be reported rather than only a
 * raised/not-raised bit.
 *
 * Nothing here changes what the gate decides: `createSafetyGate` applies its own
 * policy internally and the exit code comes from the gate. This object only
 * describes what each hazard said on the way there.
 */
export const GATE_POLICY: PolicyOptions = {
  minConfidence: DEFAULT_POLICY.minConfidence,
  minProbability: DEFAULT_POLICY.minProbability,
  accept: { true: false, false: true },
}

/** The hazard question ids, in the order the core declares them. */
export const HAZARDS: readonly string[] = Object.keys(HAZARD_QUESTIONS)

/**
 * The severity ladder, ascending, as the core declares it.
 *
 * **Imported, never restated.** The core owns this list — its safety gate reads
 * every severity level off it by position, and its configuration validates
 * `--severity-block` against it — so a CLI copy would be a second source of truth
 * for the one vocabulary a gate decision is reported in. `SEVERITY_LEVELS` was
 * added to the core's public exports while this package was being written, and
 * this import is the whole of the integration.
 */
export const SEVERITIES: readonly SeverityLevel[] = SEVERITY_LEVELS

/** One of {@link SEVERITIES}, under the core's own name for it. */
export type Severity = SeverityLevel

/**
 * The block level `--severity-block` defaults to, when the flag is not given.
 *
 * The core's own shipped default, imported for the same reason the ladder is: the
 * gate enforces it in a session, so a CLI that defaulted to something else would
 * be answering a different question from the one a session asks.
 */
export const DEFAULT_SEVERITY_BLOCK: Severity = DEFAULT_SAFETY_SEVERITY_BLOCK

/**
 * The severity one hazard's probability is reported at.
 *
 * Used only where the core's gate reported no level of its own — a core older
 * than the severity dimension, where the only signal is *whether* a hazard
 * cleared its floor. The boundaries are the core's published noul band and its
 * midpoints, so nothing here is a number only this file knows: below half the
 * band's low edge is `none`, between that and the low edge is `low`, the
 * uncertain middle splits at its midpoint, and anything above the band's high
 * edge is `critical`.
 */
export const severityOf = (probability: number): Severity => {
  const { low, high } = DEFAULT_NOUL_BAND
  if (probability < low / 2) return 'none'
  if (probability < low) return 'low'
  if (probability <= (low + high) / 2) return 'moderate'
  if (probability <= high) return 'high'
  return 'critical'
}

/** The severity a whole decision is reported at: the highest any hazard reached. */
export const worstSeverity = (severities: readonly Severity[]): Severity =>
  severities.reduce<Severity>(
    (worst, current) => (SEVERITIES.indexOf(current) > SEVERITIES.indexOf(worst) ? current : worst),
    'none',
  )

/**
 * Where a severity sits on its own scale.
 *
 * Exported for `--severity-block` comparisons, so "at or above the configured
 * level" is one comparison against one number rather than a chain of `||` that
 * has to be kept in the same order as {@link SEVERITIES}.
 */
export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity)

/** Whether a word names one of {@link SEVERITIES}. */
export const isSeverity = (value: string): value is Severity =>
  (SEVERITIES as readonly string[]).includes(value)
