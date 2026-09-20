/**
 * `jev gate` — dry-run the safety gate against a hypothetical tool call.
 *
 * This is the command the rest of the package exists to make possible. The gate
 * is the highest-value thing in `jevcore` and the hardest to try: in a DeepSeek
 * Harness session it fires on `tools/pre-execute`, off by default, and its whole
 * job is to be invisible until something is dangerous. An operator could not see
 * what it would decide without arranging a dangerous tool call, and a CI job
 * could not see it at all.
 *
 * **Nothing is executed here.** The tool name and its arguments are data. No tool
 * is invoked, no file is touched, no process is started — which is what makes it
 * safe to run against a call you would never actually make, and therefore the only
 * way to answer "would the gate have stopped that?" before it matters.
 *
 * **The decision is the core gate's, not this file's.** `createSafetyGate` — the
 * function the harness plugin registers — produces the `allow`/`ask`/`deny` this
 * command reports and exits on, and the severity it read off its own ladder. Where
 * the gate could not decide a call it falls back to its own `onUndecided`, which
 * here is the same `ask` an operator sees in a session; there is no CLI flag for
 * it, because a dry run that resolved uncertainty differently from the real gate
 * would be measuring something else.
 */

import {
  DEFAULT_GATED_TOOL_PATTERNS,
  createSafetyGate,
  isGated,
  serializeArguments,
  type GateDecision,
} from 'jevcore'
import { hasFlag, optionalString, requireString } from './../args.js'
import {
  DEFAULT_SEVERITY_BLOCK,
  FEATURE,
  SEVERITIES,
  isSeverity,
  severityRank,
  type Severity,
} from './../constants.js'
import { callEgressLines, toJson } from './../format.js'
import { parseJsonArgument, readJson } from './../input.js'
import { buildContext, provenanceLine, type ServiceContext } from './../runtime.js'
import { EXIT, type CommandContext } from './../types.js'
import { PROGRAM, UsageError } from './../usage.js'

/**
 * The severity reported when the core's gate returned no level of its own.
 *
 * A constant rather than a computed grade, and its coarseness is a fact about
 * the measurement: a core without the severity dimension reports *whether* each
 * hazard cleared its floor, not the probability behind it, so there is no finer
 * signal to grade and a `critical` nobody measured would be an invented number in
 * a safety report. It is reported as the reading of the raised hazards beside the
 * gate's own kind, and it is deliberately not consulted by
 * {@link exitForDecision} — see {@link severityOfDecision}.
 */
export const RAISED_SEVERITY: Severity = 'high'

/**
 * Whether a severity is at or above the block level.
 *
 * `at or above`, not `above`: the guardrails cookbook's own comparison is
 * `severity >= severity_block`, so a call sitting exactly on the line is asked
 * about. Positional rather than numeric, because the ladder is a sequence of
 * names and its rungs are not evenly spaced quantities.
 */
export const blocksAt = (severity: Severity, blockAt: Severity): boolean =>
  severityRank(severity) >= severityRank(blockAt)

/**
 * The severity a decision is reported at, or `undefined` when there is none.
 *
 * The core reports `severity` as a ladder level when it could read one, and omits
 * it when the severity question was undecided or unreadable — absent, never
 * `none`, so "could not tell" is not mistaken for "harmless".
 *
 * `undefined` is therefore returned in two different situations, and they must
 * not be conflated: a core that predates the severity dimension, and a core that
 * asked and could not read the answer. In both, the honest report is "no level",
 * and `severityOf` below is what a *hazard's probability* would say — never a
 * substitute for a level the gate failed to read. Grading this command's own
 * fallback as a level would let `--severity-block` deny a call on the strength of
 * a number the gate never produced.
 */
export const severityOfDecision = (decision: GateDecision): Severity | undefined => {
  const reported = (decision as { readonly severity?: unknown }).severity
  return typeof reported === 'string' && isSeverity(reported) ? reported : undefined
}

/**
 * The exit code for one gate decision.
 *
 * `deny` is 1 and `ask` is 2 rather than both being 1, because they call for
 * different reactions: `deny` is a refusal, and `ask` is a call waiting on a
 * human. A CI job that read "nobody has approved this yet" as "this is forbidden"
 * would block every change the gate was merely unsure about.
 *
 * The one place this command adds to the gate's own answer is here: a call the
 * gate asked about, whose *measured* severity is at or above `--severity-block`,
 * exits as a denial. Only a level the core actually read counts — see
 * {@link severityOfDecision} — so the comparison can neither invent a severity nor
 * turn an `allow` into a denial.
 */
export const exitForDecision = (
  decision: GateDecision['kind'],
  severity: Severity | undefined,
  blockAt: Severity,
): number => {
  if (decision === 'deny') return EXIT.FAIL
  if (decision === 'ask') {
    return severity !== undefined && blocksAt(severity, blockAt) ? EXIT.FAIL : EXIT.ASK
  }
  return EXIT.OK
}

/**
 * The tool arguments, from `--args-json` or `--args`.
 *
 * Both spellings exist because both callers exist: a CI job holds its arguments
 * as a JSON string already and should not have to write a temporary file to pass
 * them, while a person debugging a real call has them in a file or on standard
 * input. Supplying both is refused rather than resolved by precedence — two
 * sources for one value is a mistake about which one was used.
 */
const readArguments = async ({ args, io }: CommandContext): Promise<unknown> => {
  const inline = optionalString(args, 'args-json')
  const fromFile = optionalString(args, 'args')
  if (inline !== undefined && fromFile !== undefined) {
    throw new UsageError(
      '--args and --args-json both name the tool arguments. Pass one: --args reads a file or ' +
        'standard input, --args-json takes the JSON inline.',
    )
  }
  if (inline !== undefined) return parseJsonArgument(inline, '--args-json')
  if (fromFile !== undefined) return readJson(fromFile, '--args', io)
  throw new UsageError(
    'the tool arguments are required: pass --args <file|-> or --args-json <json>. An empty ' +
      'argument set is --args-json "{}".',
  )
}

/** Everything one gate run has to say, before any of it is printed. */
interface GateOutcome {
  readonly gated: boolean
  readonly decision: GateDecision['kind']
  readonly reason: string | undefined
  /** Hazards whose probability crossed the gate's own floor. */
  readonly raised: readonly string[]
  /** The severity to report, which may be this command's reading of `raised`. */
  readonly severity: Severity
  /**
   * Whether {@link GateOutcome.severity} is a level the core measured.
   *
   * `false` means the installed core did not report one, so the level shown is
   * this command's reading of the raised hazards rather than a measurement — and
   * a consumer comparing levels across runs needs to know which it is holding.
   */
  readonly severityMeasured: boolean
  readonly blockAt: Severity
  readonly exitCode: number
  /** Characters of serialized arguments the gate would judge. */
  readonly argumentsChars: number
}

/** Run `gate`. */
export const runGate = async (context: CommandContext): Promise<number> => {
  const { args, io } = context
  const tool = requireString(args, 'tool', 'the tool name the call would use')
  const toolArgs = await readArguments(context)

  const requested = optionalString(args, 'severity-block')?.trim().toLowerCase()
  if (requested !== undefined && !isSeverity(requested)) {
    throw new UsageError(
      `--severity-block must be one of ${SEVERITIES.join(', ')}, got "${requested}".`,
    )
  }
  const blockAt: Severity = requested ?? DEFAULT_SEVERITY_BLOCK

  // Built before the gate runs so the contract is in place: a feature the egress
  // contract has not enabled makes the gate allow everything (see
  // `createSafetyGate`), and reporting that as a judgment would be a lie about a
  // check that never happened. Enabling it here is what makes this a dry run of
  // the gate rather than of its absence.
  const built: ServiceContext = await buildContext(args, io, [FEATURE.gate])
  io.err(provenanceLine(built.route))

  const serialized = serializeArguments(toolArgs)

  // Whether the gate would apply at all is decided by the same predicate the gate
  // uses, so a tool outside the denylist is reported as allowed-by-scope rather
  // than allowed-by-judgment. Those are different findings and a caller reading
  // "allow" needs to know which one it got: a `bash` call was judged and cleared,
  // while a call to a tool the gate does not recognise was never looked at.
  if (!isGated(tool, DEFAULT_GATED_TOOL_PATTERNS)) {
    return report(context, built, tool, {
      gated: false,
      decision: 'allow',
      reason: `"${tool}" matches none of the gated tool patterns, so the gate would not judge it.`,
      raised: [],
      severity: 'none',
      severityMeasured: false,
      blockAt,
      exitCode: EXIT.OK,
      argumentsChars: serialized.length,
    })
  }

  const decision = await createSafetyGate({
    service: built.service,
    onUndecided: 'ask',
    // Handed to the core so the gate enforces the same line this command reports.
    // A core that predates the option ignores it and the comparison in
    // `exitForDecision` still applies it — see the note there.
    ...{ severityBlock: blockAt },
  })({ name: tool, args: toolArgs })

  for (const line of callEgressLines(built.service.stats().lastCall)) io.err(line)

  const severity = severityOfDecision(decision)
  const severityReported =
    severity ?? ((decision.raised?.length ?? 0) > 0 ? RAISED_SEVERITY : 'none')
  return report(context, built, tool, {
    gated: true,
    decision: decision.kind,
    reason: decision.reason,
    raised: decision.raised ?? [],
    // A core that reported no level is reported as unmeasured rather than as a
    // grade, and the raised hazards are graded beside it so a reader still has
    // the reading this command can honestly give.
    severity: severityReported,
    severityMeasured: severity !== undefined,
    blockAt,
    exitCode: exitForDecision(decision.kind, severity, blockAt),
    argumentsChars: serialized.length,
  })
}

/**
 * Print one gate outcome and return its exit code.
 *
 * All of the output lives here so the by-scope path and the judged path cannot
 * drift: a caller piping either into `jq` gets the same field names, and `gated`
 * is the field that says which one it received.
 */
const report = (
  { args, io }: CommandContext,
  built: ServiceContext,
  tool: string,
  outcome: GateOutcome,
): number => {
  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'gate',
        provider: built.route.kind,
        model: built.route.model,
        latencyMs: 0,
        data: {
          tool,
          gated: outcome.gated,
          decision: outcome.decision,
          exitCode: outcome.exitCode,
          severity: outcome.severity,
          severityMeasured: outcome.severityMeasured,
          blockAt: outcome.blockAt,
          raised: outcome.raised,
          reason: outcome.reason,
          argumentsChars: outcome.argumentsChars,
          toolPatterns: DEFAULT_GATED_TOOL_PATTERNS,
          credential: built.route.keySource,
        },
      }),
    )
    return outcome.exitCode
  }

  io.out(`${PROGRAM} gate ${tool}${outcome.gated ? '' : '  (not a gated tool)'}`)
  io.out(
    `decision: ${outcome.decision}  severity: ${outcome.severity}  ` +
      `(blocks at ${outcome.blockAt})  exit: ${outcome.exitCode}`,
  )
  if (outcome.raised.length === 0) {
    io.out('  no hazard was raised')
  } else {
    for (const hazard of outcome.raised) io.out(`  RAISED  ${hazard}`)
  }
  if (outcome.reason !== undefined) io.out(`reason: ${outcome.reason}`)
  io.out('nothing was executed: this is a dry run, and the arguments above are data.')
  return outcome.exitCode
}
