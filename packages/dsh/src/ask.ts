/**
 * `jev_ask` —the primitive tool.
 *
 * This is the one tool that exposes Jev's raw surface: a batch of typed
 * questions over one state. The other two tools are conveniences built on the
 * same service and exist because two shapes are common enough to deserve their
 * own schema. A caller that needs something else uses this.
 *
 * The description matters as much as the code: it tells the model when *not* to
 * reach for Jev. A decision model asked to write prose produces nothing useful,
 * and a model that does not know that will keep trying.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EgressFeature } from '@dsh-jev/core'
import { assertValidBatch, choice, noul, score } from '@dsh-jev/core'
import type { JevService } from '@dsh-jev/core'
import type { JevQuestion, JsonValue } from '@dsh-jev/core'
import { asRendered, renderResult, summarize } from '@dsh-jev/core'

const FEATURE: EgressFeature = 'tool:jev_ask'

interface QuestionInput {
  readonly type: 'noul' | 'choice' | 'score'
  readonly instructions: string
  readonly criteria?: Readonly<Record<string, string | null>>
}

interface AskArgs {
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, QuestionInput>>
}

/** Convert the model-facing question shape into the request shape. */
export const toQuestions = (
  input: Readonly<Record<string, QuestionInput>>,
): Record<string, JevQuestion> => {
  const out: Record<string, JevQuestion> = {}
  for (const [id, question] of Object.entries(input)) {
    if (question.type === 'noul') {
      out[id] = noul(question.instructions)
      continue
    }
    const criteria = question.criteria ?? {}
    out[id] = question.type === 'choice'
      ? choice(question.instructions, criteria)
      : score(question.instructions, criteria)
  }
  return out
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    provider: { type: 'string' as const, required: true as const },
    model: { type: 'string' as const, required: true as const },
    latencyMs: { type: 'number' as const, required: true as const },
    answers: { type: 'json' as const, required: true as const },
    usage: { type: 'json' as const },
    warning: { type: 'string' as const },
  },
  additionalProperties: false,
}

export const jevAskTool = (service: JevService) =>
  defineTool({
    name: 'jev_ask',
    description:
      'Ask TypeSafe Jev one or more typed questions about a single piece of state. Jev does not ' +
      'generate text: it returns a selected option and calibrated probabilities. Use it for ' +
      'judgments the rest of the work branches on —routing, classifying, scoring, deciding, ' +
      'triaging. Do NOT use it to write prose, explain, summarize, or generate code.\n\n' +
      'Question types: "noul" is yes/no and returns the probability of true; "choice" picks one ' +
      'of the criteria keys you declare; "score" places the state on an ordered scale of criteria ' +
      'keys. Several questions in one call are answered against the same state and cost one ' +
      'round-trip, so batch what you need.\n\n' +
      'Put the evidence in "state" and the question in "instructions". Every key you declare in ' +
      'criteria is a value Jev may return, so declare exactly the outcomes you can act on. This ' +
      'tool returns probabilities, not decisions —apply your own confidence threshold before ' +
      'acting, and treat a low-confidence answer as "unknown" rather than picking for it.',
    parameters: {
      state: {
        type: 'json',
        required: true,
        description:
          'The evidence Jev should judge: the text, record, or facts the questions are about. ' +
          'Be aware this is transmitted to TypeSafe when the live provider is configured.',
      },
      questions: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description:
          'Map of question id to question. Each question is { type, instructions, criteria? }. ' +
          'criteria is required for choice and score and is a map of permitted answer key to an ' +
          'optional description of that key.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({ summary: summarize(asRendered(value), 'jev_ask') }),
    },
    execute: async (args, exec) => {
      const typed = args as unknown as AskArgs
      const questions = toQuestions(typed.questions)
      // Validate locally before spending a call: a malformed batch is a caller
      // bug, and Jev rejecting it would look like an upstream failure.
      assertValidBatch(questions)
      const result = await service.ask({
        feature: FEATURE,
        state: typed.state,
        questions,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      return renderResult(result, Object.keys(questions))
    },
  })
