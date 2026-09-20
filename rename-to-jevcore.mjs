/**
 * One-shot: rename the family root from `jevkit` to `jevcore`.
 *
 * `jevkit` was rejected by npm as too similar to the existing `jev-kit`
 * package, and the name also collides with `ariel-frischer/jevkit` on GitHub.
 * `jevcore` is clean on npm, GitHub and Gitee, keeps the Jev association that a
 * coined word would lose, and as an unhyphenated word it sits further from any
 * hyphenated neighbour than `jevkit` sat from `jev-kit`.
 *
 *   jevkit       -> jevcore        the framework-agnostic core
 *   jevkit-dsh   -> jevcore-dsh    the DSH plugin
 *   jevkit-mcp   -> jevcore-mcp    the MCP server
 *   jevkit-workspace -> jevcore-workspace
 *
 * Longest name first, so no replacement can be re-matched by a later rule and
 * `jevkit-dsh` cannot be clobbered by the bare `jevkit` rule.
 *
 * Usage: node rename-to-jevcore.mjs   (then delete this file)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The script sits at the repository root while it runs, so ROOT is its own
// directory. It is deleted immediately afterwards.
const ROOT = dirname(fileURLToPath(import.meta.url))

const RENAMES = [
  ['jevkit-dsh', 'jevcore-dsh'],
  ['jevkit-mcp', 'jevcore-mcp'],
  ['jevkit-workspace', 'jevcore-workspace'],
  ['jevkit', 'jevcore'],
  // The GitHub repository is being renamed to match, so the manifest URLs move
  // with it. npm's provenance and every bug-report link follow these fields.
  ['github.com/PerryLink/jevkit', 'github.com/PerryLink/jevcore'],
]

const NEEDLES = ['jevkit', 'github.com/PerryLink/jevkit']

const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && existsSync(join(ROOT, line)))

let changed = 0
for (const relative of files) {
  const path = join(ROOT, relative)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  if (!NEEDLES.some((needle) => text.includes(needle))) continue

  let updated = text
  for (const [from, to] of RENAMES) updated = updated.split(from).join(to)
  if (updated === text) continue

  writeFileSync(path, updated, 'utf8')
  changed += 1
  console.log(`rewrote ${relative}`)
}

console.log(`\n${changed} file(s) rewritten`)

const survivors = execFileSync('git', ['grep', '-l', 'jevkit'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
if (survivors.length > 0) {
  console.error('\nWARNING: these files still mention jevkit:')
  for (const file of survivors) console.error(`  ${file}`)
  process.exitCode = 1
} else {
  console.log('no tracked file still mentions jevkit')
}
