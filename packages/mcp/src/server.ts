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
import { z } from 'zod'
import type { JevService } from 'jevcore'
import { runAsk, runCheck, runRank, type QuestionInput } from './tools.js'

/** Wire schema for one typed question. */
const questionSchema = z.object({
  type: z.enum(['noul', 'choice', 'score']).describe('noul = yes/no, choice = pick one, score = place on a scale'),
  instructions: z.string().describe('The question, phrased so a yes/no or a single selection answers it.'),
  criteria: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe(
      'Required for choice and score. For choice: each permitted answer key mapped to an optional ' +
        'description. For score: each scale level mapped to its description, written in ascending ' +
        'order with at least two levels, because the order written is the scale. A level described ' +
        'as null sends no description.',
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

export const createServer = (service: JevService): McpServer => {
  const server = new McpServer({ name: 'jevcore', version: '0.1.0' })

  server.registerTool(
    'jev_ask',
    {
      title: 'Ask Jev typed questions',
      description:
        'Ask TypeSafe Jev one or more typed questions about a single piece of state. Jev does not ' +
        'generate text: it returns a selected option and calibrated probabilities. Use it for ' +
        'judgments the rest of the work branches on — routing, classifying, scoring, triaging. ' +
        'Do NOT use it to write prose, explain, summarize, or generate code.\n\n' +
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
