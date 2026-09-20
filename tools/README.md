# tools/

Scripts that keep the **submission artifacts** honest.

Everything this project *ships* is covered by `pnpm run check`. Three drafted
files are not shipped, and no test can reach them:

| Artifact | Where it lives | What can go wrong |
|---|---|---|
| `typesafe-dsh-skill-proposal.md` | beside this repository | contains a verbatim copy of the bundled `SKILL.md`, which silently goes stale |
| `typesafe-sdk-issue-drafts.md` | beside this repository | asserts runtime behaviour of `@typesafe-ai/sdk` that a new release can change |
| the bundled skill itself | `packages/dsh/skills/` | is the source of truth for the copy above |

A stale proposal or an obsolete bug report is invisible until a maintainer reads
it, which is the worst time to find out. So the checks are a command.

```sh
# Check everything. Exits non-zero if the proposal is stale or a claim no longer
# holds. Run this before pasting anything into an issue tracker.
node tools/verify-submission-artifacts.mjs

# Refresh the proposal's embedded skill copy, then report again.
node tools/verify-submission-artifacts.mjs --sync
```

## What each script does

- **`sync-proposal-skill.mjs`** — compares the fenced draft inside the proposal
  against `packages/dsh/skills/typesafe-ai-dsh/SKILL.md` and reports the first
  differing line. `--check` reports without writing; `--sync` updates the copy.
  Preserves the proposal's own line-ending convention and BOM.
- **`verify-sdk-issue-claims.mjs`** — runs every reproduction in the SDK issue
  drafts against the installed `@typesafe-ai/sdk`, offline and without a key:
  the error taxonomy (402/409/413 must still fall through to the base
  `APIError`), the retry defaults, and the `retry-after-ms` clamping asymmetry.
  When a claim stops holding it says the draft is obsolete rather than passing
  quietly.
- **`verify-submission-artifacts.mjs`** — runs both and exits non-zero if either
  fails.

## Paths

The scripts resolve the workspace from their own location: this directory's
parent is the repository root, and the two drafted markdown files are expected
beside that root. Copy `tools/` next to the drafts on another machine and the
same commands work.

Both scripts are also safe to run from anywhere, and neither writes anything
without an explicit flag.
