# jevcore-mcp

TypeSafe [Jev](https://typesafe.ai) over the Model Context Protocol.

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`,
`score` — and returns calibrated probabilities. It does not write prose, and
asking it to is a category error. This server exposes exactly that surface.

**Offline by default. Egress disclosed. Nothing default-on.**

## Install

```sh
npx -y jevcore-mcp
```

Register it as a stdio MCP server with your host. For DeepSeek Harness, that is a
configuration-only bundle whose patch inserts the harness's MCP client:

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

## Configuration

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | Selects the TypeSafe route when present |
| `OPENROUTER_API_KEY` | Selects the OpenRouter route when present and no TypeSafe key is set |
| `JEV_PROVIDER` | `mock`, `live`, or `openrouter` — overrides the heuristic above |
| `TYPESAFE_MODEL` / `OPENROUTER_MODEL` | Model id for the selected route |
| `TYPESAFE_BASE_URL` / `OPENROUTER_BASE_URL` | API root for the selected route |

Two routes reach the same models. TypeSafe serves them directly; OpenRouter serves
the System One models at the same `POST /v1/systemone` path TypeSafe does, one
level below its own API root, which is the way in when a TypeSafe key is
impractical. They differ in whose servers see your state, so the startup report
names the endpoint rather than leaving it implied by the provider's name. On the
OpenRouter route the model id must be a System One one: bare `jev-latest` needs no
prefix, `typesafe/` is accepted on a versioned id such as `typesafe/jev-1.13`, and
`typesafe/jev-latest` is not accepted. Anything else answers with prose this
server cannot interpret as a decision.

Unlike a per-call adapter, this server resolves its credential **once at
startup** — it is a long-lived process and its credential does not change
mid-session. `JEV_PROVIDER=live` with no key is therefore a startup error with a
readable message, not a failure on the first tool call.

## The tools

| Tool | Purpose |
|---|---|
| `jev_ask` | One or more typed questions over one state; batch them into a single call |
| `jev_rank` | Score and sort candidates against one criterion, one question per candidate |
| `jev_check` | Does this evidence support this claim? `supported`, `contradicted`, `conflicted`, `insufficient`, `undecided`, or `unknown` |

Three tools, deliberately few and orthogonal. Two existing Jev MCP servers already
ship ten tools each; this one exists for the case where a host wants the three
primitives and nothing else, built on the same core as the DeepSeek Harness
plugin so the two cannot drift.

Every result carries probabilities, not decisions. Apply your own confidence
threshold before acting, and treat a low-confidence answer as unknown rather than
picking for it.

## The egress report

The server prints its contract to **stderr** on startup:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore]   armed  tool:jev_ask  (runs against the offline mock; would transmit if the provider became "live" or "openrouter")
```

Stderr, never stdout: on a stdio transport stdout is the protocol channel and a
stray line there would corrupt the stream.

Redaction runs before anything is sent. It is a mitigation, not a guarantee — an
unrecognised secret in free text will pass through. If that possibility is
unacceptable, do not set a key.

## Status

Tools, provider selection, and egress enforcement are covered by tests, and the
transport has been driven end to end by a real MCP client over stdio:

```sh
pnpm --filter jevcore-mcp run smoke        # offline, mock provider, no credential
pnpm --filter jevcore-mcp run smoke:live   # real answers, needs OPENROUTER_API_KEY
```

The offline run exercises the handshake, tool discovery, three successful calls,
and the error path for an invalid batch.

The live run drives the same surface against real System One models through
OpenRouter: all three tools answered, a three-primitive batch returned a `score`
of `1.08` on a three-level rubric with its legend intact, `jev_rank` ordered a
credential runbook above a billing guide, `jev_check` returned `contradicted`, and
the startup egress report named the OpenRouter endpoint on stderr without
disturbing the protocol channel.

**The TypeSafe route is exercised, but only lightly.** `packages/core/scripts/probe-live.mjs`
(`pnpm --filter jevcore run probe:typesafe`) asks the real API three things: ten claim/evidence
pairs whose verdict is known in advance, one question repeated six times, and a noul carrying a
`criteria: {true, false}` boundary. Two separate runs agreed — supporting evidence scored 0.95,
contradicting evidence 0.10, evidence silent about the claim 0.03, and the repeated question varied
by 0.01 or less. The boundary was accepted. What remains untested is everything around the request
rather than the request itself: quota, rate-limit and entitlement behaviour on a real account.

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, and
System One are trademarks of TypeSafe AI; this is an independent integration and
is not affiliated with or endorsed by them.
