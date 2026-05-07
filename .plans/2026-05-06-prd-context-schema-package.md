# Context Schema Package — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-central-context-server.md` — central consumer (Java)
- `2026-04-30-prd-edge-context-server.md` — edge consumer (TS)
- `2026-05-05-prd-context-loader-core.md` — owns the chunker + graph data shape

---

## 1. Purpose

The Context Schema Package is a **standalone npm package** (likely `@ecruz165/context-loader-schema` or `@ecruz165/context-schema`) containing **versioned Cypher migration files** that define the Neo4j schema used by both the edge and central context servers. It exists because the same schema must be applied to *N+1 Neo4j instances* (one central + one per workspace edge) and drift between them would silently break cross-instance query parity.

Migration files are plain text (`.cypher` files), runnable from any language: TypeScript code reads + executes them via the JS `neo4j-driver`; Java code reads + executes them via `neo4j-driver-java`. Both invoke the *same files*, ensuring identical schemas regardless of which language the runtime is.

This is the **cross-language schema contract** for the project — the boundary that makes "edge and central use the same graph shape" a verifiable property, not just a wish.

## 2. Goals (v1)

- **Versioned, idempotent Cypher migrations.** Standard `V<N>__<description>.cypher` naming. Each migration runs at most once per database; re-running on an up-to-date DB is a no-op.
- **Language-agnostic.** Files are plain Cypher; consumers pick how to apply them (TS via neo4j-driver, Java via Spring Boot's auto-migration framework or explicit code).
- **Tracked migration state.** Standard `:_SchemaMigration` node tracks which migrations have run on each DB, with their hash for tamper detection.
- **One package, two consumers.** Published once to npm; consumed by `@ecruz165/edge-context-server` (TS) and the Spring `central-context-server` module (Java reads the same files via subprocess `npm pack` extraction or a Maven mirror).
- **Schema versioning aligned with `@ecruz165/context-loader-core`.** Both packages co-version: when the chunker changes the graph shape, the schema package gets a corresponding migration in the same release.

## 3. Non-Goals (v1)

- **No migration framework abstraction.** This isn't Liquibase or Flyway-for-Cypher. It's just a directory of `.cypher` files with a thin loader contract. Consumers do their own application.
- **No data migrations (only schema).** Migrating *data* (re-chunking, re-embedding, schema-shape evolution of existing nodes) is out of scope; that's a separate ETL concern.
- **No rollback.** Migrations are forward-only. Reverting requires destroying the DB and re-ingesting, or writing a manual fix migration.
- **No Java Maven artifact.** v1 ships the npm package only; Java consumers extract files at build/runtime. v1.x: also publish to Maven Central as a JAR with `.cypher` resources.
- **No CI integration in v1.** Verifying migrations apply cleanly on a fresh Neo4j is an operator concern; v1 ships smoke tests but no CI gating.

## 4. Reference & Provenance

- Pattern: Flyway, Liquibase, Alembic, golang-migrate — versioned forward-only migrations with state tracking.
- Cypher schema management is less mature than SQL (Neo4j doesn't ship a built-in migration tool). The community pattern is exactly what this package implements: numbered files + a tracking node.
- Schema content (node labels, edge types, vector indexes) is defined by `@ecruz165/context-loader-core`'s `SourceTypeSchema` declarations; this package operationalizes those declarations as runnable migrations.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **`@ecruz165/edge-context-server` (TS)** | "On startup, ensure my workspace's Neo4j has all migrations applied." |
| **Central ContextServer (Java)** | "On startup, ensure central Neo4j has all migrations applied." |
| **Schema author (developer)** | "I'm changing the chunker output. I need to add a new migration that adds the new node label + vector index." |
| **Operator** | "Show me which migrations are applied to which Neo4j instance; flag any drift." |

## 6. Functional Requirements

### 6.1 Package structure

| ID | Requirement |
|---|---|
| F1 | Published as `@ecruz165/context-loader-schema` on npm. |
| F2 | Directory layout: `migrations/V001__init.cypher`, `migrations/V002__add_oss_labels.cypher`, etc. |
| F3 | Filename format: `V<NNN>__<snake_case_description>.cypher`. NNN is monotonically increasing per package version. |
| F4 | Each `.cypher` file is *idempotent* — uses `CREATE CONSTRAINT IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc. |
| F5 | Each migration ends with a `MERGE (m:_SchemaMigration {version: 'V001', hash: '...'})` to record application. |
| F6 | Package also exports a TS module with the migration list (for programmatic consumption from TS). |

### 6.2 Migration content

| ID | Requirement |
|---|---|
| F7 | Migrations cover: node label constraints, relationship type creation, vector indexes, full-text indexes, property indexes. |
| F8 | First migration (`V001__init.cypher`) creates the foundational schema: `:File`, `:Function`, `:Class`, `:Doc`, `:Section` labels with their constraints + vector indexes. |
| F9 | Subsequent migrations are additive — adding new labels (e.g., `OssFile`, `OssFunction`), edges (`Imports`, `Documents`), or indexes. |
| F10 | Vector index dimensions match the embedder configuration (default 1024 for Qwen3 0.6B; configurable via env-var-substitution at apply time). |
| F11 | Schema covers all source types declared in `@ecruz165/context-loader-core`'s `SourceTypeId` enum: `code-full`, `oss-code`, `prose-markdown`, `crawled-web`, `oss-docs`, `oss-issues`, `structured-schema`, `config`, `issue-tracker`, `image-described`, `pdf`, `learned`. |
| F11a | **Per-source provenance properties on every chunked node (mandatory).** Every node emitted by chunkers carries `sourceId: string` (the logical source — e.g. `react@18.2.0`) + `sourceVersion: string` (the ingest's version stamp — e.g. ISO timestamp or content hash). These properties enable: (a) sub-graph export by sourceId on the central side; (b) selective re-import on edges via `MERGE` keyed on `sourceId`+stable-id; (c) staleness detection during refresh by comparing `sourceVersion`. Edges that lack these properties cannot participate in the priming/refresh protocol. |
| F11b | First migration creates indexes on `(sourceId)` for all chunked node labels — sub-graph extraction queries depend on this for performance. |

### 6.3 Application API

| ID | Requirement |
|---|---|
| F12 | TS API: `applyMigrations(driver: Driver, options?: { embedderDim?: number }): Promise<MigrationReport>`. Reports applied/skipped counts. |
| F13 | TS API: `getAppliedMigrations(driver: Driver): Promise<string[]>`. Lists already-applied migrations. |
| F14 | TS API: `getPendingMigrations(driver: Driver): Promise<string[]>`. Lists migrations that need to run. |
| F15 | Java consumers: read migration files via classpath resources or filesystem; apply via Spring's `Neo4jClient` using same SHA-tracking convention. |
| F16 | Tracker node: `:_SchemaMigration { version, hash, applied_at, applied_by }`. Hash of file contents prevents accidental migration mutation post-apply. |

### 6.4 Versioning + release

| ID | Requirement |
|---|---|
| F17 | Package version follows `@ecruz165/context-loader-core` exactly — when context-loader-core ships v0.5.0, schema package ships v0.5.0 with any required migrations bundled. |
| F18 | Coordinated release via changesets: changing the chunker = mandatory schema-package changeset. |
| F19 | Migration files cannot be edited after release — only added. Hash mismatch triggers loud failure. |
| F20 | Published changelog explicitly lists what each migration does (added labels, indexes, etc.). |

## 7. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  @ecruz165/context-loader-schema (npm package)             │
│                                                            │
│  migrations/                                              │
│    V001__init.cypher                                      │
│    V002__add_oss_labels.cypher                            │
│    V003__add_pdf_chunks.cypher                            │
│    ...                                                    │
│                                                            │
│  src/                                                     │
│    index.ts          ← exports applyMigrations, etc.      │
│    apply.ts          ← TS migration runner                │
│    parse.ts          ← parses .cypher into statements     │
│                                                            │
└────────────────────────────────────────────────────────────┘
        ▲                          ▲                ▲
        │                          │                │
   imports                    imports         reads files
        │                          │                │
┌───────┴──────────┐  ┌────────────┴───────┐  ┌────┴──────────────┐
│ edge-context-    │  │ context-loader-cli │  │ Spring central    │
│ server (TS)      │  │ (TS, agentx-load)  │  │ ContextServer     │
│                  │  │                    │  │ (Java)            │
│ on startup,      │  │ on first run       │  │ on startup,       │
│ apply()          │  │ in a workspace,    │  │ apply via         │
│                  │  │ apply()            │  │ Neo4jClient +     │
│                  │  │                    │  │ SHA tracking      │
└──────────────────┘  └────────────────────┘  └───────────────────┘
        │                          │                  │
        ▼                          ▼                  ▼
   workspace Neo4j          workspace Neo4j        central Neo4j
```

## 8. Open Questions

1. **Java consumption pattern:** options are (a) Spring app reads `.cypher` files from npm package extracted into the Spring image at build time, (b) Maven Central artifact mirrors the npm package, (c) HTTP endpoint serves files at runtime. (a) is simplest; (b) is most idiomatic Java; (c) is most flexible. v1: (a). v1.x: maybe (b).
2. **Embedder dimension as a parameter:** vector indexes need a fixed dimension. v1: env-var substituted at migration-apply time (`{{EMBEDDER_DIM}}` in Cypher template). Risk: dimension change = re-create-index migration.
3. **Schema evolution story:** if a migration changes a label's properties, downstream queries break. Versioning the *queries* alongside the schema is a separate concern — out of scope for this package.
4. **Per-source-type schema slicing:** large deployments may not need *all* source-type indexes. Should the package support "apply only V001 + V003" subsets? v1: no — apply all or none. Subsets v2+.
5. **Migration testing:** how do we know a migration is correct before publish? CI integration with a Neo4j test container running migrations against a fresh DB and a snapshotted DB. v1.x scope.
6. **Cross-version compat:** if edge is on schema v0.5 and central is on v0.7, are queries compatible? Generally yes if migrations are additive (new labels don't break old queries). Mismatch policy: alert at startup, don't break.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Plain `.cypher` files (not Liquibase/Flyway adapter) | Cross-language; Cypher-native tooling is immature. | 2026-05-06 |
| D2 | Tracker node `:_SchemaMigration` with hash | Standard pattern; tamper detection. | 2026-05-06 |
| D3 | npm package primary; Java reads via classpath | Single source of truth; v1 simplicity. | 2026-05-06 |
| D4 | Co-versioned with `@ecruz165/context-loader-core` | Schema and chunker change together; one release cadence. | 2026-05-06 |
| D5 | Forward-only migrations | Standard practice; rollback is "destroy + reingest". | 2026-05-06 |
| D6 | Idempotent migrations using `IF NOT EXISTS` | Safe re-runs; no special-case logic. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Initial migration `V001__init.cypher` covering current edge schema; TS apply API; tracker node convention |
| **Phase 2** | Subsequent migrations as `@ecruz165/context-loader-core` evolves (additive labels for new source types) |
| **Phase 3** | Java consumption via classpath; Spring central-context-server uses on startup |
| **Phase 4** | CI smoke tests against ephemeral Neo4j |
| **Phase 5+** | Maven Central artifact (v1.x); selective subset application (v2+) |
