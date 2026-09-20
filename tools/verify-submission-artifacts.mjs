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
 *
 * Exit codes, which are part of the contract rather than an afterthought:
 *
 *   0  at least one check ran, and every check that ran passed
 *   1  a check failed, or no check could run at all
 *
 * That second half is the important one. `run` used to return `true` when a
 * sibling script was missing, so a `tools/` directory stripped down to this file
 * printed "All submission artifacts are current and their claims hold" — a
 * conclusion about two artifacts it had not opened. A check that did not run is
 * not a check that passed, and the whole reason this command exists is that
 * nobody can tell a stale draft from a fresh one by looking.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const sync = process.argv.includes('--sync')

/**
 * Run a sibling script and report `true`, `false`, or `undefined` when it is
 * absent. Three outcomes rather than a boolean, because "could not run" has to
 * stay distinguishable from "passed" all the way to the summary below.
 */
const run = (script, args = []) => {
  const scriptPath = join(here, script)
  if (!existsSync(scriptPath)) {
    console.log(`SKIP ${script} (not present, so nothing was verified by it)`)
    return undefined
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
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

const failed = results.filter((ok) => ok === false).length
const skipped = results.filter((ok) => ok === undefined).length
const ran = results.length - skipped

if (failed > 0) {
  console.log(`\n${failed} check(s) failed. Fix before filing anything.`)
  process.exitCode = 1
} else if (ran === 0) {
  console.log(
    `\nNo check could run: all ${results.length} sibling script(s) are missing, so nothing was ` +
      'verified. This is not a pass.',
  )
  process.exitCode = 1
} else if (skipped > 0) {
  console.log(
    `\n${ran} check(s) passed and ${skipped} did not run, because the script is not present ` +
      'beside this one. Nothing was verified for the missing ones.',
  )
  process.exitCode = 0
} else {
  console.log('\nAll submission artifacts are current and their claims hold.')
  process.exitCode = 0
}
