# Session state — dsh-jev

Last updated: 2026-09-21 (round 3). Read this first when resuming.

**Current state.** Four packages (`core`, `dsh`, `mcp`, `cli`) at version 0.4.0.
855 tests pass (586 / 116 / 58 / 95) with no credential and no network, and
`pnpm run check` is green. Everything below this line was written in an earlier
round and is kept because the reasoning in it still applies, but its numbers — and
the sections titled "Verified live (round 5)" and "One cosmetic defect" — describe
the state at the time they were written rather than now. Where they disagree with
this paragraph, this paragraph is right.

## Where things stand

| Deliverable | State |
|---|---|
| 1. TypeSafe SDK issue drafts | **Done** — `../typesafe-sdk-issue-drafts.md`, four ready-to-paste issues |
| 2. M0 scaffolding | **Done** |
| 3. M1 offline core engine | **Done** — `packages/core`, 586 tests |
| 4. M2 service + 3 tools | **Code done and tested; live activation blocked on a restart** (see below) |
| 5. M3 gates | **Done** — both opt-in, tested |
| 6. M4 live verification | **Blocked** — needs a TypeSafe API key |
| 7. Core split | **Done** — four packages, one decision layer |
| 8. MCP entry | **Done** — `packages/mcp`, 58 tests, stdio binary verified offline |
| 9. DSH skill | **Done and shipped** — the skill is registered by the plugin (packages/dsh/skills/typesafe-ai-dsh/SKILL.md), so it works today; the upstream proposal in `../typesafe-dsh-skill-proposal.md` is now a courtesy offer rather than a dependency |
| 10. Repo hygiene for publishing | **Done** — CONTRIBUTING, SECURITY, CHANGELOG, PUBLISHING, CI over all four packages |
| 11. MCP transport verification | **Done** — real stdio client drives the server end to end (pnpm --filter jevcore-mcp run smoke) |
| 12. Actual publish + M4 | **Blocked** — needs your accounts and an API key |

The live provider has now made real TypeSafe API calls. `pnpm --filter jevcore run
probe:typesafe` ran twice against `api.typesafe.ai`: ten claim/evidence pairs whose
verdict was known in advance, one question repeated six times, and a noul carrying
a `criteria` boundary. Supporting evidence scored 0.95, contradicting evidence
0.10, evidence silent about its claim 0.03, and the repeated question varied by
0.01 and then by nothing. That is a small constructed sample, not calibration, and
`docs/limits.md` states what remains unmeasured: quota, rate limits and entitlement
on a real account, which need production traffic rather than a probe.

**855 tests pass** (586 core, 116 dsh, 58 mcp, 95 cli) with no credential and no
network access. `pnpm run check` is green, including the documentation, legal-file,
five-language README and workflow-shell gates. All four tarballs pack correctly.

## Repository layout

```
dsh-jev/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── CONTRIBUTING.md  SECURITY.md  CHANGELOG.md  PUBLISHING.md
├── README.md        (also copied into packages/dsh)
├── .github/workflows/ci.yml    typecheck+test+build on Node 20 and 22,
│                               then a job that asserts each tarball contains
│                               what the package needs to load
└── packages/
    ├── core/   jevcore        the decisions; no framework imports; 586 tests
    ├── dsh/    jevcore-dsh    the DSH plugin; 116 tests
    ├── mcp/    jevcore-mcp    the same tools over MCP; 58 tests
    └── cli/    jevcore-cli    the `jev` command line; 95 tests
```

`packages/dsh` and `packages/mcp` are both thin: they declare schemas, translate
transport payloads, and delegate every judgment to core. That is deliberate — an
adapter cannot drift from the guarantees the others make if it owns no decision
logic.

## Verified live (round 5)

The plugin is **active** and the wiring is proven end to end, not inferred:

| Claim | Evidence |
|---|---|
| Row activates | `list_plugins` reports `include:jev` / `jevcore-dsh` / `fiberPhase: active` |
| Tools work | `jev_ask` returned `urgent=true (0.8307)`, `team=billing (0.5027)`, `provider="mock"`, 1 ms, with the SYNTHETIC warning; `jev_check` returned `verdict="insufficient"` with `{supports:0.0616, contradicts:0.632, sufficient:0.6646}` |
| No network on the default path | every result carried `provider="mock"` and `usage {inputTokens:0, outputTokens:0, costUsd:0}` |
| Skill registers | `typesafe-ai-dsh` appeared in the session skill catalog |
| MCP transport | `pnpm --filter jevcore-mcp run smoke` — handshake, discovery, 3 calls, error path |
| Packages ship correctly | all four tarballs contain every required file, including `cordis.patch.yml` and `SKILL.md` |

## One cosmetic defect, already fixed on disk, needs one restart

`jev_ask`'s live tool description contains `—?` where an em dash and a space belong
(`branches on —?routing`, `not decisions —?apply`). Four occurrences repo-wide, two of
them in text the model reads.

Cause, established from timestamps rather than guessed: the running server started at
**11:10:40**, and the fix was committed at **11:13:06** — so that process loaded the
pre-fix module and never re-read the file. `git show 87cd202:packages/dsh/src/ask.ts`
has 3 occurrences; `8293f5c` has 0.

The fix is confirmed in both source and `lib/ask.js` (0 corrupted, 3 correct em dashes).
It cannot be applied in-process: HMR watches only profile patch files
(`dsh-hmr`, "Exact-path watching for live profile patch configuration"), and there is no
module-reload entry point in any installed package. Touching `lib/*.js` does nothing.

**A restart is the only way to apply it.** Nothing else is pending behind that restart.

## Round 4: the restart cleared the first bug and revealed a second

The restart did what was predicted: the `TypeError: ... reading 'validate'` is gone.
The row moved `failed` -> `pending`.

It did not reach `active`, because a **second, unrelated bug of mine** was behind it:

```
jev (dsh-jev): pending (waiting for service: [object Object])
```

`[object Object]` is the stringified form of `{ skills: false }`, which I had put in
`inject` believing the object form marks a dependency optional. It does not. Every key
in `inject` makes the fiber wait for that service, and no service in this profile is
named after that object, so the plugin waited forever.

Fixed: `inject` is now `['tools', 'credentials']`, and `skills` is looked up at runtime
through `ctx.get('skills')` with its absence treated as a warning. The built artifact
was verified to contain the corrected array.

**This fix needs one more restart to take effect.** Toggling the row does not help, for
the same reason as before: cordis caches the plugin record, and the cached record still
carries the old `inject`. Touching the profile's `cordis.patch.yml` (the profile sets
`patchReload: live`) also did not reload it.

## The original blocker, with reproducible evidence

The DSH plugin row still shows `failed`:

```
jev (dsh-jev): TypeError: Cannot read properties of undefined (reading 'validate')
```

**The running server has never imported the current module.** Proven by putting a
`process.pid`-recording probe in the built entry, toggling the row, and reading
the log:

- importing the file with `node` → probe fires
- toggling the row in the running server → **no probe entry at all**

Not "stale text" — the server genuinely keeps an earlier module instance. Cordis
caches a plugin's `Plugin.Runtime`, including its `Config`, keyed by the plugin
callback (`vendor/cordis/src/registry.ts:322-328`); the record is created on
first load and reused, and toggling `disabled` does not evict it.

The server running the profile has PID 29812, started 10:17:17 — before the
restructure that repointed the profile. Everything since then is invisible to it.

**Action needed: restart the process serving `dsh web`.**

If it still fails after a restart, the error is then current, and the next step is
to run the module through the loader path directly:
`node --input-type=module -e "import('dsh-jev').then(m => console.log(typeof m.Config?.['~standard']?.validate))"`
from `%DSH_HOME%\profiles\web`.

## Verify after the restart

1. Plugin list shows `include:jev` as `active`.
2. The log contains:
   `[dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)`
3. Call `jev_ask` once with a trivial question; the result must carry
   `provider: "mock"` and a `warning` field. An unlabelled synthetic answer is a bug.

## Profile wiring (already done)

`%DSH_HOME%\profiles\web\package.json`:

```json
"dependencies": {
  "jevcore": "link:D:/Projects/dsh-jev/packages/core",
  "jevcore-dsh": "link:D:/Projects/dsh-jev/packages/dsh"
}
```

Both are required: `jevcore-dsh` imports `jevcore` by name, so the dependency
must resolve from the profile's own `node_modules`.

## Next actions in order

1. **Restart the process serving `dsh web`**, then run the three checks above.
2. **Apply for a TypeSafe API key** — `https://console.typesafe.ai/settings/keys`.
3. **Post issue #1** from the issue drafts, then #2, #3, #4 one at a time.
4. **M4** once the key exists: run the MCP server with `JEV_PROVIDER=live` and one
   `jev_ask`, and record real latency, cost, and transmitted fields. `LiveProvider`
   has never talked to the real API — only an injected stub.

6. **Publish** — follow `PUBLISHING.md`. Decide the package name first:
   `dsh-jev` already exists on npm at 0.2.0 as an unrelated project.

## Traps hit while building this (do not repeat)

- **The running harness caches plugin modules and does not re-import on toggle.**
  Editing a linked plugin's build output has no effect until the process restarts.
  A probe in the built file settles "did it load?" in one step; do that instead of
  reasoning about caches.
- **PowerShell `Set-Content` corrupts UTF-8.** Use
  `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`.
  Damage can leave *valid* UTF-8 that is still wrong (a truncated em dash becomes
  `U+00E2 U+0080`), so check code points, not just validity. Prefer `edit`/`write`.
- **Cordis `Config` is load-bearing.** It calls `Config['~standard'].validate(config)`
  before the plugin starts (`vendor/cordis/src/fiber.ts:53`). Exporting
  documentation under that name crashes activation.
- **A relative `outDir` in an extended tsconfig resolves against the file that
  declares it**, not the extending one — output silently landed in the repo root
  while `tsc` exited 0. Declare `outDir` in each package.
- **pnpm 11 blocks dependency build scripts and then exits non-zero on every later
  command** until the dependency is in `allowBuilds`. esbuild is the only entry.
- **pnpm's isolation means a peer's transitive dependency is not importable.** The
  MCP package needs `zod` in `dependencies` even though the SDK also depends on it.
- **Tool output schemas need implicit index signatures.** Types crossing into a
  tool output must be `type` aliases, not `interface`es, or they are not assignable
  to `JsonValue`. Arrays must be mutable.
- **Do not depend on `@deepseek-ai/dsh-tools@latest`** — it needs
  `@deepseek-ai/dsh-type-meta`, which is not published. Use `0.1.6-alpha.2`.
- **On a stdio MCP transport, stdout is the protocol channel.** Diagnostics go to
  stderr; a `console.log` corrupts the stream.
- **GitHub's unauthenticated API returns 403 when rate-limited, not 404.**
