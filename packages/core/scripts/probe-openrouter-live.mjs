/**
 * Live probe: one real request to OpenRouter's Decisions route.
 *
 * This is the check the stub tests cannot make — that the vendor accepts what we
 * build and that the answer we normalize is the answer it sent. It reports the
 * raw response alongside the normalized one precisely so the two can be
 * compared, rather than trusting the normalization.
 *
 * Requires OPENROUTER_API_KEY. Costs a fraction of a cent. Not part of CI: the
 * suite must stay offline.
 *
 * Run: node scripts/probe-openrouter-live.mjs
 */

import { OpenRouterProvider, choice, noul, renderResult, score } from 'jevkit'

const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey === '') {
  console.error('OPENROUTER_API_KEY is not set.')
  process.exit(1)
}

// Deliberately innocuous state: this probe is about the contract, not content.
const state = {
  feature: 'rate limiting',
  detail: 'A public API endpoint currently allows 100 requests per minute per token.',
  observed: 'One tenant sent 4,000 requests in a minute and slowed responses for others.',
}

const request = {
  state,
  questions: {
    urgent: noul('Does this situation warrant a change within the next working week?'),
    owner: choice('Which team should own the fix?', {
      platform: 'The API platform team',
      security: 'The security team',
      billing: 'The billing team',
    }),
    risk: score('How severe is the current impact?', {
      low: 'No user-visible effect',
      medium: 'Some users see slower responses',
      high: 'A subset of users cannot use the API',
      critical: 'The API is unusable for everyone',
    }),
  },
}

// Capture the raw response so normalization can be checked against it.
const provider = new OpenRouterProvider({ apiKey })

console.log(`endpoint: ${provider.endpoint}`)
console.log(`model:    ${provider.modelId}`)
console.log('')

const result = await provider.answer(request).catch((error) => {
  console.error(`FAILED: ${error.name}: ${error.message}`)
  if (error.cause !== undefined) console.error(`cause: ${error.cause}`)
  process.exit(1)
})

console.log('===== NORMALIZED (what the plugin would hand the model) =====')
console.log(JSON.stringify(renderResult(result, Object.keys(request.questions)), null, 2))
console.log('')
console.log(`provider: ${result.provider}`)
console.log(`model:    ${result.model}`)
console.log(`latency:  ${result.latencyMs}ms`)
console.log(`usage:    ${JSON.stringify(result.usage)}`)
