# Harness Module (Spring Modulith) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Module package:** `com.jefelabs.agentx.controlplane.harness`
**Companion documents:**
- `2026-05-07-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-07-prd-core-module.md` — scaffolding + shared kernel (open module)
- `2026-05-07-prd-dispatch-module.md` — primary consumer of the Registry's view
- `2026-05-07-prd-job-module.md` — dispatches steps to harnesses the registry tracks
- `2026-04-30-prd-harness-server.md` — TS-side that registers itself

---

## 1. Purpose

The HarnessRegistry is the **service discovery layer** for harness instances connected to the control plane. Every running harness (workspace-local on a developer laptop, ECS task in the cloud, future mobile clients) registers itself on startup and emits periodic heartbeats. The Registry maintains the live picture of "what harnesses exist right now, where to reach them, what they can do."

It exists because the control plane needs to *route* work somewhere, and routing requires knowing the candidates. Conflating "who's available" with "how to choose between them" is a common mistake in workflow systems — the Registry is deliberately scoped to *discovery only*. The Router (separate module, separate PRD) handles policy.

The pattern is well-established: Consul/etcd in service-mesh land, Kubernetes' kubelet → API server registration, Temporal worker registration. This module is a small, focused implementation of that pattern for harnesses.

## 2. Goals (v1)

- **Self-registration on startup.** Harness comes online, calls `POST /api/registry/harnesses`, gets a session token. No external setup needed.
- **Heartbeat-based liveness.** Harness sends `POST /api/registry/heartbeat` every N seconds; missing N+1 marks harness as unhealthy.
- **Capability declaration.** Harness reports what it can do: which adapters are installed, which providers it has credentials for, GPU/CPU profile, geographic region (for routing locality).
- **Graceful deregistration.** Harness on shutdown calls `DELETE /api/registry/harnesses/{id}`; removed cleanly. SIGTERM-driven.
- **Live view.** REST API + SSE stream for the Router and Web UI to consume current registry state.
- **Multi-tenant.** Harnesses register against an org; one org's Registry view doesn't leak across orgs.

## 3. Non-Goals (v1)

- **No load metrics in v1.** "How busy is each harness right now" is the Router's concern; the Registry just says "exists + alive." Per-harness load reporting is a v1.x enhancement.
- **No automatic harness provisioning.** Spinning up new harnesses (e.g., scaling ECS tasks based on demand) is out of scope. Registry only *tracks* harnesses; provisioning is operator-driven.
- **No cross-region failover logic.** Multi-region awareness is metadata only (region tag); the Router decides what to do with it.
- **No service mesh integration.** v1 doesn't try to integrate with Consul/Istio/Linkerd. Registry is a simple in-app registry, not a sidecar.
- **No version / capability negotiation protocol.** Harnesses report their capabilities once at registration; if they upgrade, they re-register. No mid-session upgrades.

## 4. Reference & Provenance

- Pattern: Kubernetes node registration (kubelet → kube-apiserver). Consul service registration. Temporal worker registration via SDK.
- v1 implementation is HTTP-based for simplicity. v2+ may switch to gRPC bidirectional streaming for sub-second freshness.
- Heartbeat protocol modeled after Kubernetes node heartbeats: simple, periodic, idempotent.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **The Harness itself (data plane)** | Register on startup, heartbeat regularly, deregister on shutdown. Treat registration as fail-safe — control plane unreachable should not block local-only operation. |
| **HarnessRouter (sibling Spring module)** | Read current set of healthy harnesses, with capabilities + region, to decide where to dispatch. |
| **Owen (operator)** | "Show me the fleet: which harnesses are alive, which are unhealthy, which are flapping." |
| **Auditor** | "When did harness X disconnect? Was it graceful?" |

## 6. Functional Requirements

### 6.1 Registration

| ID | Requirement |
|---|---|
| F1 | `POST /api/registry/harnesses` with body `{ name, version, capabilities, region, endpoints }`. Returns `{ harnessId, sessionToken }`. |
| F2 | `harnessId` is a stable identifier — preserved across reconnects (harness sends its preferred id; server confirms or assigns). |
| F3 | `sessionToken` is short-lived (minutes); harness includes it in subsequent calls. Refreshed via heartbeat. |
| F4 | Registration is **idempotent** — re-registering with same `harnessId` updates the existing record (capabilities may have changed). |
| F5 | Registration requires API token / mTLS auth at the network layer; the org context comes from the auth principal. |
| F6 | `capabilities` payload includes: installed adapters (`['claude-sdk', 'opencode-cli']`), available providers (`['anthropic', 'openai', 'local-qwen']`), max concurrent jobs, GPU presence. |

### 6.2 Heartbeat

| ID | Requirement |
|---|---|
| F7 | `POST /api/registry/heartbeat` with `{ harnessId, sessionToken, currentLoad?, healthOk? }`. Returns updated session token. |
| F8 | Heartbeat interval: 15s (server-side default, overridable per-harness via initial registration response). |
| F9 | Missing 2 consecutive heartbeats marks harness `unhealthy` (visible to Router; not yet evicted). |
| F10 | Missing 5 consecutive heartbeats marks harness `disconnected` and removes from active set; record retained in audit history. |
| F11 | `currentLoad` (number of in-flight jobs) is informational; Router may use it for fairness but doesn't have to. |

### 6.3 Deregistration

| ID | Requirement |
|---|---|
| F12 | `DELETE /api/registry/harnesses/{id}` with valid sessionToken. Marks harness `disconnected` cleanly; not flagged as crashed. |
| F13 | Harness's TS code calls deregister on SIGTERM before exiting. Failures (e.g., network down) are non-fatal — server reaps via missed heartbeats. |

### 6.4 Read API

| ID | Requirement |
|---|---|
| F14 | `GET /api/registry/harnesses` returns active harnesses for current org, with capabilities + last heartbeat timestamp. Pagination + filtering by region/capability. |
| F15 | `GET /api/registry/harnesses/{id}` for single harness detail including history (last N heartbeats, registration metadata). |
| F16 | `GET /api/registry/stream` is an SSE stream of registry events (registration, heartbeat, disconnect) for live UI updates. |
| F17 | Internal Spring API: `HarnessRegistryService.findHealthyHarnesses(criteria): List<HarnessRecord>` — read by Router. |

### 6.5 Persistence + state

| ID | Requirement |
|---|---|
| F18 | Postgres table `harnesses`: `id`, `org_id`, `name`, `version`, `capabilities (jsonb)`, `region`, `endpoints (jsonb)`, `status`, `last_heartbeat_at`, `registered_at`. |
| F19 | Postgres table `harness_audit_events`: registration, heartbeat misses, disconnects, capability changes. |
| F20 | Active-set queries cached in memory (Caffeine); cache invalidated on registration / heartbeat / disconnect. |

## 7. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  HarnessRegistry module                                          │
│                                                                  │
│  ┌────────────────────┐     ┌──────────────────────────────┐    │
│  │ Registration API   │     │ Heartbeat tracker            │    │
│  │ (POST /harnesses)  │────▶│ (scheduled job marks         │    │
│  └────────────────────┘     │  unhealthy/disconnected)     │    │
│                             └──────────┬───────────────────┘    │
│                                        │                        │
│  ┌────────────────────┐     ┌──────────▼───────────────────┐    │
│  │ Read API           │     │ Postgres + cache             │    │
│  │ (GET /harnesses)   │◀────│ (active harnesses, audit)    │    │
│  └────────────────────┘     └──────────────────────────────┘    │
│                                                                  │
│  Publishes: HarnessRegisteredEvent, HarnessHeartbeatEvent,      │
│             HarnessDisconnectedEvent — consumed by Router       │
│             + Web UI SSE channel.                                │
└──────────────────────────────────────────────────────────────────┘
```

## 8. Open Questions

1. **gRPC streaming vs HTTP polling for harnesses.** v1: harnesses do HTTP heartbeat every 15s. v2+: bidirectional gRPC stream for sub-second freshness + push-based step dispatch. Deferred until performance demands it.
2. **Capability schema:** what's the canonical shape for "what a harness can do"? Adapters + providers + max concurrency are obvious; GPU/CPU/memory profile less so. Start minimal, extend.
3. **Authentication renewal:** session tokens issued at registration expire how often? 1 hour, refreshed on heartbeat? Balances security vs reconnect churn. v1: 1 hour, refreshed on every heartbeat.
4. **Eviction grace period:** missing N=5 heartbeats = disconnect. Is N=5 right, or should it be configurable per-deployment? Likely env-var configurable.
5. **Cross-region or cross-cloud registration:** harnesses from different regions register against same control plane; latency varies. Heartbeat interval should accommodate the slowest reasonable round-trip.
6. **Org boundary at registration:** how does the harness know its org? From its API token. Tokens are minted via Web UI (org admin) and provisioned to harness via env var.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | HTTP-based registration + heartbeat in v1 | Simpler than gRPC streaming; sufficient freshness for typical deployments. | 2026-05-06 |
| D2 | Registry tracks discovery only, not load-balancing | Separation of concerns; Router owns scheduling. | 2026-05-06 |
| D3 | Postgres for persistence (not in-memory only) | Survives Spring restart; harnesses stay registered. | 2026-05-06 |
| D4 | Heartbeat interval 15s; eviction at 5 misses (75s) | Standard service-discovery cadence. | 2026-05-06 |
| D5 | Session tokens minted at registration; refreshed on heartbeat | Minimizes re-auth churn; bounded by token lifetime. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Registration + heartbeat APIs; persistence; basic read API |
| **Phase 2** | Eviction (missed heartbeat handling); audit log |
| **Phase 3** | SSE event stream for Web UI; capability filtering on read API |
| **Phase 4** | Internal API for Router consumption; performance tuning of cache |
| **Phase 5+** | gRPC streaming option (v2+) |
