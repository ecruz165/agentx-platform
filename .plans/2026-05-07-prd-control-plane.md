# Control Plane (Spring Boot Modulith) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Role:** umbrella + index — purpose, package layout, architecture overview. Implementation requirements (Docker, persistence, auth, observability, Modulith verification) live in `2026-05-07-prd-core-module.md`.
**Bootstrap source:** `.plans/2026-05-07-prd-control-plane-spring-initializr-source.zip` — Spring Initializr export. The unzipped `controlplane/` directory is the canonical starting point for the project; this PRD is its blueprint.
**Companion documents (Spring Modulith modules — one PRD per module):**
- `2026-05-07-prd-core-module.md` — scaffolding + shared kernel (open module)
- `2026-05-07-prd-catalog-module.md` — pipelines, agents, skills, products
- `2026-05-07-prd-context-module.md` — org-wide graph-RAG
- `2026-05-07-prd-intent-module.md` — conversational intake → JobIntent
- `2026-05-07-prd-job-module.md` — in-flight jobs + state machine + event log
- `2026-05-07-prd-harness-module.md` — harness registry + heartbeat
- `2026-05-07-prd-dispatch-module.md` — router + dispatch queue + audit
- `2026-05-07-prd-control-plane-web-ui.md` — browser frontend served by this app
- `2026-05-07-prd-control-plane-operational-hardening.md` — SSL/TLS + Auth + Actuator + OpenTelemetry + Datadog (Phase 7, deferred to last)
- `2026-05-07-prd-harness-router-deferred.md` — earlier deferred standalone-service design (superseded by dispatch module; kept for historical record)
- `2026-04-30-prd-harness-server.md` — TS-side data plane this control plane orchestrates

---

## 1. Purpose

The Control Plane is the **central, stateful service** that owns the truth about pipelines, products, agents, skills, and the in-flight state of jobs across an organization. Built as a Spring Boot Modulith — a single deployable Java/Kotlin process with strict module boundaries — it sits opposite the data plane (TS-based `harness-server` instances running on developer laptops, ECS tasks, etc.).

Where the data plane *executes* work, the control plane *decides*: which pipelines exist, which harness should run a given job, what context is shared org-wide, and what state every in-flight job is in. This separation mirrors Kubernetes' control-plane / kubelet split applied to agentic workflows.

Per the catalog.ts comment: "When the central Spring Modulith Catalog service lands, this loader is replaced by an HTTP/gRPC call behind the same `loadCatalog()` surface." This PRD is the umbrella for that work.

## 2. Goals (v1)

- **Single deployable unit.** One Docker image (one JAR), one configuration. Zero microservice fanout in v1; the modulith is one process. Implementation: see core module PRD.
- **Clear module boundaries.** Seven Spring Modulith modules — `core` (open) + `catalog`, `context`, `intent`, `job`, `harness`, `dispatch` (closed). Each owns its persistence + API surface; cross-module communication via published events or explicit interfaces only.
- **Standard ops envelope.** Health checks, metrics, structured logging, OpenAPI surface for REST/gRPC. Implementation: see core module PRD.
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

- This PRD is the **umbrella** for 7 module-level PRDs (`core`, `catalog`, `context`, `intent`, `job`, `harness`, `dispatch`).
- Spring Boot Modulith is the chosen framework for module boundary enforcement at compile time + at test time. https://spring.io/projects/spring-modulith
- Persistence: Postgres for relational state, Neo4j for context graph. Both run as sibling containers.
- The TS-side `harness-core`'s `Catalog` and `PipelineDef` types are the **wire-level contract** — the control plane's REST/gRPC API surfaces equivalent shapes. Java types may be hand-mirrored or codegen'd from TS.

### 4a. Bootstrap & runtime stack

The project is bootstrapped from `.plans/2026-05-07-prd-control-plane-spring-initializr-source.zip` (Spring Initializr export, kept for reproducibility). Unzipping yields a `controlplane/` directory which becomes the project root.

**Project metadata (from `pom.xml`):**

| Property | Value |
|---|---|
| Group | `com.jefelabs.agentx` |
| Artifact | `controlplane` |
| Java root package | `com.jefelabs.agentx.controlplane` |
| Application class | `ControlplaneApplication` |
| Build tool | Maven (with Maven wrapper `mvnw`) |
| Java version | 25 |
| Spring Boot | 4.0.6 |
| Spring Modulith | 2.0.6 |

**Already wired by the starter:**

| Concern | Dependency | Notes |
|---|---|---|
| Web layer | `spring-boot-starter-webmvc` | Spring MVC (servlet) — paired with virtual threads (see config note below); supports SSE via `SseEmitter`. Reactive (WebFlux) explicitly NOT chosen — see D14. |
| Module boundaries | `spring-modulith-starter-core`, `spring-modulith-runtime` | Boundary verification + ApplicationModuleListener |
| Persistence migrations | `spring-boot-starter-flyway` | Flyway with `db/migration/` location wired |
| API documentation | `springdoc-openapi-starter-webmvc-ui` 3.0.2 | Annotation-driven OpenAPI + Swagger UI at `/swagger-ui` |
| Local dev sibling services | `spring-boot-docker-compose` (runtime, optional) | Auto-starts services declared in `compose.yaml` on `mvn spring-boot:run` — populate `compose.yaml` with `postgres`, `neo4j`, `embedder` |
| Boilerplate reduction | `lombok` (annotation processor) | Records-vs-Lombok choice deferred to module authors; both are available |
| Native image build | `native-maven-plugin` (GraalVM) | `mvn -Pnative native:compile` produces a self-contained binary (~50MB, sub-second cold start) — preferred over JLink for production images |
| Test harness | `spring-modulith-starter-test`, `spring-boot-starter-flyway-test` | Includes `Scenario` testing API and Modulith verification helpers |

**Not yet wired — added per phase:**

| Concern | Dependency to add | Phase |
|---|---|---|
| Relational persistence | `spring-boot-starter-data-jpa` (or `spring-boot-starter-jdbc` + jOOQ) + `org.postgresql:postgresql` | Phase 0 (core module) |
| Modulith durable events | `spring-modulith-starter-jpa` | Phase 0 (core module) |
| Graph database | `org.neo4j.driver:neo4j-java-driver` | Phase 4 (context module) |
| Health, metrics, info | `spring-boot-starter-actuator` | **Phase 7 (final hardening)** |
| TLS / HTTPS | configure server SSL via `application.yml`; consider reverse proxy (nginx) instead | **Phase 7 (final hardening)** |
| OAuth/OIDC users | `spring-boot-starter-oauth2-client`, `spring-boot-starter-oauth2-resource-server` | **Phase 7 (final hardening)** |
| Harness mTLS / API tokens | custom config; `spring-boot-starter-security` for filter | **Phase 7 (final hardening)** |
| Structured JSON logging | `logstash-logback-encoder` (or equivalent) | **Phase 7 (final hardening)** |
| Distributed tracing | `io.micrometer:micrometer-tracing-bridge-otel` + `opentelemetry-exporter-otlp` | **Phase 7 (final hardening)** |

**Why these are deferred to Phase 7:** TLS/auth, Actuator, structured logging, and OpenTelemetry are *operational* concerns — necessary for any deployed environment but not required to validate that features work locally. Phases 0-6 build features against `localhost`/`http://localhost:8080` with no auth boundary, dev-mode `TenantContext` populated from a request header (e.g., `X-Org-Id`), and default Spring Boot console logging. This lets feature work proceed unblocked; the operational layer slots in at Phase 7 by *adding* — not replacing — wiring (e.g., once OAuth is enabled, the same `TenantContext` populates from `Authentication` instead of the dev header). The Modulith structure doesn't change.

**Required Phase 0 config additions** (no new dependencies; `application.yml` flags only):

```yaml
spring:
  threads:
    virtual:
      enabled: true   # Java 25 virtual threads for Spring MVC + @Async + RestClient (per D14)
```

This single flag makes blocking JDBC / Neo4j / outbound HTTP calls park virtual threads instead of kernel threads — the servlet API gets reactive-grade concurrency without reactive's code shape. Should land alongside the Initializr unzip in Phase 0.

**Other generated files of note:**

- `compose.yaml` — currently `services: {}`. Populate with `postgres`, `neo4j`, `embedder` containers; `spring-boot-docker-compose` will auto-start them.
- `src/main/resources/application.properties` — only `spring.application.name=controlplane` so far. Will grow with auth, persistence, Actuator, OpenAPI URL, etc. (Consider migrating to `application.yml` for readability when it grows.)
- `src/main/resources/db/migration/` — empty Flyway location; core's parent migrations land here as `V0001__core_*.sql` (per core PRD F16).
- `mvnw`, `mvnw.cmd` — Maven wrapper, so contributors don't need a system Maven install.
- `HELP.md` — Initializr-generated reference list. Safe to delete once this PRD is the canonical onboarding doc.

## 5. Package layout

The Spring Modulith app is organized into seven modules under the Java root package `com.jefelabs.agentx.controlplane`. Each direct sub-package IS a Spring Modulith module — boundary verification tests run at the package-leaf level.

```
com.jefelabs.agentx.controlplane
├── core/         (OPEN)    scaffolding + shared kernel
├── catalog/      (closed)  pipelines, agents, skills, products
├── context/      (closed)  org-wide graph-RAG (Neo4j)
├── intent/       (closed)  conversational intake → JobIntent
├── job/          (closed)  in-flight jobs + state machine
├── harness/      (closed)  registered harnesses + heartbeats
└── dispatch/     (closed)  router + queue + audit
```

### Naming conventions

- **Module = leaf package name.** Singular nouns for systems (`catalog`, `context`, `intent`, `dispatch`). Singular for `job` and `harness` even though many instances exist — the package name is the bounded context, not a collection.
- **Class names retain their domain shape.** Inside `harness/` the aggregate is `HarnessRegistry`; inside `dispatch/` it's `HarnessRouter`; inside `job/` it's `JobStateMachine`. The redundancy reads as clarification (`harness.HarnessRegistry`), not noise — package tells you the *domain*, class tells you the *role within the domain*.
- **Internal sub-packages are *closed by default*.** Code outside a module cannot import its sub-packages unless those are declared `@NamedInterface`. Each module PRD documents its sub-package layout (e.g., `job/states/`, `job/runs/`, `job/events/`).
- **`core` is `@ApplicationModule(type = OPEN)`.** Its public types (`OrgId`, `ProductId`, `TenantContext`, `JobIntent`, base auditable entity, common event envelopes) are reachable from every module without explicit dependency declarations. This is the recognized escape hatch for cross-cutting types.

### Module boundaries (events flow left-to-right)

```
intent ─JobIntent─▶ job ─StepReady─▶ dispatch ─StepDispatched─▶ harness ─StepCompleted─▶ job
```

Each arrow is a published Spring Modulith event. The Job module is the canonical "intent → durable job" boundary (`JobStateMachine.submit(JobIntent) → Job`). The Dispatch module is the *saga* between Job and Harness — it owns the policy plus the queue. The Harness module owns inventory + liveness, not routing decisions. See each module's PRD for the events it publishes + consumes.

### Why these names

- `dispatch` (not `harness-router`) — the module owns routing policy AND the dispatch queue; "dispatch" matches the bounded context, while `HarnessRouter` remains the aggregate-root class name within. (See `prd-dispatch-module.md` D7.)
- `harness` (not `harness-registry`) — the module owns more than the registry: heartbeats, capability declarations, lifecycle. `HarnessRegistry` is one aggregate within.
- `job` (not `job-state-machine`) — the module owns Jobs, JobRuns, JobEvents, plus the state machine that drives them. `JobStateMachine` is the engine inside.
- `core` (not just config-holder) — owns shared types, not just bootstrap. Open-module pattern is the standard way to share a kernel across closed modules.

## 6. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Spring Boot Modulith JVM                                            │
│  ────────────────────────                                            │
│                                                                      │
│  ┌──────────────┐       ┌──────────────────────────────────────────┐ │
│  │  Web UI      │──────▶│  REST + SSE controllers                  │ │
│  │  static      │       └────────┬─────────────────────────────────┘ │
│  │  served at / │                │                                   │
│  └──────────────┘                ▼                                   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  core module (OPEN)                                            │ │
│  │  • shared kernel: OrgId, ProductId, TenantContext, JobIntent  │ │
│  │  • scaffolding: security, persistence config, OpenAPI, OTel   │ │
│  │  • Modulith verification setup                                │ │
│  │  PRD: core-module.md                                           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ catalog      │  │ context      │  │ intent       │               │
│  │ definitions  │  │ org-wide RAG │  │ JobIntent    │               │
│  │ (PRD)        │  │ (PRD)        │  │ producer     │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │ reads           │ reads           │ JobIntent              │
│         │                 │                 ▼                        │
│         │                 │          ┌──────────────┐                │
│         └───── reads ────────────────▶│ job          │◀── StepCompleted
│                                       │ in-flight    │                │
│                                       │ jobs + JSM   │                │
│                                       │ (PRD)        │                │
│                                       └──────┬───────┘                │
│                                              │ StepReady              │
│                                              ▼                        │
│                                       ┌──────────────┐                │
│                                       │ dispatch     │                │
│                                       │ router+queue │                │
│                                       │ (PRD)        │                │
│                                       └──────┬───────┘                │
│                                              │ StepDispatched         │
│                                              ▼                        │
│                                       ┌──────────────┐                │
│                                       │ harness      │                │
│                                       │ inventory +  │──── RPC ──────▶│
│                                       │ heartbeats   │                │
│                                       │ (PRD)        │                │
│                                       └──────────────┘                │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ JDBC / Bolt / HTTP
              ┌────────────┬─────────┼────────┬────────────────┐
              ▼            ▼         ▼        ▼                ▼
         Postgres      Neo4j   Embedder    (S3 etc.   ...future stores
         (relational)  (graph) (HTTP API)  blob store)
                                              ▲
                                              │ HTTPS
                                              │
                                       harness-server N
                                       (TS data plane,
                                        worker for Job
                                        steps via dispatch)
```

## 7. Persistence model (high-level)

| Entity | Store | Owned by |
|---|---|---|
| Pipeline definitions | Postgres | catalog module |
| Agent definitions | Postgres | catalog module |
| Skill catalog | Postgres | catalog module |
| Product definitions | Postgres | catalog module |
| In-flight jobs (state machine state) | Postgres | job module |
| Job event history | Postgres (or event store) | job module |
| Harness instances + heartbeat | Postgres | harness module |
| Routing decisions audit | Postgres | dispatch module |
| Dispatch queue (pending step assignments) | Postgres | dispatch module |
| Context graph (nodes, edges, vectors) | Neo4j | context module |
| Intent sessions (conversation state) | Postgres | intent module |
| User identities + sessions | Postgres (or delegated to IdP) | core module (cross-cutting Spring Security) |

Cross-module access is **read-only via shared interfaces** — e.g., dispatch reads harness's view of available harnesses but does not write to it. Writes stay inside the owning module.

## 8. Open Questions

1. **gRPC or REST-only?** REST + SSE is sufficient for v1 (Spring MVC is wired in the starter; SSE via `SseEmitter`). gRPC adds a binary protocol for harness-to-control-plane traffic with better streaming semantics — worth considering for high-throughput deployments. Adding gRPC means pulling `grpc-spring-boot-starter` later.
2. **Event bus choice?** In-process Spring events + `spring-modulith-starter-jpa` (durable event log in Postgres) are fine for v1 (single-node). For v2+ horizontal scaling, switching to Kafka/NATS/Redis Streams becomes important. Design module boundaries so event publishing is pluggable; `spring-modulith-events-kafka` is a drop-in path.
3. **Postgres schema-per-tenant or row-level?** Row-level (`org_id` column on every table) is simpler. Schema-per-tenant offers stronger isolation but complicates Flyway migrations. v1: row-level + RLS (row-level security) policies.
4. **Web UI build pipeline:** built separately and copied into Spring's `src/main/resources/static/` at image-build time, OR built via Spring's webjars plugin? Separate-build is more flexible (can use Vite/Next/etc. natively); the starter already creates the empty `static/` directory expecting this.
5. **Records vs Lombok for value types.** Java 25 records are first-class; Lombok is also wired. For immutable DTOs / events, prefer records. Lombok stays available for entities that need mutability or builder patterns.
6. **Native image vs JVM image for production.** Native (GraalVM, via `native-maven-plugin`) gives ~50MB image + sub-second startup at the cost of ~5-minute build time and reflection-config maintenance. JVM image is bigger but easier to debug. Default v1: JVM; switch to native once boundaries stabilize.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Spring Boot Modulith over microservices for v1 | One deployment, strict module boundaries, simpler ops. Microservice split deferred until size warrants. | 2026-05-06 |
| D2 | Postgres + Neo4j (not "everything in Neo4j") | Relational for state machine, sessions, registry; graph for context. Each tool used for what it's best at. | 2026-05-06 |
| D3 | Auth via OIDC + API tokens (not custom auth) | Standard, integrates with corporate IdPs (Okta, Auth0, Cognito). | 2026-05-06 |
| D4 | TS `Catalog` types are the wire contract | Ensures TS data plane and Java control plane stay in lockstep. | 2026-05-06 |
| D5 | Neo4j is a sibling container, not embedded | Standard production pattern. Embedded mode is Community-only and not recommended for prod. | 2026-05-06 |
| D6 | Seven modules: `core` (open) + 6 closed domain modules | Domain-noun naming over pattern-noun (`harness` not `harness-registry`); `dispatch` reflects router+queue scope; `core` as open module is the recognized cross-cutting kernel pattern. | 2026-05-07 |
| D7 | Implementation requirements extracted from this umbrella into `prd-core-module.md` | Umbrella stays focused on index + architecture; cross-cutting build/persistence/auth/observability concerns live with the module that owns them. | 2026-05-07 |
| D8 | Java 21 LTS + Spring Boot 4.0.6 + Spring Modulith 2.0.6 | Initializr selected Java 25, downgraded to **Java 21 LTS** for implementation: LTS support window, broader CI matrix, virtual threads matured here (finalized in 21). Boot 4 supports 17+; the loss of Java 22-25 features (pattern-matching refinements, scoped values, etc.) is acceptable for a starting baseline. Re-evaluate when Java 25 LTS-equivalent ships. | 2026-05-07 |
| D9 | Maven (with wrapper) over Gradle | Per Initializr. Maven's stricter conventions reduce yak-shaving; wrapper means contributors don't need a system install. | 2026-05-07 |
| D10 | Group `com.jefelabs.agentx`; root package `com.jefelabs.agentx.controlplane` | Per Initializr. `jefelabs` is the org domain; `agentx` is the platform; `controlplane` is the module. | 2026-05-07 |
| D11 | OpenAPI via springdoc (annotation-driven) | Per Initializr (`springdoc-openapi-starter-webmvc-ui` wired). Generates spec from controllers; no separate hand-authored YAML to maintain. | 2026-05-07 |
| D12 | `spring-boot-docker-compose` for local dev sibling services | Per Initializr. `mvn spring-boot:run` auto-starts containers declared in `compose.yaml` (postgres, neo4j, embedder); no separate `docker compose up` step. | 2026-05-07 |
| D13 | GraalVM native-image build available (`native-maven-plugin` wired); JVM image is v1 default | Native gives ~50MB images + sub-second startup but adds reflection config burden. JVM until module surfaces stabilize, then optionally flip. | 2026-05-07 |
| D14 | Spring MVC (servlet) over WebFlux; virtual threads enabled (`spring.threads.virtual.enabled=true`) | Java 25 virtual threads provide reactive's concurrency benefits at the servlet API — blocking JDBC/Neo4j calls park virtual threads, no kernel-thread cost. Avoids reactive's debugging tax (Mono/Flux stack traces) and library friction (Flyway, multipart, R2DBC immaturity). Hot paths (catalog CRUD, SSE for progress) are I/O-bound but not high-QPS — the workload doesn't justify reactive's overhead. Per-Initializr `spring-boot-starter-webmvc` ratifies this. | 2026-05-07 |
| D15 | Embedded Postgres (zonky `embedded-postgres:2.1.0`) for local dev; external Postgres (env var) for production | Single artifact runs in three modes via Spring Boot's auto-config priority: explicit `SPRING_DATASOURCE_URL` env var → docker-compose-detected `postgres` service → zonky embedded fallback. Eliminates Docker-required local dev (zonky downloads + spawns native Postgres binary as a JVM child process). Real Postgres dialect (Postgres 17.5 binary), no H2/embedded-DB drift. Multi-tenant + horizontal-scale concerns at v2+ are addressed by switching off embedded via env var; no code change. Implementation: `core/config/EmbeddedPostgresConfig` with `@ConditionalOnMissingBean(DataSource.class)`. | 2026-05-07 |
| D20 | Controlplane Docker image bundles the Bun runtime; ingestion CLI ships as TS source, not a pre-compiled binary | The context module's ingestion path spawns `@ecruz165/context-loader-cli` (`agentx-load`, a Bun CLI) per `prd-context-module.md` D1. Bundling Bun into the JVM image rather than pre-compiling via `bun build --compile` keeps CLI updates simple (TS source change, no image rebuild), prepares for future Bun-based tooling, and avoids the per-platform binary maintenance overhead. Multi-stage Dockerfile work lands at Phase 7. | 2026-05-08 |
| D16 | Backend-first phase ordering: Web UI (formerly Phase 5) deferred to Phase 6, after Intent module | All six domain modules complete + REST/SSE/gRPC surface stable before any UI code is written. Avoids multiplicative cost of UI churn against a moving backend. Intent module belongs in the backend block because its core machinery is server-side (session manager + event consumer); the chat UI is one of several Intent surfaces, not its definition. | 2026-05-07 |
| D17 | JDBI v3 over Spring Data JPA for the DAO layer | Explicit SQL with parameter binding beats ORM magic for state-machine-heavy workloads (Job module, dispatch queue) where query plans + performance matter; multi-tenant `WHERE org_id = :orgId` injection cleaner than JPA `@Filter`; faster startup; no `LazyInitializationException` class of bug; smaller dependency surface. Modulith eventing uses the JDBC variant (`spring-modulith-starter-jdbc`) to match. JDBI's Jackson plugin handles JSONB ↔ Java object conversion at the DAO boundary. | 2026-05-07 |
| D18 | MapStruct for DTO ↔ domain object mapping | Compile-time annotation processor generates the mapper implementation, eliminating hand-written `from()` / `toDomain()` boilerplate. Spring-injected (`componentModel = "spring"`). Type-safe — adding a field to a DTO without updating the mapper is a compile error. Avoids reflection-based mapping libraries (ModelMapper, Dozer) that fail at runtime when shapes drift. | 2026-05-07 |
| D19 | Strict layering: records-for-DTOs, `*DTO` suffix, no logic in controllers, services take domain types | Controllers are HTTP-edge code only (4 lines: parse DTO, optionally read TenantContext, call service, wrap result). DTOs (records named `*DTO`) live at the controller boundary; conversion to/from domain happens via MapStruct mappers. Service signatures take primitives or domain records — never `*DTO` types. Keeps services reusable from non-HTTP callers (CLI, scheduled jobs) and unit-testable without HTTP/JSON ceremony. Captured in `feedback_controller_service_layering.md` + `feedback_dto_conventions.md`. | 2026-05-07 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 0 — skeleton** | Extract Initializr zip into `controlplane/`; add JPA + Postgres driver + Modulith JPA event publication + embedded Postgres (zonky); create empty packages for the 6 closed modules; populate `compose.yaml` with neo4j; dev-mode `TenantContext` (populated from `X-Org-Id` header); first Modulith verification test passing. **No auth, no Actuator, no OpenTelemetry — all deferred to Phase 7.** ✓ Complete (2026-05-07). |
| **Phase 1 — Catalog** | catalog module: Pipelines + Agents + Skills CRUD; expose `loadCatalog()`-equivalent REST endpoint that TS harnesses can poll |
| **Phase 2 — Harness + Dispatch** | harness module: registration + heartbeat. dispatch module: round-robin routing |
| **Phase 3 — Job module** | Server-side pipeline execution with DAG types from harness-core; harnesses become stateless step executors |
| **Phase 4 — Context module** | Central RAG with org-wide content; agents query both edge + central |
| **Phase 5 — Intent module** | Conversational intake via JobDefinitionPipelines; user-in-the-loop intent narrowing; auto-pipeline-creation via `pipeline-architect` (with admin approval gate). Backend-only at this phase — chat UI lands at Phase 6. |
| **Phase 6 — Web UI integration** | Browser app for catalog management, live job monitoring, intent chat surface, operator views (harness fleet, dispatch decisions, audit). Built against a stable OpenAPI surface — every domain module is feature-complete by this point. |
| **Phase 7 — Operational hardening (deferred to last)** | See `2026-05-07-prd-control-plane-operational-hardening.md` for full spec. Adds: SSL/TLS, OAuth/OIDC user auth + PATs, harness API token (mTLS as v2+ upgrade), Spring Boot Actuator (health + metrics + Prometheus), structured JSON logging, OpenTelemetry instrumentation, Datadog integration via DD Agent's OTLP receiver. Decomposed into sub-phases 7a–7g. Each item is *additive* — no domain-module restructure required. |

**Backend-first ordering rationale (D16).** Phases 1-5 are all server-side modules; Phase 6 is the only UI phase. This lets all REST/SSE/gRPC endpoints land + stabilize before any client code is written, avoiding the multiplicative cost of UI churn against a moving backend. Each backend phase is independently verifiable (REST + Modulith verification + integration tests) without UI scaffolding.

Phases 1-2 unblock initial value (centralized catalog). Phase 3 is the big lift (state machine semantics). Phase 4 rounds out the data tier. Phase 5 unlocks the conversational tier. Phase 6 puts a face on it. Phase 7 makes it deployable. Phase 7 is the operational hardening required before any production-shaped deployment — explicitly deferred so feature work isn't blocked on deployment plumbing.
