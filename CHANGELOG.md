# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-09-20

A seven-angle audit of the three packages, with the findings fixed rather than
recorded. Two of them were already published, and they come first because they
are the reason this release exists. The minor-version bump is for the changed
timeout semantics and the widened error vocabulary, not for the fixes.

### Fixed

- **`jev_rank` did not work at all in `jevcore-dsh` 0.2.2.** Its tool card was
  built by calling `summarize(asRendered(value), …)`, and `summarize` reads
  `value.answers` — a ranking carries `ranking`. `asRendered` is an assertion,
  not a conversion, so every call threw, the registry turned the throw into
  `returned invalid output`, and the model received zero candidates. The
  expression is replaced by a summary written for a ranking, and the old one is
  kept as a test that asserts it throws, so it cannot be "simplified" back.

  All 410 tests passed while this shipped, because every one of them called
  `execute`, and the projection the registry runs on **every** top-level call had
  no coverage at all. `test/tools.test.ts` now calls
  `output.presentationMeta` for all three tools, and reverting the fix turns four
  of those tests red.

- **`npx -y jevcore-mcp` did not start.** `lib/bin.js` had no shebang, and npm's
  `cmd-shim` reads the first line to decide how to launch a bin: with no `#!` it
  calls the file directly, so the generated Windows shim had no `node` prefix and
  the `.js` went through its file association — a host that hangs with no output
  rather than a process that fails. Both READMEs advertise that command. The
  source now carries the shebang, the file carries its executable bit (which
  `tsc` inherits, so the artifact is executable too), and the smoke test asserts
  the shebang by byte and launches through a real shim instead of
  `node <entry>` — the substitution that let this ship.

- **`resolveCheck` failed open, and could contradict itself.** When the
  sufficiency question had no answer it returned `supported` on the strength of
  `supports` alone; and a payload whose `sufficient` was 0.9895 could still come
  back `insufficient`. Both were reproduced against the built library before the
  fix.

- **Every HTTP status collapsed into one error code, so nothing could tell
  "retry" from "give up".** `openrouter.ts`'s condition was a tautology — the
  final `status !== undefined` subsumes the two tests before it — and the
  `401 || 403` branch in the TypeSafe provider was dead code. Rate limiting, a
  rejected key, exhausted quota, a malformed request and a transport failure were
  indistinguishable. The original status now travels on the error.

- **The timeout bounded one attempt, not the call, and the default did not do
  what its own comment said it did.** The SDK's `timeout` is documented as
  per-attempt "without a total retry budget", so 30s across 3 attempts is ~90s of
  blocking — the number the comment existed to prevent. A total budget now bounds
  the call. `requestTimeoutMs: 0`, documented as "disables the timeout" and
  impossible under the SDK's own validation, is either honoured or refused
  explicitly instead of failing every call behind a network-shaped error.

- **The three tools silently opted out of the harness's parallel pool.**
  `isConcurrencySafe` was never declared, and the host reads undeclared as
  exclusive, so N independent judgments ran strictly in series against a pool
  that allows ten.

- **`noul` boundaries could not be reached from any tool.** The question builder
  called `noul(instructions)` and dropped the documented `criteria: {true,
  false}` boundary; the field's declared type was the choice/score map, so it
  could not have carried one. Both the plugin and the MCP server now accept
  `boundary?: NoulCriteria`, with the same field name on both surfaces.

- The MCP server reported `version: 0.1.0` from a hardcoded string while the
  package was at 0.2.2, so every host displayed a version that had never existed.

- The MCP server's default OpenRouter baseURL was missing the `/api` the SDK's
  path needs — it fed the egress report rather than the request, so the report
  named an endpoint the call never used.

- Three false statements in the READMEs, corrected in all five languages: the
  OpenRouter model-id rule (the READMEs demanded a `typesafe/` prefix, and the id
  that rule produces — `typesafe/jev-latest` — is the one the live route
  rejects, while bare `jev-latest` works), the `engines.node` difference between
  the packages, and that default baseURL. One table cell had also been truncated
  mid-sentence in the English source for three releases.

- The bundled skill described `confidence` as "Jev's own calibration". It is a
  concentration statistic derived from the probabilities — and a `noul` answer
  has none at all.

- **The declared state cap was not a cap.** For payloads dense in characters that
  need escaping, `capJsonText` measured the JSON before escaping and sent the
  result afterwards: a 500-character cap emitted **692**, and a 16,000-character
  cap emitted **23,344**. The head length is now found by bisecting the serialized
  envelope, so the declared limit holds for every input, and the test that allowed
  `maxChars + 200` slack now asserts the limit itself.

- **Redaction erased ordinary field names.** Sixteen of sixteen non-secret names
  were removed because the key rules matched substrings (`author` for `auth`), and
  a label like `api_key=` was consumed along with its value, so a log could not
  even be read to ask whether it held a credential assignment. Rules are anchored
  to whole names now, and a label survives with its value replaced — the JSON
  stays parseable. One over-redaction is kept deliberately: `totalTokens` is still
  removed, because it cannot be told apart from `userToken` by shape.

### Added

- **Results account for themselves.** `truncated`, the size actually sent, and
  the redaction counts travel on the result. A state over the cap used to be cut
  silently, and the answer came back as though Jev had seen all of it.

- **`docs/quickstart.md`** — the core had 69 exports and no runnable example.
  Every snippet in it was run against both the published package and a fresh
  build, and the outputs matched.

- **`docs/hosts.md`** — seven MCP hosts, four mutually incompatible configuration
  shapes, the Windows variants, and the failure modes worth knowing: some hosts
  filter the environment a server is spawned with, and the DSH plugin row needs
  its own `env` because the harness scrubs `KEY`/`PASSWORD`/`SECRET`/`TOKEN` from
  the child environment. Without it a configured key silently yields synthetic
  answers.

- **`mcpName` and `server.json`**, so `jevcore-mcp` can be listed in the official
  MCP Registry, where the sibling `dsh-cert-mcp` already is.

- Error codes that name what happened, the original HTTP status, and the symbols
  earlier release notes promised but never exported (`MAX_SCORE_LEVELS`,
  `MAX_CHOICE_OPTIONS`, `isEmptyEntry`, `NoulCriteria`, `EntryType`, and the two
  request defaults).

- **`scripts/check-mojibake.mjs`** — the corrupted-dash class that shipped once
  cannot be found by scanning for replacement characters, because the artifact is
  a legal ASCII `?`. This gate also compares source against build output, which
  is how a description that only exists in `lib/` reaches a host at runtime.

### Changed

- **The default probability floor now agrees with the self-consistency band.**
  `minProbability` was 0.6 while the band's upper bound is 0.7, so a noul at 0.65
  was simultaneously `decided` and `uncertain`; the comparison was also inclusive,
  which left the same disagreement exactly at 0.7. Both floors are now 0.7 and the
  noul threshold is strict, so the two readings agree everywhere. **This is the
  one deliberate change to default behaviour, and it moves the wrong way for
  nobody:** more answers resolve `undecided`, none resolve `allow` that did not
  before.

- `jev_check` gains `undecided` for the case where the evidence is sufficient but
  neither side reaches its threshold — previously reported as `insufficient`,
  which contradicted the same payload's own probability. A missing sufficiency
  answer now fails closed instead of reading as support.

- The mojibake gate runs after the build rather than before it, so it inspects the
  bytes that will ship instead of reporting the same staleness on every run.

- Tests: 410 → 551.

### Known limitation

Releases cannot use npm's trusted publishing from this repository yet. GitHub
signs OIDC tokens for repositories created after 2026-07-15 with an immutable
subject claim, and npm's registry cannot match that form; the exchange is
rejected and the setting cannot be turned off. Reported upstream as
[npm/cli#9969](https://github.com/npm/cli/issues/9969) with this repository's
reproduction. Releases go out through the staged path described in
`PUBLISHING.md` until it is fixed.

## 0.2.2 — 2026-09-20

Repository and packaging changes. The decision core and the three entry points
behave exactly as 0.2.1 left them; what changes is the licence, what each package
ships, and how much of it a gate checks.

### Changed

- **The licence is Apache-2.0, not MIT.** `LICENSE` is now the standard Apache
  License 2.0 text, carried without a copyright line because the licence puts the
  copyright statement in `NOTICE`, where it now is; all four manifests say
  `Apache-2.0`, as do the five READMEs. A release is the only thing that can make
  this visible — published metadata is immutable, so 0.2.1 and every version before
  it still report `MIT` on npm.

- **Every package ships five READMEs.** The four translations were listed in
  `files[]` from the start while the package directories held none, so npm dropped
  them without a word and every published tarball carried the English page alone.
  Each package now carries its own set: a package's npm page is its own document,
  so the repository's translations could not stand in for it.

- **`jevcore-dsh` follows the plugin conventions of the harness it plugs into.**
  `dsh.manifestVersion: 1`; `engines.dsh` and the `@deepseek-ai/dsh-tools` peer
  range gained the `>=0.1.6-0 <0.2.0` segment, so one pin covers the current alpha
  line as well as the two earlier ones; `engines.node` is the harness's
  `^22.19.0 || >=24.0.0` rather than `>=20`.

- `files[]` ships `src` and `CHANGELOG.md`, matching the sibling plugins, so a
  stack trace from a published package points at readable source.

- **Releases authenticate with OIDC trusted publishing instead of a stored
  token.** `publish.yml` becomes `release.yml` — the filename npm's trusted
  publisher matches exactly, extension included, and the name 38 of the sibling
  plugin repositories use. The workflow holds no credential, takes
  `id-token: write`, and publishes with provenance. Hand-publishing is no longer
  a fallback: with 2FA on the account it prints `✅ Published` and exits 0 while
  only *staging* the version for approval, and the staged version then occupies
  that version number while being invisible to `npm stage list` — which is how
  0.2.2 was consumed without ever reaching the registry.

### Added

- **`scripts/check-readme-sync.mjs`**, run by `check` and by `prepublishOnly`. It
  treats each five-language README set as a unit: same `## ` sections, same fenced
  code blocks compared byte for byte, same links, same configuration keys, same
  licence, and the same ordered structural shape — headings, table rows, code
  blocks, rules and list items — with prose excluded, because prose is what a
  translation is for. The shape is what catches a section dropped and another
  duplicated in its place, which a section count alone cannot see.

- **`scripts/sync-legal-files.mjs` also ships `CHANGELOG.md`** to each package, and
  `.gitattributes` pins LF for every text file, so the byte comparison above cannot
  fail for a line-ending reason.

- **Three CI workflows**, taken from the sibling plugin repositories: `compat.yml`
  (pack, install and import all three entry points, then mount the plugin row in a
  scratch profile), `plugin-doctor.yml` (the static plugin gate) and
  `scorecard.yml` (OpenSSF Scorecard).

### Fixed

- **`NOTICE` named a dependency that no longer exists, a script that was deleted,
  and the wrong licence.** It listed `@openrouter/sdk` as an optional dependency of
  two packages and offered `packages/core/scripts/check-openrouter-schemas.mjs` as
  a verification script; both were gone by 0.2.0, and the file still said MIT.
  Rewritten against what the manifests and the tree actually contain.

## 0.2.1 — 2026-09-20

Findings from a full audit against the official TypeSafe documentation, each
confirmed against the live API before and after the change. The architecture was
not in question — code-owned control flow, atomic questions, probabilities
returned to code, and offline-by-default all match the documented design, and the
egress contract has no upstream equivalent. What follows are the defects.

### Security

- **`TYPESAFE_LOG_LEVEL` could make the SDK log what redaction had removed.** The
  TypeSafe SDK falls back to that environment variable, and its own documentation
  says `debug` "adds headers and bodies. Known credential headers are redacted;
  **bodies are not**." Reproduced live: with the variable set, an unmodified
  `LiveProvider` wrote the request body — including the state this package redacts
  before sending — to stderr. The provider now always passes `logLevel`
  explicitly, for the same reason it always passes `apiKey`.

- **Redaction covered `state` alone, so question text left unredacted.** The
  ranking tools build one question per candidate, which meant candidate text
  travelled inside the question map — a path `measure` never passed to the
  redactor. Reproduced: the same string was redacted in `state` and left the
  machine intact in `questions`. Redaction now runs over the whole payload and the
  call record counts removals from both.

  `timeout` and `retry` are now passed too, and exposed as `requestTimeoutMs` /
  `requestMaxRetries`. Not a security fix: the JavaScript SDK has no total retry
  budget, so its 10s-per-attempt default across three attempts lets a single call
  occupy roughly 30s inside a `tools/pre-execute` gate.

### Fixed

- **`provider: openrouter` threw at startup with the default configuration.** The
  guard required a `typesafe/` prefix, while the shared default model is
  `jev-latest`, so the DSH plugin passed the bare id through and threw while the
  MCP runtime quietly substituted a prefixed one — two entry points disagreeing
  about whether the feature worked at all. Live, the route accepts `jev-latest`
  and `jev-1.13`, and accepts `typesafe/jev-1.13` but *not* `typesafe/jev-latest`,
  so "must carry the prefix" was never the real rule. The guard now accepts the
  `jev-` family bare or prefixed, and still refuses other families.

- **An undescribed score level silently renumbered the scale.** A level's position
  in `criteria` *is* its score, so filtering a `null` entry out shortened the
  rubric and moved every level after it: `{low, medium: null, high}` sent a
  two-level scale in which `high` occupied position 1, and the answer's `legend`
  came back keyed `"1"` — read by any position-to-name mapping as the *medium*
  level. The live API rejects `null` entries anyway (422), so there was no correct
  fallback, only a wrong one to hide. It is now refused with an error that names
  the empty string as the way to hold a position, which the API accepts: verified
  live, `["No impact", "", "Users blocked"]` keeps `high` at index 2.

  Also enforces the ceilings the API states in its own error messages: at most 10
  score levels and 255 choice options, both previously unvalidated.

- **`NoulAnswer.confidence` was a field the vendor does not have, and it disabled
  the safety gate.** The docs say it twice, both SDK schemas agree, and live
  answers confirm it: a noul returns `{noul, type}` and nothing else. The package
  invented the field and acted on it, which made the same configuration behave
  oppositely per provider — absent on the live routes so the floor never applied,
  while the mock attached `0.5`, below the default `0.7`, so *every* hazard
  resolved `undecided` and the gate could never decide anything. Removed from the
  type, the normalizers, the mock, the policy and every rendered payload.

- **The declared `questions` cap was measured and reported but never enforced.**
  `measure` computed a capped length, used it for the startup report line, and
  returned the original map. It now refuses an over-long batch with
  `EgressTooLargeError`. Refused rather than truncated, unlike `state`: answers are
  keyed by question, so a shortened question map would return answers that cannot
  be matched back to what was asked.

- **`jev_rank` no longer splices candidate text into the question.** The docs name
  this anti-pattern outright — "put it in its own field instead of splicing it into
  a string template" — and it was the reason candidate contents could reach the
  wire as question text. Candidates now travel in `state` and each question refers
  to its own by a backticked path; verified live that ranking is unchanged (the
  credential runbook scores 0.91 against 0.01 for the billing guide).

- **An undescribed score level rendered as an empty answer.** The empty string is
  the supported way to hold a position in a scale, so an answer landing on such a
  level produced `answer: ''` — indistinguishable from "no answer". It now reports
  the level's index with a note saying so.

### Added

- **Per-criterion thresholds.** The docs are emphatic that "a confidence threshold
  is not one number. Different actions within the same system should be gated at
  different levels depending on the consequences of getting it wrong", and their
  worked example gates two actions in one system at 0.6 and 0.85. `accept` could
  say *whether* a criterion was actionable but not how sure the answer had to be,
  so the risk-scaled half of that guidance was inexpressible: every criterion
  shared one floor. `PolicyOptions.thresholds` supplies per-criterion overrides,
  and a key with none falls back to the policy's own floors.

- **Composite scoring.** The official pattern has two steps and this package had
  only the first — ask one `score` question per dimension, then normalise and
  combine with weights the caller controls. The combining half did not exist, so
  every integration hand-rolled the level-to-fraction arithmetic.
  `normalizeScore` maps an answer onto 0–1 using the rubric it actually returned,
  and `compositeScore` weights several into one number while reporting the
  arithmetic per dimension, which is the docs' stated payoff: "visibility into how
  exactly the final score is being calculated". A dimension with no answer is
  reported in `missing` rather than counted as zero — absent evidence and a
  genuine lowest score are different findings.

- **`EntryType` support for `instructions` and criteria.** The API accepts a
  string, object, array or null wherever guidance is written, and the docs spend a
  section on when structure helps — a code-sourced value in its own field,
  contrastive definitions, shared wording across questions. All three question
  builders accept it now, as do choice descriptions. Verified live.
- **A noul can describe its own boundary** via `criteria: {true, false}`, new in
  API v1. The tool boundaries accepted the field and silently dropped it for nouls.
- **`noulBand` / `DEFAULT_NOUL_BAND`.** A noul is a calibrated probability, not a
  decision, and rendering 0.51 as a settled `true` invites a branch on a coin toss.
  The official self-consistency cookbook's band — `no` below 0.30, `uncertain`
  0.30 through 0.70 inclusive, `yes` above — is now reported alongside the binary
  reading, which is left unchanged for compatibility.
- `normalizeScore`, `compositeScore`, `PolicyOptions.thresholds`, `ThresholdPair`,
  `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_REQUEST_MAX_RETRIES`, `MAX_SCORE_LEVELS`,
  `MAX_CHOICE_OPTIONS`, `EgressTooLargeError`, `isEmptyEntry`, `NoulCriteria`,
  `NoulBand`, `NoulBandBounds`, `EntryType`.

### Changed

- **Thresholds have one source rather than five.** `minConfidence` and
  `minProbability` were literal in `DEFAULT_POLICY`, `DEFAULT_CONFIG`, both gates
  and the DSH plugin's `CONFIG_DOC`, so tuning one left the others enforcing a
  different floor. `DEFAULT_POLICY` is now the source; `CONFIG_DOC` derives from
  `DEFAULT_CONFIG`, since it is the copy a user reads.

## 0.1.1 — 2026-09-20

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

### Notes for the next release

- **A `publish` does not always land the moment it returns.** npm stages the
  version first, and `GET /<pkg>` can still show only the previous version for
  tens of seconds afterwards. During this release that delay looked exactly like
  a failed publish, and a second attempt then failed with
  `409 Cannot publish over previously staged version` — the version was already
  there. Confirm a publish by re-reading the registry after a pause, and treat a
  409 as "already published", not as an error to retry.

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
