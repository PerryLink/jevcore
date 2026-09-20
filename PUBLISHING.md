# Publishing checklist

Everything here is a command you run. Nothing in this file has been executed —
**nothing has been published**, and no GitHub remote exists yet.

Run every step from the repository root.

## 0. Package names — decided

The three packages publish under the `@dsh-jev` scope:

| Directory | Package |
|---|---|
| `packages/core` | `@dsh-jev/core` |
| `packages/dsh` | `@dsh-jev/plugin` |
| `packages/mcp` | `@dsh-jev/mcp` |

### Why not the bare name `dsh-jev`

It is taken. `dsh-jev@0.2.0` belongs to `zhangxaochen`, was published 2026-09-18,
has 123 downloads a month, and is still being published — so it is not going to
free up. Two packages with the same name and different behaviour is a support
burden for both authors, and the collision is worse than usual here because
theirs targets the same framework and the same model.

Verify the scope is still yours before publishing; an npm scope belongs to
whoever publishes into it first:

```sh
npm view @dsh-jev/core version   # 404 means the scope is still unclaimed
```

### Why `plugin` rather than `dsh`

`@dsh-jev/dsh` was the first choice and it reads badly: the same three letters
appear twice with different meanings, so the scope and the package cannot be told
apart at a glance. `@dsh-jev/plugin` names the thing rather than repeating the
framework it targets, and it matches what the other two already do — scope for
the project, leaf for the artifact.

If the scope is ever lost, the fallback is your own npm scope
(`@<username>/dsh-jev` for the plugin, and matching leaves for core and mcp),
which is what most of the DSH plugin ecosystem does.

## 1. Pre-flight

```sh
pnpm install
pnpm run check          # typecheck + test + build across all three packages
```

Expected: 360 tests pass (266 core, 65 dsh, 29 mcp), with no credential set.

```sh
# Parse what this project builds against the vendors' real schemas. Offline.
pnpm --filter @dsh-jev/core run check:schemas

# Drive the MCP server over a real stdio transport, on the mock. Offline.
pnpm --filter @dsh-jev/mcp run smoke
```

Both are credential-free by design and run in CI. The schema check is the one
that found `score.criteria` being sent as a keyed map when both vendors require
an ordered array — a defect every stubbed test had passed over, because a stub
accepts whatever it is handed. Do not skip it because the suite is green.

### Optional: verify the live route before shipping

Neither of these runs in CI. Both cost a fraction of a cent and need an
OpenRouter key whose account permits the `typesafe` provider — System One models
are served by TypeSafe alone, so an account restricted to other providers gets
`HTTP 404` with "No allowed providers are available" and no amount of retrying
changes that. Enable it under **Allowed providers** at
<https://openrouter.ai/settings/privacy>.

```sh
export OPENROUTER_API_KEY=...                       # never commit this
pnpm --filter @dsh-jev/core run probe:live          # provider level
pnpm --filter @dsh-jev/mcp run smoke:live           # whole MCP surface
```

A passing run prints the real model (`typesafe/jev-1.13-<date>`), token usage and
cost, a `noul` probability, a `choice` selection, and a `score` with its legend
and per-level probabilities. **Delete the key from whatever shell or CI variable
you put it in afterwards.**

If you have a TypeSafe key instead, set `TYPESAFE_API_KEY` and select
`provider: live`; that route has the same primitives but has never been exercised
here, so treat the first run as a validation rather than a formality.

```sh
# Confirm nothing in the artifacts reaches the network on the default path.
node packages/mcp/lib/bin.js 2>&1 | head -1
# expect: [dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

## 2. Set the repository URL

All three manifests carry a placeholder `repository` field pointing at
`https://github.com/dsh-jev/dsh-jev`. Replace it with the real URL before
publishing: a wrong one sends bug reports, and npm's provenance link, to a
repository that is not yours.

```sh
grep -rl 'github.com/dsh-jev/dsh-jev' packages/*/package.json
```

Change the URL in each file, then `pnpm install` so the lockfile records it.

## 3. Version and log

1. Set the same version in all three manifests:
   `package.json`, `packages/core/package.json`, `packages/dsh/package.json`,
   `packages/mcp/package.json`.
2. Move the `CHANGELOG.md` entry from `unreleased` to that version and date it.
3. `pnpm install` so the lockfile records the workspace versions.

## 4. Inspect the tarballs before publishing

```sh
pnpm --filter @dsh-jev/core pack --dry-run
pnpm --filter @dsh-jev/plugin pack --dry-run
pnpm --filter @dsh-jev/mcp pack --dry-run
```

Check for each: `lib/` is present, `README.md` and `LICENSE` are included, and
no source maps, test files, or `node_modules` content leaked in. The DSH tarball
must also contain `cordis.patch.yml` — without it the plugin installs and does
nothing.

## 5. Publish

Order matters: the two adapters depend on `@dsh-jev/core`.

```sh
pnpm --filter @dsh-jev/core publish --access public
pnpm --filter @dsh-jev/plugin publish --access public
pnpm --filter @dsh-jev/mcp publish --access public
```

Prefer publishing from CI with provenance over a laptop:

```sh
npm publish --provenance --access public
```

## 6. Tag and push

```sh
git tag -a v0.1.0 -m "0.1.0"
git push origin main --follow-tags
```

## 7. Verify from a clean directory

Do not trust the publish output; install what you actually shipped.

```sh
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install @dsh-jev/core @dsh-jev/plugin @dsh-jev/mcp
node -e "const c = require('@dsh-jev/core'); console.log(Object.keys(c).length, 'core exports')"
```

Then, for the DSH plugin, install it into a **throwaway profile** and confirm the
row reaches `active` and the egress report appears:

```sh
dsh plugin --profile verify-jev add @dsh-jev/plugin
```

For the MCP server:

```sh
npx -y @dsh-jev/mcp    # should print the egress report to stderr and wait
```

## Known-before-you-publish

- **`@deepseek-ai/dsh-tools` is a peer dependency, and its `latest` npm tag is
  broken** — it depends on `@deepseek-ai/dsh-type-meta`, which is not published.
  The manifest does not pin a resolvable version on purpose, because DSH supplies
  it at runtime. Do not "fix" this by adding it to `dependencies`.
- **`@typesafe-ai/sdk` is an optional dependency of core.** The live provider
  loads it lazily; a consumer without it still gets the mock and a clear error
  message if they ask for live.
- **The MCP package needs `zod` in `dependencies`**, not `devDependencies`, even
  though the SDK also depends on it. pnpm's isolation means a peer's transitive
  dependency is not importable.
