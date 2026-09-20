/**
 * Drive the MCP server over a real stdio transport, as a host would.
 *
 * This exercises the part the unit tests cannot: the wire protocol, the
 * handshake, tool discovery, and a schema-validated call. It runs entirely
 * offline against the mock provider, so it needs no credential.
 *
 * Usage: node scripts/mcp-smoke.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(here, '..', 'lib', 'bin.js')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  // No credential: the server must fall back to the offline mock on its own.
  env: { ...process.env, TYPESAFE_API_KEY: '', JEV_PROVIDER: 'mock' },
  stderr: 'pipe',
})

const client = new Client({ name: 'dsh-jev-smoke', version: '0.1.0' })

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

try {
  await client.connect(transport)
  console.log('PASS handshake: connected over stdio')

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
  await client.close().catch(() => undefined)
}
