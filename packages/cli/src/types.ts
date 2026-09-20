/**
 * Shared vocabulary for the `jev` CLI.
 *
 * The one idea worth reading before the commands: **every route through this
 * package goes through `JevService`**, so the egress contract stays the single
 * authority on what may leave the machine. Nothing here calls a provider
 * directly, and no command can transmit a feature the contract has not enabled.
 *
 * The second idea is the exit-code table below. It is part of the public
 * interface, not an implementation detail: a CI job branches on the number, and
 * a shell user reads it through `$?`. So the numbers are declared once, here,
 * with the reason each one is distinct.
 */

/**
 * Process exit codes, as a closed set.
 *
 * These are a contract. A GitHub Action is written against them, so a change
 * here is a breaking change to this package's interface, not a tweak.
 *
 * `1` is shared between "a judgment came back negative" and "a file could not be
 * read", and that is deliberate rather than sloppy: `EXIT_IO` used to be a
 * number of its own, and no caller can meaningfully act on the difference
 * between "your evidence file is missing" and "the evidence contradicts the
 * claim" beyond reading stderr. What a caller *can* act on is the difference
 * between a verdict, a refusal to judge, and a crash, and those all have
 * distinct numbers below.
 *
 * The numbers are under 16 on purpose. A POSIX shell reports a signal death as
 * `128 + signal`, and a tool whose own codes reach into that range is a tool
 * whose wrapper cannot tell "the CLI exited 130" from "the CLI was SIGHUPed".
 */
export const EXIT = {
  /** The command ran and its outcome was affirmative. */
  OK: 0,
  /**
   * The command ran and its outcome was negative: `check` contradicted the
   * claim, `gate` denied the call. Also used for an input or environment error,
   * which is a different finding with the same caller reaction: stop.
   */
  FAIL: 1,
  /**
   * The gate would have asked a human. Distinct from `FAIL` because nothing has
   * been refused — the call is waiting on a decision nobody has made yet, and a
   * CI job that treats "needs approval" as "denied" is a CI job that blocks
   * every change the gate is unsure about.
   */
  ASK: 2,
  /**
   * The judgment is not a yes and not a no: `check` returned `conflicted`,
   * `insufficient`, `undecided`, or `unknown`.
   *
   * Three outcomes rather than two because the words mean three different
   * things to whoever reads them. `supported` and `contradicted` are findings
   * about the claim. The other four are findings about the *evidence* — it
   * argues with itself, it does not settle the question, it settles the question
   * without pointing anywhere, or no measurement came back at all — and a caller
   * that reads "the evidence is silent" as "the claim is false" has been told
   * something nobody measured. Collapsing them onto `1` would erase exactly that
   * distinction at the only place a script can see it.
   */
  NO_VERDICT: 3,
  /**
   * The command itself was wrong: an unknown command, an unknown flag, a missing
   * required flag, an undeclared egress feature.
   *
   * Separate from `FAIL` because it is the one failure the caller can fix by
   * editing the command line, and a typo is worth telling apart from a verdict
   * in a log. It follows the `sysexits.h` value for "command line usage error",
   * which is the convention a shell already knows.
   */
  USAGE: 64,
} as const

/**
 * One of the numbers in {@link EXIT}.
 *
 * Spelled as a union of the values rather than as `(typeof EXIT)[number]`: a
 * `const` object with literal properties has no numeric index signature, so the
 * indexed form does not typecheck under `noUncheckedIndexedAccess`.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 64

/**
 * The environment a command runs against, passed in rather than read from the
 * ambient process.
 *
 * Everything a command touches from outside itself arrives through this object:
 * the filesystem root is implicit, but stdin, both output streams, and the
 * environment are explicit. That is what makes the whole surface testable
 * in-process — a test runs `main` with its own streams and its own environment
 * object, so it cannot reach a socket, cannot read the shell's real key, and
 * cannot scribble on the terminal.
 */
export interface CliEnv {
  /** The environment variables visible to this run, e.g. `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Read standard input to the end.
   *
   * A function rather than a stream so `-` means the same thing in every command
   * and a caller that never uses `-` never touches the stream.
   */
  readonly readStdin: () => Promise<string>
  /** Write one line to the command's primary output. Payloads only. */
  readonly out: (line: string) => void
  /**
   * Write one line to the diagnostic channel.
   *
   * Every human-facing note that is not the answer belongs here, and so does
   * every warning. In `--json` mode stdout must stay a single parseable
   * document, and a report line written to stdout would turn the payload into
   * two documents and break every consumer of it.
   */
  readonly err: (line: string) => void
}

/** What `parseArgs` produced for one command: flag name to value. */
export interface ParsedArgs {
  readonly command: string | undefined
  readonly values: Readonly<Record<string, string | boolean | readonly string[] | undefined>>
  /** Positional operands, in order. */
  readonly positionals: readonly string[]
}

/** A command implementation: everything it needs, and the code it exits with. */
export type CommandRun = (context: CommandContext) => Promise<number>

/** Everything one command invocation is given. */
export interface CommandContext {
  readonly args: ParsedArgs
  readonly io: CliEnv
  /** `process.cwd()`, injected so a test can point a command at a fixture. */
  readonly cwd: string
}
