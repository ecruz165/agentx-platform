# Control Plane Operational Hardening (SSL/TLS + Auth + Actuator + OpenTelemetry + Datadog) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold; this PRD lands as Phase 7 of the control plane build
**Module package(s) affected:** `com.jefelabs.agentx.controlplane.core` (most additions); minor touches in `com.jefelabs.agentx.controlplane.harness`
**Companion documents:**
- `2026-05-07-prd-control-plane.md` — umbrella; Phase 7 references this PRD
- `2026-05-07-prd-core-module.md` — owns the cross-cutting types (`TenantContext`, `AuditPublisher`); this PRD adds the *populators* and *exporters*
- `2026-05-07-prd-harness-module.md` — harness auth (registration token, mTLS v2)
- `2026-05-07-prd-control-plane-web-ui.md` — browser auth flow (OIDC redirect handler)

---

## 1. Purpose

This PRD defines the **operational layer** that gets added to the control plane at Phase 7 — *after* every domain module is feature-complete. Four concerns, one PRD:

1. **SSL / TLS** — HTTPS on the public surface (Spring server SSL OR reverse-proxy termination). HSTS, secure cookies, cert source documented per deployment substrate.
2. **Auth** — OAuth/OIDC for users (browser flow + bearer token), Personal Access Tokens for programmatic clients, API token at harness registration with mTLS as the v2+ upgrade path.
3. **Health & metrics** — Spring Boot Actuator endpoints, Prometheus exposition, structured JSON logging.
4. **Observability vendor integration** — OpenTelemetry as the instrumentation standard, exported to **Datadog** via the DD Agent's OTLP receiver. Logs and traces correlated. Continuous profiling optional.

These concerns are deliberately deferred to last because:
- They are *operational*, not functional — the system can be developed and validated locally without any of them.
- They are *additive* against well-defined cross-cutting hooks already established in `core` (`TenantContext`, `AuditPublisher`, request filters, `EventEnvelope`).
- They have *vendor + IdP choices* that benefit from being made once the system's actual traffic and team shape are visible.

The deferral is enabled by a discipline: every domain module reads `TenantContext.current()` and emits audit events via `AuditPublisher` from day one, both with dev-mode implementations in `core`. Phase 7 swaps the implementations *under the modules*; module code does not change.

## 2. Goals (v1)

- **OAuth/OIDC for users, IdP-agnostic.** Configurable IdP (Okta, Auth0, Cognito, Keycloak, Google Workspace, GitHub). Login redirects, JWT-based access tokens, logout flow.
- **Harness API token at registration.** Token minted by CP on `POST /api/registry/harnesses`; carried in `Authorization: Bearer …` on all subsequent harness→CP calls; refreshed on heartbeat.
- **Harness mTLS available as v2 upgrade.** Same auth boundary, stronger identity. Optional in v1 (API token is sufficient for typical deployments).
- **TLS on the public surface.** HTTPS on 8443 (Spring server SSL config) OR HTTP behind a TLS-terminating reverse proxy (nginx). Both supported via configuration.
- **Standard health + metrics envelope.** Actuator endpoints (`/actuator/health`, `/actuator/health/readiness`, `/actuator/prometheus`, `/actuator/info`, `/actuator/loggers`); secured to admin role only.
- **OpenTelemetry-instrumented.** Spring MVC, JDBC, Neo4j driver, outbound HTTP — all auto-instrumented. Module boundaries surface as named spans. W3C Trace Context propagation.
- **Datadog integration.** Traces + metrics + logs flow through the DD Agent. Trace ↔ log correlation via injected `dd.trace_id` / `dd.span_id`. Tag conventions: `env`, `service`, `version`, `org_id`, `module`.
- **Structured JSON logging.** `logstash-logback-encoder` (or equivalent); request_id, trace_id, span_id, org_id, user_id in MDC; stdout only.
- **Tenant context preservation.** Auth-driven `TenantContext` populator replaces the dev-mode `X-Org-Id` filter; domain modules unchanged.

## 3. Non-Goals (v1)

- **No custom auth framework.** Spring Security primitives only; no rolled-our-own JWT issuer, no custom OAuth grants.
- **No on-prem Datadog.** Targeting Datadog cloud (US1/EU1/etc.); on-prem deployments substitute their own OTLP destination via config.
- **No RUM (Real User Monitoring) for the Web UI in v1.** Trace from server-side only; DD RUM is v1.x once the UI is stable.
- **No vendor lock at the instrumentation layer.** Code uses OTel SDK + Spring's Micrometer Tracing bridge; *only* the export endpoint is Datadog-specific. Swapping vendors = swapping `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **No SLO automation in v1.** Datadog SLO/Monitor configuration is operator-defined in DD; not pushed from this app.
- **No fine-grained per-method authorization annotations everywhere.** Authority enum + `@PreAuthorize` on controller-level endpoints only; module-internal beans trust the security context.
- **No multi-IdP simultaneously.** Single IdP per deployment via config; multi-IdP is v2+ if multi-tenant deployments need it.
- **No client SDK for OAuth (the IdP is the SDK).** Spring's OAuth2 client handles the dance; we configure the client, not the protocol.

## 4. Reference & Provenance

- Spring Boot 4 + Spring Security 6 reference: https://docs.spring.io/spring-security/reference/
- Spring Boot OpenTelemetry support via Micrometer Tracing: https://docs.spring.io/spring-boot/reference/actuator/tracing.html
- OpenTelemetry Java auto-instrumentation: https://opentelemetry.io/docs/zero-code/java/agent/
- Datadog OTLP ingestion via Agent: https://docs.datadoghq.com/opentelemetry/setup/intake/otlp_ingest/
- Datadog Java APM (alternative path): https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/java/
- The harness auth model is consistent with the existing `prd-harness-module.md` F1–F11 (registration + heartbeat) — this PRD adds the *enforcement* layer that makes the existing token mandatory.
- The `TenantContext` populator pattern follows the recipe in `prd-core-module.md` F13: a request filter populates it; this PRD swaps the filter implementation.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Daisy (developer)** | Click "Login with Google/Okta," land in the Web UI, stay logged in across browser refreshes, log out cleanly. |
| **Owen (operator/SRE)** | "Show me a flame graph of the slowest job, end-to-end across modules and harnesses; show me the log lines correlated with that trace; alert me if p95 latency on `/api/jobs/submit` exceeds 500ms." |
| **Iris (catalog admin)** | Audit log shows *which user* edited each pipeline (auth context propagated to `AuditPublisher`). |
| **Pat (auditor)** | "Confirm every persisted query is scoped to the calling principal's org_id. Show me a rejected cross-org access attempt." |
| **Security reviewer** | "Document the auth flow end-to-end: browser → IdP → CP → harness. What signs each token? Where are secrets stored? What's the rotation policy?" |
| **Platform engineer** | Deploy a Datadog Agent sidecar (or DaemonSet) that picks up CP traces/metrics/logs without code changes; tweak retention; configure SLOs in DD. |

## 6. Functional Requirements

### 6.1 User authentication (OAuth/OIDC)

| ID | Requirement |
|---|---|
| F1 | `spring-boot-starter-oauth2-client` (browser flow) + `spring-boot-starter-oauth2-resource-server` (token validation) wired in `core`. |
| F2 | IdP configuration via `application.yml`: `spring.security.oauth2.client.registration.<provider>` + `provider.<provider>` blocks. Default IdP is configurable; ships examples for Google, Okta, Auth0, Cognito, Keycloak, GitHub. |
| F3 | Login redirect flow: browser hits `/`, Spring redirects to IdP, IdP redirects back to `/login/oauth2/code/<provider>`, Spring exchanges code for tokens, sets httpOnly session cookie, redirects to original URL. |
| F4 | Logout flow: `POST /logout` invalidates session + IdP RP-initiated logout (where supported) via `OidcClientInitiatedLogoutSuccessHandler`. |
| F5 | Tokens: short-lived access token (1h default) + refresh token via OIDC; refresh handled silently on next request. |
| F6 | Web UI consumes session cookie automatically (same origin); no manual token wrangling in browser code. |
| F7 | Programmatic clients (CLI, CI bot) authenticate via *Personal Access Token* (PAT) — minted via Web UI, presented as `Authorization: Bearer <PAT>`. PATs are first-class entities in core: `personal_access_tokens` table with org_id + user_id + scope + expires_at. |
| F8 | Authority mapping: IdP claims → internal `Authority` enum. Mapping rules in `application.yml` (e.g., IdP group `catalog-admins` → `catalog:write`). v1 ships sensible defaults; v1.x adds per-org override. |

### 6.2 Tenant context (auth-driven population)

| ID | Requirement |
|---|---|
| F9 | A new `OAuth2TenantContextPopulator` filter reads `Authentication.principal` and populates `TenantContext` with `{org_id, user_id, product_id?}` derived from claims. Replaces the Phase 0 dev-mode `X-Org-Id` populator. |
| F10 | Org claim resolution rules: IdP "groups" / "orgs" / custom claim mapped via configurable Spring Expression Language (SpEL). Default: `principal.attributes['https://agentx/org_id']`. |
| F11 | Multiple-org users: if an authenticated user belongs to N orgs, `?org=<id>` query param disambiguates. Without param, default to `primary_org` (per-user setting). |
| F12 | Domain modules continue to call `TenantContext.current()` exactly as in Phases 0-6. Zero module-code changes. |
| F13 | Audit log entries (`AuditPublisher`) automatically gain `actor_user_id` from the populated context — no per-emit code change. |

### 6.3 Harness authentication (API token + mTLS upgrade path)

| ID | Requirement |
|---|---|
| F14 | Harness registration (`POST /api/registry/harnesses`) requires either a one-time bootstrap token (provisioned out-of-band by an operator) OR a valid mTLS client cert. Returns a long-lived `harness_session_token`. |
| F15 | All subsequent harness→CP calls present `Authorization: Bearer <harness_session_token>`. Spring Security filter validates token signature + lookup + org binding. |
| F16 | Token rotation: refreshed on every heartbeat (sliding 1h expiry). If a heartbeat misses the rotation window, harness must re-register. |
| F17 | Token revocation: `DELETE /api/registry/harnesses/{id}` (operator action) immediately invalidates the token. CP → harness RPC channel still terminates gracefully. |
| F18 | mTLS v2 upgrade path: `application.yml` flag `agentx.harness.auth.require-mtls=true` switches enforcement to client cert validation; bootstrap token path becomes unavailable. Harnesses obtain certs via cert-manager (k8s) / AWS ACM PCA / Vault PKI. Same `harness_session_token` is still issued; the *bootstrap* mechanism changed, not the runtime mechanism. |

### 6.4 TLS / HTTPS

| ID | Requirement |
|---|---|
| F19 | Two configuration paths, both supported via `application.yml`: |
| F19a | **In-process TLS** (`server.ssl.enabled=true`, `server.port=8443`, keystore via `server.ssl.key-store`). Spring terminates TLS itself. Suitable for direct deployments. |
| F19b | **Reverse proxy TLS** (`server.port=8080`, no SSL config; nginx/ALB sidecar terminates TLS, forwards `X-Forwarded-Proto` + `X-Forwarded-For`). Suitable for k8s/ECS where the platform manages certs. |
| F20 | Cert source: Vault-issued (preferred), AWS ACM PCA, cert-manager (k8s), self-signed (local dev only). Out-of-scope: how the cert *gets there* — operator's deployment substrate handles it. |
| F21 | HSTS, secure cookies, redirect HTTP→HTTPS — all on by default when TLS is enabled. |

### 6.5 Spring Boot Actuator

| ID | Requirement |
|---|---|
| F22 | `spring-boot-starter-actuator` added to `core/pom.xml`. |
| F23 | Endpoints exposed: `health`, `info`, `prometheus` (via `micrometer-registry-prometheus`), `loggers`, `threaddump`, `heapdump`, `metrics`. |
| F24 | Endpoints secured: `health` is public (used by load balancer probes); all others require `actuator:read` authority (or `actuator:write` for `loggers` POST). |
| F25 | `/actuator/health` includes liveness; `/actuator/health/readiness` waits for Postgres + Neo4j connectivity. Spring Boot's auto-configured indicators handle both DBs. |
| F26 | `/actuator/info` includes git commit SHA, build timestamp, Spring Modulith canvas summary (number of modules, names). Build-time injection via `org.springframework.boot:spring-boot-maven-plugin` `build-info` goal. |
| F27 | `/actuator/prometheus` is the *primary* metrics surface — DD Agent scrapes it OR Micrometer publishes via OTLP (see §6.6). Both paths supported; choose per-deployment. |

### 6.6 OpenTelemetry instrumentation

| ID | Requirement |
|---|---|
| F28 | Dependencies: `spring-boot-starter-actuator` (for Micrometer), `io.micrometer:micrometer-tracing-bridge-otel`, `io.opentelemetry:opentelemetry-exporter-otlp`. (Spring Boot 4 wires these via auto-config when present.) |
| F29 | Auto-instrumentation applies to: Spring MVC controllers, JDBC (`DataSourceProxy`), Neo4j driver (via OTel Neo4j instrumentation), outbound HTTP clients (`RestClient`/`WebClient`). |
| F30 | Custom spans at module boundaries: `@ApplicationModuleListener` invocations, REST controller methods (auto), critical service methods annotated with `@Observed`. |
| F31 | W3C Trace Context propagation across HTTP and (when added) gRPC. Harness ↔ CP RPCs include `traceparent` headers; harness-side TS code participates via the OTel JS SDK (deferred — TS-side OTel is its own scope). |
| F32 | Span attributes: `service.name=controlplane`, `service.version=<git-sha>`, `module=<package-leaf>` (`catalog`, `job`, etc.), `org_id=<TenantContext.orgId>`, `user_id=<TenantContext.userId>`, `job_id` / `step_id` / `harness_id` where applicable. |
| F33 | Trace ID format: W3C-standard 128-bit hex. Datadog converts internally to its 64-bit format; both round-trip correctly via `dd.trace_id` extraction. |
| F34 | Sampling: head-based sampler at 100% in dev, 10% in staging, 5% in prod (configurable). DD Agent does tail-based sampling for retain-all-error-traces semantics. |
| F35 | Exporter target: `otel.exporter.otlp.endpoint=http://localhost:4317` (DD Agent's OTLP gRPC receiver) by default; configurable for any OTLP destination. |

### 6.7 Datadog integration

| ID | Requirement |
|---|---|
| F36 | Datadog Agent runs as a sibling container (docker-compose), DaemonSet (k8s), or sidecar (ECS Fargate). Always reachable at a known endpoint (`localhost:4317` for OTLP, `localhost:8125` for DogStatsD). Agent config out-of-scope for this PRD; operator's deployment substrate. |
| F37 | DD Agent OTLP receiver enabled (Agent config `otlp_config.receiver.protocols.grpc.endpoint=0.0.0.0:4317`). All traces + metrics flow through it. |
| F38 | DD-specific span tags injected via `OTEL_RESOURCE_ATTRIBUTES`: `deployment.environment=<env>`, `service=controlplane`, `version=<git-sha>`. Datadog's APM service catalog auto-populates from these. |
| F39 | Log forwarding: DD Agent tails container stdout/stderr; logs are JSON-structured (per §6.8) so DD parses fields automatically. `dd.trace_id` and `dd.span_id` injected into log MDC by Spring's `OtelLoggingContextSupplier` → enables trace ↔ log correlation in the DD UI. |
| F40 | DD-specific dashboards / monitors / SLOs are operator-defined in Datadog; this PRD does not push DD config from app code. |
| F41 | Continuous profiling (optional, recommended): Datadog Java profiler attached as JVM agent (`-javaagent:dd-java-agent.jar` with `dd.profiling.enabled=true`). Adds JFR-based CPU/heap profiles to APM. v1: enabled in staging; opt-in for prod. |
| F42 | Cost guardrails: log volume capped at retention + sampling configurable in DD; trace ingest bounded by app-side sampler (F34) + DD-side intake quota. Operator monitors DD bill via DD's own metering. |

#### 6.7a Alternative path: dd-java-agent (vendor SDK)

| ID | Requirement |
|---|---|
| F43 | If OTel + OTLP path is infeasible (e.g., legacy DD deployment without OTLP receiver), `dd-java-agent.jar` can replace it: attach as `-javaagent`, set `dd.service=controlplane`, `dd.env=<env>`, `dd.version=<sha>`. Auto-instruments the same surfaces; emits DD wire format directly. |
| F44 | Trade-offs documented in Decisions Log: vendor lock vs. simplicity. v1 default is OTel + OTLP; switch to dd-java-agent only if the OTel path proves brittle on Spring Boot 4 + Java 25 (revisit at Phase 7 kickoff). |

### 6.8 Structured logging

| ID | Requirement |
|---|---|
| F45 | Replace default Spring Boot console logging with `net.logstash.logback:logstash-logback-encoder` (or `co.elastic.logging:logback-ecs-encoder` if ECS format preferred). |
| F46 | `logback-spring.xml` in `core` declares the encoder; emits one JSON object per line on stdout. |
| F47 | Standard fields: `@timestamp`, `level`, `logger`, `message`, `thread`, plus MDC: `request_id`, `trace_id`, `span_id`, `org_id`, `user_id`. |
| F48 | Application events (e.g., `JobStateTransition`, `CatalogChangedEvent`) emit structured log lines via `logger.atInfo().addKeyValue("event", "JobStateTransition").addKeyValue("from", ...).addKeyValue("to", ...).log()` — DD parses these as searchable attributes. |
| F49 | Stack traces serialized with full class/line context; nested causes preserved. |
| F50 | No log files on disk by default; container stdout is the only sink. (DD Agent / k8s log collector handles persistence.) |

## 7. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Web UI                                                      │   │
│  │  • OIDC redirect-driven login                                │   │
│  │  • httpOnly session cookie                                   │   │
│  │  • Authorization header for AJAX (bearer access token)       │   │
│  └────────────────┬─────────────────────────────────────────────┘   │
└───────────────────┼──────────────────────────────────────────────────┘
                    │ HTTPS (F19)
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Control Plane (Spring Boot Modulith)                                │
│                                                                      │
│  Spring Security filter chain                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 1. CSRF / CORS                                              │   │
│  │ 2. OAuth2 resource-server (validates JWT or session)        │   │
│  │ 3. OAuth2TenantContextPopulator (sets TenantContext.current)│   │
│  │ 4. Method-level @PreAuthorize on controllers                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Domain modules (catalog, context, intent, job, harness, dispatch)   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Read TenantContext.current() — unchanged from Phase 0        │   │
│  │ Emit AuditEvents — gain actor_user_id automatically          │   │
│  │ Emit OTel spans (auto-instrumented + @Observed)              │   │
│  │ Log via SLF4J — JSON encoder writes structured stdout        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Actuator (F22-F27)                                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ /actuator/health (public)                                    │   │
│  │ /actuator/prometheus (admin)                                 │   │
│  │ /actuator/loggers (admin)                                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└───────────────────┬─────────────────────────────────────────────────┘
                    │ OTLP gRPC :4317     │ stdout JSON       │ Bearer token
                    ▼                     ▼                   ▼
┌──────────────────────────────────┐  ┌──────────────────┐  ┌─────────────┐
│  Datadog Agent                   │  │ Container log    │  │ harness-srvr│
│  (sidecar / DaemonSet)           │  │ collector        │  │ (TS)        │
│  • OTLP receiver                 │  │ (DD Agent or k8s)│  │             │
│  • DogStatsD                     │  │  → Datadog logs  │  │ • mTLS-cert │
│  • Log tailer                    │  │                  │  │ OR API token│
│  • Profiling agent (optional)    │  └──────────────────┘  └─────────────┘
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│  Datadog cloud                   │
│  • APM (traces, profiling)       │
│  • Logs (correlated via trace_id)│
│  • Metrics                       │
│  • SLOs, monitors, dashboards    │
│  (operator-defined in DD UI)     │
└──────────────────────────────────┘
```

## 8. Open Questions

1. **OTel + OTLP vs `dd-java-agent`:** v1 default is OTel + OTLP for vendor portability. If Boot 4 + Java 25 + OTel auto-instrumentation has gaps at Phase 7 kickoff (early adopter risk), fall back to `dd-java-agent`. Decide at Phase 7 start with a 1-day spike.
2. **Per-org IdP federation:** v1 is single-IdP-per-deployment. If real customers want their own IdP (multi-tenant SaaS pattern), add per-org `IdpConfig` table + dynamic Spring Security registration lookup. v1.x scope.
3. **PAT scope granularity:** v1 PATs carry the user's full authorities. Scoped tokens (`scope: catalog:read,jobs:submit`) is more secure but heavier UX. Defer to v1.x once usage shows demand.
4. **Harness mTLS rollout timing:** API token is the v1 default. mTLS adds operational complexity (cert distribution + rotation). Trigger for the upgrade: a customer with compliance requirements (SOC2/HIPAA/etc.) explicitly asks for cert-based auth.
5. **Log volume / cost:** structured JSON + every-request MDC fields can produce a lot of log data. Sampling at the encoder layer? Per-logger filters? Default: ERROR + WARN always; INFO sampled at 10% under sustained load. v1 ships unsampled INFO; revisit when DD bill warrants.
6. **DD APM service map vs Modulith canvas:** Datadog's APM service map shows runtime call topology; Spring Modulith's canvas (`ApplicationModules.toJson()`) shows compile-time module topology. They're complementary; worth publishing both as build artifacts and surfacing the canvas in `/actuator/info`.
7. **Where does PAT issuance live?** Web UI surface for "create token, copy once" — UI module's territory but auth-adjacent. Recommend: Web UI hosts the page; this PRD's `core.security.PersonalAccessTokenService` handles persistence. PAT pages added in Phase 5 (Web UI integration) but locked behind feature flag until Phase 7 lands.
8. **Profiling in production:** DD continuous profiler costs CPU (~1-2% overhead) + ingest. v1: enable in staging; opt-in flag for prod. Revisit when prod traffic warrants.
9. **Trace context propagation TS↔Java:** Java-side OTel propagates W3C `traceparent` automatically. TS-side `harness-server` needs the OTel JS SDK to participate. Adding TS instrumentation is its own follow-up — track separately from this PRD.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | OAuth/OIDC for users (not custom auth) | Standard, IdP-agnostic, Spring Boot first-class. | 2026-05-07 |
| D2 | API token first, mTLS as v2 upgrade for harness auth | API token is simpler to provision; mTLS is heavier but more secure. Provide both, default to API token. | 2026-05-07 |
| D3 | OpenTelemetry + OTLP export to DD Agent (not `dd-java-agent`) | Vendor-portable instrumentation. Code uses OTel SDK; only the export endpoint is DD-specific. | 2026-05-07 |
| D4 | Personal Access Tokens for programmatic clients (not OAuth client-credentials grant) | Simpler UX (UI mints token, copy-paste); no IdP-side client registration burden per CLI user. | 2026-05-07 |
| D5 | Tenant context populator is the only auth-adjacent code that changes between Phase 0 and Phase 7 | Keeps domain modules unaware of auth state across phases. | 2026-05-07 |
| D6 | Authority enum + `@PreAuthorize` on controllers (not method-level annotations everywhere) | Module internals trust the security context; controller is the auth boundary. | 2026-05-07 |
| D7 | Structured JSON logging (logstash-logback-encoder), stdout-only | DD-friendly out of the box; no log file management. | 2026-05-07 |
| D8 | DD continuous profiler enabled in staging by default; opt-in for prod | Profiling is high-signal but non-zero-cost; staging is the safe canary. | 2026-05-07 |
| D9 | TLS terminated by Spring OR by reverse proxy — both supported via config | k8s/ECS deployments terminate at platform; bare-metal terminates in Spring. | 2026-05-07 |

## 10. Phased delivery (within Phase 7 of the umbrella)

This PRD itself decomposes into sub-phases since the integration is large enough to land incrementally:

| Sub-phase | Scope |
|---|---|
| **7a — Actuator + structured logging** | `spring-boot-starter-actuator`, `logstash-logback-encoder`, `logback-spring.xml` with JSON encoder, MDC propagation. No auth yet — Actuator endpoints temporarily open. Establishes the observability surface so subsequent sub-phases can verify behavior. |
| **7b — User auth (OAuth/OIDC)** | OAuth2 client + resource-server, IdP config (default: a single chosen IdP), login/logout flows, PAT issuance, swap dev-mode `TenantContext` populator for OAuth-driven. Actuator endpoints now secured. |
| **7c — Harness auth (API token)** | Token issuance at registration, Spring Security filter for harness routes, token rotation, revocation. |
| **7d — TLS** | HTTPS enabled (in-process or proxy mode); HSTS + secure cookies; cert source documented per deployment substrate. |
| **7e — OpenTelemetry + Datadog** | Micrometer Tracing bridge + OTel exporter, OTLP to DD Agent, span attributes, sampling, log↔trace correlation. DD Agent placement documented but operator-deployed. |
| **7f — Continuous profiling (opt-in)** | DD Java profiler attached in staging; opt-in flag for prod. |
| **7g — Harness mTLS (v2 upgrade path)** | Optional — only when a deployment explicitly requires it. Same auth boundary, different bootstrap. |

Each sub-phase is independently shippable; deployments can stop after 7a (just observability) or 7c (auth + observability) without 7d-7g if those don't apply. The umbrella's Phase 7 is "all of 7a-7e land; 7f-7g defer to demand."
