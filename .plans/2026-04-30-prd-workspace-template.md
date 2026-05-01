# Workspace Template (DevContainers + tmux Skill) — PRD

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Engineering, devops, product reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (workspace + worktree concepts)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- Peer PRDs (edge-memory-server, edge-context-server, harness-server) — workspace hosts these

---

## 1. Goal

A cloneable repo template that bootstraps a complete agentic workspace.

### Architectural principles

**Unit of work — job → product → set of repos.** A "product" is a named bundle of repos that belong to the same logical system (e.g., `mobile-app` = `mobile-client-repo` + `backend-api-repo` + `shared-types-repo`). Every job is submitted *against a product*, not against a single repo. The worker DevContainer for that job mounts a worktree from *every* repo in the product, presenting the agent with a synthetic monorepo view (`/workspace/<repo-name>/...` for each). The agent makes cross-repo changes atomically; on completion, harness-server opens N PRs (one per repo that was modified). This matches how real cross-cutting features ship: an "OAuth login" effort might touch frontend + backend + design-system, and the agent should see all three.

**One DevContainer per job (per "work effort").** Each submitted job gets its own ephemeral worker DevContainer, spawned by harness-server via `@devcontainers/cli`, with its own set of git worktrees (one per product repo). Multiple jobs running concurrently against the same product — even touching the same repos — do not corrupt each other's working trees. **The friction model is "two developers collaborating on the same repos"**: parallel efforts can't step on each other's working files; conflicts surface at *PR-merge time* in each repo, not at filesystem-write time. This makes long-running parallel efforts safe — a single developer can have 3+ efforts in flight on the same product simultaneously.

### What the template provides

- **Three always-on DevContainer definitions** for the peer servers (harness-server, edge-memory-server, edge-context-server) — managed by docker-compose, lifecycle controlled by `harness server start/stop`.
- **One worker DevContainer template** instantiated per job via `@devcontainers/cli` (not in compose — ephemeral, isolated, lifecycle owned by harness-server per work effort). At spawn time, harness-server generates a per-job override config that mounts every product repo's worktree.
- **Product declarations and per-job worktree allocation.** `harness-workspace.yml` declares one or more products; each names its repos. `harness-server`'s `WorkspaceManager` runs `git worktree add` for every repo in the product before spawn, `git worktree remove` (or preserve, per policy) after completion.
- A **tmux integration skill** so agents announce their tmux session/window — and developers can attach read-only via `harness attach <jobId>` to inspect work without disturbing it.
- Pre-seeded reference pipelines, default configs, and lifecycle scripts.

This is the "physical home" of an agentic workflow on a developer's machine or in a cluster.

## 2. Personas served

| Persona | Need |
|---|---|
| **Iris** (first-time user) | Clone-and-go bootstrap; everything pre-configured. |
| **Daisy** (developer) | Daily working environment with multiple concurrent agent jobs. |
| **Quinn** (curious lurker) | Peek at running agents read-only via tmux without disturbing them. |
| **Owen** (operator) | Manage workspace lifecycle, tune concurrency, monitor health. |

## 3. User stories

- *As Iris*, I `git clone` the workspace template + run `harness init` and within ~5 minutes I have a working environment.
- *As Daisy*, when I open the workspace in VS Code, it prompts to "Reopen in Container" with everything pre-installed.
- *As Daisy*, multiple agents work in parallel — each in its own DevContainer + worktree — without my host environment being touched.
- *As Quinn*, I run `harness attach job_abc123` and my terminal attaches to that agent's tmux session in **read-only mode** — I can scroll back through history and watch live, but cannot type into the agent's terminal.
- *As Owen*, I run `harness workspace status` and see all containers, worktrees, active jobs, server health.
- *As Owen*, I run `docker-compose down` to gracefully stop everything; `docker-compose up` to bring it all back.
- *As an agent in a worker container*, I emit a `tmux.session-info` skill response advertising my session name + window so observers know where to attach.

## 4. Functional requirements

### 4.1 Repo structure & DevContainers

| ID | Requirement |
|---|---|
| F1 | Repo template at `github.com/your-org/agentic-workspace-template` (template-repo flagged for `gh repo create --template`). |
| F2 | `.devcontainer/harness-server/devcontainer.json` — DevContainer definition for harness-server (Node + Bun + SQLite + harness-server binary + `@devcontainers/cli` for spawning workers). |
| F3 | `.devcontainer/edge-memory-server/devcontainer.json` — DevContainer for edge-memory-server (Node + Bun + `better-sqlite3` + `sqlite-vec` + edge-memory-server binary). |
| F4 | `.devcontainer/edge-context-server/devcontainer.json` — DevContainer for edge-context-server (Node + Bun + KuzuDB + tree-sitter + edge-context-server binary). |
| F5 | `.devcontainer/worker/devcontainer.json` — **worker DevContainer template instantiated per job** by harness-server via `@devcontainers/cli up --workspace-folder .devcontainer/worker --override-config <per-job-overrides.json>`. Includes Node + Bun + git + tmux + claude-code CLI + opencode CLI + copilot CLI + harness CLI + agentic-worker-lib runtime. **Not part of docker-compose** — ephemeral, one container per active work effort, lifecycle owned by harness-server. |
| F6 | `.devcontainer/docker-compose.yml` orchestrates **only the three always-on peer servers**. Workers are spawned via `@devcontainers/cli` per job — not via `docker compose --scale`. This split is deliberate: always-on shares lifecycle (compose semantics fit); per-job workers need independent lifecycles, isolated networks, and per-spawn override configs (devcontainer CLI fits). |
| F7 | Each container has a `Dockerfile.<name>` with reproducible image build; published to Docker Hub as prebuilt for fast first-run. The worker image is the most performance-sensitive (cold-start measured in `harness submit` UX) and is prebuilt aggressively. |
| F8 | Containers communicate via Docker network `harness-net`; UDS sockets shared via volume mount on `~/.harness/run`. Worker DevContainers join the same network at spawn time so they can reach the three peer servers over UDS or DNS. |
| F9 | Resource limits configurable per container — compose file for the three always-on; per-job overrides for workers (declared in the per-job override config harness-server generates per spawn). |

### 4.2 Workspace declaration & config

| ID | Requirement |
|---|---|
| F10 | `harness-workspace.yml` — single source of truth for workspace declaration. |
| F11 | Declares **one or more products**, each a named bundle of repos that belong to the same logical system. For each product: `id`, list of `repos[]` (each with `name`, `cloneUrl`, `baseRef`, optional `path` inside the worker DevContainer), per-product worker resource limits, optional product-scoped pipeline overrides. Use cases: a "mobile feature" product spanning `web-app` + `mobile-client` + `api-gateway` + `shared-types` + `notifications-service`; a "platform migration" product spanning multiple frontends and backends. **Every job is submitted against a product**, so the worker DevContainer always has every needed repo checked out (no mid-run "I need to also clone X" friction). |
| F12 | Workspace also declares: server ports/sockets, max concurrent workers, default worker resource limits, GraphRAG ingestion config, MemoryStore backend. |
| F13 | `.harness/config/pipelines.json` — pipeline catalog (FsConfigStore reads this). Pipelines may target specific products (`product: my-mobile-app`) or be product-agnostic. |
| F14 | `.harness/config/coordinator.json` — coordinator agent config. |
| F15 | `.harness/config/memory.config.yml` — MemoryStore backend config. |
| F16 | `.harness/config/graphrag.config.yml` — GraphRAG ingestion config. GraphRAG ingests *all repos in a product* together so the agent's context queries can span them. |
| F17 | Five reference pipelines pre-seeded: `prd-greenfield`, `brownfield-ui-enhancement`, `brownfield-fullstack-change`, `frontend-techstack-upgrade`, `backend-techstack-upgrade`. |

### 4.3 Worktree management (per-product, multi-repo)

| ID | Requirement |
|---|---|
| F18 | `.harness/wt/<jobId>/<repoName>/` — one worktree per repo in the job's product. The job's working directory layout in the worker DevContainer mirrors `/workspace/<repoName>/` for each. Gitignored from the workspace repo itself. |
| F19 | The worker DevContainer mounts every product repo's worktree under `/workspace/<repoName>/` — the agent sees a synthetic monorepo across the product's repos. The host workspace's source tree is never directly mounted into the worker. |
| F20 | `harness-server`'s `WorkspaceManager` resolves the product → repos list, then runs `git worktree add ./.harness/wt/<jobId>/<repoName> -b agent/<jobId>` against each repo's local clone before spawning. On completion, runs `git worktree remove` per repo (or preserves them per F22 policy). |
| F21 | Worktree branch naming: `agent/<jobId>` in **every repo** that the job touches. Clearly distinguishable in `git branch -a`; lets a developer see "all branches that came from agent jobs" with `git branch --list 'agent/*'`. |
| F22 | Cleanup policy: keep worktrees on success (for diff inspection / PR opening per-repo); delete on failure unless `--keep-failed` configured. Policy is per-product (a product can opt into keep-on-failure for compliance / reproducibility). |
| F23 | `harness workspace prune` removes worktrees + their branches older than configured TTL (default: 7 days). Operates across all products in the workspace. |
| F24 | **Repo cloning is the workspace's job, not the worker's.** Each product's repos are cloned once into `.harness/repos/<repoName>/` (bare or full mirror) by the workspace setup; per-job worktrees are added against those local clones. Eliminates per-job clone latency and saves disk on N parallel jobs against the same product. |

#### 4.3.1 Subagent worktree dimension (mechanism, not policy)

The worktree path schema reserves a `<subagentId>` segment so coordinators *can* allocate parallel worktrees when a pipeline or SKILL calls for fan-out — but the workspace template does **not** decide whether to fan out. Whether a coordinator uses this dimension is dictated by the pipeline's `Fork` FlowNode (design doc § 6.6), the `SKILL.md` file the coordinator is following, or the coordinator's runtime judgment. The workspace owns the *mechanism*; the pipeline / SKILL / coordinator owns the *policy*.

| ID | Requirement |
|---|---|
| F25 | **Path schema** — `.harness/wt/<jobId>/<subagentId>/<repoName>/`. The reserved value `<subagentId> = main` is the coordinator's own working set; fan-out subagents from a `Fork` are allocated as `sub-1`, `sub-2`, … (or pipeline-specified ids). A job that never fans out uses only `main` and the dimension is invisible. |
| F26 | **Branch naming** — `agent/<jobId>` for the coordinator's `main` branch in each repo; `agent/<jobId>/<subagentId>` for subagent branches in each repo each subagent touches. |
| F27 | **Allocation API** — `WorkspaceManager` exposes `allocateSubagent(jobId, subagentId)` and `releaseSubagent(jobId, subagentId)` to the harness library; the runtime calls these when compiling `Fork` to LangGraph `Send` branches (design doc M5.2). The workspace doesn't observe pipeline structure directly — it serves the API. |
| F28 | **Lifecycle defaults** — subagent worktrees default to *delete after the coordinator's `Join` consolidates* (they're inherently transient). Coordinator's `main` worktree follows F22 (keep on success / delete on failure). Coordinators can override per pipeline. |
| F29 | **Disk pressure cap** — optional `maxSubagentsPerJob` field in `harness-workspace.yml` (default unset = no cap). Defense in depth: pipeline-level fan-out caps should already exist; the workspace cap prevents pathological pipelines from filling the disk. Hitting the cap raises a typed config-error at allocation time. |

| ID | Requirement |
|---|---|
| F30 | Worker container entrypoint runs `tmux new-session -d -s agent-${JOB_ID}` and the harness worker binary inside it. |
| F31 | Worker exposes a built-in `tmux.session-info` skill returning `{ sessionName, windowName, workerHost, attachCommand }`. |
| F32 | Agents invoke the skill once at start; harness emits a `tmux-attached` `HarnessEvent` so observers learn where to attach. |
| F33 | `harness attach <jobId>` CLI command resolves the worker host + session name and runs `tmux attach -t agent-<jobId> -r` (read-only). |
| F34 | Attaching multiple observers to the same session is supported (tmux native). |
| F35 | Read-only mode (`-r` flag) prevents accidental input from observers; copy-mode (scrollback) works normally. |
| F36 | tmux config (`.harness/tmux.conf`) sets sane defaults: large scrollback, mouse support, status bar with job id + phase. |

### 4.5 Lifecycle scripts & orchestration

| ID | Requirement |
|---|---|
| F37 | `.harness/scripts/spawn-worker.sh` — invoked by `harness-server` to spawn a worker DevContainer per job. Wraps `devcontainer up --workspace-folder .devcontainer/worker --override-config <per-job.json> --remove-existing-container` (where `per-job.json` is generated per spawn with mounts for the job's worktree + UDS sockets + SKILL files, plus `runArgs` like `--label harness-job-id=<id>`). After `up` returns, runs `devcontainer exec --container-id <id> -- /usr/local/bin/harness-worker --job <id>` to start the worker process. |
| F38 | `.harness/scripts/down-worker.sh` — invoked by `harness-server` on job completion. Wraps `devcontainer down --workspace-folder .devcontainer/worker --container-id <id>`. Worktree preserved by default per F22 (failures keep too if `--keep-failed`); only the container is removed. |
| F39 | `.harness/scripts/attach-tmux.sh` — invoked by `harness attach` CLI; resolves worker container ID, then `devcontainer exec --container-id <id> -- tmux attach -t agent-<jobId> -r`. |
| F40 | `.harness/scripts/cleanup-worktree.sh` — invoked manually or via `harness workspace prune`. |
| F41 | `.harness/scripts/prewarm-servers.sh` — warms all three always-on servers before a known-busy session. |
| F42 | `.harness/scripts/health-check.sh` — verifies all always-on servers + workspace state + worker template validity. |
| F43 | `docker-compose up` brings up the three always-on servers only. Worker DevContainers are spawned dynamically via `@devcontainers/cli` (per F37), not by compose — they have independent lifecycles per work effort. |
| F44 | `docker-compose down --volumes` cleans the always-on servers including data volumes (with confirmation prompt). Worker containers are independent and require `harness workspace prune --workers` to reap stopped instances. |

### 4.6 Cluster mode (Helm)

| ID | Requirement |
|---|---|
| F45 | `helm/` directory with chart for K8s deployment. |
| F46 | Helm chart deploys: harness-server (Deployment, multi-replica), edge-memory-server (StatefulSet, single replica + persistent volume), edge-context-server (StatefulSet, single replica + persistent volume), worker pool (Deployment, scaled by HPA). |
| F47 | Worktrees stored on shared persistent volumes accessible to all worker pods. |
| F48 | tmux integration adapted for cluster mode: workers expose tmux session via `kubectl exec` (or via a custom side-car); `harness attach` resolves through harness-server. |
| F49 | Documented but not v1-validated at scale (acknowledged risk). |

## 5. Non-functional requirements

### 5.1 Performance

| ID | Requirement |
|---|---|
| N1 | Workspace cold-start (clone → containers up → ready): <5 minutes on a clean machine with prebuilt images cached. |
| N2 | Workspace cold-start without prebuilt cache: <15 minutes (one-time image build). |
| N3 | Worktree allocation: <2s. |
| N4 | Worktree cleanup: <1s. |
| N5 | tmux read-only attach has no observable performance impact on the agent. |
| N6 | All three servers warm and ready within 30s of `docker-compose up`. |

### 5.2 Compatibility

| ID | Requirement |
|---|---|
| N7 | Worker containers run on M1/M2 Mac (arm64), Linux x86_64, Linux arm64. |
| N8 | DevContainer "Reopen in Container" works in VS Code 1.80+ and Cursor. |
| N9 | Compatible with Docker 24+, Podman 4+ with `podman-compose`. |
| N10 | Windows: WSL2 only in v1; native v1.x. |

### 5.3 Reliability

| ID | Requirement |
|---|---|
| N11 | Idempotent: running `docker-compose up` repeatedly is safe. |
| N12 | Graceful shutdown: SIGTERM drains in-flight jobs before container stop. |
| N13 | Server crash recovery: restarted server re-attaches to its persistent state (Postgres + Kuzu) without data loss. |

## 6. Technical approach

- **DevContainers spec compliance**: each `.devcontainer/<name>/devcontainer.json` follows `containers.dev`. The worker template uses `--override-config` per-spawn for job-specific mounts (worktree, UDS sockets, SKILL files) and labels (`harness-job-id`).
- **Image base**: `node:22-bookworm` for Node-based; multi-stage builds with Bun installed for cold-start.
- **Image features**: `ghcr.io/devcontainers/features/git`, `tmux`, `node`, `bun`, `docker-outside-of-docker` (for harness-server to invoke `@devcontainers/cli` against the host's Docker daemon, spawning sibling worker containers — not docker-in-docker).
- **Always-on lifecycle**: docker-compose (or `docker compose` plugin) for the three peer-server DevContainers. Shared network, shared `/run` volume for UDS sockets, coordinated start/stop.
- **Per-job worker lifecycle**: **`@devcontainers/cli`** invoked per submitted job by harness-server. One `devcontainer up` per work effort; one `devcontainer exec` to start the worker process; one `devcontainer down` on completion. Multiple parallel `up` calls are safe and isolate cleanly. **No `dockerode`** — devcontainer CLI is the only worker-spawn primitive.
- **Concurrency / isolation invariant:** because each worker DevContainer mounts its own git worktree (per F19-F20), parallel jobs touching the same repo can't corrupt each other. The friction model is "two developers on the same repo" — conflicts surface at git-merge time when PRs land, not at filesystem time. This makes long-running parallel efforts on the same repo a first-class supported workflow.
- **git worktrees** via `git worktree add` (vanilla git command). One worktree per worker DevContainer; branches named `agent/<jobId>` per F21.
- **tmux 3.2+** for session/window/pane primitives; read-only attach via `-r` flag. `harness attach <jobId>` resolves the job's worker container ID and execs `tmux attach -r` inside it.
- **Helm chart** built with Helmfile.
- **Volume strategy**:
  - `./.harness/run/` mounted as `~/.harness/run/` in all containers (UDS sockets).
  - `./.harness/wt/` mounted in worker containers (worktrees).
  - `./.harness/captures/` mounted in harness-server (capture sink fallback).
  - `./.harness/checkpoints.db` mounted in harness-server (LangGraph checkpointer).
- **Networking**:
  - Local-mode: shared Docker network `harness-net`; servers reachable by name + UDS.
  - Cluster-mode: Kubernetes Services + ClusterIP.

## 7. Repo structure

```
agentic-workspace-template/
├── .devcontainer/
│   ├── harness-server/devcontainer.json        # always-on (compose)
│   ├── edge-memory-server/devcontainer.json    # always-on (compose)
│   ├── edge-context-server/devcontainer.json   # always-on (compose)
│   ├── worker/devcontainer.json                # template; instantiated per job via @devcontainers/cli
│   ├── docker-compose.yml                       # always-on triad only — workers are NOT in compose
│   ├── Dockerfile.harness-server
│   ├── Dockerfile.edge-memory-server
│   ├── Dockerfile.edge-context-server
│   └── Dockerfile.worker
├── .harness/
│   ├── config/
│   │   ├── pipelines.json                      # 5 reference pipelines
│   │   ├── coordinator.json
│   │   ├── memory.config.yml
│   │   └── graphrag.config.yml
│   ├── run/                                    # UDS sockets (gitignored, mode 0600)
│   │   ├── harness.sock
│   │   ├── memory.sock
│   │   └── context.sock
│   ├── repos/                                  # local clones of every product repo (gitignored)
│   │   ├── web-app/.git/
│   │   ├── mobile-client/.git/
│   │   ├── api-gateway/.git/
│   │   ├── notifications-service/.git/
│   │   └── shared-types/.git/
│   ├── wt/                                     # per-job worktrees (gitignored), structure: <jobId>/<repoName>/
│   │   ├── job_abc123/
│   │   │   ├── web-app/                        # worktree on branch agent/job_abc123
│   │   │   ├── api-gateway/                    # worktree on branch agent/job_abc123
│   │   │   └── shared-types/                   # worktree on branch agent/job_abc123
│   │   └── job_def456/                         # parallel job, separate worktrees, separate branches
│   │       ├── web-app/
│   │       └── notifications-service/
│   ├── captures/                               # capture sink (gitignored)
│   ├── harness.sqlite                          # harness-server SQLite (jobs, lifecycle, audit)
│   ├── memory.sqlite                           # edge-memory-server SQLite + sqlite-vec
│   ├── graphrag.kuzu/                          # edge-context-server Kuzu graph
│   ├── tmux.conf                               # workspace-wide tmux config
│   └── scripts/
│       ├── spawn-worker.sh                     # invokes `devcontainer up` per job
│       ├── down-worker.sh                      # invokes `devcontainer down` on completion
│       ├── attach-tmux.sh                      # `devcontainer exec ... tmux attach -r`
│       ├── cleanup-worktree.sh
│       ├── prewarm-servers.sh
│       └── health-check.sh
├── harness-workspace.yml                       # workspace declaration (products + repos)
├── cli-config.yml                              # default cli-config (copied to ~/.<your-org>/cli-config.yml on init)
├── .gitignore
├── helm/
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
└── README.md
```

### 7.1 `harness-workspace.yml` (illustrative — multi-product, multi-repo)

```yaml
workspace:
  id: my-team-workspace

  # Three always-on peer servers (compose-managed)
  servers:
    harness:
      image: your-org/agentic-harness-server:1.0
      port: 7700
      unixSocket: .harness/run/harness.sock
    memory:
      image: your-org/agentic-harness-edge-memory-server:1.0
      port: 7710
      unixSocket: .harness/run/memory.sock
      backend: sqlite-vec
    context:
      image: your-org/agentic-harness-edge-context-server:1.0
      port: 7720
      unixSocket: .harness/run/context.sock
      config: .harness/config/graphrag.config.yml

  # Default worker DevContainer template (instantiated per job via @devcontainers/cli)
  worker:
    image: your-org/agentic-harness-worker:1.0
    devcontainerPath: .devcontainer/worker
    defaultResources:                           # can be overridden per-product below
      memory: 4Gi
      cpu: 2
    tmux:
      enabled: true
      sessionPrefix: agent-
      readOnlyAttach: true

  # Worktree policy (applies to every product's repos)
  worktree:
    rootDir: .harness/wt
    keepOnSuccess: true                         # for diff inspection / PR opening
    keepOnFailure: false                        # override per-product if needed
    pruneAfter: 7d
    branchTemplate: agent/${jobId}              # branches in every repo a job touches

  # Products: named bundles of repos. Every job runs against exactly one product.
  products:

    - id: mobile-app
      description: "iOS + Android mobile experience and its supporting backends."
      repos:
        - name: web-app
          cloneUrl: git@github.com:my-team/web-app.git
          baseRef: main
          path: /workspace/web-app             # where the worktree mounts inside the worker DevContainer
        - name: mobile-client
          cloneUrl: git@github.com:my-team/mobile-client.git
          baseRef: main
          path: /workspace/mobile-client
        - name: api-gateway
          cloneUrl: git@github.com:my-team/api-gateway.git
          baseRef: main
          path: /workspace/api-gateway
        - name: notifications-service
          cloneUrl: git@github.com:my-team/notifications-service.git
          baseRef: main
          path: /workspace/notifications-service
        - name: shared-types
          cloneUrl: git@github.com:my-team/shared-types.git
          baseRef: main
          path: /workspace/shared-types
      resources:                                # product-specific override of worker.defaultResources
        memory: 8Gi
        cpu: 4

    - id: platform-migration
      description: "Cross-cutting infra migration touching every backend service."
      repos:
        - name: api-gateway
          cloneUrl: git@github.com:my-team/api-gateway.git
          baseRef: main
          path: /workspace/api-gateway
        - name: notifications-service
          cloneUrl: git@github.com:my-team/notifications-service.git
          baseRef: main
          path: /workspace/notifications-service
        - name: billing-service
          cloneUrl: git@github.com:my-team/billing-service.git
          baseRef: main
          path: /workspace/billing-service
        - name: identity-service
          cloneUrl: git@github.com:my-team/identity-service.git
          baseRef: main
          path: /workspace/identity-service
      pipelines:                                # product-scoped pipeline overrides
        - id: backend-techstack-upgrade
          # uses default profile from .harness/config/pipelines.json but pinned to this product
    pruneAfter: 7d
```

### 7.2 Reference pipelines pre-seeded

The five from the design doc:

1. `prd-greenfield` — PRD writing pipeline (no filesystem snapshots; lots of HITL)
2. `brownfield-ui-enhancement` — UI-only changes; git snapshots; figma context
3. `brownfield-fullstack-change` — UI + backend; split planning, integration test
4. `frontend-techstack-upgrade` — codemod-heavy; always-snapshot; mcp:context7
5. `backend-techstack-upgrade` — Spring/Java/Node migrations; security-fix phase

## 8. Acceptance criteria

- `git clone` template + `code .` + "Reopen in Container" → working environment in <5 minutes (with prebuilt images).
- Multiple jobs run concurrently in distinct worktrees + worker containers without conflict.
- All three peer servers reachable via UDS from any worker container.
- `harness attach <jobId>` connects to agent's tmux session in read-only mode; observer cannot input; agent unaffected.
- The five reference pipelines run end-to-end inside the workspace.
- `docker-compose down` cleanly stops all servers + workers; `docker-compose up` resumes correctly.
- `harness workspace status` shows all containers + worktrees + active jobs + server health.
- Helm chart deploys to kind/minikube successfully with documented limitations on production scale.

## 9. Out of scope (this PRD)

- **Cross-machine clustered DevContainers** at scale (Helm chart provided but not v1-validated >10 worker pods).
- **Native Windows DevContainers** (WSL2 only in v1).
- **Auto-scaling beyond HPA basics** (custom metrics post-v1).
- **Built-in monitoring stack** (Prometheus / Grafana shipped as documentation, not deployed).
- **Air-gapped deployments** (post-v1).
- **GPU support for local embedding models** (post-v1).

## 10. Dependencies

| Dependency | Why |
|---|---|
| DevContainers spec + `@devcontainers/cli` | Container definitions. |
| Docker 24+ (or Podman 4+) | Container runtime. |
| Git 2.40+ | Worktree support. |
| tmux 3.2+ | Session attach + read-only mode. |
| Three peer server images (memory, context, harness) | Workspace orchestrates them. |
| Worker image | Spawned per job. |
| Kubernetes 1.28+ (cluster mode only) | Production deployment. |
| Helm 3.12+ (cluster mode only) | Chart deployment. |

## 11. Open questions

| # | Question |
|---|---|
| WT1 | Default worker DevContainer count in template — 1, 2, 4, or dynamic-only? Lean: 2 (balanced). |
| WT2 | Should the workspace template ship with example task fixtures (e.g., a sample bug report) so first-run can be tested without writing one? Lean: yes. |
| WT3 | Worktree branch cleanup — delete branches after worktree pruned, or keep for git-blame history? Lean: keep branches; document `git branch -D agent/*` for manual cleanup. |
| WT4 | tmux session-share on the same worker container vs. one container per agent — which is the v1 default? Lean: one container per agent (full isolation). |
| WT5 | Should `docker-compose.yml` allow CPU/RAM overrides via env vars? Lean: yes, via `${HARNESS_WORKER_CPU}` etc. |
| WT6 | Helm chart: prepackaged Postgres (Bitnami chart dependency) or assume external Postgres? Lean: prepackaged with `enabled: true`. |
| WT7 | Should the workspace template include a CI workflow (GitHub Actions) that runs the reference pipelines on PRs? Lean: yes, post-v1. |
| WT8 | edge-memory-server and edge-context-server share a Kuzu instance via volume mount — what's the lock contention story? Test rigorously. |

## 12. Implementation milestones

Aligns with implementation plan's Phase 1 + Phase 2:

- **WT-1** — Repo template scaffold + .gitignore + README (1 day)
- **WT-2** — Three peer server DevContainer + Dockerfile (3 days)
- **WT-3** — Worker DevContainer + Dockerfile (1 day)
- **WT-4** — docker-compose orchestration + shared volume strategy (1 day)
- **WT-5** — Worktree allocation scripts + integration with harness-server's `WorktreeManager` (2 days)
- **WT-6** — tmux integration: session naming, read-only attach, `tmux.session-info` skill (2 days)
- **WT-7** — Reference pipelines (5) — config files (1 day)
- **WT-8** — `harness workspace status / prune / health-check` commands (1 day)
- **WT-9** — Helm chart for cluster mode (3 days, post-v1 validation)
- **WT-10** — Documentation: setup guide, customization guide, troubleshooting (2 days)
- **WT-11** — End-to-end smoke test: clone → up → submit job → see PR open (1 day)

Total: ~15 working days for one engineer (v1) + ~3 days for cluster Helm chart.

---

*End of Workspace Template PRD.*
