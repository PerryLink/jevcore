/**
 * `jev check` — verify a claim against evidence.
 *
 * The judgment itself is the core's: `resolveCheck` turns three noul answers into
 * one verdict, and this command only asks the three questions, prints the
 * resolution, and maps it to an exit code. Nothing about the precedence order
 * lives here, deliberately — it is the part of this feature most likely to be
 * "simplified" by someone reading only the CLI, and the core's own comment is
 * where the reasoning is.
 *
 * **Why three exit codes and not two.** `supported` and `contradicted` are
 * findings about the claim. The other four are findings about the *evidence*:
 * it argues with itself (`conflicted`), it does not settle the question
 * (`insufficient`), it settles the question without pointing anywhere
 * (`undecided`), or no measurement came back at all (`unknown`). A script that
 * read those four as "not supported" would be reporting a refutation nobody
 * measured — and in CI that is the difference between "this claim is wrong" and
 * "this repository cannot tell", which are different tickets.
 */

import { VERDICT_QUESTION, noul, resolveCheck, type CheckResolution } from 'jevcore'
import { hasFlag, requireString } from './../args.js'
import { CHECK_THRESHOLDS, FEATURE } from './../constants.js'
import { egressLines, formatProbability, toJson } from './../format.js'
import { readText } from './../input.js'
import { buildContext, provenanceLine } from './../runtime.js'
import { EXIT, type CommandContext } from './../types.js'

/**
 * The verdict is news, so it goes last.
 *
 * stdout is written in the order a person reads: what was checked, then the
 * judgment. A reader who pipes this into a log gets the claim on the line above
 * the verdict, which is what makes an archived log readable a week later.
 */
const SUPPORT_LINE = 'claim:'
const EVIDENCE_LINE = 'evidence:'

/**
 * The one-line reading of a resolution, with the probabilities that produced it.
 *
 * Every probability is printed, including the ones that are absent. `resolveCheck`
 * reports `undefined` for an unanswered question, and the CLI renders that as
 * `?` rather than dropping the field: "the sufficiency question was never
 * answered" is a finding, and it is the finding that makes an `insufficient`
 * verdict fail closed.
 */
export const verdictLine = (resolution: CheckResolution): string =>
  `verdict: ${resolution.verdict}  ` +
  `(supports=${formatProbability(resolution.supports)} ` +
  `contradicts=${formatProbability(resolution.contradicts)} ` +
  `sufficient=${formatProbability(resolution.sufficient)})`

/**
 * The exit code a verdict carries.
 *
 * Exported because it is half of this command's interface: the GitHub Action
 * written against this surface branches on it, so it is worth a test of its own
 * rather than being observable only through a whole command run.
 */
export const exitForVerdict = (verdict: CheckResolution['verdict']): number => {
  if (verdict === 'supported') return EXIT.OK
  if (verdict === 'contradicted') return EXIT.FAIL
  return EXIT.NO_VERDICT
}

/** Run `check`. */
export const runCheck = async ({ args, io }: CommandContext): Promise<number> => {
  const claim = requireString(args, 'claim', 'the claim being checked')
  const evidenceRef = requireString(args, 'evidence', 'the evidence to check it against')
  const evidence = await readText(evidenceRef, '--evidence', io)

  const questions = {
    [VERDICT_QUESTION.supports]: noul('Does this evidence support the claim?'),
    [VERDICT_QUESTION.contradicts]: noul('Does this evidence contradict the claim?'),
    [VERDICT_QUESTION.sufficient]: noul(
      'Is this evidence sufficient to settle whether the claim is true?',
    ),
  }

  const context = await buildContext(args, io, [FEATURE.check])
  io.err(provenanceLine(context.route))

  const result = await context.service.ask({
    feature: FEATURE.check,
    state: { claim, evidence },
    questions,
  })
  for (const line of egressLines(result.egress)) io.err(line)

  const resolution = resolveCheck(result, CHECK_THRESHOLDS)

  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'check',
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        data: {
          verdict: resolution.verdict,
          probabilities: {
            ...(resolution.supports === undefined ? {} : { supports: resolution.supports }),
            ...(resolution.contradicts === undefined ? {} : { contradicts: resolution.contradicts }),
            ...(resolution.sufficient === undefined ? {} : { sufficient: resolution.sufficient }),
          },
          thresholds: CHECK_THRESHOLDS,
          exitCode: exitForVerdict(resolution.verdict),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.egress === undefined ? {} : { egress: result.egress }),
        },
      }),
    )
    return exitForVerdict(resolution.verdict)
  }

  io.out(`${SUPPORT_LINE} ${claim}`)
  io.out(`${EVIDENCE_LINE} ${summarizeEvidence(evidence)}`)
  io.out(verdictLine(resolution))
  if (result.provider === 'mock') {
    io.err(
      'provider=mock: this verdict is SYNTHETIC and carries no judgment. ' +
        'Use --provider live with a credential for a real one.',
    )
  }
  return exitForVerdict(resolution.verdict)
}

/**
 * Evidence as one line: the length, and its first line as a quotation.
 *
 * Not the whole document: evidence is routinely a file, and echoing it back into
 * a terminal that already had it on the command line is noise. The length is
 * reported because it is the one fact about the evidence a reader cannot recover
 * from the excerpt, and a 40-character evidence file and a 40_000-character one
 * should not look the same in a log.
 */
const summarizeEvidence = (evidence: string): string => {
  const firstLine = evidence.split('\n', 1)[0]?.trim() ?? ''
  const quoted = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
  return `${evidence.length} chars — "${quoted}"`
}
