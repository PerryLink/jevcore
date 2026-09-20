/**
 * The safety gate: judge a tool call before it runs.
 *
 * Registered on `tools/pre-execute`, off by default. When enabled, every
 * matching tool call is judged against a published list of hazards before
 * dispatch, and against a severity score that says how damaging the call would
 * be if it is wrong or malicious.
 *
 * Five things this gate deliberately does NOT do, each of which an existing
 * third-party plugin in this ecosystem does:
 *
 *  - **It cannot fail open silently.** An undecided verdict resolves through
 *    `onUndecided`, which defaults to `ask` — the human sees it. A gate that
 *    allows on uncertainty is not a gate.
 *  - **It cannot be reconfigured by the model.** Nothing in this plugin
 *    exposes a tool that changes gate behaviour. The model cannot widen,
 *    narrow, or disable the check that constrains it.
 *  - **It does not trust a probability it did not understand.** The hazards are
 *    declared here as fixed questions; Jev answers them, and local code decides.
 *  - **It cannot be talked out of a hazard.** The severity dimension only adds
 *    escalations: a hazard that crossed its floor is asked about whatever the
 *    severity says, a severity that cannot be read is undecided rather than the
 *    bottom of the ladder, and there is no setting that turns the dimension off.
 *  - **It does not trust a level Jev named outside its own ladder.** A score
 *    answer is mapped back by *position* in the rubric declared here; its own
 *    `legend` text is never read, and an index outside the ladder is undecided.
 *
 * The hazard list and the severity rubric are also the egress disclosure: this
 * is exactly what is sent.
 */

import {
  DEFAULT_SAFETY_SEVERITY_BLOCK,
  SEVERITY_LEVELS,
  type SeverityLevel,
} from '../config.js'
import type { EgressFeature } from '../egress.js'
import { noul, score } from '../primitives.js'
import { DEFAULT_POLICY, applyPolicy, type Verdict } from '../policy.js'
import type { JevService } from '../service.js'
import { JevProviderError, type JevQuestion } from '../types.js'

export const SAFETY_FEATURE: EgressFeature = 'gate:safety'

/**
 * The hazards asked about, in order. Each is a yes/no question; a `true`
 * probability above the policy floor asks the human before the call proceeds.
 *
 * Public because this list is a disclosure: an operator enabling the gate is
 * entitled to know what it looks for, and a test asserts the questions actually
 * sent match this declaration. The severity score below is disclosed the same
 * way, and {@link SAFETY_QUESTIONS} is the batch they form together.
 */
export const HAZARD_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  irreversible_destruction: noul(
    'Does this tool call destroy data or state in a way that cannot be undone (deleting files or ' +
      'rows, dropping a database, discarding uncommitted work, force-overwriting a file)?',
  ),
  privilege_escalation: noul(
    'Does this tool call escalate privileges, change permissions or ownership, modify system ' +
      'configuration, or disable a security control?',
  ),
  credential_exposure: noul(
    'Does this tool call send credential material, private keys, or secrets to a remote endpoint, ' +
      'or write them somewhere they would be exposed?',
  ),
  external_side_effect: noul(
    'Does this tool call affect a system outside this workspace in a way that is hard to reverse ' +
      '(publishing, deploying, pushing to a shared branch, sending a message, spending money)?',
  ),
  history_rewrite: noul(
    'Does this tool call rewrite shared history or discard work that is not this session’s own ' +
      '(force-push, hard reset, rebase of published commits, deleting a branch)?',
  ),
}

/** The id the severity score is keyed by: in the answer map, and in the reason. */
export const SEVERITY_QUESTION_ID = 'severity'

/**
 * The severity rubric: level name to the description Jev receives, ascending.
 *
 * Typed as a total `Record` over {@link SeverityLevel} so a rung with no
 * description is a compile error rather than a silently missing level — a
 * level's position in the sent array *is* its score, so dropping one would
 * renumber every rung above it and the answer would map back to the wrong name
 * (see `scoreCriteriaArray`).
 *
 * The descriptions ask about damage *if the call is wrong or malicious*, which
 * is the question the guardrails cookbook scores beside its hazard nouls ("How
 * much harm could result if the assistant complied with this message?"). They
 * are deliberately not about how alarming a command looks: `rm -rf` of this
 * session's own scratch directory is `none`, and a well-formed force-push to a
 * shared branch is `high` because of what it cannot bring back.
 *
 * @see https://docs.typesafe.ai/cookbooks/llm_guardrails
 */
const SEVERITY_RUBRIC: Readonly<Record<SeverityLevel, string>> = {
  none:
    'No damage: it touches only this session’s own scratch state, and re-running it costs ' +
    'nothing.',
  low:
    'Minor: recoverable by re-running or one correction; nothing outside the workspace ' +
    'changes.',
  moderate:
    'Bounded: local or uncommitted work can be lost, or a change outside the workspace that a ' +
    'human can still undo.',
  high:
    'Serious: work or data is lost for good, a shared system is altered, or a secret is ' +
    'exposed.',
  critical:
    'Severe: production data or infrastructure is destroyed, secrets are published, or nothing ' +
    'can undo it.',
}

/**
 * The severity question, declared the way the hazards above are declared and for
 * the same reason: it is part of what leaves the machine.
 *
 * One `score` question rather than a sixth `noul`, because "is this dangerous?"
 * is what the hazards already ask and a yes cannot tell "delete one scratch
 * file" from "drop the production database" — both are a plain yes. A scale asks
 * *how much*, which is the only thing a threshold can be set against.
 *
 * The instruction is a string because the ladder below it supplies the
 * structure: five described rungs, in order, which is exactly the separation of
 * definitions the API's guidance asks for. Restating them in the instruction
 * would send the same text twice.
 */
export const SEVERITY_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  [SEVERITY_QUESTION_ID]: score(
    'How damaging would this tool call be if it is wrong, or if it were malicious? Rate the ' +
      'damage the call itself does, not how alarming it looks.',
    Object.fromEntries(SEVERITY_LEVELS.map((level) => [level, SEVERITY_RUBRIC[level]])),
  ),
}

/**
 * Everything one safety call transmits: the hazards plus the severity score.
 *
 * The object a test compares against what the provider actually received, so a
 * question that is asked without being declared here is a test failure rather
 * than a quiet widening of what leaves the machine.
 */
export const SAFETY_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  ...HAZARD_QUESTIONS,
  ...SEVERITY_QUESTIONS,
}

/**
 * Tools the gate applies to.
 *
 * A denylist of tool-name fragments rather than an allowlist of every tool:
 * a gate that only recognises one naming scheme silently stops applying the
 * moment a new execution tool appears. Matching is prefix/substring based so
 * `pwsh`, `bash`, `shell`, and a `mcp__*__shell` variant are all covered.
 */
export const DEFAULT_GATED_TOOL_PATTERNS: readonly string[] = [
  'pwsh',
  'bash',
  'shell',
  'exec',
  'write',
  'edit',
  'delete',
  'remove',
  'move',
  'rename',
  'git',
  'run_code',
]

export interface GateDecision {
  readonly kind: 'allow' | 'deny' | 'ask'
  readonly reason?: string
  /** Hazards whose probability crossed the threshold. */
  readonly raised?: readonly string[]
  /**
   * The severity level Jev assigned, when one could be read off the declared
   * ladder.
   *
   * Absent — not `none` — when the severity was undecided or unreadable, so a
   * caller cannot mistake "the gate could not tell" for "the gate was told the
   * call is harmless".
   */
  readonly severity?: SeverityLevel
}

export interface SafetyGateOptions {
  readonly service: JevService
  /** What to do when the policy cannot decide. */
  readonly onUndecided: 'ask' | 'allow' | 'deny'
  /** Minimum probability for a hazard to be considered raised. */
  readonly minProbability?: number
  /** Minimum Jev confidence for an answer to count. */
  readonly minConfidence?: number
  /**
   * Severity at or above which the call is escalated to `ask` even though no
   * hazard crossed its floor. Defaults to `DEFAULT_SAFETY_SEVERITY_BLOCK`.
   *
   * Only ever escalates: the level is compared beside the hazards' verdicts and
   * cannot withdraw one. A threshold outside the ladder escalates everything
   * rather than nothing, which is the direction a mistyped value has to fail in.
   */
  readonly severityBlock?: SeverityLevel
  /** Tool-name fragments this gate applies to. */
  readonly toolPatterns?: readonly string[]
  /** Extra context appended to the judged state, e.g. the workspace root. */
  readonly describeContext?: () => string | undefined
}

/** Whether the gate applies to a tool name. */
export const isGated = (name: string, patterns: readonly string[] = DEFAULT_GATED_TOOL_PATTERNS): boolean => {
  const lower = name.toLowerCase()
  return patterns.some((pattern) => lower.includes(pattern))
}

/**
 * The ladder's indices, as strings: a score answer's distribution is keyed by
 * rubric position, and these are the positions this gate declared.
 */
const LADDER_INDICES: readonly string[] = SEVERITY_LEVELS.map((_, index) => String(index))

/**
 * The severity level a resolved verdict names, or `undefined` when it names none.
 *
 * Read by *position* through {@link SEVERITY_LEVELS}, never from the answer's own
 * `legend` text: matching descriptions would let a provider choose the level by
 * echoing a string this module already sent it.
 *
 * `applyPolicy` has already applied the operator's floors, so `undecided` and
 * `invalid` both arrive here as "no level" — and so does an index outside the
 * ladder, because the argmax path inside `applyPolicy` is not filtered by the
 * declared criteria. That range check is why this function exists rather than a
 * cast at the call site.
 *
 * `undefined` is the only failure value, on purpose. Returning `none` would be
 * indistinguishable from Jev having said the call is harmless, and inventing
 * that reading is the one thing this gate must never do.
 */
const severityLevelOf = (verdict: Verdict): SeverityLevel | undefined => {
  if (verdict.kind !== 'decided') return undefined
  const index = LADDER_INDICES.indexOf(verdict.answer)
  return index === -1 ? undefined : SEVERITY_LEVELS[index]
}

/**
 * Whether a level is at or above the block threshold, by position in the ladder.
 *
 * `at or above`, not `above`: the cookbook's own comparison is
 * `severity >= severity_block`, so a call sitting exactly on the line is asked
 * about. The comparison is positional rather than against Jev's numeric score,
 * because the expected score may fall between rungs and a number would then
 * depend on where the rubric happens to put them.
 *
 * A threshold that is not a ladder member — which config validation refuses, but
 * a caller can still cast past — ranks below every level and so escalates
 * everything rather than nothing. That is the direction a mistyped setting has
 * to fail in.
 */
const atOrAboveBlock = (level: SeverityLevel, block: SeverityLevel): boolean =>
  SEVERITY_LEVELS.indexOf(level) >= SEVERITY_LEVELS.indexOf(block)

/**
 * Serialize tool arguments for judging.
 *
 * Byte-capped at the call site by the egress contract, and stable-ordered so
 * the same call always produces the same state — which keeps the offline test
 * fixtures meaningful.
 */
export const serializeArguments = (args: unknown): string => {
  try {
    const serialized = JSON.stringify(args)
    return serialized ?? String(args)
  } catch {
    // A cyclic or otherwise unserializable argument set is itself worth
    // flagging, but failing here would deny every call. Describe it instead.
    return '[arguments could not be serialized]'
  }
}

/**
 * Build the pre-execute hook.
 *
 * Returns a function from a tool call to a decision; the caller owns what to do
 * with it. It never throws for a provider failure, and it never returns `allow`
 * for a question it could not judge unless the operator explicitly configured
 * `onUndecided: 'allow'`.
 */
export const createSafetyGate = (options: SafetyGateOptions) => {
  const patterns = options.toolPatterns ?? DEFAULT_GATED_TOOL_PATTERNS

  /**
   * The thresholds, resolved once.
   *
   * `applyPolicy` already enforces both floors before a verdict can be
   * `decided`, so `decide` below must not re-test the probability against a
   * second, hardcoded value: doing so silently overrode the operator's setting,
   * letting a hazard through at 0.62 even when they had asked for 0.9.
   */
  const policy = {
    // Referenced rather than restated: this value used to be literal here, in the
    // context gate, in DEFAULT_CONFIG and in DEFAULT_POLICY — four copies of one
    // number, so tuning any of them left the others enforcing something else.
    minConfidence: options.minConfidence ?? DEFAULT_POLICY.minConfidence,
    minProbability: options.minProbability ?? DEFAULT_POLICY.minProbability,
  }

  /**
   * Where the severity line sits, resolved once, from configuration and the
   * shipped default. Never from model output, and never from the answer's own
   * legend: see {@link DEFAULT_SAFETY_SEVERITY_BLOCK}.
   */
  const block: SeverityLevel = options.severityBlock ?? DEFAULT_SAFETY_SEVERITY_BLOCK

  /**
   * The line a human reads when the gate stops a call.
   *
   * Factual, and deliberately without an instruction. The reason is attached to
   * an `ask`, and a host with no approval service registered converts that `ask`
   * into a *denial* — while keeping this text, so the host's own more accurate
   * fallback never gets a chance to replace it. Nothing in this package can see
   * that seam and it must not grow a way to: "approve to proceed" is an
   * instruction the operator cannot follow in exactly the deployment where they
   * are most likely to be reading it. Naming the hazard and the level is true in
   * both deployments.
   */
  const stopReason = (
    raised: readonly string[],
    severity: SeverityLevel | undefined,
    escalated: boolean,
  ): string => {
    const facts: string[] = []
    if (raised.length > 0) facts.push(`Jev flagged ${raised.join(', ')}`)
    if (severity === undefined) {
      facts.push('the severity could not be judged')
    } else if (escalated) {
      facts.push(`the severity "${severity}" is at or above the "${block}" block level`)
    } else {
      facts.push(`the severity is "${severity}"`)
    }
    return `jevcore safety gate: ${facts.join('; ')}.`
  }

  const decide = (
    verdicts: Readonly<Record<string, Verdict>>,
    severity: SeverityLevel | undefined,
  ): GateDecision => {
    const raised: string[] = []
    let undecided: string | undefined

    for (const [hazard, verdict] of Object.entries(verdicts)) {
      // A `decided` verdict has already cleared both floors inside `applyPolicy`.
      if (verdict.kind === 'decided' && verdict.answer === 'true') {
        raised.push(hazard)
        continue
      }
      if (verdict.kind !== 'decided') undecided ??= hazard
    }

    // An unreadable severity is one more thing this gate could not judge, so it
    // joins the hazards on the undecided path — the same `onUndecided` handling,
    // naming the severity question the way an undecided hazard is named. Reading
    // it as the bottom of the ladder would instead let a question the gate did
    // not understand decide that the call is harmless.
    if (severity === undefined) undecided ??= SEVERITY_QUESTION_ID

    const escalated = severity !== undefined && atOrAboveBlock(severity, block)

    // Hazards first, and unconditionally: a call that raised one is asked about
    // whatever the severity says. The severity branch can therefore only add an
    // escalation, never trade one away.
    if (raised.length > 0 || escalated) {
      return {
        kind: 'ask',
        reason: stopReason(raised, severity, escalated),
        ...(raised.length === 0 ? {} : { raised }),
        ...(severity === undefined ? {} : { severity }),
      }
    }
    if (undecided !== undefined) {
      if (options.onUndecided === 'allow') return { kind: 'allow' }
      if (options.onUndecided === 'deny') {
        return {
          kind: 'deny',
          reason: `jevcore safety gate: could not judge ${undecided} (onUndecided=deny).`,
        }
      }
      return {
        kind: 'ask',
        reason: `jevcore safety gate: could not judge ${undecided}.`,
      }
    }
    return { kind: 'allow', ...(severity === undefined ? {} : { severity }) }
  }

  return async (input: {
    readonly name: string
    readonly args: unknown
    readonly signal?: AbortSignal
  }): Promise<GateDecision> => {
    if (!isGated(input.name, patterns)) return { kind: 'allow' }
    if (!options.service.egress.allows(SAFETY_FEATURE)) {
      // The egress contract is the authority. A gate that ran while its
      // transmission was disabled would be judging nothing and saying nothing.
      return { kind: 'allow' }
    }

    const context = options.describeContext?.()
    const state = {
      tool: input.name,
      arguments: serializeArguments(input.args),
      ...(context === undefined ? {} : { context }),
    }

    let result
    try {
      result = await options.service.ask({
        feature: SAFETY_FEATURE,
        state,
        questions: SAFETY_QUESTIONS,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      // A gate that cannot reach its judge must not wave the call through as if
      // it had been checked. Route the failure through the same undecided path.
      const detail = error instanceof JevProviderError ? error.code : 'unavailable'
      if (options.onUndecided === 'allow') return { kind: 'allow' }
      return {
        kind: options.onUndecided === 'deny' ? 'deny' : 'ask',
        reason: `jevcore safety gate could not reach Jev (${detail}).`,
      }
    }

    const verdicts: Record<string, Verdict> = {}
    for (const [hazard, question] of Object.entries(HAZARD_QUESTIONS)) {
      if (question.type !== 'noul') continue
      verdicts[hazard] = applyPolicy(result.answers[hazard], ['true', 'false'], policy)
    }

    // The severity answer goes through `applyPolicy` like every other question,
    // so the operator's floors and the undecided/invalid handling are the same
    // code path rather than a second, laxer comparison invented for this one.
    const severity = severityLevelOf(
      applyPolicy(result.answers[SEVERITY_QUESTION_ID], LADDER_INDICES, policy),
    )
    return decide(verdicts, severity)
  }
}
