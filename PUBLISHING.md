# Publishing checklist

Everything here is a command you run. Nothing in this file has been executed —
**nothing has been published**, and no GitHub remote exists yet.

Run every step from the repository root.

## 0. Decide the package names first

`dsh-jev` **already exists on npm** at 0.2.0, published by `zhangxaochen`. It is a
different project that happens to share the name. Three options:

| Option | Command | Trade-off |
|---|---|---|
| Claim the unscoped name | `pnpm --filter dsh-jev publish --access public` | Name collision with an unrelated project; users may install the wrong one |
| Publish under a scope | rename to `@<you>/dsh-jev` in `packages/dsh/package.json` | Unambiguous; slightly longer install command |
| Keep it local | never publish | No collision, no distribution |

**Recommendation: publish under a scope.** Two packages with the same name and
different behaviour is a support burden for both authors. If you keep the
unscoped name, add a line to the README disambiguating the two.

## 1. Pre-flight

```sh
pnpm install
pnpm run check          # typecheck + test + build across all three packages
```

Expected: 255 tests pass (191 core, 43 dsh, 21 mcp), with no credential set.

```sh
# Confirm nothing in the artifacts reaches the network on the default path.
node packages/mcp/lib/bin.js 2>&1 | head -1
# expect: [dsh-jev] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

## 2. Version and log

1. Set the same version in all three manifests:
   `package.json`, `packages/core/package.json`, `packages/dsh/package.json`,
   `packages/mcp/package.json`.
2. Move the `CHANGELOG.md` entry from `unreleased` to that version and date it.
3. `pnpm install` so the lockfile records the workspace versions.

## 3. Inspect the tarballs before publishing

```sh
pnpm --filter @dsh-jev/core pack --dry-run
pnpm --filter dsh-jev pack --dry-run
pnpm --filter @dsh-jev/mcp pack --dry-run
```

Check for each: `lib/` is present, `README.md` and `LICENSE` are included, and
no source maps, test files, or `node_modules` content leaked in. The DSH tarball
must also contain `cordis.patch.yml` — without it the plugin installs and does
nothing.

## 4. Publish

Order matters: the two adapters depend on `@dsh-jev/core`.

```sh
pnpm --filter @dsh-jev/core publish --access public
pnpm --filter dsh-jev publish --access public
pnpm --filter @dsh-jev/mcp publish --access public
```

Prefer publishing from CI with provenance over a laptop:

```sh
npm publish --provenance --access public
```

## 5. Tag and push

```sh
git tag -a v0.1.0 -m "0.1.0"
git push origin main --follow-tags
```

## 6. Verify from a clean directory

Do not trust the publish output; install what you actually shipped.

```sh
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install @dsh-jev/core dsh-jev @dsh-jev/mcp
node -e "const c = require('@dsh-jev/core'); console.log(Object.keys(c).length, 'core exports')"
```

Then, for the DSH plugin, install it into a **throwaway profile** and confirm the
row reaches `active` and the egress report appears:

```sh
dsh plugin --profile verify-jev add dsh-jev
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
