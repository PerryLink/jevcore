/**
 * The workflow shell gate.
 *
 * A backtick inside a `run:` block is command substitution, and bash performs it
 * BEFORE the program in the block ever sees the text. When a step runs
 * `node -e "..."`, that means a backtick written inside the JavaScript program
 * -- including inside a JavaScript comment -- is executed by the shell first.
 *
 * This is not hypothetical and it is not a style preference:
 *
 *  - `ci.yml` carries a NOTE saying the script contains no backticks at all,
 *    because a stray pair once replaced part of the program with an empty string
 *    and node reported a syntax error far from its cause. The NOTE says bash
 *    performs the substitution first and that "a comment is not exempt".
 *  - The same file then kept one: a `files` in backticks inside a JavaScript
 *    comment. It happened to be harmless, because a failed substitution becomes
 *    an empty string and `files` is not a command, so the comment merely lost two
 *    characters and bash printed `files: command not found` to a log nobody reads
 *    on a green run. An accident that survives is how a rule stops being followed.
 *  - A second instance was added by the very change that introduced this gate.
 *
 * So: what a gate does not name, it does not protect. That cuts both ways. A gate
 * that reports a backtick bash would not expand teaches its reader to ignore it,
 * and a gate that stays silent about a shape it never learned reads as a pass.
 * An earlier version of this file failed in both directions at once: it missed
 * `run: |2-`, `run:` with its value on the next line, and `run` inside a flow
 * mapping, while reporting backticks inside quoted here-document bodies and
 * inside single quotes, where bash expands nothing.
 *
 * ## What this gate analyses
 *
 * For every `run:` value it can find, it reconstructs the text bash would receive
 * and reports a backtick bash would expand there. It recognises:
 *
 *  - block scalars, with the indentation and chomping indicators in either order
 *    (`|`, `|-`, `|2`, `|2-`, `|-2`, `>+2`, ...) and an optional trailing comment;
 *  - a plain scalar that starts on the `run:` line and continues on the more
 *    indented lines below it;
 *  - a plain scalar that starts on the line after `run:`;
 *  - a single- or double-quoted YAML scalar, including one that spans lines, with
 *    YAML escapes decoded (`run: "\x60whoami\x60"` is a backtick command);
 *  - `run` as a key inside a flow mapping or flow sequence, on one line or spread
 *    over several.
 *
 * ## Where bash does not expand, and how that is modelled
 *
 *  - A shell comment: at the start of a line, or at the start of a word mid-line.
 *    A JavaScript comment is not a shell comment, which is what the original
 *    defect turned on.
 *  - A single-quoted string. Quote state is carried across the lines of one run
 *    value, so a single-quoted string that spans lines is still literal.
 *  - A backslash escape, `\``.
 *  - The body of a here-document with a QUOTED delimiter -- `<<'EOF'`, `<<"EOF"`,
 *    `<<\EOF`. Nothing expands in such a body, so its backticks are literal.
 *  - The body of an UNQUOTED here-document is not exempt: it expands like a
 *    double-quoted string, so a backtick in it is still reported.
 *
 * ## Known gaps -- shapes this gate does not analyse
 *
 * Deliberately a plain text scan rather than a YAML parse: this repository has no
 * YAML dependency, and adding one to check five files would make the release path
 * depend on a parser to enforce a rule about characters. That choice has a
 * boundary, and the boundary is this list:
 *
 *  1. Anchors, aliases and merge keys. A `run` value reached through `*alias` or
 *     `<<: *x` is not followed, and text reachable only that way is not scanned.
 *  2. A `run` key written as anything but a plain `run:` -- a quoted key, an
 *     explicit `? run` key, or a key containing an escape.
 *  3. Tabs as indentation, and any line whose indentation cannot be measured.
 *  4. `${{ ... }}` expressions are not evaluated: a backtick that exists only
 *     after expression substitution is invisible here.
 *  5. Quoting inside a command substitution is not modelled separately, so a
 *     single-quoted region opened inside `` `...` `` is treated as if it ran on
 *     past the closing backtick.
 *  6. A `run:` whose value YAML reads as a mapping or a sequence -- `run:`
 *     followed by a deeper `FOO: bar` or `- item` -- is not a shell script
 *     (Actions refuses such a workflow) and is skipped rather than guessed at.
 *  7. A block scalar under `run` inside a flow collection, which is not valid
 *     YAML, is not scanned.
 *  8. Only `run` is treated as shell. A backtick in `with:`, `env:` or any other
 *     key is left alone, so a `run:` step living inside one of those strings is
 *     missed.
 *
 * A pass means: no backtick in the run values this scan can see is reachable by
 * bash command substitution. It does not mean "no backtick can reach bash".
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Printed with the verdict, so a pass carries its own scope. Mirrors the list above. */
const SCOPE =
  'scope: run values in .github/workflows/*.yml and .github/actions/**/*.yml; shell comments, ' +
  'single quotes and quoted here-document bodies are literal. Not analysed: anchors and aliases, ' +
  '`${{ }}` expressions, non-plain `run` keys, tabs as indentation -- see the header of this script.'

/** Every file that can hold a `run:` block. */
const targets = () => {
  const found = []
  const workflows = path.join(root, '.github', 'workflows')
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) {
        found.push(path.join(workflows, entry.name))
      }
    }
  }
  // Composite actions live at any depth under .github/actions, so walk it.
  const actions = path.join(root, '.github', 'actions')
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.ya?ml$/u.test(entry.name)) found.push(full)
    }
  }
  if (existsSync(actions) && statSync(actions).isDirectory()) walk(actions)
  return found.sort()
}

/** Indentation in spaces. Tabs are not valid YAML indentation and are not handled. */
const indentOf = (line) => line.length - line.trimStart().length

// --- reading YAML values ----------------------------------------------------

/**
 * A block scalar header for ANY key, not only `run`: the indentation indicator and
 * the chomping indicator may come in either order (`|2-` and `|-2` are both
 * legal) and a comment may follow. Keys other than `run` matter because their
 * bodies must be skipped -- a line inside a `description: |` that reads like
 * `run:` is text, not a step.
 *
 * A header the pattern refuses is not reported as an error: it is reclassified as
 * a one-line `run:` whose body is then never scanned. A guard that fails open on
 * unusual formatting is the failure mode this file exists to catch.
 */
const BLOCK_HEADER =
  /^(\s*)(-\s+)?([A-Za-z_][\w.-]*)\s*:[ \t]*([|>])([1-9][-+]?|[-+]?[1-9]?)?[ \t]*(#.*)?$/u

/** `run:` with whatever follows the colon on that line. */
const RUN_PREFIX = /^(\s*)(-\s+)?run:([ \t]*)(.*)$/u

/**
 * The start of a YAML node that ends a plain scalar: a mapping entry (`key:` or
 * `key: value`) or a block sequence entry. A line matching this is not shell text,
 * because YAML reads `run:` + `FOO: bar` as a mapping and `run:` + `- x` as a
 * sequence -- neither is a string, so neither reaches a shell.
 */
const NODE_START = /^\s*(?:-\s|[^\s#][^:]*:(?:\s|$))/u

/** A flow collection opening where a step or a nested value can plausibly start. */
const FLOW_OPEN = /^(\s*)(?:-\s+)?(?:[A-Za-z_][\w.-]*[ \t]*:[ \t]*)?([[{])/u

/** A plain scalar ends at ` #`, which is a YAML comment. A quoted scalar does not. */
const cutYamlComment = (text) => {
  const at = text.search(/[ \t]#/u)
  return at === -1 ? text : text.slice(0, at)
}

/** What a YAML escape stands for. Only the ones that change quoting matter. */
const ESCAPES = new Map([
  ['0', ' '], ['a', ' '], ['b', ' '], ['t', ' '], ['n', ' '], ['v', ' '], ['f', ' '],
  ['r', ' '], ['e', ' '], [' ', ' '], ['N', ' '], ['_', ' '], ['L', ' '], ['P', ' '],
  ['"', '"'], ['/', '/'], ['\\', '\\'],
])

/**
 * Decode the escape at `index` of `line`, which points at the backslash. The
 * numeric forms are decoded rather than skipped: `\x60` is a backtick by the time
 * bash sees the text.
 */
const decodeEscape = (line, index) => {
  const match = /^\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/u.exec(line.slice(index))
  if (match === null) return { text: '\\', length: 1 }
  const body = match[1]
  if (body.length === 1) return { text: ESCAPES.get(body) ?? body, length: 2 }
  return { text: String.fromCodePoint(Number.parseInt(body.slice(1), 16)), length: 1 + body.length }
}

/**
 * A quoted YAML scalar in block context, which may span lines. An escaped line
 * break joins without a space; an unescaped one folds to a space. Whitespace is
 * approximate -- only quoting and escapes decide whether bash expands a backtick.
 */
const readQuoted = (lines, index, column, quote) => {
  let text = ''
  let synthetic = false
  let line = index
  let at = column + 1
  let closed = false
  let continued = false
  while (line < lines.length) {
    const current = lines[line]
    while (at < current.length) {
      const character = current[at]
      if (quote === "'") {
        if (character === "'") {
          if (current[at + 1] === "'") {
            text += "'"
            at += 2
            continue
          }
          closed = true
          at += 1
          break
        }
        text += character
        at += 1
        continue
      }
      if (character === '\\') {
        if (at + 1 >= current.length) {
          continued = true
          at += 1
          break
        }
        const escape = decodeEscape(current, at)
        if (escape.text === '`') synthetic = true
        text += escape.text
        at += escape.length
        continue
      }
      if (character === '"') {
        closed = true
        at += 1
        break
      }
      text += character
      at += 1
    }
    if (closed) break
    line += 1
    if (line >= lines.length) break
    if (!continued) text += ' '
    continued = false
    at = indentOf(lines[line])
  }
  return { text, synthetic, endLine: Math.min(line, lines.length - 1) }
}

/**
 * The scalar that starts at (index, column) in block context, as one segment per
 * line so that a report can name the line and column the backtick is on.
 */
const readBlockScalar = (lines, index, column, keyColumn) => {
  const line = lines[index]
  const quote = line[column]
  if (quote === "'" || quote === '"') {
    const decoded = readQuoted(lines, index, column, quote)
    return {
      // +1: the opening quote is not part of the text, so the content starts after it.
      segments: [{ line: index, column: column + 1, text: decoded.text, synthetic: decoded.synthetic }],
      endLine: decoded.endLine,
    }
  }
  const segments = [{ line: index, column, text: cutYamlComment(line.slice(column)) }]
  let endLine = index
  while (endLine + 1 < lines.length) {
    const candidate = lines[endLine + 1]
    if (candidate.trim().length === 0) break
    if (indentOf(candidate) <= keyColumn) break
    if (NODE_START.test(candidate)) break
    endLine += 1
    segments.push({ line: endLine, column: 0, text: cutYamlComment(candidate) })
  }
  return { segments, endLine }
}

// --- reading flow collections ----------------------------------------------

/** The character at the cursor, `\n` at the end of a line, '' at the end of input. */
const cursorChar = (lines, cursor) =>
  cursor.line >= lines.length
    ? ''
    : cursor.column >= lines[cursor.line].length
      ? '\n'
      : lines[cursor.line][cursor.column]

const takeChar = (lines, cursor) => {
  const character = cursorChar(lines, cursor)
  if (character === '\n') {
    cursor.line += 1
    cursor.column = 0
  } else if (character !== '') {
    cursor.column += 1
  }
  return character
}

const skipSpace = (lines, cursor) => {
  for (;;) {
    const character = cursorChar(lines, cursor)
    if (character === ' ' || character === '\t' || character === '\n') takeChar(lines, cursor)
    else return
  }
}

/** A YAML scalar at the cursor, inside a flow collection. */
const readFlowScalar = (lines, cursor) => {
  const start = { line: cursor.line, column: cursor.column }
  const quote = cursorChar(lines, cursor)
  if (quote === "'" || quote === '"') {
    takeChar(lines, cursor)
    let text = ''
    let synthetic = false
    for (;;) {
      const character = cursorChar(lines, cursor)
      if (character === '') break
      if (quote === "'") {
        if (character === "'") {
          takeChar(lines, cursor)
          if (cursorChar(lines, cursor) === "'") {
            takeChar(lines, cursor)
            text += "'"
            continue
          }
          break
        }
        text += character
        takeChar(lines, cursor)
        continue
      }
      if (character === '\\') {
        if (cursor.column + 1 >= lines[cursor.line].length) {
          takeChar(lines, cursor)
          takeChar(lines, cursor)
          continue
        }
        const escape = decodeEscape(lines[cursor.line], cursor.column)
        if (escape.text === '`') synthetic = true
        text += escape.text
        for (let step = 0; step < escape.length; step += 1) takeChar(lines, cursor)
        continue
      }
      if (character === '"') {
        takeChar(lines, cursor)
        break
      }
      text += character
      takeChar(lines, cursor)
    }
    // +1: the opening quote is not part of the text, so the content starts after it.
    return { line: start.line, column: start.column + 1, text, synthetic }
  }
  let text = ''
  for (;;) {
    const character = cursorChar(lines, cursor)
    if (character === '' || character === ',' || character === '}' || character === ']') break
    if (character === '#' && (text.length === 0 || /\s/u.test(text[text.length - 1]))) {
      while (cursorChar(lines, cursor) !== '\n' && cursorChar(lines, cursor) !== '') takeChar(lines, cursor)
      continue
    }
    text += character
    takeChar(lines, cursor)
  }
  return { ...start, text: text.trim(), synthetic: false }
}

/** The plain or quoted key at the cursor, or null when there is none. */
const readFlowKey = (lines, cursor) => {
  const character = cursorChar(lines, cursor)
  if (character === '"' || character === "'") return readFlowScalar(lines, cursor).text
  const match = /^[A-Za-z_][\w.-]*/u.exec(lines[cursor.line].slice(cursor.column))
  if (match === null) return null
  for (let step = 0; step < match[0].length; step += 1) takeChar(lines, cursor)
  return match[0]
}

/**
 * The `run` values inside the flow collection that opens at (index, column).
 * Returns null when the collection never closes, so an unbalanced brace in
 * ordinary text cannot swallow the rest of the file. `blockHeader` is set when a
 * `run: |` turns up inside the collection: that is not valid YAML, so the region
 * was probably mis-detected and the caller should fall back to the block path.
 */
const readFlowRunValues = (lines, index, column, limit) => {
  const cursor = { line: index, column }
  const values = []
  let blockHeader = null
  let depth = 0
  let atKey = true
  for (;;) {
    const character = cursorChar(lines, cursor)
    if (character === '' || cursor.line - index > limit) return null
    if (character === '\n' || character === ' ' || character === '\t') {
      takeChar(lines, cursor)
      continue
    }
    if (character === '#') {
      while (cursorChar(lines, cursor) !== '\n' && cursorChar(lines, cursor) !== '') takeChar(lines, cursor)
      continue
    }
    if (character === '{' || character === '[') {
      depth += 1
      takeChar(lines, cursor)
      atKey = true
      continue
    }
    if (character === '}' || character === ']') {
      depth -= 1
      takeChar(lines, cursor)
      if (depth === 0) return { values, blockHeader, endLine: cursor.line }
      atKey = true
      continue
    }
    if (character === ',') {
      takeChar(lines, cursor)
      atKey = true
      continue
    }
    if (atKey && /[A-Za-z_"']/u.test(character)) {
      const saved = { line: cursor.line, column: cursor.column }
      const key = readFlowKey(lines, cursor)
      if (key !== null) {
        skipSpace(lines, cursor)
        if (cursorChar(lines, cursor) === ':') {
          takeChar(lines, cursor)
          skipSpace(lines, cursor)
          const next = cursorChar(lines, cursor)
          if (key === 'run') {
            if (next === '|' || next === '>') blockHeader = saved
            else values.push(readFlowScalar(lines, cursor))
          } else if (next === '"' || next === "'") {
            readFlowScalar(lines, cursor)
          }
          atKey = false
          continue
        }
        cursor.line = saved.line
        cursor.column = saved.column
      }
    }
    if (character === '"' || character === "'") {
      readFlowScalar(lines, cursor)
      atKey = false
      continue
    }
    takeChar(lines, cursor)
    atKey = false
  }
}

// --- the shell scan ---------------------------------------------------------

const failures = []
const note = (message) => failures.push(message)

let runValues = 0
const shapes = { block: 0, plain: 0, inline: 0, flow: 0 }
let carried = 0
let exempt = 0
let reachable = 0

/** A here-document ends when the delimiter is alone on the line (`<<-` strips tabs). */
const delimiterEnds = (text, heredoc) =>
  (heredoc.tabs ? text.replace(/^\t*/u, '') : text) === heredoc.delimiter

/**
 * Report the backticks in one run value that bash would expand. Quote state and
 * pending here-documents are carried across the lines of the value, because the
 * value is one shell script.
 */
const scanRunValue = (segments, relative) => {
  let quote = null
  const pending = []
  for (const segment of segments) {
    const text = segment.text
    const holdsBacktick = text.includes('`')
    if (holdsBacktick) carried += 1
    let hit = null
    if (pending.length > 0) {
      // A here-document body. With a quoted delimiter nothing expands; without
      // one the body expands like a double-quoted string, so only quotes are inert.
      if (delimiterEnds(text, pending[0])) pending.shift()
      else if (!pending[0].quoted) {
        for (let at = 0; at < text.length; at += 1) {
          if (text[at] === '\\') at += 1
          else if (text[at] === '`') {
            hit = at
            break
          }
        }
      }
    } else {
      let at = 0
      while (at < text.length) {
        const character = text[at]
        if (quote === "'") {
          if (character === "'") quote = null
          at += 1
          continue
        }
        if (quote === '"') {
          if (character === '\\') at += 2
          else if (character === '"') {
            quote = null
            at += 1
          } else {
            if (character === '`' && hit === null) hit = at
            at += 1
          }
          continue
        }
        if (character === '\\') {
          at += 2
          continue
        }
        if (character === "'") {
          quote = "'"
          at += 1
          continue
        }
        if (character === '"') {
          quote = '"'
          at += 1
          continue
        }
        if (character === '`') {
          if (hit === null) hit = at
          at += 1
          continue
        }
        if (character === '#' && (at === 0 || ' \t;&|()<>'.includes(text[at - 1]))) break
        if (character === '<' && text[at + 1] === '<') {
          const operator =
            /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/u.exec(
              text.slice(at),
            )
          if (operator !== null) {
            pending.push({
              delimiter: operator[2] ?? operator[3] ?? operator[4] ?? operator[5],
              quoted: operator[5] === undefined,
              tabs: operator[1] === '-',
            })
            at += operator[0].length
            continue
          }
        }
        at += 1
      }
    }
    if (!holdsBacktick) continue
    if (hit === null) {
      exempt += 1
      continue
    }
    reachable += 1
    const decoded =
      segment.synthetic === true && !text.includes('`')
        ? ' (the value spells no backtick literally; a YAML escape decodes to one)'
        : ''
    note(
      `${relative}:${segment.line + 1}:${segment.column + hit + 1} a backtick on a line bash will ` +
        `expand: ${text.trim()}${decoded}\n` +
        '    bash performs command substitution on backticks before the program in the step sees the ' +
        'text, so this is executed as a command. Use a shell comment, or drop the backticks.',
    )
  }
}

// --- the scan ---------------------------------------------------------------

for (const file of targets()) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const lines = readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    // A flow collection first: `run` inside one is a step written on a single
    // line, or a collection spread over several.
    const flow = FLOW_OPEN.exec(line)
    if (flow !== null) {
      const region = readFlowRunValues(lines, index, flow[0].length - 1, 400)
      if (region !== null) {
        for (const value of region.values) {
          runValues += 1
          shapes.flow += 1
          scanRunValue(
            [{ line: value.line, column: value.column, text: value.text, synthetic: value.synthetic }],
            relative,
          )
        }
        if (region.blockHeader === null || region.blockHeader.line <= index) {
          index = region.endLine
          continue
        }
        index = region.blockHeader.line - 1
        continue
      }
    }

    // A block scalar header. With an indentation indicator the body is the lines
    // indented at least that far past the key; without one, the first body line
    // sets the indentation, as YAML does. A blank line belongs to the body; the
    // first non-blank line at or below the key's own indentation ends it.
    const header = BLOCK_HEADER.exec(line)
    if (header !== null) {
      const keyColumn = header[1].length + (header[2] === undefined ? 0 : header[2].length)
      const indicator = /[1-9]/u.exec(header[5] ?? '')
      const declared = indicator === null ? null : keyColumn + Number(indicator[0])
      let end = index + 1
      while (end < lines.length) {
        const candidate = lines[end]
        if (candidate.trim().length === 0) {
          end += 1
          continue
        }
        if (declared === null ? indentOf(candidate) <= keyColumn : indentOf(candidate) < declared) break
        end += 1
      }
      // YAML strips the block's indentation from every line of its content, and
      // the shell only ever sees the stripped text. Heredoc delimiters depend on
      // it: an indented `EOF` matches once the indentation is gone.
      let dedent = declared ?? keyColumn + 1
      if (declared === null) {
        for (let probe = index + 1; probe < end; probe += 1) {
          if (lines[probe].trim().length > 0) {
            dedent = indentOf(lines[probe])
            break
          }
        }
      }
      if (header[3] === 'run') {
        runValues += 1
        shapes.block += 1
        const segments = []
        for (let body = index + 1; body < end; body += 1) {
          const raw = lines[body].trimEnd()
          const cut = Math.min(dedent, indentOf(raw))
          segments.push({ line: body, column: cut, text: raw.slice(cut) })
        }
        scanRunValue(segments, relative)
      }
      index = end - 1
      continue
    }

    const prefix = RUN_PREFIX.exec(line)
    if (prefix === null) continue
    const keyColumn = prefix[1].length + (prefix[2] === undefined ? 0 : prefix[2].length)
    const rest = prefix[4]
    const valueColumn = line.length - rest.length

    if (rest.trim().length === 0 || rest.trimStart().startsWith('#')) {
      // The value begins on the following lines, or there is none. A plain scalar
      // there ends where YAML ends it: at a shallower line, at a blank line, or at
      // a line that starts a mapping or sequence entry instead of continuing the
      // scalar (`run:` + `FOO: bar` is a mapping and `run:` + `- x` is a sequence,
      // and neither one is a shell script).
      const segments = []
      let end = index
      while (end + 1 < lines.length) {
        const candidate = lines[end + 1]
        if (candidate.trim().length === 0) break
        if (indentOf(candidate) <= keyColumn) break
        if (NODE_START.test(candidate)) break
        end += 1
        segments.push({ line: end, column: 0, text: cutYamlComment(candidate) })
      }
      if (segments.length > 0) {
        runValues += 1
        shapes.plain += 1
        scanRunValue(segments, relative)
      }
      index = end
      continue
    }

    runValues += 1
    shapes.inline += 1
    const scalar = readBlockScalar(lines, index, valueColumn, keyColumn)
    scanRunValue(scalar.segments, relative)
    index = scalar.endLine
  }
}

if (failures.length > 0) {
  console.error('workflow-shell failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    `workflow-shell: ${reachable} of ${carried} backtick-bearing line(s) in ${runValues} run value(s) ` +
      `are reachable by bash command substitution. ${SCOPE}`,
  )
  process.exit(1)
}

console.log(
  `workflow-shell: ${runValues} run value(s) recognised ` +
    `(${shapes.block} block scalar, ${shapes.plain} plain scalar continued on following lines, ` +
    `${shapes.inline} single-line, ${shapes.flow} flow); ` +
    `${carried} backtick-bearing line(s) in them, ${exempt} exempt and ${reachable} reachable by ` +
    `bash command substitution. ${SCOPE}`,
)
