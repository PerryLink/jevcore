/**
 * Live probe: does the decision model actually decide?
 *
 * The offline suite cannot answer this. Every provider test in this repository
 * runs against stubs or the hash-based mock, which is deliberate — the suite must
 * pass without a credential or a socket — but it means the numbers the package
 * returns were never the vendor's, only its own. This probe asks the real API the
 * three questions those tests cannot:
 *
 *   A. Calibration, on ten claim/evidence pairs whose verdict is known in advance
 *      (five support the claim, three contradict it, two are silent about it), in
 *      ONE batched call. Batching is the documented way to ask: the same ten
 *      questions as ten calls would cost an order of magnitude more.
 *   B. Stability, by asking one question six times. The self-consistency band this
 *      package ships assumes an answer is repeatable, and nothing else here has
 *      ever checked that assumption against the service.
 *   C. Whether the live API accepts a noul's `criteria: {true, false}` boundary —
 *      the field the primitives layer forwards and the SDK's types allow, which
 *      had only ever been checked against those types.
 *
 * Requires TYPESAFE_API_KEY. Costs a fraction of a cent, and reads the key from
 * the environment without ever printing it. Not part of CI, for the same reason
 * the suite is offline.
 *
 * Run: TYPESAFE_API_KEY=... node scripts/probe-live.mjs
 */
import { LiveProvider, noul } from 'jevcore'

const apiKey = process.env.TYPESAFE_API_KEY
if (apiKey === undefined || apiKey === '') {
  console.error('TYPESAFE_API_KEY is not set.')
  process.exit(1)
}

/** Ground truth: what the evidence does to the claim, decided by construction. */
const items = [
  { truth: 'supports', claim: 'The service is rate limited per token.',
    evidence: 'The API documentation states that each token is allowed 100 requests per minute.' },
  { truth: 'supports', claim: 'The deployment broke the billing export.',
    evidence: 'The export job started failing at 14:02, eight minutes after the deploy completed.' },
  { truth: 'supports', claim: 'Latency regressed after the cache change.',
    evidence: 'p99 rose from 120ms to 640ms in the hour following the cache rollout.' },
  { truth: 'supports', claim: 'The customer reported a data loss incident.',
    evidence: 'The ticket reads: "we lost three days of records after the migration".' },
  { truth: 'supports', claim: 'The library is deprecated.',
    evidence: 'Its README opens with a notice that the project is unmaintained and points to a successor.' },
  { truth: 'contradicts', claim: 'The service is free of rate limits.',
    evidence: 'The API documentation states that each token is allowed 100 requests per minute.' },
  { truth: 'contradicts', claim: 'The outage was caused by the database.',
    evidence: 'The database reported 100% availability throughout the incident window; the load balancer logged the failures.' },
  { truth: 'contradicts', claim: 'The patch reduced memory use.',
    evidence: 'Resident memory rose from 210MB to 380MB after the patch was applied.' },
  { truth: 'silent', claim: 'The team should migrate to the new region.',
    evidence: 'The release notes mention a new dashboard widget and a documentation fix.' },
  { truth: 'silent', claim: 'The vendor will raise prices next quarter.',
    evidence: 'The invoice lists the current per-seat price and the billing period.' },
]

const provider = new LiveProvider({ apiKey })
console.log(`endpoint: ${provider.endpoint}`)

const questions = {}
for (const [index] of items.entries()) {
  questions[`item_${index}`] =
    noul(`Does \`state.items[${index}].evidence\` support \`state.items[${index}].claim\`?`)
}

const started = Date.now()
let batched
try {
  batched = await provider.answer({ state: { items }, questions })
} catch (error) {
  console.error(`BATCH FAILED: ${error.name}: ${error.message}`)
  if (error.status !== undefined) console.error(`status: ${error.status}`)
  process.exit(1)
}

console.log('')
console.log(`=== A. calibration (one batched call, ${Date.now() - started}ms) ===`)
console.log(`usage: ${JSON.stringify(batched.usage ?? null)}`)
const groups = { supports: [], contradicts: [], silent: [] }
for (const [index, item] of items.entries()) {
  const answer = batched.answers[`item_${index}`]
  const value = answer?.type === 'noul' ? answer.noul : undefined
  groups[item.truth].push(value)
  console.log(`  ${item.truth.padEnd(11)} item_${index} -> ${value === undefined ? 'NO ANSWER' : value.toFixed(4)}`)
}
for (const [label, values] of Object.entries(groups)) {
  const clean = values.filter((value) => typeof value === 'number')
  const mean = clean.reduce((total, value) => total + value, 0) / (clean.length || 1)
  console.log(`  mean ${label.padEnd(11)} ${mean.toFixed(4)}  (n=${clean.length})`)
}

console.log('')
console.log('=== B. stability (one question, six calls) ===')
const stability = []
for (let attempt = 0; attempt < 6; attempt += 1) {
  const single = await provider
    .answer({
      state: { items: [items[0]] },
      questions: { q: noul('Does `state.items[0].evidence` support `state.items[0].claim`?') },
    })
    .catch((error) => {
      console.error(`  attempt ${attempt} failed: ${error.message}`)
      return undefined
    })
  const value = single?.answers.q?.type === 'noul' ? single.answers.q.noul : undefined
  stability.push(value)
  console.log(`  attempt ${attempt}: ${value === undefined ? 'NO ANSWER' : value.toFixed(4)}`)
}
const cleanStability = stability.filter((value) => typeof value === 'number')
if (cleanStability.length > 0) {
  const mean = cleanStability.reduce((total, value) => total + value, 0) / cleanStability.length
  const spread = Math.max(...cleanStability) - Math.min(...cleanStability)
  console.log(`  mean ${mean.toFixed(4)}  spread ${spread.toFixed(4)}`)
}

console.log('')
console.log('=== C. does the live API accept a noul boundary? ===')
const withBoundary = await provider
  .answer({
    state: { text: 'The migration completed at 09:15 and all checks passed.' },
    questions: {
      migrated: noul('Did the migration complete successfully?', {
        true: 'The text states completion and passing checks.',
        false: 'The text reports a failure, a rollback, or an incomplete migration.',
      }),
    },
  })
  .catch((error) => {
    console.error(`  REJECTED: ${error.name}: ${error.message}`)
    if (error.status !== undefined) console.error(`  status: ${error.status}`)
    return undefined
  })
if (withBoundary !== undefined) {
  console.log(`  ACCEPTED: ${JSON.stringify(withBoundary.answers.migrated)}`)
}
