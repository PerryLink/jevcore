#!/usr/bin/env node
/**
 * Stdio entry point.
 *
 * Registration only: build the runtime, start the server, and put the egress
 * report on stderr.
 *
 * The report goes to **stderr**, never stdout. On a stdio MCP transport stdout
 * is the protocol channel, and a stray line there corrupts the stream for the
 * host. That is why this file does not use `console.log`.
 *
 * The shebang is the first line of the file on purpose, and it must stay there.
 * `bin` in package.json points at the compiled `lib/bin.js`, and how the host
 * starts that file depends on this line:
 *
 *  - POSIX executes the bin file itself, so the kernel reads the shebang. A
 *    published tarball whose first two bytes are `/*` fails there instead of
 *    running.
 *  - npm's `cmd-shim` *reads* the shebang to decide what to write. Its
 *    `writeShim` matches the first line against `shebangExpr` and, when the
 *    match fails, calls `writeShim_(from, to)` with **no interpreter**, which
 *    emits `"%dp0%\..\..\lib\bin.js" %*` — the `.js` file invoked directly, so
 *    Windows resolves it through the `.js` association to a script host that
 *    never speaks stdio. The host then gets a process that writes nothing,
 *    reports no error, and does not exit. With a shebang the same call passes
 *    `prog`, and the shim is written with the interpreter in front of the path.
 *
 * So the missing shebang is not cosmetic on either platform: it decides whether
 * the generated Windows shim can start this file at all. tsc copies the shebang
 * from the source to the emitted file, so the fix has to be here, not in the
 * build.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { buildRuntime } from './runtime.js'

const note = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

const main = async (): Promise<void> => {
  const runtime = await buildRuntime()

  // The egress contract, announced before any call can happen. An operator
  // reading stderr learns whether anything leaves the machine.
  for (const line of runtime.report) note(line)

  const server = createServer(runtime.service)
  await server.connect(new StdioServerTransport())

  note(`[jevcore-mcp] ready · provider=${runtime.config.provider} · model=${runtime.config.model}`)
}

main().catch((error: unknown) => {
  note(`[jevcore-mcp] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
