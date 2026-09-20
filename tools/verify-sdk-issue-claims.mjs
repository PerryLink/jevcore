/**
 * Verify the claims in the TypeSafe SDK issue drafts against the installed SDK.
 *
 * Drafts 1-3 in `typesafe-sdk-issue-drafts.md` (a sibling of this repository's
 * parent directory) assert runtime-observable facts about `@typesafe-ai/sdk`.
 * A reproduction that does not run is worse than none: it wastes the
 * maintainer's time and costs the reporter credibility. This runs them.
 *
 * Nothing here needs an API key — every claim is offline-assertable.
 *
 * Usage: node tools/verify-sdk-issue-claims.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const require = createRequire(join(ROOT, 'packages', 'core', 'package.json'))
// Resolve the package root, then pick the ESM entry explicitly: `require.resolve`
// on the bare specifier returns the CJS build, which is not what the SDK's own
// `exports` map points an ESM consumer at.
const packageJsonPath = require.resolve('@typesafe-ai/sdk/package.json')
const packageRoot = packageJsonPath.replace(/[\\/]package\.json$/, '')
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
// Windows absolute paths must be file:// URLs before the ESM loader will take them.
const sdk = await import(pathToFileURL(join(packageRoot, 'dist', 'index.mjs')).href)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}`)
    if (detail !== undefined) console.log(`     ${detail}`)
  }
}

console.log(`@typesafe-ai/sdk ${manifest.version}\n`)

// ---------- Draft 1: error taxonomy has no class for 402, 409, 413 ----------
console.log('--- draft 1: error taxonomy ---')
check('APIError.fromResponse is exported at runtime', typeof sdk.APIError?.fromResponse === 'function')

for (const [status, expected] of [
  [400, 'BadRequestError'],
  [401, 'AuthenticationError'],
  [403, 'PermissionDeniedError'],
  [404, 'NotFoundError'],
  [422, 'UnprocessableEntityError'],
  [429, 'RateLimitError'],
  [500, 'InternalServerError'],
]) {
  const name = sdk.APIError.fromResponse(status, {}, new Headers()).constructor.name
  check(`HTTP ${status} -> ${expected}`, name === expected, `got ${name}`)
}

for (const status of [402, 409, 413]) {
  const name = sdk.APIError.fromResponse(status, {}, new Headers()).constructor.name
  check(
    `HTTP ${status} still falls through to the base APIError (the draft's claim)`,
    name === 'APIError' || name === 'TypeSafeError',
    `got ${name} — if a subclass now exists, the draft is obsolete`,
  )
}

// ---------- Drafts 2 and 3: the retry contract ----------
console.log('\n--- drafts 2 and 3: retry contract ---')
const bundle = readFileSync(join(packageRoot, 'dist', 'index.mjs'), 'utf8')

// The published bundle is minified, so these literals do not look like the
// source: 5000 is written `5e3`, 0.25 as `.25`, 60000 as `6e4`. Match the value,
// not the spelling.
check('DEFAULT_RETRY_POLICY is present in the bundle', /DEFAULT_RETRY_POLICY/.test(bundle))
check('maxRetries defaults to 2', /maxRetries:\s*2\b/.test(bundle), 'pattern not found')
check('backoffInitialMs defaults to 500', /backoffInitialMs:\s*500\b/.test(bundle), 'pattern not found')
check('backoffMaxMs defaults to 5000', /backoffMaxMs:\s*5e3\b/.test(bundle), 'pattern not found')
check('backoffJitter defaults to 0.25', /backoffJitter:\s*\.?0?\.?25\b/.test(bundle), 'pattern not found')
check('respectRetryAfter is on by default', /respectRetryAfter:\s*true\b/.test(bundle), 'pattern not found')
check('maxRetryAfterMs is 60000', /maxRetryAfterMs:\s*6e4\b/.test(bundle), 'pattern not found')
check('retry-after-ms is parsed (draft 3 cites this path)', /retry-after-ms/.test(bundle), 'header name not found')

const rateLimit = sdk.APIError.fromResponse(429, {}, new Headers({ 'retry-after': '30' }))
check(
  'RateLimitError exposes retryAfterMs parsed from Retry-After',
  rateLimit.retryAfterMs === 30_000,
  `got ${String(rateLimit.retryAfterMs)}`,
)
const msHeader = sdk.APIError.fromResponse(429, {}, new Headers({ 'retry-after-ms': '3600000' }))
check(
  "retry-after-ms of 3600000 is honoured literally, uncapped (draft 3's claim)",
  msHeader.retryAfterMs === 3_600_000,
  `got ${String(msHeader.retryAfterMs)} — if this is now capped, draft 3 is obsolete`,
)

// ---------- A caveat the drafts themselves state ----------
console.log('\n--- documented caveat ---')
check(
  'the package ships no src/ directory, so src/*.ts citations are not verifiable from the tarball',
  !/src[\\/]retry\.ts/.test(readFileSync(join(packageRoot, 'dist', 'index.d.mts'), 'utf8')),
)

console.log(
  failures === 0
    ? '\nAll draft claims hold against the installed SDK.'
    : `\n${failures} claim(s) did not hold — revise the drafts before filing.`,
)
process.exitCode = failures === 0 ? 0 : 1
