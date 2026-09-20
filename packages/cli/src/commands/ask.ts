/**
 * `jev ask` — one batch of typed questions against a state.
 *
 * The command is thin on purpose. It reads two documents, converts the question
 * definitions into the core's vocabulary, and hands the result to
 * `JevService.ask`. That is the whole of it, and it has to be: `ask` is where the
 * egress contract is exercised, so any logic that lived here instead of in the
 * service would be logic the contract does not bound.
 *
 * `--feature` defaults to this command's own feature rather than being required,
 * which is the one place this surface is more forgiving than `JevService.ask`
 * itself — the service takes `feature` as a required input because it selects
 * which egress switch and which declared field caps apply. A named feature that
 * is not declared is still refused, by the contract that owns the list.
 */

import { renderResult } from 'jevcore'
import { hasFlag, optionalString, requireString } from './../args.js'
import { FEATURE } from './../constants.js'
import { egressLines, resultLines, syntheticLine, toJson } from './../format.js'
import { asObject, readJson } from './../input.js'
import { toQuestions } from './../questions.js'
import { buildContext, asFeature, provenanceLine, type ServiceContext } from './../runtime.js'
import { EXIT, type CommandContext } from './../types.js'

/** Run `ask`. */
export const runAsk = async ({ args, io }: CommandContext): Promise<number> => {
  const stateRef = requireString(args, 'state', 'the JSON state to judge')
  const questionsRef = requireString(args, 'questions', 'the JSON object of question definitions')
  const feature = optionalString(args, 'feature') ?? FEATURE.ask

  const state = await readJson(stateRef, '--state', io)
  const document = asObject(await readJson(questionsRef, '--questions', io), '--questions')
  const questions = toQuestions(document)

  // `buildContext` builds the contract first, so an undeclared feature is refused
  // here — before a provider is resolved, and before anything could be sent.
  const context: ServiceContext = await buildContext(args, io, [feature])
  io.err(provenanceLine(context.route))
  for (const line of context.egress.reportLines()) io.err(line)

  const result = await context.service.ask({
    feature: asFeature(feature),
    state,
    questions,
  })
  const rendered = renderResult(result, Object.keys(questions))

  for (const line of egressLines(result.egress)) io.err(line)

  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'ask',
        provider: rendered.provider,
        model: rendered.model,
        latencyMs: rendered.latencyMs,
        data: {
          answers: rendered.answers,
          feature,
          ...(rendered.usage === undefined ? {} : { usage: rendered.usage }),
          ...(rendered.warning === undefined ? {} : { warning: rendered.warning }),
          ...(rendered.truncated === undefined ? {} : { truncated: rendered.truncated }),
          ...(rendered.egress === undefined ? {} : { egress: rendered.egress }),
        },
      }),
    )
    return EXIT.OK
  }

  for (const line of resultLines(`ask ${feature}`, rendered)) io.out(line)
  if (rendered.warning !== undefined) io.err(syntheticLine(rendered))
  return EXIT.OK
}
