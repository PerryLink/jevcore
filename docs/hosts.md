# Hosts: wiring `jevcore-mcp` into an MCP client

`jevcore-mcp` is one stdio binary exposing three tools — `jev_ask`, `jev_rank`,
`jev_check`. What differs between hosts is not the server; it is the names in
their configuration files. They are not compatible with each other:

| Host | File | Top-level key | Stdio entry | Environment key |
|---|---|---|---|---|
| Claude Code | `.mcp.json`, `~/.claude.json` | `mcpServers` | `command` + `args` | `env` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | `command` + `args` | `env` |
| Cursor | `mcp.json` | `mcpServers` | `command` + `args` | `env` |
| VS Code | `.vscode/mcp.json` | **`servers`** | `type: "stdio"` + `command` + `args` | `env`, `envFile` |
| Zed | `settings.json` | **`context_servers`** | `command` + `args` | `env` |
| OpenCode | `opencode.json(c)` | **`mcp` → `<name>`** | **`type: "local"`** + `command` **array** | **`environment`** |
| DeepSeek Harness | a bundle patch | — | `transport: stdio` + `command` + `args` | `env` on the MCP row |

Every snippet below is labelled with what it rests on: **per official docs** (with
the link), **measured here** (a command and its result), or **reported** (someone
else's observation, not reproduced). No MCP *host* was installed or run while
writing this page; only the server side was driven, over a real stdio MCP client.

The snippets use the package's documented launch line, `npx -y jevcore-mcp`.
**Read §0 before copying one**: on the published 0.2.2 that line does not start the
server, and §7 gives the form that does.

---

## 0. The launch command, and two defects in the published 0.2.2

The command the package documents is:

```sh
npx -y jevcore-mcp
```

**On `jevcore-mcp@0.2.2` this does not start a usable server — on any platform
tested — and it fails silently rather than reporting an error.** Read the two
defects below before configuring a host, and use the explicit `node` form in
§7 instead.

**Measured, from the published tarball** (`npm pack jevcore-mcp@0.2.2`, extracted
and inspected):

1. **`lib/bin.js` does not begin with `#!`.** `package.json` declares
   `"bin": { "jevcore-mcp": "./lib/bin.js" }`, and npm builds its launcher from
   the target file's shebang. With no shebang there is no interpreter to record,
   so the launcher executes the `.js` file directly instead of running it under
   `node` — which is what it did on both platforms tested here:

   - **Windows, measured end to end.** `npm install jevcore-mcp@0.2.2` in a temp
     prefix produced `node_modules/.bin/jevcore-mcp.cmd` whose entire body is
     `"%dp0%\..\jevcore-mcp\lib\bin.js"   %*` — no `node` anywhere in it. This
     machine associates `.js` with `WScript.exe` (`assoc .js` → `JSFile`,
     `ftype jsfile` → `C:\Windows\System32\WScript.exe "%1" %*`), so the shim
     hands an ES module to the Windows Script Host. Driving that `.cmd` as a
     stdio MCP server produced **no handshake in 8 seconds** and left a stray
     `WScript.exe` behind. That is the hang the repository's smoke test documents
     in its own comments.
   - **macOS and Linux, not measured here** (no POSIX host in this session): the
     launcher executes the file directly as well, and the kernel will not exec a
     file without a shebang. The repository's smoke test asserts the shebang for
     exactly this reason.

   The same npm, the same `bin` path, two different launchers — the shebang is the
   only variable:

   | Target file | Generated `jevcore-mcp.cmd` body |
   |---|---|
   | `jevcore-mcp@0.2.2` (no shebang) | `"%dp0%\..\jevcore-mcp\lib\bin.js"   %*` |
   | this repository's rebuilt `lib/bin.js` (`#!/usr/bin/env node`) | `"C:\Program Files\nodejs\node.exe" "%dp0%..\..\lib\bin.js" %*` |

   The fix is in the working tree, and the repository's smoke test now asserts the
   shebang and passes on the rebuilt output. **The published 0.2.2 does not carry
   it**, so until a release does, do not rely on `npx` for this package. Instead
   `npm install -g jevcore-mcp` (or install it in your project) and point the
   host's `command` at the file explicitly:

   ```json
   { "command": "node", "args": ["/absolute/path/to/node_modules/jevcore-mcp/lib/bin.js"] }
   ```

   **Measured**: a real MCP client driving `node <path>/lib/bin.js` completed the
   handshake, discovered the three tools, and answered all three (§9.2).
2. **The server reports version `0.1.0` while the package is `0.2.2`.** The
   published `lib/server.js` constructs the server with a literal version. Host
   logs will show `0.1.0`; it is cosmetic, and `src/server.ts` now reads the
   version from `package.json`.

How a host runs it: `command` + `args` + optional environment. The server writes
its protocol to **stdout** and its egress report to **stderr** — deliberately, as
the README says, because a stray line on stdout corrupts a stdio transport.

---

## 1. Claude Code

**Per official docs** — <https://code.claude.com/docs/en/mcp>

Project scope writes `.mcp.json` at the repository root and is meant to be
committed:

```json
{
  "mcpServers": {
    "jev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "jevcore-mcp"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```

The equivalent CLI (the docs are explicit that `--` separates Claude's own flags
from the server's):

```sh
claude mcp add --transport stdio jev \
  --env TYPESAFE_API_KEY=your-key-here \
  -- npx -y jevcore-mcp
```

Notes that come from the same page:

- `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url`, and
  `headers`. A `${VAR}` with no value and no default makes Claude Code *warn* and
  pass the literal text through — which for `TYPESAFE_API_KEY` means the server
  starts on the mock rather than failing.
- Claude Code reads credential-named variables as empty in a **remote** server's
  `url` and `headers`. That rule is documented for remote servers; the `env` of a
  stdio server expands normally.
- A missing executable produces `spawn <name> ENOENT` — the error class Windows
  users hit with a bare `npx` (see §7).
- Its MCP runtimes are built on the official MCP TypeScript SDK (v1 on SDK 1.x;
  the v2 runtime is "the same code on MCP TypeScript SDK 2.0"). Both spawn through
  `cross-spawn` — **measured** for the two packages installed in this checkout, see
  §7.

## 2. Claude Desktop

**Per official docs** —
<https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers>
(the old `quickstart/user` URL redirects here).

Configuration file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "jevcore-mcp"],
      "env": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

Reach it through **Settings → Developer → Edit Config**, then restart Claude
Desktop completely. The same page documents a Windows failure worth knowing:
if the server's log complains about `${APPDATA}` inside a path, add the *expanded*
value to `env` (`"APPDATA": "C:\\Users\\you\\AppData\\Roaming\\"`), and notes that
`npx` may need npm installed globally. Logs live in `%APPDATA%\Claude\logs`
(Windows) and `~/Library/Logs/Claude` (macOS); the docs say the per-server file is
named `mcp-server-<SERVERNAME>.log`, so a server named `jev` writes its stderr —
including the egress report — to `mcp-server-jev.log`.

## 3. Cursor

**Per official docs** — <https://cursor.com/docs/mcp>

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "jevcore-mcp"],
      "env": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

The docs name the file `mcp.json` and say servers can be installed and managed
from the **Customize** page, which opens the right file for the scope you are
editing (project or global). The page does not state the two full filesystem
paths; this document does not guess them. Remote servers use `url` + `headers`
instead of `command`.

## 4. VS Code

**Per official docs** —
<https://code.visualstudio.com/docs/agent-customization/mcp-servers> and the field
reference <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>

The key is **`servers`**, not `mcpServers`, and a stdio server declares
`"type": "stdio"`:

```json
{
  "servers": {
    "jev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "jevcore-mcp"],
      "env": { "TYPESAFE_API_KEY": "${input:typesafe-key}" }
    }
  }
}
```

- Workspace file: `.vscode/mcp.json` (committed, shared with the team). User file:
  **MCP: Open User Configuration** from the Command Palette. A dev container can
  carry the same `servers` block under `customizations.vscode.mcp`.
- `env` accepts strings, numbers, or null; `envFile` loads more variables from a
  file, which the docs recommend over hardcoding a key. `${input:...}` variables
  are the documented way to prompt for a secret — the reference has an
  "input variables for sensitive data" section defining the `inputs` block, whose
  exact schema is not reproduced here (not verified).
- Note for Agent Host sessions: `.vscode/mcp.json` is forwarded rather than read
  directly by the Agent Host.

## 5. Zed

**Per official docs** — <https://zed.dev/docs/ai/mcp>

Zed calls them **context servers**, so the top-level key is `context_servers`:

```json
{
  "context_servers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "jevcore-mcp"],
      "env": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

`command` and `args` are separate fields, and the env key is `env`. Manage it under
**Settings → AI → MCP Servers** (or `zed: open settings file`); a green dot beside
the name means the server is active. Two further documented details:

- Tool approval is controlled by `agent.tool_permissions.default`
  (`"confirm"` by default), and per-tool rules use the key form
  `mcp:<server>:<tool_name>` — here `mcp:jev:jev_ask`, `mcp:jev:jev_rank`,
  `mcp:jev:jev_check`. All three are read-only judgments, so auto-approving them is
  a defensible choice.
- Zed forwards configured MCP servers to **external agents** (Claude Code, Codex,
  …) over ACP, and those agents may also read their own native MCP config — so the
  same server can be registered twice if you configure both.

## 6. OpenCode

**Per official docs** — <https://opencode.ai/docs/mcp-servers/> (Windows:
<https://opencode.ai/docs/windows-wsl>)

OpenCode differs in three of the four names: the map is `mcp`, a local server
declares `"type": "local"`, and `command` is a **single array** holding the command
and its arguments. The environment key is `environment`, not `env`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "jevcore-mcp"],
      "enabled": true,
      "environment": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

- Options documented for a local server: `type`, `command`, `cwd`, `environment`,
  `enabled`, `timeout` (tool-fetch timeout, default **5000 ms**). A first `npx`
  run may need to download the package, so a cold start can exceed that; raise
  `timeout` if the tools never appear.
- `{env:VAR}` substitution appears in the docs' remote/OAuth examples. Whether it
  also applies inside `environment` is not stated on that page — use a literal
  value, or verify it yourself.
- OpenCode's Windows page recommends running OpenCode inside WSL. Inside WSL you
  are on the POSIX launch path, where the missing shebang of §0 applies; a
  locally installed copy launched through `node` is the safe form there.

## 7. Windows

Two separate questions get conflated here: can the host *find* `npx`, and can the
`npx` launcher *start this server*. The first is a Windows problem the official
SDKs solve; the second is a defect in the published package that affects every
platform.

### Measured on Windows (Node v22.22.3)

| Call | Result |
|---|---|
| `spawnSync('npx', ['--version'], { shell: false })` | `error.code = 'ENOENT'` |
| `spawnSync('npx.cmd', ['--version'], { shell: false })` | `error.code = 'EINVAL'` |
| `spawnSync('cmd', ['/c', 'npx', '--version'], { shell: false })` | exit `0` |
| `cross-spawn.sync('npx', ['--version'])` (pipes, as a client does) | exit `0`, stdout `11.16.0` |
| MCP client with `command` = the generated `jevcore-mcp.cmd` | no handshake in 8 s; stray `WScript.exe` |

Why the first four:

- There is no `npx` **executable** on Windows, only shims: `npx.cmd`, `npx.ps1`,
  and `npx` (the shell script). A `shell: false` spawn of the bare name searches
  `PATH` + `PATHEXT` for an executable image and finds none → `ENOENT`.
- Node refuses to spawn a `.cmd`/`.bat` without a shell (the CVE-2024-27980
  mitigation) → `EINVAL`. Both are Node-side policy, not a bug in npm.
- `cross-spawn` resolves the shim itself and builds the `cmd.exe` invocation, so
  `npx` is found. Both official MCP clients in this stack use it — **measured by
  reading the installed packages**: `@modelcontextprotocol/sdk@1.30.0`
  (`dist/esm/client/stdio.js`) and `@modelcontextprotocol/client@2.0.0`
  (`dist/stdio.mjs`, used by DeepSeek Harness) each contain
  `import spawn from "cross-spawn"`. A host built on either is not the problem.
- Claude Code documents the same failure class from the other side: a `command`
  that is not on `PATH` produces `spawn claude ENOENT`
  (<https://code.claude.com/docs/en/mcp>).

The fifth row is the one that bites: finding `npx` and letting `npx` start
`jevcore-mcp@0.2.2` are different things, and the second one fails (§0).

### What to write

1. **Point at the server file explicitly.** This is the only form verified end to
   end here, on Windows, with a real MCP client:

   ```json
   {
     "command": "node",
     "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\jevcore-mcp\\lib\\bin.js"]
   }
   ```

   It sidesteps shim resolution entirely, works under `shell: false`, and is what
   the repository's own smoke test does on Windows when no `node_modules/.bin`
   shim is present. Use your real install path (`npm root -g` prints the global
   one).
2. **If you must go through `cmd`**, this is measured to work as a spawn:
   `{ "command": "cmd", "args": ["/c", "npx", "-y", "jevcore-mcp"] }`. Prefer the
   `node` form: `cmd /c` re-parses its command line, so quotation inside the
   arguments is easy to get wrong, and some hosts escape arguments for a direct
   spawn rather than for `cmd.exe`. And on 0.2.2 it will still hit §0.
3. **Pass the key explicitly rather than relying on inheritance** (§9.1).
4. Claude Desktop documents a Windows-specific `ENOENT` of its own: a server log
   complaining about `${APPDATA}` inside a path is fixed by adding the expanded
   value to `env`, and `npx` may need npm installed globally.

## 8. DeepSeek Harness

**From this repository's own README** (`packages/mcp/README.md`,
`packages/dsh/README.md`): a configuration-only bundle whose patch inserts the
harness's MCP client.

```yml
- insert:
    - id: jev-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: jev
        transport: stdio
        command: node
        args: ['/absolute/path/to/node_modules/jevcore-mcp/lib/bin.js']
        env:
          TYPESAFE_API_KEY: '<the key>'
        failOnStartupError: true
```

Two departures from the README's snippet, both deliberate:

- `command` is `node` with the entry file rather than `npx -y jevcore-mcp`, for the
  reason in §0. The README's `npx` form is the documented install; on 0.2.2 it does
  not start the server.
- `env` carries the key. This host does not forward credential-shaped environment
  names to a child process, so a key exported in your shell never reaches the
  server — see the first pitfall below.

---

## 9. Known pitfalls

### 9.1 A host that filters environment variables silently drops `TYPESAFE_API_KEY`

**This one is verified in the harness source in this checkout, not reproduced by a
live call.** `@deepseek-ai/dsh-mcp-client` builds the child environment as:

```ts
{ ...scrubbedParentEnv(), ...config.env }
```

and `scrubbedParentEnv()` (`D:\deepseek-harness\packages\subprocess\subprocess\src\index.ts`)
drops every variable whose **name** matches `/KEY|PASSWORD|SECRET|TOKEN/i`, plus
every `DSH_*` name. `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` both match. So a
key you exported in your shell does **not** reach the server, `chooseProvider`
sees no credential, the server stays on the offline mock, and **every answer is
synthetic with no error**. The fix is the documented one, and it works because the
explicit map merges after the scrub:

```yml
      config:
        serverName: jev
        transport: stdio
        command: node
        args: ['/absolute/path/to/node_modules/jevcore-mcp/lib/bin.js']
        env:
          TYPESAFE_API_KEY: '<the key>'   # written here, not inherited
```

For other hosts this mechanism is **reported, not reproduced here**: hosts differ
in whether they inherit the parent environment, pass a curated set, or pass only
the `env` you declare. Treat "I set the key and it still answers synthetically" as
the symptom, and use the two diagnostics below rather than guessing.

**Diagnostics.** The server prints its egress report to stderr *before* it answers
anything, and the provider is in the last line:

```
[jevcore] provider=mock  endpoint=none  egress=OFF  (no network calls will be made; every answer is synthetic)
[jevcore-mcp] ready · provider=mock · model=jev-latest
```

`provider=mock` with a key in your shell means the key did not arrive. On
Claude Desktop that output lands in `mcp-server-jev.log`; on other hosts, in the
host's MCP log or the terminal you launched it from.

### 9.2 With no provider configured, the default is the offline mock — and the answers are synthetic

**Measured**: driving the server over a real stdio MCP client with no key, every
result carried `provider: "mock"` and a `warning`:

```json
{
  "provider": "mock",
  "model": "jev-latest",
  "latencyMs": 0,
  "answers": {
    "refund_requested": { "type": "noul", "noul": 0.548 },
    "team": {
      "type": "choice",
      "choice": "technical",
      "probabilities": { "billing": 0.4415, "technical": 0.5585 },
      "confidence": 0.5
    }
  },
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 },
  "warning": "These answers are SYNTHETIC. The mock provider derived them from a hash of the input; they carry no judgment. Set TYPESAFE_API_KEY (or OPENROUTER_API_KEY), or JEV_PROVIDER=live, for real answers."
}
```

Read `provider` and `warning`, not `model`: on this path `model` echoes the
configured name (`jev-latest`) rather than `mock/jev-synthetic`, because the MCP
runtime passes the configured model through to the provider.

Selection order, from `packages/mcp/src/runtime.ts`: `JEV_PROVIDER` wins when set
(`mock` | `live` | `openrouter`); otherwise a non-empty `TYPESAFE_API_KEY` selects
`live`; otherwise a non-empty `OPENROUTER_API_KEY` selects `openrouter`; otherwise
`mock`. An empty string counts as absent, which is why setting
`TYPESAFE_API_KEY: ''` is a reliable way to pin a server offline.

### 9.3 `JEV_PROVIDER=live` with no key is a startup error, not a per-call one

The MCP server resolves its credential **once at startup** — it is a long-lived
process. With `JEV_PROVIDER=live` and no key it exits with
`provider "live" was selected but no credential was found for TYPESAFE_API_KEY.`
On a host configured with `failOnStartupError: true` (as the DSH snippet above is),
that is a hard failure at load rather than a surprise on the first tool call —
which is the point.

### 9.4 Only the three tools exist, and they return probabilities

`jev_ask`, `jev_rank`, `jev_check` — and every result carries probabilities, not
permissions. Two consequences for host configuration:

- Nothing here writes files, runs commands, or fetches URLs. Auto-approving the
  three tools (Zed's `mcp:jev:*`, a host's allow-list) grants a read-only judgment,
  not side effects.
- Applying a threshold is your code's job. `jev_check` is the one tool that
  resolves a verdict itself (`supported` / `contradicted` / `conflicted` /
  `insufficient` / `unknown`) from three probabilities with fixed thresholds.

### 9.5 Reading an answer

A `score` answer's number may fall **between** levels, and its `legend` maps each
index back to the level's description — read the legend rather than rounding:

```json
"answers": {
  "severity": {
    "type": "score",
    "score": 1.2112,
    "legend": { "0": "low", "1": "medium", "2": "high" },
    "probabilities": { "0": 0.3038, "1": 0.1812, "2": 0.515 }
  }
}
```

A `noul` answer has no `confidence` at all — that field exists only for `choice`
and `score`. Read the probability.

---

## 10. Sources

| Host | Source used |
|---|---|
| Claude Code | <https://code.claude.com/docs/en/mcp> |
| Claude Desktop | <https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers> |
| Cursor | <https://cursor.com/docs/mcp> |
| VS Code | <https://code.visualstudio.com/docs/agent-customization/mcp-servers>, <https://code.visualstudio.com/docs/agents/reference/mcp-configuration> |
| Zed | <https://zed.dev/docs/ai/mcp> |
| OpenCode | <https://opencode.ai/docs/mcp-servers/>, <https://opencode.ai/docs/windows-wsl> |
| DeepSeek Harness | `packages/mcp/README.md` in this repository, plus `D:\deepseek-harness\packages\mcp\mcp-client\src\transport.ts` |
| Server behaviour | `packages/mcp/src/runtime.ts`, `src/bin.ts`, `scripts/mcp-smoke.mjs` (all run offline here) |
