/**
 * `jev_check` - does this evidence actually support this claim?
 *
 * A thin DSH adapter: it declares the tool schema, asks the three fixed
 * questions - each carrying the boundary that defines what its yes and what its
 * no mean - and hands the answers to `resolveCheck` in the core, which owns the
 * precedence rules and is tested independently of this runtime. What this
 * adapter adds on top is {@link reconcileVerdict}: the guards that keep the
 * verdict it reports consistent with the probabilities it reports beside it.
 *
 * The verdict vocabulary is the reason the tool exists. "Insufficient" and
 * "contradicted" call for different actions, and a boolean cannot tell them
 * apart - see the core's `check.ts` for the precedence order and why
 * contradiction outranks support.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_CHECK_THRESHOLDS,
  EGRESS_FIELDS,
  VERDICT_QUESTION,
  noul,
  renderResult,
  resolveCheck,
  type CheckThresholds,
  type EgressFeature,
  type JevService,
} from 'jevcore'

const FEATURE: EgressFeature = 'tool:jev_check'

/**
 * The declared egress cap on this tool's `state` field, which carries the claim
 * and the evidence.
 *
 * Read from the core's contract rather than restated, for the same reason
 * `rank.ts` reads its caps: the number the model is told has to be the number
 * `EgressContract.measure` enforces. Declared rather than effective — an
 * operator's `maxStateChars` overrides it and nothing at this call site sees
 * those settings.
 */
export const STATE_CHAR_CAP: number =
  EGRESS_FIELDS[FEATURE].find((field) => field.field === 'state')?.maxChars ?? 16_000

type CheckArgs = {
  claim: string
  evidence: string
}

/**
 * Every verdict this tool can return, in the order the description lists them.
 *
 * Exported so a test can hold the description to it. A vocabulary in prose is
 * worth nothing if the code can return a word the prose never mentions, or if
 * the prose advertises one no code path can produce - and both defects were
 * here: the description offered the distinction between "not supported" and
 * "contradicted" while no verdict of that name exists, and the resolver's own
 * `insufficient` was carrying two different findings at once.
 */
export const TOOL_VERDICTS = [
  'supported',
  'contradicted',
  'conflicted',
  'insufficient',
  'undecided',
  'unknown',
] as const

/**
 * The type is derived from the list, not written out beside it, so the two
 * cannot drift - and `reconcileVerdict` stops compiling if the core ever adds a
 * verdict to its own `CheckVerdict` union that this list does not cover.
 *
 * `undecided` is the one value this adapter adds to the core's vocabulary.
 */
export type ToolVerdict = (typeof TOOL_VERDICTS)[number]

/**
 * One resolved verdict, with the probabilities it reports beside it.
 *
 * Structural rather than the core's `CheckResolution` so this adapter's **own
 * output** can be fed back in - which is what makes idempotence testable - while
 * keeping the compile-time link: `resolveCheck`'s result must stay assignable
 * here, so a verdict the core adds to its vocabulary stops the build until
 * {@link TOOL_VERDICTS} covers it.
 */
export interface ResolvedVerdict {
  readonly verdict: ToolVerdict
  readonly supports: number | undefined
  readonly contradicts: number | undefined
  readonly sufficient: number | undefined
}

/**
 * The tool-level verdict: the core's resolution, plus the two guards that make
 * it say the same thing as the probabilities it ships beside.
 *
 * The core's `resolveCheck` owns the precedence order and is tested
 * independently of this runtime; this function only corrects what its result
 * claims about itself. Both defects below were reproduced against the published
 * packages (raw probe output in `work-A1-dsh.md`), and **both belong upstream in
 * `resolveCheck`** - a core fix for them is landing in parallel. This shim is
 * what keeps the published tool honest until that lands, and it is deliberately:
 *
 *  - **Narrow.** Exactly two rewrites; every other verdict passes through
 *    untouched.
 *      1. `supported` **with no sufficiency answer** (`sufficient === undefined`)
 *         becomes `insufficient`. The core returns `supported` there because its
 *         guard reads `sufficient !== undefined && sufficient <
 *         thresholds.sufficiency`, so an unanswered question skips it entirely.
 *         Fail-open is the wrong direction: an unanswered question is not a
 *         favourable answer, and the package's own rendering rule states the
 *         opposite ("a missing answer is reported as missing; nothing is filled
 *         in"). `insufficient` is the core's own label for support that does not
 *         settle the question, and it stays honest about the payload -
 *         `probabilities.sufficient` is simply absent, so nobody is told a
 *         sufficiency that was never established.
 *      2. `insufficient` **while its own sufficiency answer says otherwise**
 *         (`sufficient >= thresholds.sufficiency`) becomes `undecided`. The core
 *         returns `insufficient` whenever neither side reaches its threshold,
 *         including when the evidence was judged sufficient to settle the
 *         question. Shipped, that put `verdict: "insufficient"` next to
 *         `sufficient: 0.9895` in one payload: a single word naming two different
 *         findings ("the evidence is insufficient" and "support is
 *         insufficient"). The second reading gets its own value.
 *  - **Idempotent.** Both guards key on a state their own output cannot be in -
 *    an absent sufficiency answer, or a *core* `insufficient`. Re-applying the
 *    function to its own result therefore returns that result unchanged, so a
 *    core that already fails closed or already returns `undecided` makes this a
 *    no-op rather than a second rewrite. Held by the test named "is idempotent,
 *    so a core-side fix cannot be rewritten twice".
 *  - **One new word.** `undecided` is the only value added to the core's
 *    vocabulary, and it is the word the core fix uses too, so the two cannot
 *    disagree.
 */
export const reconcileVerdict = (
  resolved: ResolvedVerdict,
  thresholds: CheckThresholds = DEFAULT_CHECK_THRESHOLDS,
): ToolVerdict => {
  if (resolved.verdict === 'supported' && resolved.sufficient === undefined) {
    return 'insufficient'
  }
  if (
    resolved.verdict === 'insufficient' &&
    resolved.sufficient !== undefined &&
    resolved.sufficient >= thresholds.sufficiency
  ) {
    return 'undecided'
  }
  return resolved.verdict
}

/**
 * What "true" and what "false" mean for each of the three questions.
 *
 * The upstream v1 boundary definition, finally wired up: these three nouls were
 * asked with a bare string, and the docs' own guardrail cookbook defines every
 * hazard this way. Two of the three are doing work that the question text alone
 * could not. `supports` is explicit that silence is not support, because the
 * failure this tool exists to catch is evidence that reads as supportive while
 * being silent on what the claim actually asserts; `sufficient` separates "the
 * evidence settles it" from "the evidence merely mentions it". Without those,
 * a model is free to read `supports` as "related to the claim".
 */
const CHECK_BOUNDARY = {
  supports: {
    true: 'The evidence states the claim, or states premises that entail it.',
    false:
      'The evidence does not state the claim and does not entail it, including when it is ' +
      'silent on what the claim asserts or merely consistent with it.',
  },
  contradicts: {
    true: 'The evidence states that the claim is false, or states premises that entail its falsity.',
    false:
      'The evidence does not state and does not entail that the claim is false, including when ' +
      'it is silent on the claim or merely fails to support it.',
  },
  sufficient: {
    true: 'The evidence as given settles whether the claim is true; no further evidence is needed.',
    false:
      'The evidence leaves a decisive part of the claim open, for example because it is silent ' +
      'on what the claim actually asserts, so more evidence is needed to settle it.',
  },
} as const

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
    // Declared because `execute` returns them: `renderResult` computes both, and a
    // handler that rebuilds its payload out of `rendered` fields drops them
    // silently. See the note in `execute`.
    truncated: { type: 'boolean' as const },
    egress: { type: 'json' as const },
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
      'a verdict of "supported", "contradicted", "conflicted", "insufficient", "undecided", or ' +
      '"unknown", with the underlying probabilities behind it.\n\n' +
      '"supported" means the evidence supports the claim and is sufficient to settle it; ' +
      '"contradicted" means the evidence contradicts it; "conflicted" means it does both; ' +
      '"insufficient" means the evidence does not establish the claim, either because support ' +
      'is below threshold or because the evidence was judged unable to settle the question; ' +
      '"undecided" means the evidence was judged sufficient to settle it, yet neither support ' +
      'nor contradiction reached its threshold; "unknown" means no answer came back at all.\n\n' +
      'Use it before repeating a claim you have not verified, when reconciling two sources, or to ' +
      'decide whether what you read actually answers the question you asked. The distinction ' +
      'between "insufficient" and "contradicted" is the reason to use this tool rather than ' +
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
          'The evidence to judge the claim against - quote it rather than paraphrasing. The ' +
          `claim plus the evidence must serialise inside ${STATE_CHAR_CAP.toLocaleString('en-US')} ` +
          'characters: over that the state is truncated rather than refused, Jev judges a fragment ' +
          'of your own text, and the result carries "truncated": true. This text is transmitted ' +
          'to TypeSafe when the live provider is configured.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        summary: `${(value as { verdict?: string }).verdict ?? '?'} - jev_check`,
      }),
    },
    // Read-only judgment over a claim and a piece of evidence the caller already
    // holds; nothing is mutated, and two checks commute. Without this the
    // registry classifies every call `exclusive` and independent checks run
    // strictly one after another instead of in the host's parallel pool.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const typed = args as unknown as CheckArgs
      const questions = {
        [VERDICT_QUESTION.supports]: noul(
          'Does this evidence support the claim?',
          CHECK_BOUNDARY.supports,
        ),
        [VERDICT_QUESTION.contradicts]: noul(
          'Does this evidence contradict the claim?',
          CHECK_BOUNDARY.contradicts,
        ),
        [VERDICT_QUESTION.sufficient]: noul(
          'Is this evidence sufficient to settle whether the claim is true?',
          CHECK_BOUNDARY.sufficient,
        ),
      }

      const result = await service.ask({
        feature: FEATURE,
        state: { claim: typed.claim, evidence: typed.evidence },
        questions,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })

      const resolved = resolveCheck(result, thresholds)
      const verdict = reconcileVerdict(resolved, thresholds)
      const rendered = renderResult(result, Object.keys(questions))

      return {
        provider: rendered.provider,
        model: rendered.model,
        latencyMs: rendered.latencyMs,
        verdict,
        probabilities: {
          ...(resolved.supports === undefined ? {} : { supports: resolved.supports }),
          ...(resolved.contradicts === undefined ? {} : { contradicts: resolved.contradicts }),
          ...(resolved.sufficient === undefined ? {} : { sufficient: resolved.sufficient }),
        },
        answers: rendered.answers,
        ...(rendered.usage === undefined ? {} : { usage: rendered.usage }),
        ...(rendered.warning === undefined ? {} : { warning: rendered.warning }),
        // Forwarded for the reason the core's `RenderedResult.truncated` gives:
        // they change how the verdict has to be read. `renderResult` computed both
        // and this return dropped them, so an evidence string over the state cap
        // was replaced by a `[truncated]` envelope — Jev judged a prefix of the
        // caller's own JSON rather than the evidence — and the payload still read
        // as a verdict about the evidence that was sent. Measured with one 17,000
        // character evidence string, which a free-text field reaches trivially.
        ...(rendered.truncated === true ? { truncated: true } : {}),
        // Spread, and the two arrays copied, so the value is lossless JSON: the
        // core's `JevEgressFacts` is an interface (no implicit index signature)
        // whose array members are `readonly`, which the output schema's inferred
        // `JsonValue` refuses.
        ...(rendered.egress === undefined ? {} : {
          egress: {
            ...rendered.egress,
            redactedFields: [...rendered.egress.redactedFields],
            redactionRules: [...rendered.egress.redactionRules],
          },
        }),
      }
    },
  })