# jevcore

TypeSafe [Jev](https://typesafe.ai) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and any other MCP host.

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`, `score` — and returns
calibrated probabilities. It does not write prose, and asking it to is a category error. This project
gives an agent exactly that surface, and nothing more.

**Offline by default. Egress disclosed. Nothing default-on.**

---

## Three packages, one decision layer

| Package | What it is | Use it when |
|---|---|---|
| [`jevcore`](packages/core) | The decisions. Imports nothing from DeepSeek Harness or Cordis. | You want Jev in a plain script, a service, or your own harness |
| [`jevcore-dsh`](packages/dsh) | The DSH plugin: one service, three tools, two opt-in gates | You are running DeepSeek Harness |
| [`jevcore-mcp`](packages/mcp) | The same three tools over MCP, with a stdio binary | Your host speaks MCP but is not DSH |

The adapters are thin on purpose. `packages/dsh` is four files: it declares tool schemas and
translates hook payloads. Everything decision-shaped — the primitives, the providers, the egress
contract, the policy, the gates — lives in core, so a new adapter cannot drift from the guarantees
the others make.
One runtime requirement differs across the three: `jevcore-dsh` tracks the harness and needs
Node `^22.19.0 || >=24.0.0`, while `jevcore` and `jevcore-mcp` need `>=20`.

---

## Why this exists

Between 2026-09-17 and 09-20, nineteen plugins appeared that wire Jev into DSH. Auditing their source
found a consistent pattern: the module labelled *guard*, *gate*, or *warden* was also the module
shipping prompts, tool arguments, and file contents to a third party, and the README generally did not
say so. Several were enabled by default. One gate could be reconfigured by the model it was guarding.

This project is the same idea with those failure modes designed out:

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
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore] ready - provider=mock - gates: safety=off context=off
```

With `provider: live` and every feature enabled, the same report becomes explicit about what leaves:

```
[jevcore] provider=live  endpoint=https://api.typesafe.ai  egress=ON
[jevcore]   SENDS  tool:jev_ask  { state<=16000c questions<=4000c }
[jevcore]   SENDS  tool:jev_rank  { state<=16000c questions<=4000c }
[jevcore]   SENDS  tool:jev_check  { state<=16000c questions<=4000c }
[jevcore]   SENDS  gate:safety  { state<=8000c questions<=2000c }
[jevcore]   SENDS  gate:context  { state<=6000c questions<=2000c }
[jevcore]   redaction is best-effort; it removes named fields and known secret shapes, and cannot
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

### As a DeepSeek Harness plugin

```sh
dsh plugin --profile <profile> add jevcore-dsh
```

Or from a checkout:

```sh
dsh plugin --profile <profile> add /absolute/path/to/jevcore/packages/dsh
```

`packages/dsh` imports `jevcore` by name, so a checkout also needs core
resolvable from the profile (`add /absolute/path/to/jevcore/packages/core`).

Then confirm the row activated — the plugin list should show `jev` as `active`,
not `failed` — and check the startup report in the log.

### As an MCP server

For a host that speaks MCP, the same three tools are available over stdio:

```sh
npx -y jevcore-mcp
```

To wire it into DeepSeek Harness specifically, install a configuration-only bundle
whose patch inserts the harness's own MCP client:

```yml
- insert:
    - id: jev-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jev
        transport: stdio
        command: npx
        args: ['-y', 'jevcore-mcp']
        env:
          TYPESAFE_API_KEY: '<the key>'
        failOnStartupError: true
```

The env map is not optional: DSH strips every credential-shaped name — anything
containing KEY, PASSWORD, SECRET or TOKEN, in any case — from the environment it
hands a spawned server, then merges this map back in afterwards. A key exported in
your shell never arrives, and the server stays on the offline mock without
reporting an error.

The provider is chosen from the environment:

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | Selects the TypeSafe route when present |
| `OPENROUTER_API_KEY` | Selects the OpenRouter route when present and no TypeSafe key is set |
| `JEV_PROVIDER` | `mock`, `live`, or `openrouter` — overrides the heuristic above |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Model id for the selected route |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | API root for the selected route |

With neither key it stays on the offline mock. Unlike the plugin, the MCP server
resolves its credential once at startup, so a missing key with
`JEV_PROVIDER=live` is a startup error rather than a per-call surprise.

Its egress report goes to **stderr**, never stdout — on a stdio transport stdout
is the protocol channel, and a stray line there would corrupt the stream.

### Going live

There are two routes to Jev. Both call the same models and both return the same
typed answers; they differ in who holds your credential and whose servers see
your state.

**TypeSafe directly** — use this if you have a key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys):

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: live
        apiKeyRef: TYPESAFE_API_KEY   # a reference, never the key
        model: jev-latest
```

**Through OpenRouter** — use this if a TypeSafe key is impractical and you
already have an [OpenRouter](https://openrouter.ai) key. OpenRouter serves the
System One models at the same `POST /v1/systemone` path TypeSafe does, one level
below its own API root, so this is the documented route to Jev rather than an
approximation of it:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        provider: openrouter
        openRouterApiKeyRef: OPENROUTER_API_KEY
        model: jev-latest              # a bare `jev-*` id, or `typesafe/jev-1.13`
```

The route is reached by pointing the official `@typesafe-ai/sdk` at
`https://openrouter.ai/api` with your OpenRouter key — OpenRouter's own
documented integration, so there is no second client to keep in step.

Two things to know about the OpenRouter route:

- **Your state goes to OpenRouter, not to TypeSafe.** A different third party
  with different retention and logging. The startup report names the endpoint for
  exactly this reason — read it rather than inferring the destination from the
  provider's name.
- **It returns a cost**, which TypeSafe's own route does not, so `usage.costUsd`
  is populated here and absent there.

The model id must be a System One one. `jev-latest` bare is the default and needs
no prefix; `typesafe/` is accepted on a versioned id such as `typesafe/jev-1.13`,
but not on the moving tag — `typesafe/jev-latest` is not accepted by the route.
Any other id would be routed to a chat model, which answers with prose this plugin
cannot interpret as a decision, so it is refused before the call rather than
misread after it.

Either way the credential is resolved through DSH's credential service first,
then the environment variable of that name. It is read per call, so a key added
while the process is running is picked up. It is never logged, never returned
from a tool, and never written to configuration. Each route has its own reference
(`apiKeyRef` and `openRouterApiKeyRef`) so the two cannot accidentally share a key.

`@typesafe-ai/sdk` is the only optional dependency; the plugin
loads and runs offline without either, and only needs the one for the route you
choose.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `mock` | `mock` (offline, deterministic, synthetic), `live` (TypeSafe), or `openrouter` |
| `apiKeyRef` | `TYPESAFE_API_KEY` | Credential reference for the `live` route |
| `openRouterApiKeyRef` | `OPENROUTER_API_KEY` | Credential reference for the `openrouter` route |
| `baseURL` | `https://api.typesafe.ai` | API root for the `live` route. Non-HTTPS is refused except on loopback |
| `openRouterBaseURL` | `https://openrouter.ai/api` | API root for the `openrouter` route. Same rule |
| `model` | `jev-latest` | Sent with every request. On the OpenRouter route the bare default works; `typesafe/` needs a versioned id such as `typesafe/jev-1.13`, and `typesafe/jev-latest` is not accepted |
| `logLevel` | `warn` | `silent` \| `warn` \| `info` \| `debug` |
| `minConfidence` | `0.7` | Below this, an answer is not acted on |
| `minProbability` | `0.6` | Below this, a decision is not acted on |
| `maxStateChars` | per feature | Replaces the `state` cap for every feature. `0` means "keep the declared cap" |
| `gates.safety` | `false` | Judge tool calls before dispatch |
| `gates.context` | `false` | Withhold large, uninformative tool results |

The declared `state` caps are 16,000 characters for the three tools and 8,000 / 6,000 for the safety
and context gates. `maxStateChars` replaces all of them, and the startup report shows the effective
value rather than the declared one, so what it prints is what is enforced.

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
  `conflicted`, `insufficient`, `undecided`, or `unknown`. Contradiction outranks support, because
  evidence that both supports and refutes is a conflict, not a weak yes.

### A bundled skill

The plugin registers a skill, `typesafe-ai-dsh`, teaching an agent when a Jev
judgment is the right tool and when it is a category error. It is registered
through the skill registry rather than shipped as a directory for a provider to
scan, so it needs no dependency on where a profile keeps its skills and it
disappears cleanly when the plugin is removed.

The body lives in `skills/typesafe-ai-dsh/SKILL.md` and is read at load rather
than embedded, so the file a human edits is the file that ships. A test asserts
the two cannot drift.

The registry is declared as an **optional** dependency: a profile that does not
compose the skill subsystem still gets the service and the three tools, with a
warning that the skill was skipped.

### The mock provider

With `provider: mock`, every answer is derived from a hash of the question and state, so tests can
assert exact values and no socket is opened. Synthetic results are labelled as such in three places:
`provider: "mock"`, a `mock/jev-synthetic` model name, and a `warning` field on the result. A mock
that could be mistaken for a real judgment would be worse than no mock at all.

---

## Status

Honest accounting of what has and has not been verified.

**Verified**
- 410 tests pass across three packages (314 core, 66 DSH, 30 MCP), with no network access and no
  `TYPESAFE_API_KEY`. CI clears the variable and expects the suite to pass anyway.
- **The OpenRouter route is verified against the real API.** `pnpm --filter jevcore run
  probe:live` drives the provider and `pnpm --filter jevcore-mcp run smoke:live` drives the whole MCP
  surface — transport, tool schemas, service and provider — against real System One models
  (`typesafe/jev-1.13-20260917`). A three-primitive batch returned a `noul` at 0.91, a `choice` at
  0.97, and a `score` of `1.05` on a four-level rubric, with usage reported as
  `{ inputTokens: 469, outputTokens: 68, costUsd: 0.000019698 }`. `jev_rank` ordered a credential
  runbook above a billing guide; `jev_check` returned `contradicted`. Both scripts need
  `OPENROUTER_API_KEY` and are excluded from CI.
- **The payload shapes are checked against the vendors' own type definitions.**
  `test/vendor-conformance.test.ts` pins this project's question and answer types to both SDKs, so a
  drift in either direction is a compile error rather than a malformed request on the one route that
  costs money and transmits data. That check is what found `score.criteria` being sent as a keyed map
  when the API requires an ordered array — a defect the stubbed unit tests had passed over
  throughout. There is also a script that parsed our payloads against OpenRouter's published zod
  schemas for the `alpha/decisions` route; both the script and that route are gone, because the
  OpenRouter provider now uses the documented `/v1/systemone` path through the same client TypeSafe
  uses, which the conformance test already covers.
- **The plugin activates in a running harness and its tools work.** The plugin row reports `active`;
  `jev_ask` returned `urgent=true (0.8307)` and `team=billing (0.5027)` against the mock in 1 ms, and
  `jev_check` returned `verdict="insufficient"` with its three probabilities. Every result carried
  `provider: "mock"` and zero token usage, so the default path made no network call.
- **The bundled skill registers.** `typesafe-ai-dsh` appears in the session skill catalog.
- The default path makes no network call: asserted by spying on `globalThis.fetch` while mounting the
  plugin and answering through the service, and again while assembling the MCP runtime.
- A disabled gate registers **no** event listener, and a denied egress never reaches the provider.
- `Config` satisfies the Standard Schema protocol Cordis requires before a plugin starts.
- Every DSH API used here (`ctx.provide`, `ctx.effect`, `tools.register`, `defineTool`,
  `tools/pre-execute`, `tools/post-execute`, `credentials.resolve`) was checked against the installed
  runtime before use, and the payload types come from the installed declaration files.

**Not verified, or known-broken**
- **The TypeSafe route has never been exercised against the real API.** No TypeSafe credential was
  available, so `LiveProvider` is covered against an injected stub and against the vendor's type
  definitions — weaker than a real call. The question shape is now known-correct and both routes take
  the same primitives, so a TypeSafe key is *expected* to work unchanged; that is an expectation, not
  an observation. Quota, rate-limit and entitlement behaviour on a real account is untested.
- **`jev_ask`'s description carries a corrupted dash on the build that is currently running.** It
  reads `branches on —?routing` where an em dash followed by a space belongs. Cause: a UTF-8 round-trip
  early in development replaced the third byte of the em dash with `?`. It is fixed on disk — four
  occurrences, zero remaining, confirmed in both source and build output — but the running process
  loaded its module before the fix and cannot re-read it without a restart. Cosmetic only; it changes
  no behaviour.
- The MCP server has been driven end to end by a real MCP client over stdio
  (`pnpm --filter jevcore-mcp run smoke`): handshake, tool discovery, three successful calls, and an
  error result for an invalid batch. It has not been driven by any other third-party host.
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

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev, and System One are trademarks of TypeSafe AI. This project is an independent
integration and is not affiliated with or endorsed by TypeSafe AI.
