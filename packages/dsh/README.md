# dsh-jev

TypeSafe [Jev](https://typesafe.ai) as a first-class Cordis service and three model-visible tools for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`, `score` — and returns
calibrated probabilities. It does not write prose, and asking it to is a category error. This plugin
gives an agent exactly that surface, and nothing more.

**Offline by default. Egress disclosed. Nothing default-on.**

---

## Why this exists

Between 2026-09-17 and 09-20, nineteen plugins appeared that wire Jev into DSH. Auditing their source
found a consistent pattern: the module labelled *guard*, *gate*, or *warden* was also the module
shipping prompts, tool arguments, and file contents to a third party, and the README generally did not
say so. Several were enabled by default. One gate could be reconfigured by the model it was guarding.

This plugin is the same idea with those failure modes designed out:

| Property | How it is guaranteed here |
|---|---|
| No network call unless you ask for one | Default provider is an offline mock; the live path needs both `provider: live` and a resolved credential |
| Every transmission named before it happens | One startup log line per feature: `off` or `SENDS <feature> { fields }` |
| Gates register nothing when disabled | Verified by test, not by policy — a disabled gate adds no event listener at all |
| The model cannot widen its own constraints | No tool exposes gate configuration |
| A judge that cannot answer never means "allow" | Undecided resolves through explicit config, defaulting to `ask` |

---

## The egress contract

This is the part worth reading before installing.

Transmission is decided per feature, and every feature defaults to off. The plugin prints its own
contract at load:

```
[dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[dsh-jev] ready - provider=mock - gates: safety=off context=off
```

With `provider: live` and every feature enabled, the same report becomes explicit about what leaves:

```
[dsh-jev] provider=live  endpoint=https://api.typesafe.ai  egress=ON
[dsh-jev]   SENDS  tool:jev_ask  { state<=16000c questions<=4000c }
[dsh-jev]   SENDS  tool:jev_rank  { state<=16000c questions<=4000c }
[dsh-jev]   SENDS  tool:jev_check  { state<=16000c questions<=4000c }
[dsh-jev]   SENDS  gate:safety  { state<=8000c questions<=2000c }
[dsh-jev]   SENDS  gate:context  { state<=6000c questions<=2000c }
[dsh-jev]   redaction is best-effort; it removes named fields and known secret shapes, and cannot
             recognise an unrecognised secret in free text
```

| Feature | Off by default? | What it sends |
|---|---|---|
| `tool:jev_ask` | runs when the model calls it | the arguments the model passed, after redaction |
| `tool:jev_rank` | runs when the model calls it | the query plus every candidate |
| `tool:jev_check` | runs when the model calls it | the claim and its evidence |
| `gate:safety` | **yes — explicit opt-in** | the tool name, its arguments, the workspace root |
| `gate:context` | **yes — explicit opt-in** | a large tool result the agent just received |

The tools transmit only when the model chooses to call them, which is visible in the transcript. The
gates would run on every matching tool call, which is not, so they are opt-in.

### Redaction, and its honest limit

Before anything is sent, `src/redact.ts` runs two passes: values under sensitive field names
(`password`, `token`, `apiKey`, `authorization`, …) are replaced wholesale, and secret-shaped strings
that survive into free text are pattern-matched (`Bearer …`, `sk-…`, `ts_live_…`, AWS/GitHub/Google
key shapes, JWTs, private-key headers, credentials in connection strings).

This is a mitigation, not a permission. A secret that sits under an unrecognised key name *and* does
not match a known shape will pass through. If that possibility is unacceptable for your workload, do
not enable the live provider.

---

## Install

```sh
dsh plugin --profile <profile> add dsh-jev
```

Or from a checkout:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-jev
```

Then confirm the row activated (`plugin_manager` / the plugin list should show `jev` as `active`, not
`failed`) and check the startup report in the log.

### Going live

```yml
- insert:
    - id: jev
      name: 'dsh-jev'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

The credential is resolved through DSH's credential service first, then the environment variable of
that name. It is read per call, so a key added while the process is running is picked up. It is never
logged, never returned from a tool, and never written to configuration.

`@typesafe-ai/sdk` is an optional dependency; the plugin loads and runs offline without it.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `mock` | `mock` (offline, deterministic, synthetic) or `live` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | Credential reference resolved via `ctx.credentials` |
| `baseURL` | `https://api.typesafe.ai` | API root. Non-HTTPS is refused except on loopback |
| `model` | `jev-latest` | Sent with every request |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | Below this, an answer is not acted on |
| `minProbability` | `0.6` | Below this, a decision is not acted on |
| `gates.safety` | `false` | Judge tool calls before dispatch |
| `gates.context` | `false` | Withhold large, uninformative tool results |

Gates accept a bare boolean (`safety: false`) or an object with `onUndecided`: `ask` (default),
`allow`, or `deny`.

An unknown value is rejected at load with a message naming the key, rather than being silently
ignored — a config typo should not quietly change the privacy posture.

---

## Using it

### From another plugin, with no model in the loop

The service is the primary surface. This is the point of a decision model: a routing or gating
decision should not cost a model round-trip.

```ts
const jev = ctx.get('jev')
const result = await jev.ask({
  feature: 'tool:jev_ask',
  state: { ticket: 'I was charged twice.' },
  questions: {
    urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
    team: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoices, refunds', technical: 'Bugs, outages' },
    },
  },
})
```

`result.answers` carries probabilities and confidence. Deciding what to do with them is your code's
job — see `src/policy.ts` for a worked example with an explicit confidence floor, where an unsure
answer produces `ask` rather than `allow`.

### From the model

Three tools, deliberately few and orthogonal:

- **`jev_ask`** — a batch of typed questions over one state.
- **`jev_rank`** — score and sort candidates against one criterion, one question per candidate in a
  single round-trip. The probabilities are independent per-candidate judgments, not a distribution.
- **`jev_check`** — does this evidence support this claim? Returns `supported`, `contradicted`,
  `conflicted`, `insufficient`, or `unknown`. Contradiction outranks support, because evidence that
  both supports and refutes is a conflict, not a weak yes.

### The mock provider

With `provider: mock`, every answer is derived from a hash of the question and state, so tests can
assert exact values and no socket is opened. Synthetic results are labelled as such in three places:
`provider: "mock"`, a `mock/jev-synthetic` model name, and a `warning` field on the result. A mock
that could be mistaken for a real judgment would be worse than no mock at all.

---

## Status

Honest accounting of what has and has not been verified.

**Verified**
- 232 tests pass with no network access and no `TYPESAFE_API_KEY`.
- The default path makes no network call: asserted by spying on `globalThis.fetch` while mounting the
  plugin and answering through the service.
- A disabled gate registers **no** event listener, and a denied egress never reaches the provider.
- The plugin activates on a real Cordis `Context`, publishes `ctx.jev`, and registers exactly three
  tools.
- Every DSH API used here (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) was checked against the installed
  runtime before use, and the payload types come from the installed declaration files.

**Not verified**
- **The live path has never been exercised against the real API.** No credential existed during
  development, so `LiveProvider` is covered only against an injected stub SDK. Expect to validate it
  on first live use.
- Gate behaviour on live traffic. The gates are tested against synthetic answers and real hook
  payload shapes, but no real tool call has been gated end to end.
- The context gate cannot recover context already spent. It withholds a result from reaching the
  agent; it does not prune anything retroactively, and the README of any plugin claiming otherwise
  should be read sceptically.
- No long-running or adversarial testing. Redaction is pattern-based and will miss an unrecognised
  secret shape.

---

## Design notes

Three decisions that are easy to get wrong and expensive to get wrong:

**A judge that cannot answer must not mean "allow".** If Jev is unreachable, or answers below the
confidence floor, the gates resolve through `onUndecided`, which defaults to `ask`. The only way to
get fail-open behaviour is to configure it. The context gate is the deliberate exception: it fails
open unconditionally, because losing a real tool result to a phantom "irrelevant" verdict is worse
than keeping an uninformative one.

**Nothing the model can say changes the gate.** No tool exposes gate configuration, thresholds, or
scope. A guard the guarded process can reconfigure is not a guard.

**A probability is not a permission.** Jev returns numbers; `src/policy.ts` turns them into
`allow`/`ask`/`deny` against locally configured thresholds. An answer that names a value outside the
declared criteria is `invalid` and denies — the guarantee of a typed decision model is that it cannot
return an undeclared value, so a violation means something upstream is wrong.

## Development

```sh
pnpm install
pnpm run check      # typecheck + tests + build
pnpm test           # tests only
```

No test requires a credential or a network connection, and CI enforces that by running with
`TYPESAFE_API_KEY` cleared.

## License

MIT

TypeSafe, Jev, and System One are trademarks of TypeSafe AI. This project is an independent
integration and is not affiliated with or endorsed by TypeSafe AI.
