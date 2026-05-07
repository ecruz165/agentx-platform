# Central ContextServer (Spring Modulith module) — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-06-prd-context-schema-package.md` — versioned Cypher migrations (shared with edge)
- `2026-04-30-prd-edge-context-server.md` — workspace-local sibling (TS data plane)
- `2026-05-05-prd-context-loader-core.md` — chunker + ingest engine (TS, used by both edge and central via subprocess)
- `2026-05-05-prd-context-loader-cli.md` — `agentx-load` binary that the central ingest invokes

---

## 1. Purpose

The Central ContextServer is the **org-wide graph-RAG layer** in the control plane. It serves shared knowledge — OSS package documentation, public crawls, internal docs, cross-product reference material — to harnesses and their agents. Pairs with workspace-local `edge-context-server` instances which serve workspace-private context (your code, your in-flight captures).

Together they form a **two-tier RAG architecture**: edge for private + low-latency, central for shared + curated. Agents querying for context typically fan out to both layers and merge results by relevance — same pattern as LangChain's `EnsembleRetriever`.

This module exists because some context is *organizationally shared*: OSS package graphs ingested once, reused everywhere; internal Confluence/Notion docs that every team can query; cross-product design system references. Replicating that data per-workspace is wasteful and inconsistent. Centralizing it is the right answer; the question is just *where* central lives — and the answer here is "inside the Spring Modulith control plane, backed by central Neo4j."

## 2. Goals (v1)

- **Org-wide ingestion API.** `POST /api/context/sources` to register a source for ingestion (OSS package, web crawl, internal docs).
- **Org-wide query API.** `POST /api/context/query` returns ranked context chunks; harnesses call this from agents during their tool/RAG flows.
- **Reuses TS chunker engine.** Spring shells out to the published `@ecruz165/context-loader` CLI (`agentx-load`) for actual ingestion. No reimplementation of chunkers in Java.
- **Same Neo4j schema as edge.** Defined by `@ecruz165/context-loader-schema` package; both edge and central run the same Cypher migrations.
- **Multi-tenant.** Orgs can have multiple knowledge sets with access policies; products can be granted read access to specific sets.
- **Refresh scheduling.** Sources can declare a refresh cadence (`daily`, `weekly`); central server scheduled-refreshes them.
- **Same query-result shape as edge.** Drop-in compatible with the edge query API so harness code can fan out to both transparently.

## 3. Non-Goals (v1)

- **No edge replacement.** Workspace-private data stays at the edge. Central never replicates workspace data. Critically: this also means **central traffic is bounded by org-wide content size, not by per-user query rate** — the high-QPS work happens at edge. Central is small + slow-growing + read-cacheable; sized for *graph size* not *query rate*.
- **No agent invocation.** Central serves context; it does not run agents (those belong on harnesses).
- **No real-time streaming ingest.** Sources are batch-ingested on registration + scheduled refresh. Real-time webhooks (e.g., GitHub push) come later.
- **No chunker innovation in Java.** Reuse the TS implementation via subprocess; don't build a parallel chunker stack.
- **No sub-org / per-team segmentation in v1.** Org-level access control only. Per-team / per-user ACLs are v1.x.
- **No vector-only mode.** Schema is hybrid graph+vector; v1 ships with both. Pure-vector or pure-graph stripped variants are not v1 goals.

## 4. Reference & Provenance

- The chunker pipeline + graph schema are owned by `@ecruz165/context-loader-core` (TS). Central server *invokes* this code, doesn't reimplement.
- Edge sibling: `@ecruz165/edge-context-server` (TS). Same query shape, different scope.
- Cypher schema migrations: shared via `@ecruz165/context-loader-schema` (see companion PRD).
- Neo4j as backing store; Bolt protocol; `neo4j-driver-java` for connections.
- Embedder via OpenAI-compatible HTTP API (TEI, vLLM, LiteLLM).

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Iris (catalog admin)** | "Register `react@18.2.0` for org-wide ingestion; refresh weekly; grant read access to all products in this org." |
| **Daisy (developer's agent)** | "While I'm writing a feature, my agent queries context for `useState hook` — gets back chunks from React's official docs, ranked by relevance, merged with workspace-local matches." |
| **Owen (operator)** | "Show me ingestion status: which sources, when last refreshed, how many chunks each, error rate." |
| **CI/CD pipeline** | "Programmatic context queries from automated workflows that don't run in a workspace." |

## 6. Functional Requirements

### 6.1 Source registration + ingestion

| ID | Requirement |
|---|---|
| F1 | `POST /api/context/sources` accepts `{ kind, target, profile?, refreshSchedule?, accessPolicy? }`. Returns `{ sourceId, ingestionJobId }`. |
| F2 | Ingestion is async: kicks off a background job; status visible via `GET /api/context/sources/{id}`. |
| F3 | Ingestion implementation: shells out to `agentx-load <args>` as subprocess. CLI emits NDJSON events; Spring reads them and updates ingestion job state. |
| F4 | Source kinds (v1): `oss-package` (npm, cargo, pypi later), `prose-markdown` (path or URL), `crawled-web`, `oss-docs`. Mirrors `@ecruz165/context-loader-core`'s SourceTypeId. |
| F5 | Failure handling: ingestion errors logged + reported; partial ingest preserved (don't roll back chunks already inserted). |
| F6 | `DELETE /api/context/sources/{id}` removes a source: its nodes/edges are deleted from Neo4j; metadata kept for audit. |

### 6.2 Query API

| ID | Requirement |
|---|---|
| F7 | `POST /api/context/query` accepts `{ text, productId, k=10, sources? }`. Returns ranked chunk array with `{ chunk, score, sourceId, metadata }`. |
| F8 | Query path: embed the text via embedder service, vector-search in Neo4j against indexed nodes, return top-k by cosine similarity. |
| F9 | Query result shape matches edge-context-server's response shape exactly — drop-in compat for harness clients. |
| F10 | Access control: query is scoped to current org; further restricted to sources the calling product has access to per `accessPolicy`. |
| F11 | Query latency target: p50 < 200ms, p95 < 500ms (single embedder + Neo4j round-trip). |
| F12 | Hybrid query: combine vector search with graph traversal (e.g., "all docs that document React functions used by this snippet"). v1 ships pure-vector; graph-aware queries v1.x. |

### 6.2a Sub-graph export (edge priming) — v1.x

| ID | Requirement |
|---|---|
| F12a | `POST /api/context/subgraph/export` accepts `{ sources: [{ kind, target, sinceVersion? }, ...] }` and streams an NDJSON response of nodes + edges + metadata. Each line: `{ kind: 'node' | 'edge' | 'progress' | 'done', ...payload }`. |
| F12b | Implementation: per source, run `apoc.export.cypher.query()` (or equivalent `apoc.export.json.query()`) on Aura/central Neo4j with a Cypher pattern matching the source's sub-graph: `MATCH (s:Source {sourceId: $sid})-[r*0..]->(n) RETURN s, r, n`. Stream results back through Spring response. |
| F12c | Response is delta-aware: if `sinceVersion` is provided, only nodes/edges modified after that source's version are exported. Enables incremental refresh on edge. |
| F12d | Per-source provenance: every exported node carries `sourceId` + `sourceVersion` properties so edges can selectively re-import without touching workspace data. |
| F12e | Access control: subgraph export respects same `accessPolicy` as `/query` — caller must have read access to each requested source. |
| F12f | Rate limit: export endpoint capped per harness (default 5 concurrent exports) to protect Aura/central from priming storms. |
| F12g | Timeout: each individual source export bounded (default 60s); exports that exceed are paginated by the caller via cursor (split by node-id range). |

### 6.3 Refresh scheduling

| ID | Requirement |
|---|---|
| F13 | Sources with `refreshSchedule: 'daily' | 'weekly' | 'manual'` get scheduled refresh via Spring `@Scheduled`. |
| F14 | Refresh runs the same `agentx-load` ingestion as initial registration; new chunks added, stale ones removed. |
| F15 | Refresh failures non-fatal — last-good data remains queryable; alert sent to operator. |
| F16 | `POST /api/context/sources/{id}/refresh` triggers immediate manual refresh. |

### 6.4 Access control + multi-tenancy

| ID | Requirement |
|---|---|
| F17 | Every source has `org_id` (required) + optional `accessPolicy: { allowedProductIds: string[] | 'all' }`. |
| F18 | Default access policy: `'all'` within org (any product in org can query). Operators tighten via API. |
| F19 | Cross-org queries blocked at API gateway via Spring Security; cannot read another org's sources. |
| F20 | Audit log of every source addition / removal / access policy change. |

### 6.5 Persistence + Neo4j

| ID | Requirement |
|---|---|
| F21 | Postgres tables: `context_sources` (registry), `ingestion_jobs` (in-flight + history), `context_audit_log`. |
| F22 | Neo4j connection via Bolt; central Neo4j instance as sibling container in docker-compose. |
| F23 | Schema migrations on startup via `@ecruz165/context-loader-schema` Cypher files (idempotent). |
| F24 | Embedder URL configurable; same OpenAI-compatible API as edge. |

## 7. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Central ContextServer module                                      │
│                                                                    │
│  ┌─────────────────┐     ┌──────────────────────────────────────┐ │
│  │ Source mgmt API │     │ Refresh scheduler                    │ │
│  │ (POST /sources) │     │ (Spring @Scheduled per source)       │ │
│  └────────┬────────┘     └──────────────┬───────────────────────┘ │
│           │                              │                         │
│           └────────────┬─────────────────┘                         │
│                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ Ingestion runner                                          │   │
│  │ (spawns `agentx-load <args>`, reads NDJSON events,        │   │
│  │  updates ingestion_jobs)                                  │   │
│  └────────────┬───────────────────────────────────────────────┘   │
│               │                                                    │
│               ▼ (Cypher writes via Bolt)                          │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ Central Neo4j (sibling container)                          │   │
│  └────────────────────────────────────────────────────────────┘   │
│               ▲                                                    │
│               │ (Cypher reads via Bolt)                            │
│  ┌────────────┴───────────────────────────────────────────────┐   │
│  │ Query API                                                  │   │
│  │ (POST /query) — embeds + vector-searches + filters         │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  Reads: Catalog (product → sources access policy)                 │
│  Writes: Postgres (sources, ingestion_jobs, audit)                │
│  Writes: Neo4j (graph nodes/edges/vectors)                         │
└────────────────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTPS
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         Harness 1     Harness 2     Harness N
         (queries +    (queries)     (queries)
          fan-out merge
          with edge)
```

## 8. Open Questions

1. **Subprocess vs in-process ingestion in Java.** v1 spawns `agentx-load` per ingest run — straightforward, but spawn overhead adds up if many ingests run in parallel. Long-running mode (one persistent agentx-load process accepting jobs over UDS) is a v1.x optimization.
2. **Cross-tenant chunk dedup.** Two orgs ingest `react@18.2.0` — do they share the chunks (storage savings) or each gets their own (isolation)? Probably each their own for v1; dedup is hard with access control.
3. **Neo4j sizing.** Central Neo4j scales differently from edge — many readers, fewer writers, larger graphs. v1: single Neo4j instance, vertical scale. v2+: read replicas / cluster.
4. **Hybrid query support timing.** Pure-vector ranking is sufficient for v1; graph-aware queries (Cypher patterns + vector blend) are powerful but harder to API-design well. Defer to v1.x.
5. **Result merging at the harness.** When a harness queries both edge + central and merges, what's the merge algorithm? Score-based with reciprocal-rank-fusion is standard. The merge is *harness-side* code, not server-side — but the ranking shape needs to be compatible.
6. **Ingest status visibility:** during a long ingest (e.g., crawling a large doc set), do clients see partial results? Default: no — chunks aren't queryable until ingest completes. Streaming-as-you-go is a UX nicety for v1.x.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Reuse `@ecruz165/context-loader` CLI for ingest | One source of truth for chunkers + graph schema; no Java reimplementation. | 2026-05-06 |
| D2 | Same Neo4j schema as edge | Cross-implementation parity; shared migrations package. | 2026-05-06 |
| D3 | Query result shape matches edge API | Drop-in compat for harnesses; merge logic is symmetric. | 2026-05-06 |
| D4 | Org-level multi-tenancy from day one | Future-proofs the module; cheap to add now. | 2026-05-06 |
| D5 | Neo4j sibling container, not embedded | Production-grade pattern; embedded is Community-only. | 2026-05-06 |
| D6 | Subprocess ingestion in v1; long-running mode in v1.x | Reduces v1 complexity; can optimize after measuring. | 2026-05-06 |
| D7 | Sub-graph export via APOC + NDJSON streaming for edge priming (v1.x) | Aura supports APOC export procedures; NDJSON streams cleanly to edge consumers; idempotent ingest because schema is shared. | 2026-05-07 |
| D8 | Edge primes from central by-source-id, not full replication | Bandwidth-efficient; matches workspace-declared `contextSources`; supports air-gap operation post-prime. | 2026-05-07 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Source registration API + persistence; ingestion runner that spawns `agentx-load`; basic query (vector-only) |
| **Phase 2** | Refresh scheduling; status reporting; multi-source query merging |
| **Phase 3** | Access policies + multi-tenant queries; audit log |
| **Phase 4** | Hybrid (graph+vector) queries; long-running ingest mode |
| **Phase 5** | Read replicas / Neo4j cluster (v2+) |
