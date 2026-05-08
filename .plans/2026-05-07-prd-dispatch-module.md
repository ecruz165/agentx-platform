# Dispatch Module (Spring Modulith) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Module package:** `com.jefelabs.agentx.controlplane.dispatch`
**Companion documents:**
- `2026-05-07-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-07-prd-core-module.md` — scaffolding + shared kernel (open module)
- `2026-05-07-prd-harness-module.md` — supplies the candidate set of harnesses
- `2026-05-07-prd-job-module.md` — primary consumer of routing decisions
- `2026-05-07-prd-harness-router-deferred.md` — earlier (deferred) standalone-router design; this PRD describes the Spring Modulith module that absorbs that role into the control plane

---

## 1. Purpose

The Dispatch module is the **scheduling, queueing, and policy layer** inside the control plane's Spring Modulith. Given (a) a job's pipeline step that needs to execute, (b) the product's tenancy + locality requirements, and (c) the current set of registered harnesses, it answers: *"which specific harness should run this step?"* — and holds the dispatch queue that bridges the Job module (work to do) and the Harness module (workers available).

The module's primary aggregates are `HarnessRouter` (policy + decision) and the dispatch queue (pending step assignments). It exists because dispatch is a meaningfully separate concern from harness registration: knowing what's available (Harness module) and deciding what to do with that knowledge (Dispatch module) have different cadences, different inputs, and different failure modes. Conflating them is the most common mistake in workflow systems.

This PRD describes the **module within the Spring Boot Modulith control plane**. The earlier `prd-harness-router-deferred.md` describes a deferred standalone HTTP/UDS service for the same role; the Spring module supersedes that design — same responsibilities, different deployment shape (in-process module instead of separate service).

In v1 the routing logic is intentionally simple — round-robin with capability filtering, plus an "affinity" rule that keeps a job's steps on the same harness when possible (so worktree caches and credential propagation stay warm). v1.x and beyond add policy primitives: locality, fairness, capability-matching, cost-aware, etc.

## 2. Goals (v1)

- **Capability filtering.** The router considers only harnesses that *can* run the step (e.g., the agent's adapter is installed, the required provider has credentials).
- **Affinity.** When a job's first step ran on harness X, subsequent steps prefer harness X (for warm cache, persistent state). Configurable per-job (`affinity: 'sticky' | 'free'`).
- **Health-aware.** Unhealthy harnesses (per Registry's status) are excluded.
- **Multi-tenant.** Routing decisions respect org boundaries — a harness registered under org A is never given org B's work.
- **Audit trail.** Every routing decision is logged with the input criteria + the chosen harness + the reason.
- **Pluggable policies.** Router accepts a `RoutingPolicy` interface; v1 ships with `RoundRobinPolicy` + `StickyAffinityPolicy`, but new policies can be added without touching the interface.

## 3. Non-Goals (v1)

- **No real load balancing.** v1 doesn't track per-harness CPU/memory/queue depth; doesn't make load-aware decisions. v1.x adds when load reporting from Registry lands.
- **No cost-aware routing.** "Pick the cheapest provider" requires per-binding cost data the catalog doesn't track yet. v2+.
- **No geographic routing.** Region tags are read but not used; v1 is single-region. v2+ when multi-region demand surfaces.
- **(REVISED) Router DOES hold the dispatch queue.** Earlier draft put the queue in JSM with retry-poll; corrected: Router holds a Postgres-backed queue of pending step dispatches and pushes assignments via events when harnesses become available (see §6.6). This matches the Kubernetes scheduler pattern and gives Router global visibility for fairness. JSM submits, listens for `dispatch-ready`, then RPC's the assigned harness.
- **No live re-routing.** Once a step is dispatched, it stays on that harness even if a "better" harness comes online. v2+.
- **No bidding / auction.** Some routing systems let workers "bid" for jobs. v1 is push-based — the Router decides; harnesses don't choose.

## 4. Reference & Provenance

- Pattern: Kubernetes scheduler (filtering + scoring), Argo Workflows worker selection, Temporal task-queue routing.
- Earlier deferred design: `2026-05-07-prd-harness-router-deferred.md` — standalone HTTP/UDS service. Build triggers (warm pool, multi-instance scaling) listed there inform when the Spring module needs the policies described here.
- v1 routing logic is small enough (~200 lines of Java) that it doesn't need a constraint solver or scheduling library. Just plain decision code with pluggable policies.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **JobStateMachine (sibling Spring module)** | "Here's a pipeline step ready to run; tell me which harness to dispatch to." |
| **Owen (operator)** | "Show me the routing decisions for the last hour; are we balanced?" |
| **Iris (catalog admin)** | "Pin pipeline X to harnesses with GPU capability; pin pipeline Y to specific harnesses by id." |

## 6. Functional Requirements

### 6.1 Routing decision

| ID | Requirement |
|---|---|
| F1 | Internal API: `HarnessRouter.routeStep(StepContext): RoutingDecision` where `StepContext = { jobId, productId, step, requiredCapabilities, affinityHint }` and `RoutingDecision = { harnessId } | { reason: 'no-eligible-harness' }`. |
| F2 | Eligible-harness filtering: registry-healthy + capabilities-match + org-match. |
| F3 | Among eligible, apply policy chain: affinity preference > policy-specific selection (round-robin in v1) > tie-break by lowest `last_dispatched_at`. |
| F4 | Decision is logged to Postgres `routing_decisions` table; not blocking on log persistence. |
| F5 | If no eligible harness, return `{ reason: 'no-eligible-harness', missingCapabilities? }`. JobStateMachine retains job in `queued` state and re-asks when registry events suggest new candidates. |

### 6.2 Affinity

| ID | Requirement |
|---|---|
| F6 | When `affinityHint = stickyToJobOrigin`, prefer the harness that ran the job's first step. If unavailable, fall through to next-best. |
| F7 | Affinity preference is per-job, persisted in `jobs.affinity_harness_id`. |
| F8 | `affinityHint = none` skips affinity; round-robin across all eligible. |
| F9 | Default: pipelines opt-in via catalog metadata (`pipeline.routing.affinity = 'sticky'`); no affinity unless declared. |

### 6.3 Capability matching

| ID | Requirement |
|---|---|
| F10 | Step-derived capability requirements: agent step requires the agent's `adapter` + at least one `accepts` provider; transform/wait/etc. require nothing harness-specific (could run on any healthy harness). |
| F11 | Pipeline-level capability requirements: pipeline can declare `requiresCapabilities: ['gpu', 'private-network']` in catalog; router filters accordingly. |
| F12 | Catalog-level pinning: `pipeline.routing.harnessId = '...'` restricts routing to a specific harness. |

### 6.4 Policies

| ID | Requirement |
|---|---|
| F13 | `RoutingPolicy` interface: `select(eligibleHarnesses, context): HarnessId`. v1 ships `RoundRobinPolicy` + `StickyAffinityPolicy`. |
| F14 | Policy chain composition: affinity is *always* applied first (if hint present); then the configured base policy fires for non-affinity routes. |
| F15 | Policy selection per-deployment via `application.yml`: `agentx.router.policy = round-robin` (default). |
| F16 | New policies (e.g., `LeastLoadedPolicy`) can be added by implementing the interface; no other code changes needed. |

### 6.5 Audit

| ID | Requirement |
|---|---|
| F17 | Postgres table `routing_decisions`: `id`, `job_id`, `step_id`, `harness_id`, `policy_used`, `eligible_count`, `reason`, `decided_at`. |
| F18 | `GET /api/router/decisions?jobId={id}` returns routing history for a job. |

### 6.6 Dispatch queue

| ID | Requirement |
|---|---|
| F20 | Router maintains a Postgres-backed queue `dispatch_queue` with columns: `id`, `job_id`, `step_id`, `org_id`, `affinity_hint`, `required_capabilities`, `priority`, `enqueued_at`, `assigned_harness_id?`, `assigned_at?`, `state` (`pending`, `assigned`, `delivered`, `expired`). |
| F21 | Internal API `HarnessRouter.enqueueStep(StepContext): EnqueueResult` — JSM calls this when a step is ready to run; returns `{ dispatchId, queuePosition }`. |
| F22 | Router runs a scheduler loop: when a harness reports capacity (via Registry heartbeat or explicit `/capacity` event), Router scans `dispatch_queue` for pending entries that match the harness's capabilities + org boundary, applies routing policy, assigns, emits `dispatch-ready` event with `{ dispatchId, jobId, stepId, harnessId }`. |
| F23 | JSM listens for `dispatch-ready` events for its own jobs (filtered by `jobId`); on receipt, sends the step over RPC to the assigned harness. |
| F24 | Queue entries expire after a configurable TTL (default 1 hour) if not assigned — emit `dispatch-expired`; JSM handles by failing the job with reason `no-harness-available`. |
| F25 | Cancelling a job removes all its pending queue entries; Router emits `dispatch-cancelled` events for cleanup. |
| F26 | Priority field allows multi-tenant fairness: paid orgs / urgent jobs get higher priority. v1: priority is integer; defaults to `0`. |
| F27 | Operator visibility: `GET /api/router/queue?org={id}` lists pending entries for diagnostics; `GET /api/router/queue/stats` returns aggregate counts by state, age distribution. |
| F19 | `GET /api/router/decisions?since=<ts>&limit=N` paginated stream for operator audit. |

## 7. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  HarnessRouter module                                           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ HarnessRouter.routeStep(StepContext)                   │    │
│  │                                                         │    │
│  │   1. Read eligible harnesses                            │    │
│  │      from HarnessRegistry (in-Spring read)              │    │
│  │   2. Filter by capabilities                             │    │
│  │   3. Filter by org boundary                             │    │
│  │   4. Apply affinity (if hinted)                         │    │
│  │   5. Apply base policy (round-robin)                    │    │
│  │   6. Tie-break by last_dispatched_at                    │    │
│  │   7. Persist decision to audit log                      │    │
│  │   8. Return decision                                    │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Reads from: HarnessRegistry (live view, in-process)           │
│  Reads from: Catalog (pipeline.routing metadata)               │
│  Writes to:  Postgres routing_decisions                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 8. Open Questions

1. **Affinity strength:** "prefer" affinity (fall through if unavailable) or "require" affinity (fail with `affinity-violated` if unavailable)? Default: prefer. Strict-mode might be useful for testing/debugging.
2. **Re-routing on harness disconnect mid-job:** if affinity-pinned harness drops, re-route remaining steps elsewhere or fail the job? Default: re-route with a warning event. Fail-strict mode for compliance-critical pipelines.
3. **Pinning syntax:** `pipeline.routing.harnessId = '...'` is one option; `pipeline.routing.harnessSelector = { region: 'us-east', capability: 'gpu' }` is more flexible. Start simple, extend.
4. **Batch dispatch:** if a `fork` step has 5 branches needing dispatch, route all 5 in one `routeBatch()` call so the Router can balance globally. v1: per-step calls; per-batch is v1.x.
5. **Routing latency target:** routing should be sub-millisecond (in-process call, cache hit). If pathologically slow (e.g., huge eligible set), need indexing. v1: linear scan, fine for hundreds of harnesses.
6. **What happens to in-flight steps when a routing policy changes?** Existing dispatches stick; only future dispatches use the new policy. Hot-reload of policy via config reload, restart-free.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Routing is read-only of Registry; doesn't push back changes | Clean separation. | 2026-05-06 |
| D2 | Affinity is opt-in per-pipeline | Default anonymous routing keeps fairness simple. | 2026-05-06 |
| D3 | Round-robin baseline for v1 | Simplest fair policy; extend later. | 2026-05-06 |
| D4 | Pluggable RoutingPolicy interface | Extensibility without core changes. | 2026-05-06 |
| D5 | Audit log every decision | Debugging + fairness analysis depend on it. | 2026-05-06 |
| D6 | Routing lives as a Spring Modulith module, not a standalone service | Earlier `prd-harness-router-deferred.md` deferred a standalone design. The Spring module absorbs that role with the same responsibilities and lower operational complexity. | 2026-05-06 |
| D7 | Module renamed from `harnessrouter` → `dispatch` | The module owns routing AND the dispatch queue (per F20-F27); `dispatch` reads more accurately as the bounded context. `HarnessRouter` remains the aggregate-root class name within. | 2026-05-07 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | `routeStep` API; capability filtering; round-robin policy |
| **Phase 2** | Affinity hints; pipeline-level routing metadata |
| **Phase 3** | Audit log + REST endpoints for operator views |
| **Phase 4** | Additional policies (`LeastLoadedPolicy`, etc.) once Registry exposes load |
| **Phase 5+** | Multi-region, cost-aware, batch dispatch (v2+) |
