/**
 * Drive the MCP server over a real stdio transport, as a host would.
 *
 * This exercises the part the unit tests cannot: the wire protocol, the
 * handshake, tool discovery, and a schema-validated call. It runs entirely
 * offline against the mock provider, so it needs no credential.
 *
 * It also exercises the part the protocol tests used to miss: **how the host
 * starts the process**. This script used to spawn `node lib/bin.js`, which
 * cannot fail for the reason `npx -y jevcore-mcp` fails. The shebang on line 1
 * is what decides both launch paths:
 *
 *  - POSIX executes the bin file itself, so the kernel reads it.
 *  - npm's `cmd-shim` reads it to pick the interpreter. Without a match it emits
 *    `"%dp0%\..\..\lib\bin.js" %*` — the file called directly, which Windows
 *    sends to a script host that never speaks stdio, so the host waits forever
 *    instead of failing.
 *
 * The shebang was missing, `npx -y jevcore-mcp` produced a process that never
 * wrote a byte, and this script passed throughout. So the shebang is asserted
 * before anything is spawned — a build that drops it fails here by name instead
 * of hanging on a user's machine — and the entry point is then launched through
 * the generated shim when the workspace has one.
 *
 * Usage: node scripts/mcp-smoke.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const serverEntry = join(packageRoot, 'lib', 'bin.js')

/** The manifest, so the client can assert the version the server reports. */
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

/**
 * How to start the server, closest to what a host does.
 *
 * 1. the local `node_modules/.bin` shim, when the workspace has one — this is
 *    literally the file npm and pnpm generate for a `bin` entry;
 * 2. on POSIX, the `bin` file itself with its executable bit, which is what
 *    that shim points at and what the kernel resolves through the shebang;
 * 3. `node lib/bin.js`, which proves the protocol but not the launch path.
 *
 * A bare `spawn` of a `.js` file on Windows is deliberately not attempted: the
 * `.js` association sends it to a script host that never speaks stdio, so the
 * check would hang the smoke test rather than report the problem.
 */
const chooseLaunch = () => {
  const binName = 'jevcore-mcp'
  // npm and pnpm write a bare name plus a suffix per platform: a symlink on
  // POSIX, a `.cmd` (and `.ps1`) shim on Windows. `existsSync` does not consult
  // PATHEXT, so the suffix has to be spelled out.
  const shimDir = join(packageRoot, 'node_modules', '.bin')
  const shimName = ['', '.cmd', '.ps1', '.exe'].find((suffix) =>
    existsSync(join(shimDir, `${binName}${suffix}`)),
  )
  if (shimName !== undefined) {
    return { kind: 'shim', command: join(shimDir, binName), args: [], label: `node_modules/.bin/${binName}${shimName}` }
  }
  if (process.platform !== 'win32' && existsSync(serverEntry) && statSync(serverEntry).mode & 0o111) {
    return { kind: 'exec', command: serverEntry, args: [], label: 'lib/bin.js (executable, via shebang)' }
  }
  return { kind: 'node', command: process.execPath, args: [serverEntry], label: 'node lib/bin.js' }
}

const launch = chooseLaunch()

const launchEnv = { ...process.env, TYPESAFE_API_KEY: '', JEV_PROVIDER: 'mock' }

// A Windows `.cmd` shim is executed by cmd.exe, so the first call goes through
// the shell. That is enough to prove the shim starts the server and that it
// writes to stdout; the stdio transport below then attaches without a shell.
const shimProbe = (shim) => {
  const result = spawnSync(shim.command, ['--version-probe'], {
    shell: true,
    env: launchEnv,
    encoding: 'utf8',
    timeout: 15_000,
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) return `could not run ${shim.label}: ${result.error.message}`
  if (!out.includes('ready')) {
    return (
      `${shim.label} produced no startup output (stdout+stderr was ${out.length} characters, ` +
      `signal=${String(result.signal)}). A host launching this gets a process that never speaks.`
    )
  }
  return undefined
}

/**
 * The shebang check.
 *
 * Read as bytes rather than as text through an editor or a build step: `#!` at
 * offset 0 is the whole contract. `src/bin.ts` is checked too, because that is
 * the file the fix lives in and the file a future edit would remove it from.
 */
const assertShebang = (file, label) => {
  if (!existsSync(file)) {
    fail(`${label} does not exist; run the build before the smoke test`)
    return
  }
  const head = readFileSync(file).subarray(0, 2).toString('latin1')
  if (head !== '#!') {
    fail(
      `${label} does not start with "#!" (first two bytes: ${JSON.stringify(head)}). A POSIX host ` +
        `executes the bin file directly, so this is the difference between running and producing ` +
        `a process that writes nothing and never exits.`,
    )
    return
  }
  console.log(`PASS shebang: ${label} starts with "#!"`)
}

assertShebang(join(packageRoot, 'src', 'bin.ts'), 'src/bin.ts')
assertShebang(serverEntry, 'lib/bin.js')

if (launch.kind === 'node' && process.platform === 'win32') {
  console.error(
    'NOTE: no node_modules/.bin/jevcore-mcp shim is present, so this run starts the entry point ' +
      'through node. The shebang is asserted statically above; the shim path itself is exercised ' +
      'by CI on Linux, where the executable bit is honoured.',
  )
}

console.log(`PASS launch: starting via ${launch.label}`)

if (launch.kind === 'shim' && launch.label.endsWith('.cmd')) {
  const problem = shimProbe(launch)
  if (problem === undefined) {
    console.log('PASS shim: the Windows .cmd shim starts the server and it writes to stdout')
  } else {
    fail(problem)
  }
}

// The shell is needed only to reach a `.cmd` on Windows; the transport itself
// talks over pipes either way.
const shell = launch.kind === 'shim' && launch.label.endsWith('.cmd')

const transport = new StdioClientTransport({
  command: launch.command,
  args: launch.args,
  // No credential: the server must fall back to the offline mock on its own.
  env: { ...process.env, TYPESAFE_API_KEY: '', JEV_PROVIDER: 'mock' },
  stderr: 'pipe',
  ...(shell ? { shell: true } : {}),
})

const client = new Client({ name: 'jevcore-smoke', version: manifest.version })

/**
 * Bound the handshake.
 *
 * A server launched without a usable shebang does not fail — it produces a
 * process that never writes a byte and never exits, and a host waits forever.
 * This script must report that, not reproduce it.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000
let handshakeTimer
const timeout = new Promise((_, reject) => {
  handshakeTimer = setTimeout(
    () => reject(new Error(`no MCP handshake within ${HANDSHAKE_TIMEOUT_MS}ms`)),
    HANDSHAKE_TIMEOUT_MS,
  )
})

try {
  await Promise.race([client.connect(transport), timeout])
  clearTimeout(handshakeTimer)
  console.log('PASS handshake: connected over stdio')

  const implementation = client.getServerVersion()
  if (implementation?.version !== manifest.version) {
    fail(
      `the server reports version ${String(implementation?.version)}, package.json says ` +
        `${manifest.version}. A client logs that string; it must be the published one.`,
    )
  } else {
    console.log(`PASS version: the server reports ${manifest.version}, matching package.json`)
  }

  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  console.log(`PASS discovery: ${names.length} tools -> ${names.join(', ')}`)

  const expected = ['jev_ask', 'jev_check', 'jev_rank']
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`expected exactly ${expected.join(', ')}`)
  }

  for (const tool of tools) {
    if (!tool.description || tool.description.length < 40) {
      fail(`${tool.name} has no useful description; a model cannot use it well`)
    }
    if (!tool.inputSchema || Object.keys(tool.inputSchema.properties ?? {}).length === 0) {
      fail(`${tool.name} exposes no parameters`)
    }
  }
  console.log('PASS schemas: every tool has a description and parameters')

  const ask = await client.callTool({
    name: 'jev_ask',
    arguments: {
      state: { ticket: 'I was charged twice and nobody replied.' },
      questions: {
        urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
        },
      },
    },
  })

  if (ask.isError) fail(`jev_ask returned an error: ${JSON.stringify(ask.content)}`)

  const payload = JSON.parse(ask.content[0].text)
  if (payload.provider !== 'mock') fail(`expected the mock provider, got ${payload.provider}`)
  if (!payload.warning) fail('a synthetic answer came back unlabelled; that is a bug')
  if (Object.keys(payload.answers).length !== 2) fail('expected two answers')
  console.log(
    `PASS call: jev_ask -> ${Object.keys(payload.answers).join(', ')} ` +
      `(provider=${payload.provider}, labelled synthetic)`,
  )

  const ranked = await client.callTool({
    name: 'jev_rank',
    arguments: { query: 'find the billing policy', candidates: ['payments guide', 'api reference'] },
  })
  const ranking = JSON.parse(ranked.content[0].text).ranking
  if (ranking.length !== 2) fail('jev_rank did not return both candidates')
  const scores = ranking.map((entry) => entry.relevance ?? -1)
  if (JSON.stringify(scores) !== JSON.stringify([...scores].sort((a, b) => b - a))) {
    fail('jev_rank returned an unsorted ranking')
  }
  console.log('PASS call: jev_rank -> sorted, both candidates present')

  const checked = await client.callTool({
    name: 'jev_check',
    arguments: { claim: 'the service is free', evidence: 'pricing is $42 per billion tokens' },
  })
  const verdict = JSON.parse(checked.content[0].text).verdict
  if (!verdict) fail('jev_check returned no verdict')
  console.log(`PASS call: jev_check -> verdict="${verdict}"`)

  // A tool must report a caller error as an error result, not as a crash.
  const rejected = await client.callTool({
    name: 'jev_ask',
    arguments: {
      state: 'x',
      questions: { broken: { type: 'choice', instructions: 'pick', criteria: { only: null } } },
    },
  })
  if (!rejected.isError) fail('an invalid batch should come back as an error result')
  console.log('PASS errors: an invalid batch is reported, not thrown into the transport')

  console.log('\nMCP smoke test passed. The server speaks the protocol correctly.')
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  clearTimeout(handshakeTimer)
  await client.close().catch(() => undefined)
}
