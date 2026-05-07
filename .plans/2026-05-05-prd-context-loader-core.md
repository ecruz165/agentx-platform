# Context Loader Core — PRD

**Status:** Draft (2026-05-05)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `.plans/2026-05-05-prd-context-loader-cli.md` — the CLI surface that wraps this lib
- `.plans/2026-04-30-prd-edge-context-server.md` — supersedes its F21/F22/F24/F26 ingestion semantics; the server now consumes this lib
- `.plans/2026-04-30-prd-agent-adapter-lib.md` — used when a source-type step needs an LLM call (e.g., `image-described`, `oss-issues` summarization)
- `.plans/2026-04-30-prd-auth-lib.md` (renamed `agent-auth-lib`) — `CredentialBroker` for GitHub/Jira/Confluence ingestion
- `.plans/2026-04-30-prd-harness-core.md` — explicitly NOT a consumer; ingestion is data flow, not agent orchestration

---

## 1. Purpose

A standalone TypeScript library (`@ecruz165/context-loader-core`) that defines **how content becomes typed graph data + vectors** for both the edge tier (local `neo4j-edge` sidecar) and the central tier (self-hosted Neo4j Community on ECS+EBS). Both tiers run the same engine — see workspace memory `project_central_graph_store_choice`. The library:

- Enumerates a catalog of **context source types**, each with its own matcher, chunker, graph schema, and embedder selection.
- Chunks content via type-specific strategies (tree-sitter AST for code, heading-based for prose, per-page for PDFs, etc.).
- Embeds chunks via an OpenAI-compatible HTTP endpoint (default: `ai/qwen3-embedding` locally via Docker Model Runner, Bedrock Titan v2 in deployed envs — see workspace memory `project_embedder_choice`).
- Writes nodes/edges/vectors via a `GraphIngestionBackend` interface; the production impl is a single `Neo4jBackend` used by both tiers (different `bolt://` URLs).
- Emits structured `IngestionEvent`s for progress observability.

The library is consumed by three layers, each in a different role:

| Consumer | Role | When used |
|---|---|---|
| `@ecruz165/harness` | **Primary user surface.** Launches loaders as harness-server jobs (`harness context load <source>`), shows live progress in `jobs-tui`, exposes catalog management (`harness context source list/describe/extend`), and offers a first-run wizard (`harness context load configure`). | Daily developer workflow inside a workspace with a running triad. |
| `@ecruz165/context-loader` | **Headless executable** — the binary `agentx-load`. Ingests directly when no harness is around (CI runs, scripts, ECS task entrypoints) and runs as the spawn-worker process when harness-cli launches a load. | Scripted/automated runs; spawn-worker mode under harness-server. |
| `@ecruz165/edge-context-server` | **HTTP-triggered ingestion routes** — `POST /v1/sources/...` endpoints that internally call `ingest()`. | Browser/IDE integration paths that talk to edge-context over the network. |

The relationship between the top two rows is the same "thin headless emitter, thick consumer" pattern used elsewhere in the codebase (see `project_observability_via_emitter` memory): `agentx-load` emits structured `IngestionEvent`s; harness-cli is the rich subscriber that aggregates them across concurrent loads and renders them through `jobs-tui`. Because both speak the same wire format (JSON events over stdout standalone, over UDS in worker mode), the same loader binary serves all three consumers without branching.

**Why now:** The local stack has reached infrastructure completeness (compose with embedder + agent-llm sidecars, OpenCode adapter that supports custom HTTP endpoints). The next step is making the context graph actually populated. Without a coherent loader, each ingestion path (repo / upload / crawl / external) would be implemented separately inside edge-context-server with no shared abstraction.

The library introduces the concept of **context sources** — typed inputs from which the system loads content into the context graph — and **source types** — the per-content-type rules describing how each kind of source should be chunked, structured, and embedded.

## 2. Goals (v1)

- **Concept-first design.** The vocabulary the library exposes is *context sources* and *source types*; implementation terms (chunking strategy, embedder URL, graph schema) are second-order.
- **Source type catalog with distinct rules per type.** A profile catalog where each entry has its own matcher, chunker, graph schema, and embedder selection. No universal pipeline pretending to handle every content type.
- **Pluggable backend.** A `GraphIngestionBackend` interface with one production adapter (`Neo4jBackend`) used by both edge and central — the engine is the same, only the `bolt://` URL differs. The interface stays pluggable so future tiers (e.g., a different graph store on a third tier) can land without rewiring callers.
- **Tree-sitter AST as the dominant chunking strategy for code.** Function/class-level chunks for code source types; heading-based for prose; per-page for PDFs. Skeleton-only mode for OSS code reduces volume by ~10× without sacrificing usage-pattern retrieval.
- **Cross-source-type graph edges.** When the same symbol is described in `oss-code`, `oss-docs`, and `oss-issues`, the loader emits cross-source-type edges (`Documents`, `Mentions`, `FixedIn`) so retrieval can traverse code → docs → issue history in one query path.
- **Programmatic API only.** This package is a library — no CLI, no HTTP server, no daemon. Consumers wrap it (per `prd-context-loader-cli.md`).

## 3. Non-Goals (v1)

- **Not a query/retrieval layer.** This package writes; reading happens via edge-context-server's HTTP API or central Neo4j queries.
- **Not multi-model embedding orchestration in v1.** Spec'd in the profile config (each source type can name an embedder URL + dim) but only one embedder model is actually used per workspace. Multi-model support is a v1.x optimization.
- **Not a tree-sitter grammar distribution mechanism.** Grammars are bundled per-language at build time; new language support requires a code release.
- **Not a long-running daemon.** Each loader invocation is one ingestion run. State persists in the graph backend, not in the loader process.
- **Not a generic file-walker / corpus indexer.** Source types are explicitly enumerated; matching files that don't fit any registered type are logged-and-skipped, not silently embedded as fallback.
- **Not a license-policy gate.** License is *tracked* on each ingested OSS node; whether to ingest GPL code is a downstream policy decision.
- **Not a CLI.** All CLI concerns (binary names, flag parsing, help text, install/distribution, job-mode UDS protocol) belong to `@ecruz165/context-loader`. See its PRD.

## 4. Reference & Provenance

This package consolidates ingestion concerns currently distributed across:

| Source | What gets extracted |
|---|---|
| `prd-edge-context-server.md` F21 (repo import) | Code source type + tree-sitter chunking |
| `prd-edge-context-server.md` F22 (file upload) | PDF + image source types |
| `prd-edge-context-server.md` F24 (external sources) | Issue tracker source types |
| `prd-edge-context-server.md` F26 (URL crawling) | Crawled web docs source type |
| `prd-edge-context-server.md` § 13 (`graphrag.config.yml`) | Renamed to `context-sources.yml`; same role |
| Memory `project_embedder_jina_v3.md` | Default embedder choice |
| Memory `project_central_grounding_bidirectional.md` | Backend-agnostic write contract |

**Naming refactor:** Per the design discussion, the term `graphrag` (as a CLI namespace and concept) is replaced by `context source`. Existing PRD references to `graphrag` get updated.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Developer building edge-context-server** | Import the lib, call `await ingest(...)` from an HTTP route handler, stream events back to the client |
| **Developer building context-loader-cli** | Import the lib's programmatic API, wrap it with arg-parsing, mode detection, event-formatting |
| **Future contributor adding a source type** | Add a new entry to `BUILTIN_SOURCE_TYPES`, write a chunker function (or reuse an existing one with config), update the graph schema declaration. ~50-200 LOC per new type |
| **Future contributor adding a backend** | Implement the `GraphIngestionBackend` interface for a new graph DB (e.g., ArangoDB, Memgraph, JanusGraph). All source-type code works against the new backend without modification |

User stories:
- *As edge-context-server*, when a `POST /v1/sources/add` request arrives, I call `ingest({ source: req.body, backend: localNeo4j, embedder: cfg.embedder, onEvent: (e) => stream.write(e) })` and pipe events back to the client as SSE.
- *As context-loader-cli*, my entrypoint parses argv, builds an `IngestSpec`, calls `ingest()`, and emits events to stdout (or UDS in job mode).
- *As a future contributor*, I add `slack-thread` as a new source type by writing 60 lines: a matcher (Slack API URL pattern), a chunker (thread = parent chunk; replies = children), a graph schema (`SlackThread`, `SlackMessage` nodes; `RepliedTo`, `Mentions` edges). I register it in `BUILTIN_SOURCE_TYPES`. It works.

## 6. Functional Requirements

### 6.1 Source Type Catalog

| ID | Requirement |
|---|---|
| F1 | The package ships a built-in catalog of source types. v1 catalog (13 entries): `code-full`, `oss-code`, `prose-markdown`, `crawled-web`, `oss-docs`, `oss-issues`, `structured-schema`, `config`, `issue-tracker`, `image-described`, `pdf`, `learned`, `skip`. Each entry has its own `{ matcher, chunker, graph-schema, embedder?, options }`. |
| F2 | Each source type's matcher is per-file (or per-source-item for non-file inputs like URLs/issues): include-glob list, exclude-glob list, optional size cap. First-match-wins; matcher order in catalog defines precedence. |
| F3 | Each source type names a **chunker** by id (e.g., `tree-sitter`, `heading-based`, `issue-thread`, `pdf-page`, `whole-file`, `image-vision`). Chunkers are registered code; new types can either reuse an existing chunker with config or register a new one. |
| F4 | Each source type defines a **graph schema fragment**: which node labels it produces (e.g., `Function`, `Class`, `Module` for `code-full`) and which edge types it can emit. Cross-source-type edges (e.g., `code-full:Function ←Documents← oss-docs:Section`) are declared so the backend layer knows the union schema. |
| F5 | Each source type can override the default embedder (URL + model + dimension) for its content. v1: one embedder per workspace; the override field is spec'd but not used. |
| F6 | Source type ids are kebab-case. The catalog is exported as `BUILTIN_SOURCE_TYPES` and merged with user-provided extensions at load time (per F8). |
| F7 | One source type, `skip`, exists explicitly to enumerate file extensions and paths that should never be ingested under any other type (binaries, build artifacts, lock files, large fixtures). It produces no chunks; it documents the deny list. |

### 6.2 User-extensible profile spec

| ID | Requirement |
|---|---|
| F8 | Users can extend the catalog via `<workspace>/.harness/config/context-sources.yml` or `~/.agentx/context-sources.yml` (user-global). User entries are merged into the built-in catalog; user entries can override built-ins by id. |
| F9 | Profile spec is YAML, Zod-validated. Schema is exported from `@ecruz165/context-loader-core/schema`. Invalid configs throw `SourceTypeValidationError` with path-rooted messages on the first invocation that touches them. |
| F10 | Built-in chunkers are referenced by id in user configs (`chunker: { type: tree-sitter, granularity: function-class, ... }`). User-defined chunkers (out of scope for v1) would require code registration. |
| F11 | The catalog supports config inheritance: a user-defined source type can extend a built-in (`extends: code-full`) and override specific fields. |

### 6.3 Backend abstraction

| ID | Requirement |
|---|---|
| F12 | Single TypeScript interface `GraphIngestionBackend` with `upsertNode`, `upsertEdge`, `upsertVector`, plus bulk variants and `ensureSchema(profile)`. |
| F13 | **One backend implementation ships in v1**, conforming to `GraphIngestionBackend`. Selection is by URL scheme passed via config or `--backend` flag: |
| F13a | `Neo4jBackend` (`neo4j://host:port`, `bolt://...`, `neo4j+s://...`) — opens a Bolt protocol connection via the official `neo4j-driver`. **Concurrent-safe** — Neo4j's transaction layer serializes concurrent writes natively. Used for both edge tier (local triad's `neo4j-edge` sidecar) and central tier (self-hosted Neo4j Community on ECS+EBS) — same code, different `bolt://` URL. See workspace memory `project_central_graph_store_choice` for the engine choice rationale. |
| F13b | A test-only `InMemoryGraphBackend` ships under `src/backends/in-memory.ts` for unit/integration tests; it is exported but not part of the production CLI surface. |
| F14 | Backend selection at runtime via programmatic config or CLI flag. Loader code paths are backend-agnostic — they emit `GraphNode`/`GraphEdge`/`Vector` records; the backend translates them to Cypher. |
| F15 | Idempotent writes via content-hash dedup (per `prd-edge-context-server.md` F5). The backend computes content hashes per node and `MERGE`-by-id skips redundant upserts when the hash matches. Re-running ingestion is safe. **Concurrent dedup**: when multiple CLIs ingest overlapping content simultaneously, content-hash MERGEs converge to the same final state regardless of write order. No special coordination needed. |
| F16 | Backend implementations handle their own connection pooling, transaction batching, and error retries. The loader engine treats the backend as a write-only sink with `Promise<void>` return on each upsert (for backpressure). |
| F16a | **Concurrent CLI execution is a first-class supported pattern.** Multiple `agentx-load` processes (or multiple `harness context load` jobs) writing to the same Neo4j endpoint MUST work without coordination beyond what the driver+server provide. Neo4j's Bolt session model handles this natively. |

### 6.4 Source-type-specific behaviors

| ID | Requirement |
|---|---|
| F23 | **`code-full`**: Tree-sitter AST chunking. Function/class-level chunks, with separate skeleton (signature + docstring + first-line summary) and body chunks linked by `SkeletonOf` edge. Default exclude: `node_modules`, `dist`, `build`, `.next`, `.gradle`, `target`, `venv`, `__pycache__`. Default size cap: 256 KB. Grammars: TS/JS/Java/Kotlin/Python/Go/Rust/C/C++. |
| F24 | **`oss-code`**: Same chunking as `code-full` but `bodyExtraction: false` by default — skeleton-only. Body extraction enabled per-path (e.g., `**/examples/**`). Each chunk tagged with `(packageName, version, license, sourceRepo)` provenance. Detect package + version from `package.json`/`pom.xml`/`Cargo.toml` adjacent to the source root. |
| F25 | **`prose-markdown`**: Heading-based chunking (H1/H2 sections). Max 2048 tokens per chunk with 128-token overlap. No AST. Extract Markdown links → `LinkedFrom` edges. |
| F26 | **`crawled-web`**: HTML → Mozilla Readability → Markdown → reuse `prose-markdown` chunker. Per-page chunks tagged with `sourceUrl`, `crawledAt`, content-hash. Respects `robots.txt`, rate-limits per host (default 1 req/sec). Detect doc framework (Docusaurus, MkDocs, Starlight, VitePress) for better section extraction when possible. |
| F27 | **`oss-docs`**: Reuses `crawled-web` chunker plus version awareness (detect from URL path or docs-version-config). Code examples in fenced blocks become separate `OssDocCodeExample` nodes; symbol-resolve them best-effort to `oss-code:OssFunction` to emit `Documents` edges. |
| F28 | **`oss-issues`**: Fetches via GitHub/GitLab API (auth via `CredentialBroker.getCredential('github')`). Issue body = parent chunk; comments = child chunks. **Curation filters required**: `state=closed AND (hasFixPr OR labels=[bug,regression,breaking-change] OR comment_count>=5)`; exclude labels `[question, duplicate, support, stale]`. Cap at 5K issues per repo by default. Inferred version from fix-PR's release tag → `FixedIn` edge. Symbol-mention extraction (regex-detect `useEffect` style references) → `Mentions` edges to `oss-code:OssFunction`. |
| F29 | **`structured-schema`**: OpenAPI/GraphQL/SQL/Proto. Per-endpoint or per-type chunks; preserve schema relationships as graph edges (`References`, `Returns`, `Accepts`). |
| F30 | **`config`**: Whole-file chunk for small configs (`<16 KB`). Skip files over the size cap. Useful for "how is this project set up" queries. |
| F31 | **`issue-tracker`**: Internal Jira/Confluence/etc., per `prd-edge-context-server.md` F24. Same auth-broker pattern as `oss-issues` but provider-aware. |
| F32 | **`image-described`**: Two-stage. Image → vision LLM (calls `agent-vl` Docker service via OpenAI-compatible HTTP at `http://agent-vl:8080`) → description text → embedder → vector. The vision LLM call uses `@ecruz165/agent-adapter`'s `createAgent` directly with the local-endpoint config, NOT through harness-core's orchestrator. |
| F33 | **`pdf`**: Per-page text extraction (use `pdfjs-dist` or similar). For scanned PDFs (no extractable text), fall back to per-page vision-LLM description via `agent-vl`. Each page = one chunk linked to the parent `Doc` node. |
| F34 | **`learned`**: Different lifecycle from other source types — written by harness-server's end-of-job evaluator phase, not by user-triggered ingestion. The loader exposes a programmatic API for this path: `loader.upsertLearning({ jobId, productId, content, derivedFrom })`. |
| F35 | **`skip`**: Lists denylist patterns (`.exe`, `.zip`, `.pyc`, `.otf`, `.gz`, `.psd`, `.bmpr`, `.dll`, `.so`, `.dylib`, lock files, `.terraform/providers/**`). Files matching this type produce zero chunks; the matcher logs at debug level and continues. |

### 6.5 Event types for progress streaming

| ID | Requirement |
|---|---|
| F41 | `IngestionEvent` is a discriminated union with at least these kinds: `source-resolved` (input → list of items to process), `item-walked` (per file/page/issue: `{ id, type, sizeBytes }`), `chunk-produced` (`{ chunkCount, totalTokens }`), `chunk-embedded` (`{ chunkId, vectorDim, embedderLatencyMs }`), `node-written` (`{ nodeId, label }`), `edge-written` (`{ from, to, type }`), `source-completed` (`{ filesIngested, chunksWritten, vectorsWritten, errors }`), `error` (`{ phase, item, message }`). |
| F42 | Events are JSON-serializable; the same shape works on stdout, over UDS, and over HTTP/SSE. |

## 7. Non-Functional Requirements

### 7.1 Latency targets

| Operation | p95 (warm) | p99 (warm) |
|---|---|---|
| Per-chunk embed roundtrip (CPU TEI) | <80ms | <200ms |
| Per-node graph upsert (Neo4j local) | <5ms | <20ms |
| Per-node graph upsert (Neo4j Bolt over LAN) | <20ms | <80ms |
| Tree-sitter parse of a 50KB TS file | <200ms | <500ms |

### 7.2 Throughput targets

| Configuration | Throughput |
|---|---|
| Single ingestion run, ai/qwen3-embedding-0.6B (Docker MR, CPU), code-full profile | ~50-150 chunks/s end-to-end |
| 4 parallel runs, shared embedder sidecar | ~150-400 chunks/s aggregate (fan-in at embedder) |
| Full skoolscout-com repo (~5K source files) | <5 min end-to-end |
| OSS dep skeleton-only ingestion (`react@18.2.0`) | <2 min |

### 7.3 Reliability

- Survives partial failures: a single file failing to parse doesn't abort the run; it produces an `error` event and the loader continues.
- Survives backend disconnects: the `GraphIngestionBackend` adapter retries transient failures with exponential backoff (default 3 attempts).
- Idempotent on re-run: content-hash dedup means re-running on an unchanged corpus is a no-op.
- Cancellable: respects `AbortSignal` at chunk-batch boundaries (typically <5 second cancellation latency).

### 7.4 Resource

- Idle RSS: <100 MB.
- Active RSS during ingestion: <500 MB at typical workloads.
- Per-grammar disk: ~5-20 MB (tree-sitter wasm binaries shipped with the package).

## 8. Public API

```ts
// @ecruz165/context-loader-core
import { ingest, ingestOssDep, type SourceTypeId, type GraphIngestionBackend, type IngestionEvent } from '@ecruz165/context-loader-core';

// Programmatic API — single source ingestion
await ingest({
  source: { type: 'code-full', path: '/path/to/repo' },
  backend: new Neo4jBackend({ url: 'bolt://neo4j-edge:7687', user: 'neo4j', password: 'neo4j' }),
  embedder: { url: 'http://embedder:8080/v1', model: 'ai/qwen3-embedding', dim: 1024 },
  onEvent: (e: IngestionEvent) => console.log(e),
  signal: abortSignal,
});

// OSS-specific helper — runs the trio (oss-code + oss-docs + oss-issues)
await ingestOssDep({
  package: 'react',
  version: '18.2.0',
  types: ['oss-code', 'oss-docs', 'oss-issues'],   // or a subset
  backend, embedder, onEvent, signal,
});

// Backend interface (implementations in core)
export interface GraphIngestionBackend {
  upsertNode(node: GraphNode): Promise<void>;
  upsertEdge(edge: GraphEdge): Promise<void>;
  upsertVector(nodeId: string, vector: Float32Array, meta: Record<string, unknown>): Promise<void>;
  upsertNodesBulk(nodes: GraphNode[]): Promise<void>;
  upsertEdgesBulk(edges: GraphEdge[]): Promise<void>;
  upsertVectorsBulk(items: Array<{ nodeId: string; vector: Float32Array; meta: Record<string, unknown> }>): Promise<void>;
  ensureSchema(profile: SourceTypeSchema): Promise<void>;
  close(): Promise<void>;
}

// Source type catalog
export const BUILTIN_SOURCE_TYPES: Record<SourceTypeId, SourceType>;
export type SourceTypeId =
  | 'code-full' | 'oss-code' | 'prose-markdown' | 'crawled-web'
  | 'oss-docs' | 'oss-issues' | 'structured-schema' | 'config'
  | 'issue-tracker' | 'image-described' | 'pdf' | 'learned' | 'skip';

// Event types
export type IngestionEvent =
  | { kind: 'source-resolved'; source: SourceRef; itemCount: number }
  | { kind: 'item-walked'; itemId: string; itemType: string; sizeBytes: number }
  | { kind: 'chunk-produced'; chunkId: string; chunkCount: number; totalTokens: number }
  | { kind: 'chunk-embedded'; chunkId: string; vectorDim: number; latencyMs: number }
  | { kind: 'node-written'; nodeId: string; label: string }
  | { kind: 'edge-written'; from: string; to: string; type: string }
  | { kind: 'source-completed'; filesIngested: number; chunksWritten: number; vectorsWritten: number; errors: number }
  | { kind: 'error'; phase: string; item?: string; message: string };
```

## 9. Configuration Schema

`<workspace>/.harness/config/context-sources.yml`:

```yaml
# Default embedder for all source types unless overridden per-type.
# Local default: ai/qwen3-embedding via Docker Model Runner.
# Deployed: flip url+model to a Bedrock-fronting endpoint (e.g., LiteLLM
# proxying amazon.titan-embed-text-v2:0). Both 1024-dim, both speak the
# OpenAI /v1/embeddings shape — see workspace memory project_embedder_choice.
embedder:
  url: http://embedder:8080/v1     # service-name DNS in compose
  model: ai/qwen3-embedding
  dim: 1024

# Default backend (consumed by CLI; lib takes the backend programmatically).
# The same Neo4j engine runs both edge (local triad sidecar) and central
# (ECS+EBS) — only the URL changes.
backend:
  type: neo4j
  uri: bolt://neo4j-edge:7687     # service-name DNS in compose
  username: neo4j
  # password: from env or secret store, never inline

# Source type registrations (additive to built-in catalog)
sources:
  - type: code-full
    paths: ['./packages/**/src']

  - type: oss-code
    package: react
    version: 18.2.0
    sourceRepo: https://github.com/facebook/react

  - type: oss-docs
    package: react
    version: 18.2.0
    crawl:
      urls: [https://react.dev]
      scope: site
      maxDepth: 3

  - type: oss-issues
    package: react
    repo: facebook/react
    refreshSchedule: daily

# User-defined source type overrides
overrides:
  code-full:
    extends: builtin
    chunker:
      maxFileBytes: 524288
    matcher:
      exclude:
        - '**/test-resources/**/*.json'
```

## 10. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Library name | `@ecruz165/context-loader-core` (matches `harness-core` convention) | Multiple consumers (cli, edge-context-server, harness-cli shim) — `-core` is appropriate suffix |
| D4 | Reuse harness-core orchestrator? | **No** | Wrong abstraction — ingestion is data flow, not agent invocation |
| D5 | Reuse `@ecruz165/agent-adapter` for vision/summarization? | **Yes** | `image-described` and `oss-issues` profile steps need LLM calls — use `createAgent` directly, not via runJob |
| D6 | Backend abstraction shape | One interface (`GraphIngestionBackend`), one production adapter (`Neo4jBackend`) used by both edge and central tiers | Engine unified to Neo4j on 2026-05-05; interface stays pluggable for future tiers. Matches `project_central_graph_store_choice.md`. |
| D11 | Source type catalog versioning | Catalog is part of `@ecruz165/context-loader-core`'s major version | New built-in source type = minor release. Renamed/removed = major release |
| D12 | License tracking on OSS sources | Yes — `license` is a required property on OSS-* node types | Tag, don't filter |
| D13 | Tree-sitter grammars distribution | Bundled with package (wasm) | Avoids per-machine install dance. v1 grammars: TS/JS/Java/Kotlin/Python/Go/Rust/C/C++ |
| D14 | Cross-source-type edges | Declared in source type schema; backend layer enforces | Otherwise the union schema across types becomes implicit — fragile |

### Open

| # | Question |
|---|---|
| O1 | **Auto-detect deps from `package.json`/`pom.xml`?** Walks the manifest, registers each dep as an `oss-code` source automatically. **Lean: explicit `agentx-load oss add` for v1; auto-detect for v1.x.** |
| O2 | **Profile inheritance vs override syntax** — should user configs use `extends: builtin-id` (single inheritance) or merge-deep (additive)? **Lean: single inheritance for v1.** |
| O3 | **Schema migrations** — when a source type's graph schema changes between versions, how does an existing graph get migrated? **Lean: out of scope for v1; require `agentx-load <source> --rebuild` to drop and re-ingest.** |
| O4 | **Multi-version coexistence** — store multiple versions of the same OSS dep simultaneously (`react@17` + `react@18`)? **Lean: yes for v1.x; only-active-version for v1.** |
| O5 | **Refresh semantics** — `refresh` does what exactly? **Lean: incremental via content-hash dedup (no work for unchanged content).** |
| O6 | **GitHub rate-limit handling for `oss-issues`** — backoff, reduce concurrency, or fail-loud? **Lean: backoff on 429; fail-loud on auth errors.** |
| O7 | **Sandboxing user chunkers** — when v1.x adds user-defined chunkers, do we sandbox them (worker_threads) or trust them (eval)? **Lean: out of scope for v1.** |

## 11. Implementation Phases

**Phase A — Skeleton + types** (~1 day)
1. Package skeleton (`packages/context-loader-core`).
2. Public-API types: `GraphNode`, `GraphEdge`, `SourceType`, `SourceTypeId`, `IngestionEvent`, `GraphIngestionBackend`.
3. `BUILTIN_SOURCE_TYPES` registry stub (just the ids + matcher patterns; no chunkers yet).

**Phase B.0 — prose-markdown end-to-end (DONE 2026-05-05)** (~1 day)
4. `prose-markdown` source type with heading-based chunker, glob matcher, walker.
5. `InMemoryGraphBackend` (test-only).
6. `ingest()` pipeline + OpenAI-compat embedder client.
7. 21 vitest tests covering chunker, matcher, ingest pipeline, in-memory search.

**Phase B.1 — `Neo4jBackend` + smoke test against real edge** (~2 days)
8. `Neo4jBackend` using the official `neo4j-driver` (Bolt protocol). Maps `ensureSchema(SourceTypeSchema)` to `CREATE CONSTRAINT` per node label + `CREATE VECTOR INDEX` for vector-bearing labels (1024-dim, cosine). Maps bulk upserts to `UNWIND $rows MERGE ... ON CREATE SET ... ON MATCH SET ...` patterns.
9. Smoke test: same prose-markdown corpus ingests cleanly into both `InMemoryGraphBackend` (test) and `Neo4jBackend` (against the local `neo4j-edge` compose sidecar); same node/edge/vector counts.
10. Local `neo4j-edge` sidecar in `workspace-template/.devcontainer/docker-compose.yml`: `neo4j:5-community`, persistent volume, accessible at `bolt://neo4j-edge:7687` from siblings.

**Phase B.2 — `code-full` source type** (~2 days)
11. Tree-sitter integration (TS + Python grammars first; rest of catalog list in Phase C).
12. Function/class chunker; skeleton-vs-body extraction.
13. Smoke test: `ingest({ source: { type: 'code-full', path: './packages/harness-core' }, backend: neo4j })` writes function nodes + skeleton/body relationships verifiably.

**Phase C — Source-type expansion** (~3 days)
14. `oss-code` source type (skeleton-only).
15. `oss-docs` source type (clone-or-crawl, version-aware).
16. `oss-issues` source type (GitHub API, curation filters).
17. Cross-source-type edge emission (`Documents`, `FixedIn`, `Mentions`).
18. Smoke test: ingest `react@18.2.0` triple; verify graph has cross-references.

**Phase D — Multi-media + secondary types** (~2 days)
19. `image-described` (uses `agent-adapter` to call vision LLM at `http://agent-vl:8080`).
20. `pdf` (text + scanned fallback).
21. `crawled-web` (Mozilla Readability extraction).
22. `structured-schema`, `config` source types.

**Phase E — Tests + docs** (~2 days)
23. Unit tests (chunkers, matchers — most done in Phase B.0).
24. Integration tests (Neo4j round-trips, multi-source-type cross-edges).
25. e2e test (full repo).
26. README; usage examples.

**Total estimate: ~12 focused days for the lib v1.** Reduced from 13 because the original Phase C (multi-backend) collapsed to a single `Neo4jBackend` once the engine was unified.

CLI integration (binary `agentx-load`, harness-cli shim, job-mode UDS protocol) is in `prd-context-loader-cli.md`'s Implementation Phases, ~2 additional days on top.

## 12. Future Work (v2+)

- **Multi-model embedding** (D10 evolved) — different embedders for different source types; multiple vector indexes per node.
- **Incremental refresh** (O5 evolved) — file-watcher daemon mode that re-ingests on changes.
- **User-defined chunkers** (O7) — plugin system for new chunkers without core releases.
- **Auto-detect deps from manifests** (O1) — walks `package.json`/`pom.xml`/`Cargo.toml` and offers OSS sources as a batch.
- **Late-interaction retrieval** (ColPali-style) — different storage shape; v2 if quality demands it.
- **Schema migrations** (O3) — automated graph migrations on source-type schema bumps.
- **Multi-version coexistence** (O4) — query-time version filtering across multiple ingested versions of the same OSS dep.
- **Telemetry** — emit metrics (chunks/sec, embedder latency, backend throughput) to Prometheus or similar.

## 13. Out-of-Scope Forever (intentional)

- **MCP support of any kind.** Same blanket constraint as agent-adapter-lib.
- **Synchronous read API.** This package writes; reading happens elsewhere.
- **Embedding API hosting.** The package is a *client* of an embedder service.
- **Pipeline orchestration.** Not a generic pipeline engine. harness-core handles agent pipelines.
- **Schema design service.** Source-type graph schemas are declared per type; the loader doesn't infer or evolve schemas at runtime.
- **Bundling embedder models.** The package never ships LLM weights or embedding-model files.

## 14. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `@ecruz165/agent-auth` | `CredentialBroker` for GitHub/Jira/Confluence ingestion | **Hard** |
| `@ecruz165/agent-adapter` | When a source-type step needs an LLM (vision for `image-described`, optional summarization for `oss-issues`) | **Hard** |
| `tree-sitter` (Node binding) + per-language grammars | AST chunking | **Hard** |
| `neo4j-driver` | `Neo4jBackend` (the only production adapter) | **Hard** |
| `cheerio` + `@mozilla/readability` | HTML extraction for `crawled-web` | **Soft** |
| `pdfjs-dist` | PDF parsing for `pdf` source type | **Soft** |
| `js-yaml` | `context-sources.yml` parsing | **Hard** |
| `zod` | Config schema validation | **Hard** |

---

*End of Context Loader Core PRD.*
