#!/usr/bin/env node
/**
 * The `jev` executable. Wiring only.
 *
 * Everything this file does is supply the three things `main` refuses to read for
 * itself — the arguments, the environment and the streams — and set the exit
 * code. That is deliberate: `main` takes them as parameters so the whole tool is
 * runnable in-process by a test, with no subprocess, no socket and no credential.
 *
 * The shebang is the first line of the file on purpose, and it must stay there.
 * `bin` in package.json points at the compiled `lib/bin.js`, and how a host starts
 * that file depends on this line:
 *
 *  - POSIX executes the bin file itself, so the kernel reads the shebang. A
 *    published tarball whose first two bytes are `/*` fails there instead of
 *    running.
 *  - npm's `cmd-shim` *reads* the shebang to decide what to write. When the first
 *    line does not match its `shebangExpr`, it writes a shim with no interpreter,
 *    which emits `"%dp0%\..\..\lib\bin.js" %*` — the `.js` file invoked directly,
 *    so Windows resolves it through the `.js` association to a script host that
 *    never runs it. The result is a process that writes nothing, reports no
 *    error, and does not exit.
 *
 * tsc copies the shebang from the source to the emitted file, so the fix has to
 * be here, not in the build.
 */

import { main } from './main.js'
import type { CliEnv } from './types.js'

/**
 * Read standard input to the end.
 *
 * `for await` over the stream rather than a `data` listener, so the read ends
 * when the stream ends and an error surfaces as a rejection rather than as a
 * silent truncation. A caller that pipes nothing gets an empty string, which is
 * then a JSON parse error naming the flag — a better message than a hang.
 */
const readStdin = async (): Promise<string> => {
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) chunks.push(chunk as string)
  return chunks.join('')
}

const io: CliEnv = {
  env: process.env,
  readStdin,
  // stdout carries payloads only. Every note, warning and egress line goes to
  // stderr, because in `--json` mode a second document on stdout would make the
  // first one unparseable.
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/**
 * Run, and set the exit code rather than calling `process.exit`.
 *
 * `process.exit` truncates a pending write on a pipe, which is exactly what a
 * command whose output was piped to `jq` is doing at that moment. Setting
 * `exitCode` lets Node flush and exit on its own.
 */
main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    io.err(`jev: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
