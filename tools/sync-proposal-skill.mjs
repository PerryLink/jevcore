/**
 * Check or refresh the skill draft embedded in the submission proposal.
 *
 * The proposal is an issue body for `typesafe-ai/skills` containing a verbatim
 * copy of the bundled SKILL.md. That copy cannot be guarded by a test — the
 * proposal lives outside the package tree — so it is checked by hand here. It
 * *did* go stale once, which is why this exists.
 *
 * Usage:
 *   node tools/sync-proposal-skill.mjs           # write the current skill into the proposal
 *   node tools/sync-proposal-skill.mjs --check   # report drift, exit 1 if stale
 *
 * The workspace root is the parent of this file's directory, so `dsh-jev/tools/`
 * can be copied beside the drafts on another machine.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = join(ROOT, '..')
const PROPOSAL = join(WORKSPACE, 'typesafe-dsh-skill-proposal.md')
const SKILL = join(ROOT, 'packages', 'dsh', 'skills', 'typesafe-ai-dsh', 'SKILL.md')

const checkOnly = process.argv.includes('--check')
const MARKER = '```markdown\n---\nname: typesafe-ai-dsh'

let proposalBytes
try {
  proposalBytes = readFileSync(PROPOSAL)
} catch {
  console.error(`FAIL: the proposal is not at ${PROPOSAL}`)
  process.exit(1)
}

// Normalize line endings for every comparison, then restore the file's own
// convention on write: the proposal is checked out with CRLF on Windows, and a
// search for '\n```' would otherwise never match.
const text = proposalBytes.toString('utf8').replace(/\r\n/g, '\n')
const start = text.indexOf(MARKER)
if (start === -1) {
  console.error('FAIL: no fenced skill draft found in the proposal')
  process.exit(1)
}
const bodyStart = text.indexOf('\n', start) + 1
const end = text.lastIndexOf('```')

const hasBom = proposalBytes[0] === 0xef && proposalBytes[1] === 0xbb && proposalBytes[2] === 0xbf
const eol = proposalBytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'

const shipped = readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n').trimEnd()
const embedded = text.slice(bodyStart, end).trimEnd()

if (embedded === shipped) {
  console.log(`proposal draft is current (${shipped.length} bytes)`)
  process.exit(0)
}

const a = embedded.split('\n')
const b = shipped.split('\n')
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) {
    console.log(`first difference at line ${i + 1}:`)
    console.log(`  proposal: ${JSON.stringify(a[i] ?? null)}`)
    console.log(`  SKILL.md: ${JSON.stringify(b[i] ?? null)}`)
    break
  }
}

if (checkOnly) {
  console.error('FAIL: the proposal draft is stale. Run: node tools/sync-proposal-skill.mjs')
  process.exit(1)
}

// Rebuild with one consistent line ending, then restore any BOM. `text` is
// already LF-normalized, so this cannot leave mixed endings behind.
const rebuilt = (text.slice(0, bodyStart) + shipped + text.slice(end)).replace(/\n/g, eol)
writeFileSync(PROPOSAL, hasBom ? '\ufeff' + rebuilt : rebuilt, 'utf8')
console.log(`updated the proposal draft to ${shipped.length} bytes (eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`)
