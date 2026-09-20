/**
 * The usage text, and the one exit path for a command that was written wrong.
 *
 * The help text is a string constant rather than a template built from the
 * command table on purpose: a reader runs `jev --help` to find out what this
 * tool does, and the answer has to be a document someone wrote, not a rendering
 * of an argument parser's internal shape. The table below would produce a list
 * of flags; this produces an explanation.
 */

import { EXIT } from './types.js'

/** The name this tool is installed as. Used in every message it prints. */
export const PROGRAM = 'jev'

/**
 * Thrown for a command line the CLI will not run.
 *
 * Carries its own exit code because every usage failure exits {@link EXIT.USAGE}
 * and `main` should not have to decide that a second time.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError'
  readonly exitCode = EXIT.USAGE
}

/** The full help document, printed by `jev --help` and by `jev help`. */
export const HELP = `jev - TypeSafe Jev decisions from a shell or a CI job.

Usage: ${PROGRAM} <command> [flags]

Commands:
  ask      Answer one batch of typed questions against a state.
  check    Verify a claim against evidence; prints a verdict and probabilities.
  rank     Order candidates by relevance to a query.
  gate     Dry-run the safety gate against a hypothetical tool call.
  egress   Print what this tool may send, and the cap on each field.
  models   Print the models and endpoints this tool would use.

Global flags:
  --json              Machine-readable output on stdout. Stable field names.
  --provider <kind>   mock | live | openrouter. Default: mock.
                      "mock" is offline and produces synthetic answers; the other
                      two transmit, and need a credential.
  --mock              Force the offline mock provider. Same as --provider mock.
  --model <id>        Model to call. Defaults to jev-latest.
  --endpoint <url>    API root for a transmitting provider.
  -h, --help          Print this text.
  -v, --version       Print the version.

Exit codes:
  0  allowed / supported / printed
  1  denied / contradicted / input error
  2  the gate would ask a human (gate only)
  3  no verdict: conflicted, insufficient, undecided or unknown (check only)
  64 command line error

Environment:
  TYPESAFE_API_KEY      credential for the "live" provider
  OPENROUTER_API_KEY    credential for the "openrouter" provider
  JEV_PROVIDER          default for --provider
  TYPESAFE_BASE_URL     default for --endpoint (live)
  OPENROUTER_BASE_URL   default for --endpoint (openrouter)

Run "${PROGRAM} <command> --help" for a command's own flags.

Nothing leaves the machine unless a transmitting provider was selected. The
credential is read from the environment or the shell's environment, is passed
to the provider, and is never printed.`

/**
 * The per-command help documents, keyed by command name.
 *
 * Separate from {@link HELP} for the same reason that document is hand-written:
 * the flags a command accepts are only half of what a reader needs — the other
 * half is what the exit codes mean for that command, which no parser can derive.
 */
export const COMMAND_HELP: Readonly<Record<string, string>> = {
  ask: `${PROGRAM} ask - answer one batch of typed questions against a state.

Usage: ${PROGRAM} ask --state <file|-> --questions <file|-> --feature <name> [flags]

Flags:
  --state <file|->      JSON state to judge. "-" reads standard input.
  --questions <file|->  JSON object of question definitions: id -> question.
  --feature <name>      Egress feature to send under. Must be one of the declared
                        features; run "${PROGRAM} egress" to list them.
  --model <id>          Model to call.
  --mock                Force the offline mock provider.
  --json                Machine-readable output.

A question is { "type": "noul" | "choice" | "score", "instructions": ... } with
"criteria" for choice and score, and "boundary" for a noul.

Exit codes:
  0  answers returned
  1  the request could not be made
  64 the command line or the question definitions are wrong`,

  check: `${PROGRAM} check - verify a claim against evidence.

Usage: ${PROGRAM} check --claim <text> --evidence <file|-> [flags]

Flags:
  --claim <text>        The claim being checked.
  --evidence <file|->   Evidence to check it against. "-" reads standard input.
  --model <id>          Model to call.
  --mock                Force the offline mock provider.
  --json                Machine-readable output.

Prints one of six verdicts, then the three probabilities behind it:
  supported      the evidence supports the claim and was judged sufficient
  contradicted   the evidence contradicts the claim
  conflicted     the evidence both supports and contradicts it
  insufficient   the evidence does not establish the claim
  undecided      the evidence settles the question but points neither way
  unknown        no measurement came back at all

Exit codes:
  0  supported
  1  contradicted, or the request could not be made
  3  conflicted, insufficient, undecided or unknown
  64 the command line is wrong

Three outcomes rather than two because the last four words are findings about
the evidence, not about the claim. A script that read them as "not supported"
would be reporting a refutation nobody measured.`,

  rank: `${PROGRAM} rank - order candidates by relevance to a query.

Usage: ${PROGRAM} rank --query <text> --candidates <file|-> --criterion <text> [flags]

Flags:
  --query <text>        The task, question or need being ranked against.
  --candidates <file|-> JSON array of strings. "-" reads standard input.
  --criterion <text>    What relevance means here, as a yes/no question.
  --model <id>          Model to call.
  --mock                Force the offline mock provider.
  --json                Machine-readable output.

The per-candidate numbers are INDEPENDENT probabilities. One candidate at 0.9 and
another at 0.8 does not mean the first is more likely to be *the* answer, and the
numbers do not sum to 1. They rank a shortlist; nothing more.

Exit codes:
  0  a ranking was produced
  1  the request could not be made
  64 the command line is wrong`,

  gate: `${PROGRAM} gate - dry-run the safety gate against a hypothetical tool call.

Usage: ${PROGRAM} gate --tool <name> --args <file|-> [--severity-block <level>] [flags]

Flags:
  --tool <name>              The tool name the call would use.
  --args <file|->            JSON tool arguments. "-" reads standard input.
  --args-json <json>         The same arguments, inline.
  --severity-block <level>   Block at this severity or above:
                             none | low | medium | high | critical.
                             Default: high.
  --model <id>               Model to call.
  --mock                     Force the offline mock provider.
  --json                     Machine-readable output.

This runs the gate's own hazard questions and reports what it decided. Nothing is
executed: the tool name and arguments are data, and no tool is invoked. An
operator can therefore see what the gate would do before switching it on, and a
CI job can ask without a DeepSeek Harness host.

The decision is reported with the severity of what was raised:
  allow  nothing was raised, or the gate could not decide and its policy allows
  ask    a hazard crossed its threshold, or the gate could not judge the call
  deny   a hazard was raised at or above --severity-block

Exit codes:
  0  allow
  1  deny
  2  ask
  64 the command line is wrong`,

  egress: `${PROGRAM} egress - print what this tool may send and the cap on each field.

Usage: ${PROGRAM} egress [--feature <name> ...] [flags]

Flags:
  --feature <name>   Feature to arm. Repeatable. Default: every declared feature.
  --provider <kind>  Which provider the report should describe.
  --endpoint <url>   Endpoint to name in the report.
  --json             Machine-readable output.

Every feature that can transmit declares the fields it would send and the cap on
each. This prints that declaration as it applies to this invocation, so a person
can read one screen and know what would leave the machine.

Exit codes:
  0  the report was printed
  64 an unknown feature or flag was named`,

  models: `${PROGRAM} models - print the models and endpoints this tool would use.

Usage: ${PROGRAM} models [--catalogue] [flags]

Flags:
  --catalogue        Ask the API what this account can call. One authenticated
                     request; never made without this flag.
  --provider <kind>  Which provider to describe.
  --model <id>       The model that provider would call.
  --endpoint <url>   API root, when one is configured.
  --json             Machine-readable output.

Without --catalogue this is a local resolution, not a catalogue: it reports the
model each route would send, whether a credential for it exists, and where it
would post - all read from this machine, with nothing fetched.

Exit codes:
  0  the report was printed
  64 an unknown flag was named, or --catalogue was combined with the mock`,
}

/**
 * The help document for a command.
 *
 * An unknown command yields the general help rather than an error of its own:
 * the caller reached this function because they named something, and the useful
 * answer is the list of things they could have named.
 */
export const helpFor = (command: string | undefined): string =>
  command === undefined ? HELP : (COMMAND_HELP[command] ?? HELP)
