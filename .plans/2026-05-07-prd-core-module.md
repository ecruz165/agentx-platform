# Core Module (Spring Modulith — OPEN) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Module package:** `com.jefelabs.agentx.controlplane.core`
**Module type:** `@ApplicationModule(type = OPEN)` — public types reachable from every other module without explicit dependency declarations
**Companion documents:**
- `2026-05-07-prd-control-plane.md` — umbrella for the Spring Modulith app (this PRD owns the implementation requirements that umbrella references)
- `2026-05-07-prd-catalog-module.md`, `2026-05-07-prd-context-module.md`, `2026-05-07-prd-intent-module.md`, `2026-05-07-prd-job-module.md`, `2026-05-07-prd-harness-module.md`, `2026-05-07-prd-dispatch-module.md` — closed domain modules that depend on the shared kernel + scaffolding owned here

---

## 1. Purpose

The Core module is the **scaffolding + shared kernel** for the control-plane Spring Modulith. Two roles in one module:

1. **Scaffolding**: app entry point (`@SpringBootApplication`), security configuration, persistence/Flyway setup, OpenAPI generation, Actuator endpoints, structured logging, OpenTelemetry tracing, multi-tenant Spring Security context, graceful-shutdown hooks, and the Modulith-verification test harness.
2. **Shared kernel**: cross-cutting types every closed domain module needs — `OrgId`, `ProductId`, `TenantContext`, `JobIntent`, base `AuditableEntity`, common event envelopes — surfaced as the *open* module so domain modules can import them without declaring `core` as an explicit dependency.

Core is *not* a domain module. It owns no business logic. It owns the things that, if they were duplicated in each domain module, would create drift (auth filter, multi-tenant context, base entity) — or, if they were peer-imported across closed modules, would create a tangle of cross-module dependencies that defeats Modulith verification.

## 2. Goals (v1)

- **Single deployable unit.** One Docker image (one JAR), one configuration. Bundled Web UI static assets baked into the image.
- **Spring Modulith boundary verification.** A canonical test class runs `ApplicationModules.of(Application.class).verify()` on every CI run; any module-boundary violation fails the build.
- **Standard ops envelope.** Health checks (`/actuator/health`), metrics (`/actuator/prometheus`), structured JSON logging, OpenAPI spec generated from controllers across all modules.
- **Stateful with durability.** Postgres for relational; Flyway-managed migrations; common conventions for per-module child migrations.
- **Auth + authorization.** OAuth/OIDC for users (Web UI); API tokens or mTLS for harness-to-control-plane traffic; Spring Security context propagated through all module boundaries.
- **Multi-tenant ready.** Every persisted entity carries `org_id` + `product_id`; tenant scope is enforced at the security filter and the JPA/jOOQ query layer (RLS or query interceptors).
- **Shared kernel of truth.** Cross-cutting types live exactly once. Importing `JobIntent` from `core` is the same import in every domain module.

## 3. Non-Goals (v1)

- **No domain logic.** Core does not own catalog content, jobs, harnesses, dispatch decisions, intents, or context. Those live in their respective closed modules.
- **No microservice boundaries.** Core is the scaffolding for the modulith; if/when modules are extracted into services, this PRD doesn't follow them — each becomes its own deployable.
- **No replacement for Spring Security primitives.** Core configures Spring Security; it doesn't write a custom auth framework.
- **No custom event bus.** v1 uses Spring Modulith's in-process event publication. Pluggable transport (Kafka/NATS/Redis Streams) is v2+.
- **No Java/Kotlin polyglot in v1.** Whichever language is chosen for D-J1 (see umbrella PRD §8) is the language for *all* modules; core doesn't try to be language-neutral.
- **No client-SDK generation.** OpenAPI spec is generated; SDKs (TS, Python, Go) are downstream tooling, not core's responsibility.

## 4. Reference & Provenance

- The implementation requirements F1–F13 of the earlier draft of `prd-control-plane.md` are extracted here. The umbrella now references this PRD instead.
- Spring Modulith open-module pattern: https://docs.spring.io/spring-modulith/reference/fundamentals.html#modules.advanced (look for `@ApplicationModule(type = OPEN)`).
- Spring Boot reference for the scaffolding pieces (Actuator, Flyway, OAuth2 Resource Server, OAuth2 Client) — all standard.
- The shared `JobIntent` type is the contract between `intent` (producer) and `job` (consumer); placing it in `core` is the recognized "neutral ground" pattern from DDD-on-Modulith.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Domain-module author** | "I need to declare an entity that's tenant-scoped, audited, and uses standard ULID ids — I import `core.AuditableEntity` and don't reinvent." |
| **Domain-module author** | "I need to publish a `JobIntent`-shaped event from `intent` and consume it in `job` — both modules import `core.JobIntent`; no peer-to-peer dependency between intent and job." |
| **Operator (Owen)** | "I need to verify the running app is healthy, scrape Prometheus metrics, view structured logs in a SIEM, and trace a request across all module boundaries." |
| **Security reviewer** | "I need to confirm that every persisted query is scoped to the calling principal's `org_id` automatically, with no module-level escape hatches." |
| **CI / build engineer** | "I need a single test that fails the build if any module imports another module's internal package — no human review burden." |

## 6. Functional Requirements

### 6.1 Application bootstrap + deployment

| ID | Requirement |
|---|---|
| F1 | Single Docker image containing Spring Boot app + bundled Web UI static assets. Built with Gradle (or Maven); JLink-trimmed runtime for smaller image. |
| F2 | `docker-compose.yml` defines the deployment unit: `spring-app` + `postgres` + `neo4j` + `embedder` + (optional) `nginx` reverse proxy. Same compose works for local dev (uses `localhost`) and small deployments (named hosts). |
| F3 | App exposes HTTPS on a single port (default 8443); HTTP/8080 in dev. Internal modules talk via Spring DI, not HTTP. |
| F4 | Public API surface: REST + Server-Sent Events for streaming progress; gRPC optional v1.x. OpenAPI spec generated from controllers across all modules. |
| F5 | Configuration: 12-factor — env vars and `application.yml` for local dev. Sensitive values via secret manager (AWS Secrets Manager, HashiCorp Vault, env-var fallback). |
| F6 | Graceful shutdown: SIGTERM drains in-flight HTTP, completes in-flight jobs OR persists their state for resume after restart. Hook lives in core; domain modules register `SmartLifecycle` participants. |

### 6.2 Health, metrics, observability

| ID | Requirement |
|---|---|
| F7 | Health endpoints: `/actuator/health` (liveness), `/actuator/health/readiness` (waits for Postgres + Neo4j connectivity). |
| F8 | Metrics: `/actuator/prometheus` exposes app metrics, JVM, HTTP request rates, module-internal events. Each domain module registers its own metrics via `MeterRegistry` injection. |
| F9 | Structured JSON logs (Logback + `logstash-logback-encoder` or equivalent). Request IDs propagated through all module boundaries via MDC. |
| F10 | Distributed tracing via OpenTelemetry; auto-instruments Spring Web + JDBC + Neo4j-driver; module boundaries appear as named spans. |

### 6.3 Authentication + authorization

| ID | Requirement |
|---|---|
| F11 | Users authenticate via OAuth/OIDC (configurable IdP — Okta, Auth0, Cognito, Keycloak). Spring Security OAuth2 Client + Resource Server. |
| F12 | Harnesses authenticate to CP via API token OR mTLS at the registration endpoint; subsequent requests carry a session token (per harness module). Token verification lives in core; harness module declares the authority. |
| F13 | Spring Security context propagates a `TenantContext` (org_id + product_id when applicable + user_id) through all controller invocations. Domain modules read it via `TenantContext.current()`. |
| F14 | Authorization checks against an `Authority` enum that domain modules can extend (`catalog:write`, `job:cancel`, `intent:approve-pipeline`, etc.). |

### 6.4 Persistence + multi-tenancy

| ID | Requirement |
|---|---|
| F15 | Postgres for relational state. Flyway-managed migrations. |
| F16 | Migration convention: parent migrations (Postgres extensions, base tables, RLS setup) live at `core/src/main/resources/db/migration/V0001__core_*.sql`. Each domain module owns child migrations at `<module>/src/main/resources/db/migration/V<NN>__<module>_<desc>.sql`. Flyway applies in numeric order across all locations. |
| F17 | Every domain entity FK-references `org_id` (and `product_id` where applicable). Multi-tenant base class `AuditableEntity` provides: `id` (ULID), `org_id`, `product_id?`, `created_at`, `updated_at`, `created_by`, `updated_by`. |
| F18 | Tenant scope enforced via Postgres RLS policies installed by core's parent migrations + a `TenantAwareDataSource` that sets `app.current_org` per connection. Domain modules inherit enforcement; cannot accidentally bypass. |
| F19 | Audit log primitive (`AuditEvent`) lives in core; domain modules emit audit events via a `core.AuditPublisher` bean. v1 sink: Postgres `audit_events` table. v2+: pluggable to SIEM. |

### 6.5 Modulith verification

| ID | Requirement |
|---|---|
| F20 | A test class `com.jefelabs.agentx.controlplane.core.ModulithVerificationTest` runs `ApplicationModules.of(Application.class).verify()` on every CI run; module boundary violations fail the build. |
| F21 | Each domain module is `@ApplicationModule(type = CLOSED)` (default). `core` is `@ApplicationModule(type = OPEN)`. Allowed cross-module dependencies are declared via `package-info.java` in each module. |
| F22 | The Modulith canvas (`ApplicationModules.toJson()`) is exported as a build artifact; the umbrella PRD's architecture diagram should match it. |
| F23 | Documentation generation: `ApplicationModules.documenting()` produces module-level Asciidoc + PlantUML diagrams; published as part of the build artifacts directory. |

### 6.6 Shared kernel (the OPEN-module surface)

The following types are public from `core` and importable from every domain module without dependency declarations:

| Type | Purpose | Owner |
|---|---|---|
| `OrgId`, `ProductId`, `JobId`, `HarnessId`, `StepId` (value types) | Strongly-typed wrappers around ULID strings | core |
| `TenantContext` | Request-scoped record of org/product/user; populated by Spring Security filter | core |
| `AuditableEntity` (abstract base) | Common columns: id, org_id, product_id, timestamps, actors | core |
| `JobIntent` (record) | `{ pipelineId, productId, input, set?, config? }` — neutral type bridging intent → job | core |
| `JobIntentSubmittedEvent` | Published by `intent` (or any producer); consumed by `job` | core |
| `JobIntentValidationException` | Thrown by job module when an intent fails preflight | core |
| `AuditPublisher` (interface) | Domain modules call this to emit audit events | core |
| `EventEnvelope<T>` | Standard wrapper for cross-module published events: `{ id, type, occurredAt, tenant, payload }` | core |
| `Pageable`, `PageResult<T>` | Pagination primitives used by every module's REST API | core (or rely on Spring Data's) |

| ID | Requirement |
|---|---|
| F24 | All types listed above are `public` in their respective `core.<topic>` packages and have stable serialization (Jackson + JsonSchema generation for OpenAPI). |
| F25 | `JobIntent` is the **only** type both `intent` and `job` modules need to share. No other peer-module imports between domain modules. |
| F26 | `EventEnvelope<T>` is the canonical cross-module event shape; domain modules publish concrete subtypes (`StepReady extends EventEnvelope<StepReadyPayload>`) but never re-implement the envelope. |
| F27 | Adding a new shared kernel type requires updating this PRD + the open-module surface; reviewers verify the addition is genuinely cross-cutting (not domain-leak). |

## 7. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  com.jefelabs.agentx.controlplane                                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  core/  @ApplicationModule(type = OPEN)                    │  │
│  │  ─────                                                     │  │
│  │  • Application.java (@SpringBootApplication)               │  │
│  │  • config/        (Security, Web, JPA, Neo4j, OpenAPI)    │  │
│  │  • tenancy/       (TenantContext, TenantAwareDataSource)  │  │
│  │  • security/      (OAuth2, mTLS, Authority)               │  │
│  │  • types/         (OrgId, ProductId, JobIntent, …)        │  │
│  │  • persistence/   (AuditableEntity, ULID gen, RLS hooks)  │  │
│  │  • audit/         (AuditEvent, AuditPublisher)            │  │
│  │  • events/        (EventEnvelope<T>)                       │  │
│  │  • observability/ (logging, metrics, tracing setup)       │  │
│  │  • verification/  (ModulithVerificationTest)              │  │
│  │  • migrations/    db/migration/V0001__core_*.sql          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│              ▲       ▲       ▲       ▲       ▲       ▲           │
│              │       │       │       │       │       │           │
│         catalog  context  intent   job  harness  dispatch       │
│         (CLOSED) (CLOSED) (CLOSED)(CLOSED)(CLOSED)(CLOSED)      │
│                                                                  │
│   All closed domain modules import core types freely             │
│   (open-module rule). Domain modules MUST NOT peer-import        │
│   each other except via published EventEnvelope events.          │
└──────────────────────────────────────────────────────────────────┘
```

## 8. Open Questions

1. **JDK version:** Java 21 LTS (virtual threads make per-job-per-thread practical for blocking work) vs Java 17 LTS (broader compat). Recommend 21 for new work. (Echoed from umbrella §8.)
2. **Java vs Kotlin:** Modulith works with both. Kotlin's null-safety + sealed-type ergonomics align with the agent/event shapes. Java has the larger ecosystem story. Decision deferred to first-implementation kickoff. (Echoed from umbrella §8.)
3. **Postgres tenancy: schema-per-tenant or row-level + RLS?** Row-level + RLS in v1; schema-per-tenant adds migration complexity not justified by current scale. (Echoed from umbrella §8.)
4. **OpenAPI generation:** annotation-driven (springdoc) vs contract-first (OpenAPI Generator from a hand-authored spec). Recommend springdoc for v1 (fewer build steps); revisit if API consumers demand a single source-of-truth spec.
5. **Audit log sink:** Postgres in v1; consider event-sourcing approach (separate audit DB or append-only event store) when audit volume justifies.
6. **Web UI build pipeline:** built separately and copied into Spring's `static/` at image-build time, OR built via Spring's webjars plugin? Separate-build is more flexible. (Echoed from umbrella §8.)
7. **Can `core` be split into `core` + `shared-kernel`?** Some Modulith projects split scaffolding (closed) from shared types (open). Worth considering if `core` grows large; v1 keeps them combined for simplicity.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | `core` is `@ApplicationModule(type = OPEN)` | Recognized escape hatch for cross-cutting types; avoids per-module dependency declarations for primitives every module needs. | 2026-05-07 |
| D2 | `JobIntent` lives in `core`, not in `intent` or `job` | Both modules need the type; placing it in either creates an asymmetric peer dependency. Core is neutral ground. | 2026-05-07 |
| D3 | Multi-tenant enforcement via Postgres RLS + `TenantAwareDataSource` | Defense-in-depth: a SQL bug in any domain module cannot leak across orgs. | 2026-05-07 |
| D4 | Flyway migration ownership: parent in core, children per-module | Each module owns its schema; core owns the cross-cutting tables (audit, RLS policies). | 2026-05-07 |
| D5 | OpenTelemetry for distributed tracing | Standard, vendor-neutral; Spring auto-instrumentation is mature. | 2026-05-07 |
| D6 | Modulith verification test runs on every CI | Boundaries enforced at compile time + test time; no review burden. | 2026-05-07 |
| D7 | Implementation requirements consolidated here from umbrella | Single home for "how the app is built"; umbrella is index/architecture only. | 2026-05-07 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 0 — bootstrap** | `Application.java`, security config (OIDC + API token), Postgres + Flyway base migrations, Actuator endpoints, structured logging, OpenAPI generation, empty domain modules, Modulith verification test |
| **Phase 1 — tenancy + audit** | `TenantContext`, `TenantAwareDataSource`, RLS policies, `AuditableEntity` base class, `AuditPublisher` + `audit_events` table |
| **Phase 2 — shared kernel** | `JobIntent`, `EventEnvelope<T>`, value types (`OrgId`, etc.), `Pageable`/`PageResult<T>` |
| **Phase 3 — observability** | OpenTelemetry tracing wired through module boundaries; Prometheus metrics; SIEM-ready log format |
| **Phase 4 — operational polish** | Graceful shutdown lifecycle, secret-manager integration, OpenAPI doc improvements, `ApplicationModules.documenting()` artifact in CI |

Phases 0–1 unblock every domain module's first commit. Phases 2–3 round out cross-cutting concerns. Phase 4 is operational hardening that can lag feature work without blocking it.
