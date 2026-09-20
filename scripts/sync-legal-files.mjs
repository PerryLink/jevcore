/**
 * Assert every package ships the same LICENSE and NOTICE as the repository root.
 *
 * npm can only include files inside the package directory, so the root copies
 * have to be duplicated into each package before packing. Duplication drifts
 * unless something checks it, and the failure is quiet: a package publishes with
 * a stale or missing attribution file and nobody notices until it matters.
 *
 * This runs as part of `pnpm run check`, so a drift fails the build rather than
 * the publish. Fix it with:
 *
 *   node scripts/sync-legal-files.mjs
 *
 * Usage: node scripts/sync-legal-files.mjs [--check]
 */

import { copyFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packages = ['core', 'dsh', 'mcp']
const files = ['LICENSE', 'NOTICE']
const checkOnly = process.argv.includes('--check')

let failures = 0
for (const name of packages) {
  for (const file of files) {
    const source = join(root, file)
    const target = join(root, 'packages', name, file)

    let expected
    try {
      expected = readFileSync(source, 'utf8')
    } catch {
      console.error(`FAIL: ${file} is missing from the repository root`)
      failures += 1
      continue
    }

    let actual
    try {
      actual = readFileSync(target, 'utf8')
    } catch {
      actual = undefined
    }

    if (actual === expected) {
      console.log(`ok   packages/${name}/${file}`)
      continue
    }

    if (checkOnly) {
      console.error(
        `FAIL: packages/${name}/${file} is ${actual === undefined ? 'missing' : 'stale'}. ` +
          'Run: node scripts/sync-legal-files.mjs',
      )
      failures += 1
      continue
    }

    copyFileSync(source, target)
    console.log(`sync packages/${name}/${file}`)
  }
}

if (failures > 0) process.exit(1)
console.log(checkOnly ? 'legal files are in sync' : 'legal files synced')
