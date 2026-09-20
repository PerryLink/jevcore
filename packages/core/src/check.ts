/**
 * Claim verification: resolve a set of `noul` answers into one verdict.
 *
 * Framework-agnostic on purpose — it takes a {@link JevResult} and returns a
 * judgment, so the same resolution backs the DSH tool, an MCP tool, or a plain
 * script.
 *
 * The shape of the answer is the point. A single yes/no cannot distinguish
 * "not supported" from "actively refuted", and those call for different
 * actions. So three independent questions are asked — supports, contradicts,
 * sufficient — and this module resolves them with an explicit precedence order
 * that lives in code, not in the model.
 *
 * The precedence is not arbitrary, and it is stated here because two of its
 * rules were wrong in ways that produced a verdict contradicting the
 * probabilities printed beside it:
 *
 *  1. **A missing answer is never a favourable answer.** Only an explicit
 *     sufficiency answer permits `supported`.
 *  2. **Strong contradiction outranks everything.** Evidence that both supports
 *     and refutes a claim is a conflict, not a weak yes.
 *  3. **Strong contradiction outranks weak evidence too**, even when the
 *     evidence was judged unable to settle the question: "this is false" is more
 *     useful to a caller than "this is unsettled".
 *  4. **Evidence judged sufficient, with neither side strong, is `undecided`** —
 *     not `insufficient`. `insufficient` already means "the evidence does not
 *     settle the claim", and it cannot also mean "the evidence does settle it but
 *     points nowhere".
 */

import type { JevResult } from './types.js'

/** The question ids this module reads. */
export const VERDICT_QUESTION = {
  supports: 'supports_claim',
  contradicts: 'contradicts_claim',
  sufficient: 'evidence_is_sufficient',
} as const

/**
 * The verdict resolved from three probabilities.
 *
 * `undecided` was added because `insufficient` was carrying two different
 * findings. A payload reading `verdict: "insufficient", sufficient: 0.9895`
 * contradicts itself: the word says the evidence does not settle the claim and
 * the number beside it says the opposite. The second reading — the evidence
 * settles the question, but support and contradiction are both too weak to name
 * an answer — now has its own value.
 *
 * The five original words keep their meanings exactly.
 */
export type CheckVerdict =
  /** Support cleared its threshold and the evidence was judged sufficient. */
  | 'supported'
  /** Contradiction cleared its threshold. */
  | 'contradicted'
  /** Both sides cleared their thresholds. */
  | 'conflicted'
  /**
   * The evidence does not establish the claim: either support was below
   * threshold, or the evidence was judged unable to settle the question.
   */
  | 'insufficient'
  /**
   * The evidence was judged sufficient to settle the question, yet neither
   * support nor contradiction reached its threshold.
   */
  | 'undecided'
  /** No answer came back at all. */
  | 'unknown'

export interface CheckResolution {
  readonly verdict: CheckVerdict
  readonly supports: number | undefined
  readonly contradicts: number | undefined
  readonly sufficient: number | undefined
}

export interface CheckThresholds {
  /** Probability of `supports_claim` needed for a `supported` verdict. */
  readonly support: number
  /** Probability of `contradicts_claim` needed for a `contradicted` verdict. */
  readonly contradiction: number
  /** Below this, `evidence_is_sufficient` reads as insufficient. */
  readonly sufficiency: number
}

export const DEFAULT_CHECK_THRESHOLDS: CheckThresholds = {
  support: 0.7,
  contradiction: 0.7,
  sufficiency: 0.5,
}

const readNoul = (result: JevResult, questionId: string): number | undefined => {
  const answer = result.answers[questionId]
  return answer?.type === 'noul' ? answer.noul : undefined
}

/**
 * Resolve three probabilities into one verdict. Pure, so the precedence is
 * testable.
 *
 * The rules, in order, and why each sits where it does:
 *
 *  0. Neither support nor contradiction answered at all → `unknown`. This is the
 *     only thing `unknown` means; a missing *sufficiency* answer does not make a
 *     verdict unknown, because support was measured and the answer is a finding
 *     about it.
 *  1. Both sides strong → `conflicted`. Checked first: evidence that both
 *     supports and refutes is a finding in itself, and reporting it as support
 *     would be the worst available error.
 *  2. Contradiction strong → `contradicted`. Above the sufficiency test on
 *     purpose: "this is false" is more useful than "this is unsettled", so a
 *     strong contradiction is reported even when the evidence was judged unable
 *     to settle the question.
 *  3. Evidence judged *not* sufficient — explicitly below the threshold, or not
 *     answered at all → `insufficient`, whatever support said.
 *  4. Support strong, evidence sufficient → `supported`. Note that this is the
 *     only path to `supported`, which is what makes an unanswered sufficiency
 *     question fail closed.
 *  5. Anything else that still has a measurement → `undecided`.
 *
 * Rule 3 is the fix for a fail-open bug: the guard used to read
 * `sufficient !== undefined && sufficient < thresholds.sufficiency`, so an
 * *unanswered* sufficiency question skipped the check entirely and
 * `supports: 0.95` alone returned `supported`. An unanswered question is not a
 * favourable answer — the package's own rendering rule says the opposite ("a
 * missing answer is reported as missing; nothing is filled in") — and a
 * provider that returns fewer answers than were asked must not thereby earn a
 * stronger verdict.
 *
 * Rule 5 is the fix for a self-contradicting payload: the last branch used to
 * return `insufficient` whenever neither side cleared its threshold, even when
 * the sufficiency answer said the evidence *did* settle the question. That
 * shipped as `verdict: "insufficient"` next to `sufficient: 0.9895`.
 */
export const resolveCheck = (
  result: JevResult,
  thresholds: CheckThresholds = DEFAULT_CHECK_THRESHOLDS,
): CheckResolution => {
  const supports = readNoul(result, VERDICT_QUESTION.supports)
  const contradicts = readNoul(result, VERDICT_QUESTION.contradicts)
  const sufficient = readNoul(result, VERDICT_QUESTION.sufficient)

  const base = { supports, contradicts, sufficient }
  if (supports === undefined && contradicts === undefined) {
    return { verdict: 'unknown', ...base }
  }

  const supportIsStrong = (supports ?? 0) >= thresholds.support
  const contradictionIsStrong = (contradicts ?? 0) >= thresholds.contradiction
  // Only an explicit answer counts. `undefined` is not sufficiency.
  const evidenceIsSufficient = sufficient !== undefined && sufficient >= thresholds.sufficiency

  if (supportIsStrong && contradictionIsStrong) {
    return { verdict: 'conflicted', ...base }
  }
  if (contradictionIsStrong) {
    return { verdict: 'contradicted', ...base }
  }
  if (!evidenceIsSufficient) {
    return { verdict: 'insufficient', ...base }
  }
  if (supportIsStrong) {
    return { verdict: 'supported', ...base }
  }
  // Sufficient evidence, neither side strong: a real finding, and not the same
  // one as "the evidence does not settle this".
  return { verdict: 'undecided', ...base }
}
