/**
 * Argument parsing, written by hand against `node:util`'s `parseArgs`.
 *
 * No dependency, and no schema library: the flag surface is small and each
 * command's flags are declared in one table below, so the whole grammar is
 * reviewable in a screen. `parseArgs` is a Node builtin, which matters for a
 * package whose point is to be runnable from a shell on a machine where nothing
 * has been installed.
 *
 * Two decisions worth stating:
 *
 *  - **Unknown flags are errors, never ignored.** A typo such as `--evidnce`
 *    silently dropping a required input is how a CI job ends up checking
 *    nothing and reporting success. `strict: true` turns it into a usage error.
 *  - **The commands take no positional operands.** Their inputs are named flags,
 *    so a stray word is a mistake rather than an argument, and it is refused.
 */

import { parseArgs } from 'node:util'
import { EXIT, type ParsedArgs } from './types.js'
import { PROGRAM, UsageError } from './usage.js'

/** How one flag is declared. */
interface FlagSpec {
  readonly type: 'string' | 'boolean'
  /**
   * The flag may be repeated, and every value is kept.
   *
   * Only `egress --feature` uses this so far, and it needs it: arming two
   * features in one report is the ordinary case, and a flag that silently keeps
   * only its last value would produce a report that describes half of what was
   * asked for.
   */
  readonly multiple?: boolean
}

/** Flags every command accepts. */
const GLOBAL: Readonly<Record<string, FlagSpec>> = {
  help: { type: 'boolean' },
  json: { type: 'boolean' },
  provider: { type: 'string' },
  mock: { type: 'boolean' },
  model: { type: 'string' },
  endpoint: { type: 'string' },
}

/** Flags one command accepts, on top of {@link GLOBAL}. */
const COMMAND_FLAGS: Readonly<Record<string, Readonly<Record<string, FlagSpec>>>> = {
  ask: {
    state: { type: 'string' },
    questions: { type: 'string' },
    feature: { type: 'string' },
  },
  check: {
    claim: { type: 'string' },
    evidence: { type: 'string' },
  },
  rank: {
    query: { type: 'string' },
    candidates: { type: 'string' },
    criterion: { type: 'string' },
  },
  gate: {
    tool: { type: 'string' },
    args: { type: 'string' },
    'args-json': { type: 'string' },
    'severity-block': { type: 'string' },
  },
  egress: {
    feature: { type: 'string', multiple: true },
  },
  models: {
    catalogue: { type: 'boolean' },
  },
}

/**
 * Every command this tool runs, in the order `--help` lists them.
 *
 * Distinct from the keys of {@link COMMAND_FLAGS} so that a command can be
 * declared before its flags exist; the reverse — flags with no command — would
 * be unreachable code, and the help text is generated from the flag tables, so
 * the two cannot disagree about what exists.
 */
export const COMMANDS: readonly string[] = ['ask', 'check', 'rank', 'gate', 'egress', 'models']

/** Whether a word names a command. */
export const isCommand = (name: string): boolean => COMMANDS.includes(name)

/** The short forms this tool accepts, mapped to their long names. */
const SHORT: Readonly<Record<string, string>> = { h: 'help', v: 'version' }

/**
 * What to do with this command line, decided before any I/O happens.
 *
 * `help` is a first-class outcome rather than a flag the command reads: help is
 * answered without a provider, without a credential and without touching the
 * filesystem, so a machine that cannot run the command at all can still read
 * what it would have done. That is the difference between a help flag and a help
 * path, and it is why `--help` works with no arguments and with arguments that
 * would otherwise be refused.
 */
export type Invocation =
  | { readonly kind: 'help'; readonly command: string | undefined }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly command: string; readonly args: ParsedArgs }

/**
 * Turn an `ERR_PARSE_ARGS_*` failure into a sentence a person can act on.
 *
 * `parseArgs` names the offending token in its own message, so the token is
 * quoted back rather than re-derived — a second attempt to work out which flag
 * was wrong is a second chance to get it wrong.
 */
const describeParseFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  // Node's messages are prefixed "Unknown option '--x'." or "Option '--x' ...".
  // The prefix is dropped so the tool's own voice is what a reader sees.
  return message.replace(/^Unknown option\b/u, 'unknown flag').replace(/\s+/gu, ' ').trim()
}

/** The declared flag table for a command, or a usage error. */
const flagsFor = (command: string): Readonly<Record<string, FlagSpec>> => {
  const own = COMMAND_FLAGS[command]
  if (own === undefined) {
    throw new UsageError(
      `unknown command "${command}". Known commands: ${COMMANDS.join(', ')}. ` +
        `Run "${PROGRAM} --help" for what each one does.`,
    )
  }
  return { ...GLOBAL, ...own }
}

/**
 * Read one command line.
 *
 * The `help` check runs on the raw words before `parseArgs` sees them, so
 * `jev gate --help` works even though it names a required flag this parser would
 * not require anyway, and `jev ask --help --nonsense` prints help rather than
 * failing on the nonsense. Asking what a command does should not require knowing
 * how to call it.
 */
export const parseInvocation = (argv: readonly string[]): Invocation => {
  const [first, ...rest] = argv
  if (first === undefined) return { kind: 'help', command: undefined }

  if (first.startsWith('-')) {
    const long = first.replace(/^--?/u, '')
    const name = SHORT[long] ?? long
    if (name === 'help') return { kind: 'help', command: undefined }
    if (name === 'version') return { kind: 'version' }
    throw new UsageError(
      `expected a command, got the flag "${first}". Run "${PROGRAM} --help" for the list.`,
    )
  }

  const command = first
  const flags = flagsFor(command)
  // Checked here rather than left to `parseArgs`, which cannot know that `-h` is
  // a spelling of `help`.
  const aliased = rest.map((word) => {
    if (!/^-[A-Za-z]$/u.test(word)) return word
    const long = SHORT[word.slice(1)]
    return long === undefined ? word : `--${long}`
  })
  if (aliased.includes('--help')) return { kind: 'help', command }
  if (aliased.includes('--version')) return { kind: 'version' }

  // Rebuilt rather than passed through so `multiple` carries the literal type
  // `true` that `parseArgs`'s own declarations require: a `boolean` computed at
  // this point is not assignable to them, and the flag table above is typed for
  // readability rather than for that overload.
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: true }> = {}
  for (const [name, spec] of Object.entries(flags)) {
    options[name] =
      spec.multiple === true ? { type: spec.type, multiple: true } : { type: spec.type }
  }

  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({ args: [...aliased], options, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(
      `${describeParseFailure(error)} Run "${PROGRAM} ${command} --help" for this command's flags.`,
    )
  }

  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `"${PROGRAM} ${command}" takes no positional arguments, got ` +
        `${parsed.positionals.map((word) => `"${word}"`).join(', ')}. Every input is a named flag; ` +
        `run "${PROGRAM} ${command} --help" to see them.`,
    )
  }

  return {
    kind: 'run',
    command,
    args: {
      command,
      values: parsed.values as ParsedArgs['values'],
      positionals: [],
    },
  }
}

/** A required string flag, or a usage error naming what is missing. */
export const requireString = (args: ParsedArgs, name: string, why: string): string => {
  const value = args.values[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`--${name} is required: ${why}. Exit code ${EXIT.USAGE}.`)
  }
  return value
}

/** An optional string flag. A boolean value here is a caller bug, and refused. */
export const optionalString = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.values[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new UsageError(`--${name} needs a value, and none was given.`)
  }
  return value
}

/** A repeatable string flag, always as an array. */
export const stringList = (args: ParsedArgs, name: string): readonly string[] => {
  const value = args.values[name]
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value as readonly string[]
  throw new UsageError(`--${name} needs a value, and none was given.`)
}

/** Whether a boolean flag was set. */
export const hasFlag = (args: ParsedArgs, name: string): boolean => args.values[name] === true
