# Session state — dsh-jev

Last updated: 2026-09-20. Read this first when resuming.

## Where things stand

| Deliverable | State |
|---|---|
| 1. TypeSafe SDK issue drafts | **Done** — `typesafe-sdk-issue-drafts.md`, four ready-to-paste issues |
| 2. M0 scaffolding | **Done** — `D:\Projects\dsh-jev` |
| 3. M1 offline core engine | **Done** — 232 tests pass, no network, no credential |
| 4. M2 service + 3 tools | **Code done and tested; live activation blocked on a process restart** (see below) |
| 5. M3 gates | **Done** — both opt-in, tested |
| 6. M4 live verification | **Blocked** — needs a TypeSafe API key |
| 7. M5 publish (npm + GitHub) | **Blocked** — needs your account; everything else is ready |
| 8. Core split + MCP entry | Not started |
| 9. DSH skill for `typesafe-ai/skills` | Not started |

## The one thing blocking verification

The plugin is installed in the `web` profile and linked, but the row shows `failed` with:

```
jev (dsh-jev): TypeError: Cannot read properties of undefined (reading 'validate')
```

**This error is stale.** It came from the first install, when `src/index.ts` exported a `Config`
object. Cordis treats a plugin's `Config` export as a Standard Schema and calls
`Config['~standard'].validate(...)` before starting the plugin (`vendor/cordis/src/fiber.ts:53`), so
documentation exported under that name crashed activation.

That export is gone — replaced by `CONFIG_DOC`. Verified three ways:

- `npx tsc -p tsconfig.build.json --noEmit` → clean
- a fresh `node` process importing the profile-resolved entry reports `'Config' in m === false`
- `test/plugin.test.ts` mounts the plugin on a real Cordis `Context` and asserts the service
  publishes and three tools register

The toggle cannot clear it because Node caches an ES module by resolved URL, and the running process
already evaluated that URL.

**Action needed: restart the `dsh web` process.** Afterwards the row should go `active`, the startup
report should appear in the log, and `jev_ask` / `jev_rank` / `jev_check` should be callable.

If it *still* fails after a restart, the error is no longer stale and the next step is to check
whether the profile's resolved entry is the file that was built:
`%DSH_HOME%\profiles\web\node_modules\dsh-jev\lib\index.js`.

## Verify after the restart

1. Plugin list shows `include:jev` as `active`.
2. Log contains:
   `[dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)`
3. Call `jev_ask` once with a trivial question and confirm the result carries
   `provider: "mock"` and a `warning` field. A mock answer that is not labelled as synthetic is a bug.

## Next actions in order

1. **Restart `dsh web`**, then run the three checks above.
2. **Apply for a TypeSafe API key** — `https://console.typesafe.ai/settings/keys`. Needed for M4.
3. **Post issue #1** from `typesafe-sdk-issue-drafts.md`, then #2, #3, #4 one at a time.
4. **M4 once the key exists**: set `provider: live`, `apiKeyRef: TYPESAFE_API_KEY`, run one
   `jev_ask`, and record real latency, cost, and transmitted fields. `LiveProvider` has never talked
   to the real API — it is covered only against an injected stub SDK.
5. **M5 publish**: `pnpm publish --access public` after `npm run check`. Note that
   `zhangxaochen/dsh-jev` already exists on npm at 0.2.0 and is a different project; decide whether
   to publish under a scope, and consider adding a README line disambiguating the two.
6. **Core split + MCP entry** — the case for a generic Jev MCP server is weak:
   `jkudish/jev-mcp` already ships ten tools. The differentiated version is an MCP entry over this
   same core, not another tool collection.

## Repository facts

- Path: `D:\Projects\dsh-jev`
- Package: `dsh-jev@0.1.0`, MIT, ESM, Node >= 20
- 232 tests across 12 files; `pnpm run check` = typecheck + test + build
- npm pack: 72 files, 64.9 kB tarball
- No install-time scripts (`prepublishOnly` only)
- `@typesafe-ai/sdk` is an **optional** dependency; the plugin runs offline without it
- `@deepseek-ai/dsh-tools` is a peer dependency. **Do not use `@deepseek-ai/dsh-tools@latest`** —
  that version depends on `@deepseek-ai/dsh-type-meta`, which is not published. Use `0.1.6-alpha.2`
  or `0.1.5-rc.2`.

## Traps hit during this build (do not repeat)

- **PowerShell `Set-Content` corrupts UTF-8.** It mangled three source files; the fix is
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.
  Verify with a strict `UTF8Encoding($false, $true)` decode after any bulk edit.
- **Cordis `Config` export is a trap.** Never export documentation under that name.
- **Tool output schemas need implicit index signatures.** Types that cross into a tool output must be
  `type` aliases, not `interface`es, or they are not assignable to `JsonValue`. Arrays must be
  mutable (`T[]`, not `readonly T[]`).
- **GitHub's unauthenticated API returns 403 when rate-limited, not 404.** A repo probe that treats
  403 as "missing" produces false negatives.
