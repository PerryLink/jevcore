/**
 * `jev_check` - does this evidence actually support this claim?
 *
 * A thin DSH adapter: it declares the tool schema, asks the three fixed
 * questions, and hands the answers to `resolveCheck` in the core, which owns
 * the precedence rules and is tested independently of this runtime.
 *
 * The verdict vocabulary is the reason the tool exists. "Not supported" and
 * "contradicted" call for different actions, and a boolean cannot tell them
 * apart - see the core's `check.ts` for the precedence order and why
 * contradiction outranks support.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_CHECK_THRESHOLDS,
  VERDICT_QUESTION,
  noul,
  renderResult,
  resolveCheck,
  type CheckThresholds,
  type EgressFeature,
  type JevService,
} from '@dsh-jev/core'

const FEATURE: EgressFeature = 'tool:jev_check'

type CheckArgs = {
  claim: string
  evidence: string
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
      'evidence, and it cannot detect that you omitted the decisive passage - a confident verdict ' +
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
          'The evidence to judge the claim against - quote it rather than paraphrasing. This ' +
          'text is transmitted to TypeSafe when the live provider is configured.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        summary: `${(value as { verdict?: string }).verdict ?? '?'} - jev_check`,
      }),
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