/**
 * Cross-check this project's OpenRouter payloads against the vendor's own Zod
 * schemas.
 *
 * The unit tests use a stub SDK, which proves our side of the contract but not
 * that the vendor would accept it. This imports `@openrouter/sdk`'s real
 * schemas and parses what this plugin actually produces, in both directions:
 * the request we build, and the response shapes we handle. No key and no network
 * are involved.
 *
 * Run from this package: node scripts/check-openrouter-schemas.mjs
 */

import {
  DecisionsRequest$outboundSchema,
  DecisionsResponse$inboundSchema,
} from '@openrouter/sdk/models'
import { OpenRouterProvider, choice, noul, score } from '@dsh-jev/core'

let failures = 0
const check = (label, result) => {
  if (result.success) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}`)
    console.log('     ' + JSON.stringify(result.error?.issues ?? result.error).slice(0, 400))
  }
}

// Capture the exact payload the provider builds by stubbing the SDK client.
let captured
const stub = {
  OpenRouter: class {
    alpha = {
      decisions: {
        create: async (request) => {
          captured = request
          return {
            model: 'typesafe/jev-1.13',
            provider: 'TypeSafe',
            answers: {
              urgent: { type: 'noul', noul: 0.91, confidence: 0.88 },
              team: {
                type: 'choice',
                choice: 'billing',
                probabilities: { billing: 0.7, technical: 0.3 },
                confidence: 0.7,
              },
              risk: {
                type: 'score',
                score: 1.4,
                legend: { '0': 'none', '1': 'severe' },
                probabilities: { '0': 0.2, '1': 0.8 },
                confidence: 0.75,
              },
            },
            usage: { inputTokens: 120, outputTokens: 0, cost: 0.000005 },
          }
        },
      },
    }
  },
}

const provider = new OpenRouterProvider({
  apiKey: 'sk-or-v1-schema-check',
  loadSdk: async () => stub,
})

const result = await provider.answer({
  state: { ticket: 'I was charged twice.', cwd: 'D:/work' },
  questions: {
    urgent: noul('Does this convey urgency?'),
    team: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
    risk: score('How risky?', { low: 'none', high: 'severe' }),
  },
})

if (captured === undefined) {
  console.log('FAIL the provider did not call the client')
  process.exit(1)
}

// 1. The request we build must satisfy the vendor's outbound schema.
check(
  'request payload parses against DecisionsRequest$outboundSchema',
  DecisionsRequest$outboundSchema.safeParse(captured.decisionsRequest),
)

// 2. The wrapper the SDK requires must be what we send.
check('the payload is wrapped in decisionsRequest', {
  success: Object.keys(captured).length === 1 && captured.decisionsRequest !== undefined,
})

// 3. The response shape we handle must satisfy the vendor's inbound schema.
//
// This is the wire shape, so `usage` is snake_case: the SDK's zod schema
// requires `input_tokens` / `output_tokens` and its `fromJSON` remaps them to
// the camelCase names its TypeScript type declares. Both spellings are read by
// `readUsage` in provider/openrouter.ts.
const goodResponse = {
  model: 'typesafe/jev-1.13',
  provider: 'TypeSafe',
  answers: {
    urgent: { type: 'noul', noul: 0.91, confidence: 0.88 },
    team: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.7, technical: 0.3 },
      confidence: 0.7,
    },
    risk: {
      type: 'score',
      score: 1.4,
      legend: { '0': 'none', '1': 'severe' },
      probabilities: { '0': 0.2, '1': 0.8 },
      confidence: 0.75,
    },
  },
  usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
}
check(
  'response shape parses against DecisionsResponse$inboundSchema',
  DecisionsResponse$inboundSchema.safeParse(goodResponse),
)

// 4. Every question variant this project can build must be accepted. These are
// the real primitives, not hand-written objects, so a change to `score()` that
// breaks the wire contract fails here.
const allTypes = {
  model: 'typesafe/jev-1.13',
  state: { ticket: 'I was charged twice.' },
  questions: {
    a: noul('Does this convey urgency?'),
    b: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
    c: score('How risky?', { low: 'none', high: 'severe' }),
  },
}
check(
  'every primitive this project builds is accepted',
  DecisionsRequest$outboundSchema.safeParse(allTypes),
)

// 4b. The specific regression: a score sent as a keyed map is rejected by the
// vendor, so this check documents why `score()` emits an array.
const keyedScore = {
  ...allTypes,
  questions: { c: { type: 'score', instructions: 'How risky?', criteria: { low: 'none', high: 'severe' } } },
}
if (DecisionsRequest$outboundSchema.safeParse(keyedScore).success) {
  console.log('FAIL a keyed score map was accepted; this check no longer guards anything')
  failures += 1
} else {
  console.log('PASS a keyed score map is rejected, confirming the array is required')
}

// 5. Our own answer types must round-trip: what we claim to parse is what the
// schema says can arrive.
if (Object.keys(result.answers).length !== 3) {
  console.log(`FAIL expected 3 parsed answers, got ${Object.keys(result.answers).length}`)
  failures += 1
} else {
  console.log('PASS all three answer types parsed')
}

console.log(failures === 0 ? '\nAll schema checks passed.' : `\n${failures} schema check(s) failed.`)
process.exitCode = failures === 0 ? 0 : 1
