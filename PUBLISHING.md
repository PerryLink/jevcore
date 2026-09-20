# Publishing checklist

Status as of writing:

- **0.1.0 is published to npm** — `jevcore`, `jevcore-dsh` and `jevcore-mcp` are
  live, verified by installing them from the public registry into an empty
  directory rather than by trusting the publish output;
- the repository is public at <https://github.com/PerryLink/jevcore>, with CI
  green, and a mirror is pushed to Gitee at
  <https://gitee.com/perrylink/jevcore>;
- the `Publish` workflow is in place for future releases, but it needs an
  `NPM_TOKEN` repository secret before a tag push can use it (below).

Run every step from the repository root.

## Before the next release: add the NPM_TOKEN secret

The 0.1.0 release was published from a laptop, which works but produces no
provenance attestation. To release the next version through the workflow:

1. Create an npm **automation** token with publish rights for `jevcore`,
   `jevcore-dsh` and `jevcore-mcp` (npm → Access Tokens → Generate New Token →
   Automation; automation tokens bypass 2FA, which CI needs).
2. Add it to the repository: **Settings → Secrets and variables → Actions → New
   repository secret**, named `NPM_TOKEN`.
3. Bump the version in all four manifests and `pnpm install`, then push a `v*`
   tag.

Without that secret the workflow **fails** rather than skipping, deliberately: a
tag that "passes" while publishing nothing is easy to mistake for a release.

The token is never written to this repository or any of its files. It belongs in
repository secrets, and locally only in the environment of the command that needs
it.

### Why the first attempt failed, recorded so it is not repeated

The unscoped name `jevkit` was rejected outright:

```
403 Forbidden - PUT https://registry.npmjs.org/jevkit - Package name too similar
to existing package jev-kit
```

`npm view jevkit` returned 404 right up to that moment, which is the trap: a 404
proves a name is unregistered, never that it will pass the similarity check.
npm's rule for that check is [undocumented and cannot be queried before
publishing](https://github.com/orgs/community/discussions/205030), so the only
reliable defence is a name that is not close to anything — or a scope. `jevcore`
passed, and the same name was verified free on GitHub and Gitee first.

## 0. Package names — decided

The three packages publish as a **family of unscoped names**, rooted at `jevcore`:

| Directory | Package | Role |
|---|---|---|
| `packages/core` | `jevcore` | The framework-agnostic decision core |
| `packages/dsh` | `jevcore-dsh` | The DeepSeek Harness / Cordis plugin |
| `packages/mcp` | `jevcore-mcp` | The MCP server |

Both adapters depend on the root name, so a reader can infer the dependency
direction from the names alone. Nothing but the DSH adapter carries `dsh`.

### Why not the bare name `dsh-jev`

It is taken. `dsh-jev@0.2.0` belongs to `zhangxaochen`, was published 2026-09-18,
has 123 downloads a month, and is still being published — so it is not going to
free up. Two packages with the same name and different behaviour is a support
burden for both authors, and the collision is worse than usual here because
theirs targets the same framework and the same model.

### Why not a `@dsh-jev` scope

That was the earlier plan and it was wrong, for a reason worth recording: two of
the three packages are **not** DSH-specific. A Claude Desktop user looking for a
Jev MCP server would find `@dsh-jev/mcp` and reasonably conclude it was not for
them, and someone writing a plain script would read the same into
`@dsh-jev/core`. Scoping everything under the framework's name mis-sold two
thirds of the project. Only the DSH adapter should say `dsh`, and now only it
does.

### Why `jevcore`

`jevkit` was the first choice and npm refused it as too similar to the existing
`jev-kit`. `jev-core`, `jev-tools` and `jev-plugin` are unregistered but sit one
hyphen away from names that are not, which is the same trap. Coined alternatives
(`probanda`, `kalibr`) were considered and rejected on a different ground: they
say nothing about Jev, and a name nobody can connect to the project is not worth
the safety.

`jevcore` keeps the association, is unhyphenated — further from any hyphenated
neighbour than `jevkit` sat from `jev-kit` — and was verified free on npm, GitHub
and Gitee before anything was published. Candidate families that failed the
GitHub half of that check: `jevkit` (`ariel-frischer/jevkit`), `jev-decision-*`
(`zhangxaochen/dsh-jev`), `jev-dsh` (`buberlo/dsh-jev`), and `jev-mcp` which is
taken on npm itself.

A scope (`@perrylink/jevcore`) would have side-stepped the similarity check
entirely and npm recommends it, but it was not wanted: the scoped form reads more
like a personal namespace than a project, and unscoped names are simpler to
install.

### Unscoped names must be claimed individually

npm registers ownership of a **scope** (`@scope/`), not a name prefix. There is
no such thing as owning `jevcore-*`: `jevcore`, `jevcore-dsh` and `jevcore-mcp` are
three independent names and each has to be free at publish time. Verify before
publishing:

```sh
for n in jevcore jevcore-dsh jevcore-mcp; do npm view "$n" version 2>&1 | head -1; done
# 404 for each means all three are still claimable
```

If a name is lost, the fallback is an npm scope you own
(`@<username>/jevcore` and matching leaves), which is what most of the DSH plugin
ecosystem does.

## 1. Pre-flight

```sh
pnpm install
pnpm run check          # typecheck + test + build across all three packages
```

Expected: 360 tests pass (266 core, 65 dsh, 29 mcp), with no credential set.

```sh
# Parse what this project builds against the vendors' real schemas. Offline.
pnpm --filter jevcore run check:schemas

# Drive the MCP server over a real stdio transport, on the mock. Offline.
pnpm --filter jevcore-mcp run smoke
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
pnpm --filter jevcore run probe:live          # provider level
pnpm --filter jevcore-mcp run smoke:live           # whole MCP surface
```

A passing run prints the real model (`typesafe/jev-1.13-<date>`), token usage and
cost, a `noul` probability, a `choice` selection, and a `score` with its legend
and per-level probabilities. **Delete the key from whatever shell or CI variable
you put it in afterwards.**

If you have a TypeSafe key instead, set `TYPESAFE_API_KEY` and select
`provider: live`; that route has the same primitives but has never been exercised
here, so treat the first run as a validation rather than a formality.

### Before filing the drafted issues or the skill proposal

Two artifacts are drafted for submission but live **outside** this repository, so
no test guards them:

- `typesafe-dsh-skill-proposal.md` — an issue for `typesafe-ai/skills`, containing
  a verbatim copy of the bundled `SKILL.md`;
- `typesafe-sdk-issue-drafts.md` — four issue bodies for the TypeSafe SDK that
  assert runtime behaviour of `@typesafe-ai/sdk`.

```sh
node tools/verify-submission-artifacts.mjs          # both checks; non-zero on drift
node tools/verify-submission-artifacts.mjs --sync   # refresh the skill copy first
```

The first check exists because the copy *did* go stale once: the proposal claimed
it could not drift from the shipped skill, and it had. The second re-runs every
reproduction in the SDK drafts, so a claim that a newer SDK invalidates is caught
here rather than in a maintainer's reply. See [tools/README.md](./tools/README.md).

```sh
# Confirm nothing in the artifacts reaches the network on the default path.
node packages/mcp/lib/bin.js 2>&1 | head -1
# expect: [jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; ...)
```

## 2. Repository URL — already set

All three manifests point at <https://github.com/PerryLink/jevcore>, which is
where the repository now lives. Nothing to do unless it moves; if it does, the
`repository`, `bugs` and `homepage` fields in all three manifests must move with
it, because npm's provenance link and every bug report follow those fields.

```sh
grep -rl 'github.com/PerryLink/jevcore' packages/*/package.json   # expect three files
pnpm install                                                     # let the lockfile record it
```

## 3. Version and log

1. Set the same version in all three manifests:
   `package.json`, `packages/core/package.json`, `packages/dsh/package.json`,
   `packages/mcp/package.json`.
2. Move the `CHANGELOG.md` entry from `unreleased` to that version and date it.
3. `pnpm install` so the lockfile records the workspace versions.

## 4. Inspect the tarballs before publishing

```sh
pnpm --filter jevcore pack --dry-run
pnpm --filter jevcore-dsh pack --dry-run
pnpm --filter jevcore-mcp pack --dry-run
```

Check for each: `lib/` is present, `README.md` and `LICENSE` are included, and
no source maps, test files, or `node_modules` content leaked in. The DSH tarball
must also contain `cordis.patch.yml` — without it the plugin installs and does
nothing.

## 5. Publish — a tag push, not a laptop

**0.1.0 is already published**, from a laptop, so this section is for the *next*
release. Do not push a `v0.1.0` tag: the workflow would try to publish versions
that already exist and npm would refuse them.

For the next release: bump the version in all four manifests, move the
`CHANGELOG.md` entry off `unreleased`, `pnpm install` so the lockfile records it,
then push the matching tag:

```sh
git tag -a v0.1.1 -m "0.1.1"
git push origin main --follow-tags
gh run watch                    # follow the Publish run
```

The `Publish` workflow (`.github/workflows/publish.yml`) triggers on a `v*` tag.
It verifies that every manifest agrees with the tag, re-runs the full check and
the vendor schema cross-check, then publishes the three packages **in dependency
order** with provenance. Order matters: both adapters depend on `jevcore`.

Requires the `NPM_TOKEN` repository secret described at the top of this file. If
that secret is missing the run fails rather than skipping — deliberately, because
a tag that "passes" while publishing nothing is easy to mistake for a release.

You can rehearse without publishing: **Actions → Publish → Run workflow** with
`dry-run` left checked. It packs and verifies, and stops.

Publishing by hand is possible but second best, because it has no provenance
attestation — and it is how 0.1.0 went out:

```sh
# Needs a token in the environment. `pnpm`, never `npm`, so the `workspace:*`
# dependency is rewritten to a real version.
pnpm --filter jevcore publish --access public --no-git-checks
pnpm --filter jevcore-dsh publish --access public --no-git-checks
pnpm --filter jevcore-mcp publish --access public --no-git-checks
```

Then verify by installing from the registry into an empty directory, not by
reading the publish output:

```sh
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install jevcore jevcore-dsh jevcore-mcp
node -e "import('jevcore').then(m => console.log(Object.keys(m).length, 'exports'))"
```

Note that pnpm publishes what is on disk in `lib/`, so run `pnpm run build`
first — the workflow does this as part of `pnpm run check`.

## 6. Tag and push

That is the same command as section 5; the tag *is* the release trigger.

```sh
git tag -a v0.1.1 -m "0.1.1"     # not v0.1.0; that version is already on npm
git push origin main --follow-tags
```

## 7. Verify from a clean directory

Do not trust the publish output; install what you actually shipped.

```sh
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install jevcore jevcore-dsh jevcore-mcp
node -e "const c = require('jevcore'); console.log(Object.keys(c).length, 'core exports')"
```

Then, for the DSH plugin, install it into a **throwaway profile** and confirm the
row reaches `active` and the egress report appears:

```sh
dsh plugin --profile verify-jev add jevcore-dsh
```

For the MCP server:

```sh
npx -y jevcore-mcp    # should print the egress report to stderr and wait
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
