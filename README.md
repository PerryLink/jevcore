# jevcore
[![dshfind](https://dshfind.com/api/badge/PerryLink/jevcore?metric=downloads)](https://dshfind.com/plugins/PerryLink/jevcore?ref=badge)

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore/badge)](https://api.securityscorecards.dev/projects/github.com/PerryLink/jevcore)
[![jevcore MCP server](https://glama.ai/mcp/servers/PerryLink/jevcore/badges/score.svg)](https://glama.ai/mcp/servers/PerryLink/jevcore)

TypeSafe [Jev](https://typesafe.ai) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and any other MCP host.

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`, `score` — and returns
calibrated probabilities. It does not write prose, and asking it to is a category error. This project
gives an agent exactly that surface, and nothing more.

**Offline by default. Egress disclosed. Nothing default-on.**

---

**📖 Ecosystem knowledge base** — measured data, not marketing: [plugin development guide · plugin-selection data · maintenance criteria](https://perrylink.github.io/dsh-plugin-guide/).

<!-- star-cta -->
## ⭐ 如果它帮到了你

这个插件是 [DSH 插件家族](https://github.com/PerryLink)的一员（40+ 个，全部 Apache-2.0）。如果你在用，**给个 star** —— 它不会解锁任何功能，但会让下一个人在搜索里更容易找到它。

*English:* part of a 40+ plugin family for DeepSeek Harness. If it is useful, **a star helps the next person find it** — nothing is gated behind it.


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

`ask` is a question, so it needs something to ask. A deployment that composes no approval service
cannot escalate to a human, and DeepSeek Harness then refuses the call instead of running it: every
tool the safety gate matches is refused, which an operator experiences as the plugin having broken
shell commands. [docs/approval.md](docs/approval.md) has the mechanism, and the plugin README covers
the deployment view.

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
- **The TypeSafe route is exercised, but only lightly.** `packages/core/scripts/probe-live.mjs`
  (`pnpm --filter jevcore run probe:typesafe`) asks the real API three things: ten claim/evidence
  pairs whose verdict is known in advance, one question repeated six times, and a noul carrying a
  `criteria: {true, false}` boundary. Two separate runs agreed — supporting evidence scored 0.95,
  contradicting evidence 0.10, evidence silent about the claim 0.03, and the repeated question varied
  by 0.01 or less. The boundary was accepted. What remains untested is everything around the request
  rather than the request itself: quota, rate-limit and entitlement behaviour on a real account.
- **`jev_ask`'s description carries a corrupted dash on the build that is currently running.** It
  reads `branches on —?routing` where an em dash followed by a space belongs. Cause: a UTF-8 round-trip
  early in development replaced the third byte of the em dash with `?`. It is fixed on disk — four
  occurrences, zero remaining, confirmed in both source and build output — but the running process
  loaded its module before the fix and cannot re-read it without a restart. The dash itself is
  cosmetic, but the staleness is not: the same process also lacks every fix made since it started,
  including the `band` field that keeps a 0.51 from being read as a settled yes.
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

## PerryLink DSH Plugin Family

This project is one of the **87 actively maintained** DeepSeek Harness plugins from [PerryLink](https://github.com/PerryLink). The family roster is **95** plugins in total — **5 frozen**, **3 retired** — and stays collapsed below so every README keeps a short first screen. Expand it to see every row, with the reason in the Status column.

<details>
<summary>Expand all 95 plugins</summary>

| Plugin | One-liner | Status |
|---|---|---|
| **[dsh-aqua-input-check](https://github.com/PerryLink/dsh-aqua-input-check)** | 水产养殖投入品记录核对（按投入品用量、休药期与起捕间隔核对记录自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-archive-check](https://github.com/PerryLink/dsh-archive-check)** | 档案归档完整性与保管期限核对（依据《档案法》及配套规定，仅提示差异，不作出定性结论） |  |
| **[dsh-auto-review](https://github.com/PerryLink/dsh-auto-review)** | Second-model auto-review on the approval chain, fail-closed by default |  |
| **[dsh-autotier](https://github.com/PerryLink/dsh-autotier)** | Automatic strong/cheap model-tier routing with deterministic risk guards and a `/tier` command |  |
| **[dsh-background-agents](https://github.com/PerryLink/dsh-background-agents)** | Durable background child agents with a Web UI sidebar, messaging and interrupt | 🚫 RETIRED — see the repo README |
| **[dsh-bid-ca-precheck](https://github.com/PerryLink/dsh-bid-ca-precheck)** | 投标文件符合性预检（按招标文件逐条核对响应情况，仅提示差异，不作出定性结论） |  |
| **[dsh-bid-qual-check](https://github.com/PerryLink/dsh-bid-qual-check)** | 投标人资格条件核对（按资格条件与证明材料核对逐条响应，仅提示差异，不作出定性结论） |  |
| **[dsh-budget](https://github.com/PerryLink/dsh-budget)** | Cost governance for DeepSeek Harness: budgets, carbon, and latency in one panel. | 🧊 FROZEN — see the repo README |
| **[dsh-cert-mcp](https://github.com/PerryLink/dsh-cert-mcp)** | Read-only MCP server exposing the certification registry: grades, snapshots and five-dimension evidence |  |
| **[dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind)** | Claude Code /rewind-equivalent: snapshots, session forks, one-shot restore |  |
| **[dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)** | Migrate Claude Code sessions, memory, skills and CLAUDE.md into DSH | 🧊 FROZEN — see the repo README |
| **[dsh-click](https://github.com/PerryLink/dsh-click)** | Cross-platform native desktop control for DeepSeek Harness — Windows first. |  |
| **[dsh-composer-history](https://github.com/PerryLink/dsh-composer-history)** | Terminal-style input history for the web composer: arrows, Ctrl+R search |  |
| **[dsh-contract-stance](https://github.com/PerryLink/dsh-contract-stance)** | 合同条款立场台账核对（按立场、风险等级与退让底线核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-customs-doc-check](https://github.com/PerryLink/dsh-customs-doc-check)** | 报关单证一致性核对（按公开的报关单填制规范核对单证间字段一致性，仅提示差异，不作出定性结论） |  |
| **[dsh-data-quality](https://github.com/PerryLink/dsh-data-quality)** | Dataset quality checks and citation cross-checks (the optional numeric bridge consumed here) |  |
| **[dsh-defend](https://github.com/PerryLink/dsh-defend)** | Prompt-injection, jailbreak, and secret-leak defense for DeepSeek Harness. | 🧊 FROZEN — see the repo README |
| **[dsh-demurrage-ledger](https://github.com/PerryLink/dsh-demurrage-ledger)** | 滞箱费台账核对（按免箱期与费率核对超期天数与金额的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-doublecheck](https://github.com/PerryLink/dsh-doublecheck)** | Engineering-discipline guard: requirements grill, test gates, adversary review |  |
| **[dsh-draw](https://github.com/PerryLink/dsh-draw)** | Unified static-image generation routing for DeepSeek Harness. | 🧊 FROZEN — see the repo README |
| **[dsh-drill-script-check](https://github.com/PerryLink/dsh-drill-script-check)** | 应急演练脚本核对（按阶段、响应分级、指挥与资源要素核对脚本齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-eia-guide-check](https://github.com/PerryLink/dsh-eia-guide-check)** | 环评导则适用性核对（按要素、导则名称与执行标准核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-emergency-plan](https://github.com/PerryLink/dsh-emergency-plan)** | 应急预案要素齐备性与条款级页码定位（依据 GB/T 29639-2020 等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-essay-rubric-check](https://github.com/PerryLink/dsh-essay-rubric-check)** | 作文量表评分核对（按评分项、原文定位与分值算术核对评分自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-evidence-check](https://github.com/PerryLink/dsh-evidence-check)** | 证据清单齐备性核对（按待证事实与证据要素核对清单自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-export-ctl-check](https://github.com/PerryLink/dsh-export-ctl-check)** | 出口管制物项核对（按管制清单、最终用途与许可证核对台账齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-fast](https://github.com/PerryLink/dsh-fast)** | Read-only performance diagnostics for DeepSeek Harness. |  |
| **[dsh-fmea-table-check](https://github.com/PerryLink/dsh-fmea-table-check)** | FMEA 分析表要素齐备性与风险顺序数一致性核对（按公开的 FMEA 方法标准核对表内自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-forecast-penalty](https://github.com/PerryLink/dsh-forecast-penalty)** | 预测准确率考核核对（按准确率、门槛与考核单价核对考核费用的算术自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-fund-research](https://github.com/PerryLink/dsh-fund-research)** | Deterministic research reports for Chinese public mutual funds |  |
| **[dsh-github](https://github.com/PerryLink/dsh-github)** | GitHub PR/issues integration for DSH, every write gated by approval |  |
| **[dsh-gongwen-flow-check](https://github.com/PerryLink/dsh-gongwen-flow-check)** | 公文流转与办理时限核对（按公开的公文处理规范核对环节完整性与时限，仅提示差异，不作出定性结论） |  |
| **[dsh-gongwen-word-check](https://github.com/PerryLink/dsh-gongwen-word-check)** | 公文格式要素核对（按公开的党政机关公文格式标准核对版头与主体要素，仅提示差异，不作出定性结论） |  |
| **[dsh-guard-plan-qc](https://github.com/PerryLink/dsh-guard-plan-qc)** | 劳动保护与安全防护用品配置表核对（按公开的配备标准核对品名规格与配置数量，仅提示差异，不作出定性结论） |  |
| **[dsh-hazchem-check](https://github.com/PerryLink/dsh-hazchem-check)** | 危险化学品临界量与重大危险源辨识核对（按储存量与临界量核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-hazplan-check](https://github.com/PerryLink/dsh-hazplan-check)** | HAZOP 分析表要素齐备性与偏差推导一致性核对（依据公开的危险与可操作性分析标准，仅提示差异，不作出定性结论） |  |
| **[dsh-hidden-risk-map](https://github.com/PerryLink/dsh-hidden-risk-map)** | 安全隐患台账→《工贸企业重大事故隐患判定标准》（应急管理部令第10号）条款映射提示（仅提示差异，不作出定性结论） |  |
| **[dsh-hs-classify](https://github.com/PerryLink/dsh-hs-classify)** | 商品归类层级一致性核对（按章、品目、子目与商品编号的层级关系核对自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-icd-rule-check](https://github.com/PerryLink/dsh-icd-rule-check)** | ICD 合并编码与星剑号配对提示（依据 GB/T 14396-2016 与公开的 ICD 使用说明，仅提示差异，不作出定性结论） |  |
| **[dsh-industry-research](https://github.com/PerryLink/dsh-industry-research)** | Industry research orchestration that seals its deliverables through this plugin's `ctx.researchReport.assemble` |  |
| **[dsh-lawcite-adapter](https://github.com/PerryLink/dsh-lawcite-adapter)** | 法条引用与文书要素核对（按名称、条号、原文与效力状态核对引用可核验性，仅提示差异，不作出定性结论） |  |
| **[dsh-laya](https://github.com/PerryLink/dsh-laya)** | Laya typed decisions (`noul`/`choice`/`score`) as a first-class Cordis service and model-visible tools |  |
| **[dsh-lc-doc-check](https://github.com/PerryLink/dsh-lc-doc-check)** | 信用证单据条款核对（按单据种类、份数、期限与不符点核对交单自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-learning-gap-check](https://github.com/PerryLink/dsh-learning-gap-check)** | 能力差距与培养计划核对（按能力等级差、培养措施与完成期限核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-library](https://github.com/PerryLink/dsh-library)** | Local document knowledge base for DeepSeek Harness. |  |
| **[dsh-local-ai](https://github.com/PerryLink/dsh-local-ai)** | Local-model (Ollama) integration for DeepSeek Harness. |  |
| **[dsh-lsp-actions](https://github.com/PerryLink/dsh-lsp-actions)** | LSP diagnostics, formatting, completion, code actions and rename over language servers |  |
| **[dsh-mask](https://github.com/PerryLink/dsh-mask)** | PII masking middleware: anonymize at the model boundary, restore at the display layer |  |
| **[dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel)** | Read-only MCP runtime panel: /mcp command + Settings tab with status, tools and errors |  |
| **[dsh-medrec-qc](https://github.com/PerryLink/dsh-medrec-qc)** | 病案首页形式质控与逻辑矛盾提示（依据国卫办医发〔2016〕24号等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-memento](https://github.com/PerryLink/dsh-memento)** | Approval-gated cross-session memory: ctx.memory seam + SQLite + memory tool |  |
| **[dsh-nsfc-form-check](https://github.com/PerryLink/dsh-nsfc-form-check)** | 国家自然科学基金申请书形式审查与匿名化提示（依据《国家自然科学基金条例》与申请人导入的当年指南，仅提示差异，不作出定性结论） |  |
| **[dsh-nurse-record-check](https://github.com/PerryLink/dsh-nurse-record-check)** | 护理记录时限、签名与评估表完整性校验（依据《病历书写基本规范》等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-observe](https://github.com/PerryLink/dsh-observe)** | OpenTelemetry and Langfuse observability exporter for DeepSeek Harness. |  |
| **[dsh-origin-rvc-check](https://github.com/PerryLink/dsh-origin-rvc-check)** | 原产地区域价值成分核对（按 RVC 定义式与门槛核对原产地判定自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-ota-review-check](https://github.com/PerryLink/dsh-ota-review-check)** | 在线点评回复台账核对（按回复时限、问题分类与整改状态核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-output-styles](https://github.com/PerryLink/dsh-output-styles)** | Claude Code outputStyles-equivalent runtime style switching |  |
| **[dsh-paper-doc-adapter](https://github.com/PerryLink/dsh-paper-doc-adapter)** | 试卷解析结构核对（按题型、答案、分值与 yotta 标识核对试卷结构自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-permission-rules](https://github.com/PerryLink/dsh-permission-rules)** | Claude Code-style declarative allow/deny/ask permission rules with audit |  |
| **[dsh-permit-report-check](https://github.com/PerryLink/dsh-permit-report-check)** | 行政许可办理核对（按申请材料、法定时限与决定记录核对台账闭环，仅提示差异，不作出定性结论） |  |
| **[dsh-pipeline-check](https://github.com/PerryLink/dsh-pipeline-check)** | 项目全流程文件链条核对（按环节先后与金额口径核对链条自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-pleading-draft](https://github.com/PerryLink/dsh-pleading-draft)** | 起诉状要素齐备性核对（按诉请、事实、证据、法条四要素核对文书齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-plugin-doctor](https://github.com/PerryLink/dsh-plugin-doctor)** | Zero-dependency static + sandbox smoke detector for DSH plugins |  |
| **[dsh-plugin-guide](https://github.com/PerryLink/dsh-plugin-guide)** | Plugin-development knowledge base as an on-demand agent skill |  |
| **[dsh-plugin-kit](https://github.com/PerryLink/dsh-plugin-kit)** | Shared zero-runtime-dependency toolkit for the PerryLink DSH plugins |  |
| **[dsh-plugin-upgrade](https://github.com/PerryLink/dsh-plugin-upgrade)** | One-package, one-corridor-index plugin upgrade skill: routes a repository to the matching closed corridor card |  |
| **[dsh-policy-brief-draft](https://github.com/PerryLink/dsh-policy-brief-draft)** | 政策专报要素核对（按观点、依据、出处与建议核对专报齐备，仅提示差异，不作出定性结论） |  |
| **[dsh-power-loss-split](https://github.com/PerryLink/dsh-power-loss-split)** | 线损电量拆分与考核表核对（依据公开的线损计算口径，仅提示差异，不作出定性结论） |  |
| **[dsh-power-ticket-check](https://github.com/PerryLink/dsh-power-ticket-check)** | 电力工作票要素齐备性与签发许可顺序核对（依据现行电力安全工作规程，仅提示差异，不作出定性结论） |  |
| **[dsh-ppap-check](https://github.com/PerryLink/dsh-ppap-check)** | PPAP 提交要素齐备性核对（按公开的 PPAP 手册与提交等级核对要素齐备与版本填写，仅提示差异，不作出定性结论） |  |
| **[dsh-protest-deadline](https://github.com/PerryLink/dsh-protest-deadline)** | 质疑与投诉期限核对（按公开的政府采购质疑投诉规定核对期限与台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-railway-window](https://github.com/PerryLink/dsh-railway-window)** | 铁路施工天窗台账核对（按时间窗、时长算术与命令号核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-reach](https://github.com/PerryLink/dsh-reach)** | Multi-channel approval/question bridge: WeChat/Telegram/Feishu, session console | 🧊 FROZEN — see the repo README |
| **[dsh-repair-order-qc](https://github.com/PerryLink/dsh-repair-order-qc)** | 维修工单结算核对（按项目金额、配件工时合计与结算总额核对算术自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-research-report](https://github.com/PerryLink/dsh-research-report)** | Verifiable research-report engine: content-addressed evidence ledger and sealed versions |  |
| **[dsh-review-reply-check](https://github.com/PerryLink/dsh-review-reply-check)** | 审稿意见逐条回应覆盖核对（按意见与回应一一对应核对覆盖完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-rulefile-check](https://github.com/PerryLink/dsh-rulefile-check)** | 规则库文件自检核对（按条款引用纪律与效力上限核对规则库自身合规，仅提示差异，不作出定性结论） |  |
| **[dsh-safety-brief-check](https://github.com/PerryLink/dsh-safety-brief-check)** | 安全技术交底记录要素齐备性与签字闭环核对（依据公开的安全生产法规与检查标准，仅提示差异，不作出定性结论） |  |
| **[dsh-score](https://github.com/PerryLink/dsh-score)** | Multi-dimensional quality scoring for DeepSeek Harness plugins. |  |
| **[dsh-session-pin](https://github.com/PerryLink/dsh-session-pin)** | Pin sessions in the Web sidebar with durable ordering | 🚫 RETIRED — see the repo README |
| **[dsh-session-sync](https://github.com/PerryLink/dsh-session-sync)** | Cross-device session sync for DeepSeek Harness — a dedicated git mirror of your session store. |  |
| **[dsh-site-log-check](https://github.com/PerryLink/dsh-site-log-check)** | 监理日志跨日连续性与旁站覆盖提示（依据 GB/T 50319-2013 等公开文件，仅提示差异，不作出定性结论） |  |
| **[dsh-skill-pack-security](https://github.com/PerryLink/dsh-skill-pack-security)** | Security-audit skill pack: secret scan, dependency and supply-chain review |  |
| **[dsh-soe-decision-check](https://github.com/PerryLink/dsh-soe-decision-check)** | 三重一大决策台账核对（按前置研究、会议审议与决议记录核对程序留痕，仅提示差异，不作出定性结论） |  |
| **[dsh-soilwater-check](https://github.com/PerryLink/dsh-soilwater-check)** | 土壤与地下水监测台账核对（按点位、监测项目、限值与超标判定核对台账自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-sop-sync-check](https://github.com/PerryLink/dsh-sop-sync-check)** | 作业规程与 FMEA／控制计划一致性核对（按编号与版本核对三份文件是否同步，仅提示差异，不作出定性结论） |  |
| **[dsh-spc-gbt-adapter](https://github.com/PerryLink/dsh-spc-gbt-adapter)** | 控制图常数与过程能力指数核对（按 GB/T 4091 的常规控制图常数表核对控制限与 Cp/Cpk 的自洽性，仅提示差异，不作出定性结论） |  |
| **[dsh-talk](https://github.com/PerryLink/dsh-talk)** | Voice-first session loop for DeepSeek Harness: talk to it, hear it answer. |  |
| **[dsh-team-rooms](https://github.com/PerryLink/dsh-team-rooms)** | Cross-session team rooms: shared message bus, task board and timeline | 🚫 RETIRED — see the repo README |
| **[dsh-tender-extract](https://github.com/PerryLink/dsh-tender-extract)** | 招标文件条款摘录核对（按出处与原文逐字核对摘录完整性，仅提示差异，不作出定性结论） |  |
| **[dsh-tender-matrix](https://github.com/PerryLink/dsh-tender-matrix)** | 评标因素评分矩阵核对（按分值上限与合计核对矩阵自洽，仅提示差异，不作出定性结论） |  |
| **[dsh-test-drive](https://github.com/PerryLink/dsh-test-drive)** | Isolated install-and-smoke test drives for DeepSeek Harness plugins. |  |
| **[dsh-ticktick](https://github.com/PerryLink/dsh-ticktick)** | TickTick/Dida365 task bridge: session-header panel + 11 tools |  |
| **[dsh-translate](https://github.com/PerryLink/dsh-translate)** | Vendor parameter translation and deterministic JSON repair for DeepSeek Harness. |  |
| **[dsh-warranty-calc](https://github.com/PerryLink/dsh-warranty-calc)** | 质保期与索赔金额核对（按质保期月数与里程、索赔金额算式核对自洽，仅提示差异，不作出定性结论） |  |

</details>

</details>

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors

TypeSafe, Jev, and System One are trademarks of TypeSafe AI. This project is an independent
integration and is not affiliated with or endorsed by TypeSafe AI.
