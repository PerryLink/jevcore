# Session state — dsh-jev

Last updated: 2026-09-20. Read this first when resuming.

## Where things stand

| Deliverable | State |
|---|---|
| 1. TypeSafe SDK issue drafts | **Done** — `../typesafe-sdk-issue-drafts.md`, four ready-to-paste issues |
| 2. M0 scaffolding | **Done** |
| 3. M1 offline core engine | **Done** — in `packages/core` |
| 4. M2 service + 3 tools | **Code done and tested; live activation needs a `dsh web` restart** (proven below) |
| 5. M3 gates | **Done** — both opt-in |
| 6. M4 live verification | **Blocked** — needs a TypeSafe API key |
| 7. M5 publish | **Blocked** — needs your npm/GitHub account; everything else ready |
| 8. Core split | **Done** — `@dsh-jev/core` + `dsh-jev` |
| 9. MCP entry | Not started |
| 10. DSH skill for `typesafe-ai/skills` | Not started |

## Repository layout

```
dsh-jev/
├── package.json              workspace root (private)
├── pnpm-workspace.yaml       packages/* + the esbuild allowBuilds entry
├── tsconfig.base.json        shared compiler options (no outDir — see traps)
├── packages/core/            @dsh-jev/core — no framework dependency
│   ├── src/  types, primitives, check, redact, egress, config, schema,
│   │         credentials, providers, service, policy, render, gates
│   └── test/ 191 tests
└── packages/dsh/             dsh-jev — the DeepSeek Harness plugin
    ├── src/  index (apply/Config/inject), ask, rank, check
    ├── cordis.patch.yml
    └── test/ 43 tests
```

`packages/core` imports nothing from DeepSeek Harness or Cordis. `packages/dsh`
is a thin adapter: it declares tool schemas and translates hook payloads, and
everything decision-shaped lives in core.

## The one blocker, with evidence

The plugin row shows `failed` with:

```
jev (dsh-jev): TypeError: Cannot read properties of undefined (reading 'validate')
```

**This error does not come from the current code.** Established by instrumenting
the built entry point with a probe that appends to a log file on load, then
toggling the row and reading the log:

- The probe fired for a local `node` import.
- It did **not** fire when the running server toggled the row — only one entry
  in the log, from the smoke test.

So the running process resolves `dsh-jev` from an internal cache and never
re-imports the file. Cordis stores a plugin's `Plugin.Runtime` — including its
`Config` — in a registry keyed by the plugin callback
(`vendor/cordis/src/registry.ts:322-328`), and that record is created on first
load and reused. Toggling `disabled` does not evict it.

The fix is already in place; the process must restart to observe it.

**Action needed: restart `dsh web`.**

If it still fails after a restart, the error is then genuinely current, and the
first thing to check is the profile's resolved entry:
`%DSH_HOME%\profiles\web\node_modules\dsh-jev\lib\index.js`.

## Verify after the restart

1. Plugin list shows `include:jev` as `active`.
2. The log contains:
   `[dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)`
3. Call `jev_ask` once with a trivial question; the result must carry
   `provider: "mock"` and a `warning` field. An unlabelled synthetic answer is a bug.

## Profile wiring (already done)

`%DSH_HOME%\profiles\web\package.json` links both packages:

```json
"dependencies": {
  "@dsh-jev/core": "link:D:/Projects/dsh-jev/packages/core",
  "dsh-jev": "link:D:/Projects/dsh-jev/packages/dsh"
}
```

Both must be present: `dsh-jev` imports `@dsh-jev/core` by name, so the
dependency has to resolve from the profile's own `node_modules`, not from a
nested one.

## Next actions in order

1. **Restart `dsh web`**, then run the three checks above.
2. **Apply for a TypeSafe API key** — `https://console.typesafe.ai/settings/keys`.
3. **Post issue #1** from the issue drafts, then #2, #3, #4 one at a time.
4. **M4** once the key exists: set `provider: live`, `apiKeyRef: TYPESAFE_API_KEY`,
   run one `jev_ask`, and record real latency, cost, and transmitted fields.
   `LiveProvider` has never talked to the real API — only an injected stub.
5. **MCP entry** — a `packages/mcp` that wraps core. Note the case is weaker than
   it looks: `jkudish/jev-mcp` already ships ten tools, so the only defensible
   version is a thin MCP surface over *this* core, not another tool collection.
6. **M5 publish** — `pnpm -r publish --access public` after `pnpm run check`.
   `zhangxaochen/dsh-jev` already exists on npm at 0.2.0 and is a different
   project; publish under a scope or add a README line disambiguating them.

## Traps hit while building this (do not repeat)

- **PowerShell `Set-Content` corrupts UTF-8.** It mangled several source files.
  Use `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`.
  Note the damage can leave *valid* UTF-8 that is silently wrong (a truncated em
  dash as `U+00E2 U+0080`), so an encoding validity check is not enough — check
  code points. Prefer `edit`/`write` over shell rewriting.
- **Cordis `Config` is load-bearing.** Cordis calls
  `Config['~standard'].validate(config)` before the plugin starts
  (`vendor/cordis/src/fiber.ts:53`). Exporting documentation under that name
  crashes activation. Implement the Standard Schema protocol, or name the
  documentation something else.
- **A relative `outDir` in an extended tsconfig resolves against the file that
  declares it**, not the extending one. A base-config `"./lib"` wrote output to
  the repo root, and `tsc` still exited 0. Declare `outDir` in each package.
- **pnpm 11 blocks dependency build scripts AND exits non-zero on every later
  command** until the dependency is listed in `allowBuilds`. esbuild (a vitest
  transitive) is the only entry here.
- **Tool output schemas need implicit index signatures.** Types crossing into a
  tool output must be `type` aliases, not `interface`es, or they are not
  assignable to `JsonValue`. Arrays must be mutable (`T[]`, not `readonly T[]`).
- **Do not depend on `@deepseek-ai/dsh-tools@latest`** — it depends on
  `@deepseek-ai/dsh-type-meta`, which is not published. Use `0.1.6-alpha.2`.
- **GitHub's unauthenticated API returns 403 when rate-limited, not 404.** A
  probe treating 403 as "missing" produces false negatives.
