/**
 * MCP server definition.
 *
 * Three tools, deliberately few and orthogonal — the same surface the DSH
 * plugin exposes, because both are thin layers over one core. Two add-ons that
 * already ship ten tools each are a better answer for "give me every judgment
 * shape"; this server exists for the case where a host wants the three
 * primitives and nothing else.
 *
 * Tool descriptions carry the same obligation as the DSH ones: say when *not* to
 * use the tool. A decision model asked to write prose produces nothing useful,
 * and a caller that does not know that will keep trying.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { JevService } from 'jevcore'
import { runAsk, runCheck, runRank, type QuestionInput } from './tools.js'

/**
 * The version reported to clients, read from this package's own manifest.
 *
 * It used to be the literal string '0.1.0' while the package moved on to 0.2.2,
 * so every client that logged the server version logged one that had never been
 * published. A version that is not read from the manifest is a version that
 * drifts, and this one had already drifted twice.
 *
 * `lib/server.js` and `src/server.ts` both sit exactly one directory below the
 * package root, so the same relative path resolves in a checkout and in an
 * installed tarball. `package.json` is not in `files[]` — it is not supposed to
 * be — but npm always ships it regardless of that list, so it is present in both.
 *
 * The read is lazy and cached: a package that cannot find its own manifest has a
 * broken install, but it should still answer `tools/list` and report the failure
 * on the call to `initialize` rather than failing at import time.
 */
let cachedVersion: string | undefined

/** The version this server reports, read from the package manifest once. */
export const packageVersion = (): string => {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    const version =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as { version?: unknown }).version
        : undefined
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error('the manifest has no "version" field')
    }
    cachedVersion = version
    return version
  } catch (error) {
    throw new Error(
      `[jevcore-mcp] cannot read its own version from package.json: ` +
        `${error instanceof Error ? error.message : String(error)}. Reporting a version that was ` +
        `never published is worse than refusing to handshake.`,
    )
  }
}

/**
 * A one-entry description: a string, or a structured value whose keys name what
 * each part is for. Mirrors the core's `EntryType` and the DSH plugin's schema,
 * so both entry points accept the same questions.
 */
const entryType = z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])

/** One of the two outcomes a noul's boundary may describe. */
const noulCriteria = z.object({
  true: entryType.optional().describe('What "true" means for this question.'),
  false: entryType.optional().describe('What "false" means for this question.'),
})

/** Wire schema for one typed question. */
const questionSchema = z.object({
  type: z.enum(['noul', 'choice', 'score']).describe('noul = yes/no, choice = pick one, score = place on a scale'),
  instructions: entryType.describe(
    'The question, phrased so a yes/no or a single selection answers it. A string, or an ' +
      'object/array of named fields when definitions, contrasts or examples clarify the question.',
  ),
  criteria: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe(
      'Required for choice and score. For choice: each permitted answer key mapped to an optional ' +
        'description. For score: each scale level mapped to its description, written in ascending ' +
        'order with at least two levels, because the order written is the scale. A level described ' +
        'as null sends no description. For a noul it is the legacy spelling of `boundary` and is ' +
        'read as one.',
    ),
  boundary: noulCriteria
    .optional()
    .describe(
      'noul only: what "true" and what "false" mean. Declare one whenever the line between yes ' +
        'and no is not self-evident — including what silence in the evidence does NOT count as — ' +
        'because a noul whose boundary is unstated is one whose 0.5 cannot be interpreted. A ' +
        'boundary on a choice or a score is refused rather than ignored.',
    ),
})

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

const failure = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: error instanceof Error ? error.message : String(error),
    },
  ],
})

/**
 * Build the server.
 *
 * @param service - the decision layer every tool call goes through.
 * @param version - implementation version to report. Defaults to the version in
 *   this package's manifest, which is what a client should see; the parameter
 *   exists so a test can prove the default is the manifest and not a literal.
 */
export const createServer = (service: JevService, version: string = packageVersion()): McpServer => {
  const server = new McpServer({ name: 'jevcore', version })

  server.registerTool(
    'jev_ask',
    {
      title: 'Ask Jev typed questions',
      description:
        'Ask TypeSafe Jev one or more typed questions about a single piece of state. Jev does not ' +
        'generate text: it returns a selected option and calibrated probabilities. Use it for ' +
        'judgments the rest of the work branches on — routing, classifying, scoring, triaging. ' +
        'Do NOT use it to write prose, explain, summarize, or generate code.\n\n' +
        'Question types: "noul" is yes/no and returns the probability of true; "choice" picks one ' +
        'of the criteria keys you declare; "score" places the state on an ordered scale whose ' +
        'levels you declare in ascending order. A noul may also declare "boundary" — what true ' +
        'means and what false means — which is worth supplying whenever the line between them is ' +
        'not obvious.\n\n' +
        'Batch related questions into one call: they are answered against the same state in one ' +
        'round-trip. A score question answers with a numeric "score" that may fall between ' +
        'levels, a "legend" mapping each level index to its description, and probabilities per ' +
        'level. This tool returns probabilities, not decisions — apply your own confidence ' +
        'threshold before acting, and treat a low-confidence answer as unknown rather than ' +
        'picking for it.',
      inputSchema: {
        state: z
          .unknown()
          .describe('The evidence to judge. This is transmitted to TypeSafe when a live key is configured.'),
        questions: z
          .record(z.string(), questionSchema)
          .describe('Map of question id to question. Ids are the keys of the response.'),
      },
    },
    async (args) => {
      try {
        return json(await runAsk(service, args as { state: never; questions: Record<string, QuestionInput> }))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'jev_rank',
    {
      title: 'Rank candidates with Jev',
      description:
        'Rank a list of candidates by how well each satisfies one stated criterion. Returns every ' +
        'candidate with an independent relevance probability, sorted. Use it to order search ' +
        'hits, triage a backlog, or find the one item that answers a question.\n\n' +
        'The probabilities are independent per-candidate judgments, NOT a distribution that sums ' +
        'to 1. A flat set of scores means "none of these stands out", not a fine-grained ordering.',
      inputSchema: {
        query: z.string().describe('The task or question the candidates are ranked against.'),
        candidates: z.array(z.string()).describe('One string per candidate.'),
        criterion: z
          .string()
          .optional()
          .describe('What "relevant" means, as a yes/no question about one candidate.'),
      },
    },
    async (args) => {
      try {
        return json(await runRank(service, args))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'jev_check',
    {
      title: 'Check a claim against evidence',
      description:
        'Check whether a piece of evidence supports a specific claim. Returns "supported", ' +
        '"contradicted", "conflicted", "insufficient", or "unknown", with the underlying ' +
        'probabilities. The distinction between "not supported" and "contradicted" is the reason ' +
        'to use this rather than reading the evidence yourself.\n\n' +
        'It judges one claim against the evidence you give it. It does not search for evidence, ' +
        'and it cannot detect that you omitted the decisive passage.',
      inputSchema: {
        claim: z.string().describe('The single claim to check.'),
        evidence: z.string().describe('The evidence to judge it against. Quote rather than paraphrase.'),
      },
    },
    async (args) => {
      try {
        return json(await runCheck(service, args))
      } catch (error) {
        return failure(error)
      }
    },
  )

  return server
}
