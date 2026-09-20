/**
 * The in-process harness every test in this package runs through.
 *
 * `main` takes its argv, environment and streams as arguments precisely so this
 * can exist: a test runs the real command surface with its own inputs and asserts
 * on what the tool printed and what it exited with. There is no subprocess, no
 * terminal, and no reading of the ambient environment — a developer's real
 * `TYPESAFE_API_KEY` cannot reach a test, because the tests pass their own
 * environment object and nothing falls back to `process.env`.
 *
 * `describe` is a reserved name in vitest, so the CLI's own `describe` (a
 * shape-namer for error messages) is not imported here.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from '../../src/main.js'
import type { CliEnv } from '../../src/types.js'

/** What one run of the tool produced. */
export interface RunResult {
  /** Everything written to the primary output, joined. */
  readonly stdout: string
  /** Everything written to the diagnostic channel, joined. */
  readonly stderr: string
  /** The process exit code the tool chose. */
  readonly code: number
  /** `stdout` as JSON. Throws with the raw text attached when it is not JSON. */
  readonly json: <T = Record<string, unknown>>() => T
}

/** A run harness, plus the temporary directory its fixture files live in. */
export interface Harness {
  readonly run: (
    argv: readonly string[],
    options?: {
      readonly env?: Readonly<Record<string, string | undefined>>
      readonly stdin?: string
    },
  ) => Promise<RunResult>
  /** Write a fixture file and return its path. */
  readonly file: (name: string, contents: string) => string
  /** Write a fixture file whose contents are `JSON.stringify(value, null, 2)`. */
  readonly json: (name: string, value: unknown) => string
  /** The fixture directory, for a command that names a path itself. */
  readonly dir: string
  readonly dispose: () => void
}

/**
 * Create the harness.
 *
 * The fixture directory is created eagerly rather than lazily so `dir` is a real
 * path from the first line of a test: a command that resolves a relative path
 * against `cwd` needs somewhere to resolve it to.
 */
export const createHarness = (): Harness => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-cli-test-'))

  const file = (name: string, contents: string): string => {
    const target = path.join(dir, name)
    writeFileSync(target, contents, 'utf8')
    return target
  }

  const run: Harness['run'] = async (argv, options = {}) => {
    const out: string[] = []
    const err: string[] = []
    const io: CliEnv = {
      // A fresh object per run, so a test that sets one variable cannot leak it
      // into the next run through a shared reference.
      env: { ...options.env },
      readStdin: () => Promise.resolve(options.stdin ?? ''),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    }
    const code = await main(argv, io)
    const stdout = out.join('\n')
    const stderr = err.join('\n')
    return {
      stdout,
      stderr,
      code,
      json: <T,>() => {
        try {
          return JSON.parse(stdout) as T
        } catch (error) {
          throw new Error(
            `stdout was not a single JSON document (${error instanceof Error ? error.message : String(error)}):\n${stdout}`,
          )
        }
      },
    }
  }

  return {
    run,
    file,
    json: (name, value) => file(name, JSON.stringify(value, null, 2)),
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
