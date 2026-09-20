/**
 * Does the declared redaction actually cover everything that leaves?
 *
 * `EGRESS_FIELDS['tool:jev_rank']` claims `state` carries "the query plus every
 * candidate the model passed, after redaction". `rank.ts` instead splices each
 * candidate into the QUESTION text and sends only `{ query }` as state. If
 * `measure` redacts state alone, candidate text leaves verbatim.
 *
 * This sends a candidate containing a recognizable fake credential and inspects
 * the payload the provider is handed -- before any network call, by stubbing the
 * provider.
 *
 * Usage: node scripts/probe-redaction-coverage.mjs
 */

import { EgressContract, JevService } from 'jevcore'

// A fake but well-formed-looking key, of the shape the default ruleset targets.
const FAKE_KEY = 'sk-live-9f3a2b7c8d1e4f5a6b0c9d8e7f6a5b4c'
const CANDIDATE = `Credential rotation runbook. Admin token: ${FAKE_KEY}`

let captured
const stubProvider = {
  id: 'stub',
  answer: async (request) => {
    captured = request
    return { model: 'stub', answers: {}, latencyMs: 1, provider: 'stub' }
  },
}

const egress = new EgressContract({ transmitting: true }, 'https://example.invalid', undefined)
const service = new JevService({ provider: stubProvider, egress, transmitting: true, model: 'stub' })

// Reproduce exactly what rank.ts builds.
const question = { type: 'noul', instructions: `Candidate: ${CANDIDATE}\n\nQuestion: Does this help?` }
const state = { query: 'how do I rotate an API key' }

await service.ask({ feature: 'tool:jev_rank', state, questions: { candidate_0: question } })

const stateText = JSON.stringify(captured?.state ?? null)
const questionsText = JSON.stringify(captured?.questions ?? null)

console.log('payload the provider received:')
console.log('  state     :', stateText)
console.log('  questions :', questionsText.slice(0, 220))
console.log('')

const inState = stateText.includes(FAKE_KEY)
const inQuestions = questionsText.includes(FAKE_KEY)

console.log(`fake key present in state     : ${inState}`)
console.log(`fake key present in questions : ${inQuestions}`)
console.log('')

if (inState) {
  console.log('RESULT: redaction covered it (the secret was in state).')
  process.exit(0)
}
if (inQuestions) {
  console.log('RESULT: DEFECT CONFIRMED -- the secret left the machine verbatim, in the')
  console.log('        question text, which measure() never redacts and the declared')
  console.log('        per-feature question cap never bounds.')
  process.exit(1)
}
console.log('RESULT: the secret is absent from both fields; investigate why.')
process.exit(2)
