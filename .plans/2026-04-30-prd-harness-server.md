# Harness-Server — PRD

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Engineering, product, ops reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (the runtime layer this exposes)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-prd-harness-core.md` — **hard dependency** (this server is the HTTP/WS surface wrapping a configured harness; config loading + credential propagation lives there, not here)
- Peer servers: edge-memory-server PRD, edge-context-server PRD

---

## 1. Goal

**Near-term v1 deployment context: DevContainer on the developer's local machine.** Single-user, loopback-only, no ingress, no production-grade scale or auth. Production multi-tenant deployment (Helm/K8s, ingress, multi-instance) is post-v1 — see § 4.3 + § 6 + § 9.1.

A standalone HTTP + WebSocket service. **REST is the canonical command interface; WebSocket is a live channel for events and an optional bidirectional fast-path for steering.** Both transports for any given action (e.g., steering) converge in the same internal handler so downstream behavior is identical regardless of how the message arrived — REST and WS are test-equivalent input paths.

It:

1. **Receives jobs** via REST API (or wired `JobSource` adapters: GitHub issues, cron, webhooks, file-watcher).
2. **Queues** them with priority + idempotency. (Multi-tenant scoping deferred to v1.x — see § 4.3 + § 9.1.)
3. **Distributes to workers** running in distinct repos / worktrees / DevContainers, allowing many jobs to run concurrently.
4. **Emits captures, events, and statuses** via WebSocket / REST / `JobSink` adapters (PR creation, comments, Slack, webhooks).

This is the orchestration brain. It does not own memory state (edge-memory-server does) or the knowledge graph (edge-context-server does). It coordinates *workers* that consume those services.

## 2. Personas served

| Persona | Need |
|---|---|
| **Daisy / Quinn** (developers, via TUI / VS Code) | Submit jobs, watch progress, steer mid-run, cancel. |
| **Owen** (operator) | Monitor running fleet, tune concurrency, view audit logs. |
| **Maya** (multi-tenant admin) | Multi-user auth, per-tenant quotas, pipeline catalog governance. |
| **External integrations** | GitHub Actions, Linear automations, Slack bots, cron schedulers — submit jobs via API or wired sources. |

## 3. User stories

- *As Daisy*, I `POST /v1/jobs` with a task description and pipeline name; I receive a `jobId` immediately and watch progress over a WebSocket connection.
- *As Daisy*, I open WebSocket `/v1/jobs/{id}/events` and see `phase-started`, `tool-called`, `phase-completed` events as they happen.
- *As Daisy* (TUI), I send a steering message over the same WebSocket connection (low-latency live path) and see a `steering-applied` event flow back when the agent picks it up.
- *As a script / CI integration*, I `POST /v1/jobs/{id}/steer` with the same payload — without needing to open a WebSocket — and the message lands in the same inbox; the steer is processed identically.
- *As Owen*, I `GET /v1/admin/workers` and see all active workers, their current jobs, and resource usage.
- *As Maya*, I configure quotas in `harness-server.config.yml`: "user `alice` ≤ 3 concurrent jobs; org `acme` ≤ $50/day."
- *As an external integration*, I label a GitHub issue and the configured `GitHubIssueSource` automatically submits a job.
- *As an agent in a worker*, I emit a tool-call event that flows through the harness-server to all subscribed observers.

## 4. Functional requirements

### 4.1 Job submission & lifecycle

| ID | Requirement |
|---|---|
| F1 | REST: `POST /v1/jobs` accepts `{ input, productId, pipeline?, profile?, priority?, deadline?, idempotencyKey?, metadata? }`; returns `{ jobId, status: 'pending', submittedAt }`. The `productId` is required and resolved against the workspace's declared products (see workspace-template F11) — it determines which set of repos the worker DevContainer will mount. |
| F2 | REST: `GET /v1/jobs/{id}` returns full lifecycle including current phase, usage rollup, captures index. |
| F3 | REST: `GET /v1/jobs?filter=...` supports filtering by status, pipeline, source, submittedAfter, with pagination. |
| F4 | REST: `DELETE /v1/jobs/{id}` cancels a running job (graceful by default, `?force=true` for immediate). |
| F5 | Idempotency: jobs with the same `idempotencyKey` within a configured window dedupe to the original submission. |
| F6 | Priority: higher-priority jobs jump the queue; lifecycle preserves submission order otherwise (FIFO). |
| F7 | Scheduled execution: `scheduledAt` field defers job dispatch to that timestamp. |
| F8 | Soft deadlines: `deadline` field; if exceeded, server emits `deadline-missed` event (does not auto-cancel). |

### 4.2 Worker pool & dispatch

| ID | Requirement |
|---|---|
| F9 | **Worker model: one ephemeral DevContainer per job, spawned via `@devcontainers/cli`.** harness-server invokes the workspace's `.harness/scripts/spawn-worker.sh` (which wraps `devcontainer up --workspace-folder .devcontainer/worker --override-config <per-job.json>`) per submitted job; on completion, invokes `devcontainer down`. The worker container runs the agentic-worker-lib runtime, which bootstraps the agent and connects to harness-server + the edge servers over UDS. **No in-process worker pool.** Multiple parallel jobs spawn multiple parallel DevContainers; concurrency capped by `maxConcurrentJobs`. |
| F10 | **Workspace Provisioning (multi-repo, product-scoped):** every job is submitted *against a product* (declared in `harness-workspace.yml`); the `WorkspaceManager` resolves the product → its `repos[]`, runs `git worktree add` for each repo into `.harness/wt/<jobId>/<repoName>/` on a shared branch name `agent/<jobId>`, generates the per-job devcontainer override config (mounting each worktree at the repo's declared `path`), and hands off to spawn-worker. On completion, runs `git worktree remove` per repo (keeping branches per F22 of workspace-template). The agent sees a synthetic monorepo across the product's repos. |
| F11 | Concurrency caps: global, per-pipeline, per-user, per-org, per-provider (e.g., max 6 concurrent Anthropic calls). |
| F12 | Visibility-locking: worker pulls jobs via `JobQueue.next(workerId)` which atomically claims the job. |
| F13 | Worker heartbeat: workers ping the server periodically; jobs without recent heartbeat re-enter queue. |
| F14 | Graceful drain on SIGTERM: complete in-flight jobs up to `drainGracePeriodMs`, snapshot, exit. |

### 4.3 Trust model

**Near-term v1 deployment: DevContainer on the developer's local machine.** The harness-server container runs on Docker (or Docker Desktop / Colima / Orbstack) on the developer's workstation, with a port forwarded to host loopback. No ingress, no TLS, no remote callers, no multi-user — and **no separate database container**. State (jobs, captures index, audit log, pipeline catalog) lives in a SQLite file in a volume mount; capture payloads live on filesystem in the same volume. One container, one process, one volume.

v1 ships **transport security only**; application-level identity / multi-tenancy is deferred to v1.x when production deployment becomes a real concern. The trust boundary is:

- **Local-mode access** (UDS) is governed by file-system permissions — the developer's user account *is* the auth. In a DevContainer, "local" means `docker exec` into the container or a shared bind-mount.
- **Remote-mode access** in near-term v1 means **localhost loopback only** — the developer's IDE, TUI, or browser hitting the forwarded port. The harness-server doesn't authenticate callers; the assumption is "if you reached the loopback port, you're already on the developer's machine."
- **Admin operations** are gated to local-socket access only — there's no admin-token concept in v1.
- **Future v1.x deployment** (production-grade, multi-tenant) puts the server behind an ingress (K8s Ingress, nginx, Cloudflare Tunnel, etc.) that handles TLS + caller auth and forwards `X-Forwarded-User` for audit-log actor population. The audit-log actor schema is already shaped for this upgrade — see F19.

| ID | Requirement |
|---|---|
| F15 | **Local Mode:** Unix Domain Socket (UDS) with `0600` permissions. File-system ownership is the auth model. |
| F16 | **Remote Mode (TCP):** HTTP/1.1 over plain TCP. TLS is **not** terminated by the server — deployments wanting TLS put the server behind a reverse proxy (nginx, Caddy, Cloudflare, etc.) that handles cert lifecycle and termination. The server itself does not validate caller identity in v1. |
| F17 | **Admin endpoints UDS-only:** `/v1/admin/*` and `POST /v1/pipelines/{id}` reject TCP requests with `403 Forbidden`. Admin operations require connecting over the local socket. |
| F18 | **Quotas:** global concurrency caps (`maxConcurrentJobs`) and per-pipeline caps. Per-provider caps (e.g., max 6 concurrent Anthropic calls) enforced. Per-user / per-org caps **deferred to v1.x** when identity lands. |
| F19 | **Audit log actor field:** records the connection source (`uds:<uid>` for local, `tcp:<peer-ip>` for remote, plus any forwarding headers `X-Forwarded-For` / `X-Forwarded-User` if a reverse proxy populates them). When v1.x adds identity, actor field upgrades to authenticated user without breaking the audit-log schema. |

### 4.4 Pipeline catalog governance

| ID | Requirement |
|---|---|
| F20 | `GET /v1/pipelines` lists catalog (filtered by user's access). |
| F21 | `POST /v1/pipelines/{id}` (admin) creates or updates a pipeline; validated against build-time registries. |
| F22 | `DELETE /v1/pipelines/{id}` (admin) removes a pipeline. |
| F23 | Pipeline catalog persisted via `ConfigStore` interface (SQLite in v1; Postgres in v1.x production). |
| F24 | **Coordinator Dispatch:** When a client submits with `pipeline: 'auto'`, the Coordinator agent evaluates the task and designates both the pipeline and the **workspace type** (e.g., `git-worktree`, `directory`). |

### 4.5 Events, captures, & observability

| ID | Requirement |
|---|---|
| F25 | **WebSocket** `/v1/jobs/{id}/events` streams typed `HarnessEvent`s for that job. Each event tagged with monotonic `seq`; on reconnect, client passes `?since=<lastSeq>` to replay missed events from a per-job ring buffer (default 1000 events). |
| F26 | **WebSocket** `/v1/events` global stream with filter query params (`?type=phase-started`, `?pipeline=fix-bug`). Same `seq`-based replay semantics. |
| F27 | **Steering — two transports, one inbox:** Both paths converge in `SteeringInbox.submit()` and produce identical downstream behavior. <br>**(a) WebSocket frame** on `/v1/jobs/{id}/events` (or a dedicated `/v1/jobs/{id}/steer` channel if the client wants to keep events read-only): `{type:'steer', priority, content, metadata?}` → server replies with `{type:'steer-ack', steerId}` on the same socket. Best for live TUI. <br>**(b) REST POST** `/v1/jobs/{id}/steer` with the same JSON payload → returns `202 Accepted {steerId, queued: true}`. Best for scripts, CI integrations, conformance tests. <br>In both cases, application-level confirmation that the worker picked up the steer flows back as a `steering-applied` event over the WebSocket events stream (correlated by `steerId`). |
| F27a | **Urgent steering:** when `priority: 'urgent'`, server sends `SIGTERM` to the worker, updates phase context, restarts the phase. The corresponding `phase-restarted` event includes `appliedSteers: [steerId]`. Same behavior whether the steer arrived via WebSocket or REST. |
| F27b | **Test parity:** the conformance suite exercises every steering scenario over both transports; the worker's downstream behavior must be byte-identical regardless of input transport. |
| F28 | Captures stored externally — `CaptureSink` interface; production default S3, dev default filesystem. |
| F29 | `GET /v1/jobs/{id}/captures` returns capture index with signed URLs to actual payloads. |
| F30 | Audit log: every state-changing API + agent action persisted append-only with `{ timestamp, actor, action, resource, before, after }`. |
| F31 | OpenTelemetry traces with GenAI semantic conventions; OTLP exporter configurable. |
| F32 | Prometheus metrics at `/metrics` (queue depth, worker count, p95 latencies, error rates). |

### 4.6 Source / sink integrations

| ID | Requirement |
|---|---|
| F33 | `JobSource` interface allows registering external job providers (CLI, GitHub issues, cron, file-watcher, webhooks). |
| F34 | `JobSink` interface allows pushing results to external systems (PR creation, issue comments, Slack, webhooks). |
| F35 | Built-in sources: `WebhookSource` (HTTP endpoint accepting POSTed jobs); `CronSource` (declarative scheduling); `CliSource` (stdin from `harness submit` CLI command). |
| F36 | Built-in sinks: `ResultReturnSink` (default for synchronous CLI consumers), `WebhookSink`. |
| F37 | Concrete source/sink integrations (GitHub, Linear, Slack) ship as separate companion packages. |

### 4.7 OpenAPI & client generation

| ID | Requirement |
|---|---|
| F38 | OpenAPI 3.1 spec auto-generated from Zod schemas + Hono routes. |
| F39 | TypeScript client auto-generated from spec; published as `@your-org/agentic-harness-client`. |
| F40 | Python client auto-generated for non-TS consumers (post-v1). |

## 5. Non-functional requirements

### 5.1 Latency targets

| Operation | p95 (warm) | p99 (warm) |
|---|---|---|
| `POST /v1/jobs` | <100ms | <300ms |
| `GET /v1/jobs/{id}` | <30ms | <100ms |
| `GET /v1/jobs?filter=...` (≤100 results) | <80ms | <250ms |
| WS event delivery from emission | <50ms | <150ms |
| Coordinator dispatch (job → first phase started) | <500ms | <1500ms |
| `POST /v1/pipelines/{id}` (admin) | <200ms | <500ms |

### 5.2 Throughput & scale

These are **production-deployment aspirational targets** for when v1.x leaves the DevContainer. **Near-term v1 single-developer DevContainer use is at least 1–2 orders of magnitude smaller** (1–3 concurrent jobs typical, dozens-deep queue at most). Architecture choices (Postgres queue, WebSocket fan-out, idempotency keying) shouldn't preclude these targets, but v1 acceptance does *not* require demonstrating them.

| ID | Requirement (production aspirational) |
|---|---|
| N1 | 50 concurrent jobs on 16-core / 32GB host (jobs are I/O-bound to LLM APIs). |
| N2 | 200 jobs/hour sustained throughput. |
| N3 | Queue depth ≥1000 jobs without degradation. |
| N4 | 100 concurrent WebSocket subscribers per job. |

### 5.3 Reliability

**v1 (DevContainer) reliability targets:**

| ID | Requirement |
|---|---|
| N5 | Survives single-worker crashes — orphaned jobs return to queue within heartbeat-timeout. |
| N6 | Survives `kill -9` of the harness-server process — in-flight job state recovers from SQLite WAL on next start; no jobs lost. |
| N7 | Single-container deployment runs unsupervised for ≥7 days without memory leaks (idle RSS stable, no FD growth). |

**v1.x (production) reliability targets — aspirational, not v1 acceptance gates:**

| ID | Requirement (production aspirational) |
|---|---|
| N8 | 99.9% uptime in production (multi-instance + Redis + Postgres). |
| N9 | Survives Postgres failover — connection pool reconnects, in-flight HTTP requests retry once. |
| N10 | Survives Redis failover (when present) — fallback to Postgres-only queue mode. |

### 5.4 Resource

| ID | Requirement |
|---|---|
| N11 | Idle RSS <50MB. |
| N12 | Active RSS 100–200MB typical, <500MB peak. |
| N13 | Cross-platform binaries: darwin, linux x86_64, linux arm64. |

## 6. Technical approach

- **Runtime:** Bun (preferred for HTTP perf) or Node 22+.
- **HTTP framework:** Hono (fast, edge-compatible, built-in OpenAPI gen via `@hono/zod-openapi`).
- **WebSocket:** native server (Bun) or `ws` library (Node). Per-job ring buffer (default 1000 events) backs `?since=<seq>` reconnect-replay.
- **REST steering inbox:** `POST /v1/jobs/{id}/steer` enters the same internal `SteeringInbox.submit()` as WebSocket `steer` frames — single handler, two transports.
- **Persistence:**
  - **v1 (near-term):** **SQLite** in WAL mode (jobs, lifecycle, captures index, audit, configs, pipeline catalog) via `better-sqlite3`. Single file in a Docker volume. Migrations via `drizzle-kit` or hand-rolled SQL stepper.
  - **v1 capture payloads:** filesystem in the same volume mount (`FsCaptureSink`). Signed-URL flow in F29 returns a local file:// URL until v1.x adds S3.
  - **v1.x:** **Postgres 15+** for staging / production deployments — same schema, ported via the same migration tool. Capture payloads move to **S3** or compatible (MinIO).
  - **v2:** **Redis** for cross-instance event pubsub + queue coordination.
- **Queue impl:**
  - **v1:** SQLite single-writer queue. WAL mode + `BEGIN IMMEDIATE` transactions handle the single-worker dequeue case; one in-process worker pool means no cross-process locking is needed.
  - **v1.x:** Postgres-backed using `SELECT ... FOR UPDATE SKIP LOCKED` for multi-worker safety.
  - **v2:** optional Redis-backed for high-RPS scenarios.
- **Workers:**
  - v1: in-process pool managed via `p-queue`.
  - v1.x: child-process via Node `child_process.fork`.
  - v2: DevContainer-launched via `WorkspaceTemplate` integration.
- **Trust model (v1, near-term):**
  - **DevContainer on developer's local machine.** Single-user, loopback-only access. No ingress, no TLS, no remote callers, no multi-tenant identity model. v1.x revisits the trust model when production deployment lands.
  - **Local mode:** UDS with mode `0600`; file-system ownership *is* the auth. In a DevContainer, "local" means `docker exec` into the container.
  - **Remote mode:** plain HTTP/1.1 over loopback (forwarded port from container to host `127.0.0.1`). No in-process TLS or auth.
  - **Admin gating:** connection-source check rejects `/v1/admin/*` and pipeline-mutating endpoints unless the request arrived over UDS.
  - Application-level auth (JWT, mtauth, API keys, per-user scoping) **deferred to v1.x** — see § 9.1.
- **Observability:** Pino logs + OpenTelemetry traces (OTLP exporter) + Prometheus metrics.
- **Deployment:**
  - **v1 (near-term):** DevContainer on developer's machine. `docker compose up` brings up just harness-server (single container; SQLite in a volume). The HTTP port forwards to host `127.0.0.1:<port>`. No sibling Postgres or Redis container.
  - **v1.x:** Standalone Docker image suitable for staging deployments behind an ingress.
  - **v2:** Helm chart for K8s with multi-instance Redis-backed queue (HS-15).

## 7. API surface

### 7.1 Jobs

```http
POST /v1/jobs
Content-Type: application/json
# v1: no in-process auth — see § 4.3. Server runs container-native; ingress
#     (nginx, K8s Ingress, Cloudflare Tunnel, etc.) handles TLS + caller auth
#     if needed and forwards X-Forwarded-User for audit-log actor population.
{
  "input": { "task": "Upgrade dashboard from Vue 2.7 to Vue 3.5" },
  "pipeline": "auto",
  "profile": "standard",
  "priority": 0,
  "idempotencyKey": "deadbeef-...",
  "metadata": { "originatingUrl": "..." }
}
→ 202 Accepted
{ "jobId": "job_abc123", "status": "pending", "submittedAt": 1714492800000 }

GET /v1/jobs/job_abc123
→ 200
{
  "jobId": "...",
  "status": "running",
  "sessionId": "sess_...",
  "pipelineId": "frontend-techstack-upgrade",
  "profile": "standard",
  "currentPhase": "codemod",
  "submittedAt": ..., "startedAt": ...,
  "usage": { "totalInputTokens": 12345, "totalOutputTokens": 6789, "totalDollars": 0.34 }
}

GET /v1/jobs?status=running&pipeline=brownfield-ui-enhancement&limit=20
→ 200 { "jobs": [...], "next": "cursor:..." }

DELETE /v1/jobs/job_abc123
{ "reason": "user cancelled" }
→ 200 { "status": "cancelled" }
```

### 7.2 Pipelines (catalog)

```http
GET /v1/pipelines
→ 200 [{ "id": "fix-bug", "description": "...", "whenToUse": [...], "profiles": [...] }, ...]

POST /v1/pipelines/perf-regression-checkout       (admin)
{ "description": "...", "whenToUse": [...], "profiles": {...} }
→ 200

DELETE /v1/pipelines/perf-regression-checkout    (admin)
→ 204
```

### 7.3 Captures

```http
GET /v1/jobs/job_abc123/captures
→ 200 [{ "phaseId": "plan", "captureUrl": "https://signed-s3-url/...", "expiresAt": ... }, ...]
```

### 7.4 Workers (admin)

```http
GET /v1/admin/workers
→ 200 [{ "workerId": "w-01", "currentJob": "job_abc123", "status": "running",
         "memMB": 124, "lastHeartbeat": ... }, ...]

GET /v1/admin/queue
→ 200 { "depth": 42, "byStatus": {...}, "byPipeline": {...} }

POST /v1/admin/workers/{id}/drain      (admin)
→ 202 { "draining": true }
```

### 7.5 WebSocket events + steering (both transports)

**Per-job event stream** (WebSocket):

```
ws://harness-server/v1/jobs/job_abc123/events?since=42

← {"seq":43,"type":"phase-started","phaseId":"plan","agent":{...}}
← {"seq":44,"type":"tool-called","phaseId":"plan","toolName":"memory.query",...}
← {"seq":45,"type":"phase-completed","phaseId":"plan","usage":{...}}
← {"seq":46,"type":"steering-applied","steerId":"stm_4","appliedAt":...,"phaseId":"code"}
…

# Connection drops. Client reconnects with last seq it saw:
ws://harness-server/v1/jobs/job_abc123/events?since=46
← (server replays from per-job ring buffer; default 1000-event capacity)
```

**Global event stream** (all jobs, filter query params):

```
ws://harness-server/v1/events?type=phase-started&pipeline=fix-bug
← (same shape, filtered)
```

**Steering — Path A: WebSocket frame (live TUI fast-path)**

```
ws://harness-server/v1/jobs/job_abc123/events    # using the open events socket

→ {"type":"steer","priority":"next-boundary","content":"Use the v2 endpoint","metadata":{"source":"tui"}}
← {"type":"steer-ack","steerId":"stm_4"}

# Later, via the same socket:
← {"seq":47,"type":"steering-applied","steerId":"stm_4","appliedAt":...,"phaseId":"code"}
```

**Steering — Path B: REST POST (scripts, CI, conformance tests)**

```http
POST /v1/jobs/job_abc123/steer
Content-Type: application/json
{
  "priority": "next-boundary",
  "content": "Use the v2 endpoint",
  "metadata": { "source": "github-actions" }
}
→ 202 Accepted
{ "steerId": "stm_4", "queued": true }

# Confirmation flows back via WebSocket events stream (any subscribed client):
← {"seq":47,"type":"steering-applied","steerId":"stm_4","appliedAt":...,"phaseId":"code"}
```

**Both paths land in the same `SteeringInbox.submit()` handler** — the worker, audit log, and `steering-applied` event production are transport-agnostic. Conformance tests run every steering scenario over both transports and assert byte-identical downstream behavior.

### 7.6 Health & meta

```http
GET /health
→ 200 { "ok": true, "uptimeMs": ..., "version": "1.0.0", "queue": {...}, "workers": {...} }

GET /metrics                                       (Prometheus exposition)
GET /openapi.json                                  (OpenAPI 3.1 spec)
```

## 8. Acceptance criteria

### v1 (near-term DevContainer deployment)

- All in-scope functional requirements pass automated tests (auth-deferred F-IDs noted in § 4.3 + § 9.1 are excluded).
- All § 5.1 latency targets met for single-user load (≤3 concurrent jobs).
- `docker compose up` brings up the single harness-server container with a SQLite volume successfully on Docker Desktop, Colima, and Orbstack; the server's port forwards to host loopback and accepts requests.
- OpenAPI spec validates with `redocly lint`.
- Generated TypeScript client exercises all in-scope endpoints in conformance test suite.
- Audit log captures every state-changing action with connection-source actor (`uds:<uid>` / `tcp:127.0.0.1`).
- Survives chaos tests: kill workers mid-job (recover within heartbeat timeout), kill server (in-flight jobs resume on restart from checkpointer).

### v1.x (production deployment — post-v1)

- Multi-instance deployment (with Redis + Postgres + S3) sustains 50 concurrent jobs without coordination errors (§ 5.2 production aspirational targets).
- Helm chart deploys to kind/minikube successfully with autoscaling configured (HS-15).
- Reverse-proxy integration documented (nginx, K8s Ingress, Cloudflare) — `X-Forwarded-User` populates audit-log actor.
- Application-level auth landed (whichever of JWT/mtauth/API-keys the v1.x identity model selects).

## 9. Out of scope (this PRD)

- **Built-in UI dashboard** — TUI + VS Code extension are the v1 surfaces.
- **Native cluster orchestration** beyond Helm chart (consumer wires their own K8s manifests if needed).
- **Distributed tracing collector** — consumer wires OpenTelemetry endpoint (Tempo, Jaeger, etc.).
- **Built-in billing / metering** — consumer integrates Stripe / similar; harness-server emits usage events.
- **Multi-region active-active** — single-region in v1; v2 if demand emerges.
- **WebHooks for outgoing notifications beyond JobSink** — extend via custom JobSink.

### 9.1 Deferred to v1.x (deliberate)

- **Application-level authentication.** Bearer-token (JWT) validation, API-key issuance, mtauth integration. v1 expects deployments to put the server behind a trusted network or a reverse proxy that handles caller auth (nginx basic-auth, Cloudflare Access, oauth2-proxy, etc.).
- **Multi-tenant identity model.** Per-user / per-org scoping of jobs, captures, audit-log actor field. v1 records connection source (`uds:<uid>` / `tcp:<peer-ip>` + forwarded headers); v1.x upgrades the actor field to an authenticated user identity without breaking the schema.
- **Per-user / per-org quotas.** v1 enforces global concurrency caps, per-pipeline caps, and per-provider caps (e.g., max-concurrent-Anthropic-calls). Per-identity quotas land with the v1.x identity model.
- **Admin-scoped tokens.** v1 gates admin endpoints by *connection origin* (UDS-only); v1.x adds token-scoped admin RBAC for remote operators.

## 10. Dependencies

| Dependency | Why |
|---|---|
| Harness library + runtime layer | Provides `JobQueue`, `Workspace`, lifecycle types. |
| **`better-sqlite3`** | v1 persistence (jobs, captures index, audit, configs). |
| **`drizzle-kit`** (or hand-rolled SQL stepper) | Schema migrations for SQLite. |
| Postgres 15+ | **v1.x** — staging / production deployments. |
| Redis 7+ | **v2** — cross-instance event pubsub + queue coordination. |
| S3-compatible object store | **v1.x** capture storage; v1 uses filesystem. |
| OpenTelemetry SDK | Tracing. |
| Hono + `@hono/zod-openapi` | HTTP framework + OpenAPI gen. |

## 11. Open questions

| # | Question |
|---|---|
| HS1 | ~~Postgres-only queue in v1, or also Redis from day 1?~~ **Resolved:** v1 uses SQLite (single container, single worker pool). Postgres lands in v1.x for staging; Redis only enters in v2 for multi-instance. |
| HS2 | Workers in-process v1, or spawn child-processes for isolation? Trade simplicity vs. fault containment. |
| HS3 | Capture sink production default — S3? Self-hosted MinIO? Postgres `bytea`? |
| HS4 | ~~mtauth in v1 or local-only with mtauth post-v1?~~ **Resolved:** all application-level auth (mtauth, JWT, API keys) deferred to v1.x — see § 4.3 + § 9.1. v1 ships transport security only (TLS for remote HTTP/2, UDS for local + admin). |
| HS5 | Idempotency window length — 24h default? Configurable per-deployment? |
| HS6 | Job deadlines — auto-cancel at deadline or just emit `deadline-missed` event? Lean toward latter. |
| HS7 | Coordinator-rejected jobs — keep in audit log indefinitely or TTL? |
| HS8 | API versioning — `/v1/` path prefix vs. `Accept-Version` header? Path is simpler; header is more flexible. |
| HS9 | ~~TLS in remote mode — required always, or only when HTTP/2 is enabled?~~ **Resolved:** server runs container-native and exposes plain HTTP/1.1 only; TLS is the ingress's job (nginx/Caddy/Cloudflare/K8s Ingress). No in-process TLS in v1 or planned in v1.x. |

## 12. Implementation milestones

Aligns with the implementation plan's Layer 5 + ecosystem track:

- **HS-1** — Server skeleton: Hono + Zod + OpenAPI gen + `/health` (1 day)
- **HS-2** — SQLite persistence + WAL mode + migrations via `drizzle-kit` (~1 day; Postgres port deferred to v1.x as a separate milestone)
- **HS-3** — Job submission + retrieval REST endpoints (1 day)
- **HS-4** — In-process worker pool + worktree allocation integration (3 days)
- **HS-5** — Idempotency + priority + scheduling (1 day)
- **HS-6** — UDS admin gating: connection-source check rejects `/v1/admin/*` and pipeline-mutating endpoints over TCP (~0.25 day). No in-process TLS — that's the ingress's job in container-native deployment.
- **HS-7** — Pipeline catalog endpoints + ConfigStore wiring (1 day)
- **HS-8** — Coordinator dispatch flow (1 day)
- **HS-9** — WebSocket event streams (`/v1/jobs/{id}/events`, `/v1/events`) with `?since=<seq>` ring-buffer replay + steering inbox accepting both WS frames and REST POST `/v1/jobs/{id}/steer`. Conformance test asserts byte-identical worker behavior across both input transports. (~2 days)
- **HS-10** — Captures + S3 sink (1 day)
- **HS-11** — Audit log + Prometheus metrics + OTel traces (2 days). Audit `actor` field records connection source (`uds:<uid>` / `tcp:<peer-ip>` + forwarded headers).
- **HS-12** — Global concurrency caps + per-pipeline + per-provider quotas (~0.5 day). Per-user / per-org caps deferred to v1.x.
- **HS-13** — Built-in JobSources (Cron, Webhook) + JobSinks (Webhook, ResultReturn) (2 days)
- **HS-14** — Generated TypeScript client + conformance test (1 day)
- **HS-15** — Helm chart + multi-instance Redis-backed queue (post-v1, 3 days)
- **HS-16** — Documentation + reference deployment guide (1 day)

Total: ~18.5 working days for one engineer (v1, single-instance); +3 days for multi-instance Redis path. (Down from ~21 — HS-6 reduced to UDS admin gating only; HS-9 keeps WebSocket for events + adds REST steering inbox as test-equivalent input path; HS-12 reduced to global/per-pipeline/per-provider quotas; HS-2 SQLite simplifies persistence.)

---

*End of Harness-Server PRD.*
