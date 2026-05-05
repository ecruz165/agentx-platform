# Harness CLI (TUI + Commands) — PRD

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Engineering, design, product reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (`Harness` API surface this CLI mirrors over a network)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-prd-harness-server.md` — REST/WS server this CLI is the primary client of
- `.plans/2026-04-30-prd-edge-memory-server.md` — memory CLI subcommands aggregate here
- `.plans/2026-04-30-prd-edge-context-server.md` — context CLI subcommands aggregate here
- `.plans/2026-04-30-prd-workspace-setup-cli.md` — `harness init` / `harness server *` / `harness doctor` subcommands aggregate here
- `.plans/2026-04-30-prd-vscode-extension.md` — peer surface; the extension shells out to this CLI for parity-critical operations

---

## 1. Goal

**Near-term v1 deployment context: DevContainer on the developer's local machine** — the same trust posture as the three peer servers (UDS / loopback, no app-level auth). See § 4.7.

A single `harness` binary that is **the unified terminal entry point** for the agentic workspace. It serves three audiences from one command surface:

1. **Humans (TUI + commands)** — submit jobs, watch progress, steer mid-flight, rollback, attach to running workers, manage memory and context, manage the workspace itself.
2. **Agents (skill surface)** — invoked through their adapter's Bash tool, guided by workspace `SKILL.md` files. The agent uses the *same* binary, *same* subcommands, *same* output formats as the human. **No MCP** (corporate policy `feedback_no_mcp`).
3. **Scripts / CI integrations** — `--json` output and stable exit codes for automation.

**Parity Requirement:** Every action available in the TUI (submit, steer, rollback, attach, cancel, status, history, memory ops, context ops, server lifecycle) is exposed as a direct subcommand of `harness`. The TUI is a discovery and live-monitoring surface; the CLI is the contract. Internally, the TUI calls the same client-side handlers that the subcommands call — there is no TUI-only logic.

**Aggregation Architecture:** `harness` is a single binary that mounts subcommand groups owned by other deliverables (memory from edge-memory-server, context from edge-context-server, init/server/doctor from workspace-setup-cli). The mount mechanism is build-time composition — see § 4.1 + § 6.

---

## 2. Personas served

| Persona | Need |
|---|---|
| **Daisy** (developer, primary user) | Submit jobs, watch them run, steer when needed, rollback failures, query memory and context interactively. |
| **Quinn** (curious lurker / new joiner) | Read-only attach to other developers' running jobs, browse memory/context, learn by watching. |
| **Owen** (operator) | Server lifecycle, prewarm, doctor, update, queue inspection, audit-log viewing. |
| **Worker agent** (LLM, via Bash tool) | Discover memory/context as skills, invoke `harness memory query/put` and `harness context graphrag traverse` per `SKILL.md` guidance. |
| **CI / external scripts** | `harness submit --json`, parse `jobId`, poll `harness job status --json`, react to exit codes. |

---

## 3. User stories

### Human, interactive
- *As Daisy*, I run `harness tui` and see a live dashboard: queue depth, running jobs (worker DevContainer status), recent completions, server health for all three peer servers. Pressing `s` from the dashboard opens a submit form; `Enter` on a running job opens its detail view with live event stream.
- *As Daisy*, I run `harness submit fix-bug --product mobile-app --input task.md` and the CLI streams events (`session-started`, `phase-started`, `tool-called`, `phase-completed`) to my terminal until completion or interrupt. `Ctrl-C` once asks "graceful cancel? (y/N)"; twice forces.
- *As Daisy*, I run `harness job steer <jobId> "use the existing AuthService instead of creating a new one"` mid-flight; the steer is delivered to the inbox and applied at the next phase boundary.
- *As Daisy* (a job has gone wrong), I run `harness job rollback <jobId> --to-phase analyze` and the worker checkpoints back to that phase boundary.
- *As Quinn*, I run `harness job attach <jobId>` and tmux-attach (read-only via `-r`) into the worker's terminal to watch what the agent is typing.
- *As Daisy*, I run `harness job ls --status running` and see all jobs currently in flight across the workspace, with their pipelines, products, and elapsed time.
- *As Daisy*, I run `harness job logs <jobId>` and see the captured agent capture stream rendered with phase headers.

### Human, server lifecycle (aggregated from workspace-setup-cli)
- *As Daisy*, after a reboot I run `harness server start` and the three always-on containers come back up; `harness server status` confirms they're healthy.
- *As Owen*, I run `harness doctor` for triage; `harness update` for image bumps.

### Human, knowledge surfaces (aggregated from edge-memory-server / edge-context-server)
- *As Daisy*, I run `harness memory query --scope user:alice --type recent --limit 20` and see what my agent remembers about me.
- *As Daisy*, I run `harness context graphrag traverse --entity AuthService --depth 2` and see the call graph.

### Agent, via Bash tool (no MCP)
- *As an agent in a worker container*, my `SKILL.md` tells me how to look something up; I emit a Bash tool call: `harness memory query --type similarity --query "auth bug" --k 5`. The CLI talks to edge-memory-server over UDS and prints `--json` (because I always pass `--json` per skill guidance). I parse it and proceed.
- *As an agent*, I run `harness context graphrag search --query "rate limiting middleware" --k 5 --json` to find relevant code before making a change.

### Scripts / CI
- *As a CI script*, I run `harness submit pr-review --product mobile-app --input @-  --json --wait` (reads input from stdin, blocks until completion, prints final result as JSON). Exit code 0 = succeeded; 2 = failed; 3 = rejected by coordinator; 4 = cancelled.

---

## 4. Functional requirements

### 4.1 Command taxonomy & aggregation

| ID | Requirement |
|---|---|
| F1 | Single `harness` binary. All subcommands dispatched from one entry point. No separate `harness-memory` / `harness-context` binaries. |
| F2 | **Top-level subcommand groups** (each owned by a deliverable, mounted at build time): `init`, `server`, `submit`, `job`, `memory`, `context`, `pipeline`, `workspace`, `tui`, `doctor`, `update`, `uninstall`, `join`, `use`, `version`. |
| F3 | **Job operations group** (`harness job`): `submit` (alias of top-level `harness submit`), `status`, `ls`, `logs`, `events`, `steer`, `rollback`, `cancel`, `attach`, `captures`. |
| F4 | **Memory group** (`harness memory`): subcommands per `prd-edge-memory-server.md` F20 — `query`, `put`, `recent`, `forget`, `inspect`, `import`, `export`, `tag`, `consolidate`. |
| F5 | **Context group** (`harness context`): three sub-groups per `prd-edge-context-server.md` F37–F39 — `harness context graphrag *`, `harness context openapi *`, `harness context plugins list`. |
| F6 | **Server lifecycle group** (`harness server`): subcommands per `prd-workspace-setup-cli.md` F13–F18 — `start`, `stop`, `status`, `restart`, `prewarm`. |
| F7 | **Pipeline catalog group** (`harness pipeline`): `ls`, `show <id>`, `validate <file>`, `save <file>`, `delete <id>`, `history <id>`. Maps onto harness-server's catalog REST/UDS endpoints. |
| F8 | **Workspace group** (`harness workspace`): `ls` (list configured workspaces from `cli-config.yml`), `prune` (clean stopped workers), `doctor` (alias of top-level `harness doctor`). |
| F9 | **Build-time mount mechanism:** subcommand modules are imported from their owning packages (`@your-org/edge-memory-cli`, `@your-org/edge-context-cli`, `@your-org/workspace-setup-cli`) and registered against a single `commander.js` root. Each mountable module exports `{ name, build(parent: Command): void }`. The harness-cli package depends on each module package and composes them. **Plugin discovery (third-party mounts) is deferred to v1.x** — see § 8 HC1. |
| F10 | **Subcommand parity:** every command available in `harness tui` keystrokes is also reachable via a non-interactive subcommand. Implemented by routing both surfaces through the same client-side function (e.g., `submitJob`, `steerJob`, `rollbackToPhase`). The TUI cannot do anything the CLI cannot. |
| F11 | **Help discoverability:** `harness --help` shows top-level groups; `harness <group> --help` shows subcommands; `harness <group> <subcmd> --help` shows flags. Help is the same text humans read and agents parse — agents are encouraged to call `--help` when uncertain. |

### 4.2 Job submission & lifecycle (talks to harness-server)

| ID | Requirement |
|---|---|
| F12 | `harness submit <pipeline> [--profile <name>] --product <id> --input <file\|@->` submits a job. `<pipeline>` may be `auto` to invoke the coordinator. `--input @-` reads from stdin. Returns `jobId` immediately and (by default) streams events until completion. `--no-wait` returns immediately after submission. |
| F13 | **`--product` is required** for every submit (matches harness-server F1 + F10). When omitted, the CLI errors with "specify `--product` (run `harness workspace ls --products` to see available)." Resolution order for the default: `--product` flag → `HARNESS_PRODUCT` env → workspace's `defaultProduct` → error. |
| F14 | `harness job status <jobId>` prints lifecycle, current phase, usage rollup, exit status. |
| F15 | `harness job ls [--status running\|pending\|completed\|cancelled\|errored] [--pipeline <id>] [--product <id>] [--since <ts>]`. |
| F16 | `harness job events <jobId> [--since <seq>]` streams the WebSocket event channel to stdout, formatted by default; `--json` emits one JSON-line per event. Reconnect-replay uses the `?since=<seq>` semantics from harness-server F25. |
| F17 | `harness job logs <jobId> [--phase <id>]` prints captured agent output (formatted), with phase headers. `--raw` prints unfiltered capture content. |
| F18 | `harness job steer <jobId> <message> [--scope session\|phase] [--priority urgent\|next-boundary]`. `--priority urgent` opts in to mid-phase delivery (per harness-server F27). Default priority is `next-boundary`. |
| F19 | `harness job rollback <jobId> --to-phase <phaseId>`. Posts to harness-server's rollback endpoint (currently undefined — see § 8 HC2). |
| F20 | `harness job cancel <jobId> [--force]`. `--force` issues immediate cancel; default is graceful drain per harness-server F4. |
| F21 | `harness job attach <jobId>` opens a tmux read-only attach (`tmux -S <socket> attach -t agent-<jobId> -r`) into the running worker's session. Implementation: CLI looks up the worker's tmux socket path from harness-server (`GET /v1/jobs/<id>` returns the socket path in `worker.tmuxSocket`), then exec's tmux. **Read-only is enforced by the `-r` flag**; v1 acknowledges this is a UX boundary, not a security boundary (anyone with FS access to the socket can re-attach r/w). |
| F22 | `harness job captures <jobId> [--phase <id>]` lists captures with their URLs (per harness-server F29). `--download <captureId> -o <path>` downloads. **Capture URL portability:** the CLI handles both `file://` (v1 local) and `https://` (v1.x signed) — see § 8 HC3. |

### 4.3 Memory + context skill surface (agent-facing)

| ID | Requirement |
|---|---|
| F23 | All `harness memory *` and `harness context *` subcommands are designed to be agent-callable — terse, predictable, `--json`-clean. Reference `SKILL.md` files installed by the workspace template (`memory.md`, `graphrag.md`) document the agent-facing patterns. |
| F24 | **Latency budget acknowledgement:** when invoked from inside a worker container, the agent path is Bash-tool → spawn → CLI parse → UDS roundtrip → server. Realistic agent-observed p95: 100–250ms cold, 60–120ms warm. Server-side `<50ms` targets in edge-server PRDs are **server-side only**; the CLI hop is acknowledged here so downstream PRDs don't size against unrealistic numbers. |
| F25 | **Scope inference inside a worker:** when the CLI runs inside a worker container, it reads `JOB_ID`, `PRODUCT_ID`, `USER_ID` from the environment (set by harness-server when spawning the worker). Subcommands that take `--scope` use these as defaults per the read/write precedence chains in `prd-edge-memory-server.md` F3a/F3b. The agent does not need to thread scope manually for the common case. |
| F26 | **Scope-binding integrity:** the CLI never trusts agent-supplied `--scope job:<otherJob>` arguments unless the supplied `<otherJob>` matches the `JOB_ID` the worker was spawned with — except when running on the developer's host (outside a worker), where the developer's filesystem identity is the auth (per v1 trust model). Mismatched scope inside a worker → `ScopeBindingError` with non-zero exit. **Note: this is enforcement at the CLI layer; servers will not enforce until v1.x identity lands** — see § 8 HC4. |
| F27 | **No MCP path:** the CLI is the **only** sanctioned way for an agent to reach memory or context in v1. The package does not link `@modelcontextprotocol/sdk`. Workspace bootstrap explicitly suppresses MCP at adapter spawn (per `prd-agent-adapter-lib.md:288-292`). The skill surface is intentionally CLI-only. |

### 4.4 TUI

| ID | Requirement |
|---|---|
| F28 | `harness tui` opens an interactive Ink-based UI. Default landing view: dashboard (queue depth, running jobs, recent completions, server health). |
| F29 | **Views:** Dashboard, Job Detail (live event stream + steer composer), Job List (filterable), Memory Browser (scope tree + entry detail), Context Browser (graph stats + recent ingests), Pipeline Catalog (browse + validate). |
| F30 | **Keystrokes (consistent across views):** `?` (help), `q` (back/quit), `s` (submit new), `r` (refresh), `Enter` (drill in), `Esc` (cancel input), `/` (filter). |
| F31 | **Live event stream rendering:** Job Detail subscribes to `/v1/jobs/<id>/events` and renders the same event types listed in design `§6.21` with phase grouping. Steer composer is a modal at the bottom; pressing `S` (capital-S) posts the message via the same WS connection (urgent path) or REST (`harness server` reachable but WS isn't). |
| F32 | **Connection state indicator:** persistent header line shows green/yellow/red per peer server (harness-server, edge-memory-server, edge-context-server). Click-through (or `c`) opens a connection diagnostic with last-seen-ms, version compat, suggested fix. |
| F33 | **Resource posture:** the TUI is allowed up to 200MB RSS; event-stream rendering uses windowed virtualization for >500 events. The dashboard refreshes via WS pushes (no polling). |
| F34 | **TUI is not a separate binary.** It is `harness tui` — the same binary, same config, same connection logic as the subcommands. |

### 4.5 Output formats & exit codes

| ID | Requirement |
|---|---|
| F35 | `--json` flag is universal across all subcommands. JSON output is line-oriented for streaming subcommands (`harness job events --json` → one JSON object per line, no wrapping array). |
| F36 | Default human output uses ANSI when stdout is a TTY, plain text otherwise. `--no-color` forces plain. `NO_COLOR` env var honored. |
| F37 | `--quiet` suppresses progress chrome and prints only the final result (job ID for submit, count for forget, etc.) — designed for shell pipelines. |
| F38 | **Exit codes:** `0` success; `1` general error (network, parse, validation); `2` job/operation reached terminal failure (`errored`); `3` job rejected by coordinator (`status: 'rejected'`); `4` job cancelled (`status: 'cancelled'`); `5` operation interrupted by HITL escalation (`status: 'interrupted'`); `64` usage error (bad flags); `69` service unavailable; `77` permission denied. |
| F39 | **Error envelope (JSON mode):** `{ ok: false, error: { kind, message, retriable, requestId, hint? } }`. `kind` mirrors the design's `HarnessError` taxonomy from `§6.18`. |
| F40 | `--request-id <id>` allows callers to provide a correlation ID; the CLI propagates it through all server calls. When omitted, the CLI generates a ULID. The ID is echoed back in error envelopes for downstream tracing. |

### 4.6 Workspace selection & multi-workspace

| ID | Requirement |
|---|---|
| F41 | The CLI reads `~/.harness/cli-config.yml` (path canonicalized — see § 8 HC5) for the list of known workspaces and which is active. |
| F42 | `harness use <workspace>` switches the active workspace (writes to `cli-config.yml`). |
| F43 | `--workspace <name>` flag overrides the active workspace per-invocation (does not persist). |
| F44 | When invoked inside a worker DevContainer, the workspace is determined by the bind-mounted UDS socket location — the env var `HARNESS_WORKSPACE_ID` is set by harness-server at worker spawn. The CLI uses that, ignoring `cli-config.yml`. |
| F45 | `harness workspace ls` lists configured workspaces with health status (UDS reachable? servers up?). |
| F46 | **Cross-workspace operations are forbidden in v1.** A subcommand cannot target a workspace different from the active one without `--workspace` and an explicit warning. Bulk operations across workspaces are deferred to v1.x. |

### 4.7 Authentication & v1.x forward-compat

| ID | Requirement |
|---|---|
| F47 | **v1: no app-level auth.** UDS file-perm + loopback is the security boundary. The CLI does not present credentials to the servers. Matches the v1 trust posture in `prd-harness-server.md § 4.3` and edge servers' `§ 4.3`. |
| F48 | **Transport selection:** prefer UDS when `cli-config.yml` lists a socket path and the path is reachable; fall back to localhost TCP if UDS is missing or fails. **Admin-only operations** (per harness-server F17 — `/v1/admin/*` and `POST /v1/pipelines/{id}`) require UDS; the CLI surfaces a clear error if attempted over TCP. |
| F49 | **`--auth-token <token>` flag is reserved syntactically** — accepts a value but is silently ignored in v1. v1.x will wire it into an `Authorization: Bearer` header. (Mirrors workspace-setup-cli F35's `--auth-config v1x.yml` pattern.) |
| F50 | **Forward-compat audit log:** every CLI invocation that reaches a server emits an audit-log row at the server with `actor: uds:<uid>` (see harness-server F19). The CLI does not control this; it is recorded by the server based on the connection. v1.x identity surfaces as authenticated user on the same row. |

### 4.8 Self-update + version compatibility

| ID | Requirement |
|---|---|
| F51 | `harness version` prints CLI version, active-workspace server versions (queried via `/v1/meta` on each peer server), and a compat-matrix verdict (`ok` / `warn` / `error`). |
| F52 | **Version compatibility check on every command:** if any peer server reports a major version that the CLI is not compatible with, the command fails fast with `kind: 'version-skew'` and a suggested upgrade command (`harness update --component cli` or `harness server update`). |
| F53 | **OpenAPI client generation:** the CLI's HTTP client is generated from the harness-server OpenAPI spec at the CLI's release time (per harness-server F38). Schema drift between client and server is a deliberate failure: the version-compat check (F52) gates all calls. |
| F54 | **WS frame schemas** (steer, steer-ack, steering-applied, events) are not in OpenAPI; they live in a shared types package (`@your-org/harness-protocol`) consumed by both server and CLI. |
| F55 | `harness update --component cli` invokes `npm`/`pnpm`/`bun` global install of a newer version (chosen by detection of the user's package manager). `harness update` (no flags) updates servers + CLI together — delegates to workspace-setup-cli's `update` flow. |

### 4.9 SKILL.md surface for agents

| ID | Requirement |
|---|---|
| F56 | The CLI ships a single canonical `harness.md` SKILL file (~80 lines) that documents agent-facing patterns: how to use `--json`, how to interpret exit codes, when to call `--help`, how to handle `--scope` defaults. The workspace template installs it into `~/.claude/skills/harness.md` (or the workspace `.skills/`) inside the worker container. |
| F57 | **Per-domain skills compose with the master skill:** `memory.md` and `graphrag.md` (shipped by edge servers) are loaded alongside `harness.md`; the master skill is short and points at the per-domain skills for verbs. No duplication. |
| F58 | **Verbatim-stable agent surface:** flags, output shapes, and exit codes for `memory`, `context`, and `job` subcommands are part of the **public CLI contract**. Breaking changes require a major version bump and a transition window. (See § 8 HC6 for what counts as breaking.) |

---

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| N1 | **Cold-start (binary launch):** p95 <80ms on macOS arm64, <50ms on Linux x86_64 — measured `time harness --version` from a cold OS page cache after 10s idle. Bun-compiled single binary; no Node startup tax. |
| N2 | **Warm subcommand p95** (e.g., `harness memory query` with edge-memory-server already warm): <120ms end-to-end from CLI invocation to printed output. |
| N3 | **Streaming subcommands** (`harness submit` default, `harness job events`): TTFB <200ms; subsequent event latency <50ms above WS native latency. |
| N4 | **Memory:** <60MB RSS for non-TUI subcommands; <200MB for `harness tui`. |
| N5 | **Robust under partial failures:** when one peer server is down, only commands that target it fail (memory down → `harness memory *` fails; harness-server down → `harness submit` fails; context down doesn't break either). Each failure includes a remediation hint (`harness server start <name>`). |
| N6 | **Single binary distribution.** Built via `bun build --compile`; macOS arm64 + Linux x86_64 + Linux arm64 + (best-effort) Windows x64. Worker-template prebuild includes a Linux x86_64 binary even on macOS hosts (cross-compile). |
| N7 | **Reproducible installation:** `npm install -g @your-org/harness-cli@<version>` and `bun install -g` produce byte-identical binaries from the same release tag. |
| N8 | **Help text is the contract.** `harness <cmd> --help` is the documentation; no separate man pages, no separate website docs for the CLI surface. (External docs reference the help text.) |
| N9 | **Telemetry: opt-in only.** v1 ships no telemetry collection. Opt-in usage analytics via `harness config set telemetry.enabled true` is reserved for v1.x. |
| N10 | **Sandbox-friendly:** the CLI does not write outside `~/.harness/`, the workspace, and `$TMPDIR`. No global modifications. Uninstall (workspace-setup-cli's `harness uninstall`) is clean. |

---

## 6. Technical approach

### 6.1 Stack

- **Language:** TypeScript, compiled with `bun build --compile` to a single binary. (Same toolchain as edge servers and harness-server for consistency.)
- **Command framework:** `commander.js` (mature, supports the build-time mount pattern). Considered alternatives: `oclif` (heavier, plugin-runtime overhead we don't need in v1), `clipanion` (smaller community).
- **TUI framework:** `ink` (React-for-terminal). Renders to ANSI, plays well with the same data shapes the rest of the CLI uses.
- **Streaming:** native `fetch` for REST; `ws` for WebSocket; `stream` standard module for line-buffered JSON output.
- **Validation:** Zod schemas shared with `@your-org/harness-protocol` for both REST request bodies and WS frames.

### 6.2 Aggregation pattern

Each domain CLI ships as a separate package exposing a `build(parent: Command): void` function:

```ts
// @your-org/edge-memory-cli
export const memoryCommand = {
  name: 'memory',
  build(parent: Command): void {
    const memory = parent.command('memory')
      .description('Workspace memory operations');
    memory.command('query')...;
    memory.command('put')...;
    // ...
  }
};
```

The harness-cli package depends on each domain package and composes:

```ts
// @your-org/harness-cli
import { memoryCommand } from '@your-org/edge-memory-cli';
import { contextCommand } from '@your-org/edge-context-cli';
import { setupCommands } from '@your-org/workspace-setup-cli';
import { jobCommand, submitCommand, pipelineCommand } from './commands/job';
import { tuiCommand } from './tui';

const program = new Command('harness');
[setupCommands, jobCommand, submitCommand, memoryCommand, contextCommand, pipelineCommand, tuiCommand]
  .forEach(mod => mod.build(program));
program.parse();
```

This keeps each domain owning its own subcommand surface (and tests) while presenting one binary to the user. **Plugin discovery for third-party mounts is out of scope for v1** — see HC1.

### 6.3 Connection management

- One `HarnessClient` instance per process, shared across subcommands. Connects lazily.
- Per-server clients (`HarnessServerClient`, `MemoryClient`, `ContextClient`) all share the same UDS-or-TCP transport selection logic (per F48).
- WebSocket connections are command-scoped (created when the command needs streaming, closed at command exit). The TUI maintains a long-lived WS for the duration of the session.

### 6.4 Worker-context detection

The CLI detects "I am running inside a worker" via the env var `HARNESS_WORKSPACE_ID`. When set:
- Workspace selection skips `cli-config.yml` (F44).
- Default scope inference enabled (F25).
- Scope-binding integrity enforced (F26).
- All output defaults to `--json` unless TTY is detected (workers shouldn't have TTY by default, but tmux gives them one — see open question HC7).

### 6.5 What this CLI does NOT own

- Job persistence, queue, worker spawning → harness-server.
- Memory/context storage → respective edge servers.
- Workspace bootstrap (image build, container start) → workspace-setup-cli; the CLI mounts those subcommands but doesn't implement them.
- Credential storage / OAuth flows → agent-auth-lib (consumed indirectly by the servers; the CLI itself does not present credentials in v1).

---

## 7. Out of scope (v1)

- **Plugin discovery for third-party mounts.** v1 is build-time composition only.
- **Cross-workspace operations.** One active workspace at a time.
- **Scriptable command pipelines** (e.g., `harness pipe submit | filter | steer`). Use shell composition.
- **GUI other than TUI.** No Electron, no web UI; the VS Code extension is a separate deliverable.
- **Telemetry.** Opt-in v1.x only.
- **Authentication.** UDS + loopback is the v1 boundary.
- **Auto-update.** v1 has `harness update` (manual); auto-update is v1.x.

---

## 8. Open questions

| ID | Question | Lean |
|---|---|---|
| HC1 | Plugin discovery for third-party mounts — npm convention (`@your-org/harness-cli-plugin-*`)? Manifest-driven? | Defer to v1.x; in v1, build-time composition only. |
| HC2 | `harness job rollback` — server endpoint shape. Currently undefined in harness-server PRD; this CLI assumes a future `POST /v1/jobs/<id>/rollback` with `{ toPhase }` body. | File against harness-server PRD; suggested shape: `POST /v1/jobs/<id>/rollback` returning `{ rolledBackTo: phaseId, snapshotRef }`. |
| HC3 | Capture URL portability (`file://` from worker container vs. host CLI). | CLI auto-detects: `file://` URLs from worker context resolve to bind-mounted host paths; from host context resolve directly. Document the bind-mount contract in workspace-template. Long-term: signed HTTPS URLs from harness-server (v1.x). |
| HC4 | Scope-binding integrity (F26) — CLI-side enforcement only is weak. Should it be server-side too? | Yes, in v1.x when identity lands. v1 acceptable as defense-in-depth. |
| HC5 | `cli-config.yml` canonical location — `~/.harness/` or `~/.<your-org>/`? | Resolves WS3 from workspace-setup-cli; lean toward `~/.harness/` for ergonomic consistency with the binary name. Confirm with workspace-setup-cli + edge servers. |
| HC6 | Public-contract definition for "verbatim-stable agent surface" (F58) — what counts as breaking? | Lean: flag names, exit codes, JSON output keys are stable. Help text, error messages, color choices are mutable. Codify in CONTRIBUTING.md when v1 ships. |
| HC7 | Worker-context default output: `--json` always, or honor TTY? | Lean: `--json` when `HARNESS_WORKSPACE_ID` is set AND `stdout` is not a TTY. tmux makes stdout a TTY; agents typically pipe output, so the TTY check is right. |
| HC8 | TUI persistence — should the dashboard remember filters / panel layout across sessions? | Lean: no in v1; add `~/.harness/tui-state.json` opt-in if user demand emerges. |

---

## 9. Milestones

> Estimates assume one full-time engineer, focused; calendar will be ~1.5× due to integration with harness-server, edge servers, and workspace-setup-cli landing in parallel.

| ID | Milestone | Days |
|---|---|---|
| HC-1 | Project skeleton + `bun build --compile` + reproducible release pipeline + cross-arch matrix | 2 |
| HC-2 | `HarnessClient` (UDS-or-TCP transport, connection pooling, error envelope, request-ID propagation, version-compat check) | 2 |
| HC-3 | `harness submit` + `harness job status/ls/cancel/logs/captures` (REST surface; `--json`, exit codes) | 2 |
| HC-4 | `harness job events` + `harness job steer` (WS surface; reconnect-replay; ack handling) | 2 |
| HC-5 | `harness job rollback` + `harness job attach` (depends on HC2 server-side endpoint + tmux-attach plumbing) | 1.5 |
| HC-6 | Aggregation: mount `harness memory` (from edge-memory-cli), `harness context` (from edge-context-cli), `harness server/init/doctor/update/uninstall/join` (from workspace-setup-cli) | 1.5 |
| HC-7 | `harness pipeline ls/show/validate/save/delete/history` (talks to harness-server's catalog endpoints) | 1.5 |
| HC-8 | `harness use` + `harness workspace ls/prune` + `cli-config.yml` reader + worker-context detection (HARNESS_WORKSPACE_ID + scope-binding integrity per F26) | 1.5 |
| HC-9 | TUI dashboard view + Job List view + connection state indicator | 2 |
| HC-10 | TUI Job Detail view (live event stream + steer composer; modal flows) | 2 |
| HC-11 | TUI Memory Browser + Context Browser views | 1.5 |
| HC-12 | TUI Pipeline Catalog view + validate flow | 1 |
| HC-13 | `harness version` + version-compat check (F52) + OpenAPI client wiring | 1 |
| HC-14 | Reference `harness.md` SKILL file + verbatim-stability test fixtures (snapshot tests for flags / exit codes / JSON keys) | 1 |
| HC-15 | Cross-platform packaging: macOS arm64, Linux x86_64, Linux arm64; smoke tests on each; npm/pnpm/bun publish flow | 2 |
| HC-16 | Documentation pass: help text completeness, exit-code reference, error-envelope reference; HC1–HC8 resolution write-up | 1 |
| | **Total** | **~24.5 days** |

Calendar (one engineer): ~5 weeks. Realistic with parallel server work landing on the expected schedule; +1 week if HC-5 (rollback/attach) blocks on harness-server endpoint definition.

---

## 10. Acceptance criteria

- All TUI keystrokes have a parallel CLI subcommand (parity test enumerated against the F2/F3 taxonomy).
- `harness memory query` and `harness context graphrag traverse` invoked from inside a worker container return correct results with default scope inference (F25).
- `harness submit pr-review --product mobile-app --input @- --json --wait` from a CI script returns exit code 0 on success, 2 on failure, 3 on rejection.
- `harness job events --since 0 <jobId>` against a long-running job emits events without buffer overflow and without dropping (subject to the harness-server ring-buffer aging policy — see HC2/HC8 in harness-server).
- `harness version` against a workspace with mismatched server major reports `kind: 'version-skew'` and exits non-zero with the suggested upgrade command.
- `harness tui` opens, refreshes via WS pushes (no polling visible in `tcpdump`), uses <200MB RSS for a 5-minute session with a single running job streaming 2k events.
- `harness --help`, `harness <group> --help`, and `harness <group> <subcmd> --help` all render coherent text with consistent section ordering across groups.
- The shipped `harness.md` SKILL file results in an agent (claude-code-cli) successfully invoking memory and context subcommands with correct `--json` parsing in a scripted dry-run.
- Conformance: snapshot tests cover every documented flag, exit code, and JSON-output shape; CI fails on diff without an explicit version-bump approval.
- Cross-platform: smoke test passes on macOS arm64 + Linux x86_64 + Linux arm64.

---

## 11. Cross-document dependencies

| Depends on | What |
|---|---|
| `harness-server` | REST + WS surfaces; `/v1/meta` for version compat; rollback endpoint (HC2 unresolved); `worker.tmuxSocket` field in `GET /v1/jobs/<id>` for attach |
| `edge-memory-server` | Mountable `harness memory` subcommand module |
| `edge-context-server` | Mountable `harness context` subcommand module |
| `workspace-setup-cli` | Mountable `harness init/server/doctor/update/uninstall/join` subcommand modules; ownership of `cli-config.yml` schema |
| `harness-protocol` (new shared package) | WS frame schemas (steer, steer-ack, steering-applied, events); shared error envelope shape; `RunResult` + `HarnessError` types |
| `agent-adapter-lib` | None directly; the CLI is invoked *by* agents that the adapter spawns, but the CLI does not import the adapter |
| `agent-auth-lib` | None in v1 (the CLI does not present credentials); v1.x will use `agent-auth-lib` for the `--auth-token` flow |

---

## 12. Forward compatibility (v1.x)

- **Application-level auth:** `--auth-token` becomes wired (F49). New flag `harness login` invokes agent-auth-lib's OAuth flows. Audit-log actor upgrades from `uds:<uid>` to authenticated user (F50).
- **Plugin discovery:** convention-based npm plugin loading (HC1) lands as opt-in.
- **Cross-workspace operations:** `harness submit --workspace <name>` becomes routine; bulk operations enabled.
- **Auto-update:** `harness update --auto` background daemon.
- **Telemetry:** opt-in usage analytics (F58).
- **TUI state persistence:** opt-in dashboard preferences (HC8).
- **Signed-URL captures:** `https://` capture URLs replace `file://` once harness-server v1.x adds S3 sink (HC3).
- **Coordinator-rejected job UX:** CLI/TUI surface for `RunResult { status: 'rejected' }` with rationale display, retry-with-different-pipeline flow, and feedback into pipeline-catalog improvement.

---

## 13. Glossary

| Term | Definition |
|---|---|
| **Aggregation** | The build-time composition pattern by which `harness-cli` mounts subcommands owned by other deliverables into a single binary (§ 6.2). |
| **Mount** | A subcommand group registered against the root `commander.js` program by another package's `build(parent)` function. |
| **Skill surface** | The subset of CLI subcommands and output shapes that an agent invokes through its Bash tool, guided by a `SKILL.md`. Verbatim-stable per F58. |
| **Worker context** | The runtime environment inside a worker DevContainer, detected by `HARNESS_WORKSPACE_ID` env var (§ 6.4). |
| **TUI parity** | The invariant that every TUI keystroke action has an equivalent non-interactive subcommand (F10). |
| **Verbatim-stable** | A public-contract guarantee that flag names, exit codes, and JSON output keys do not change without a major version bump (F58). |

---

*End of PRD.*
