# @dsh-jev/mcp

TypeSafe [Jev](https://typesafe.ai) over the Model Context Protocol.

Jev is not a chat model. It answers typed questions — `noul` (yes/no), `choice`,
`score` — and returns calibrated probabilities. It does not write prose, and
asking it to is a category error. This server exposes exactly that surface.

**Offline by default. Egress disclosed. Nothing default-on.**

## Install

```sh
npx -y @dsh-jev/mcp
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
        args: ['-y', '@dsh-jev/mcp']
        failOnStartupError: true
```

## Configuration

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | Presence selects the live provider; absence keeps it offline |
| `JEV_PROVIDER` | `mock` or `live`, overriding the heuristic above |
| `TYPESAFE_MODEL` | Model name; defaults to `jev-latest` |
| `TYPESAFE_BASE_URL` | API root; defaults to `https://api.typesafe.ai` |

Unlike a per-call adapter, this server resolves its credential **once at
startup** — it is a long-lived process and its credential does not change
mid-session. `JEV_PROVIDER=live` with no key is therefore a startup error with a
readable message, not a failure on the first tool call.

## The tools

| Tool | Purpose |
|---|---|
| `jev_ask` | One or more typed questions over one state; batch them into a single call |
| `jev_rank` | Score and sort candidates against one criterion, one question per candidate |
| `jev_check` | Does this evidence support this claim? `supported`, `contradicted`, `conflicted`, `insufficient`, or `unknown` |

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
[dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[dsh-jev]   armed  tool:jev_ask  (runs against the offline mock; would transmit if provider became "live")
```

Stderr, never stdout: on a stdio transport stdout is the protocol channel and a
stray line there would corrupt the stream.

Redaction runs before anything is sent. It is a mitigation, not a guarantee — an
unrecognised secret in free text will pass through. If that possibility is
unacceptable, do not set a key.

## Status

Tools, provider selection, and egress enforcement are covered by tests, and the
transport has been driven end to end by a real MCP client over stdio:

`sh
pnpm --filter @dsh-jev/mcp run smoke
`

That exercises the handshake, tool discovery, three successful calls, and the
error path for an invalid batch. **The live provider has still only ever run
against an injected stub** — no real TypeSafe API call has been made.

## License

MIT. TypeSafe, Jev, and System One are trademarks of TypeSafe AI; this is an
independent integration and is not affiliated with or endorsed by them.
