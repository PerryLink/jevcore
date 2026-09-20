# jevcore

TypeSafe [Jev](https://typesafe.ai) decisions, with no framework attached.

This package imports nothing from DeepSeek Harness, Cordis, or any plugin runtime.
It is usable from a plain Node script, an MCP server, a CLI, or an agent-harness
adapter — which is why the adapters in this repository are thin layers over it
rather than the other way around.

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`,
`score` — and returns calibrated probabilities. It does not write prose.

**Offline by default. Egress disclosed. Nothing default-on.**

## Install

```sh
npm install jevcore
```

`@typesafe-ai/sdk` is an optional dependency. Without it the package still works
in full against the offline mock; only `provider: live` needs it, and it is
imported lazily.

## The two ideas worth knowing

### The egress contract

`EgressContract` is the single place that decides what may leave the machine.

Every feature that can transmit declares the fields it sends and the cap on each.
No feature transmits unless it is switched on. Nothing reaches a provider without
passing through it, and the contract can describe itself:

```ts
import { EgressContract } from 'jevcore'

for (const line of contract.reportLines()) console.log(line)
// [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

Redaction runs before the measurement, so the sizes reported are the sizes that
actually leave. Its limit is documented rather than hidden: it removes values
under recognisable field names and strings matching known secret shapes, and it
**will not** catch an unrecognised secret in free text.

### A probability is not a permission

`applyPolicy` turns Jev's numbers into `allow` / `ask` / `deny` against thresholds
that live in your configuration, never in model output.

```ts
import { applyPolicy, DEFAULT_POLICY } from 'jevcore'

const verdict = applyPolicy(answer, ['low', 'medium', 'high'], {
  ...DEFAULT_POLICY,
  accept: { low: true, medium: false, high: false },
})
// decided | undecided | invalid
```

An answer naming a value outside the criteria you declared is `invalid`, not
trusted: the guarantee of a typed decision model is that it cannot return an
undeclared value, so a violation means something upstream is wrong.

An `undecided` verdict is not an `allow`. A gate that defaults to permitting when
it is unsure is not a gate.

## What is in here

| Area | Exports |
|---|---|
| Primitives | `noul`, `choice`, `score`, `assertValidBatch`, `topCriterion` |
| Providers | `MockProvider`, `LiveProvider`, `assertUsableEndpoint` |
| Egress | `EgressContract`, `EGRESS_FEATURES`, `EGRESS_FIELDS`, `EgressDeniedError` |
| Redaction | `redact`, `DEFAULT_KEY_RULES`, `DEFAULT_VALUE_RULES` |
| Policy | `applyPolicy`, `verdictToAction`, `DEFAULT_POLICY` |
| Verification | `resolveCheck`, `VERDICT_QUESTION`, `DEFAULT_CHECK_THRESHOLDS` |
| Service | `JevService` |
| Gates | `createSafetyGate`, `createContextGate` |
| Config | `resolveConfig`, `Config`, `DEFAULT_CONFIG` |
| Credentials | `resolveApiKey`, `describeKeySource` |

The gates are framework-agnostic: they take a plain input — a tool name and its
arguments, or a result's content — and return a decision. Wiring them to a
particular event is the adapter's job.

## The mock provider

Deterministic and offline: every answer is derived from a hash of the question
and state, so tests can assert exact values and no socket is opened. Synthetic
results are labelled in three places — `provider: "mock"`, a `mock/jev-synthetic`
model name, and a `warning` field. A mock that could be mistaken for a real
judgment would be worse than no mock at all.

What it varies is narrower than that sounds, and one input it never reads is the question's
`instructions` text: the hash covers the question's id and the request's state alone. Two
differently-worded questions with the same id over the same state therefore get the same answer, so
the mock cannot tell you whether a prompt is worded well. The declared criteria do not enter the hash
either, though they still shape the answer: a `choice` answer spreads its weights across the labels
you declared, and a `score` answer across the number of levels. Both report a fixed confidence of 0.5.
[docs/limits.md](docs/limits.md) lists the rest of what the offline path does not model.

## Development

```sh
pnpm install
pnpm run check
```

No test requires a credential or a network connection.

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, and
System One are trademarks of TypeSafe AI; this is an independent integration and
is not affiliated with or endorsed by them.
