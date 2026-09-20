/**
 * Rename the published package identifiers from the @dsh-jev scope to the
 * jevkit family.
 *
 * Only *npm identifiers* change. The repository directory, the internal
 * `packages/dsh` folder, the `ctx.jev` service name, and the model-visible tool
 * names (`jev_ask`, `jev_rank`, `jev_check`) are deliberately left alone: they
 * are either local paths or part of the user-facing contract, and renaming them
 * is not what was asked.
 *
 *   @dsh-jev/core   -> jevkit          the framework-agnostic core
 *   @dsh-jev/plugin -> jevkit-dsh      the DSH/Cordis plugin
 *   @dsh-jev/mcp    -> jevkit-mcp      the MCP server
 *   dsh-jev-workspace -> jevkit-workspace
 *
 * The long names are replaced first, so no replacement can be re-matched by a
 * later rule.
 *
 * Usage:
 *   node scripts/rename-packages.mjs           # apply
 *   node scripts/rename-packages.mjs --check   # report leftovers, exit 1
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

/** Applied in order; the first match wins because these are distinct strings. */
const RENAMES = [
  ['@dsh-jev/plugin', 'jevkit-dsh'],
  ['@dsh-jev/core', 'jevkit'],
  ['@dsh-jev/mcp', 'jevkit-mcp'],
  ['dsh-jev-workspace', 'jevkit-workspace'],
  // Any surviving scope reference is a miss, reported below rather than
  // rewritten blindly.
]

/** Every tracked file that contains an identifier we care about. */
const trackedFiles = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && existsSync(join(ROOT, line)))

const NEEDLES = ['@dsh-jev/', 'dsh-jev-workspace']

let changed = 0
const leftovers = []

for (const relative of trackedFiles) {
  const path = join(ROOT, relative)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue // binary or unreadable; nothing to rename in a lockfile blob
  }
  if (!NEEDLES.some((needle) => text.includes(needle))) continue

  let updated = text
  for (const [from, to] of RENAMES) updated = updated.split(from).join(to)

  if (updated === text) continue

  if (checkOnly) {
    leftovers.push(relative)
    continue
  }
  writeFileSync(path, updated, 'utf8')
  changed += 1
  console.log(`rewrote ${relative}`)
}

if (checkOnly) {
  if (leftovers.length > 0) {
    console.error(`FAIL: ${leftovers.length} file(s) still carry the old identifiers:`)
    for (const file of leftovers) console.error(`  ${file}`)
    process.exit(1)
  }
  console.log('no old package identifiers remain in tracked files')
  process.exit(0)
}

console.log(`\n${changed} file(s) rewritten`)

// Report anything left behind, so a partial rename cannot pass as complete.
const survivors = execFileSync('git', ['grep', '-l', '-e', '@dsh-jev/', '-e', 'dsh-jev-workspace'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line.trim().length > 0)
if (survivors.length > 0) {
  console.error('\nWARNING: these files still contain an old identifier:')
  for (const file of survivors) console.error(`  ${file}`)
  process.exitCode = 1
} else {
  console.log('no old package identifiers remain in tracked files')
}
