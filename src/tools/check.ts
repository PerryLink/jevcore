/**
 * `jev_check` â?does this evidence actually support this claim?
 *
 * The shape of the answer is the whole point. A single yes/no produces a
 * useless result for the common case where the evidence *contradicts* the
 * claim: "not supported" and "actively refuted" call for different actions, and
 * a boolean cannot tell them apart.
 *
 * So Jev is asked three independent questions â?supports, contradicts,
 * sufficient â?and this tool resolves them into one verdict. The resolution is
 * local code with an explicit precedence order, not something Jev decides.
 *
 * The precedence matters: contradiction wins over support. Evidence that both
 * supports and contradicts a claim is not a partial yes, it is a conflict, and
 * reporting it as "supported" would be the most damaging possible error here.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EgressFeature } from '../egress.js'
import { noul } from '../primitives.js'
import type { JevService } from '../service.js'
import type { JevResult } from '../types.js'
import { renderResult } from './render.js'

const FEATURE: EgressFeature = 'tool:jev_check'

export const VERDICT_QUESTION = {
  supports: 'supports_claim',
  contradicts: 'contradicts_claim',
  sufficient: 'evidence_is_sufficient',
} as const

/** The verdict this tool resolves to. */
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

/**
 * Resolve three probabilities into one verdict.
 *
 * Exported and pure so the precedence is testable on its own.
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

interface CheckArgs {
  readonly claim: string
  readonly evidence: string
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    provider: { type: 'string' as const, required: true as const },
    model: { type: 'string' as const, required: true as const },
    latencyMs: { type: 'number' as const, required: true as const },
    verdict: { type: 'string' as const, required: true as const },
    probabilities: { type: 'json' as const, required: true as const },
    answers: { type: 'json' as const, required: true as const },
    usage: { type: 'json' as const },
    warning: { type: 'string' as const },
  },
  additionalProperties: false,
}

export const jevCheckTool = (
  service: JevService,
  thresholds: CheckThresholds = DEFAULT_CHECK_THRESHOLDS,
) =>
  defineTool({
    name: 'jev_check',
    description:
      'Check whether a piece of evidence supports a specific claim, using TypeSafe Jev. Returns ' +
      'a verdict of "supported", "contradicted", "conflicted", "insufficient", or "unknown", ' +
      'with the underlying probabilities.\n\n' +
      'Use it before repeating a claim you have not verified, when reconciling two sources, or to ' +
      'decide whether what you read actually answers the question you asked. The distinction ' +
      'between "not supported" and "contradicted" is the reason to use this tool rather than ' +
      'reading the evidence yourself and guessing.\n\n' +
      'This tool judges one claim against the evidence you give it. It does not search for ' +
      'evidence, and it cannot detect that you omitted the decisive passage â?a confident verdict ' +
      'on incomplete evidence is still a verdict on incomplete evidence.',
    parameters: {
      claim: {
        type: 'string',
        required: true,
        description: 'The single, specific claim to check. One claim per call.',
      },
      evidence: {
        type: 'string',
        required: true,
        description:
          'The evidence to judge the claim against â?quote it rather than paraphrasing. This ' +
          'text is transmitted to TypeSafe when the live provider is configured.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({ summary: `${value.verdict} Â· jev_check` }),
    },
    execute: async (args, exec) => {
      const typed = args as unknown as CheckArgs
      const questions = {
        [VERDICT_QUESTION.supports]: noul('Does this evidence support the claim?'),
        [VERDICT_QUESTION.contradicts]: noul('Does this evidence contradict the claim?'),
        [VERDICT_QUESTION.sufficient]: noul(
          'Is this evidence sufficient to settle whether the claim is true?',
        ),
      }

      const result = await service.ask({
        feature: FEATURE,
        state: { claim: typed.claim, evidence: typed.evidence },
        questions,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })

      const resolved = resolveCheck(result, thresholds)
      const rendered = renderResult(result, Object.keys(questions))

      return {
        provider: rendered.provider,
        model: rendered.model,
        latencyMs: rendered.latencyMs,
        verdict: resolved.verdict,
        probabilities: {
          ...(resolved.supports === undefined ? {} : { supports: resolved.supports }),
          ...(resolved.contradicts === undefined ? {} : { contradicts: resolved.contradicts }),
          ...(resolved.sufficient === undefined ? {} : { sufficient: resolved.sufficient }),
        },
        answers: rendered.answers,
        ...(rendered.usage === undefined ? {} : { usage: rendered.usage }),
        ...(rendered.warning === undefined ? {} : { warning: rendered.warning }),
      }
    },
  })
