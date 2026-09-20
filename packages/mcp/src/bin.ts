/**
 * Stdio entry point.
 *
 * Registration only: build the runtime, start the server, and put the egress
 * report on stderr.
 *
 * The report goes to **stderr**, never stdout. On a stdio MCP transport stdout
 * is the protocol channel, and a stray line there corrupts the stream for the
 * host. That is why this file does not use `console.log`.
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

  note(`[jevkit-mcp] ready · provider=${runtime.config.provider} · model=${runtime.config.model}`)
}

main().catch((error: unknown) => {
  note(`[jevkit-mcp] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
