/**
 * `jev egress` — what this tool may send, and the cap on each field.
 *
 * The contract can describe itself (`EgressContract.reportLines`), and this
 * command exists to put that description in front of a person who is not running
 * a DeepSeek Harness session. The whole claim of this project is that an operator
 * can read one screen and know whether anything leaves their machine; that claim
 * was, until this command, only checkable from inside a Host process.
 *
 * Two deliberate properties:
 *
 *  - **The report is computed for this invocation.** The features named by
 *    `--feature` are the ones armed, the endpoint is the one this invocation
 *    would post to, and `transmitting` is a fact about the selected provider. A
 *    report describing a hypothetical configuration would be a document, not a
 *    disclosure.
 *  - **No credential is resolved.** Arming a feature does not require a key: the
 *    report is about what *would* be sent, and a command that insisted on a key in
 *    order to describe a transmission it will not make would be unusable on
 *    exactly the machine where the question matters most. The route is still
 *    described honestly — a `live` route with no key reports `live`, and every
 *    command that actually answers reports the missing key as an error.
 */

import { EGRESS_FIELDS, EGRESS_FEATURES, type EgressFeature } from 'jevcore'
import { hasFlag, stringList } from './../args.js'
import { toJson } from './../format.js'
import { armedFeatures, egressFor, resolveRoute } from './../runtime.js'
import { EXIT, type CommandContext } from './../types.js'
import { PROGRAM } from './../usage.js'

/** One feature's declared payload, as this command reports it. */
interface FeatureReport {
  readonly feature: EgressFeature
  readonly armed: boolean
  readonly fields: readonly {
    readonly field: string
    readonly maxChars: number
    readonly carries: string
  }[]
}

/** Run `egress`. */
export const runEgress = async ({ args, io }: CommandContext): Promise<number> => {
  const requested = stringList(args, 'feature')
  // `resolveRoute`, not `buildRoute`: describing a route must not require a
  // credential. See the note on `RoutePlan`.
  const route = resolveRoute(args, io)
  const egress = egressFor(route, requested)
  const armed = armedFeatures(egress)

  const reports: readonly FeatureReport[] = EGRESS_FEATURES.map((feature) => ({
    feature,
    armed: armed[feature],
    // Read through the contract rather than from `EGRESS_FIELDS`, so an
    // operator-side cap override would be reflected here the moment one exists:
    // reading the raw declaration would print the shipped cap and quietly
    // disagree with what the contract enforces.
    fields: egress.fieldsOf(feature),
  }))

  if (hasFlag(args, 'json')) {
    io.out(
      toJson({
        ok: true,
        command: 'egress',
        provider: route.kind,
        model: route.model,
        latencyMs: 0,
        data: {
          endpoint: route.endpoint ?? null,
          transmitting: route.transmitting,
          features: reports,
          declared: EGRESS_FEATURES,
          declaredFields: EGRESS_FIELDS,
          report: egress.reportLines(),
        },
      }),
    )
    return EXIT.OK
  }

  io.out(`${PROGRAM} egress - what this tool may send`)
  io.out(
    `provider: ${route.kind}  endpoint: ${route.endpoint ?? 'none'}  ` +
      `transmitting: ${route.transmitting ? 'YES' : 'no'}`,
  )
  io.out('')
  for (const line of egress.reportLines()) io.out(line)
  io.out('')
  for (const report of reports) {
    io.out(`${report.armed ? 'ARMED' : 'off  '}  ${report.feature}`)
    for (const field of report.fields) {
      io.out(`         ${field.field} <= ${field.maxChars} chars - ${field.carries}`)
    }
  }
  io.out('')
  io.out(
    'Redaction runs over everything that leaves, but it is best-effort: it removes values under ' +
      'recognised field names and strings matching known secret shapes, and it cannot recognise ' +
      'an unrecognised secret written into free text.',
  )
  if (!route.transmitting) {
    io.out(
      'This report describes a mock run: the features above are armed, and with the offline ' +
        'provider nothing is transmitted at all.',
    )
  }
  return EXIT.OK
}
