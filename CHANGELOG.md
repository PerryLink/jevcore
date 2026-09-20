# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Fixed

- **`jevcore-dsh` declared its `@deepseek-ai/dsh-tools` peer dependency without
  an upper bound** (`>=0.1.0`). A future `0.2.0` would therefore have been
  accepted even though it is free to break the plugin API. It now uses the range
  the rest of this author's DSH plugins were verified against:
  `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0`.

  `@deepseek-ai/cordis` was raised from `^4.0.0` to `^4.0.2` to match the version
  the plugin is actually compiled and tested against.

  Worth knowing when reading that range: it deliberately excludes `0.0.1-rc.1`.
  npm's `latest` tag for `@deepseek-ai/dsh-tools` points at that version, which is
  older than everything the plugin needs, while the versions in use carry the
  `next` and `alpha` tags. The peer is optional and DSH supplies it at runtime, so
  this does not affect installation — but it does mean explicitly asking npm to
  install `@deepseek-ai/dsh-tools` alongside the plugin fails, and that is npm's
  tag to fix, not this package's.

## 0.1.0 — 2026-09-20

Initial release. Pre-1.0, so the API may change between minor versions.

Published to npm as `jevcore`, `jevcore-dsh` and `jevcore-mcp`. Repository at
<https://github.com/PerryLink/jevcore>, mirrored to
<https://gitee.com/perrylink/jevcore>.

### Changed

- **Renamed the packages and the brand twice before the first publish**, settling
  on the `jevcore` family. Only the final state is usable, but the intermediate
  step is recorded because it is the more useful lesson:

  | Was | Now | Role |
  |---|---|---|
  | `@dsh-jev/core` | `jevcore` | framework-agnostic core |
  | `@dsh-jev/plugin` | `jevcore-dsh` | the DeepSeek Harness plugin |
  | `@dsh-jev/mcp` | `jevcore-mcp` | the MCP server |

  The `@dsh-jev` scope was dropped first, because two of the three packages are
  **not** DSH-specific: a Claude Desktop user looking for a Jev MCP server would
  have read `@dsh-jev/mcp` as "not for me", and the same went for anyone writing
  a plain script against `@dsh-jev/core`. Only the DSH adapter is DSH-specific,
  and now only its name says so. Both adapters depend on the root name, so the
  dependency direction is readable from the names alone.

  The intended unscoped name was `jevkit`, and npm refused it outright:

  ```
  403 Forbidden - Package name too similar to existing package jev-kit
  ```

  `npm view jevkit` returned 404 right up to that moment, which is the trap: a
  free name is not a publishable one, and npm's similarity rule is
  [undocumented and cannot be queried in advance](https://github.com/orgs/community/discussions/205030).
  `jevkit` also turned out to collide on GitHub (`ariel-frischer/jevkit`). The
  replacement `jevcore` was verified free on npm, GitHub and Gitee before it was
  attempted, and as an unhyphenated word it sits further from any hyphenated
  neighbour than `jevkit` sat from `jev-kit`.

  The rename reached the runtime identifiers a user or host can see, not just the
  manifests: the Cordis plugin name (`jevcore`), the MCP server name and `bin`
  command (`jevcore-mcp`), the `Config` Standard Schema `vendor` field, the
  startup egress prefix (`[jevcore]`), and the config and gate error messages.

  Unscoped family names have to be claimed individually — npm registers ownership
  of a scope, not a name prefix — so all three names were confirmed free before
  the rename.

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

- **`jevcore`** — framework-agnostic decision layer.
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
- **`jevcore-dsh`** — the DeepSeek Harness plugin.
  - `ctx.jev`, a first-class service other plugins can call with no model turn
    in between.
  - Three model-visible tools: `jev_ask`, `jev_rank`, `jev_check`.
  - `Config` implemented as a Standard Schema, which Cordis requires before a
    plugin starts.
  - Startup egress report on one line per feature.
- **`jevcore-mcp`** — the same three tools over MCP, with a stdio binary that
  writes its egress report to stderr so the protocol channel stays clean.

### Fixed

- **`score` criteria were sent in the wrong shape, and score answers were read
  in the wrong shape.** Both are corrected against the vendors' own type
  definitions rather than by observation.

  A `score` question declares an ordered rubric. TypeSafe types it
  `ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]]` and OpenRouter
  types it `Array<...>` — an **array**, indexed by score from zero. This project
  sent a keyed map, the shape `choice` uses, so a score question was malformed on
  both routes. `score()` now converts its level map to the ordered array in the
  order written (validating that at least two levels carry a description) and
  refuses integer-like level names, which `Object.keys` would reorder ahead of
  the rest.

  A score answer carries an expected score that may fall *between* levels, plus
  the rubric it was scored against: `{ score, confidence, legend, probabilities }`,
  with `legend` mapping each index to its description and `probabilities` keyed by
  the same indices. This project read it as a choice answer (`choice` naming a
  level plus probabilities keyed by name), so a real score answer parsed to
  nothing useful. There is now a distinct `ScoreAnswer` in the `JevAnswer` union,
  and the mock, both live routes, the renderer and the policy all handle it.

- **OpenRouter usage spelling.** The vendor's wire schema requires snake_case
  `input_tokens` / `output_tokens`, while its TypeScript type declares camelCase
  `inputTokens` / `outputTokens` and its `fromJSON` remaps one to the other.
  Reading the wrong spelling does not throw; it reports no usage at all. Both are
  now read, on both routes.

- **Build output had been committed into `src/`.** An inherited relative `outDir`
  once resolved against the config file that declared it and emitted 16 `.d.ts`
  files beside their sources, where they were committed and then silently went
  stale. They are removed and `.gitignore` now covers that path, so the same
  misconfiguration cannot be committed again.

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

- Added `packages/core/test/vendor-conformance.test.ts` — pins this project's
  question and answer shapes against **both** vendors' own type definitions, so a
  drift on either side is a compile error rather than a malformed request on the
  one route that costs money and transmits data.
- Added `packages/core/scripts/check-openrouter-schemas.mjs` — parses the payloads
  this project actually builds against OpenRouter's real zod schemas, in both
  directions, including a negative check that a keyed score map is rejected. It
  runs offline with no credential and is wired into CI. **It is what found the
  `score` defect**: the stubbed unit tests passed the whole time, because a stub
  accepts whatever it is handed.
- Added `packages/core/test/contracts.test.ts` — 20 tests pinning the public
  identifiers that bind the pieces together: the egress feature constants, the
  verdict question ids, the gate question sets, and the render helpers. A wrong
  feature constant (for example `SAFETY_FEATURE` naming a tool switch) compiles
  cleanly and would silently disable a tool whenever the gate was enabled;
  nothing caught that before.

### Notes

- **Verified against the live OpenRouter route.** `scripts/probe-openrouter-live.mjs`
  drives the provider and `packages/mcp/scripts/mcp-smoke-live.mjs` drives the
  whole MCP surface — transport, tool schemas, service, provider — against real
  System One models. Both need `OPENROUTER_API_KEY` and are excluded from CI; the
  suite stays offline. The live answers confirmed the shapes above: a score came
  back as `score: 1.05` with a four-level `legend` and index-keyed
  probabilities, and usage arrived as `inputTokens` / `outputTokens` / `cost`.
- **Not verified against the live TypeSafe API.** No TypeSafe credential was
  available. `LiveProvider` is covered against an injected stub and against the
  vendor's own type definitions, which is a weaker guarantee than a real call:
  the question shape is now known-correct, but the account-level behaviour
  (rate limits, quota, model entitlements) is untested. The two routes accept the
  same primitives, so a TypeSafe key is expected to work unchanged — expected,
  not observed.
