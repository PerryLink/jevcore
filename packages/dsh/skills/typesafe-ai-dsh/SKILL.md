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

Batch related questions into one call: they are answered against the same state in
a single round-trip, which is where most of the cost saving comes from.

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

- `confidence` is Jev's own calibration. Treat it as a floor on trust, not as a
  substitute for a threshold.
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

Every result names its provider. If it says `mock`, the answers are synthetic and
carry no judgment; do not act on them.
