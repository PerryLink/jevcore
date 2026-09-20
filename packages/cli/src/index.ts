/**
 * `jevcore-cli` — the `jev` command line, over the `jevcore` decision core.
 *
 * A fourth entry point over the same core as the library, the MCP server and the
 * DeepSeek Harness plugin: one decision layer, four transports. Nothing here
 * re-implements a judgment. `ask` calls `JevService.ask`, `check` calls
 * `resolveCheck`, `gate` calls `createSafetyGate`, and `egress` calls
 * `EgressContract.reportLines` — so a decision made at a shell prompt means what
 * it means in a session.
 *
 * The package exports its parts rather than only its executable, so the same
 * command surface is reachable from Node: `main` takes argv, the environment and
 * the streams as arguments, which is what makes the whole tool testable
 * in-process and usable as a library by another tool that wants `gate`'s answer
 * without spawning a process.
 */

export { main, classifyFailure, contextFor, VERSION } from './main.js'
export { parseInvocation, COMMANDS, hasFlag, optionalString, requireString, stringList } from './args.js'
export type { Invocation } from './args.js'
export {
  EXIT,
  type CliEnv,
  type CommandContext,
  type CommandRun,
  type ExitCode,
  type ParsedArgs,
} from './types.js'
export { COMMAND_HELP, HELP, PROGRAM, UsageError, helpFor } from './usage.js'
export { parseJsonArgument, readJson, readText } from './input.js'
export { toJson, egressLines, callEgressLines, answerLine, resultLines } from './format.js'
export {
  BUDGET_OVERRIDE_ENV,
  DEFAULT_ENDPOINTS,
  SDK_OVERRIDE_ENV,
  armedFeatures,
  asFeature,
  buildContext,
  buildRoute,
  chooseProvider,
  egressFor,
  enabledFeatures,
  loadStubSdk,
  provenanceLine,
  resolveEndpoint,
  resolveModel,
  resolveRoute,
  type Route,
  type RoutePlan,
  type ServiceContext,
} from './runtime.js'
export { toQuestions } from './questions.js'
export { runAsk } from './commands/ask.js'
export { exitForVerdict, runCheck, verdictLine } from './commands/check.js'
export { runRank, INDEPENDENCE_NOTE, candidateQuestion, candidateQuestionId, orderRanking } from './commands/rank.js'
export {
  RAISED_SEVERITY,
  blocksAt,
  exitForDecision,
  runGate,
  severityOfDecision,
} from './commands/gate.js'
export { runEgress } from './commands/egress.js'
export { runModels } from './commands/models.js'
export {
  CHECK_THRESHOLDS,
  DEFAULT_RANK_CRITERION,
  DEFAULT_SEVERITY_BLOCK,
  FEATURE,
  GATE_POLICY,
  HAZARDS,
  SEVERITIES,
  isSeverity,
  severityOf,
  severityRank,
  worstSeverity,
  type Severity,
} from './constants.js'
