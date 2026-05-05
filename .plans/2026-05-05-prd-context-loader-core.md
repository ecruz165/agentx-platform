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

A standalone TypeScript library (`@agentx/context-loader-core`) that defines **how content becomes typed graph data + vectors** for both the edge tier (Kuzu) and the central tier (Neo4j). The library:

- Enumerates a catalog of **context source types**, each with its own matcher, chunker, graph schema, and embedder selection.
- Chunks content via type-specific strategies (tree-sitter AST for code, heading-based for prose, per-page for PDFs, etc.).
- Embeds chunks via an OpenAI-compatible HTTP endpoint (jina-v3 via TEI in the default workspace).
- Writes nodes/edges/vectors via a pluggable `GraphIngestionBackend` interface (Kuzu for edge, Neo4j for central — same loader code, different sinks).
- Emits structured `IngestionEvent`s for progress observability.

The library is consumed by:
- `@agentx/context-loader-cli` — the standalone CLI binary `agentx-load`
- `@agentx/edge-context-server` — for HTTP-triggered ingestion routes
- `@agentx/harness-cli` — for the `harness context source <verb>` workspace shim

**Why now:** The local stack has reached infrastructure completeness (compose with embedder + agent-llm sidecars, OpenCode adapter that supports custom HTTP endpoints). The next step is making the context graph actually populated. Without a coherent loader, each ingestion path (repo / upload / crawl / external) would be implemented separately inside edge-context-server with no shared abstraction.

The library introduces the concept of **context sources** — typed inputs from which the system loads content into the context graph — and **source types** — the per-content-type rules describing how each kind of source should be chunked, structured, and embedded.

## 2. Goals (v1)

- **Concept-first design.** The vocabulary the library exposes is *context sources* and *source types*; implementation terms (chunking strategy, embedder URL, graph schema) are second-order.
- **Source type catalog with distinct rules per type.** A profile catalog where each entry has its own matcher, chunker, graph schema, and embedder selection. No universal pipeline pretending to handle every content type.
- **Pluggable backend.** A `GraphIngestionBackend` interface with two adapters (`KuzuIngestionBackend` for edge, `Neo4jIngestionBackend` for central). Same source-type code emits the same node/edge/vector writes; the backend translates to its query language.
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
- **Not a CLI.** All CLI concerns (binary names, flag parsing, help text, install/distribution, job-mode UDS protocol) belong to `@agentx/context-loader-cli`. See its PRD.

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
- *As edge-context-server*, when a `POST /v1/sources/add` request arrives, I call `ingest({ source: req.body, backend: localKuzu, embedder: cfg.embedder, onEvent: (e) => stream.write(e) })` and pipe events back to the client as SSE.
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
| F9 | Profile spec is YAML, Zod-validated. Schema is exported from `@agentx/context-loader-core/schema`. Invalid configs throw `SourceTypeValidationError` with path-rooted messages on the first invocation that touches them. |
| F10 | Built-in chunkers are referenced by id in user configs (`chunker: { type: tree-sitter, granularity: function-class, ... }`). User-defined chunkers (out of scope for v1) would require code registration. |
| F11 | The catalog supports config inheritance: a user-defined source type can extend a built-in (`extends: code-full`) and override specific fields. |

### 6.3 Backend abstraction

| ID | Requirement |
|---|---|
| F12 | Single TypeScript interface `GraphIngestionBackend` with `upsertNode`, `upsertEdge`, `upsertVector`, plus bulk variants and `ensureSchema(profile)`. |
| F13 | **Three backend implementations ship in v1**, all conforming to `GraphIngestionBackend`. Selection is by URL scheme passed via config or `--backend` flag: |
| F13a | `KuzuDirectBackend` (`kuzu://path/to/dir`) — opens the Kuzu DB file in the loader's process. **Single-writer; NOT concurrent-safe.** Use for standalone solo invocations only. Two CLIs targeting the same Kuzu directory will fight over file locks. |
| F13b | `KuzuViaServerBackend` (`kuzu+uds:///path/to/context.sock` or `kuzu+http://host:port`) — writes via HTTP/UDS to a long-running edge-context-server that owns the Kuzu DB exclusively. **Concurrent-safe** — the server multiplexes concurrent client connections and serializes writes at its connection layer. This is the default when a workspace's triad is up (`harness context source add ...` uses this implicitly). |
| F13c | `Neo4jBackend` (`neo4j://host:port`, `bolt://...`, `neo4j+s://...`) — opens a Bolt protocol connection. **Concurrent-safe** — Neo4j's transaction layer serializes concurrent writes natively. Use for central-tier ingestion and any scenario with multiple concurrent CLIs writing to a shared graph. |
| F14 | Backend selection at runtime via programmatic config or CLI flag. Loader code paths are backend-agnostic — they emit `GraphNode`/`GraphEdge`/`Vector` records; the backend translates to Cypher / Kuzu's dialect. |
| F15 | Idempotent writes via content-hash dedup (per `prd-edge-context-server.md` F5). The backend computes content hashes per node and skips upserts when the hash matches an existing node. Re-running ingestion is safe. **Concurrent dedup**: when multiple CLIs ingest overlapping content simultaneously, content-hash upserts converge to the same final state regardless of write order. No special coordination needed. |
| F16 | Backend implementations handle their own connection pooling, transaction batching, and error retries. The loader engine treats the backend as a write-only sink with `Promise<void>` return on each upsert (for backpressure). |
| F16a | **Concurrent CLI execution is a first-class supported pattern.** Multiple `agentx-load` processes (or multiple `harness submit ingest` jobs) writing to the same target backend MUST work without coordination beyond what the backend provides. Choosing the right backend is the user's responsibility: KuzuDirect for solo, KuzuViaServer for local concurrent, Neo4j for central or production concurrent. |

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
| F32 | **`image-described`**: Two-stage. Image → vision LLM (calls `agent-vl` Docker service via OpenAI-compatible HTTP at `http://agent-vl:8080`) → description text → embedder → vector. The vision LLM call uses `@agentx/agent-adapter`'s `createAgent` directly with the local-endpoint config, NOT through harness-core's orchestrator. |
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
| Per-node graph upsert (Kuzu local) | <2ms | <10ms |
| Per-node graph upsert (Neo4j Bolt over LAN) | <20ms | <80ms |
| Tree-sitter parse of a 50KB TS file | <200ms | <500ms |

### 7.2 Throughput targets

| Configuration | Throughput |
|---|---|
| Single ingestion run, jina-v3 via TEI CPU, code-full profile | ~50-150 chunks/s end-to-end |
| 4 parallel runs, shared TEI sidecar | ~150-400 chunks/s aggregate (fan-in at embedder) |
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
// @agentx/context-loader-core
import { ingest, ingestOssDep, type SourceTypeId, type GraphIngestionBackend, type IngestionEvent } from '@agentx/context-loader-core';

// Programmatic API — single source ingestion
await ingest({
  source: { type: 'code-full', path: '/path/to/repo' },
  backend: new KuzuIngestionBackend({ path: '/data/context' }),
  embedder: { url: 'http://localhost:8080/v1', model: 'jinaai/jina-embeddings-v3', dim: 1024 },
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
# Default embedder for all source types unless overridden per-type
embedder:
  url: http://embedder:8080/v1     # service-name DNS in compose
  model: jinaai/jina-embeddings-v3
  dim: 1024

# Default backend (consumed by CLI; lib takes the backend programmatically)
backend:
  type: kuzu
  path: ./data/context
  # OR
  # type: neo4j
  # uri: neo4j://localhost:7687
  # username: neo4j

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
| D1 | Library name | `@agentx/context-loader-core` (matches `harness-core` convention) | Multiple consumers (cli, edge-context-server, harness-cli shim) — `-core` is appropriate suffix |
| D4 | Reuse harness-core orchestrator? | **No** | Wrong abstraction — ingestion is data flow, not agent invocation |
| D5 | Reuse `@agentx/agent-adapter` for vision/summarization? | **Yes** | `image-described` and `oss-issues` profile steps need LLM calls — use `createAgent` directly, not via runJob |
| D6 | Backend abstraction shape | One interface, two adapters (Kuzu, Neo4j) | Same loader code, different sinks. Matches `project_central_grounding_bidirectional.md` |
| D11 | Source type catalog versioning | Catalog is part of `@agentx/context-loader-core`'s major version | New built-in source type = minor release. Renamed/removed = major release |
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

**Phase B — Two source types end-to-end** (~3 days)
4. `code-full` source type with TS + Python tree-sitter grammars.
5. `prose-markdown` source type.
6. `KuzuIngestionBackend` (writes to a local Kuzu directory).
7. Smoke test: `ingest({ source: { type: 'code-full', path: './packages/harness-core' }, backend: kuzu })` writes nodes/edges/vectors verifiably.

**Phase C — Backend pluggability** (~2 days)
8. `Neo4jIngestionBackend` (Bolt protocol).
9. Smoke test: same source ingests cleanly into both Kuzu and Neo4j; same node counts.

**Phase D — OSS triple** (~3 days)
10. `oss-code` source type (skeleton-only).
11. `oss-docs` source type (clone-or-crawl, version-aware).
12. `oss-issues` source type (GitHub API, curation filters).
13. Cross-source-type edge emission (`Documents`, `FixedIn`, `Mentions`).
14. Smoke test: ingest `react@18.2.0` triple; verify graph has cross-references.

**Phase E — Multi-media + secondary types** (~2 days)
15. `image-described` (uses `agent-adapter` to call vision LLM at `http://agent-vl:8080`).
16. `pdf` (text + scanned fallback).
17. `crawled-web` (Mozilla Readability extraction).
18. `structured-schema`, `config` source types.

**Phase F — Tests + docs** (~2 days)
19. Unit tests (chunkers, matchers).
20. Integration tests (Kuzu + Neo4j round-trips).
21. e2e test (full repo).
22. README; usage examples.

**Total estimate: ~13 focused days for the lib v1.**

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
| `@agentx/agent-auth-lib` | `CredentialBroker` for GitHub/Jira/Confluence ingestion | **Hard** |
| `@agentx/agent-adapter` | When a source-type step needs an LLM (vision for `image-described`, optional summarization for `oss-issues`) | **Hard** |
| `tree-sitter` (Node binding) + per-language grammars | AST chunking | **Hard** |
| `kuzu` (Node binding) | `KuzuIngestionBackend` | **Soft** (only required if Kuzu backend selected at runtime) |
| `neo4j-driver` | `Neo4jIngestionBackend` | **Soft** |
| `cheerio` + `@mozilla/readability` | HTML extraction for `crawled-web` | **Soft** |
| `pdfjs-dist` | PDF parsing for `pdf` source type | **Soft** |
| `js-yaml` | `context-sources.yml` parsing | **Hard** |
| `zod` | Config schema validation | **Hard** |

---

*End of Context Loader Core PRD.*
