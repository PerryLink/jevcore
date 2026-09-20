<!--
  Generated from docs/approval.md. Do not edit this copy: the next sync overwrites it.
  Regenerate with `node scripts/sync-package-docs.mjs` from the repository root.
-->

# Approval: what `ask` does in a deployment that cannot ask anyone

The safety gate has three decisions: `allow`, `deny`, and `ask`
(`packages/core/src/gates/safety.ts:173-187`). Two of them are answers. `ask` is
not: it is a question the gate hands to the host, and whether a human ever sees
it depends on the deployment, not on this plugin.

In a DSH deployment with no approval service composed, the host turns every
`ask` into a `deny` and reuses the gate's own reason as the denial text.
An operator who enables the gate and does not know this reads the result as
"the plugin is broken: every shell command is now refused".

This page states what actually happens, how to tell the denial paths apart, and
what your options are. Every claim is cited to the file that enforces it.

---

## 0. The path an `ask` takes

1. The gate judges the call and returns a decision. It asks when Jev flags a
   hazard, when the severity it assigned is at or above the configured block
   level, or when it cannot decide and `onUndecided` is `ask` (the default)
   (`packages/core/src/gates/safety.ts:345-395`).
2. The plugin's listener forwards that decision as the host's `PreToolDecision`
   (`packages/dsh/src/index.ts:357-371`). It calls `next()` only on `allow`, so
   the gate can refuse a call and can never approve one another listener
   refused.
3. The host resolves the `ask` in `serviceAsk` before anything is dispatched
   (`D:\deepseek-harness\packages\core\tools\src\index.ts:1486-1489` and
   `:1698-1738`).
4. If the resolution is a denial, the tool body never runs. The call is
   materialized as an error result whose text is `Error: <reason>`
   (`...core/tools/src/index.ts:1496-1508`). That is what the model reads, and
   what the session transcript records.

---

## 1. What happens with no approval service: a plain deny

The host consumes the seam opportunistically. This is the whole of the
degradation, from
`D:\deepseek-harness\packages\core\tools\src\index.ts:1702-1708`:

```ts
const approval = this.ctx.get('approval')
if (approval === undefined) {
  return {
    decision: {
      kind: 'deny',
      reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`,
    },
    approvalCancelled: false,
  }
}
```

The host's own event documentation states the rule in one line, at
`...core/tools/src/index.ts:139`: "approval support turns `ask` into denial".

Four consequences follow, and each one answers a question an operator asks:

- **It is a plain deny, not a distinct outcome.** There is no separate
  "no approver" decision kind (`PreToolDecision` is `allow` / `deny` / `cancel` /
  `ask`, `...core/tools/src/index.ts:589-593`) and no distinct error code. The
  call fails the way a policy denial fails.
- **Nothing is logged.** `serviceAsk` contains no logger call
  (`...core/tools/src/index.ts:1698-1738`). The host does not warn that a
  decision it could not escalate became a refusal.
- **`ask.reason` is used verbatim when it is present**, and this plugin always
  supplies one: the listener forwards the gate's reason
  (`packages/dsh/src/index.ts:369`), and the gate builds one for every `ask`
  (`gates/safety.ts:328-343`). So the host's fallback text
  (`requires approval (not yet supported)`) is not what you will see; the gate's
  own reason is.
- **The reason is therefore the only description of what happened.** In a
  deployment with no approver, a flagged call produces a transcript line like
  this, built by `stopReason` (`gates/safety.ts:334-342`):

  ```text
  Error: jevcore safety gate: Jev flagged irreversible_destruction; the severity "high" is at or above the "high" block level.
  ```

  The call did not run, and there is nothing anywhere that could approve it.

That last consequence is understood in this repository's own code. The comment
above `stopReason` says the reason is kept free of any instruction precisely
because a host with no approval service converts the `ask` into a denial while
keeping this text:
"`approve to proceed` is an instruction the operator cannot follow in exactly the
deployment where they are most likely to be reading it"
(`packages/core/src/gates/safety.ts:316-327`). An earlier revision of the gate
did say "Approve to proceed" on the way to a denial; the wording is fixed, the
mechanism this page is about is not.

The undecided path produces the same kind of text, naming the question rather
than a hazard: `jevcore safety gate: could not judge credential_exposure.`
(`gates/safety.ts:389-392`), and an unreachable Jev produces
`jevcore safety gate could not reach Jev (<detail>).` (`gates/safety.ts:428-431`).

---

## 2. Telling the denial paths apart

Several different situations end in a denied tool call, and the text is the only
signal you get. It is worth reading exactly.

| What the model receives | What happened | Where |
|---|---|---|
| `Error: jevcore safety gate: <the gate's reason>` | **No approval service is composed.** The `ask` had nowhere to go, and the deny inherited the gate's own reason | `...core/tools/src/index.ts:1702-1708` |
| `Error: tool "pwsh" requires approval, but no approval channel is available` | The service is composed, but no answerer answered: none is registered, or one threw or returned a value outside the vocabulary (normalized to `unavailable`) | `...core/tools/src/index.ts:1732-1735`; `...interaction/user-approval/src/index.ts:273-285` |
| `Error: the user rejected tool "pwsh"` | The session policy is `never`, which rejects every ask deterministically, **or** a human said no | `...core/tools/src/index.ts:1724-1727`; `...interaction/user-approval/src/index.ts:268` |
| `Error: approval for tool "pwsh" was cancelled` | The call's signal aborted while the question was open | `...core/tools/src/index.ts:1728-1731` |
| `Error: jevcore safety gate: could not judge <question> (onUndecided=deny).` | You set `onUndecided: deny`. The gate denied the call itself; no approval was consulted | `gates/safety.ts:383-388`; `packages/dsh/src/index.ts:366-369` |

There is also a denial for an `ask` with no agent attached
(`requires approval, but the call has no agent to route it through`,
`...core/tools/src/index.ts:1709-1713`), which is not reachable from a normal
agent-scoped tool call.

The practical test: a *human "no"* and a *policy `never`* produce the same
string, so read the session policy before concluding that someone declined. A
missing approver is the only one of these whose text names this plugin's gate.

---

## 3. Which deployments have an approver

The seam is `ctx.get('approval')`, and it is the same lookup the tool registry
uses for its own purposes
(`peekApprover: () => this.ctx.get('approval')`,
`...core/tools/src/index.ts:927`). Whether it resolves to anything is a property
of the composition:

- **DSH's base bundle composes the service**
  (`D:\deepseek-harness\packages\bundle\base\cordis.patch.yml:231-234`), with the
  policy chosen from the environment:

  ```yml
  - id: approval
    name: '@deepseek-ai/dsh-user-approval'
    config:
      policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
  ```

  The `web`, `headless` and `acp` bundles layer over `base`, so they have the
  service. The web bundle also composes the client-side prompt
  (`packages/bundle/web-app/cordis.patch.yml:272-273`).

- **The minimal SDK bundle does not.** Its patch opens with "this bundle does not
  layer over dsh-base: this insert is the complete Cordis tree"
  (`packages/bundle/sdk-minimal/cordis.patch.yml:1-3`) and composes no approval
  row at all. In that deployment `ctx.get('approval')` is `undefined` and every
  `ask` takes the deny path in section 1.

- **A composed service is not the same as a human being asked.** Two settings
  still deny without asking anyone: a policy of `never` (the base bundle selects
  it whenever `DSH_PERMISSION_MODE` is `danger-full-access`), and a composition
  with no answerer registered on `approval/request`, which fails closed as
  `unavailable` (`...interaction/user-approval/src/index.ts:50-60` and
  `:268-285`).

- **A session running under `never` says so in its own system prompt.** The
  service is the only thing that adds the approval-policy sentence
  (`...interaction/user-approval/src/index.ts:155-167`), and the two sentences
  differ: a session whose runtime context says approval prompts are disabled is
  under `never`. If no such sentence appears at all, consider whether any
  approval service is mounted.

---

## 4. Your options, honestly

The gate's defaults are `enabled: false, onUndecided: ask`
(`packages/core/src/config.ts:263-266`), so nothing below is forced on you.
These are the real choices, with the configuration each one needs.

**1. Leave the safety gate off.** This is the default and a defensible choice:
the gate is the only part of this plugin that reads your tool calls, and turning
it off keeps the plugin to the three tools.

**2. Mount an approver, then enable the gate.** This is the only option that
makes `ask` mean what it says. You need both halves: the service, and something
listening on `approval/request` (a UI or an ACP client). The service row is the
one DSH's base bundle already carries (section 3). Then run the session under a
policy of `ask`, not `never`, and enable the gate:

```yml
- insert:
    - id: jev
      name: 'jevcore-dsh'
      config:
        gates:
          safety:
            enabled: true
            onUndecided: ask
```

**3. Make the refusal say what happened: `onUndecided: deny`.** With no approver
this changes nothing about *whether* an undecided call runs; it changes the
reason, from a sentence naming the question to one that states the gate denied
it (`gates/safety.ts:383-388`). It is the strictest setting the config surface
offers, and the only one that removes the ambiguity without removing the gate:

```yml
        gates:
          safety:
            enabled: true
            onUndecided: deny
```

Be clear about what it does not do. **A raised hazard, and an escalated
severity, do not consult `onUndecided` at all**: `decide` returns `ask` for both
before it reads the setting (`gates/safety.ts:373-380`). In a deployment with no
approver those `ask` decisions are still denied, carrying the gate's own reason.
So option 3 makes the undecided path explicit and leaves the other two paths
exactly as they were.

**4. Narrow what is gated: not available from plugin configuration.** The
`createSafetyGate` API takes `toolPatterns` (`gates/safety.ts:207`, applied at
`:402`), but the plugin never passes it
(`packages/dsh/src/index.ts:344-353`), so the gate always uses the fixed list
`DEFAULT_GATED_TOOL_PATTERNS` (`gates/safety.ts:158-171`): `pwsh`, `bash`,
`shell`, `exec`, `write`, `edit`, `delete`, `remove`, `move`, `rename`, `git`,
`run_code`. Matching is a case-insensitive substring test, so in a `ptc` session
the single visible `run_code` tool is gated for every program it runs.

A `toolPatterns:` key written into the plugin config is **silently ignored**:
the gate reader returns only `enabled` and `onUndecided`
(`packages/core/src/config.ts:304-326`), and the loader validates with that same
reader (`packages/core/src/schema.ts:44-51`). Narrowing means composing your own
`tools/pre-execute` listener that calls `createSafetyGate` with your patterns,
or changing the constant. Until then, the gate's coverage is all or nothing.

**5. Do not reach for `onUndecided: allow`.** It is the setting that looks like
an escape hatch and is not one:

- It cannot fix the common case. A raised hazard, and a severity at or above the
  block level, return `ask` before the setting is read
  (`gates/safety.ts:373-380`), so those calls are still denied by a deployment
  with no approver.
- It removes the floor for the case it does control. `allow` means an answer
  below your confidence and probability thresholds is treated as permission,
  which is the opposite of what the gate is for
  (`gates/safety.ts:12-13`).

One thing to know before you enable the gate at all: since the severity
dimension was added, a call can be asked about **without raising any hazard**,
because its severity alone reached the block level
(`gates/safety.ts:368-380`). The shipped block level is `high`
(`DEFAULT_SAFETY_SEVERITY_BLOCK`, `packages/core/src/config.ts:97`), resolved
once from that default unless the gate's caller passes `severityBlock`
(`gates/safety.ts:314`), and the comparison is `at or above`
(`gates/safety.ts:261-262`). In a deployment with no approver, that widens the
set of calls that become refusals.

The honest summary: with no approver, an enabled safety gate denies the calls it
asks about, and no setting short of disabling the gate or mounting an approver
changes that. Configure `deny` if you want the undecided path to be explicit,
mount an approver if you want the gate to be a gate, and leave it off if you
want neither.

---

## 5. Checking a deployment

- Read the composition for the `@deepseek-ai/dsh-user-approval` row. No row
  means every `ask` is a deny.
- Read the session policy. `never` means every `ask` is a rejection that names
  the user.
- Read the denial text against the table in section 2. It distinguishes the two.
- The plugin's own startup line reports the gates, not the approver
  (`packages/dsh/src/index.ts:401-405`):

  ```text
  [jevcore] ready · provider=mock · gates: safety=on context=off
  ```

  Nothing in the plugin checks `ctx.get('approval')`, so `safety=on` in a
  deployment with no approver is the configuration this page is about. A startup
  warning for that case is a reasonable change to the plugin; it is not
  implemented here.

For the timing and cost boundaries of the same plugin, see
[limits.md](./limits.md). For the gate's own configuration surface, see
[packages/dsh/README.md](../packages/dsh/README.md).
