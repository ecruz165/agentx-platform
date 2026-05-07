# Harness Server Concurrency Evolution — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-04-30-prd-harness-server.md` — current (v0/v1) harness-server design this PRD evolves
- `2026-05-06-prd-job-state-machine.md` — control-plane consumer that drives concurrent step dispatch
- `2026-05-06-prd-control-plane-harness-router.md` — routes concurrent work to this harness
- `2026-05-06-prd-harness-registry.md` — capability/load reporting

---

## 1. Purpose

The harness-server today (per its v0/v1 PRD) is built for **single-workspace, low-concurrency** use: one developer, a handful of in-flight jobs, mostly sequential UDS request/response. With the control plane in the picture, the same harness instance might receive concurrent step-dispatch requests from a JobStateMachine fanning out a `fork`/`map` step across multiple branches, AND simultaneously handle local CLI traffic from `harness submit` invocations, AND maintain a websocket for the Web UI.

This PRD captures the **concurrency upgrades** harness-server needs to safely serve many concurrent requests without dropping work or corrupting state. It is *not* a rewrite — it's a focused evolution of the existing design with explicit performance + correctness goals.

## 2. Goals (v1.x)

- **Concurrent request handling.** N simultaneous incoming requests (via UDS, HTTP, gRPC) processed without blocking each other. Default target: 100 concurrent in-flight requests.
- **Concurrent job execution.** M simultaneous in-flight jobs running their pipelines without serializing on a single thread or shared state. Defaults sized for a typical 4 vCPU / 8 GiB ECS task: **16 concurrent active jobs, 200 in-flight (active + queued)**. Configurable per harness via env vars.
- **Right-sized for ECS deployment.** v1 worker model is Bun subprocesses inside the harness ECS task (no container-in-container). Per-task concurrency budgeted at ~256-512 MiB RAM per active job + 512 MiB for the harness itself. Recommended ECS sizes: 4 vCPU / 8 GiB (medium, default), 8 vCPU / 16 GiB (large). Above 16 vCPU diminishing returns — scale out, not up.
- **Scale-out architecture.** Higher concurrency demand met by running more ECS tasks (each one a harness instance), not by enlarging a single task. HarnessRouter spreads work across the fleet; HarnessRegistry tracks per-task load.
- **Per-job worker isolation.** Each job's worker container/subprocess is independent; one job's slowness doesn't block another's progress.
- **Backpressure.** When concurrency limits are hit, incoming requests get a clean 429 (or a queue with bounded depth) rather than degrading silently.
- **Resource caps.** Configurable per-harness: max concurrent jobs, max workers, max RAM/CPU. Surfaced to HarnessRegistry as capability declaration.
- **Async I/O end-to-end.** No blocking I/O in request paths. Bun's runtime + Node's async APIs everywhere; subprocess spawn is non-blocking.
- **Graceful degradation under load.** When over-capacity, prioritize completing in-flight work over accepting new work.

## 3. Non-Goals (v1.x)

- **Not horizontal scaling.** A single harness-server is still a single process on a single host. Scaling across multiple harnesses is the control plane's job (HarnessRouter spreads work across harnesses).
- **Not multi-tenant within one harness.** A harness is registered to one org; jobs from different orgs don't share a harness.
- **No per-job process isolation as default.** Containers are still per-job (existing model), but the harness-server's request-handling and job-orchestration code share the host process.
- **No Erlang-/Akka-style actor model.** Bun/Node async + careful state isolation is sufficient; introducing an actor framework adds complexity without clear payoff.
- **No persistent in-flight state on the harness.** v1 keeps job state in memory; control plane (JobStateMachine) is the durable record. Mid-flight harness crashes mean the control plane re-routes incomplete steps to another harness.

## 4. Reference & Provenance

- Existing harness-server PRD: `2026-04-30-prd-harness-server.md` — reference design; this PRD describes deltas.
- Bun's runtime supports concurrent fetch/HTTP/UDS via the same async-await primitives Node has. No special concurrency library needed.
- Inspiration: nginx worker model (event loop per worker), Go's goroutine model (lightweight tasks), Erlang's actor isolation. We're picking the simplest of these patterns.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **JobStateMachine** | "I'm dispatching 5 concurrent fork branches to your harness; handle them in parallel; don't queue them serially." |
| **Daisy (developer)** | "I have a long-running job running in the background; I should still be able to submit a quick `harness auth status` query without waiting." |
| **Owen (operator)** | "Show me how many jobs and requests this harness is handling right now; alert if it's over 80% of capacity." |
| **Web UI** | "I'm tailing a job's events via SSE; multiple users may tail the same job simultaneously." |

## 6. Functional Requirements

### 6.1 Request handling

| ID | Requirement |
|---|---|
| F1 | All inbound transports (UDS, HTTP, gRPC) use async handlers. No blocking I/O in the request path. |
| F2 | Configurable concurrency cap on inbound requests: `HARNESS_MAX_CONCURRENT_REQUESTS` (default 100). When exceeded: 429 with `Retry-After`. |
| F3 | Per-route concurrency limits where appropriate (e.g., `/submit` capped lower than `/status`). |
| F4 | Long-running streams (SSE, WebSocket) don't count against the concurrent-request cap; counted separately. |
| F5 | Request timeout configurable per-route (default 30s for sync requests; unlimited for streams). |

### 6.2 Job execution

| ID | Requirement |
|---|---|
| F6 | Configurable max concurrent jobs: `HARNESS_MAX_CONCURRENT_JOBS` (default 16). |
| F7 | When at limit, new jobs from local clients return 429 / queued state with reason `harness-at-capacity`. From control plane, the JobStateMachine receives a `harness-busy` signal and re-routes. |
| F8 | Each job's orchestration runs in an isolated async context. Per-job state is kept in a `Map<jobId, JobRuntime>` keyed by jobId; no shared global state. |
| F9 | Per-job timeout: jobs exceeding configured wall-clock deadline are auto-cancelled; control plane notified. Default deadline: 1 hour, configurable per-pipeline. |
| F10 | Subprocess spawning (workers, harness-pipeline-cli) uses non-blocking spawn; child stdout/stderr piped through async streams. |

### 6.3 Resource limits

| ID | Requirement |
|---|---|
| F11 | Container slot tracking: `HARNESS_MAX_WORKERS` (default 8 — one container per worker; matches typical laptop capacity). |
| F12 | RAM/CPU caps per worker container: configured at spawn time (current code already supports this via `defaultResources` in workspace yaml). |
| F13 | Disk-space awareness: harness checks available disk before spawning a worker (worktrees can be large); refuses spawn if below threshold. |
| F14 | When over-capacity, in-flight workers complete; new spawns blocked (returns `no-capacity` to control plane). |

### 6.4 Capability + load reporting to HarnessRegistry

| ID | Requirement |
|---|---|
| F15 | Heartbeat to HarnessRegistry includes current load: `{ inflightJobs, inflightRequests, capacity: { maxJobs, maxWorkers } }`. |
| F16 | Capability declaration includes resource caps: `{ maxConcurrentJobs: 16, maxWorkers: 8, hasGpu: true, ... }`. |
| F17 | Health status reflects capacity: harness reports `degraded` when at >80% capacity, `unhealthy` when at 100%. |
| F18 | Registry's `currentLoad` field used by HarnessRouter for fairness across harnesses. |

### 6.4a ECS sizing reference

Defaults are tuned for the recommended 4 vCPU / 8 GiB profile. Operators sizing differently should override env vars accordingly:

| ECS task size | RAM | Active jobs | In-flight (active + queued) | Notes |
|---|---|---|---|---|
| 1 vCPU / 2 GiB | tight | 2-4 | up to 50 | Dev-only; one bad job can OOM |
| 2 vCPU / 4 GiB | small | 4-8 | up to 100 | Per-developer / edge tier |
| **4 vCPU / 8 GiB** | medium | **16** (default) | **200** (default) | **Recommended for shared/team harness** |
| 8 vCPU / 16 GiB | large | 32 | 400 | Bigger teams, CI/automation tier |
| 16 vCPU / 32 GiB | XL | 48-64 | 800 | Diminishing returns; prefer running 2× medium |
| 32+ vCPU | excessive | n/a | n/a | Don't — coordination overhead exceeds scale-up gain |

**Sensitivity factors (shift the table):**
- Pipelines with many `fork`/`map` branches → bursty 5-10× active demand spikes
- Pipelines with `wait-for-event` (intake, approval) → effectively free; in-flight count unbounded by RAM
- Long-running agent calls (large context, tool-use loops) → reduces effective active count by holding RAM longer
- Local-LLM bindings co-located in the same task → RAM doubles or triples per active call (don't co-locate inference unless task RAM doubled)
- Per-container worker mode (when feasible via ECS+Fargate+privileged) → RAM ~3× per worker; concurrent count drops 60-70%

**Operating model (rough capacity planning):**
- ~50 concurrent users → ~100-200 in-flight jobs → 5-10 medium ECS tasks
- ~500 concurrent users → ~1000-2000 in-flight jobs → 30-50 medium ECS tasks
- Auto-scale on `inflight / capacity > 0.7`; cooldown 5+ min (agent jobs are spiky in starts, slow in finishes)

### 6.5 Observability

| ID | Requirement |
|---|---|
| F19 | Per-route Prometheus metrics: request rate, p50/p99 latency, error rate, in-flight count. |
| F20 | Per-job metrics: lifecycle duration, step count, total tokens, errors. |
| F21 | Logged structured events on each state transition; correlated by `jobId` + `requestId`. |
| F22 | `/metrics` endpoint exposes all of the above for Prometheus scrape. |

### 6.6 Graceful degradation + shutdown

| ID | Requirement |
|---|---|
| F23 | SIGTERM: stop accepting new requests; finish in-flight (with 30s grace); deregister from HarnessRegistry; exit. |
| F24 | SIGKILL fallback: ensure subprocess workers are also killed (parent-death-signal) so we don't leak containers. |
| F25 | If shutdown grace expires with in-flight work, persist remaining job state to a local file so the control plane can resume after restart. |

## 7. Architecture changes from existing design

```
┌─────────────────────────────────────────────────────────────┐
│  harness-server (v1.x with concurrency upgrades)           │
│                                                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ UDS server │  │ HTTP/gRPC  │  │ SSE/WS     │           │
│  │ (Bun)      │  │ server     │  │ servers    │           │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘           │
│        │               │               │                   │
│        └───────────┬───┴───────────────┘                   │
│                    │                                        │
│         ┌──────────▼──────────┐                            │
│         │ Request queue       │  Backpressure: 429         │
│         │ (concurrency-       │  when over cap             │
│         │  limited channel)   │                            │
│         └──────────┬──────────┘                            │
│                    │                                        │
│  ┌─────────────────▼─────────────────────────────────────┐ │
│  │ Async router → handlers (Map<route, AsyncHandler>)   │ │
│  └─────────────────┬─────────────────────────────────────┘ │
│                    │                                        │
│  ┌─────────────────▼─────────────────────────────────────┐ │
│  │ Job runtime registry: Map<jobId, JobRuntime>         │ │
│  │   (one per in-flight job; isolated state)            │ │
│  └─────────────────┬─────────────────────────────────────┘ │
│                    │                                        │
│  ┌─────────────────▼─────────────────────────────────────┐ │
│  │ Worker pool: Set<WorkerHandle>                       │ │
│  │   (capped by HARNESS_MAX_WORKERS;                    │ │
│  │    each is a spawned container or subprocess)        │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                             │
│  Periodic: heartbeat → HarnessRegistry with load report    │
└─────────────────────────────────────────────────────────────┘
```

Key changes from current implementation:
- All request handlers wrapped in concurrency-limited channels (Promise queue with cap)
- Per-job state explicitly isolated (no globals)
- Worker pool capped + tracks current allocation
- Heartbeat enriched with load metrics

## 8. Open Questions

1. **Concurrency primitive:** Bun has built-in async/await + a native `BunSemaphore`-equivalent (not yet — but `Promise.all` with batched tasks works). Use a small library (`p-limit`) or hand-rolled? Recommend hand-rolled in a single utility file for transparency.
2. **Connection pooling for outbound calls:** harness makes HTTPS calls to LLM providers, embedder service, control plane. Default Bun fetch is pooled; verify pool sizes are sane under high concurrency.
3. **UDS socket file handle limits:** OS file-handle limit affects concurrent UDS connections. Default ulimit is usually 256-1024 on macOS / Linux; might need `ulimit -n 65536` for high-concurrency deployments.
4. **Worker container reuse vs always-fresh:** today each job spawns a fresh container. For high-throughput, pooling warm containers would reduce spawn latency but adds isolation concerns. Defer to v2.
5. **Cancellation propagation under load:** when 16 jobs run concurrently and we get a global SIGTERM, cancelling all of them in parallel can cause network/disk thundering-herd. Stagger cancellations? Investigate.
6. **Load shedding policy:** when over capacity, do we reject all incoming work, or prioritize control-plane traffic over local CLI calls? Simple: reject all equally. Smart: priority queue with control-plane class above local class. v1: simple; v1.x: priority.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Single-process concurrency, not multi-process / cluster mode | Bun/Node async is sufficient; cluster mode adds IPC complexity without payoff for typical loads. | 2026-05-06 |
| D2 | In-memory job state only; durability is control plane's job | Cleaner separation; matches the data-plane / control-plane split. | 2026-05-06 |
| D3 | Configurable caps via env vars (HARNESS_MAX_*) | Operators tune per-deployment without code changes. | 2026-05-06 |
| D4 | 429 backpressure with Retry-After (not infinite queue) | Bounded resources prevent OOM under sustained load. | 2026-05-06 |
| D5 | Heartbeat carries load metrics for Router | Enables load-aware routing without separate metrics scrape. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Concurrent request handling; per-route concurrency limits; backpressure on /submit |
| **Phase 2** | Per-job runtime isolation; concurrent job execution up to MAX_CONCURRENT_JOBS |
| **Phase 3** | Worker pool tracking; resource caps; capacity-aware spawn |
| **Phase 4** | Load reporting to HarnessRegistry; degraded/unhealthy thresholds |
| **Phase 5** | Observability (Prometheus, structured logs, traces) |
| **Phase 6** | Load shedding policy (priority queue, control-plane-first) — v1.x |
