/**
 * Keep the artifacts that live outside this repository honest.
 *
 * Three files are drafted for submission rather than shipped:
 *
 *  - `typesafe-dsh-skill-proposal.md` — an issue against `typesafe-ai/skills`,
 *    containing a verbatim copy of the bundled SKILL.md;
 *  - `typesafe-sdk-issue-drafts.md` — four issue bodies for the TypeSafe SDK,
 *    making runtime claims about `@typesafe-ai/sdk`;
 *  - `verify-*.mjs` in this directory, which check the above.
 *
 * None of them can be guarded by a test, because none of them is in the package
 * tree. That is exactly why they need a command: a stale copy or an obsolete
 * claim is invisible until a maintainer reads it. Run this before pasting
 * anything into an issue tracker.
 *
 * The sibling files resolve the workspace from their own location, so the whole
 * `tools/` directory can be dropped onto another machine beside the drafts.
 *
 * Usage:
 *   node tools/verify-submission-artifacts.mjs           # check everything
 *   node tools/verify-submission-artifacts.mjs --sync    # refresh the copy
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const sync = process.argv.includes('--sync')

/** Run a sibling script and report whether it passed. */
const run = (script, args = []) => {
  const path = join(here, script)
  if (!existsSync(path)) {
    console.log(`SKIP ${script} (not present)`)
    return true
  }
  const result = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const ok = result.status === 0
  console.log(`${ok ? 'PASS' : 'FAIL'} ${script}`)
  for (const line of output.split('\n')) console.log(`     ${line}`)
  return ok
}

console.log('=== submission artifacts ===\n')

const results = [
  run('sync-proposal-skill.mjs', sync ? [] : ['--check']),
  run('verify-sdk-issue-claims.mjs'),
]

const failed = results.filter((ok) => !ok).length
console.log(
  failed === 0
    ? '\nAll submission artifacts are current and their claims hold.'
    : `\n${failed} check(s) failed. Fix before filing anything.`,
)
process.exitCode = failed === 0 ? 0 : 1
