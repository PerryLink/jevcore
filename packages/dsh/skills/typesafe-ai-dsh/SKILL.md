---
name: typesafe-ai-dsh
description: Use TypeSafe Jev for narrow judgments inside DeepSeek Harness — routing, classifying, scoring, verifying, reranking — instead of spending a model turn on them. Load this when a task turns on a decision with a small, fixed set of outcomes, or when you need a calibrated probability rather than prose.
---

# Jev in DeepSeek Harness

Jev is a System One decision model. It does not write prose, explain, or generate
code. It answers typed questions and returns calibrated probabilities.

That constraint is the whole point: a judgment with a small, fixed answer set does
not need a model turn, and paying for one is the most common waste in an agent
loop.

## When to reach for it

Use Jev when **all** of these hold:

- the outcome is one of a small set you can name in advance;
- you need a probability, a ranking, or a yes/no, not text;
- you will branch on the answer in code.

Typical shapes: which of these N tools is relevant; is this result relevant to the
task; does this evidence support this claim; which team owns this ticket; how
risky is this operation; which of these two sources is more authoritative.

Do **not** use it to summarize, explain, draft, translate, or reason
step-by-step. Those need a generative model, and Jev will return a selection where
you wanted a sentence.

## The three primitives

| Primitive | Answers | Returns |
|---|---|---|
| `noul` | yes/no | probability of true |
| `choice` | one of a named set | the selection plus a distribution |
| `score` | where on an ordered scale | a numeric expected score, the rubric as `legend`, and probabilities per level |

Declare `score` levels in ascending order, because the order written *is* the
scale, and give each level a description. The score that comes back may fall
between levels — `1.4` on a three-level rubric is a real answer, not a bug — so
read `legend` to name the level rather than assuming an integer.

**Reference the part of the state you are asking about by path, in backticks.**
When `state` is an object, a question about one field should name that field:
"Does \`ticket.messages[0].text\` request a refund?", not "does this request a
refund?". Dot-and-index paths with the backticks are what upstream prescribes,
and the model then knows which part of the state to judge
([Primitives](https://docs.typesafe.ai/primitives.md), "Reference specific
fields"). `jev_rank` builds its per-candidate questions this way already.

**Make `choice` options contrastive: give every option the same sub-keys.** An
option description may be structured, and describing each option with the *same*
labels — what it covers, what it does not, an example — sharpens the boundary
between options instead of leaving the model to infer it. Upstream's worked
example uses `what` / `not_for` / `examples` on every option for exactly that
reason ([Advanced: structure](https://docs.typesafe.ai/primitives/advanced.md),
"JSON rubric for boundary clarification"). Through these tools each option's
description is a single string, so spell the same labels out inside each one.

**A `noul` with an unstated boundary is one whose 0.5 cannot be interpreted.**
Say what yes means and what no means whenever the line between them is not
obvious — including what silence in the evidence does *not* count as (the
`jev_ask` schema names the field the boundary belongs in). Upstream defines every
hazard in its guardrail recipe this way, and the same page shows structured
`true`/`false` descriptions for a subtle boundary
([Advanced: structure](https://docs.typesafe.ai/primitives/advanced.md),
"Structured Noul criteria").

Batch related questions into one call: they are answered against the same state in
a single round-trip, which is where most of the cost saving comes from. Ask
questions you might not need, too — an extra question costs tokens, not time, and
code can ignore the answers it does not use. Upstream measures 13 questions in one
call at `11.5x` cheaper and `9.6x` faster than 13 calls, with no change in the
answers ([Primitives](https://docs.typesafe.ai/primitives.md), "Ask multiple
questions together"). Two requests are the exception: ask again only when the
first answer is needed to fetch evidence, build new state, or choose the next
question's options.

## Two rules that prevent the common mistakes

**A probability is not a permission.** Jev tells you how likely something is; it
does not decide what to do about it. Apply your own threshold. When the answer is
below it, the outcome is "unknown" — not "allow". A gate that defaults to allow
when it is unsure is not a gate.

**Nothing runs on every tool call unless you asked for it.** A decision layer that
inspects every tool call or every tool result transmits content off the machine by
default, and it runs far more often than you expect. Enable that deliberately, and
prefer a threshold that skips small inputs entirely.

## Working with the answer

- `confidence` is a concentration statistic over the answer's own probability
  distribution — how peaked it is, from 0 to 1 — not a measure of whether the
  answer is true, and not this project's own calibration. Upstream says you are
  never locked into its definition and hands you the full `probabilities` for
  that reason. **A `noul` answer has no `confidence` at all**: a two-outcome
  answer has no distribution for a concentration statistic to summarise, so read
  the probability itself.
- A `score` answer's number may fall *between* levels. Read `legend` to name the
  level instead of rounding, and read `probabilities` when the shape of the
  distribution is what you are acting on.
- An answer naming a value outside the criteria you declared means something
  upstream is wrong. Treat it as a failure, not as a decision.
- Independent per-candidate judgments (ranking) do not sum to 1. Do not normalize
  them and do not read them as shares.
- If Jev is unreachable, surface that. Do not substitute a default and continue as
  though the judgment happened.

## Cost shape

Input is billed per token; output is free. So `state` size is the entire cost
model. Send the evidence the question is about, not the transcript that produced
it — and remember that `state` leaves your machine, so redact before you send.

## In this plugin

Three tools are available: `jev_ask` for a batch of typed questions, `jev_rank` to
order candidates against one criterion, and `jev_check` to test a claim against
evidence. The same judgments are reachable from code through `ctx.jev` with no
model turn at all — prefer that when the decision is already being made in code.

Choose by the shape of the answer you need:

- **`jev_ask`** — you can state the question and the possible answers. Routing,
  classifying, scoring, verifying a field. Start here: it is the general tool, and
  the other two are conveniences for shapes that come up often.
- **`jev_rank`** — the answer is an ordering over a list longer than a handful:
  search hits, a triage backlog, which file to read first. One question per
  candidate, all in one round-trip. The per-candidate probabilities are
  independent judgments, not a distribution: `0.5` is not "half the total
  relevance", and a flat set of scores means nothing stands out rather than
  forming a fine-grained order.
- **`jev_check`** — you have a specific claim and the evidence for it, and "not
  supported" and "contradicted" would send you to different actions. It judges
  only the evidence you hand it: it cannot search for more, and it cannot tell
  that you omitted the decisive passage.

Do not reach for any of them to summarize, explain, draft, or translate — or for
an open-ended "look at this and tell me what to do". That last one is a slow
judgment in a decision's clothing; either split it into questions whose answers
your code combines, or keep it in the model.

Every result names its provider. If it says `mock`, the answers are synthetic and
carry no judgment; do not act on them. Check `provider`, not `model`: the model
name can read like a real one while the answers are still synthetic.
