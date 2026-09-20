# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.1 — 2026-09-21

0.4.0 was staged and never released, except for the CLI. This is what an
adversarial pass over it found, and the first item is why the release was pulled.

### Fixed

- **`jev_ask` returned invalid output on every call, in every real host.** The
  host validates a tool's return value against the schema that tool declares, on
  the ordinary dispatch path, and rejects an undeclared key. `JevService` stamps
  `egress` onto every result, `renderResult` forwards it, and `ask.ts` returns
  `renderResult(...)` verbatim — while `ask.ts`'s output schema declared neither
  `truncated` nor `egress`. `rank.ts` and `check.ts` declared both. So every call
  came back as `tool "jev_ask" returned invalid output: "value.egress" is not a
  declared property (additionalProperties: false)`.

  **This was already broken in the published 0.3.1.** The schema and the core's
  stamping are byte-identical at `fc8f016`; only the tool that returns the core's
  rendered payload directly was affected, which is why `jev_rank` and `jev_check`
  kept working. A thousand lines of tests never saw it because they drive
  `definition.execute(...)` — one level below the validator the registry runs on
  every top-level call. `test/tools.test.ts` now asserts each tool's payload
  against its own declared schema.

- **The question map's redaction leaked secrets nested inside a question.** The
  fix that stopped `credential_exposure` being replaced by `"[redacted]"` disabled
  the key rules for the entire question subtree, so a secret named by its *key
  inside* a question stopped being redacted at all: `noul({ password: '…' })`
  reached the provider verbatim and `redactions` was `0`. Now only the map's
  **top-level ids** are exempt — they key the answers and are protocol
  identifiers — while each question's **value** is redacted with the full rules.

- **The shape guard did not fire for every reshape.** A redactor returning a
  number or a boolean produced no error at all, because `Object.entries(7)` is
  `[]`; `null` produced a `TypeError` rather than `EgressShapeError`. The guard
  now requires a non-null, non-array object whose id set is exactly the declared
  one.

- **`recent()`'s freeze was shallow, so the record could be rewritten.**
  `recent()[0].redactionRules.push('FORGED')` succeeded and changed what
  `stats().lastCall` reported: the record object was frozen, its array was not,
  and it was the array the service kept. This package describes the call history
  as the honest record of what happened, and a record a caller can edit is not
  that.

- **An open breaker still charged the call budget.** `budget.reserve()` ran before
  `breaker.assert()`, so a provider that had been failing burned the budget on
  calls that were never made — measured at three of three consumed with zero
  transmissions. The breaker is consulted first.

- **A cache failure could be recorded as a provider failure**, turning a storage
  bug into an unhealthy endpoint and incrementing `failures` for a call whose
  provider answered correctly. **A cache hit also dropped `warning`**, so a
  synthetic answer came back from the cache looking like a real one.

- **The safety and context gates dropped the egress facts**, the same defect class
  fixed in the MCP and DSH adapters earlier in this release: they rebuild a
  `JevResult` field by field, and the rebuilt value lost `truncated` and `egress`.

- **The published CLI answered `--version` with the wrong version.**
  `jevcore-cli@0.4.0` reported `0.3.1`, because the constant was kept in step with
  `package.json` by hand and the hand slipped during the bump. It is read from the
  manifest at run time now, so there is no second copy to forget.

- **The GitHub Action's output heredocs were not delimiter-safe.** A stdout line
  reading `JEV_RESULT_EOF` closed the heredoc early and every line after it was
  parsed by the runner as a further `$GITHUB_OUTPUT` command — an output whose
  name came from the document. The delimiters are generated per run. Separately, a
  newline in the `command` input forged a second `::error::` annotation line;
  newlines are stripped from any value before it reaches a workflow command.

- **`scripts/check-workflow-shell.mjs` both missed violations and invented them.**
  It did not see `run: |2-`, a plain scalar whose value continues on the next
  line, or `run` written inside a flow mapping — and it reported backticks inside
  quoted-heredoc bodies and single-quoted strings, where bash expands nothing at
  all. A guard that is wrong in both directions teaches people to ignore it.

### Changed

- **The release path records why `0.4.0` is not a version to install.**
  `jevcore-cli@0.4.0` is live and cannot be installed: its name was new, a first
  publish of a package name cannot be staged, and it pinned `jevcore@0.4.0`
  exactly — a version that never left staging. `latest` moves to 0.4.1, which
  resolves.

## 0.4.0 — 2026-09-21

Four surfaces over one decision core now, and most of this release is about the
places where they had quietly stopped agreeing with it. The headline item is a
defect that had been shipping since the safety gate existed and that no test could
see, because the gate's own error handling turned it into a plausible answer.

### Fixed

- **The `credential_exposure` hazard never reached Jev.** `EgressContract`
  redacted the question map with the key rules on, and a key rule replaces a value
  whose *field name* looks secret-bearing. The hazard id `credential_exposure`
  matches `/credential/i`, so its entire question was replaced by the string
  `"[redacted]"` before transmission — 160 characters of a declared
  1,774-character payload. On the live route the API received a string where a
  question object belongs. On the offline route, which is the default and what
  every test ran against, the mock threw
  `TypeError: Cannot convert undefined or null to object`. The safety gate catches
  provider errors and routes them through `onUndecided`, whose default is `ask`,
  so a gate that had stopped judging anything returned exactly the decision a
  careful gate returns. Nothing failed; nothing was asked either.

  The question map is redacted with the value rules only now — question ids key
  the answers, so they are protocol identifiers rather than field names — and
  `measure` asserts the shape survived, raising `EgressShapeError` instead of
  letting a reshaped map become a silent `ask`. `state` still gets both passes, so
  a credential in the payload is still redacted.

  The test that should have caught this compared the *keys* of the transmitted map
  against the declared one. The keys were never the problem.

- **The MCP tools never reported that they had truncated.** `EgressContract` caps
  `state` by truncating it, deliberately. All three MCP handlers build their own
  result objects rather than going through the core's `renderResult`, and all
  three dropped `truncated` and `egress`. Measured: ten candidates of 4,000
  characters are 40,271 characters of state, 16,000 of them are sent, and
  `runRank` returned all ten original strings beside their scores with nothing to
  say that six had been reduced to fragments.

- **The DSH `jev_rank` and `jev_check` tools dropped the same two fields**, for the
  same reason and out of the same kind of hand-built return object. `jev_ask`
  returns `renderResult(...)` directly and was unaffected.

- **The TypeSafe SDK's `debug` log level writes request bodies verbatim**, with
  credential headers redacted and bodies not (`@typesafe-ai/sdk` 0.6.0,
  `dist/index.d.mts:210-215`). It was reachable from this plugin: `logLevel`
  accepts `'debug'`, and both the DSH plugin and the MCP runtime forwarded it. Both
  routes now clamp to a body-safe level through one shared client builder, and body
  logging requires an explicit `allowSdkBodyLogging` opt-in that says what it does.

- **The safety gate's reason told operators to approve a call that had been
  denied.** With no approval service mounted, the DSH host turns `ask` into `deny`
  and carries the gate's own reason text into the refusal, so a deployment with no
  approver saw "Approve to proceed" attached to a call that was refused. The reason
  now names the hazards and the severity factually, and the plugin warns at startup
  when the gate is enabled and nothing in the deployment can approve anything.

- **The rank candidate cap was enforced but undocumented**, so a caller passing too
  many candidates got an error it could not explain. It is a 4,000-character cap on
  the generated questions — refused, never truncated — which is 20 candidates under
  the default criterion and 7 under a 400-character one. Both the DSH and the MCP
  tool descriptions now state it, derived from the contract rather than typed in,
  with tests that fail if the prose and the enforcement drift apart.

- **The CLI's `gate` dry run said the safety gate does not ask a severity
  question** and dropped the severity from its output. Both were true before this
  release and neither is now.

### Added

- **`jev` — a command line over the same decision core** (new package
  `jevcore-cli`). `ask`, `check`, `rank`, `gate`, `egress` and `models`, each with
  `--json` and a documented exit-code contract. `jev gate` is the one worth
  knowing: it dry-runs the safety gate against a hypothetical tool call, so an
  operator or a CI job can see the decision without running anything and without a
  DSH session.

- **A GitHub Action** (`.github/actions/jev-check`) wrapping the CLI's `check` and
  `gate`. Its default is `fail-on: never`: a Jev call returns a probability, and
  what that probability is allowed to authorise belongs to the workflow that owns
  it rather than to this action. Workflow inputs arrive through the environment
  instead of by interpolation into the script text, because a claim can come from a
  pull request body.

- **A resilience layer, inert unless asked for**: an answer cache keyed on the
  *measured* payload, a hard ceiling on calls and spend, and a consecutive-failure
  breaker that honours `Retry-After`. The cache cannot be enabled for
  `gate:safety` — a gate verdict is about one call, not about a reusable input —
  and a cache constructed without an explicit allow/exclude decision caches
  nothing. A budget refusal and an open breaker throw before the provider is
  touched, so neither is recorded as a provider failure, and a cache hit does not
  increment `transmitted` because nothing left the machine.

- **`JevService.askMany`**: N independent states with bounded concurrency and
  per-item failure isolation. Not a batching discount, and it cannot be one — the
  wire format carries exactly one `state` per request.

- **`runRepeated`**, a reusable form of the self-consistency measurement this
  project had been performing by hand. It measures agreement, not correctness, and
  its doc comment is emphatic about the difference because a small spread is easy
  to over-read.

- **`x-typesafe-request-id` is now read and surfaced.** The SDK assigns it on the
  *response* and exposes it through `APIPromise.withResponse()`, which this package
  was not calling, so the id was being discarded. None is invented and none is
  sent: whether the service accepts a client-supplied one is undocumented, and
  therefore untested here.

- **A model catalogue and an alias-drift check.** `jev-latest` and `jev-preview`
  move, and the SDK's own default when no model is configured is `jev-latest`, so
  "I did not choose a model" silently means "whatever is newest". The catalogue
  cannot resolve an alias; the response's `model` field can. `checkAliasDrift`
  therefore needs an observed answer and reports `unknown` without one.

- **A severity dimension for the safety gate**, so that "delete a scratch file" and
  "drop the production database" stop gating identically. One `score` question over
  a documented five-rung ladder, a configurable `safetySeverityBlock` defaulting to
  `high`, and a test that runs eighteen fixtures through a transcription of the
  pre-severity decision and asserts the new one is never *less* strict.

- **`seq` on every call record**, so `recent()` has a defined order that does not
  depend on wall-clock ties. `recent()` also returns a frozen copy now rather than
  the service's live internal array.

- **`costAccounting` and `callsWithoutCost` on `JevStats`.** `totalCostUsd` is
  always `0` on the official route, because `Usage` has no cost field at all
  (`dist/index.d.mts:121-126`) — a confident-looking zero that means "unknown". The
  new field says which of the two a zero is.

- **An `onRecord` observer hook** for a metrics or logging surface. An observer
  that throws never fails the Jev call.

- **The four `docs/` pages now ship inside every package.** They were in no
  package's `files` array, so an npm install produced a plugin with no quickstart
  and no statement of its deployment boundaries while the repository looked
  complete. They are generated copies kept in sync by
  `scripts/sync-package-docs.mjs`, guarded by `check:docs`, and named in the CI step
  that verifies each tarball — because what a gate does not name, it does not
  protect.

- **`docs/approval.md`** documents the deployment boundary that bites: `ask` needs
  something that can ask a human, and a deployment without one gets a denial
  carrying the gate's own reason. **`docs/limits.md`** collects what the project
  does not do — the per-attempt timeout with no total retry budget, what a zero cost
  means, the ranking cap, what the offline mock ignores, and what has never been
  measured.

- **`scripts/check-workflow-shell.mjs`**, a gate for a trap that had already caught
  this repository twice: bash performs command substitution on backticks inside a
  `run:` block before the program in that block sees the text, so a backtick in a
  JavaScript comment is executed as a command.

### Changed

- **Package README links to the documentation now resolve inside the tarball.**
  `../../docs/limits.md` escapes the installed package; `docs/limits.md` resolves
  both on the forge and after `npm install`, which is the entire point of shipping
  the documents.

- **`packages/cli` is part of the release**: the tag-to-manifest check, the
  trusted-publishing diagnostic, the publish order (core first, because every other
  package depends on it) and the five-language README gate all name it now.

- **`skillRegistration` still returns `whenToUse`, and that is a finding rather
  than an omission.** It is not rendered to the model, which is what an earlier
  audit concluded — but the host forwards it into the client-facing skill catalog,
  so removing it would drop a protocol payload field. The doc comment records what
  was checked, so nobody re-opens it from the same wrong premise.

## 0.3.1 — 2026-09-20

Documentation and one script. Nothing about how the packages behave changed, but
what they claim about themselves did — and a claim that has quietly become false is
the kind of thing this project spends its time removing from other people's code.

### Added

- **`packages/core/scripts/probe-live.mjs`** — `pnpm --filter jevcore run
  probe:typesafe`. The offline suite proves this project agrees with itself; it
  cannot prove the vendor agrees with it, because every provider test runs against
  a stub or the hash-based mock. This probe asks the real API three things: ten
  claim/evidence pairs whose verdict is known in advance, one question repeated
  six times, and a noul carrying a `criteria: {true, false}` boundary.

  Two runs agreed. Supporting evidence scored 0.95 (0.952, then 0.950),
  contradicting evidence 0.10, evidence silent about its claim 0.03, and the
  repeated question varied by 0.01 and then by nothing at all. The boundary was
  accepted — the first time that field has been exercised against the service
  rather than against the SDK's types.

### Fixed

- **The READMEs said the TypeSafe route had never been exercised against the real
  API.** It now has, by the probe above, and the five languages of all three
  README sets carry the numbers instead of an expectation. What remains untested
  is stated just as plainly: quota, rate-limit and entitlement behaviour on a real
  account, which needs production traffic and cannot be probed from here.

- **The corrupted-dash note called the stale build cosmetic.** The dash is; the
  staleness is not. The process still displaying that corrupted dash also lacks
  every fix made since it started, including the `band` field that keeps a 0.51
  from being rendered as a settled yes. The note says so now, and says that a
  restart is what clears it.

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
