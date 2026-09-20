# Limits: what this does not do

This page collects the boundaries you would otherwise discover by being
surprised. Each one is stated with the constant or the line that enforces it, and
where a number is derived the arithmetic is written out so you can check it.

Nothing here is a defect list. These are the edges of the design: what the
timeouts really bound, what a reported cost really is, where a long candidate
list is refused instead of shortened, and what the offline mock is allowed to
mean.

---

## 1. Timing: a per-attempt timeout, and a total you cannot configure

Three numbers govern one call, and only two of them are in your configuration.

| What | Value | Where |
|---|---|---|
| Per-attempt timeout | `requestTimeoutMs`, default `10_000` ms | `packages/core/src/config.ts:230`, passed at `packages/dsh/src/index.ts:244` |
| Retries after the first attempt | `requestMaxRetries`, default `2` | `packages/core/src/config.ts:239` |
| Total budget for the whole call | `40_000` ms, derived | `packages/core/src/provider/classify.ts:311-312` |

**The per-attempt number does not bound the call, and the SDK says so in its own
words.** `timeout` is documented as "Timeout per attempt in milliseconds; there
is no total retry budget", default `10000`
(`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:184` and `:220`). Three attempts at
the default timeout is not ten seconds of blocking; it is up to thirty, plus
backoff.

**The bound is the total budget the provider arms around the whole call:**

```ts
// packages/core/src/provider/classify.ts:311-312
export const DEFAULT_TOTAL_BUDGET_MS: number =
  DEFAULT_PER_ATTEMPT_TIMEOUT_MS * (DEFAULT_MAX_RETRIES + 1) + 10_000
```

That is `10_000 x 3 + 10_000 = 40_000` ms. When it fires, the signal aborts with
a reason named `TimeoutError` carrying
`the call exceeded its total budget of 40000ms` (`classify.ts:337-363`), which
the classifier reports as code `timeout`:
`TypeSafe call timed out before an answer arrived.` (`classify.ts:238-248`).

**The total is derived from the defaults, not from your settings.** The
expression reads the two `DEFAULT_*` constants (`classify.ts:280` and `:288`),
so it is fixed at module load, and the DSH plugin never passes `totalBudgetMs`
(`packages/dsh/src/index.ts:232-246`). Configure `requestTimeoutMs: 30_000` and a
call is still cut off at 40 seconds, mid-attempt. `totalBudgetMs` exists as a
provider option (`packages/core/src/provider/live.ts:216-224`, and the same on
the OpenRouter route at `packages/core/src/provider/openrouter.ts:107`) and is
deliberately absent from the plugin's config surface: `JevConfigInput` has no
such key (`config.ts:121-186`). A library embedder can set it; a plugin operator
cannot.

Two more consequences of the same design:

- **`requestTimeoutMs: 0` does not remove the ceiling.** It means "no per-attempt
  deadline", encoded as `86_400_000` ms because the SDK rejects any value `<= 0`
  (`NO_PER_ATTEMPT_TIMEOUT_MS`, `classify.ts:67`; `timeoutForSdk`,
  `provider/live.ts:254`). The 40-second budget still applies.
- **The tools share one fate per batch.** Jev answers every question in a call
  against one state, so a call that times out returns nothing: there is no
  partial result and no per-question retry. And a retry re-sends the same
  payload, so one logical call can put the same state on the wire up to three
  times. `stats().transmitted` counts logical calls, not attempts
  (`packages/core/src/service.ts:242-250`).

The SDK's own retry defaults apply underneath: backoff starting at 500 ms,
doubling to a 5,000 ms cap, jitter 0.25, retrying statuses 408, 429 and 500-599,
and honouring `Retry-After` up to 60 s (`dist/index.d.mts:159-179`). The plugin
overrides only `maxRetries` (`packages/dsh/src/index.ts:245`). Time spent
waiting out a `Retry-After` counts against the same 40-second budget, and that
delay can be longer than the budget.

---

## 2. Cost accounting: a zero that means "not reported"

`JevStats.totalCostUsd` sums the cost the provider actually reported
(`packages/core/src/service.ts:54-83`), and the field beside it says whether
that sum is spend at all:

```ts
// packages/core/src/service.ts:380
costAccounting: this.calls > 0 && this.callsWithoutCost === 0 ? 'reported' : 'unavailable',
```

On the live TypeSafe route it is always `unavailable`, and the total is a
confident-looking `0`:

- The SDK's usage type has no cost field. `Usage` is
  `{ input_tokens, output_tokens }` and nothing else
  (`@typesafe-ai/sdk@0.6.0`, `dist/index.d.mts:120-126`; `SystemOneResult.usage`
  at `:128-135`).
- This package reads a cost only if one is present: `readUsage` looks for
  `cost_usd` or `costUsd` (`packages/core/src/provider/live.ts:371-383`), and the
  branch never fires on that route, so every successful call adds `0` while it
  is being billed (`service.ts:260-269`).
- Upstream charges per input token and makes output tokens free
  ([Models](https://docs.typesafe.ai/models.md)), so the real cost is not zero.
  It is simply not in the response this route reads.

`callsWithoutCost` is the raw count behind that verdict: successful calls whose
result carried no `usage.costUsd` (`service.ts:93-102`). Read it directly when
you want the shape of the problem rather than the verdict. Equal to `calls`, it
says the provider never reports cost; climbing partway through says the route
used to report it and stopped.

The OpenRouter route is different: it reads `cost` or `cost_usd` from the
response (`packages/core/src/provider/openrouter.ts:187-199`), so a cost can
appear there and `costAccounting` can read `reported`. The mock reports
`{ inputTokens: 0, outputTokens: 0, costUsd: 0 }`
(`packages/core/src/provider/mock.ts:152`), which is honest for a provider that
touches no API, and does not make it a cost measurement. The type has always
allowed an absent cost (`JevUsage.costUsd` is optional,
`packages/core/src/types.ts:190-194`).

Three more things the counters are not:

- **Failures contribute nothing.** Usage is accumulated after the provider
  returns, in the success branch only (`service.ts:260-269`); a call that failed
  after the vendor billed for it adds zero, and `failures` counts it instead.
- **They are process-lifetime counters, not a window.** `stats()` reports totals
  since the service was constructed (`service.ts:368-384`), and `recent()` keeps
  the last 20 calls (`historyLimit ?? 20`, `service.ts:207`; the plugin does not
  override it, `packages/dsh/src/index.ts:270-277`).
- **There is no per-feature or per-model breakdown.** `JevStats` has one set of
  totals, so the three tools and both gates share them.

---

## 3. Ranking: one question per candidate, and a cap that refuses

`jev_rank` builds one `noul` question per candidate and asks them all in one
call against one state (`packages/dsh/src/rank.ts:54-80`; the MCP server builds
the same questions in `packages/mcp/src/tools.ts:212-218`). There is no
candidate-count argument anywhere, and the candidate list is never truncated by
the tool: every candidate comes back in the ranking, and one Jev did not answer
is reported as `no answer returned for this candidate` and sorted last rather
than treated as a relevance of zero (`rank.ts:388-408`).

What *is* capped is the serialized question map: 4,000 characters for
`tool:jev_rank` (`packages/core/src/egress.ts:63-70`, read into the tool as
`QUESTION_CHAR_CAP`, `rank.ts:94-95`). And `questions` is **refused, not
truncated**, because answers are keyed by question (`egress.ts:302-312`): a
shortened map would return answers that cannot be matched to what was asked. The
refusal is an `EgressTooLargeError` naming the limit and the actual size
(`egress.ts:182-204`), thrown before any provider call (`service.ts:238-248`).
The tool description states the same thing to the model (`rank.ts:163-176`).

So the candidate limit is the character cap divided by the cost of one question.
Each additional candidate costs 126 characters plus your criterion's length
(`CANDIDATE_QUESTION_OVERHEAD`, `rank.ts:118`), with one more character from
index 10 on, plus the map's own braces and commas. The criterion is repeated into
every question, which is why its length is charged once per candidate. When you
omit `criterion`, the default text is 69 characters (`DEFAULT_CRITERION`,
`rank.ts:42-43`):

| Criterion length | Candidates that fit | Serialized size, and the refusal one candidate later |
|---|---|---|
| 69 (criterion omitted) | 20 | 3,921; 21 would be 4,118 |
| 400 | 7 | 3,683; 8 would be 4,209 |
| 1,000 | 3 | 3,379; 4 would be 4,505 |

Those counts are arithmetic from the question construction and the
4,000-character cap; the 20 and the 7 match what the MCP tool description
reports as measured (`packages/mcp/src/server.ts:185-186`). The direction is
what to remember: **a long criterion costs you candidates one for one**, and a
batch that does not fit is refused outright, so retrying the same call cannot
help. The DSH tool description quotes its own figure as "about N"
(`rank.ts:163-176`), computed with a `+1` and from a `candidateCap` that counts
with a 200-character allowance (`rank.ts:129-133` and `:169`), so that figure
sits above the number that actually fits; the table above is the boundary the
cap enforces.

Two related caps behave differently, and it is worth keeping them apart:

- **The candidate text travels in `state`**, capped at 16,000 characters for
  `tool:jev_rank` (`egress.ts:63-70`, read into the tool as `STATE_CHAR_CAP`,
  `rank.ts:106-107`). An over-long state is *truncated*, into a valid envelope
  that declares the original size (`egress.ts:406-466`), and both the result
  (`service.ts:166-182`) and the DSH tool payload (`rank.ts:423`) carry
  `truncated: true`. Jev then judges a smaller state, which is why you should
  read that flag rather than assume it saw the whole list. `packages/mcp/src/tools.ts:24-38`
  records the measurement behind this: ten 4,000-character candidates are 40,271
  characters of state, 16,000 are sent, and all ten candidates still come back
  with scores that describe the fragment.
- **`maxStateChars` raises neither cap for `questions`.** It replaces the `state`
  field's cap only (`egress.ts:242-248`), and `0` means "keep the declared cap"
  (`config.ts:369-376`).

---

## 4. The offline mock: deterministic, and deliberately not a measurement

The mock is the default provider, and it is honest about being one. Two
guarantees and one warning:

- **Determinism.** Each answer is FNV-1a over `questionId + "\u0000" +
  JSON.stringify(state)`, rounded to four decimals
  (`packages/core/src/provider/mock.ts:35-51` and `:88`). The same state and the
  same question id always give the same number, so you can assert on it.
- **No invented confidence.** Choice and score answers carry a fixed `0.5`
  (`MOCK_CONFIDENCE`, `mock.ts:32`); a noul carries none, because a noul has
  none (`mock.ts:80-90`). Under the default `minConfidence` of `0.7`, every mock
  choice or score answer is therefore `undecided`. That is the mock refusing to
  look certain, not a bug.
- **What it ignores is the point.** `probe` hashes the question *id* and the
  *state* only (`mock.ts:50-51`). The instructions, a noul's `criteria`, and a
  choice's option descriptions never enter the hash; a score's descriptions
  appear only as the returned `legend` (`mock.ts:109-113`). Rewrite a question so
  it means the opposite and the number does not move. Its `usage` is zeros, its
  `latencyMs` is a wall-clock delta that is normally `0`, and its `model` reports
  `mock/jev-synthetic` unless a model was configured (`mock.ts:148-155`).

Read a mock answer as a fixture, never as a judgment: it is a hash of your own
input. Do not tune a threshold against it, and do not read a mock gate decision
as evidence about a real one.

---

## 5. Model aliases move under you

`model` defaults to `jev-latest` (`packages/core/src/config.ts:247`), which is
the SDK's own default as well (`dist/index.d.mts:208`). An alias is not a
version: `jev-latest` and `jev-preview` both resolve to `jev-1.13.0` today, and
"an alias moves when a new release ships, so the answers behind it can change
without a change on your side" ([Models](https://docs.typesafe.ai/models.md)).

The response's `model` field reports the versioned id that answered, and this
package passes it through (`packages/core/src/provider/live.ts:557`), so log it
if any threshold depends on the numbers. If you have tuned a threshold against a
specific version, pin that version's id instead of the alias; upstream accepts a
versioned id whether or not `models.list()` returns it, and that list currently
contains the aliases.

This project's own live figures are point-in-time observations, not ongoing
calibration. `packages/core/scripts/probe-live.mjs` builds ten claim/evidence
pairs, repeats one question six times, and sends one noul with a boundary
(its header comment, lines 1-26); it needs a key and does not run in CI
(`PUBLISHING.md:214-216`), and two separate runs agreed on those numbers
(`PUBLISHING.md:234-244`). Nothing re-measures them when the alias moves, so read
them as "what one version said, twice", not as a property of `jev-latest`.

---

## 6. Egress: the disclosure lives elsewhere, and the one path that could undo it

This page does not restate the caps. The per-feature declaration of what can
leave, with a character cap per field, is `EGRESS_FIELDS`
(`packages/core/src/egress.ts:50-95`); a feature that is not switched on throws
rather than transmitting (`EgressDeniedError`, `egress.ts:157-166`); and the
startup report prints the effective caps, so what it says is what is enforced
(`egress.ts:341-375`). The prose self-description is the "egress contract"
section of [packages/dsh/README.md](../packages/dsh/README.md). Every provider
call goes through that one measurement path
(`packages/core/src/service.ts:238-248`).

One limit of that promise is worth stating anyway, because it is invisible from
the report. The SDK prints request bodies verbatim at `debug`, and only the
headers pass through its redaction (`@typesafe-ai/sdk@0.6.0`,
`dist/index.mjs:597-598`; its own type documentation says "`info` logs request
summaries; `debug` adds headers and bodies. Known credential headers are
redacted; bodies are not", `dist/index.d.mts:210-215`). A body is exactly what
this package redacts before sending, so this is the one SDK setting that can put
the state into a log after redaction removed it.

Three things stand between that and your log:

- The provider always passes a log level explicitly, so `TYPESAFE_LOG_LEVEL`
  cannot raise it (`packages/core/src/provider/live.ts:98-104` and `:352-366`).
- `debug` is clamped to `info` for every caller that has not opted in:
  `sdkLogLevelFor` maps `debug` to `BODY_SAFE_LOG_LEVEL` unless the caller passes
  `allowSdkBodyLogging: true` (`live.ts:110-159`), which is a provider option
  (`live.ts:182-199`) and not a configuration key (`config.ts:121-186`).
- The DSH plugin passes neither, so its own `logLevel` setting cannot reach body
  logging (`packages/dsh/src/index.ts:232-246`).

The consequence to keep in mind is the shape of the remaining exposure: it is
opt-in, one provider option away, and named after the consequence rather than the
log level precisely so that nobody enables it by accident.

---

## 7. What is not measured

- **Your account's quota, rate limits, and entitlement.** Nothing in this
  repository exercises them. Upstream documents 250,000 tokens/second and 1,200
  requests/minute for Jev 1.13 and says those limits are adjusting dynamically
  ([Models](https://docs.typesafe.ai/models.md)); the request budget is 64k
  tokens, of which 32k is `state` plus the longest question. This package
  classifies a 429 as `rate-limited` and a 402 as `quota-exceeded`
  (`packages/core/src/provider/classify.ts:167-178`), which tells you what
  happened, not what your plan allows.
- **The live numbers in this repository come from a small constructed sample.**
  Ten claim/evidence pairs, one question repeated six times, one boundary check,
  two runs that agreed (`PUBLISHING.md:234-244`). No real workload, no long run,
  no adversarial input.
- **Redaction is pattern-based.** It removes named fields and known secret shapes
  (`packages/core/src/redact.ts:67-118`); a secret whose shape it does not know
  survives it. The startup report says this in its own words
  (`egress.ts:370-374`).
- **Gate behaviour on live traffic.** The suite is credential-free by design and
  runs in CI (`PUBLISHING.md:209-212`), while the only live-route checks are
  manual probes that do not (`PUBLISHING.md:214-216`). So a gate decision in a
  test comes from the deterministic mock, and no live end-to-end gate run is
  recorded here.
- **Cost, as above.** On the TypeSafe route the reported total is zero because
  the response carries no cost, so nothing here can tell you what a run spent.

For what happens to a gate's `ask` when the deployment cannot ask anyone, see
[approval.md](./approval.md).
