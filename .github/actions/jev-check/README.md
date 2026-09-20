# Jev judgment

Turn one narrow CI question into a calibrated probability, and branch on the number
instead of on prose.

This action is a thin shell over the [`jev` CLI](../../../packages/cli). It exists so a
workflow can use the same decision core, egress contract, and redaction path that the
library, the MCP server, and the DeepSeek Harness plugin use — rather than a re-implementation
that drifts from them.

## The design rule this action follows

**A probability is not a permission.** A Jev call returns a number and a verdict; what that
number is allowed to authorise is a policy decision belonging to the workflow that owns it.
So the action's default is `fail-on: never`: it reports, and you branch on the outputs.

## Usage — verify a claim against evidence

```yaml
- uses: PerryLink/jevcore/.github/actions/jev-check@main
  id: claim
  with:
    command: check
    claim: 'The retry policy has no total budget; the timeout applies per attempt.'
    evidence-file: docs/limits.md
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
    version: '0.4.0'

- if: steps.claim.outputs.exit-code == '1'
  run: echo "::error::the evidence contradicts the recorded claim"
```

## Usage — dry-run the safety gate

```yaml
- uses: PerryLink/jevcore/.github/actions/jev-check@main
  id: gate
  with:
    command: gate
    tool: pwsh
    args-json: '{"command":"git push --force origin main"}'
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

`gate` judges a *hypothetical* tool call. It runs nothing, so it is safe on any runner, and it
is the only way to see what the gate would decide without a live session.

## Exit codes

The action surfaces the CLI's own exit code as an output. It is available whether or not the
step failed, so a later step can apply its own policy.

| command | code | meaning |
| --- | --- | --- |
| `check` | `0` | `supported` — the evidence settles the claim |
| `check` | `1` | `contradicted` — the evidence refutes the claim |
| `check` | `3` | `conflicted`, `insufficient`, `undecided`, or `unknown` |
| `gate` | `0` | `allow` |
| `gate` | `1` | `deny` |
| `gate` | `2` | `ask` — a human should confirm |
| either | `64` | the action was given bad inputs |

Those are three outcomes for `check`, not two, on purpose. "The evidence does not establish
this" and "the evidence refutes this" are different findings, and collapsing them is how a
missing citation gets reported as a refutation.

## Inputs

| input | default | notes |
| --- | --- | --- |
| `command` | — | `check` or `gate` |
| `claim` | — | required by `check` |
| `evidence-file` | — | required by `check`; `-` reads stdin |
| `tool` | — | required by `gate` |
| `args-json` | `{}` | required by `gate` |
| `fail-on` | `never` | `never`, `contradicted`, `deny-or-ask`, `any-nonzero` |
| `api-key` | — | pass `${{ secrets.TYPESAFE_API_KEY }}` |
| `model` | — | pin a version if you want a reproducible verdict |
| `mock` | `false` | offline; measures nothing, and says so in the log |
| `version` | `latest` | the `jevcore-cli` version to run |

## Outputs

| output | meaning |
| --- | --- |
| `exit-code` | the CLI's exit code, as a string |
| `result-json` | the `--json` document from stdout, verbatim. Diagnostics stay on stderr and out of this value, so it parses. |
| `summary` | the last prose line the CLI wrote to stderr, or the exit code when it wrote none |

## Two things worth knowing before you wire this into a required check

- **`fail-on: any-nonzero` is usually a mistake for `check`.** It fails the job on the
  "could not decide" outcomes too, which turns *we do not know* into *no*.
- **`mock: true` measures nothing.** It exercises the workflow's plumbing without a key or a
  network call, and the action emits a warning saying exactly that. It is not a cheap way to
  get a real verdict.

## Security

Inputs reach the script through environment variables, never by interpolation into the script
text. A claim can come from a pull request body, and `${{ }}` substitution happens before the
shell sees the line — an interpolated value containing shell syntax would execute. Environment
variables are data and cannot become code.

The API key is exported for the CLI to resolve and is never echoed.
