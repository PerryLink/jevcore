# Contributing

Thanks for looking. This is a small project with a narrow purpose, and the
guidance below is mostly about keeping that purpose narrow.

## What this project is

Three packages over one decision layer:

| Package | What it is |
|---|---|
| `@dsh-jev/core` | The decisions. No framework dependency — it imports nothing from DeepSeek Harness or Cordis. |
| `dsh-jev` | The DeepSeek Harness plugin: three tools, one service, two opt-in gates. |
| `@dsh-jev/mcp` | The same three tools over MCP, for hosts that are not DSH. |

Jev answers typed questions and returns calibrated probabilities. It does not
generate text. Any change that treats it as a chat model is out of scope.

## The invariants

These are the reasons the project exists. A change that breaks one will be
declined regardless of how useful it otherwise is.

1. **Offline by default.** A fresh install makes no network call. The provider
   defaults to the offline mock, and every feature that could transmit is off
   unless configuration turns it on.
2. **Transmission is disclosed.** Every feature that can send content declares
   the fields it sends and the cap on each, in `packages/core/src/egress.ts`.
   The plugin prints that contract at load. A feature that transmits without
   appearing there is a bug.
3. **A judge that cannot answer must not mean "allow".** If Jev is unreachable
   or unsure, the outcome routes through `onUndecided`, which defaults to `ask`.
   Fail-open exists only as an explicit choice. The context gate is the one
   deliberate exception, and it is documented as such.
4. **The model cannot widen its own constraints.** No tool changes gate
   configuration, thresholds, or scope.
5. **A missing answer is reported as missing.** Nothing is filled in. If Jev
   returns no answer, the result says so rather than substituting a default or a
   fabricated probability.
6. **A probability is not a permission.** Thresholds live in local
   configuration. Model output never decides what is permitted.

## Development

```sh
pnpm install
pnpm run check      # typecheck + test + build, every package
pnpm run test       # tests only
```

Node 20 or newer. No test may require a credential or a network connection —
CI clears `TYPESAFE_API_KEY` and expects the suite to pass anyway. If your change
needs a live API to verify, add it to a manual script rather than the test suite.

## Before you open a pull request

- `pnpm run check` passes.
- New behaviour has a test. Behaviour that is a *guarantee* — "this makes no
  network call", "a disabled gate registers nothing" — has a test that would
  fail if the guarantee were broken.
- Public functions have a doc comment that says why the thing exists, not what
  the signature already says.
- If you changed what leaves the machine, `packages/core/src/egress.ts` and both
  READMEs were updated together. A privacy claim that only exists in prose will
  drift.

## Reporting a security issue

Please do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Scope

Welcome: better judgments, better prompts for the primitives, additional
framework adapters over `@dsh-jev/core`, documentation fixes, and bug reports
with a reproduction.

Out of scope: anything that turns this into a general-purpose LLM client;
default-on transmission; web routes without authentication; and changes that
require an API key to run the test suite.
