# Catalog Service (Spring Modulith module) — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-06-prd-job-state-machine.md` — consumer of catalog (reads pipelines + agents at job start)
- `2026-05-06-prd-context-schema-package.md` — schema for context-graph entities
- `2026-04-30-prd-harness-core.md` — TS-side equivalent types (`Catalog`, `PipelineDef`, `AgentDef`, `ProductDef`)
- `packages/harness-core/src/catalog.ts` — TS-side implementation (canonical type shapes)

---

## 1. Purpose

The Catalog module is the **system of record** for what pipelines, agents, skills, and products exist in a deployment. It owns the truth that everything else reads from: harnesses pull pipeline definitions before running jobs, the JobStateMachine asks the catalog "what are the steps in pipeline X?", the Web UI edits via this module's REST endpoints.

It exists in the control plane (not the data plane) because catalog content is **admin-owned, ecosystem-wide, and write-rare**: a few authors edit it; many consumers read it. Centralizing the source of truth eliminates drift between harness instances and unblocks the multi-tenant model (different orgs see different catalogs).

The TS-side `harness-core` already has the type shapes (`Catalog`, `PipelineDef`, `AgentDef`, etc.). This module mirrors those types in Java/Kotlin and persists them durably.

## 2. Goals (v1)

- **Mirror TS catalog types exactly.** The wire-level contract is what the TS data plane already consumes via `loadCatalog()`. Java types are hand-mirrored or codegen'd from the TS source.
- **CRUD via REST + Web UI.** Authors edit through the Web UI (or REST API directly); changes are validated against the same rules as the TS-side validator.
- **Strong validation.** Same well-formedness rules as `validateCatalog()` in `harness-core` — invalid catalogs cannot be saved.
- **Versioning.** Every catalog edit creates a new version; history queryable. v1 doesn't roll back automatically; rollback is a separate "publish version N" action.
- **Multi-tenant.** Catalogs are per-org; pipelines/agents/skills carry `org_id` and (optionally) `product_id` if they're product-specific.
- **Caching.** Read-heavy workload — catalog content cached in-memory + invalidated on edit.

## 3. Non-Goals (v1)

- **No client-side catalog (workspace-local files) replacement.** TS-side `loadCatalog()` keeps reading `.harness/config/pipelines.json` for offline/local-dev mode. The Spring catalog is *additionally* available; offline mode still works.
- **No automated migration of existing workspace pipelines.** Bringing a workspace's local pipelines.json into the central catalog is a manual import for v1.
- **No fine-grained ACLs in v1.** Anyone with `catalog:write` permission can edit anything in their org. Per-pipeline / per-skill ACLs come later.
- **No catalog templates / inheritance.** Each pipeline is its own document. Composition via the `CallStep` is the v1 reuse mechanism.
- **No GitOps integration.** v1 doesn't watch a git repo for catalog changes. Edit-via-UI/API only. (Could be added as a separate sync layer.)

## 4. Reference & Provenance

- TS-side canonical types: `packages/harness-core/src/catalog.ts` (`Catalog`, `PipelineCatalog`, `PipelineDef`, `AgentDef`, `ProductDef`, `ContextSourceDef`, `ProductRepo`, etc.).
- TS-side validation: `validateCatalog()`, `validateUnifiedCatalog()` — these are the rules the Java validator must mirror.
- The pipeline DAG step kinds are still being finalized (see in-flight work on `PipelineStep` tagged union — agent, phase, loop, fork, map, conditional, retry, timeout, try, approval, call, wait, wait-for-event, transform, fail, succeed). The Java types must follow whatever lands.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Iris (catalog admin)** | Create new pipelines, edit agent system prompts, declare products, register skills. All via Web UI. |
| **Daisy (developer)** | Read-only consumption: "What pipelines can I run for product X?" |
| **Owen (operator)** | "Show me audit trail of catalog edits this week." |
| **CI/CD pipeline** | Programmatic catalog read (for `harness submit`-equivalent flows) — REST API access. |

## 6. Functional Requirements

### 6.1 Persistence + schema

| ID | Requirement |
|---|---|
| F1 | Postgres tables: `pipelines`, `agents`, `skills`, `products`, `catalog_versions`, `catalog_audit_log`. |
| F2 | Each entity has `org_id` (required), `id` (stable ULID), `version` (monotonic per org+id), `created_at`, `updated_at`, `created_by`, `updated_by`. |
| F3 | Pipeline body stored as JSONB with the `PipelineStep[]` shape from the TS-side type. Validated on insert. |
| F3a | Pipelines have a `kind` field: `'work'` (default — does product work), `'job-definition'` (emits a JobIntent — used by IntentService for intake), `'post-job'` (runs after a job for cleanup/notifications). Reserved for future: `'meta'` (emits a PipelineDef itself, e.g. `pipeline-architect`). |
| F3b | Pipelines have an `output` field (`PipelineOutputContract`) that describes their terminal-step output shape: `agent-text` (default for `kind: 'work'`), `job-intent` (required for `kind: 'job-definition'`), `job-intents` (fan-out meta-pipelines), `pipeline-spec` (for `pipeline-architect`-style spec emitters), `structured` with explicit JSON Schema. |
| F4 | Skills are normalized: separate tables for `skill_tools`, `skill_integrations`, `skill_tasks`, `skill_workflows`. Each has `slug`, `description`, `metadata`. |
| F5 | Agents reference skills via JSONB `skillz` field; FK constraints not enforced at DB level (TS catalog allows referencing not-yet-installed skills per existing convention). |
| F6 | Products have FK to repos array (JSONB) and `contextSources` (JSONB). |
| F7 | Flyway migrations versioned in `src/main/resources/db/migration/V<N>__<desc>.sql`. |

### 6.2 REST API

| ID | Requirement |
|---|---|
| F8 | `GET /api/catalog/pipelines` — list pipelines for current org. Pagination, filtering. |
| F9 | `GET /api/catalog/pipelines/{id}` — fetch single pipeline. |
| F10 | `POST /api/catalog/pipelines` — create pipeline. Validation must pass. |
| F11 | `PUT /api/catalog/pipelines/{id}` — update pipeline (creates new version). |
| F12 | `DELETE /api/catalog/pipelines/{id}` — soft-delete (sets `deleted_at`); pipeline kept for audit. |
| F13 | Same shape for agents, skills, products. |
| F14 | `POST /api/catalog/validate` — preflight validate a payload without saving. Returns the list of validation errors. |
| F15 | `GET /api/catalog/full` — returns the entire `Catalog` document (pipelines + products) for the org, suitable for harness consumption via `loadCatalog()` HTTP shim. Supports ETag for cache. |

### 6.3 Validation

| ID | Requirement |
|---|---|
| F16 | Java validator implements the same rules as `validateCatalog()` in `harness-core`. Both must be kept in lockstep — one source of truth (TS) is mirrored. |
| F17 | Validation errors are structured: `{ path: 'pipelines[0].steps[2].body[1].agent.id', message: 'must be non-empty string' }`. UI surfaces them inline. |
| F18 | Pipeline step kinds validated against the locked v1 tagged union: `agent`, `phase`, `loop`, `fork`, `map`, `conditional`, `retry`, `timeout`, `try`, `approval`, `call`, `wait`, `wait-for-event`, `transform`, `fail`, `succeed` (16 kinds). Adding new kinds is additive (consumers using older types just see unknown variant); removing or changing semantics is breaking. |
| F18a | `kind: 'job-definition'` pipelines must declare `output: { kind: 'job-intent' }`; validator rejects `kind: 'job-definition'` with any other output contract. |
| F18b | LoopStep validation: `until` is one of `agent-signal`, `output-matches`, `iteration-limit`, `intent-ready`, `structured-output`. `intent-ready` is sugar for `structured-output` with the JobIntent schema. `conditionEval` defaults to `'after-each-step'`. |
| F18c | ConditionalStep validation: `condition` predicate is one of `output-matches`, `output-equals`, `json-path`, `no-pipeline-matches`, `pipeline-exists`, `intent-ambiguous`. Catalog-aware predicates (`no-pipeline-matches`, etc.) require the runtime to query the catalog at evaluation time. |
| F18d | ForkStep + MapStep validation: `join` is one of `all`, `any`, `n-of-m`. `aggregate` (optional) is one of `array` (default), `concat`, `merge-objects`, `vote`, `pick-best`, `agent`. MapStep `over` is one of `from-input`, `from-product-repos`, `from-step-output`, `static`. |
| F19 | Agent `accepts` field validated as flat array OR named-set Record per existing TS rules. |
| F20 | Skill references validated structurally only (slug shape) — existence in skillzkit is checked at procurement time on the harness side, not here. |

### 6.4 Caching + change events

| ID | Requirement |
|---|---|
| F21 | Read path is cached in-memory (Caffeine or Spring Cache) per org. TTL: 60s with explicit invalidation on edit. |
| F22 | On every catalog mutation, publish a `CatalogChangedEvent` (Spring Modulith event) so dependent modules (JobStateMachine, ContextServer) can invalidate their own caches. |
| F23 | Harnesses that pull catalog over HTTP receive an `ETag`; conditional GET (`If-None-Match`) returns 304 when unchanged. |

### 6.5 Versioning + audit

| ID | Requirement |
|---|---|
| F24 | Every edit creates a new entry in `catalog_versions` with the full prior shape. v1 keeps all history (no garbage collection). |
| F25 | `catalog_audit_log` records: who, when, what changed (diff or full document), reason (optional commit-message-like field). Auto-generated pipelines (created by `pipeline-architect`) tagged with `created_by: 'pipeline-architect'` and `source_intent: '...'` for traceability. |
| F26 | `GET /api/catalog/pipelines/{id}/versions` — list historical versions. |
| F27 | `GET /api/catalog/pipelines/{id}/versions/{n}` — fetch a specific version. |
| F28 | v1: no automatic rollback. v1.x: explicit `POST /api/catalog/pipelines/{id}/revert?to=<version>` action. |

### 6.6 Auto-generated pipelines (Phase 6+)

| ID | Requirement |
|---|---|
| F29 | Programmatic catalog writes by the system (specifically by `pipeline-architect` runs) require an `ApprovalStep` upstream — pipelines aren't saved until a `catalog-admins` approver signs off. The approval gate is part of the JobDefinitionPipeline that triggered creation, not enforced here in Catalog. |
| F30 | The Catalog API `POST /api/catalog/pipelines` accepts a `proposalMode: 'commit' | 'propose'` flag. `'propose'` saves the pipeline in `proposed` status (not yet active); a separate admin action transitions it to `active`. |
| F31 | Catalog introspection skills shipped in default catalog (used by `pipeline-architect` agents): `catalog:list-agents`, `catalog:list-skills`, `catalog:get-step-kinds`, `catalog:list-pipelines`. These let the architect agent know what primitives are available when synthesizing a new pipeline. |
| F32 | Per-org rate limit on auto-generation: max N auto-pipeline-creates per hour (default 10). Prevents runaway agent loops from spamming the catalog. |
| F33 | Auto-generated pipelines are queryable as a filtered set: `GET /api/catalog/pipelines?createdBy=pipeline-architect&status=proposed`. |

## 7. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Catalog module                                                    │
│                                                                    │
│  ┌───────────────────┐  ┌──────────────────────┐  ┌─────────────┐ │
│  │ REST controllers  │  │ Validator            │  │ Cache       │ │
│  │ (CatalogApi)      │──│ (CatalogValidator,   │──│ (per-org    │ │
│  │                   │  │  rules from TS)      │  │  Caffeine)  │ │
│  └─────────┬─────────┘  └──────────┬───────────┘  └─────┬───────┘ │
│            │                       │                    │         │
│            ▼                       ▼                    ▼         │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ Repository (Spring Data JPA / jOOQ) — Postgres tables      │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  Publishes: CatalogChangedEvent — consumed by JobStateMachine     │
│  + Web UI SSE channel.                                             │
└────────────────────────────────────────────────────────────────────┘
```

## 8. Open Questions

1. **Java types: hand-mirror or codegen from TS?** Codegen via `quicktype` or a custom script keeps types in lockstep. Hand-mirror is simpler initially but drifts. Recommend codegen for v1.x once TS types stabilize.
2. **Skill slug uniqueness:** are skill slugs globally unique or per-org? skillzkit's catalog is global, so probably global. But ACLs per-org might mean some skills are visible to some orgs. v1: global slugs, no per-org ACLs.
3. **Skill metadata:** what fields beyond slug + description? skillzkit's catalog has more (tags, owner, version). Mirror that or simplify? Defer until we see real demand.
4. **JSONB vs separate tables:** pipelines stored as JSONB blobs (entire `PipelineStep[]`) or normalized into rows? JSONB is simpler and preserves the tagged union shape; normalization is harder for nested structures. Recommend JSONB.
5. **Migration from local pipelines.json:** v1 manual import via `POST /api/catalog/pipelines` with the JSON body. v1.x might add a `harness catalog import` CLI subcommand. Defer.
6. **Catalog signing / immutability:** for compliance, do we want to sign catalog versions cryptographically so consumers can verify integrity? v2+ if a use case emerges.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Postgres + JSONB for catalog storage | Simpler than full normalization for a write-rare, read-heavy, deeply-nested shape. | 2026-05-06 |
| D2 | Validation rules mirror TS `validateCatalog()` | One source of truth (TS); Java is the consumer. | 2026-05-06 |
| D3 | Org-level multi-tenancy from day one | Future-proof; cheap to add now, expensive later. | 2026-05-06 |
| D4 | All edits versioned + audited | Compliance + debugging. | 2026-05-06 |
| D5 | Skill references not FK-validated at DB level | Mirrors TS convention; allows referencing not-yet-installed skills. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Persistence + REST CRUD for pipelines + agents (read-only paths first) |
| **Phase 2** | Validator implementation; preflight + save-time validation |
| **Phase 3** | Skills + Products CRUD |
| **Phase 4** | Caching + change events + ETag support for harness HTTP polling |
| **Phase 5** | Versioning + audit log + revert action |
