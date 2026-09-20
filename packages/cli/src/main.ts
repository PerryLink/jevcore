/**
 * `main` — the one place a command is chosen, run, and turned into an exit code.
 *
 * Everything outside `bin.ts` is a library: `main` takes its argv, its
 * environment and its streams as arguments, so a test can run the whole tool
 * in-process with its own inputs and assert on what came out. `bin.ts` is a
 * three-line adapter that supplies the real ones, which is why the tool's
 * behaviour is testable without spawning a process, without a socket, and without
 * a credential.
 *
 * Failure handling is here rather than in the commands, and it distinguishes
 * three things a caller reacts to differently:
 *
 *  - **A usage error**, which the caller fixes by editing the command line. 64.
 *  - **A domain refusal**, such as an egress feature that is not enabled or a
 *    payload over its declared cap. These are `jevcore`'s own error types, and
 *    they are reported as configuration findings rather than as crashes.
 *  - **A provider failure**, which is the network or the credential. 1.
 *
 * Nothing here catches a programming error. An unexpected exception propagates
 * out of `main` and out of the process, because swallowing one would turn a bug
 * into a verdict — and a verdict is what a CI job branches on.
 */

import {
  EgressDeniedError,
  EgressTooLargeError,
  JevProviderError,
  ConfigError,
} from 'jevcore'
import { parseInvocation } from './args.js'
import { runAsk } from './commands/ask.js'
import { runCheck } from './commands/check.js'
import { runEgress } from './commands/egress.js'
import { runGate } from './commands/gate.js'
import { runModels } from './commands/models.js'
import { runRank } from './commands/rank.js'
import { toJson } from './format.js'
import { EXIT, type CliEnv, type CommandContext, type CommandRun } from './types.js'
import { PROGRAM, UsageError, helpFor } from './usage.js'

/** The version this build reports. Kept in step with `package.json` by hand. */
export const VERSION = '0.3.1'

/** Every command, mapped to its implementation. */
const RUNNERS: Readonly<Record<string, CommandRun>> = {
  ask: runAsk,
  check: runCheck,
  rank: runRank,
  gate: runGate,
  egress: runEgress,
  models: runModels,
}

/**
 * What a failure should be reported as.
 *
 * `hint` is separated from `message` on purpose: a message says what happened and
 * a hint says what to do about it, and a caller parsing `--json` can act on the
 * second without reading prose.
 */
interface FailureReport {
  readonly message: string
  readonly errorCode: string | undefined
  readonly hint: string | undefined
  readonly exit: number
}

/**
 * Classify a thrown value.
 *
 * The order of the checks follows the class hierarchy, not the alphabet:
 * `EgressDeniedError` and `EgressTooLargeError` are not `JevProviderError`s, so
 * they are tested first, and each gets a hint that names the actual remedy — an
 * undeclared feature is fixed by editing the command line, a cap overflow by
 * sending less, a missing key by setting a variable.
 */
export const classifyFailure = (error: unknown): FailureReport => {
  if (error instanceof UsageError) {
    return { message: error.message, errorCode: 'usage', hint: undefined, exit: error.exitCode }
  }
  if (error instanceof EgressDeniedError) {
    return {
      message: error.message,
      errorCode: 'egress-denied',
      hint:
        'The egress contract decides what may leave the machine, and it has not enabled this ' +
        `feature. Run "${PROGRAM} egress" to see which features are declared, and name one with ` +
        '--feature.',
      exit: EXIT.FAIL,
    }
  }
  if (error instanceof EgressTooLargeError) {
    return {
      message: error.message,
      errorCode: 'egress-too-large',
      hint: 'Send a smaller payload: the declared cap is on the field named in the message.',
      exit: EXIT.FAIL,
    }
  }
  if (error instanceof JevProviderError) {
    return {
      message: error.message,
      errorCode: error.code,
      hint:
        error.code === 'no-credential'
          ? 'Set the named environment variable, or pass --mock to run offline.'
          : undefined,
      exit: EXIT.FAIL,
    }
  }
  if (error instanceof ConfigError) {
    return { message: error.message, errorCode: 'config', hint: undefined, exit: EXIT.FAIL }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    errorCode: undefined,
    hint: undefined,
    exit: EXIT.FAIL,
  }
}

/**
 * Whether the raw words ask for machine-readable output.
 *
 * Read from the words rather than from the parsed flags because a command line
 * that fails to parse has no flags to read — and `--json` is exactly the mode in
 * which a caller needs a parseable report *of* that failure.
 */
const wantsJson = (argv: readonly string[]): boolean => argv.includes('--json')

/** Run one command line. Returns the process exit code. */
export const main = async (argv: readonly string[], io: CliEnv): Promise<number> => {
  const json = wantsJson(argv)

  let invocation
  try {
    invocation = parseInvocation(argv)
  } catch (error) {
    return fail(io, error, json, 'unknown')
  }

  if (invocation.kind === 'version') {
    io.out(VERSION)
    return EXIT.OK
  }

  if (invocation.kind === 'help') {
    const text = helpFor(invocation.command)
    // Help goes to stdout with exit 0 when a command or `--help` asked for it,
    // and to stderr with 64 when the command line named nothing at all. The
    // distinction is the difference between a request and a mistake, and a shell
    // script that runs `jev` with no arguments should not read it as success.
    if (argv.length === 0) {
      io.err(text)
      return EXIT.USAGE
    }
    io.out(text)
    return EXIT.OK
  }

  const command = invocation.command
  const runner = RUNNERS[command]
  if (runner === undefined) {
    return fail(io, new UsageError(`unknown command "${command}"`), json, command)
  }

  try {
    return await runner({ args: invocation.args, io, cwd: process.cwd() })
  } catch (error) {
    return fail(io, error, json, command)
  }
}

/** Report a failure on both channels and return its exit code. */
const fail = (io: CliEnv, error: unknown, json: boolean, command: string): number => {
  const report = classifyFailure(error)
  // stderr always carries the human sentence, whether or not JSON was asked for:
  // a person watching a terminal is the more common reader of a failed CI step,
  // and the JSON consumer is not reading stderr at all.
  io.err(`${PROGRAM} ${command}: ${report.message}`)
  if (report.hint !== undefined) io.err(`${PROGRAM}: ${report.hint}`)

  if (json) {
    io.out(
      toJson({
        ok: false,
        command,
        provider: 'none',
        model: '',
        latencyMs: 0,
        error: report.message,
        ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
        ...(report.hint === undefined ? {} : { hint: report.hint }),
        exitCode: report.exit,
      }),
    )
  }
  return report.exit
}

/**
 * A `CommandContext`-shaped value, for callers that run one command directly.
 *
 * Exported for tests: when the thing under test is a command rather than the
 * dispatcher, running it through argv would test the parser twice and the command
 * once.
 */
export const contextFor = (
  args: CommandContext['args'],
  io: CliEnv,
  cwd: string = process.cwd(),
): CommandContext => ({ args, io, cwd })

export { EXIT, helpFor }
