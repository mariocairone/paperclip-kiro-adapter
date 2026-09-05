# Paperclip Kiro ACP adapter

ACP-first [Paperclip](https://github.com/paperclipai/paperclip) adapter for Kiro CLI.

- Adapter type: `kiro_acp`
- Display name: **Kiro ACP**
- Package: `@mariocairone/paperclip-kiro-adapter` `0.1.0` (private)
- Execution: local Kiro CLI only; no remote Paperclip writes are performed by installation or environment checks

## Requirements

- Node.js `>=22.13.0` (required by the pinned `acpx` runtime)
- Paperclip external-adapter support
- `kiro-cli` available to the Paperclip server user
- A completed Kiro login for that user
- Kiro CLI with `kiro-cli acp` for the ACP lane

```bash
kiro-cli login --use-device-flow
kiro-cli acp --help
```

Build a local checkout with:

```bash
npm ci
npm run build
```

This package is private and is not intended for registry publication. Install a built checkout through Paperclip's local-adapter path when testing; this repository does not install itself into a live Paperclip instance.

## Architecture

`execute()` resolves one of two lanes:

1. **ACP lane (default):** `@paperclipai/adapter-utils/acpx-engine` starts `kiro-cli acp` over stdio. Session identity and tool events come from typed ACP/acpx metadata. No terminal transcript parsing and no `chat --list-sessions` heuristic are used.
2. **CLI compatibility lane:** the original `kiro-cli chat --no-interactive` wrapper remains available. It preserves prompt assembly, profile handling, output sanitization, timeout behavior, session lookup/resume, loopback API access, runtime MCP, skills, and base-agent inheritance.

### Engine resolution

| `engine` | Behavior |
|---|---|
| `auto` (default) | Use ACP. Fall back to CLI **only** when `kiro-cli acp --help` explicitly reports that the `acp` subcommand is unavailable. Missing binaries, auth failures, timeouts, and ambiguous probe failures do not trigger fallback. |
| `acp` | Require ACP. A missing subcommand fails closed with no CLI fallback. |
| `cli` | Always use the compatibility wrapper. |

The capability probe is read-only, cached for five minutes, and starts no ACP session.

### ACP profile lifecycle

Kiro receives trusted system context through an agent profile. The ACP profile:

- has a deterministic name derived from the Paperclip agent ID;
- is stored under `$KIRO_HOME/agents` (or `~/.kiro/agents`), with a workspace fallback only when the home is not writable;
- is written atomically with mode `0600`;
- is rewritten per heartbeat and fingerprinted into the acpx session identity, so persona, instructions, skills, MCP, model, or tool-policy changes start a compatible new ACP session;
- is retained because a warm ACP server outlives one heartbeat;
- is cleaned only by a safe stale-file sweep restricted to old, regular, adapter-owned `paperclip-*.json` files. Foreign files and symlinks are untouched.

The trusted system prompt is `base persona + selected Paperclip skills + managed instructions`. Per-wake Paperclip context remains in the acpx turn prompt.

### Base agents

`baseAgent` resolves, in order:

1. `<cwd>/.kiro/agents/<name>.md` or `.json`
2. `$KIRO_HOME/agents/<name>.md` or `.json`
3. `~/.kiro/agents/<name>.md` or `.json` when `KIRO_HOME` is unset

Markdown frontmatter and JSON profiles inherit:

- `prompt`
- `model`
- `tools` and `allowedTools`
- `mcpServers`
- `resources`
- `toolAliases`
- `toolsSettings`
- `includeMcpJson`
- `requireMcpStartup`

With Paperclip `model: auto`, the base model wins. An explicit Paperclip model wins over the base model.

### MCP

MCP servers are combined from Kiro's global/workspace `mcp.json`, the base agent, and Paperclip runtime connections. Every server is added to the Kiro `tools`/`allowedTools` list as `@name`; `"*"` alone covers only built-in tools. Runtime names are sanitized. Base-agent MCP definitions win collisions, followed by existing Kiro MCP definitions; runtime connections cannot replace either. Bearer tokens are written only to the mode-`0600` profile and are never logged.

`requireMcpStartup: true` fails before launch if no MCP server is configured and is copied to the Kiro profile for Kiro versions that support that field.

## Configuration

Paperclip already renders `command`, `model`, standard thinking effort, `cwd`, instructions, prompt template, and `extraArgs`. Adapter-specific fields are:

| Field | Default | Description |
|---|---:|---|
| `engine` | `auto` | `auto`, `acp`, or `cli`; semantics above |
| `baseAgent` | — | Existing Markdown/JSON Kiro agent to inherit |
| `effort` | — | Standard Paperclip thinking-effort field: `low`, `medium`, `high`, `xhigh`, `max` |
| `trustTools` | unset | Comma-separated string or string array for `--trust-tools`; unset uses `--trust-all-tools`; an explicit empty list emits no Kiro trust flag |
| `requireMcpStartup` | `false` | Require configured MCP and request Kiro profile startup enforcement |
| `preferConfiguredCwd` | `false` | Make configured `cwd` override Paperclip's workspace |
| `permissionMode` | `approve-all` | acpx client policy: `approve-all`, `approve-reads`, or `deny-all` |
| `nonInteractivePermissions` | `deny` | `deny` or `fail` |
| `timeoutSec` | `0` | ACP/CLI run timeout; `0` means no adapter timeout |
| `graceSec` | `20` | CLI fallback SIGTERM grace period |
| `logLineLimit` | `2000` | CLI fallback log-line truncation; `0` disables it |

### Model and effort are session-fixed

Kiro CLI does not support the model/effort configuration methods used by generic ACP clients. The adapter therefore passes both on the process command:

```text
kiro-cli acp --agent <profile> --model <model> --effort <effort>
```

It removes all model/effort keys from the acpx-engine config, preventing `session/set_config_option`. A model or effort change changes the command/session fingerprint and applies to a new ACP session.

Effort precedence is explicit:

1. `effort` (standard Paperclip field)
2. `thinkingEffort`
3. `reasoningEffort`
4. `modelReasoningEffort`
5. legacy `kiroEffort` (read-only migration compatibility)

Values outside `low`, `medium`, `high`, `xhigh`, `max` fail the environment check and are omitted with a run warning.

### Reserved `extraArgs`

The adapter owns these flags and rejects both `--flag value` and `--flag=value` forms in `extraArgs`:

- `--agent`
- `--model`
- `--effort`
- `--resume-id`
- `--output-format`
- `--no-interactive`

This prevents caller arguments from breaking profile, session, or typed-output guarantees.

### Network and Paperclip instructions

The agent receives Paperclip runtime environment, managed instructions, selected skills, runtime MCP, and the loopback API URL. Public Paperclip origins are replaced for the ACP worker with `PAPERCLIP_RUNTIME_API_URL` pointing to loopback (or `PAPERCLIP_LOCAL_API_URL`), while `NO_PROXY`/`no_proxy` include `localhost`, `127.0.0.1`, and `::1`.

## Sessions and output

ACP session parameters are serialized by the pinned acpx-engine session codec and retain `sessionKey`, `acpSessionId`, `agentSessionId`, runtime session name, cwd, mode, and config fingerprint. CLI session params remain `{ sessionId, cwd }`. The combined codec round-trips both formats.

ACP emits JSON log events such as `acpx.session`, `acpx.text_delta`, `acpx.tool_call`, `acpx.status`, and `acpx.result`. The CLI fallback keeps the existing ANSI/redraw sanitizer and UI parser.

## Usage accounting

Kiro CLI 2.21.0 emits private typed `_kiro.dev/metadata` notifications containing `meteringUsage` credits, but the pinned acpx 0.12.0 runtime does not expose that private notification through `AcpRuntimeEvent` or `getStatus()`. The adapter does not parse private protocol traffic or infer accounting:

- `resultJson.usageJson` is `null` while no standard typed usage reaches acpx;
- `usage`, `usageBasis`, and cost are preserved only if the pinned acpx engine receives typed usage through its public runtime contract;
- private Kiro credit metadata cannot currently be mapped safely to Paperclip budget enforcement.

## Migration from `kiro_local`

This adapter intentionally uses the new type `kiro_acp`; it does not claim the baseline `kiro_local` type.

1. Install/build this adapter as a separate local package.
2. Change each intended Paperclip agent's adapter type from `kiro_local` to `kiro_acp`.
3. Keep existing `command`, `model`, `cwd`, `baseAgent`, skills, instructions, MCP, timeout, and environment configuration.
4. Start with `engine: auto`. Use `engine: acp` after confirming `kiro-cli acp --help` works and fail-closed behavior is desired.
5. Use the standard Paperclip `Thinking effort` field; legacy `kiroEffort` is read only for migration compatibility.
6. Remove reserved flags from `extraArgs`.

There is no Git-history import, live adapter installation, remote creation, or Paperclip system mutation in this repository.

## Limitations

- Local execution only; remote/sandbox Kiro provisioning is not implemented.
- Kiro login is manual.
- Model and effort cannot change inside a live ACP session.
- `requireMcpStartup` depends on Kiro profile support; the adapter can guarantee the local “at least one MCP configured” precondition, not behavior in older Kiro builds that ignore the profile field.
- Private Kiro credit metadata is visible on the wire but not exposed by acpx 0.12.0's public runtime contract; see Usage accounting.
- Base-agent-scoped MCP is visible only when present in the inherited profile; unrelated agent profiles are not scanned.
- Reloading an already imported Node ESM package may require a Paperclip server restart.

## Development and validation

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

A read-only smoke test can use `kiro-cli acp --help` and the bundled acpx client. Do not install the adapter into a live Paperclip instance merely to validate the package.

## Attribution and license

MIT licensed. The initial CLI baseline was adapted from [Schapat/paperclip-kiro-adapter](https://github.com/Schapat/paperclip-kiro-adapter), and its public `feat-acp-engine` work was consulted as a technical reference. Copyright and attribution details are in [LICENSE](LICENSE) and [NOTICE](NOTICE). This repository has an independent Git history and is not affiliated with Paperclip Labs or Kiro.
