/**
 * The bundled skill.
 *
 * DSH finds skills through a registry, and a plugin can contribute one directly
 * with `ctx.skills.register()` — no filesystem provider, no directory scanning.
 *
 * The body is **read from `skills/typesafe-ai-dsh/SKILL.md`** rather than
 * embedded here. One source of truth: the file is what a human edits, what the
 * upstream proposal copies, and what ships. The cost is a file read; the
 * benefit is that the markdown cannot silently drift from a TypeScript copy.
 *
 * The read is relative to this module, so it works from `lib/` in the published
 * tarball. `skills/` is in the package's `files` list for that reason.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the skill markdown lives, relative to the built module. */
const SKILL_RELATIVE_PATH = join('..', 'skills', 'typesafe-ai-dsh', 'SKILL.md')

/** The registry key this skill is addressed by. */
export const SKILL_NAME = 'typesafe-ai-dsh'

/**
 * Front matter fields this module understands.
 *
 * A deliberately tiny parser: the file is authored by hand and has exactly two
 * scalar fields. A YAML dependency for that would be disproportionate.
 */
export interface SkillFrontMatter {
  readonly name: string
  readonly description: string
}

export interface ParsedSkill {
  readonly frontMatter: SkillFrontMatter
  /** The markdown body, with front matter removed. */
  readonly content: string
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Split a skill document into front matter and body.
 *
 * Throws on a shape it cannot read rather than guessing: a skill that loads
 * with a missing description is a skill the model cannot route to, and a silent
 * default would hide that.
 */
export const parseSkill = (document: string): ParsedSkill => {
  const match = FRONT_MATTER.exec(document)
  if (match?.[1] === undefined) {
    throw new Error(`${SKILL_NAME}: SKILL.md has no front matter block`)
  }
  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0 && value.length > 0) fields.set(key, value)
  }

  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined) throw new Error(`${SKILL_NAME}: SKILL.md front matter has no "name"`)
  if (description === undefined) {
    throw new Error(`${SKILL_NAME}: SKILL.md front matter has no "description"`)
  }

  return {
    frontMatter: { name, description },
    content: document.slice(match[0].length),
  }
}

/**
 * Read and parse the bundled skill.
 *
 * The path is configurable so a test can point at the file in the repository
 * rather than at a build output, which is how the packaging is verified.
 */
export const loadSkill = (moduleUrl: string = import.meta.url): ParsedSkill => {
  const here = dirname(fileURLToPath(moduleUrl))
  const document = readFileSync(join(here, SKILL_RELATIVE_PATH), 'utf8')
  return parseSkill(document)
}

/** The registry fields for the bundled skill, plus its body. */
export const skillRegistration = (moduleUrl?: string) => {
  const skill = loadSkill(moduleUrl)
  return {
    name: skill.frontMatter.name,
    description: skill.frontMatter.description,
    whenToUse:
      'A decision turns on a small, fixed set of outcomes, or you need a calibrated probability ' +
      'rather than prose.',
    content: skill.content,
  }
}
