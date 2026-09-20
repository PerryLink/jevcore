# Quickstart: from zero to a decision, offline

`jevcore@0.2.2` has 69 runtime exports. This page uses six of them to get from an
empty directory to a decision your code can branch on, with no API key, no network
call, and no TypeSafe account.

Every command and every output on this page was executed against
`jevcore@0.2.2` from npm on Node 22.22.3, Windows. Anything stated from source
rather than from a run is labelled.

---

## 0. What you need

- **Node.js 20 or newer.** `packages/core/package.json` declares
  `"engines": { "node": ">=20" }`.
- The package:

  ```sh
  npm install jevcore
  ```

`@typesafe-ai/sdk` is an *optional* dependency. Everything below runs without it;
only the live route needs it.

---

## 1. Build a client

Two useful facts about this library before the first line: a provider is
injectable, and nothing may reach a provider without passing an egress contract.
So a client is a provider plus a contract. Offline, that is `MockProvider` plus a
contract that denies everything except the feature you are calling.

```js
// jev.mjs — one client, no credential, no network.
import { EgressContract, JevService, MockProvider } from 'jevcore'

export const egress = new EgressContract(
  {
    transmitting: false, // the mock cannot reach the network
    enabled: {
      'tool:jev_ask': true,
      'tool:jev_rank': false,
      'tool:jev_check': false,
      'gate:safety': false,
      'gate:context': false,
    },
  },
  'none',
)

export const jev = new JevService({ provider: new MockProvider(), egress, transmitting: false })

if (process.argv[1]?.endsWith('jev.mjs') === true) {
  console.log(egress.reportLines().join('\n'))
}
```

```console
$ node jev.mjs
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

That report is the contract describing itself: `egress=OFF` because
`transmitting` is false, and `armed tool:jev_ask` because that one feature is
switched on. A feature that is not switched on throws rather than transmitting —
this is the same `jev` client, asked for a feature the contract denies:

```js
import { JevProviderError } from 'jevcore'
import { jev } from './jev.mjs'

try {
  await jev.ask({
    feature: 'tool:jev_check',
    state: { claim: 'x', evidence: 'y' },
    questions: {
      supports_claim: { type: 'noul', instructions: 'Does `evidence` support `claim`?' },
    },
  })
} catch (error) {
  console.log(error instanceof JevProviderError, error.constructor.name, error.message)
}
```

```console
false EgressDeniedError egress for "tool:jev_check" is not enabled. This feature would send content to a third party. Enable it in the plugin config if that is what you want.
```

Note `false` for `instanceof JevProviderError`: a denied call is a *contract*
refusal, not a provider failure, and it never reaches a provider. The check lives
in `EgressContract.measure` → `assert`.

---

## 2. One `noul`: a probability, then an action

A `noul` is a yes/no question. The answer is the probability of **true**.

```js
// decide.mjs — probabilities in, an action out.
import { answerOf, applyPolicy, noul, verdictToAction } from 'jevcore'
import { jev } from './jev.mjs'

const questions = {
  refund_requested: noul('Does `ticket` request a refund?', {
    true: 'The message asks for money back.',
    false: 'The message does not ask for money back.',
  }),
}
const accept = { true: true, false: false }

for (const ticket of [
  'Where is my package?',
  'I was charged twice for order A-104. Please refund the duplicate.',
]) {
  const result = await jev.ask({ feature: 'tool:jev_ask', state: { ticket }, questions })
  const answer = answerOf(result, 'refund_requested')
  const verdict = applyPolicy(answer, ['true', 'false'])
  console.log(ticket)
  console.log('  provider:', result.provider, '| noul:', answer.noul)
  console.log('  verdict:', verdict)
  console.log('  action:', verdictToAction(verdict, { accept }))
}
```

```console
$ node decide.mjs
Where is my package?
  provider: mock | noul: 0.95
  verdict: { kind: 'decided', answer: 'true', probability: 0.95 }
  action: allow
I was charged twice for order A-104. Please refund the duplicate.
  provider: mock | noul: 0.548
  verdict: { kind: 'undecided', reason: 'below-confidence' }
  action: ask
```

Three things happened there, and each is a rule:

- **`noul` is P(true), not a verdict.** `0.548` means the model gives "yes" a
  slightly better than even chance. The strength of a noul answer is
  `max(noul, 1 - noul)` — here `0.548`.
- **`applyPolicy` applies *your* floors, not the model's opinion.** With the
  default policy (`minConfidence: 0.7`, `minProbability: 0.6`), `0.548` is below
  the floor, so the verdict is `undecided` — never a default `allow`.
- **`verdictToAction` maps the verdict to `allow` / `deny` / `ask`.** `accept`
  says which criteria are actionable at all; a criterion absent from `accept`
  yields `ask`.

The three verdict kinds are `decided`, `undecided` (reason `below-confidence` or
`no-answer`), and `invalid` (the answer named a value outside the criteria you
declared). `invalid` maps to `deny`: a typed decision model cannot return an
undeclared value, so a violation means something upstream is wrong.

### The mock is synthetic, and it says so

`0.95` for *"Where is my package?"* is not a judgment — the mock hashes the
question id and the state and returns the hash as a probability. Rename the
question id and the number changes. That is on purpose, and it is why every
result names its provider:

```js
result.provider // 'mock'
result.model    // 'mock/jev-synthetic' — when the caller names no model
```

Every mock answer is deterministic: the same state and question id always give
the same number, so you can assert on it in tests. Do not read it as a view about
the world.

---

## 3. `choice`: one of a named set

```js
// choice.mjs — pick one of a named set.
import { applyPolicy, answerOf, choice, verdictToAction } from 'jevcore'
import { jev } from './jev.mjs'

const result = await jev.ask({
  feature: 'tool:jev_ask',
  state: { ticket: 'The API returns 500 on every request.' },
  questions: {
    team: choice('Which team should handle `ticket`?', {
      technical: 'Bugs, outages, integrations',
      billing: 'Charges, invoices, refunds',
    }),
  },
})

const answer = answerOf(result, 'team')
console.log('answer:', JSON.stringify(answer))

// The floors the default policy applies to a choice answer.
const policy = { minConfidence: 0.4, minProbability: 0.5, accept: { billing: true } }
const verdict = applyPolicy(answer, ['technical', 'billing'], policy)
console.log('verdict:', JSON.stringify(verdict))
console.log('action:', verdictToAction(verdict, policy))

// An answer naming a value outside the criteria you declared is refused, not trusted.
const outside = applyPolicy(answer, ['technical'], { minConfidence: 0.4, minProbability: 0.5 })
console.log('outside the declared criteria:', JSON.stringify(outside))
console.log('action:', verdictToAction(outside))
```

```console
$ node choice.mjs
answer: {"type":"choice","choice":"billing","probabilities":{"technical":0.137,"billing":0.863},"confidence":0.5}
verdict: {"kind":"decided","answer":"billing","probability":0.863}
action: allow
outside the declared criteria: {"kind":"invalid","reason":"answer \"billing\" is not one of the declared criteria"}
action: deny
```

Two notes that save time later:

- **The keys of `criteria` are the permitted answers.** Declare exactly the
  outcomes you can act on; a key you declare is a value Jev may return.
- **`minConfidence` is why the defaults look strict.** A choice answer carries a
  `confidence`, and the default floor for it is `0.7`. The mock reports a fixed
  `0.5`, so *every* mock choice or score answer is `undecided` under the default
  policy. That is the mock being honest about having no basis for confidence, not
  a bug — lower `minConfidence` deliberately when you are exercising the offline
  path, as above, and leave it where it belongs in production.

Per-criterion floors are available when one outcome is riskier than another:
`thresholds: { billing: { minProbability: 0.95 } }` applies to the *selected*
criterion only.

---

## 4. `score`: the array position **is** the score

A `score` question places the state on an ordered scale. The order you write the
levels in is the scale: the first level is score `0`, the last is score `n-1`.

```js
// score.mjs — a position on an ordered scale: array position IS the score.
import { applyPolicy, answerOf, score, scoreCriteriaArray, assertValidBatch } from 'jevcore'
import { jev } from './jev.mjs'

const levels = {
  low: 'Read-only, or trivially reversible',
  medium: 'Recoverable with effort',
  high: 'Irreversible destruction of data',
}

// The level names are yours; only the descriptions go on the wire, in this order.
console.log(scoreCriteriaArray(levels))

const result = await jev.ask({
  feature: 'tool:jev_ask',
  state: { command: 'rm -rf /var/lib/data' },
  questions: { harm: score('How much harm would running `command` do?', levels) },
})

const answer = answerOf(result, 'harm')
console.log('score:', answer.score)
console.log('legend:', JSON.stringify(answer.legend))
console.log('probabilities:', JSON.stringify(answer.probabilities))
console.log('verdict:', JSON.stringify(applyPolicy(answer, [])))

// A level with no description is refused, because dropping it renumbers the scale.
try {
  scoreCriteriaArray({ low: 'a', medium: null, high: 'c' })
} catch (error) {
  console.log('undescribed level:', error.message.split('.')[0])
}

// The two-level minimum is checked by the batch validator the tools call, not by score().
try {
  assertValidBatch({ harm: score('How bad?', { only: 'one level' }) })
} catch (error) {
  console.log('one level:', error.message)
}
```

```console
$ node score.mjs
[
  'Read-only, or trivially reversible',
  'Recoverable with effort',
  'Irreversible destruction of data'
]
score: 0.9289
legend: {"0":"Read-only, or trivially reversible","1":"Recoverable with effort","2":"Irreversible destruction of data"}
probabilities: {"0":0.279,"1":0.5131,"2":0.2079}
verdict: {"kind":"undecided","reason":"below-confidence"}
undescribed level: score level(s) "medium" have no description
one level: question "harm" is a score but declares 1 described level(s). A scale needs at least two, because a one-level scale carries no ordering.
```

Reading that:

- **`0.9289` is between levels, and that is a real answer.** It sits between
  `low` (0) and `medium` (1). `legend` maps each index back to its description,
  so read the level from `legend`, not by rounding and not by assuming an
  integer. Under the mock the expected score is the probability-weighted mean of
  the levels — here `0*0.279 + 1*0.5131 + 2*0.2079 = 0.9289`.
- **Your level names never leave the process.** `scoreCriteriaArray` sends the
  descriptions only. Keep the names for your own code and use `legend` to map an
  index back to its description.
- **An undescribed level is an error, not something dropped.** Dropping one would
  renumber every level after it and silently change the meaning of every score.
  Use `''` to hold a position you do not want to describe.
- **Integer-like level names are rejected too**, because JavaScript reorders
  integer-like keys: `{ 0: 'a', 1: 'b', high: 'c' }` throws rather than producing
  a scale in an order you did not write. Name the levels.
- **`applyPolicy` on a score answer judges the rubric indices**, which is why the
  call above passes an empty criteria list: a score's distribution is over its
  levels, so its criteria are its own indices.

---

## 5. Batch, don't loop

Every question in one call is answered against the same `state` in one
round-trip. Adding questions costs tokens, not wall-clock time. The official
docs put a number on it: batching 13 questions into one call was measured at
`11.5x` cheaper and `9.6x` faster than 13 separate calls, with no change in the
answers ([Primitives → Ask multiple questions together](https://docs.typesafe.ai/primitives.md)).

```js
// batch.mjs — one call, three judgments.
import { choice, noul, score } from 'jevcore'
import { jev } from './jev.mjs'

const result = await jev.ask({
  feature: 'tool:jev_ask',
  state: { ticket: 'I was charged twice for order A-104.' },
  questions: {
    refund_requested: noul('Does `ticket` request a refund?'),
    team: choice('Which team should handle `ticket`?', { billing: 'Charges', technical: 'Bugs' }),
    urgency: score('How urgent is `ticket`?', {
      low: 'No time pressure',
      medium: 'Same-day',
      high: 'Blocking production',
    }),
  },
})

console.log(Object.keys(result.answers), '| provider:', result.provider, '| latencyMs:', result.latencyMs)
console.log(JSON.stringify(result.answers, null, 2))
```

```console
$ node batch.mjs
[ 'refund_requested', 'team', 'urgency' ] | provider: mock | latencyMs: 0
{
  "refund_requested": {
    "type": "noul",
    "noul": 0.8502
  },
  "team": {
    "type": "choice",
    "choice": "billing",
    "probabilities": { "billing": 0.7124, "technical": 0.2876 },
    "confidence": 0.5
  },
  "urgency": {
    "type": "score",
    "score": 1.1982,
    "legend": {
      "0": "No time pressure",
      "1": "Same-day",
      "2": "Blocking production"
    },
    "probabilities": { "0": 0.2341, "1": 0.3336, "2": 0.4323 },
    "confidence": 0.5
  }
}
```

(Formatted for readability; the run prints the full JSON on one line per key.)

`JevService.ask` does not validate the batch for you. `assertValidBatch` is the
local check the tools run before spending a call; call it yourself if you build
questions dynamically:

```js
assertValidBatch(questions) // throws on an empty instruction, a one-level score, >10 levels, …
```

---

## 6. Going live

Two routes reach the same models. Both change one line of the client above: the
provider.

### TypeSafe directly

```js
// live.mjs — same client, real answers. Needs a key and `npm install @typesafe-ai/sdk`.
import { egress } from './jev.mjs'
import { DEFAULT_CONFIG, JevProviderError, JevService, LiveProvider, resolveApiKey } from 'jevcore'

const access = await resolveApiKey({ ref: DEFAULT_CONFIG.apiKeyRef })
if (access === undefined) {
  console.log(`no ${DEFAULT_CONFIG.apiKeyRef} in this process: nothing was sent, stay on the mock`)
} else {
  const provider = new LiveProvider({ apiKey: access.value, model: DEFAULT_CONFIG.model })
  const jev = new JevService({
    provider,
    egress,
    transmitting: true,
    model: DEFAULT_CONFIG.model,
  })
  console.log('endpoint:', provider.endpoint, '| key from:', access.source)
  try {
    const result = await jev.ask({
      feature: 'tool:jev_ask',
      state: { ticket: 'Where is my package?' },
      questions: { refund_requested: { type: 'noul', instructions: 'Does `ticket` request a refund?' } },
    })
    console.log('provider:', result.provider, '| model:', result.model)
    console.log('answer:', JSON.stringify(result.answers.refund_requested))
  } catch (error) {
    if (error instanceof JevProviderError) console.log(error.code, '-', error.message)
    else throw error
  }
}
```

```console
$ node live.mjs
no TYPESAFE_API_KEY in this process: nothing was sent, stay on the mock
```

The credential names, defaults, and endpoints below are read from the current
source (`packages/core/src/config.ts`, `provider/live.ts`,
`provider/openrouter.ts`), not from memory:

| What | Value | Where it comes from |
|---|---|---|
| `provider` | `'mock'` by default | `DEFAULT_CONFIG.provider` |
| Credential reference, TypeSafe route | `apiKeyRef`, default `'TYPESAFE_API_KEY'` | `DEFAULT_CONFIG.apiKeyRef` |
| Credential reference, OpenRouter route | `openRouterApiKeyRef`, default `'OPENROUTER_API_KEY'` | `DEFAULT_CONFIG.openRouterApiKeyRef` |
| Model | `model`, default `'jev-latest'` | `DEFAULT_CONFIG.model` |
| TypeSafe API root | `'https://api.typesafe.ai'` | `DEFAULT_ENDPOINT` |
| OpenRouter API root | `'https://openrouter.ai/api'` (the client posts to `/v1/systemone` below it) | `DEFAULT_OPENROUTER_ENDPOINT` |

How a credential reference is resolved, in order: the DSH credential service when
one is composed, then the environment variable **of that same name**
(`credentials.ts` → `resolveApiKey`). The reference is a *name*; the key itself is
never written to configuration, never logged, and never returned from a tool. The
environment is read at call time, so a key exported into a running process is
picked up.

Three failure modes are worth knowing before you spend an afternoon on them:

- **No SDK installed.** `provider "live" needs the official SDK. Install it with
  ``npm install @typesafe-ai/sdk``, or keep the default mock provider.` with code
  `provider-unavailable`. Install the optional dependency for the route you use.
- **No credential.** `resolveApiKey` returns `undefined` rather than throwing, so
  decide what a missing key means at your own boundary — the guard in `live.mjs`
  above stays offline; the MCP server treats it as a startup error when you asked
  for `live` explicitly.
- **A non-HTTPS endpoint.** `baseURL` that is neither `https:` nor loopback
  `http:` is refused with code `provider-unavailable`, so a typo cannot ship your
  state in cleartext.

On the OpenRouter route the model id must be a System One one: a bare `jev-*`
(such as `jev-1.13`) or a `typesafe/`-prefixed one. Anything else is refused
before the call, because another model answers with prose this library cannot
read as a decision.

> **Not verified on this page.** No live call was made while writing it — there
> was no credential in the environment, so the *guard* path above is what ran.
> The live providers are covered by the repository's own tests against injected
> stubs, and the OpenRouter route was exercised against the real API by
> `pnpm --filter jevcore run probe:live` (see the package README's status
> section). Neither is a substitute for trying it with your own key.

---

## 7. What the library has that the three tools do not expose

`jev_ask`, `jev_rank`, and `jev_check` (in the DSH plugin and the MCP server)
are thin adapters over this package. Several capabilities are real, tested, and
*not reachable* from those tools — knowing which saves you from waiting for a
tool that will never carry them.

| Capability | Exports | Reachable from the three tools? |
|---|---|---|
| Composite scoring across several answers | `compositeScore`, `normalizeScore` | **No.** Library only; wire it into your own code |
| Local policy: probability → `allow`/`ask`/`deny` | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY`, `answerOf` | **No.** The tools return probabilities, not decisions, on purpose |
| Noul banding (`no` / `uncertain` / `yes`) | `noulBand`, `DEFAULT_NOUL_BAND` | **Partly.** The *functions* are library-only; `jev_ask` already reports the default band as `band` on a noul answer, and the bounds are not configurable there |
| The two gates | `createSafetyGate`, `createContextGate`, `isGated`, `HAZARD_QUESTIONS`, `CONTEXT_QUESTIONS` | **No.** The DSH plugin registers them as opt-in gates; no tool configures or calls them |
| Check thresholds | `resolveCheck`, `DEFAULT_CHECK_THRESHOLDS`, `VERDICT_QUESTION` | **Partly.** `jev_check` uses the default thresholds; changing them is a library call |
| Redaction rules | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` | **No.** They run inside every tool call and are not configurable from one |
| Egress contract | `EgressContract`, `EGRESS_FIELDS`, `EgressDeniedError` | **No.** The DSH plugin exposes one field of it (`maxStateChars`); the MCP server has no such key |
| Structured question text and structured option descriptions | `EntryType` (`noul`, `choice`, `score`) | **No, not fully.** The tool schemas declare `criteria` values as strings; the MCP server declares `instructions` as a string. Structure is a library feature |
| Batch several questions in one call | `JevService.ask`, `assertValidBatch` | **Yes** — this is the one worth using |
| Result rendering for a model | `renderResult`, `renderAnswer`, `summarize`, `asRendered`, `rankingSize` | Used by the tools; callable from your code too |

The tool schemas in your host are the authority for what that host accepts.

Two pages carry the boundaries this table only names:
[approval.md](./approval.md) for what a gate's `ask` becomes when the deployment
composes no approval service, and [limits.md](./limits.md) for the request
timing, cost accounting, ranking cap, and mock behaviour.

---

## 8. Next

- [docs/hosts.md](./hosts.md) — wiring the MCP server into six hosts, and the
  Windows spawn problem.
- [Primitives](https://docs.typesafe.ai/primitives.md) — when to use `noul` vs
  `choice` vs `score`, and how to reference state fields by path.
- [Confidence](https://docs.typesafe.ai/confidence.md) — what `confidence` is
  (a concentration statistic over the answer's own distribution), and why a noul
  does not carry one.
