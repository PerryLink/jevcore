/**
 * The context gate: keep the turn from filling with results that say nothing.
 *
 * Registered on `tools/post-execute`, off by default. Its job is narrow on
 * purpose, because a post-execute gate can block but cannot remove what is
 * already in context — pretending otherwise would be the kind of overclaim this
 * project exists to avoid.
 *
 * What it actually does: when a tool result is large but judged uninformative,
 * it is replaced with a short corrective note that tells the model what to do
 * differently. What it does *not* do: recover context already spent, or re-judge
 * earlier results.
 *
 * Two guards keep it from becoming a nuisance, which is the failure mode of
 * every context-pruning plugin in this ecosystem:
 *
 *  - **Small results are never judged.** Below `minChars` the gate does not run
 *    at all — no call, no transmission, no opinion. Most results are small.
 *  - **It fails open.** If Jev is unreachable or undecided, the result is kept.
 *    Losing a real result to a phantom "irrelevant" verdict is worse than
 *    keeping an uninformative one, and the model can still ask again.
 */

import type { EgressFeature } from '../egress.js'
import { noul } from '../primitives.js'
import { applyPolicy } from '../policy.js'
import type { JevService } from '../service.js'
import { JevProviderError, type JevQuestion } from '../types.js'

export const CONTEXT_FEATURE: EgressFeature = 'gate:context'

/**
 * The two questions asked about one large result.
 *
 * `is_relevant` is the blocking question; `restates_goal` distinguishes "this is
 * off-topic" from "this merely repeats what we already knew", which call for
 * different next steps. Both are disclosed here because they are what leaves
 * the machine.
 */
export const CONTEXT_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  is_relevant: noul(
    'Is this tool result relevant to making progress on the task described above? Answer false ' +
      'if it is boilerplate, an error unrelated to the task, navigation or index noise, a listing ' +
      'with no bearing on the task, or content that plainly does not help.',
  ),
  adds_information: noul(
    'Does this tool result add information that was not already stated in the task description ' +
      'above? Answer false if it only restates what was already given.',
  ),
}

export interface ContextGateOptions {
  readonly service: JevService
  /**
   * Minimum result size before the gate judges anything. Default 4000
   * characters: below this, judging costs more than the context it could save.
   */
  readonly minChars?: number
  /** Below this relevance probability the result is blocked. */
  readonly minRelevance?: number
  /** Minimum Jev confidence for its answer to count. */
  readonly minConfidence?: number
  /**
   * Supplies the task description the result is judged against. When absent,
   * only `adds_information` is asked — judging relevance without knowing the
   * goal would be guessing.
   */
  readonly describeGoal?: () => string | undefined
}

export interface ContextGateDecision {
  /** True when the caller should replace the result content. */
  readonly block: boolean
  readonly feedback?: string
  readonly reason?: string
}

/** Flatten a result's content blocks into the text the gate judges. */
/**
 * One content block, as this module is willing to see it.
 *
 * Deliberately loose: a real `ContentBlock` may carry an image, an attachment or
 * an arbitrary payload, and this function has to be total over any of them. A
 * narrower annotation would reject a genuine block for having an extra field,
 * which is a typing failure rather than a runtime one — the caller would have to
 * cast to satisfy it. Only `type` and `text` are ever read.
 */
export type ResultBlock = { readonly type?: unknown; readonly text?: unknown } & {
  readonly [key: string]: unknown
}

/**
 * Flatten a result's content to the text a gate may judge.
 *
 * Everything that is not a text block contributes nothing, so a base64 blob in
 * an image block never reaches the state Jev receives — where it would be billed
 * as input and would leak the image.
 */
export const resultText = (content: readonly ResultBlock[] | undefined): string => {
  if (content === undefined) return ''
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

const TRUNCATION_NOTE =
  '\n\n[original result withheld by the dsh-jev context gate; re-run a narrower query if you need it]'

export const createContextGate = (options: ContextGateOptions) => {
  const minChars = options.minChars ?? 4_000
  const minRelevance = options.minRelevance ?? 0.4

  return async (input: {
    readonly toolName: string
    readonly content: readonly ResultBlock[] | undefined
    readonly signal?: AbortSignal
  }): Promise<ContextGateDecision> => {
    const text = resultText(input.content)
    if (text.length < minChars) return { block: false }
    if (!options.service.egress.allows(CONTEXT_FEATURE)) return { block: false }

    const goal = options.describeGoal?.()
    const questions: Record<string, JevQuestion> = { ...CONTEXT_QUESTIONS }
    // Without a goal, "is this relevant" has no referent. Ask only what can be
    // answered without one.
    if (goal === undefined || goal.trim().length === 0) delete questions.is_relevant

    let result
    try {
      result = await options.service.ask({
        feature: CONTEXT_FEATURE,
        state: {
          tool: input.toolName,
          ...(goal === undefined ? {} : { task: goal.slice(0, 2_000) }),
          result: text,
        },
        questions,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      // Fail open: a judge we cannot reach must never cost the model a result.
      const detail = error instanceof JevProviderError ? error.code : 'unavailable'
      return { block: false, reason: `jev unavailable (${detail})` }
    }

    const policy = {
      minConfidence: options.minConfidence ?? 0.7,
      minProbability: minRelevance,
    }

    const relevance = questions.is_relevant
      ? applyPolicy(result.answers.is_relevant, ['true', 'false'], policy)
      : undefined
    const adds = applyPolicy(result.answers.adds_information, ['true', 'false'], policy)

    // Only a confident "not relevant" blocks. Everything else keeps the result.
    if (relevance?.kind === 'decided' && relevance.answer === 'false') {
      return {
        block: true,
        feedback:
          `The result from ${input.toolName} was judged not relevant to the task ` +
          `(relevance ${Math.round((1 - relevance.probability) * 100)}% against). It was withheld ` +
          `to save context. Try a narrower query, or state what you are looking for.`,
      }
    }
    if (adds.kind === 'decided' && adds.answer === 'false') {
      return {
        block: true,
        feedback:
          `The result from ${input.toolName} only restated information already given. It was ` +
          `withheld to save context. Use what you already have, or ask something new.`,
      }
    }
    return { block: false }
  }
}

export { TRUNCATION_NOTE }
