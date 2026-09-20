import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SKILL_NAME, loadSkill, parseSkill, skillRegistration } from '../src/skill.js'

/** The skill file as it lives in the repository, not as a build output. */
const repoSkillPath = fileURLToPath(new URL('../skills/typesafe-ai-dsh/SKILL.md', import.meta.url))

describe('parsing', () => {
  it('splits front matter from the body', () => {
    const parsed = parseSkill('---\nname: x\ndescription: y\n---\n\n# Heading\n')
    expect(parsed.frontMatter).toEqual({ name: 'x', description: 'y' })
    expect(parsed.content.trimStart().startsWith('# Heading')).toBe(true)
  })

  it('tolerates CRLF line endings', () => {
    const parsed = parseSkill('---\r\nname: x\r\ndescription: y\r\n---\r\nbody')
    expect(parsed.frontMatter.name).toBe('x')
    expect(parsed.content).toBe('body')
  })

  it('ignores comment lines inside front matter', () => {
    const parsed = parseSkill('---\n# a comment\nname: x\ndescription: y\n---\nbody')
    expect(parsed.frontMatter).toEqual({ name: 'x', description: 'y' })
  })

  it('throws when there is no front matter rather than guessing', () => {
    expect(() => parseSkill('# just a heading')).toThrow(/no front matter/)
  })

  it('throws when the name is missing, because the skill could not be addressed', () => {
    expect(() => parseSkill('---\ndescription: y\n---\nbody')).toThrow(/no "name"/)
  })

  it('throws when the description is missing, because the model could not route to it', () => {
    expect(() => parseSkill('---\nname: x\n---\nbody')).toThrow(/no "description"/)
  })
})

describe('the bundled skill', () => {
  it('loads from the package layout', () => {
    const registration = skillRegistration()
    expect(registration.name).toBe(SKILL_NAME)
    expect(registration.description.length).toBeGreaterThan(40)
    expect(registration.content.length).toBeGreaterThan(500)
  })

  it('names itself with the registry key', () => {
    expect(loadSkill().frontMatter.name).toBe(SKILL_NAME)
  })

  it('teaches the shape of a judgment, not the API surface', () => {
    const body = loadSkill().content
    // The two failure modes the ecosystem actually exhibits.
    expect(body).toMatch(/probability is not a permission/i)
    expect(body).toMatch(/every tool call/i)
    // And an explicit statement of what Jev is not for.
    expect(body).toMatch(/do \*\*not\*\* use it to summarize/i)
  })

  it('mentions every tool the plugin actually registers', () => {
    const body = loadSkill().content
    for (const tool of ['jev_ask', 'jev_rank', 'jev_check']) {
      expect(body).toContain(tool)
    }
  })

  it('warns that mock answers carry no judgment', () => {
    expect(loadSkill().content).toMatch(/synthetic/i)
  })

  it('reads the same file a human edits', () => {
    // Guards the packaging decision: the body is read from the markdown rather
    // than embedded, so a reader editing SKILL.md must see their edit take
    // effect. If this fails, the two have diverged.
    const onDisk = readFileSync(repoSkillPath, 'utf8')
    expect(skillRegistration().content).toBe(parseSkill(onDisk).content)
  })

  it('declares a description long enough to route on', () => {
    const parsed = parseSkill(readFileSync(repoSkillPath, 'utf8'))
    expect(parsed.frontMatter.description.length).toBeGreaterThan(80)
  })
})

/**
 * The contract the registry on the other side of `ctx.skills.register()` applies.
 *
 * The sources these assertions come from, so a reader can re-check them instead of
 * trusting a comment: DeepSeek Harness `packages/skill/skill/src/index.ts` (the
 * registration contract, the name pattern, and `validateRuntimeSkill`, which
 * checks name, description and invocation only) and
 * `packages/skill/tool-skill/README.md` with its `tests/tool-skill.spec.ts` (the
 * model-facing catalog renders name and a capped description, and never
 * `whenToUse`).
 */
describe('the registration the registry receives', () => {
  it('pins the key set, because the registry silently ignores fields it does not know', () => {
    // A misspelled field is registered and does nothing: unknown keys are not
    // rejected. Pinning the keys is what makes adding or dropping one deliberate.
    expect(Object.keys(skillRegistration()).sort()).toEqual([
      'content',
      'description',
      'name',
      'whenToUse',
    ])
  })

  it('names the skill in the form the registry matches and the model routes by', () => {
    // The registry's own pattern: a name that does not match it is rejected at
    // registration time, and the catalog addresses the skill by this name.
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(skillRegistration().name).toBe(SKILL_NAME)
  })

  it('carries `whenToUse` as provider metadata, which the model never sees', () => {
    // Kept on purpose, and this test exists so that dropping it is a decision
    // rather than a tidy-up: DSH forwards it into the client-facing skill catalog,
    // so it is part of a protocol payload even though no model-facing renderer
    // reads it and no shipped client component displays it yet. See the note on
    // `skillRegistration`.
    const { whenToUse, description } = skillRegistration()
    expect(typeof whenToUse).toBe('string')
    expect(whenToUse.length).toBeGreaterThan(0)
    // And it is not folded into the one field the model does read: the catalog
    // description is capped and is rendered in every session, so a routing hint
    // duplicated there would be paid for on every step.
    expect(description).not.toContain(String(whenToUse))
  })
})
