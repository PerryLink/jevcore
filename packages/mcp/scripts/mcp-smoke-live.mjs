/**
 * Drive the MCP server over a real stdio transport against the live
 * OpenRouter route.
 *
 * The offline smoke test proves the protocol; this proves the whole stack —
 * transport, tool schemas, core service, provider, and real Jev answers —
 * against the vendor. It is the MCP-shaped counterpart to
 * `packages/core/scripts/probe-openrouter-live.mjs`.
 *
 * Requires OPENROUTER_API_KEY. Costs a fraction of a cent per tool call. Not
 * part of CI: the suite must stay offline.
 *
 * Usage: OPENROUTER_API_KEY=... node scripts/mcp-smoke-live.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey === '') {
  console.error('OPENROUTER_API_KEY is not set.')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(here, '..', 'lib', 'bin.js')

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const pass = (message) => console.log(`PASS ${message}`)

let stderrText = ''
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: '' },
  stderr: 'pipe',
})
// The egress report must arrive on stderr; stdout carries the protocol.
transport.stderr?.on('data', (chunk) => {
  stderrText += String(chunk)
})

const client = new Client({ name: 'jevkit-live-smoke', version: '0.1.0' })

try {
  await client.connect(transport)
  pass('handshake: connected over stdio')

  const { tools } = await client.listTools()
  pass(`discovery: ${tools.length} tools -> ${tools.map((t) => t.name).sort().join(', ')}`)

  // 1. jev_ask with all three primitives, including the score shape that this
  //    work corrected.
  const ask = await client.callTool({
    name: 'jev_ask',
    arguments: {
      state: {
        endpoint: '/v1/payments',
        observation: 'A tenant sent 4,000 requests in one minute; p99 latency rose for everyone.',
      },
      questions: {
        urgent: { type: 'noul', instructions: 'Does this warrant action within a week?' },
        owner: {
          type: 'choice',
          instructions: 'Which team should own the fix?',
          criteria: { platform: 'The API platform team', security: 'The security team' },
        },
        severity: {
          type: 'score',
          instructions: 'How severe is the current impact?',
          criteria: {
            low: 'No user-visible effect',
            medium: 'Some users see slower responses',
            high: 'A subset of users cannot use the API',
          },
        },
      },
    },
  })
  if (ask.isError) fail(`jev_ask returned an error: ${JSON.stringify(ask.content)}`)

  const payload = JSON.parse(ask.content[0].text)
  if (payload.provider !== 'openrouter') fail(`expected provider "openrouter", got "${payload.provider}"`)
  if (payload.warning !== undefined) fail('a live answer was labelled synthetic')
  console.log(`     provider=${payload.provider} model=${payload.model} usage=${JSON.stringify(payload.usage)}`)

  // The MCP surface keys answers by question id; the DSH surface returns an
  // array with the ids inline. Both carry the same answer objects.
  const byId = payload.answers
  for (const id of ['urgent', 'owner', 'severity']) {
    if (byId[id] === undefined) fail(`no answer for "${id}"`)
  }

  // The noul answer must carry a probability of true.
  if (typeof byId.urgent?.noul !== 'number') fail('the noul answer carries no probability')
  // The score answer must carry the rubric it was scored against, and a numeric
  // expected score — this is the shape that used to be wrong.
  if (typeof byId.severity?.score !== 'number') fail('the score answer carries no numeric score')
  if (byId.severity?.legend === undefined) fail('the score answer carries no legend')
  if (Object.keys(byId.severity?.legend ?? {}).length !== 3) {
    fail(`expected a 3-level legend, got ${JSON.stringify(byId.severity?.legend)}`)
  }
  pass(
    `call: jev_ask -> urgent=${byId.urgent?.answer}(${byId.urgent?.noul}) ` +
      `owner=${byId.owner?.answer} severity=${byId.severity?.score} ` +
      `(${byId.severity?.answer ?? 'between levels'})`,
  )

  // 2. jev_rank — a live reranking of two candidates.
  const ranked = await client.callTool({
    name: 'jev_rank',
    arguments: {
      query: 'how do I rotate an API key',
      candidates: ['Billing and invoices guide', 'Credential rotation runbook'],
    },
  })
  if (ranked.isError) fail(`jev_rank returned an error: ${JSON.stringify(ranked.content)}`)
  const ranking = JSON.parse(ranked.content[0].text).ranking
  if (ranking.length !== 2) fail('jev_rank did not return both candidates')
  const scores = ranking.map((entry) => entry.relevance ?? -1)
  if (JSON.stringify(scores) !== JSON.stringify([...scores].sort((a, b) => b - a))) {
    fail('jev_rank returned an unsorted ranking')
  }
  pass(`call: jev_rank -> ${ranking.map((e) => `${e.candidate}:${e.relevance}`).join(' ')}`)

  // 3. jev_check — a claim the evidence contradicts.
  const checked = await client.callTool({
    name: 'jev_check',
    arguments: {
      claim: 'The API is free to use without limits.',
      evidence: 'Pricing is $42 per billion tokens, and each key is limited to 100 requests per minute.',
    },
  })
  if (checked.isError) fail(`jev_check returned an error: ${JSON.stringify(checked.content)}`)
  const judgement = JSON.parse(checked.content[0].text)
  if (judgement.verdict === undefined) fail('jev_check returned no verdict')
  pass(`call: jev_check -> verdict=${judgement.verdict}`)

  // 4. The egress report must be on stderr, and must name OpenRouter rather
  //    than TypeSafe, because that is where the state actually goes.
  if (!/openrouter/i.test(stderrText)) {
    fail(`the startup report does not name the OpenRouter endpoint:\n${stderrText}`)
  } else {
    pass('egress: the startup report names the OpenRouter endpoint')
  }
  if (/Transcript|BEGIN|sk-or-v1/.test(stderrText)) {
    fail('the startup report leaks credential or payload content')
  }

  console.log(
    failures === 0
      ? '\nLive MCP smoke test passed. The whole stack answers against real System One models.'
      : `\n${failures} live check(s) failed.`,
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  await client.close().catch(() => undefined)
}

process.exitCode = failures === 0 ? 0 : 1
