# Control Plane (Spring Boot Modulith) — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-control-plane-web-ui.md` — browser frontend served by this app
- `2026-05-06-prd-catalog-service.md` — Catalog module inside this app
- `2026-05-06-prd-job-state-machine.md` — JobStateMachine module
- `2026-05-06-prd-harness-registry.md` — HarnessRegistry module
- `2026-05-06-prd-harness-router.md` — HarnessRouter module
- `2026-05-06-prd-central-context-server.md` — central ContextServer module
- `2026-04-30-prd-harness-server.md` — the per-harness data-plane server this control plane orchestrates

---

## 1. Purpose

The Control Plane is the **central, stateful service** that owns the truth about pipelines, products, agents, skills, and the in-flight state of jobs across an organization. Built as a Spring Boot Modulith — a single deployable Java/Kotlin process with strict module boundaries — it sits opposite the data plane (TS-based `harness-server` instances running on developer laptops, ECS tasks, etc.).

Where the data plane *executes* work, the control plane *decides*: which pipelines exist, which harness should run a given job, what context is shared org-wide, and what state every in-flight job is in. This separation mirrors Kubernetes' control-plane / kubelet split applied to agentic workflows.

Per the catalog.ts comment: "When the central Spring Modulith Catalog service lands, this loader is replaced by an HTTP/gRPC call behind the same `loadCatalog()` surface." This PRD is the umbrella for that work.

## 2. Goals (v1)

- **Single deployable unit.** One Docker image (one JAR), one configuration. Zero microservice fanout in v1; the modulith is one process.
- **Clear module boundaries.** Catalog, JobStateMachine, HarnessRegistry, HarnessRouter, ContextServer are *Spring Modulith modules* — each owns its persistence + API surface; cross-module communication via published events or explicit interfaces only.
- **Standard ops envelope.** Health checks (`/actuator/health`), metrics (`/actuator/prometheus`), structured logging, OpenAPI surface for the public REST/gRPC API.
- **Stateful with durability.** All in-flight job state persists to a relational store (Postgres) so a restart doesn't lose work. Catalog is in Postgres + cache; context graph is Neo4j (separate).
- **Auth + authorization.** OAuth/OIDC for users (Web UI); API tokens or mTLS for harness-to-control-plane traffic.
- **Multi-tenant ready.** Every entity carries an org/product scope so a single deployment can serve multiple isolated tenants without code changes.

## 3. Non-Goals (v1)

- **Not horizontally scaled.** v1 is single-node. Adding active-active replication across nodes is v2+ work and depends on persistence + event-bus selection.
- **Not edge-replacement.** Workspace-local services (edge-context-server, edge-memory-server) keep operating; control plane *augments*, doesn't replace.
- **No microservice extraction.** v1 is a modulith on purpose — module boundaries enable future split, but premature splitting adds operational complexity without benefit.
- **No Kubernetes-native v1.** Single docker-compose deployment first; helm chart / operator come later.
- **No paid features yet.** No billing, no quota tracking, no rate limiting beyond DoS protection. Multi-tenancy is for isolation, not yet for monetization.

## 4. Reference & Provenance

- This PRD is the **umbrella** for 5 module-level PRDs (catalog, job-state-machine, harness-registry, harness-router, central-context-server).
- Spring Boot Modulith is the chosen framework for module boundary enforcement at compile time + at test time. https://spring.io/projects/spring-modulith
- Persistence: Postgres for relational state, Neo4j for context graph. Both run as sibling containers.
- The TS-side `harness-core`'s `Catalog` and `PipelineDef` types are the **wire-level contract** — the control plane's REST/gRPC API surfaces equivalent shapes. Java types may be hand-mirrored or codegen'd from TS.

## 5. Functional Requirements

| ID | Requirement |
|---|---|
| F1 | Single Docker image containing Spring Boot app + bundled Web UI static assets. Built with Gradle (or Maven); JLink-trimmed runtime for smaller image. |
| F2 | `docker-compose.yml` defines the deployment unit: `spring-app` + `postgres` + `neo4j` + `embedder` + (optional) `nginx` reverse proxy. |
| F3 | App exposes HTTPS on a single port (default 8443); HTTP/8080 in dev. Internal modules talk via Spring DI, not HTTP. |
| F4 | Public API surface: REST + Server-Sent Events for streaming progress; gRPC optional v1.x. OpenAPI spec generated from controllers. |
| F5 | Health endpoints: `/actuator/health` (liveness), `/actuator/health/readiness` (waits for DB + Neo4j). |
| F6 | Metrics: `/actuator/prometheus` exposes app metrics, JVM, HTTP request rates, module-internal events. |
| F7 | Auth: users authenticate via OAuth/OIDC (configurable IdP); harnesses authenticate via API token or mTLS. |
| F8 | Multi-tenant: every persisted entity carries `org_id` + `product_id` (FK or denormalized). All queries are tenant-scoped via Spring Security context. |
| F9 | Observability: structured JSON logs, request IDs propagated through all module boundaries, distributed tracing via OpenTelemetry. |
| F10 | Configuration: 12-factor — env vars and `application.yml` for local dev. Sensitive values via secret manager (AWS Secrets Manager, HashiCorp Vault, env-var fallback). |
| F11 | Persistence: Postgres for relational; Flyway-managed migrations versioned in `src/main/resources/db/migration/`. |
| F12 | Graceful shutdown: SIGTERM drains in-flight HTTP, completes in-flight jobs OR persists their state for resume after restart. |
| F13 | Module boundaries enforced via Spring Modulith verification tests — modules can only talk to each other through published events or explicit interfaces. |

## 6. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  Spring Boot Modulith JVM                                    │
│  ────────────────────────                                    │
│                                                              │
│  ┌──────────────┐       ┌──────────────────────────────────┐ │
│  │  Web UI      │──────▶│  REST + SSE controllers          │ │
│  │  static      │       └──────────┬───────────────────────┘ │
│  │  served at / │                  │                          │
│  └──────────────┘       ┌──────────▼───────────────────────┐ │
│                         │  Catalog module                  │ │
│                         │  (PRD: catalog-service.md)       │ │
│                         └──────────┬───────────────────────┘ │
│                         ┌──────────▼───────────────────────┐ │
│                         │  JobStateMachine module     │ │
│                         │  (PRD: job-state-machine)   │ │
│                         └──────────┬───────────────────────┘ │
│                         ┌──────────▼───────────────────────┐ │
│                         │  HarnessRouter module            │ │
│                         │  (PRD: harness-router)           │ │
│                         └──────────┬───────────────────────┘ │
│                         ┌──────────▼───────────────────────┐ │
│                         │  HarnessRegistry module          │ │
│                         │  (PRD: harness-registry)         │ │
│                         └──────────┬───────────────────────┘ │
│                         ┌──────────▼───────────────────────┐ │
│                         │  IntentService module            │ │
│                         │  (PRD: intent-service)           │ │
│                         │  conversational intent narrowing │ │
│                         │  via JobDefinitionPipelines      │ │
│                         └──────────┬───────────────────────┘ │
│                                    ▼                          │
│                         ┌──────────────────────────────────┐ │
│                         │  ContextServer module            │ │
│                         │  (PRD: central-context-server)   │ │
│                         └──────────┬───────────────────────┘ │
└────────────────────────────────────┼─────────────────────────┘
                                     │ JDBC / Bolt
              ┌────────────┬─────────┼────────┬────────────────┐
              ▼            ▼         ▼        ▼                ▼
         Postgres      Neo4j   Embedder    (S3 etc.   ...future stores
         (relational)  (graph) (HTTP API)  blob store)
```

## 7. Persistence model (high-level)

| Entity | Store | Owned by |
|---|---|---|
| Pipeline definitions | Postgres | Catalog module |
| Agent definitions | Postgres | Catalog module |
| Skill catalog | Postgres | Catalog module |
| In-flight jobs (state machine state) | Postgres | JobStateMachine module |
| Job event history | Postgres (or event store) | JobStateMachine module |
| Harness instances + heartbeat | Postgres | HarnessRegistry module |
| Routing policies / decisions audit | Postgres | HarnessRouter module |
| Context graph (nodes, edges, vectors) | Neo4j | ContextServer module |
| User identities + sessions | Postgres (or delegated to IdP) | (cross-cutting Spring Security) |
| Intent sessions (conversation state) | Postgres | IntentService module |
| Dispatch queue (pending step assignments) | Postgres | HarnessRouter module |

Cross-module access is **read-only via shared interfaces** — e.g., HarnessRouter reads HarnessRegistry's view of available harnesses but does not write to it. Writes stay inside the owning module.

## 8. Open Questions

1. **Java vs Kotlin?** Modulith works with both. Kotlin's null-safety + DSL ergonomics align with the catalog-as-config workflow. Java has the larger Spring ecosystem story. Likely Kotlin for new code, Java for any required legacy integration.
2. **gRPC or REST-only?** REST + SSE is sufficient for v1. gRPC adds a binary protocol for harness-to-control-plane traffic with better streaming semantics — worth considering for high-throughput deployments.
3. **Event bus choice?** In-process Spring events are fine for v1 (single-node). For v2+ horizontal scaling, switching to Kafka/NATS/Redis Streams becomes important. Design module boundaries so event publishing is pluggable.
4. **Postgres schema-per-tenant or row-level?** Row-level (`org_id` column on every table) is simpler. Schema-per-tenant offers stronger isolation but complicates migrations. v1: row-level + RLS (row-level security) policies.
5. **Web UI build pipeline:** built separately and copied into Spring's `static/` at image-build time, OR built via Spring's webjars plugin? Separate-build is more flexible (can use Vite/Next/etc. natively).
6. **JDK version:** Java 21 LTS (virtual threads make per-job-per-thread practical for blocking work) vs Java 17 LTS (broader compat). Recommend 21 for new work.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Spring Boot Modulith over microservices for v1 | One deployment, strict module boundaries, simpler ops. Microservice split deferred until size warrants. | 2026-05-06 |
| D2 | Postgres + Neo4j (not "everything in Neo4j") | Relational for state machine, sessions, registry; graph for context. Each tool used for what it's best at. | 2026-05-06 |
| D3 | Auth via OIDC + API tokens (not custom auth) | Standard, integrates with corporate IdPs (Okta, Auth0, Cognito). | 2026-05-06 |
| D4 | TS `Catalog` types are the wire contract | Ensures TS data plane and Java control plane stay in lockstep. | 2026-05-06 |
| D5 | Neo4j is a sibling container, not embedded | Standard production pattern. Embedded mode is Community-only and not recommended for prod. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 0 — skeleton** | Spring Modulith bootstrap, empty modules, health checks, Postgres + Flyway migrations, OIDC auth |
| **Phase 1 — Catalog** | Pipelines + Agents + Skills CRUD; expose `loadCatalog()`-equivalent REST endpoint that TS harnesses can poll |
| **Phase 2 — Registry + Router** | Harnesses register on startup; router routes incoming jobs by simple round-robin |
| **Phase 3 — JobStateMachine** | Server-side pipeline execution with DAG types from harness-core; harnesses become stateless step executors |
| **Phase 4 — ContextServer** | Central RAG with org-wide content; agents query both edge + central |
| **Phase 5 — Web UI integration** | Browser app for catalog management + live job monitoring |
| **Phase 6 — IntentService** | Conversational intake via JobDefinitionPipelines; user-in-the-loop intent narrowing; auto-pipeline-creation via `pipeline-architect` (with admin approval gate) |

Phases 1-2 unblock initial value (centralized catalog). Phase 3 is the big lift (state machine semantics). Phase 4-5 round out the platform. Phase 6 unlocks the conversational + self-extending tier.
