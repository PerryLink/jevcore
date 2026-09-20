/**
 * Copy every Markdown document in the repository's `docs/` into each package
 * that publishes it.
 *
 * npm can only include files inside the package directory, so the root
 * documentation has to be duplicated into each package before packing -- the
 * same constraint that puts LICENSE and NOTICE in three places. Duplication
 * drifts, and this drift failed in the quietest way available: the four
 * documents were in no package's `files[]` at all, so `npm install jevcore-dsh`
 * delivered a plugin with no quickstart and no statement of the deployment's
 * limits, while the repository looked complete.
 *
 * `files[]` is necessary and it is not sufficient. npm drops an entry it cannot
 * find without a word, so a manifest that names `docs` over a directory nobody
 * generated publishes exactly as much as no entry at all -- which is what the
 * README translations did before `scripts/check-readme-sync.mjs` existed. The
 * copy loop below is the "find"; the manifest assertion at the end of each
 * package is the "name". A document needs both to arrive.
 *
 * The copies are not byte-for-byte. Each one opens with a banner naming its
 * source and the command that regenerates it, because a copy has one failure
 * mode the legal files do not have: a reader edits the wrong one and the edit
 * disappears at the next sync. A LICENSE that differs from the root copy is not
 * the licence, so that one is copied verbatim; a quickstart that says where it
 * came from is still the quickstart.
 *
 * This runs as part of `pnpm run check`, so drift fails the build rather than
 * the publish. Fix it with:
 *
 *   node scripts/sync-package-docs.mjs
 *
 * Usage: node scripts/sync-package-docs.mjs [--check]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the canonical documents live, and what each copy is generated into. */
const SOURCE_DIR = 'docs'

/**
 * The packages whose tarballs carry the documentation.
 *
 * Every publishable package, which now includes the CLI. A package that names
 * `docs` in `files[]` without generating it fails the assertion below, and one
 * that ships no documentation at all is the gap this script was written to close
 * in the first place. `docs/limits.md` and `docs/quickstart.md` are as relevant to
 * somebody running `jev` from a shell as to somebody mounting the plugin.
 */
const packages = ['core', 'dsh', 'mcp', 'cli']

const checkOnly = process.argv.includes('--check')

let failures = 0

/** One failure, printed where it happens and counted for the exit code. */
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}

/** Repository-relative, forward-slashed, so messages read the same on Windows. */
const posix = (path) => path.split(sep).join('/')

/**
 * The banner every copy opens with.
 *
 * An HTML comment renders nowhere -- not on GitHub, not in a Markdown preview --
 * so it costs the reader nothing and answers the one question a copy raises:
 * why an edit here is pointless.
 */
const banner = (source) => `<!--
  Generated from ${source}. Do not edit this copy: the next sync overwrites it.
  Regenerate with \`node scripts/sync-package-docs.mjs\` from the repository root.
-->

`

/**
 * Every Markdown document under `directory`, as a path relative to it, sorted.
 *
 * Relative to the directory rather than to the repository root, because the
 * same shape is compared against two trees at once: what `docs/` holds and what
 * `packages/<name>/docs/` holds.
 *
 * Sorted because `readdirSync` returns them in the filesystem's order, and this
 * output is read by a person diagnosing a failed run.
 */
const markdownIn = (directory) => {
  const base = join(root, directory)
  const walk = (current) => {
    const found = []
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        found.push(...walk(path))
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      // Only a regular file can be copied or pruned. A symlink or a device node
      // named `*.md` falls through every branch here, and a document skipped in
      // silence is a document that ships to nobody.
      if (!entry.isFile()) {
        fail(`${posix(relative(root, path))} is not a regular file, so it cannot be copied`)
        continue
      }
      found.push(posix(relative(base, path)))
    }
    return found
  }
  return walk(base).sort()
}

/**
 * Remove directories a prune emptied, deepest first.
 *
 * git and npm both ignore an empty directory, so leaving one is not drift. It
 * is still worth deleting: a `docs/` that exists and holds nothing reads like a
 * package that documents something.
 */
const pruneEmptyDirectories = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirectories(join(directory, entry.name))
  }
  if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true })
}

if (!existsSync(join(root, SOURCE_DIR))) {
  fail(`${SOURCE_DIR}/ does not exist, so the packages would ship no documentation`)
  process.exit(1)
}

const sources = markdownIn(SOURCE_DIR)

// A copy of nothing is not a sync: without this the script would create three
// empty directories and report success, and `files[]` would name a `docs` that
// holds none.
if (sources.length === 0) {
  fail(`${SOURCE_DIR}/ holds no Markdown documents, so the copies would be empty`)
  process.exit(1)
}

for (const name of packages) {
  const packageDir = `packages/${name}`
  const docsDir = `${packageDir}/${SOURCE_DIR}`

  for (const source of sources) {
    const canonical = `${SOURCE_DIR}/${source}`
    const target = join(root, docsDir, source)
    const shown = `${docsDir}/${source}`

    let bytes
    try {
      bytes = readFileSync(join(root, canonical))
    } catch (error) {
      fail(
        `${canonical} could not be read (${error.message}). A document that cannot be read is a ` +
          'document that never reached the packages',
      )
      continue
    }

    // Buffers, not decoded strings: a UTF-8 decode replaces a stray invalid byte
    // with U+FFFD and writes the replacement into the copy, so the copy would
    // differ from its source in a way no reader of the diff can see.
    const expected = Buffer.concat([Buffer.from(banner(canonical), 'utf8'), bytes])

    let actual
    try {
      actual = readFileSync(target)
    } catch {
      actual = undefined
    }

    if (actual !== undefined && actual.equals(expected)) {
      console.log(`ok   ${shown}`)
      continue
    }

    if (checkOnly) {
      fail(
        `${shown} is ${actual === undefined ? 'missing' : 'stale'}. ` +
          'Run: node scripts/sync-package-docs.mjs',
      )
      continue
    }

    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, expected)
    } catch (error) {
      fail(`${shown} could not be written (${error.message})`)
      continue
    }
    console.log(`sync ${shown}`)
  }

  // A copy whose source is gone is published forever otherwise: `files[]` ships
  // the whole directory, and nothing else in this repository knows the file
  // exists. check-mojibake.mjs reports an orphan artifact for the same reason.
  if (existsSync(join(root, docsDir))) {
    const expectedDocuments = new Set(sources)
    for (const source of markdownIn(docsDir)) {
      if (expectedDocuments.has(source)) continue
      const shown = `${docsDir}/${source}`
      if (checkOnly) {
        fail(
          `${shown} has no ${SOURCE_DIR}/${source} to regenerate it. Delete it, or run: ` +
            'node scripts/sync-package-docs.mjs',
        )
        continue
      }
      rmSync(join(root, docsDir, source))
      console.log(`prune ${shown}`)
    }
    if (!checkOnly) pruneEmptyDirectories(join(root, docsDir))
  }

  // `files[]` is what makes the copies shippable, so a manifest that does not
  // name them publishes a package whose documentation exists only in the
  // repository. That is a one-line mistake with no symptom until a consumer goes
  // looking: what a gate does not name, it does not protect.
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    fail(`${packageDir}/package.json could not be read as JSON (${error.message})`)
  }
  const listsDocs = Array.isArray(manifest?.files) && manifest.files.includes(SOURCE_DIR)
  if (manifest !== undefined && !listsDocs) {
    fail(
      `${packageDir}/package.json does not list "${SOURCE_DIR}" in files[]. npm would drop ` +
        `every copy in ${docsDir}; add "${SOURCE_DIR}" to files[] there.`,
    )
  }
}

if (failures > 0) process.exit(1)
console.log(checkOnly ? 'package documentation is in sync' : 'package documentation synced')
