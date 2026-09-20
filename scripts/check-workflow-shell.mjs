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
 * So: what a gate does not name, it does not protect.
 *
 * A line whose first non-space character is `#` is a SHELL comment, and bash
 * does not expand those. Those are allowed, and there are several -- the notes in
 * `release.yml` and `ci.yml` are load-bearing documentation. Everything else
 * inside a `run:` block is live shell.
 *
 * Deliberately a plain text scan rather than a YAML parse: this repository has no
 * YAML dependency, and adding one to check five files would make the release path
 * depend on a parser to enforce a rule about characters.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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

const failures = []
const note = (message) => failures.push(message)

let blocks = 0
let checked = 0

for (const file of targets()) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const lines = readFileSync(file, 'utf8').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    // A block scalar header: `run: |`, `run: |-`, `run: >`, optionally with an
    // indentation indicator such as `|2`, and optionally with a trailing comment.
    // The block is the run of following lines indented deeper than the key; the
    // first non-blank line at or below the key's indentation ends it.
    //
    // The trailing comment is allowed for a reason worth stating: a header the
    // regex refuses is not reported as an error, it is silently reclassified as a
    // one-line `run:` and its body is then never scanned. A guard that fails open
    // on unusual formatting is the failure mode this file exists to catch.
    const header = /^(\s*)(?:-\s+)?run:\s*[|>][-+]?\d*\s*(?:#.*)?$/u.exec(line)
    if (header === null) {
      // A one-line `run:` is live shell on its own line. The negative lookahead
      // keeps a block indicator out of this branch, so the two cases stay disjoint.
      if (/^(\s*)(?:-\s+)?run:\s+(?![|>])/u.test(line)) {
        checked += 1
        const body = line.replace(/^(\s*)(?:-\s+)?run:\s+/u, '')
        if (body.includes('`')) note(`${relative}:${index + 1} single-line run with a backtick: ${line.trim()}`)
      }
      continue
    }

    blocks += 1
    const keyIndent = indentOf(line)
    let end = index + 1
    while (end < lines.length) {
      const candidate = lines[end]
      if (candidate.trim().length === 0) {
        end += 1
        continue
      }
      if (indentOf(candidate) <= keyIndent) break
      end += 1
    }

    for (let body = index + 1; body < end; body += 1) {
      const candidate = lines[body]
      if (!candidate.includes('`')) continue
      checked += 1
      // A shell comment is not expanded by bash. JavaScript comments are NOT
      // shell comments, which is the distinction the original defect turned on.
      if (candidate.trimStart().startsWith('#')) continue
      note(
        `${relative}:${body + 1} a backtick on a line bash will expand: ${candidate.trim()}\n` +
          '    bash performs command substitution on backticks before the program sees the text, ' +
          'so this runs as a command. Use a shell comment, or drop the backticks.',
      )
    }

    index = end - 1
  }
}

if (failures.length > 0) {
  console.error('workflow-shell failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `workflow-shell: ${blocks} run blocks and ${checked} backtick-bearing line(s) checked, ` +
    'none reachable by bash command substitution',
)
