// Five-language README sync gate.
//
// `README.md` is the source of truth; the four translations must stay its
// structural equal. Translated prose is expected to differ — everything else is
// not, and that distinction is the whole check.
//
// There are FOUR such sets, not one: the repository root and each of the three
// packages, because each package's npm page is its own document and the root
// translations cannot stand in for it. That is not a hypothetical — `files[]`
// listed the four translations while the package directories held none, so npm
// dropped them from every published tarball without a word. A set is checked as
// a unit: a package README without its translations is a failure, not an
// omission.
//
// What must match, and why each one is worth a gate rather than a convention:
//
//   - the `## ` section count, so a section added to one file cannot be silently
//     missing from the others;
//   - every fenced code block, compared verbatim. A translation must not touch a
//     command, an identifier or a log line, and "should not" is not a check. This
//     repo has already been bitten once by a shell command that looked fine and
//     was wrong;
//   - the set of URLs, so no link is dropped or rewritten in translation;
//   - the install command, because it is the one line a reader acts on;
//   - every configuration key in the Configuration table, so a documented option
//     cannot go missing from four of the five pages;
//   - the licence, because a licence that says MIT on the npm page while the
//     repository says Apache-2.0 is worse than either;
//   - the document's structural shape: the ordered sequence of headings, table
//     rows, fenced blocks, rules and list items, with all prose removed. A bare
//     `## ` count survives a section being dropped and another duplicated in its
//     place; the shape does not, because the dropped section takes its rows,
//     blocks and list items with it. Prose is excluded because prose is exactly
//     what a translation is allowed to change.
//
// Section headings are allowed to be translated, so they are counted, not compared.
//
// Usage: node scripts/check-readme-sync.mjs
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const SOURCE = 'README.md'
const TRANSLATIONS = ['README-zh.md', 'README-es.md', 'README-pt.md', 'README-hi.md']
const INSTALL_COMMAND = 'dsh plugin --profile <profile> add jevcore-dsh'
const LICENCE = 'Apache License 2.0'

/**
 * Every five-language README set in the repository.
 *
 * `requiresInstallCommand` is set only where the document is the plugin's own
 * page. Asserting it everywhere would demand that the core and MCP pages tell
 * the reader to install a plugin they did not ask for.
 */
const SETS = [
  { dir: '.', label: 'README.md', requiresInstallCommand: true },
  { dir: 'packages/core', label: 'packages/core/README.md', requiresInstallCommand: false },
  { dir: 'packages/dsh', label: 'packages/dsh/README.md', requiresInstallCommand: true },
  { dir: 'packages/mcp', label: 'packages/mcp/README.md', requiresInstallCommand: false },
]

const failures = []
const note = (message) => failures.push(message)

/** Read one file of a set, or record the failure and return undefined. */
const read = (dir, file) => {
  const relative = dir === '.' ? file : path.posix.join(dir, file)
  const filePath = path.join(root, dir, file)
  if (!existsSync(filePath)) {
    note(`${relative} is missing`)
    return undefined
  }
  const text = readFileSync(filePath, 'utf8')
  if (text.startsWith('\uFEFF')) note(`${relative} starts with a UTF-8 BOM`)
  return text
}

/** `## ` section count. Headings may be translated, so only the count is compared. */
const sectionCount = (text) => (text.match(/^## /gmu) ?? []).length

/** Does the document have a `## Configuration` section at all? */
const hasConfiguration = (text) => /^##\s+Configuration\s*$/mu.test(text)

/**
 * The document's structure, in order, as block types — no prose.
 *
 * Every token here is content rather than language: a translation may rewrite
 * any sentence, but it cannot invent a table row or lose a fenced block. Blank
 * lines are deliberately NOT tokens: they delimit paragraphs, and where a
 * paragraph is wrapped is a prose decision (the Hindi translations re-wrap every
 * paragraph and still match this signature exactly).
 */
const shape = (text) => {
  const tokens = []
  for (const line of text.split(/\r?\n/u)) {
    if (/^## /u.test(line)) tokens.push('H2')
    else if (/^### /u.test(line)) tokens.push('H3')
    else if (/^```/u.test(line)) tokens.push('FENCE')
    else if (/^\|/u.test(line)) tokens.push('ROW')
    else if (/^-{3,}\s*$/u.test(line)) tokens.push('HR')
    else if (/^[-*] /u.test(line)) tokens.push('LI')
    else if (/^\d+\. /u.test(line)) tokens.push('OL')
  }
  return tokens
}

/** Where two shapes first diverge, as a human-readable position. */
const firstDivergence = (expected, actual) => {
  const limit = Math.max(expected.length, actual.length)
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      return `block ${index + 1}: ${expected[index] ?? 'nothing'} vs ${actual[index] ?? 'nothing'}`
    }
  }
  return 'identical'
}

/** Every fenced block, verbatim, in document order. */
const fencedBlocks = (text) => [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gmu)].map((m) => m[1])

/** Every URL the document points at, as a set. */
const urls = (text) => new Set([...text.matchAll(/https?:\/\/[^\s)\]"'>]+/gu)].map((m) => m[0]))

/**
 * Configuration keys: the backticked token in the first cell of each row under
 * `## Configuration`, until the next `## ` heading.
 *
 * Header rows are excluded structurally — a header is the row a separator row
 * follows. That rule exists because a name blacklist is not enough: the MCP page
 * heads its table `| Variable | Effect |`, and `Variable` is a label the
 * translation is entitled to translate. Treating it as a key produced four false
 * failures the first time this gate ran against real translations.
 */
const configKeys = (text) => {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^##\s+Configuration\s*$/u.test(line))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s+/u.test(line))
  const section = end === -1 ? rest : rest.slice(0, end)
  const isSeparator = (line) => /^\|[\s:|-]*\|$/u.test(line ?? '')
  const keys = []
  for (const [index, line] of section.entries()) {
    if (!line.startsWith('|')) continue
    if (isSeparator(line) || isSeparator(section[index + 1])) continue
    const key = line.split('|')[1]?.trim()
    if (key === undefined || key === '') continue
    const tokens = [...key.matchAll(/`([^`]+)`/gu)].map((match) => match[1])
    keys.push(...(tokens.length > 0 ? tokens : [key]))
  }
  return keys
}

const summaries = []

for (const set of SETS) {
  const source = read(set.dir, SOURCE)
  if (source === undefined) continue

  const expectedSections = sectionCount(source)
  const expectedBlocks = fencedBlocks(source)
  const expectedUrls = urls(source)
  const expectedKeys = configKeys(source)
  const expectedShape = shape(source)

  if (expectedSections === 0) note(`${set.label} declares no '## ' sections; the gate would be vacuous`)
  if (expectedBlocks.length === 0) {
    note(`${set.label} declares no fenced code blocks; the gate would be vacuous`)
  }
  if (hasConfiguration(source) && expectedKeys.length === 0) {
    note(`${set.label} has a Configuration section but no keys; the gate would be vacuous`)
  }
  if (expectedShape.length < 20) {
    note(`${set.label} reduces to ${expectedShape.length} structural blocks; the shape check would be vacuous`)
  }
  if (set.requiresInstallCommand && !source.includes(INSTALL_COMMAND)) {
    note(`${set.label} does not contain the install command the gate checks for: ${INSTALL_COMMAND}`)
  }
  if (!source.includes(LICENCE)) note(`${set.label} does not state the licence: ${LICENCE}`)
  if (/^MIT$/mu.test(source)) note(`${set.label} still carries the bare 'MIT' licence line`)

  for (const file of TRANSLATIONS) {
    const text = read(set.dir, file)
    if (text === undefined) continue
    const relative = set.dir === '.' ? file : path.posix.join(set.dir, file)

    const sections = sectionCount(text)
    if (sections !== expectedSections) {
      note(`${relative}: ${sections} '## ' sections, expected ${expectedSections}`)
    }

    const blocks = fencedBlocks(text)
    if (blocks.length !== expectedBlocks.length) {
      note(`${relative}: ${blocks.length} fenced code blocks, expected ${expectedBlocks.length}`)
    } else {
      for (const [index, block] of blocks.entries()) {
        if (block !== expectedBlocks[index]) {
          note(
            `${relative}: code block ${index + 1} differs from ${SOURCE}. Code must be copied ` +
              'verbatim — commands, identifiers and log lines are not prose.',
          )
        }
      }
    }

    const has = urls(text)
    for (const url of expectedUrls) {
      if (!has.has(url)) note(`${relative}: missing the link ${url}`)
    }

    const actualShape = shape(text)
    if (actualShape.length !== expectedShape.length) {
      note(
        `${relative}: ${actualShape.length} structural blocks, expected ${expectedShape.length} ` +
          `(first difference at ${firstDivergence(expectedShape, actualShape)})`,
      )
    } else if (actualShape.join(' ') !== expectedShape.join(' ')) {
      note(
        `${relative}: structural shape differs from ${SOURCE} — first difference at ` +
          `${firstDivergence(expectedShape, actualShape)}. Headings may be translated; the order ` +
          'and number of headings, table rows, code blocks, rules and list items may not change.',
      )
    }

    if (set.requiresInstallCommand && !text.includes(INSTALL_COMMAND)) {
      note(`${relative}: missing the install command`)
    }
    if (!text.includes(LICENCE)) note(`${relative}: does not state the licence: ${LICENCE}`)
    if (/^MIT$/mu.test(text)) note(`${relative}: still carries the bare 'MIT' licence line`)

    for (const key of expectedKeys) {
      if (!text.includes(`\`${key}\``)) note(`${relative}: missing the configuration key \`${key}\``)
    }
  }

  summaries.push(
    `${set.label}: ${expectedSections} sections, ${expectedShape.length} structural blocks, ` +
      `${expectedBlocks.length} code blocks, ${expectedUrls.size} links, ${expectedKeys.length} config keys`,
  )
}

if (failures.length > 0) {
  console.error('readme-sync failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`readme-sync: ${SETS.length} README sets x 5 languages are in sync`)
for (const summary of summaries) console.log(`  ${summary}`)
