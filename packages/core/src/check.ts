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
 * The precedence is not arbitrary. Contradiction outranks support: evidence
 * that both supports and refutes a claim is a conflict, not a weak yes, and
 * reporting it as "supported" would be the most damaging error available here.
 */

import type { JevResult } from './types.js'

/** The question ids this module reads. */
export const VERDICT_QUESTION = {
  supports: 'supports_claim',
  contradicts: 'contradicts_claim',
  sufficient: 'evidence_is_sufficient',
} as const

/** The verdict resolved from three probabilities. */
export type CheckVerdict = 'supported' | 'contradicted' | 'conflicted' | 'insufficient' | 'unknown'

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

/** Resolve three probabilities into one verdict. Pure, so the precedence is testable. */
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

  // Conflict first: strong evidence on both sides is a finding in itself, and
  // reporting it as support would be the worst available error.
  if ((supports ?? 0) >= thresholds.support && (contradicts ?? 0) >= thresholds.contradiction) {
    return { verdict: 'conflicted', ...base }
  }
  if ((contradicts ?? 0) >= thresholds.contradiction) {
    return { verdict: 'contradicted', ...base }
  }
  if ((supports ?? 0) >= thresholds.support) {
    // Support without sufficiency is a real distinction: the evidence points
    // the right way but does not settle the question.
    if (sufficient !== undefined && sufficient < thresholds.sufficiency) {
      return { verdict: 'insufficient', ...base }
    }
    return { verdict: 'supported', ...base }
  }
  return { verdict: 'insufficient', ...base }
}
