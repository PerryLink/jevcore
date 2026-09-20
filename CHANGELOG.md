# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — unreleased

Initial implementation. Pre-1.0, so the API may change between minor versions.

### Added

- **An OpenRouter route to the same models.** OpenRouter hosts the System One
  models behind its own Decisions route (`POST /api/alpha/decisions`), taking the
  same `noul` / `choice` / `score` primitives plus a `model` field. Setting
  `provider: openrouter` reaches Jev through it, which matters when a TypeSafe
  key is impractical and an OpenRouter key is already in hand.

  It is a distinct route, not an alias: state goes to OpenRouter rather than
  TypeSafe, so the startup report names that endpoint instead of leaving the
  destination implied by the provider's name. The route is `alpha` in
  OpenRouter's own SDK, so the shape may change. A model id without the
  `typesafe/` prefix is refused before the call, because any other model answers
  with prose this plugin cannot interpret as a decision.

- **`@dsh-jev/core`** — framework-agnostic decision layer.
  - The three System One primitives (`noul`, `choice`, `score`) with validation.
  - `MockProvider`, deterministic and offline, which labels every answer as
    synthetic in three places so it cannot be mistaken for a real judgment.
  - `LiveProvider` over the official `@typesafe-ai/sdk`, loaded lazily, refusing
    a non-HTTPS endpoint outside loopback.
  - The egress contract: per-feature switches, declared fields and caps, a
    measure-before-send path, and a human-readable self-report.
  - Redaction with key-name rules and value-pattern rules, plus a documented
    statement of what it cannot do.
  - Local decision policy: thresholds in configuration, a confidence floor, and
    an answer naming an undeclared criterion treated as invalid rather than
    trusted.
  - Two gates: a safety gate on `tools/pre-execute` and a context gate on
    `tools/post-execute`, both framework-agnostic and both off by default.
- **`@dsh-jev/plugin`** — the DeepSeek Harness plugin.
  - `ctx.jev`, a first-class service other plugins can call with no model turn
    in between.
  - Three model-visible tools: `jev_ask`, `jev_rank`, `jev_check`.
  - `Config` implemented as a Standard Schema, which Cordis requires before a
    plugin starts.
  - Startup egress report on one line per feature.
- **`@dsh-jev/mcp`** — the same three tools over MCP, with a stdio binary that
  writes its egress report to stderr so the protocol channel stays clean.

### Fixed

- **The safety gate ignored a raised `minProbability`.** It built its policy from
  the configured floors and then `decide` re-tested the probability against a
  hardcoded `?? 0.6`, so an operator asking for 0.9 still had a 0.8 hazard
  flagged as raised. The gates now resolve their thresholds once and `decide`
  trusts `applyPolicy`, which already enforces both floors.
- **`maxStateChars` was parsed, typed and documented but never read**, so a
  configured limit bounded nothing. This is the exact defect this project exists
  to avoid in other plugins — a documented config key that silently does not
  apply — and it was present here. The operator's cap now reaches the egress
  contract, bounds what is actually measured, and is shown in the startup report
  in place of the declared value. `0` still means "keep the declared cap".
- `rankingSize` threw on `undefined` and other non-object input, from a
  presentation callback where an exception breaks the tool card rather than
  merely displaying a wrong number. It now returns `0` for anything that is not
  a rank payload.
- `summarize` decided whether to mark a result as synthetic from the provider
  name (`provider === 'mock'`). It now keys off the `warning` field the provider
  actually set, so a result labelled synthetic is displayed as synthetic
  regardless of which provider produced it.

### Tests

- Added `packages/core/test/contracts.test.ts` — 20 tests pinning the public
  identifiers that bind the pieces together: the egress feature constants, the
  verdict question ids, the gate question sets, and the render helpers. A wrong
  feature constant (for example `SAFETY_FEATURE` naming a tool switch) compiles
  cleanly and would silently disable a tool whenever the gate was enabled;
  nothing caught that before.

### Notes

- Nothing is verified against the live TypeSafe API yet. `LiveProvider` is
  covered only against an injected stub. See the README's status section.
