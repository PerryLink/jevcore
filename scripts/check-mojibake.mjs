/**
 * Two gates for damage no other check in this repository can see: text that a
 * UTF-8 round-trip corrupted, and a build artifact that no longer matches the
 * source it was built from.
 *
 * WHY THE CORRUPTION GATE EXISTS
 *
 * An em dash in this repository's prose once came back from a UTF-8 -> GBK ->
 * UTF-8 round-trip as U+2014 followed by an ASCII `?`, travelled into `lib/`,
 * and was served at runtime inside a tool description. A whole-tree search for
 * U+FFFD found nothing the whole time, and it always will: `?` is valid ASCII,
 * and the surviving dash is the character that was meant to be there. Nothing
 * else in `pnpm run check` reads the raw characters of source, so this is the
 * only place the damage can be caught before it ships.
 *
 * WHAT IS FATAL AND WHAT IS ADVISORY, AND WHY THE SPLIT IS NOT A DODGE
 *
 *   - A hit in code, configuration, a workflow or a build artifact is FATAL.
 *     There is no legitimate reason for the sequence to be there: it is either
 *     the defect, or a fixture that deliberately quotes it -- and a fixture can
 *     say so in one line with the `mojibake:allow <reason>` marker below.
 *
 *   - A hit in a Markdown file is ADVISORY unless it was reviewed and recorded
 *     in `scripts/mojibake-allowlist.json`. Ten READMEs and SESSION-STATE.md
 *     quote the broken sequence verbatim, in backticks, in the section that
 *     records the incident: the corrupted form IS the evidence there, and every
 *     occurrence in this repository today -- thirteen of them, in eleven files
 *     -- is exactly that. A regex cannot tell a quotation from damage, and a
 *     gate that fails on the documentation of a defect is a gate people switch
 *     off. An unreviewed Markdown hit is printed on every run, so it is seen and
 *     decided on; recording it as a quotation, or fixing it, are both one line.
 *
 * The allowlist may name Markdown documents and nothing else -- an entry for a
 * source file or a `lib/` output is itself a failure, because silencing damage
 * in the artifact is the one thing this gate must not be talked out of.
 *
 * WHY THE DRIFT GATE COMPARES STRING LITERALS AND NOT LINES
 *
 * The obvious implementation -- compare the non-empty lines of `src/x.ts` with
 * those of `lib/x.js` -- cannot work, and the failure is not subtle. Measured on
 * this repository: `packages/core/src/types.ts` has 313 non-empty lines and
 * `lib/types.js` has 20, of which 6 appear nowhere in the source (`code;`,
 * `super(message, options)`, `//# sourceMappingURL=types.js.map`). TypeScript
 * erases types, elides type-only imports and drops interfaces, so ordinary
 * compilation looks exactly like drift, in every file, forever.
 *
 * String literals are the part of a TypeScript file that survives compilation
 * byte for byte, and they are what ships: a description, a log line, an error
 * message. The comparison is deliberately one-directional -- a literal is
 * reported only when the artifact has it and the source does not -- because
 * `src` legitimately holds literals that never reach `lib` (type-only imports,
 * interface members, `keyof` unions). A literal in both is a match; a literal
 * only in the source is what a correct build looks like.
 *
 * Two further filters keep the gate honest:
 *
 *   - Only text-like literals are considered: a letter and a space. An enum
 *     member name, a module specifier or a generated identifier is one token,
 *     and TypeScript emits names as strings that never appeared as string
 *     literals in the source, which would make them false drift.
 *   - A candidate must also be absent as a plain substring of the source text.
 *     A regex is not a parser, and a string it mis-paired out of a comment or an
 *     apostrophe would otherwise be reported; requiring the text to be absent
 *     from the source entirely makes such a mis-pair harmless.
 *
 * Orphan and missing outputs are checked too, because `tsc` never deletes:
 * `lib/x.js` whose `src/x.ts` is gone is a deleted file that npm would still
 * publish, and it survives a rebuild.
 *
 * WHAT THE DRIFT HALF FAILS ON, AND WHY ONLY THAT
 *
 * The rule is what a rebuild cannot fix. A stale or missing output is reported,
 * never failed: `pnpm run build` is the whole remedy, so failing would only ever
 * mean "you have not built since your last edit" -- a gate that goes red for
 * doing nothing wrong is a gate people learn to skip. What a rebuild does NOT
 * fix is fatal: an orphan output survives every build until someone deletes it,
 * and a declaration file committed under `src/` is build output that escaped
 * .gitignore once already.
 *
 * WHERE THIS GATE SITS, AND WHY
 *
 * It runs AFTER `build` in `pnpm run check`. The first draft ran before it, on
 * the argument that a stale `lib/` is only visible before the build refreshes
 * it. That argument does not survive contact with a working tree: every edit
 * makes `lib/` stale, so the chain printed the same advisory block on every run
 * until someone rebuilt -- noise on the normal path, which is how a real finding
 * gets skimmed past. What the earlier placement bought was the report "the
 * artifact lags the source", and in this repository nothing ships on that path:
 * `release.yml` runs the whole chain, build included, before it publishes, so
 * the artifact a registry or an npm consumer receives was always built from the
 * source it is being compared with. The placement that is left is the one the
 * corruption half wants anyway -- it now scans the artifact the build just
 * produced, which is the bytes that would ship.
 *
 * The stale-output comparison is still here and still correct; it now speaks
 * when this script is run on its own in a tree that has not been rebuilt, which
 * is the moment someone is asking that exact question. In the chain, the drift
 * half is quiet unless a rebuild could not have fixed it, which is the whole
 * point of the fatal tier above.
 *
 * Usage: node scripts/check-mojibake.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Never worth reading: other people's code, VCS metadata, other tools' output. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', 'dist', '.turbo'])

/** A file larger than this is not hand-written text, whatever its name says. */
const MAX_BYTES = 4 * 1024 * 1024

/** Silences the hits on its own line, but only when a reason follows it. */
const ALLOW_MARKER = 'mojibake:allow'

const ALLOWLIST_FILE = 'scripts/mojibake-allowlist.json'

/**
 * The sequences this gate looks for.
 *
 * Every pattern is written with `\u` escapes on purpose: this file must never
 * contain the bytes it hunts, or it would have to excuse itself. The `g` flag is
 * required by `String.prototype.matchAll`, the only thing these are used with,
 * so `lastIndex` is never read in a stateful way.
 */
const CORRUPTION = [
  {
    label: 'en or em dash followed by an ASCII question mark',
    pattern: /[\u2013\u2014]\?/gu,
    hint:
      'a UTF-8 round-trip replaced what followed the dash with `?`; restore the character, or ' +
      'delete the sequence. `git log -p -- <file>` shows the round-trip that did it.',
  },
  {
    label: 'Unicode replacement character U+FFFD',
    pattern: /\uFFFD/gu,
    hint: 'the bytes here were not valid UTF-8; recover the character or remove the placeholder.',
  },
  {
    label: 'UTF-8 read back as GBK',
    pattern: /\u9225|\u953F\u65A4\u62F7/gu,
    hint: 'this CJK sequence is a UTF-8 punctuation byte or a replacement pair read back as GBK.',
  },
  {
    label: 'UTF-8 read back as windows-1252',
    pattern: /\u00E2\u20AC/gu,
    hint: 'this is the windows-1252 misreading of a UTF-8 punctuation lead byte.',
  },
]

const failures = []
const warnings = []
const note = (message) => failures.push(message)
const warn = (message) => warnings.push(message)

/** Repository-relative, forward-slashed, so messages read the same on Windows. */
const relative = (file) => path.relative(root, file).split(path.sep).join('/')

/** True for the documents where quoting the defect is legitimate. */
const isMarkdown = (name) => name.endsWith('.md')

/**
 * The reviewed exceptions, or an empty set when there is no file.
 *
 * A missing file is not an error on its own: the hits it would have excused are
 * then reported as unreviewed, each one saying what to do about it. A file that
 * is present but unreadable is loud, because treating it as empty in silence is
 * how a reviewed exception quietly returns to being an unreviewed hit.
 */
const reviewedExceptions = () => {
  const file = path.join(root, ALLOWLIST_FILE)
  if (!existsSync(file)) return new Map()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    note(
      `${ALLOWLIST_FILE} cannot be read as JSON (${error.message}); the reviewed exceptions it ` +
        'holds are not being applied',
    )
    return new Map()
  }
  const entries = new Map()
  for (const [name, count] of Object.entries(parsed.reviewed ?? {})) {
    if (!isMarkdown(name)) {
      note(
        `${ALLOWLIST_FILE} reviews ${name}, which is not a Markdown document. Only documentation ` +
          'may be excused: in code, configuration or a build artifact the sequence is the defect.',
      )
      continue
    }
    entries.set(name, count)
  }
  return entries
}

/** Every file under `directory` that `accept` claims, by name. */
const walk = (directory, accept) => {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      for (const file of walk(path.join(directory, entry.name), accept)) found.push(file)
      continue
    }
    if (!entry.isFile()) continue
    if (!accept(entry.name)) continue
    const file = path.join(directory, entry.name)
    let size
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > 0 && size <= MAX_BYTES) found.push(file)
  }
  return found
}

/**
 * A source map embeds a copy of its source, so a hit inside one is the same hit
 * a second time, on a line that JSON-escaped the whole file into one string.
 */
const notAMap = (name) => !name.endsWith('.map')

/** Binary content read as UTF-8 produces replacement characters that are not damage. */
const text = (file) => {
  const bytes = readFileSync(file)
  if (bytes.includes(0)) return undefined
  return bytes.toString('utf8')
}

const reviewed = reviewedExceptions()
const hits = []
let scanned = 0
let excusedInline = 0

for (const file of walk(root, notAMap)) {
  const name = relative(file)
  const content = text(file)
  if (content === undefined) continue
  scanned += 1

  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    for (const signature of CORRUPTION) {
      const occurrences = [...line.matchAll(signature.pattern)].length
      if (occurrences === 0) continue

      const marker = line.indexOf(ALLOW_MARKER)
      if (marker !== -1) {
        const reason = line.slice(marker + ALLOW_MARKER.length).trim()
        if (reason === '') {
          note(
            `${name}:${index + 1}: \`${ALLOW_MARKER}\` with no reason after it. An exception ` +
              'nobody can review is not an exception: write why this occurrence is deliberate.',
          )
          continue
        }
        excusedInline += occurrences
        continue
      }

      // One record per line and signature, carrying how many times the sequence
      // occurs on it: the reviewed counts are counts of occurrences, and a line
      // that quotes the defect twice is two hits, not one.
      hits.push({
        name,
        line: index + 1,
        occurrences,
        signature,
        excerpt: line.trim().slice(0, 140),
      })
    }
  }
}

const byFile = new Map()
for (const hit of hits) {
  if (!byFile.has(hit.name)) byFile.set(hit.name, [])
  byFile.get(hit.name).push(hit)
}

/** Occurrences in a file's records, which is the unit the allowlist counts. */
const occurrencesIn = (records) => records.reduce((sum, hit) => sum + hit.occurrences, 0)

let honoured = 0
const honouredFiles = new Set()
for (const [name, count] of reviewed) {
  const found = occurrencesIn(byFile.get(name) ?? [])
  if (found === count) {
    honoured += count
    honouredFiles.add(name)
    byFile.delete(name)
    continue
  }
  if (found < count) {
    warn(
      `${ALLOWLIST_FILE} reviews ${count} hit(s) in ${name}, which now has ${found}. The prose it ` +
        'excuses was rewritten or removed: lower the number, or delete the entry.',
    )
  }
}

/** Cap per file, so one damaged document cannot bury every other finding. */
const PER_FILE_LIMIT = 10

let unreviewedHits = 0
for (const [name, found] of byFile) {
  const reviewedHere = reviewed.get(name)
  const total = occurrencesIn(found)
  const excess = reviewedHere === undefined ? total : total - reviewedHere
  if (excess <= 0) continue

  if (isMarkdown(name)) {
    unreviewedHits += excess
    warn(
      `${name}: ${total} hit(s), ${excess} of them not reviewed in ${ALLOWLIST_FILE}. ` +
        'Markdown hits are advisory because a quotation of this defect looks exactly like the ' +
        'defect; each one below needs a decision, not a guess.',
    )
    for (const hit of found.slice(0, PER_FILE_LIMIT)) {
      warn(`  ${hit.name}:${hit.line}: ${hit.signature.label} -- ${hit.excerpt}`)
    }
    if (found.length > PER_FILE_LIMIT) {
      warn(`  ${name}: and ${found.length - PER_FILE_LIMIT} more, not listed`)
    }
    continue
  }

  for (const hit of found) {
    note(`${hit.name}:${hit.line}: ${hit.signature.label} -- ${hit.excerpt}`)
    note(`  ${hit.signature.hint}`)
  }
}

/**
 * The string literals of a file, decoded. A template that interpolates is left
 * out: it is assembled at runtime from parts this scan cannot see, so it is not
 * comparable in either direction.
 */
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gu

const SIMPLE_ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' }

const decode = (raw) =>
  raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/gu, (_, body) => {
    if (body.startsWith('u{')) return String.fromCodePoint(Number.parseInt(body.slice(2, -1), 16))
    if (body.startsWith('u')) return String.fromCharCode(Number.parseInt(body.slice(1), 16))
    if (body.startsWith('x')) return String.fromCharCode(Number.parseInt(body.slice(1), 16))
    if (body === '\n') return ''
    return SIMPLE_ESCAPES[body] ?? body
  })

const literals = (content) => {
  const found = new Set()
  for (const match of content.matchAll(LITERAL)) {
    if (match[1] === '`' && match[2].includes('${')) continue
    try {
      found.add(decode(match[2]))
    } catch {
      found.add(match[2])
    }
  }
  return found
}

/**
 * Whether a literal is the kind of text this gate is about. A letter and a space
 * means prose somebody reads; that excludes module specifiers, enum member names
 * and the identifiers TypeScript emits as strings without a literal ever
 * appearing in the source, all of which would be reported as drift on a
 * perfectly correct build.
 */
const looksLikeProse = (literal) => /\p{L}/u.test(literal) && /\s/u.test(literal)

/** Cap per file here too: a stale artifact must not bury the other findings. */
const DRIFT_LIMIT = 5

const packagesRoot = path.join(root, 'packages')
const packages = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : []

const compared = []
let drifted = 0
let orphaned = 0

for (const name of packages) {
  const srcDir = path.join(packagesRoot, name, 'src')
  const libDir = path.join(packagesRoot, name, 'lib')
  if (!existsSync(srcDir)) continue

  // A clean checkout has no `lib/`: it is gitignored and built on demand, so
  // there is nothing to compare and nothing to report.
  if (!existsSync(libDir)) continue

  const sources = walk(srcDir, (file) => file.endsWith('.ts'))
  const outputs = walk(libDir, (file) => file.endsWith('.js'))
  compared.push(`packages/${name}`)

  const expected = new Set()
  for (const file of sources) {
    const inside = path.relative(srcDir, file).split(path.sep).join('/')

    // A declaration file under `src/` is build output that was committed: the
    // build emits declarations into `lib/`, and .gitignore already says so.
    if (inside.endsWith('.d.ts')) {
      note(
        `packages/${name}/src/${inside} is a declaration file inside the source tree. ` +
          'Declarations are emitted into lib/, and a copy here is build output that was committed.',
      )
      continue
    }

    const target = inside.replace(/\.ts$/u, '.js')
    expected.add(target)

    const output = path.join(libDir, target)
    if (!existsSync(output)) {
      warn(
        `packages/${name}/src/${inside} has no lib/${target}: the artifact predates this source ` +
          'file. A rebuild is the whole fix, so this is reported rather than failed -- run ' +
          '`pnpm run build`.',
      )
      continue
    }

    const sourceText = readFileSync(file, 'utf8')
    const sourceLiterals = literals(sourceText)
    const candidates = [...literals(readFileSync(output, 'utf8'))].filter(
      (literal) =>
        !sourceLiterals.has(literal) && !sourceText.includes(literal) && looksLikeProse(literal),
    )
    if (candidates.length === 0) continue

    drifted += 1
    const shown = candidates.slice(0, DRIFT_LIMIT).map((literal) => JSON.stringify(literal))
    warn(
      `packages/${name}/lib/${target} carries ${candidates.length} text literal(s) that ` +
        `packages/${name}/src/${inside} no longer has: ${shown.join(', ')}${
          candidates.length > DRIFT_LIMIT
            ? `, and ${candidates.length - DRIFT_LIMIT} more`
            : ''
        }. The artifact is stale, and one of these shipped once: a description in lib/ is what a ` +
        'host reads at runtime. A rebuild is the whole fix -- run `pnpm run build`.',
    )
  }

  for (const file of outputs) {
    const inside = path.relative(libDir, file).split(path.sep).join('/')
    if (expected.has(inside)) continue
    orphaned += 1
    note(
      `packages/${name}/lib/${inside} has no packages/${name}/src/${inside.replace(/\.js$/u, '.ts')}` +
        '. A rebuild does not delete it, so npm would publish a file whose source no longer ' +
        'exists: delete it, or run `pnpm run clean && pnpm run build`.',
    )
  }
}

if (warnings.length > 0) {
  console.log('mojibake warnings (advisory, not fatal -- each one is a decision for a human):')
  for (const warning of warnings) console.log(`  - ${warning}`)
}

if (failures.length > 0) {
  console.error('mojibake failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `mojibake: ${scanned} files scanned for corrupted text: ${honoured} hit(s) reviewed in ` +
    `${honouredFiles.size} documentation file(s), ${unreviewedHits} advisory Markdown hit(s) not ` +
    `reviewed, ${excusedInline} excused inline, 0 fatal`,
)
console.log(
  compared.length === 0
    ? 'drift:    no packages/*/lib in this checkout, so there is nothing to compare'
    : `drift:    ${compared.join(', ')} compared against lib/: ${drifted} stale file(s) reported ` +
        `above, ${orphaned} orphan output(s)`,
)
