# jevcore-cli

The `jev` command line: TypeSafe [Jev](https://typesafe.ai) decisions from a
shell, a script, or a CI job.

This package is a fourth entry point over the same decision core as the library,
the MCP server, and the DeepSeek Harness plugin. Nothing here re-implements a
judgment:

- `jev ask` calls `JevService.ask`, so the egress contract and the redaction path
  apply exactly as they do in a session;
- `jev check` calls `resolveCheck`, the same resolver the MCP tool uses;
- `jev gate` calls `createSafetyGate`, the same function the harness registers;
- `jev egress` calls `EgressContract.reportLines`, the contract's own
  self-description.

A decision made at a prompt therefore means what it means inside an agent.

## Install

```sh
npm install -g jevcore-cli
```

The offline mock provider is the default and needs nothing else. A live route
needs `@typesafe-ai/sdk`, which is an optional dependency of the core.

## The commands

| Command | What it answers |
|---|---|
| `jev ask` | A batch of typed questions — noul, choice, score — about one state |
| `jev check` | One of six verdicts for a claim against evidence, plus the probabilities |
| `jev rank` | Candidates ordered by relevance, with a probability each |
| `jev gate` | What the safety gate would decide about a tool call, without running it |
| `jev egress` | What this tool may send, and the cap on every field |
| `jev models` | Which model and endpoint each route would use |

Every command supports `--json` for machine-readable output and prints a
human-readable form by default. The field names under `data` are stable, in the
same way the exit codes are.

## Asking a question

```sh
jev ask --state record.json --questions questions.json --feature tool:jev_ask
```

```json
{
  "usable": {
    "type": "noul",
    "instructions": "Is this record usable?",
    "boundary": { "true": "it can be used as it stands", "false": "it cannot" }
  }
}
```

`--feature` selects the egress feature the call travels under. It must be one of
the declared features, and an undeclared name is a hard error listing them —
because the contract, not the command line, decides what may leave the machine.

## Checking a claim

```sh
jev check --claim "the build is reproducible" --evidence build.log
```

```
claim: the build is reproducible
evidence: 4821 chars — "commit 3f9a1c2 ..."
verdict: supported  (supports=0.95 contradicts=0.05 sufficient=0.90)
```

The verdict is one of six words, and they are not two words with four synonyms:

| Verdict | Meaning |
|---|---|
| `supported` | The evidence supports the claim and was judged sufficient |
| `contradicted` | The evidence contradicts the claim |
| `conflicted` | The evidence supports the claim and contradicts it |
| `insufficient` | The evidence does not establish the claim |
| `undecided` | The evidence settles the question but points neither way |
| `unknown` | No measurement came back at all |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | `check` supported the claim; `gate` allowed the call; the command printed |
| `1` | `check` contradicted the claim; `gate` denied the call; an input error |
| `2` | `gate` would ask a human before proceeding |
| `3` | `check` returned `conflicted`, `insufficient`, `undecided`, or `unknown` |
| `64` | The command line itself is wrong |

Exit code `3` exists because the last four verdicts are findings about the
*evidence*, not about the claim. A script that read them as "not supported" would
be reporting a refutation nobody measured, and in CI that is the difference
between "this claim is false" and "this repository cannot tell".

## The gate, dry-run

```sh
jev gate --tool git --args-json '{"command":"push --force"}' --severity-block high
```

```
jev gate git
decision: ask  severity: high  (blocks at high)  exit: 1
  RAISED  external_side_effect
reason: jevcore safety gate: Jev flagged external_side_effect; the severity "high" is at or above the "high" block level.
nothing was executed: this is a dry run, and the arguments above are data.
```

This is the command worth knowing about. The gate is off by default in a session
and its job is to be invisible until something is dangerous, so there was no way
to ask what it would do without arranging a dangerous tool call. Here the tool
name and its arguments are **data**: no tool is invoked, no file is touched, no
process is started.

The decision comes from `createSafetyGate`, so it is the same decision a session
would get. The hazards it judges are declared in the core and are printed by
`jev egress --feature gate:safety`: irreversible destruction, privilege
escalation, credential exposure, external side effects, and history rewriting,
plus a severity score.

## What may leave the machine

```sh
jev egress
```

```
provider: mock  endpoint: none  transmitting: no
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
ARMED  gate:safety
         state <= 8000 chars - the tool name, its arguments, and the session working directory
         questions <= 2000 chars - the fixed hazard questions
```

`EgressContract` is the single place that decides what may leave the machine.
Every feature declares the fields it would send and the cap on each, the contract
describes itself, and this command prints that description as it applies to the
invocation you are about to run.

Both routes are **off by default**. `--provider live` and `--provider openrouter`
transmit; anything else runs against the offline mock, which answers from a hash
of the input, opens no socket, and labels every result as synthetic on stderr as
well as in the payload.

Redaction runs over everything that leaves, and its limit is stated rather than
hidden: it removes values under recognised field names and strings matching known
secret shapes, and it cannot recognise an unrecognised secret written into free
text.

## Configuration

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | Credential for the `live` provider |
| `OPENROUTER_API_KEY` | Credential for the `openrouter` provider |
| `JEV_PROVIDER` | Default for `--provider` |
| `TYPESAFE_BASE_URL` | Default for `--endpoint` on the `live` route |
| `OPENROUTER_BASE_URL` | Default for `--endpoint` on the `openrouter` route |

A credential is never printed, logged, or echoed. The tool reports which source a
key came from — the environment, or a credential service — and nothing more.

## Avoiding a surprise

| Flag | Effect |
|---|---|
| `--mock` | Force the offline mock provider |
| `--json` | Machine-readable output on stdout; every note goes to stderr |
| `--model` | Model to call |
| `--endpoint` | API root for a transmitting provider |

## Development

```sh
pnpm install
pnpm --filter jevcore-cli run test
pnpm --filter jevcore-cli run typecheck
```

No test in this package needs a credential or a socket. The live route is
exercised through a stub SDK module named by an environment variable, so a
developer's real key cannot turn a test into a network call.

## License

[Apache License 2.0](LICENSE) © 2026 jevcore contributors. TypeSafe, Jev, and
System One are trademarks of TypeSafe AI; this is an independent integration and
is not affiliated with or endorsed by them.
