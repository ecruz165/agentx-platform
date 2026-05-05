# Context Loader CLI — PRD

**Status:** Draft (2026-05-05)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `.plans/2026-05-05-prd-context-loader-core.md` — the library this CLI wraps; defines source types, backends, programmatic API
- `.plans/2026-04-30-prd-harness-cli.md` — for the workspace-shim relationship (`harness context source <verb>`)
- `.plans/2026-04-30-prd-harness-server.md` — for the spawn-worker integration in job mode

---

## 1. Purpose

A standalone CLI binary `agentx-load` (shipped via `@agentx/context-loader-cli`) that wraps `@agentx/context-loader-core` to make context-source ingestion runnable as a one-shot CLI process. The CLI:

- Accepts subcommands aligned with the `context source` namespace (`add`, `list`, `describe`, `refresh`, `remove`, `crawl`, `upload`, `oss`, `types`, `stats`, `dry-run`).
- Runs in two modes:
  - **Standalone mode** — runs in-process, writes directly to a configured backend, no harness triad required. Default invocation context.
  - **Job mode** — invoked as a worker container's entrypoint by harness-server's `spawnWorker`; emits structured progress events to a UDS event channel (the `--output-events-uds` protocol) so the harness TUI can show live ingestion progress and cancel via container kill.
- Reads workspace-aware config from `<workspace>/.harness/config/context-sources.yml` when run inside a workspace; falls back to `~/.agentx/context-sources.yml` (user-global) or pure-CLI-flag config when no workspace is detected.

The CLI exists as a separate package from the lib because:
1. **Different audiences** — the lib is for code authors importing it; the CLI is for end-users running commands.
2. **Different distribution** — the lib is npm-published-and-imported; the CLI is bun-built into a standalone binary that may be packaged separately for OS distributions.
3. **Different lifecycle concerns** — UX/ergonomics vs API stability.

Per `prd-harness-core.md`'s convention (separate PRDs for harness-core, harness-server, harness-cli), each package gets its own design doc.

## 2. Goals (v1)

- **Single binary `agentx-load`.** Built with Bun for fast cold-start. Distributable as a npm-installable package and (eventually) standalone executables via `bun build --compile`.
- **Subcommand surface mirrors the user's mental model.** The user thinks "context sources" — the CLI exposes verbs operating on them: `add`, `list`, `refresh`, `remove`, etc. Implementation terms (chunkers, backends, embedders) are flag-level config, not subcommands.
- **Standalone mode is the default and primary use case.** Run on a laptop with a Neo4j instance, no agentx triad needed; works end-to-end.
- **Job mode is a clean opt-in.** Triggered by a single env var (`JOB_ID`) plus flag (`--output-events-uds`). When detected, behavior changes to emit events over UDS instead of stdout, catch `SIGTERM` for graceful cancellation, and respect the worker container's lifecycle.
- **Workspace-shim parity with the standalone CLI.** `@agentx/harness-cli`'s `harness context source <verb>` exposes the same subcommands and flags; both paths invoke the same lib functions. Two doors, one room.
- **Config-driven repeatable runs.** `<workspace>/.harness/config/context-sources.yml` declares default sources, embedder URL, backend selection. CLI invocations can override any of those via flags but the config provides reasonable defaults.

## 3. Non-Goals (v1)

- **No interactive UI inside `agentx-load` itself.** No TUI mode, no fancy progress bars beyond simple line-based output. Job mode emits structured events; the consumer (harness TUI) renders them.
- **No daemon mode.** Each invocation is one ingestion run. State persists in the graph backend, not in the CLI process.
- **No automated dep discovery from manifests.** v1 requires explicit `agentx-load oss add <package>@<version>`. (Auto-detect from `package.json` is on the v1.x roadmap.)
- **No background scheduling.** `refreshSchedule: daily` in `context-sources.yml` is a *declaration* of intent — actually triggering daily runs requires cron, harness-server's job-scheduling (per `prd-harness-server.md`), or external orchestration. The CLI runs on demand.
- **Not a benchmarking harness.** When you want to compare embedders, that's the bench profile in compose plus your own scripts. The CLI doesn't ship a built-in benchmarker.
- **No GUI / web interface.** CLI only.

## 4. Reference & Provenance

- All chunking, profile, backend, and graph-write semantics live in `prd-context-loader-core.md`. This PRD only describes the CLI surface.
- The job-mode UDS protocol mirrors how `@agentx/agent-adapter`'s adapters emit events into `JobBus` for the harness TUI — same event-routing pattern, different event types (per `prd-context-loader-core.md` F41).
- The workspace-shim relationship follows the precedent set by `harness submit` (which proxies to `harness-server` via UDS): `harness context source <verb>` is a thin shim that either imports the lib directly (in-process) or shells out to `agentx-load`.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Iris (installer / new user)** | One-shot `agentx-load <repo>` on a laptop with a Neo4j running. No setup beyond the binary install. |
| **Daisy (developer at keyboard, in a workspace)** | `harness context source add --type oss-code react@18.2.0`. Get progress in the TUI. Cancel mid-run if it takes too long. |
| **Owen (operator / SRE)** | `agentx-load oss refresh-issues react`. Cron-schedule via `agentx-load oss add ... --refresh-schedule daily`. Inspect what's ingested via `agentx-load list`. |
| **CI/CD pipeline** | Invoke `agentx-load <path> --backend neo4j://central:7687 --no-progress` from a build step. Exit code 0 on success, non-zero on any error. |

User stories:
- *As Iris*, I run `agentx-load https://github.com/openai/openai-cookbook --type oss-code --backend neo4j://localhost:7687`. The CLI clones, walks, parses, embeds, writes to Neo4j. I never run a triad.
- *As Daisy*, I run `harness context source add --type oss-code react@18.2.0`. The harness-server spawns a worker container running `agentx-load`. The TUI shows live progress: "1234 files walked, 5678 chunks embedded, 9 errors." I press `c` to cancel.
- *As Owen*, I run `agentx-load --config /etc/agentx/sources.yml`. The config declares 5 OSS deps, an internal Jira instance, and a docs crawl. The CLI walks all of them in sequence, emits events to stdout, exits 0 on success.

## 6. Functional Requirements

### 6.1 CLI binary + invocation

| ID | Requirement |
|---|---|
| F17 | `@agentx/context-loader-cli` ships a single binary `agentx-load`. Built with Bun for fast cold-start (<100ms p95). Distributed as an npm-installable package. |
| F18 | The binary parses argv via `commander` (or equivalent) and dispatches to subcommands. Help text is exhaustive (`--help` on every subcommand) and includes example invocations. |
| F22 | Help text for every subcommand explains the source type the verb operates on. `agentx-load --help` and `harness context source --help` produce equivalent output. |

### 6.2 Subcommand surface

| ID | Requirement |
|---|---|
| F18a | **`add <target>`** — register and ingest a context source. `target` is a path, URL, or package spec. `--type <id>` overrides auto-detection. Common flags: `--backend`, `--embedder-url`, `--profile-config`, `--dry-run`. |
| F18b | **`list`** — show registered sources. Flags: `--type <id>`, `--backend <selection>`, `--format json|table`. |
| F18c | **`describe <source-id>`** — show what was ingested for a source: counts, last refresh, chunk samples. |
| F18d | **`refresh <source-id>`** — re-ingest a source incrementally (per `prd-context-loader-core.md` F15: content-hash dedup means unchanged content is a no-op). |
| F18e | **`remove <source-id>`** — drop nodes/edges/vectors for a source. Confirmation prompt unless `--yes`. |
| F18f | **`crawl <url>`** — invoke the crawled-web source type. Flags: `--scope page|subtree|site`, `--max-depth`, `--rate-limit-per-host`, `--allowed-domains`. |
| F18g | **`upload <file>`** — single-file upload (PDF, image, etc.). Auto-detects type from MIME / extension. |
| F18h | **`oss <verb>`** — convenience namespace for OSS deps. `oss add <package>@<version>` runs the trio (oss-code + oss-docs + oss-issues) by default; `--only <type>` narrows. `oss list`, `oss refresh <package>`, `oss remove <package>`. |
| F18i | **`types`** — list registered source types. `types describe <id>` shows the rules for a specific type. |
| F18j | **`stats`** — count nodes/edges/vectors per source / per type / per backend. |
| F18k | **`dry-run <target>`** — show what would be ingested, no writes. Useful for validating matchers + chunking before committing. |

### 6.3 Standalone vs job mode

| ID | Requirement |
|---|---|
| F19 | **Standalone mode** is the default. Detected when `--output-events-uds` is absent and no `JOB_ID` env is set. The CLI emits human-readable progress to stdout (or structured JSON if `--output json`), exits with conventional Unix codes (0 success, non-zero on errors). |
| F20 | **Job mode** is detected when `--output-events-uds=<path>` and `JOB_ID` are both present. The CLI: (a) routes structured events to the UDS instead of stdout, (b) tags every emitted event with `JOB_ID`, (c) catches `SIGTERM` for graceful cancellation (flushes in-flight buffers, writes a `cancelled` event, exits within 5s), (d) writes a `source-completed` event before normal exit. |
| F37 | The CLI does not assume harness-server is reachable in standalone mode. UDS paths and `JOB_ID` env are the *only* signals that switch to job mode; their absence means standalone. |

### 6.4 Job-mode UDS protocol

| ID | Requirement |
|---|---|
| F38 | The UDS named by `--output-events-uds` is opened by the CLI as a writer (the harness-server side opens it as a reader). Events are JSON objects, one per line, terminated by `\n`. Schema is `IngestionEvent` from `prd-context-loader-core.md` F41. |
| F39 | Each event is augmented in job mode with `jobId: <string>` and `ts: <ISO-8601>`. The augmentation is the CLI's responsibility, not the lib's. |
| F40 | If the UDS is closed by the reader (e.g., harness-server crashes mid-job), the CLI logs to stderr and continues writing to stdout as a fallback — does not crash. |

### 6.5 spawn-worker integration

| ID | Requirement |
|---|---|
| F41 | `harness-server`'s `spawnWorker` (per `packages/harness-server/src/spawn-worker.ts`) gains a code path for ingestion jobs: when a job's body has `kind: 'ingestion'`, the generated devcontainer override sets `agentx-load` as the entrypoint, mounts the workspace `.harness/run/` for the events UDS, and passes the source spec via env vars. |
| F42 | Job submission API: `harness submit ingest --type <source-type> <target>`. Internally constructs a job body `{ kind: 'ingestion', sourceType, target, profile?, options? }`, registers it via the existing `POST /v1/jobs` route, harness-server spawns the worker. |
| F43 | Multiple ingestion jobs run in parallel (one worker container each). All workers share the same embedder service (HTTP fan-in handled by TEI's `--max-concurrent-requests`). Backend writes serialize at the storage layer (Kuzu WAL or Neo4j Bolt session). |

### 6.6 Workspace shim integration

| ID | Requirement |
|---|---|
| F21 | `@agentx/harness-cli` exposes `harness context source <verb>` as a thin shim. Internally it either (a) imports `@agentx/context-loader-core` directly and executes in-process (default), or (b) shells out to `agentx-load` (fallback for when the workspace shim wants to delegate to the standalone binary). v1 default: import-and-execute path. |
| F44 | Workspace-shim invocations auto-discover config from `<workspace>/.harness/config/context-sources.yml` via `findWorkspaceRoot()`. Standalone-CLI invocations require `--config <path>` or fall back to `~/.agentx/context-sources.yml`. |
| F45 | The two paths produce identical events and identical graph state. Tests verify parity. |

## 7. Non-Functional Requirements

### 7.1 Latency targets

| Operation | p95 (warm) | p99 (warm) |
|---|---|---|
| `agentx-load --help` cold start | <100ms | <250ms |
| `agentx-load list` (in-memory state) | <200ms | <500ms |
| `agentx-load dry-run <small-repo>` | <2s | <5s |
| `agentx-load add <small-repo>` end-to-end | depends on lib (see core PRD §7.1) | — |

### 7.2 Reliability

- Survives missing-config: `agentx-load --help` and `agentx-load types` work without any config file.
- Survives partial failures: per-file errors don't abort the whole run; emitted as `error` events; final exit code reflects whether any errors occurred (`0` for clean success, `1` for at-least-one-error, `2` for fatal/abort).
- Survives Ctrl+C gracefully: standalone mode catches `SIGINT`, flushes buffers, exits within 5s.
- Survives `SIGTERM` in job mode: same as Ctrl+C but also writes a `cancelled` event to the UDS.

### 7.3 Resource

- Idle RSS: <50 MB (CLI process; embedder service excluded).
- Active RSS during ingestion: bounded by lib (see core PRD §7.4).

## 8. CLI Surface — full reference

```bash
# Direct invocation (standalone CLI, binary: agentx-load)
agentx-load <target>                                    # auto-detect type from input
agentx-load add <target> --type code-full
agentx-load add ./my-repo --type code-full
agentx-load add react@18.2.0 --type oss-code
agentx-load add ./docs --type prose-markdown

# OSS namespace (the trio convenience)
agentx-load oss add react@18.2.0
agentx-load oss add react@18.2.0 --only oss-code
agentx-load oss add react@18.2.0 --only oss-code,oss-docs
agentx-load oss list
agentx-load oss refresh react
agentx-load oss remove react@17.0.0

# Crawling
agentx-load crawl https://react.dev --scope site --max-depth 3
agentx-load crawl https://react.dev --scope subtree --rate-limit-per-host 2

# Inspection
agentx-load list                                        # all sources
agentx-load list --type oss-code
agentx-load describe <source-id>                        # details for one source
agentx-load types                                       # built-in catalog
agentx-load types describe oss-code                     # rules for that type
agentx-load stats                                       # counts: nodes/edges/vectors

# Validation
agentx-load dry-run <target>                            # what would happen, no writes
agentx-load dry-run <target> --type code-full --verbose

# Backend selection (overrides config)
agentx-load <target> --backend kuzu://./data/context
agentx-load <target> --backend neo4j://localhost:7687
agentx-load <target> --backend neo4j --uri neo4j://my.host:7687 --username neo4j

# Embedder override (overrides config; useful for benchmarking)
agentx-load <target> --embedder-url http://embedder-qwen:8080/v1
agentx-load <target> --embedder-url http://localhost:8080/v1 --embedder-model jinaai/jina-embeddings-v3

# Job mode (typically invoked by harness-server's spawnWorker, not by hand)
agentx-load <target> --output-events-uds=/run/job-events.sock
  # JOB_ID env must be set; CLI emits IngestionEvent JSON to the UDS

# Output formatting (standalone)
agentx-load <target> --output json                      # structured stdout
agentx-load <target> --output progress                  # default: line-based
agentx-load <target> --output silent                    # only errors, exit code carries result

# Workspace shim (in harness-cli) — equivalent surface
harness context source add <target>
harness context source add --type oss-code react@18.2.0
harness context source list
harness context source describe <source-id>
harness context source refresh <source-id>
harness context source remove <source-id>
harness context source crawl <url>
harness context source upload <file>
harness context source types
harness context source types describe oss-code

# Submitting as a job (for parallelism + observability):
harness submit ingest --type oss-code react@18.2.0      # spawns worker container
```

## 9. Job-mode UDS protocol

When `--output-events-uds=<path>` and `JOB_ID` env are both present:

1. **Connection:** CLI opens the UDS as a writer. Per `IngestionEvent` schema (core PRD F41), each event is one JSON object terminated by `\n`.
2. **Augmentation:** every event is wrapped with `{ jobId, ts, ...event }`.
3. **Heartbeat:** if no other event has fired in the last 5s, CLI emits `{ kind: 'heartbeat', jobId, ts }`.
4. **Cancellation:** on `SIGTERM`, CLI emits `{ kind: 'cancelled', jobId, ts, reason: 'sigterm' }` then exits within 5s.
5. **Completion:** on normal exit, CLI emits `{ kind: 'source-completed', jobId, ts, ... }` then closes the UDS and exits 0.
6. **Failure:** on uncaught error, CLI emits `{ kind: 'error', jobId, ts, phase: 'fatal', message }` then exits 2.

The UDS reader (harness-server) parses events line-by-line, routes them onto the job's JobBus, which streams to TUI consumers via SSE.

## 10. Workspace shim relationship

`harness context source <verb>` (in `@agentx/harness-cli`) is the workspace-aware equivalent. Both paths:

- Read the same `<workspace>/.harness/config/context-sources.yml`.
- Use the same `CredentialBroker` (per `agent-auth-lib`) for OSS issues and other authenticated sources.
- Emit the same `IngestionEvent` shape.
- Write to the same backends.

The shim's value: discovers the workspace automatically, so users in a workspace don't need `--config <path>` flags. v1 implementation imports `@agentx/context-loader-core` directly; v1.x may shell out to `agentx-load` for cancellation simplicity.

## 11. Distribution

- **npm package**: `@agentx/context-loader-cli`. `bin: agentx-load` registered in `package.json`. Users install via `bun install -g @agentx/context-loader-cli` (or pnpm/npm).
- **Single-binary builds (v1.x)**: `bun build --compile` produces standalone executables for macOS arm64/x64 and Linux x64. Distributed via GitHub Releases. Useful for users who don't have Node/Bun installed.
- **Cross-platform**: Bun runtime supported on macOS arm64 + macOS x64 + Linux x64 + Windows x64 (in that order of priority).
- **Versioning**: Follows `@agentx/context-loader-core`'s major version. CLI bug fixes can ship as patch versions independently.

## 12. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D2 | Standalone CLI name | `@agentx/context-loader-cli`, binary `agentx-load` | Verb describes action; pairs with the lib name |
| D3 | Concept naming | "context source" / "source type" | Aligns with existing `context` vocabulary; replaces `graphrag` |
| D7 | Standalone vs job mode | Both supported; same binary | Standalone for solo use; job mode for engineering workflows. Feature-flagged via `--output-events-uds` presence |
| D8 | One CLI per job (in job mode) | Yes | Reuses spawn-worker pattern; no daemon; cancellation works via container kill |
| D15 | Bun runtime | Yes — for fast cold-start and consistency with `harness-cli` | Cold-start matters for a "ran often" CLI |
| D16 | Argument parser | `commander` (industry-standard, well-known to TS devs) | Avoid yargs/clipanion lock-in |

### Open

| # | Question |
|---|---|
| O8 | **Single-binary distribution timeline** — v1 npm-only, v1.x compiled binaries; or compiled binaries from day 1? **Lean: npm-only for v1; compiled for v1.x.** |
| O9 | **Output format default** — `progress` (line-based human-readable), `json` (structured), or detect-from-tty? **Lean: detect-from-tty (progress in TTY, json in pipe).** |
| O10 | **Confirmation prompts on `remove`** — always confirm, never confirm, or `--yes` to skip? **Lean: always confirm interactively; auto-skip when stdin not a TTY.** |
| O11 | **`agentx-load watch`** mode (long-running file-watcher) — v1 or v2? **Lean: v2; conflicts with the "no daemon" non-goal.** |

## 13. Implementation Phases

(CLI-specific phases. Lib phases are in `prd-context-loader-core.md` §11.)

**Phase F (depends on core Phase B) — CLI scaffolding** (~1 day)
1. Package skeleton (`packages/context-loader-cli`).
2. Bun bin entrypoint (`src/bin.ts`); commander setup.
3. Subcommands: `add`, `list`, `types`, `dry-run`, `--help`, `--version`.
4. Standalone-mode event-to-stdout printer.
5. Smoke test: `agentx-load add ./packages/harness-core --type code-full --backend kuzu://./data/test` ingests successfully.

**Phase G (depends on Phase F + harness-server changes) — Job mode + workspace shim** (~1 day)
6. `--output-events-uds` flag implementation.
7. `JOB_ID` env detection.
8. SIGTERM handling + graceful shutdown.
9. harness-server's `spawnWorker` ingestion-job code path (depends on harness-server PRD update).
10. `harness submit ingest` command in `harness-cli`.
11. `harness context source <verb>` shim in `harness-cli`.

**Total CLI estimate: ~2 days on top of core's 13 days.**

## 14. Out-of-Scope Forever (intentional)

- **Interactive TUI mode for the standalone CLI.** TUI consumers exist (`harness jobs-tui`) and consume the structured event stream; the CLI itself doesn't render TUI.
- **Web UI / GUI.** CLI only.
- **Embedded scheduler.** Cron / harness-server schedules are external to the CLI.
- **Multi-tenant identity in v1 standalone mode.** Standalone runs single-user; multi-tenant identity comes only via the workspace shim and harness-server (which has the broker).

## 15. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `@agentx/context-loader-core` | The lib this CLI wraps | **Hard** |
| `@agentx/agent-auth-lib` | Re-exported types if user inspects credentials | Soft (transitively from core) |
| `commander` | Argument parsing | **Hard** |
| `kleur` (or chalk) | Terminal color output for human-readable progress | **Soft** (tty-detected) |
| Bun runtime | Build + run | **Hard** |

---

*End of Context Loader CLI PRD.*
