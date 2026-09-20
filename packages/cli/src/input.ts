/**
 * Reading a command's inputs.
 *
 * Three rules hold across every file-shaped flag:
 *
 *  - `-` means standard input, and it means the same thing everywhere, so a
 *    pipeline can feed any command without a temporary file.
 *  - A path is resolved against the process working directory, and the resolved
 *    path is what an error names — "no such file" pointing at a relative name
 *    the user already knows they typed is not an error message.
 *  - What was read is validated as JSON *here*, with the flag name attached, so
 *    a parse failure says which input was malformed rather than surfacing three
 *    frames later as an undefined value.
 *
 * The whole file is read into memory. These inputs are a state, a claim, an
 * evidence document, a candidate list and a tool-argument object: all of them are
 * bounded by the egress cap on the way out (16_000 characters for a state), and a
 * streaming reader would add a code path for a size that cannot legitimately
 * occur.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from 'jevcore'
import type { CliEnv } from './types.js'
import { UsageError } from './usage.js'

/** What a `-`-capable flag was given. */
export const STDIN = '-'

/** Whether a flag value selects standard input. */
export const isStdin = (value: string): boolean => value === STDIN

/**
 * Read a text input, from a file or from standard input.
 *
 * `where` is the flag name, used verbatim in every failure. Without it a command
 * with two file inputs reports "cannot read file" and leaves the reader to guess
 * which one.
 */
export const readText = async (input: string, where: string, io: CliEnv): Promise<string> => {
  if (isStdin(input)) {
    try {
      return await io.readStdin()
    } catch (error) {
      throw new UsageError(
        `${where} was told to read standard input, and reading it failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const resolved = path.resolve(input)
  try {
    return await readFile(resolved, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new UsageError(
      `${where} could not be read: ${resolved} ${code === 'ENOENT' ? 'does not exist' : `failed (${code ?? 'unknown error'})`}.`,
    )
  }
}

/**
 * The file a `--file` style flag names, or standard input.
 *
 * Exported so a command can hand the same resolved path to more than one reader
 * — `gate` uses it to read `--args` and then decides whether the result is an
 * object.
 */
export const readJson = async (input: string, where: string, io: CliEnv): Promise<JsonValue> => {
  const text = await readText(input, where, io)
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    throw new UsageError(
      `${where} (${isStdin(input) ? 'standard input' : path.resolve(input)}) is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Parse a JSON value that arrived on the command line rather than in a file.
 *
 * Kept separate from {@link readJson} so the error can point at the flag instead
 * of at a path, which is the only thing that differs between the two cases.
 */
export const parseJsonArgument = (text: string, where: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    throw new UsageError(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** A JSON object, or a usage error naming what arrived instead. */
export const asObject = (value: JsonValue, where: string): Record<string, JsonValue> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`${where} must be a JSON object, got ${describe(value)}.`)
  }
  return value as Record<string, JsonValue>
}

/** A JSON array of strings, or a usage error naming the offending entry. */
export const asStringArray = (value: JsonValue, where: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new UsageError(`${where} must be a JSON array of strings, got ${describe(value)}.`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new UsageError(
        `${where}[${index}] must be a string, got ${describe(entry)}. Candidates are ranked as ` +
          'they are written, so a number or an object here has no text to judge.',
      )
    }
    return entry
  })
}

/**
 * A short description of a JSON value's shape, for an error message.
 *
 * Says `null` and `array` rather than `object`, because those are the two shapes
 * a caller most often passes by accident and the two that a bare `typeof` check
 * reports misleadingly.
 */
export const describe = (value: JsonValue | undefined): string => {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}
