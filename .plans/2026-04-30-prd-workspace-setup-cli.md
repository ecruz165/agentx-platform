# Workspace Setup CLI — PRD

**Status:** Draft
**Date:** 2026-05-01
**Author:** Edwin Cruz
**Audience:** Engineering, devops, product reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-prd-workspace-template.md` — the template this CLI bootstraps from
- `.plans/2026-04-30-prd-harness-server.md` — orchestration brain that spawns workers via this CLI's installed primitives
- `.plans/2026-04-30-prd-edge-memory-server.md`, `.plans/2026-04-30-prd-edge-context-server.md` — peer servers brought up by `harness init`

---

## 1. Goal

A bootstrap installer that brings a new user from "zero" to "working agentic workspace with three always-on servers running and a worker DevContainer template registered for parallel jobs" in a single command.

The CLI owns three primary verbs:

1. **`harness init`** — first-time setup. Detects prereqs, clones the workspace template, pulls/builds images, starts the three always-on DevContainers (harness-server, edge-memory-server, edge-context-server), registers the worker DevContainer template with `@devcontainers/cli`, generates `~/.harness/cli-config.yml`, and optionally installs the VS Code extension.
2. **`harness server <start|stop|status|restart|prewarm>`** — lifecycle management for the always-on triad.
3. **`harness submit <pipeline> ...`** — the user-facing entry point that triggers harness-server to spawn an ephemeral worker DevContainer per "work effort" via `@devcontainers/cli`. (The actual spawning is harness-server's job; the CLI is a thin client.)

Plus operator helpers: `harness doctor`, `harness update`, `harness uninstall`, `harness join` (join an existing remote workspace).

Ships as `@your-org/agentic-workspace-setup-cli` runnable via `npx`. After `init`, the user's `harness` CLI binary is installed and the same binary handles all subsequent commands.

**Why this CLI is meaningfully different from the per-server CLIs (`harness memory ...`, `harness context graphrag ...`):** the per-server CLIs run *against an already-running workspace*. This CLI runs *to bring the workspace into being*. It owns container lifecycle, prereq detection, file generation, and idempotency — concerns the per-server CLIs assume away.

## 2. Personas served

| Persona | Need |
|---|---|
| **Iris** (first-time user) | One-command bootstrap from `npx`; sensible defaults; clear errors when prereqs fail. |
| **Daisy** (returning developer) | `harness server start` after a reboot; `harness submit` to start a new work effort. |
| **Owen** (operator / SRE) | `harness doctor` for triage; `harness update` to bump server versions; `harness uninstall` to cleanly remove. |
| **Quinn** (curious lurker) | `harness attach <jobId>` to peek at a running worker DevContainer (via tmux read-only). |

## 3. User stories

- *As Iris*, I run `npx @your-org/agentic-workspace-setup-cli init my-workspace` from any directory, follow prompts (or pass `--config init.yml` for non-interactive), and within ~5 minutes have three running peer-server containers + a worker template ready to instantiate per-job.
- *As Daisy*, after a reboot I run `harness server start` and the three always-on containers come back up; `harness server status` confirms they're healthy.
- *As Daisy*, I run `harness submit fix-bug --input task.md` and watch a fresh worker DevContainer spin up and start streaming events. Submitting a second job in another terminal spawns a second worker — they don't conflict.
- *As Owen*, I run `harness doctor` and the CLI checks Docker, `@devcontainers/cli`, git, tmux, server health, container reachability, worker-template validity, and `cli-config.yml` consistency. Each check passes or fails with a remediation hint.
- *As Owen*, I run `harness update` and the CLI pulls newer images for the three peer servers, restarts them in dependency order, and re-validates the worker template.
- *As Iris*, when the install fails (e.g., Docker not running), the CLI tells me what's missing and how to fix it — never silently proceeds.
- *As Daisy*, I run `harness uninstall --keep-data` and the CLI stops the containers and removes the binary but preserves `~/.harness/` and the workspace's data volumes.

## 4. Functional requirements

### 4.1 Prereq detection

| ID | Requirement |
|---|---|
| F1 | `harness init --check` runs prereq detection without making changes; outputs a checklist of pass/fail per item with remediation hints. |
| F2 | Required prereqs verified: Docker (or Podman) ≥24, `@devcontainers/cli` ≥0.50, git ≥2.40, Node ≥20, tmux ≥3.2 (for read-only attach). Missing prereqs block `init` with clear messages. |
| F3 | Optional prereqs detected: VS Code or Cursor (for extension install), `gh` CLI (for github-source integration). Missing optionals warn but don't block. |
| F4 | Platform detection (macOS, Linux x86_64, Linux arm64, Windows-WSL2). Native Windows in v1.x. |
| F5 | If `@devcontainers/cli` is missing, `init` offers to install it (`npm i -g @devcontainers/cli`) with explicit user consent. |

### 4.2 Workspace bootstrap

| ID | Requirement |
|---|---|
| F6 | `harness init [name]` clones the workspace template (`github.com/your-org/agentic-workspace-template`) into `./<name>` (default: `agentic-workspace`). |
| F7 | `harness init --use ./existing-workspace` adopts an existing checkout that follows the template's directory layout. |
| F8 | Idempotent: running `init` against an already-initialized workspace re-validates state, repairs missing files, but does not overwrite user customizations to `harness-workspace.yml` or `cli-config.yml` without `--force`. |
| F9 | Generates `~/.harness/cli-config.yml` pointing at the workspace's UDS sockets / forwarded TCP ports. |
| F10 | Generates `.harness/run/`, `.harness/wt/` (worktree root), `.harness/captures/` directories with mode `0700`. |
| F11 | Pre-seeds the five reference pipelines (per workspace-template F16) in `.harness/config/pipelines.json`. |
| F12 | Non-interactive mode: `harness init --config init.yml` reads all prompts from a config file (for CI / scripted deploys). |

### 4.3 Always-on server lifecycle (the 3 peer-server DevContainers)

| ID | Requirement |
|---|---|
| F13 | `harness server start` runs `docker compose -f .devcontainer/docker-compose.yml up -d` to start the three always-on DevContainers (harness-server, edge-memory-server, edge-context-server). Streams logs to terminal until containers are healthy or fails fast. |
| F14 | `harness server stop` runs `docker compose ... down` (preserves volumes by default). `--volumes` flag removes data volumes after a y/N confirmation. |
| F15 | `harness server status` queries each server's `/health` endpoint over its UDS socket and reports `{ ok, state, uptimeMs, version }` per server, plus aggregate workspace status. |
| F16 | `harness server restart [<server>]` restarts one or all of the three. Default: rolling restart (memory → context → harness) to minimize disruption. |
| F17 | `harness server prewarm` invokes each server's `/health` endpoint and a no-op tool to force warmup before a known-busy session. |
| F18 | Cross-platform service registration is **out of scope for v1** — the always-on DevContainers run only when `harness server start` is invoked; no launchd / systemd / Task Scheduler integration. v1.x adds opt-in auto-start. |

### 4.4 Worker DevContainer template registration

| ID | Requirement |
|---|---|
| F19 | `harness init` validates the workspace's `.devcontainer/worker/devcontainer.json` exists and parses cleanly via `devcontainer read-configuration --workspace-folder .devcontainer/worker`. |
| F20 | `harness init` invokes `devcontainer build --workspace-folder .devcontainer/worker --image-name harness-worker:dev` to prebuild the worker image; subsequent job submissions reuse the cached image. |
| F21 | `harness server status` includes a "worker template" health line: `{ valid: true, lastBuilt: ..., imageId: ... }`. |
| F22 | `harness workspace prune --workers` removes all stopped worker containers older than configured TTL (default 7 days) using `docker container prune` filtered by the `harness-worker` label. |
| F23 | The worker template's `devcontainer.json` declares mounts that the harness-server populates per spawn (job-specific worktree path, agent SKILL files, UDS sockets to peer servers); registration validates these mount points reference existing host paths. |

### 4.5 `@devcontainers/cli` integration (worker spawn lifecycle)

The harness-server is the entity that *spawns* worker DevContainers per job; this CLI is responsible for ensuring the spawn primitives exist and work. The contract:

| ID | Requirement |
|---|---|
| F24 | The workspace ships a `.harness/scripts/spawn-worker.sh` (provided by workspace-template F30) that the harness-server invokes for each job. The script wraps `devcontainer up --workspace-folder .devcontainer/worker --override-config <per-job-overrides.json> --remove-existing-container`. |
| F25 | Per-job override file (generated by harness-server) injects: `mounts` (worktree, SKILL files, UDS sockets), `containerEnv` (`JOB_ID`, `WORKSPACE_ID`, `HARNESS_SOCKET_PATH`, etc.), `runArgs` (CPU/memory limits, `--label harness-worker=true`, `--label harness-job-id=<id>`). |
| F26 | After `devcontainer up` returns, harness-server invokes `devcontainer exec --workspace-folder .devcontainer/worker --container-id <id> -- /usr/local/bin/harness-worker --job <id>` to start the worker process. The worker process uses `agentic-worker-lib` to bootstrap the agent (per the agentic-worker-lib PRD). |
| F27 | Multiple parallel `devcontainer up` invocations (one per concurrent job) succeed without conflict — each gets its own container ID, network alias, and worktree mount. |
| F28 | On job completion (success or failure), harness-server invokes `devcontainer down --workspace-folder .devcontainer/worker --container-id <id>` to clean up. The worktree is preserved by default (per workspace-template F21) for diff inspection / PR opening. |
| F29 | The CLI installs a `harness workspace doctor --workers` subcommand that simulates a fake job spawn through the same primitives and verifies the full lifecycle (up → exec → down) succeeds in <60s. |

### 4.6 cli-config.yml generation

| ID | Requirement |
|---|---|
| F30 | `harness init` generates `~/.harness/cli-config.yml` with `default_workspace`, per-workspace UDS socket paths, fallback TCP ports, log paths. |
| F31 | Multiple workspaces supported: re-running `harness init my-other-workspace` appends a workspace entry without overwriting existing ones. |
| F32 | `harness use <workspace>` switches the default workspace; `harness workspace list` enumerates known workspaces. |
| F33 | `cli-config.yml` schema is Zod-validated on every CLI invocation; corrupt/incomplete configs fail with a path-rooted error. |

### 4.7 Auth wiring (v1: minimal)

| ID | Requirement |
|---|---|
| F34 | Per the harness-ecosystem v1 trust posture (`harness-server § 4.3`, edge servers' `§ 4.3`), v1 has no app-level auth. `harness init` does not generate or rotate any tokens. UDS file-perm + loopback-only is the security boundary. |
| F35 | `harness init --auth-config v1x.yml` is reserved syntactically but not implemented in v1 — placeholder for v1.x when application-level auth lands. |
| F36 | If the user runs `harness init` against a workspace declaring `auth.provider: mtauth` (legacy template syntax), the CLI warns + ignores the field, recommends migrating the workspace yaml to v1 syntax. |

### 4.8 Optional VS Code extension install

| ID | Requirement |
|---|---|
| F37 | `harness init --with-vscode` (or interactive `y/N` prompt) installs `@your-org/agentic-harness-vscode` via `code --install-extension` (or Cursor equivalent). |
| F38 | Detection of running VS Code / Cursor instances; offer to reload the window after install. |
| F39 | Extension install is opt-out by default (`--no-vscode` to skip even if available). |

### 4.9 Doctor / update / uninstall

| ID | Requirement |
|---|---|
| F40 | `harness doctor` runs the full health-check matrix: prereqs (F1-F4), server status (F15), worker-template validity (F21), spawn-lifecycle smoke test (F29), `cli-config.yml` integrity (F33). Outputs JSON when invoked with `--json`. |
| F41 | `harness update` pulls newer images for the three peer servers (`docker compose pull`), runs migrations if any, restarts in dependency order. Includes `--dry-run` flag. |
| F42 | `harness uninstall` stops containers, optionally removes images / volumes (`--remove-data`), removes the CLI binary (`--remove-cli`). Default keeps volumes + binary; explicit flags required to delete. |

### 4.10 Join existing workspace (multi-machine)

| ID | Requirement |
|---|---|
| F43 | `harness join <workspace-url>` registers a remote workspace's connection details into local `cli-config.yml` without bringing up local containers. (For users targeting a remote multi-tenant deployment in v1.x — placeholder in v1.) |
| F44 | v1 implementation: returns a not-implemented message pointing at v1.x release notes. v1 is single-machine DevContainer only. |

## 5. Non-functional requirements

### 5.1 Performance

| ID | Requirement |
|---|---|
| N1 | `harness init` cold path (clean machine, prebuilt images cached): <5 minutes wall-clock. |
| N2 | `harness init` cold-cold (no images cached, must build): <15 minutes. |
| N3 | `harness server start` on warm system: <30s to all-healthy. |
| N4 | `harness server status`: <500ms p95. |
| N5 | `harness doctor`: <10s for the full check matrix on a healthy workspace. |
| N6 | Worker spawn lifecycle (`devcontainer up` → worker process responding to harness-server): <15s p95 on a warm worker image. |

### 5.2 Reliability

| ID | Requirement |
|---|---|
| N7 | Idempotent: re-running any subcommand multiple times produces the same end state. |
| N8 | Crash-safe: if `harness init` is killed mid-run, re-running resumes from the last completed step (state tracked in `~/.harness/init-state.json`). |
| N9 | Clear failure modes: every error message includes (a) what failed, (b) why (raw stderr if applicable), (c) remediation hint or relevant `harness doctor` subcommand to diagnose. |

### 5.3 Cross-platform

| ID | Requirement |
|---|---|
| N10 | macOS (Docker Desktop / Colima / Orbstack), Linux x86_64, Linux arm64, Windows-WSL2 in v1. Native Windows v1.x. |
| N11 | Shell scripts (`spawn-worker.sh`, etc.) are POSIX-compliant; PowerShell variants ship in v1.x. |

## 6. Technical approach

- **Primary tool:** `@devcontainers/cli` for both validation/prebuild (init time) and per-job spawn (runtime, invoked by harness-server). v1 shells out to it; v1.x may import it as a library if perf demands.
- **Always-on orchestration:** docker-compose (or `docker compose` plugin) for the three peer-server DevContainers — they share lifecycle, share a network, and need `up -d` semantics. Compose handles networking, volume mounting, and health-check coordination.
- **Per-job orchestration:** `devcontainer up` — each worker is its own DevContainer instance, ephemeral, isolated. Not in the compose file (would force coupled lifecycle).
- **Language:** TypeScript on Bun-compiled standalone binary (fast cold-start matters here — the user's first interaction with the system).
- **CLI framework:** commander; Zod for config validation; `prompts` for interactive flows; `chalk` (optional) for colored output.
- **Image pull strategy:** parallel `docker pull` on the three server images; serial install steps after to avoid race conditions in `cli-config.yml` writes.
- **Auth:** none in v1 (per § 4.7). `~/.<your-org>/auth.json` from auth-lib is a separate concern; this CLI doesn't manage it.
- **State tracking:** `~/.harness/init-state.json` records install progress for crash-safe resume; `~/.harness/cli-config.yml` is the runtime config.

## 7. CLI surface

```
harness init [name]                          # first-time setup
   --check                                   # dry-run: detect prereqs only
   --use <path>                              # adopt existing workspace
   --config <init.yml>                       # non-interactive
   --with-vscode | --no-vscode               # extension install
   --force                                   # overwrite existing files (dangerous)

harness server <verb>                        # always-on triad lifecycle
   start [--prewarm]
   stop [--volumes]
   status [--json]
   restart [<server>]
   prewarm

harness submit <pipeline> [args]             # thin client → harness-server
   --input <file>
   --profile <name>
   --watch                                   # tail events

harness workspace <verb>
   list
   status
   prune [--workers] [--worktrees]
   doctor [--workers]                        # spawn-lifecycle smoke test

harness use <workspace>                      # switch default workspace
harness join <url>                           # placeholder in v1

harness doctor [--json]                      # full health-check matrix
harness update [--dry-run]                   # pull newer server images
harness uninstall [--remove-data] [--remove-cli]

harness attach <jobId>                       # tmux read-only attach (delegates to workspace-template's attach-tmux.sh)
```

## 8. Acceptance criteria

- `npx @your-org/agentic-workspace-setup-cli init my-workspace` on a clean machine with prebuilt images cached completes in <5 minutes and ends in `harness server status` reporting all three servers healthy.
- A subsequent `harness submit fix-bug --input task.md` triggers harness-server to spawn a worker DevContainer via `devcontainer up`; logs stream; on completion the worktree exists at `.harness/wt/<jobId>/` and the worker container is removed.
- Two parallel `harness submit` invocations spawn two separate worker DevContainers without conflict.
- `harness doctor` on a healthy workspace returns all-green in <10s; on a misconfigured workspace, every red line includes a remediation hint.
- `harness uninstall` cleanly stops containers; with `--remove-data` removes volumes; without flags preserves user data.
- `harness init --config init.yml` runs end-to-end non-interactively (CI-suitable).
- The CLI runs on macOS (darwin), Linux (x86_64 + arm64), Windows-WSL2.

## 9. Out of scope (this PRD)

- **Cross-platform service auto-start** (launchd / systemd / Task Scheduler) — `harness server` is manual-start in v1; v1.x adds opt-in auto-start.
- **Native Windows DevContainers** — WSL2 only in v1.
- **Multi-machine remote-workspace join** — `harness join` is a placeholder in v1.
- **Auth token management** — deferred to v1.x when application-level auth lands.
- **GPU / accelerator-aware worker spawning** — v1.x.
- **Air-gapped install** — post-v1.
- **Custom worker DevContainer image registries beyond Docker Hub + ghcr.io** — post-v1.

### 9.1 Deferred to v1.x

- Cross-platform service registration (auto-start at login).
- `harness join` against remote (multi-tenant) workspaces.
- Per-tenant credentials provisioning during `init` (currently no auth in v1).
- PowerShell-native scripts for native Windows.

## 10. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `@devcontainers/cli` ≥0.50 | Primary lifecycle tool for validating + prebuilding the worker template, and per-job worker spawn (driven by harness-server using the same primitive) | **Hard** |
| Docker ≥24 (or Podman ≥4) | Container runtime | **Hard** |
| docker-compose plugin (or standalone) | Always-on triad orchestration | **Hard** |
| Git ≥2.40 | Cloning + worktree support (worktree usage in workers) | **Hard** |
| Node ≥20 | CLI runtime + `@devcontainers/cli` requires Node | **Hard** |
| tmux ≥3.2 | `harness attach` read-only mode | **Soft** (only required for the attach feature) |
| VS Code or Cursor | Extension install (optional flag) | **Soft** |
| `gh` CLI | Workspace clone fallback when not using a template repo | **Soft** |

## 11. Open questions

| # | Question |
|---|---|
| WS1 | Should `harness init` warn vs. block when the user is on Docker Desktop with very low resource limits (e.g., <8GB allocated)? Lean: warn, with a guide link. |
| WS2 | `@devcontainers/cli` shell-out vs. library import — measure cold-start cost; if shell-out adds >1s per spawn, switch to library. Lean: shell-out in v1, profile + reconsider in v1.x. |
| WS3 | Where should `cli-config.yml` live in the multi-workspace case — `~/.harness/cli-config.yml` (single global) vs. `<workspace>/.harness/cli-config.yml` (per-workspace)? Lean: global with multiple workspace entries (matches `default_workspace` switching). |
| WS4 | Should `harness submit` block-and-wait by default or background-and-return? Lean: background-and-return; `--watch` to tail events. |
| WS5 | `harness server prewarm` — invoke once during `init` or only on explicit demand? Lean: only on explicit demand; first-job latency is acceptable. |
| WS6 | Worker image prebuild — single architecture (host arch) or multi-arch buildx? Lean: host-arch in v1; multi-arch v1.x. |
| WS7 | Should the CLI ship its own embedded `@devcontainers/cli` (vendored) or require a globally-installed one? Lean: require globally-installed (one less duplicate; matches user instinct); offer to install if missing. |

## 12. Implementation milestones

Aligns with implementation plan's Phase 2 (after the workspace template + harness-server are sufficient to drive a real `init`):

- **WSC-1** — CLI skeleton: commander wiring, Zod config schemas, `init` interactive prompts (1 day)
- **WSC-2** — Prereq detection + remediation messaging (`harness init --check`) (1 day)
- **WSC-3** — Workspace clone / adopt / file generation (`init` non-`--check` path) (1.5 days)
- **WSC-4** — `harness server` lifecycle subcommands wrapping docker-compose (1 day)
- **WSC-5** — Worker DevContainer template validation + prebuild via `@devcontainers/cli` (F19-F23) (1.5 days)
- **WSC-6** — `harness workspace doctor --workers` spawn-lifecycle smoke test (1 day)
- **WSC-7** — `cli-config.yml` generation + multi-workspace switching (`harness use`) (1 day)
- **WSC-8** — `harness doctor` full health-check matrix (1 day)
- **WSC-9** — `harness update` + `harness uninstall` (1 day)
- **WSC-10** — VS Code extension install integration (~0.5 day)
- **WSC-11** — Non-interactive `--config init.yml` path (~0.5 day)
- **WSC-12** — Cross-platform CI matrix: macOS + Linux + WSL2 (1 day)
- **WSC-13** — Documentation: install guide, troubleshooting, customization (1 day)

Total: ~13 working days for one engineer.

**Sequencing note:** WSC-5 + WSC-6 require the workspace-template's worker DevContainer definition to be stable, and harness-server's spawn-lifecycle integration (HS-4) to exist as a target for WSC-6's smoke test. Hold WSC-5/6 until those are at least HS-4 milestone-complete.

---

*End of Workspace Setup CLI PRD.*
