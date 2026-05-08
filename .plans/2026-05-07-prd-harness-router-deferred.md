# Harness Router (Deferred standalone-service design) — PRD

**Status:** Superseded by `2026-05-07-prd-dispatch-module.md` (kept as historical record of the deferred standalone-service design).
**Date:** 2026-05-06 (last revised 2026-05-07 to mark superseded status)
**Author:** Edwin Cruz
**Audience:** Engineering, devops, product reviewers
**Companion documents:**
- `2026-05-07-prd-dispatch-module.md` — current Spring Modulith design that absorbs this role; build this instead unless the standalone-service triggers fire
- `.plans/2026-04-30-prd-workspace-template.md` — workspace + worker DevContainer
- `.plans/2026-04-30-prd-workspace-cli.md` — workspace CLI
- Memory: `project_proxy_per_job_architecture` — Model C origin
- Memory: `project_harness_router_dispatcher` — design summary
- Memory: `project_harness_server_registry` — directory the router reads from
- Memory: `project_spawn_primitive_pluggability` — what the router invokes for fresh-spawn fallback

---

## 1. Goal

A small, always-on, lightweight HTTP/UDS service that ROUTES incoming
client requests (job submissions, console operations) to the right
harness-server instance — selected by capability match + load
metrics. Pairs with a Registry service (the directory) to make
"always-on stable URL" coexist with "ephemeral or pooled
harness-server instances."

This is the component the `project_proxy_per_job_architecture` memory
named "proxy"; this PRD renames it `harness-router` for clarity:
proxy is generic, router specifically describes what it does.

### Why deferred

The router is **only needed when scaling beyond a single
harness-server instance.** v1 deployments (local-dev, single workspace,
single user) have one harness-server at a fixed URL — clients dial
it directly, no routing required. Building the router prematurely
adds infrastructure complexity without solving any v1 user pain.

### Build triggers — implement when ANY become real

- **Warm pool** — multiple concurrent harness-server instances on
  one host to amortize cold-start latency
- **Multi-tenant production** — one stable URL fronting N
  tenant-scoped instances
- **Model C per-job ephemeral instances** — each job gets a fresh
  harness-server container; URL is not fixed; routing by jobId is
  the only way to find the instance
- **Capability-tier sharding** — gpu/cpu, frontier/cheap, public/private —
  jobs need to land on the matching tier

Until one of these is concrete, this PRD stays in `.plans/` as a
design document — not as a build target.

## 2. Personas served (when built)

| Persona | Need |
|---|---|
| **Daisy** (developer, multi-job) | Submit a job and have it land on a warm instance with cache state, not a cold one |
| **Owen** (operator, multi-tenant) | One stable entry point in front of N harness-server instances; topology hidden from clients |
| **Quinn** (curious observer) | "Show me all instances + their load" — operational inventory at a glance |
| **External integration** (CI bot, web-app submitting jobs) | One URL to point at; topology changes don't require client updates |

## 3. User stories

- *As Daisy*, when I submit two back-to-back jobs against the same
  workspace, the second job lands on the same instance as the first
  so the bare-repo cache + opencode-server are reused. Sticky-by-
  workspace dispatch saves clone latency.
- *As Owen*, I scale the harness-server pool from 1 → 3 instances
  without telling any clients. The router picks up the new instances
  from the Registry; clients keep dialing the same URL.
- *As Owen*, when I see one instance saturating, I scale up to 4
  instances. New jobs flow to the newest instance via least-loaded
  policy. Existing jobs keep running on their instances until done.
- *As Daisy*, when no warm instance is available + my job needs a
  capability no instance has, the router spawns a fresh instance
  via the configured spawn primitive (subprocess / devcontainer /
  k8s Job / ECS Task) and routes my job to it once registered.
- *As an external integration*, my POST request gets a stable
  response shape regardless of which underlying instance handled it.

## 4. Functional requirements

### 4.1 Routing pipeline

| ID | Requirement |
|---|---|
| R1 | Router accepts incoming HTTP / UDS requests at a stable known URL (`harness.sock` for local; ALB/Ingress for k8s/ECS). |
| R2 | For every incoming request, router queries the Registry for live harness-server instances + their capabilities + their current load metrics (heartbeat-derived). |
| R3 | Router applies a CAPABILITY FILTER — drops instances whose capabilities can't satisfy the request (provider creds missing for resolved bindings, product not in scope, active set incompatible, spawn-supports mismatch). |
| R4 | Router applies a HEALTH FILTER — drops instances flagged stale (3× missed heartbeats per Registry default). |
| R5 | Router applies the configured LOAD POLICY (see §4.3) to pick from remaining candidates. |
| R6 | If no candidate exists AND spawn capacity is available, router invokes the configured spawn primitive (per `project_spawn_primitive_pluggability`) to create a fresh instance, waits for its registration, then routes the request to it. |
| R7 | If no candidates AND no spawn capacity, router responds 503 with a clear error: "no harness-server instance available for capability profile X." |
| R8 | Routing decisions are logged with: jobId, chosen instanceId, candidate count after each filter, policy invocations. Operators can replay decisions via these logs. |
| R9 | Router itself is stateless — Registry is the source of truth. Multiple router replicas can run behind a load balancer for HA without coordinating between themselves. |

### 4.2 Operations supported

| ID | Requirement |
|---|---|
| R10 | `POST /v1/jobs` (job submission) — capability-routed per §4.1 + load-balanced; chosen instance owns the job for its lifetime. |
| R11 | `GET /v1/jobs` — fans out across all live instances; aggregates results in submission order. Per-instance failures degrade gracefully (return partial list with a `degraded` field). |
| R12 | `GET /v1/jobs/:id` — Registry lookup (`/registry/jobs/:id/instance`) → forward to that instance. 404 when the instance has terminated. |
| R13 | `GET /v1/jobs/:id/events` (SSE) — same Registry lookup + forward; router proxies the SSE stream verbatim, doesn't try to parse envelopes. |
| R14 | `POST /v1/jobs/:id/steer` (future steering prompts, see §10 open questions) — same Registry lookup + forward; per-job routing is mandatory for in-flight operations. |
| R15 | Console-web's catalog-management operations (mutations on pipelines/products/etc.) bypass the router and go directly to central Spring Modulith Catalog — these are not job-scoped, not instance-scoped. |

### 4.3 Load policies

| ID | Requirement |
|---|---|
| R16 | Policy is configurable per deployment via env or a config field; not hardcoded. |
| R17 | `prefer-idle` — first instance with `activeJobs=0` wins; falls back to least-loaded if all are busy. Default for warm-pool deployments. |
| R18 | `least-loaded` — pick instance minimizing `(activeJobs * weight) + cpuPercent + memPercent`. |
| R19 | `round-robin` — next instance in rotation. Stateless — uses a counter the router keeps per (capability-tuple) bucket. |
| R20 | `sticky-workspace` — last instance that ran this workspace. Tie-breaks by load when staleness is detected. Pairs with the spawnWorker bare-repo cache to maximize warmness. |
| R21 | `fresh-only` — always invoke spawn primitive; no reuse. For testing or strict-isolation scenarios. |
| R22 | Default policy: `prefer-idle` with `sticky-workspace` as tie-breaker — keeps cache warm + balances load. |

### 4.4 Spawn-fallback

| ID | Requirement |
|---|---|
| R23 | Router has a configured spawn primitive matching the deployment platform (subprocess for local-dev; devcontainer for richer local; k8s-job for k8s; ecs-task for ECS). |
| R24 | When fallback fires, router calls spawn primitive with the request's required capabilities so the new instance boots with matching config (right `accepts` set, right provider creds available). |
| R25 | Router awaits registration of the new instance with a configurable timeout (default 30s). On timeout, respond 503 with diagnostic. |
| R26 | Router does NOT teardown spawned instances — that's the instance's own responsibility (per `project_spawn_primitive_pluggability`, Model C ephemeral instances self-terminate after their job finishes; warm-pool instances live until idle TTL). |

### 4.5 HA + observability

| ID | Requirement |
|---|---|
| R27 | Router is horizontally scalable — multiple replicas behind an ingress/LB; Registry is shared. Replicas don't communicate; load decisions converge via Registry's freshness. |
| R28 | Router exposes its own `/health` endpoint (Registry reachability + recent decision-rate). Independent of instance health. |
| R29 | Router exports metrics: requests routed per policy, capability-filter rejections, spawn-fallbacks fired, queue time waiting for spawn, Registry round-trip times. |
| R30 | Router logs each routing decision in a structured format suitable for replay analysis. Default sink is stdout JSONL (consistent with `project_spawn_primitive_pluggability`). |

## 5. Non-goals

- **Router is NOT the orchestrator.** It doesn't run jobs, doesn't
  build adapters, doesn't read catalog. It's a thin dispatcher.
- **Router is NOT the auth boundary.** Auth tokens / cookies pass
  through unchanged; the chosen harness-server validates downstream.
  Router treats all requests as opaque (modulo the routing fields it
  reads from the path/body).
- **Router is NOT a service mesh.** It routes ONE service (harness-
  server). Edge-memory + edge-context have their own (or no) routing.
- **Router is NOT for v1.** See §1 build triggers.

## 6. Architecture sketch

```
                                      ┌────────────────────────────┐
                                      │      Registry (central)    │
                                      │  /registry/instances       │
                                      │  /registry/jobs/:id/        │
                                      │            instance        │
                                      └────────────┬───────────────┘
                                                   │
                                                   │ reads + spawns notify
                                                   ▼
   ┌─────────────────┐    routes      ┌───────────────────────────┐
   │ workspace CLI   │───────────────▶│                           │
   │ console-web     │                │      harness-router       │
   │ harness-cli     │                │                           │
   │ external bots   │                │  - capability filter      │
   └─────────────────┘                │  - load policy             │
                                      │  - spawn-fallback         │
                                      └────────────┬──────────────┘
                                                   │
                              forwards to chosen instance
                                                   │
                ┌──────────────────────────────────┼──────────────────────────────────┐
                ▼                                  ▼                                  ▼
     ┌────────────────────┐         ┌────────────────────┐         ┌────────────────────┐
     │ harness-server #1  │         │ harness-server #2  │         │ harness-server #3  │
     │ activeJobs: 2      │         │ activeJobs: 0      │         │ activeJobs: 5      │
     │ set: cheap         │         │ set: frontier      │         │ set: cheap         │
     │ providers: [opn,a] │         │ providers: [a]     │         │ providers: [opn]   │
     └────────────────────┘         └────────────────────┘         └────────────────────┘
                                            ↑
                                      router preferred this
                                      (capability match +
                                      activeJobs=0 wins)
```

### Topology placements

| Deployment | Router placement |
|---|---|
| Local dev (multi-instance, warm pool) | Tiny daemon listening on UDS or `localhost:NNNN`. Manages a small warm pool (1-3 instances). |
| K8s | Deployment behind a Service + Ingress. Stateless replicas for HA. |
| ECS | Fargate Service + ALB. Same shape as k8s. |

## 7. Tech stack (proposed)

- **Language:** TypeScript (Bun runtime). Same as harness-server, harness-cli — share package types via workspace links.
- **HTTP framework:** Lightweight, low-allocation — Hono or raw `node:http`. Router is on the request path; latency budget is tight.
- **Registry client:** Generated from central Spring Modulith OpenAPI (per `project_central_is_spring_modulith` contract-first principle).
- **Distribution:** Same as workspace CLI — bun-compiled single-file binary.

## 8. Out-of-scope (for v1 of router itself when built)

- **Rate limiting** — defer to ingress/LB layer (k8s Ingress, ALB, etc.). Router doesn't need its own.
- **Caching** — router doesn't cache responses; it forwards. Caching belongs in clients (console-web) or in central Catalog.
- **Authn/authz** — pass-through; downstream harness-server enforces.
- **Mesh-style retries** — if a chosen instance fails, return the error verbatim. Clients retry at their own discretion. (Adding retries here creates duplicate-execution risk for non-idempotent operations.)

## 9. Migration / introduction

When the build trigger fires, introduction is incremental:

1. **Phase R1:** Build a stub router that always picks "the only
   instance" (single-instance environments). Register it as the
   stable URL clients dial. No real routing logic yet — just
   passthrough.
2. **Phase R2:** Introduce the Registry. Stub router now reads the
   instance URL from Registry instead of config. Still
   single-instance.
3. **Phase R3:** Add capability-filter + first load policy
   (`prefer-idle`). Multi-instance becomes possible without client
   changes.
4. **Phase R4:** Add spawn-fallback. Now Model C / warm-pool /
   on-demand scaling all work.
5. **Phase R5:** Add remaining load policies + observability + HA
   replication.

Each phase is independently shippable. Phase R1 has no user-facing
benefit (it's a passthrough) but it captures the URL contract — once
clients dial the router, future phases swap behavior under them
without client-side changes.

## 10. Open questions

- **Do per-job ephemeral instances (Model C) include their job's
  output in the heartbeat payload?** Probably no — that's bus-event
  territory, not registry telemetry. But "the instance is making
  progress" might be a useful liveness signal beyond the timer-based
  heartbeat.
- **Sticky-workspace policy + spawn-fallback: race conditions?** If
  workspace W just had a job complete on instance A and a new job
  arrives, sticky says "go to A" — but if A's idle TTL expired in
  between and A self-terminated, the request must fall through to
  spawn. Acceptable race; just need to verify the Registry's
  termination signal arrives BEFORE the dispatch decision sees A as
  alive.
- **Backpressure when spawn capacity is exceeded?** Current spec says
  503 — should we offer a queue with bounded depth? Probably no for
  v1-of-router; backpressure usually belongs in the client.
- **Multi-region routing?** Current design assumes a single Registry.
  Multi-region requires either federated registries or a global
  Registry tier — own design problem, not this PRD's scope.

## 11. Status + next steps

**Status: Deferred.** Design captured here so future-Edwin doesn't
have to reconstruct it when the build trigger fires.

**Build only when:**
- Multi-instance scenarios become real (warm pool, Model C, multi-
  tenant)
- A concrete workload demands it (e.g., "developers running 5+
  concurrent jobs report cold-start latency hurts")

**Until then:** v1 ships with one harness-server at a fixed URL.
Clients (workspace CLI, console-web) dial it directly. Registry is
ALSO deferred (see `project_harness_server_registry`).

**Trigger to revisit:**
- An ops requirement pushes for HA harness-server fleet
- Model C per-job containers become the default (today's in-process
  flow plus slice 9d-4 env-flag opt-in is sufficient for current
  scenarios)
- A user reports cold-start pain that warm-pool would solve
