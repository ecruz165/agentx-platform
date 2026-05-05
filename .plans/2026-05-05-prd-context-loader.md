# Context Loader — PRD

**Status:** Draft (2026-05-05)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `.plans/2026-04-30-prd-edge-context-server.md` — supersedes its F21/F22/F24/F26 ingestion semantics; the server now consumes this lib
- `.plans/2026-04-30-prd-agent-adapter-lib.md` — used when a source-type step needs an LLM call (e.g., `image-described`, `oss-issues` summarization)
- `.plans/2026-04-30-prd-auth-lib.md` (renamed `agent-auth-lib`) — `CredentialBroker` for GitHub/Jira/Confluence ingestion
- `.plans/2026-04-30-prd-harness-core.md` — explicitly NOT a consumer; ingestion is data flow, not agent orchestration

---

## 1. Purpose

Two new packages (`@agentx/context-loader-core` + `@agentx/context-loader-cli`) plus integrations into existing packages, that together define **how context sources become typed graph data + vectors** in the edge or central tier.

The package exists because today the existing edge-context-server PRD describes *what* gets ingested (F21 repos, F22 uploads, F24 external sources, F26 URL crawls) without committing to *how* that ingestion works. As we've layered on tree-sitter AST chunking (PRD F21), per-content-type rules (this design), embedder swappability (jina-v3 via TEI), and the local/central bidirectional grounding model (`project_central_grounding_bidirectional.md`), a single coherent ingestion abstraction is now load-bearing.

The package introduces the concept of **context sources** — typed inputs from which the system loads content into the context graph — and **source types** — the per-content-type rules describing how each kind of source should be chunked, structured, and embedded.

**Why now:** The local stack has reached infrastructure completeness (compose with embedder + agent-llm sidecars, OpenCode adapter that supports custom HTTP endpoints). The next step is making the context graph actually populated. Without a coherent loader, each ingestion path (repo / upload / crawl / external) would be implemented separately inside edge-context-server with no shared abstraction — leading to duplicated chunking logic, inconsistent graph schemas across source types, and no path to standalone-mode (loading into a Neo4j without the triad).

## 2. Goals (v1)

- **Concept-first design.** The user-facing vocabulary is *context sources* and *source types*; the CLI verbs (add, list, refresh, remove) operate on those nouns. Implementation terms (chunking strategy, embedder URL, graph schema) are second-order.
- **Source type catalog with distinct rules per type.** A profile catalog where each entry has its own matcher, chunker, graph schema, and embedder selection. No universal pipeline pretending to handle every content type.
- **Two CLI surfaces, one library.** `@agentx/context-loader-cli` ships a standalone binary `agentx-load` that works without the harness triad. `@agentx/harness-cli` exposes the same operations under `harness context source <verb>` for users already in a workspace. Both are thin wrappers around `@agentx/context-loader-core`.
- **Pluggable backend.** A `GraphIngestionBackend` interface with two adapters (`KuzuIngestionBackend` for edge, `Neo4jIngestionBackend` for central). Same source-type code emits the same node/edge/vector writes; the backend translates to its query language.
- **Two execution modes for the same CLI binary.** *Standalone:* runs in-process, writes directly to the configured backend, no triad needed. *Job mode:* invoked as a worker container's entrypoint by harness-server's `spawnWorker`; emits structured progress events back to JobBus over a UDS event channel; gets full lifecycle observability (cancellation, retry, status streaming to the TUI).
- **Tree-sitter AST as the dominant chunking strategy for code.** Function/class-level chunks for code source types; heading-based for prose; per-page for PDFs. Skeleton-only mode for OSS code reduces volume by ~10× without sacrificing usage-pattern retrieval.
- **Cross-source-type graph edges.** When the same symbol is described in `oss-code`, `oss-docs`, and `oss-issues`, the loader emits cross-source-type edges (`Documents`, `Mentions`, `FixedIn`) so retrieval can traverse code → docs → issue history in one query path. This is the qualitative leap over single-source ingestion.

## 3. Non-Goals (v1)

- **Not a query/retrieval layer.** This package writes; reading happens via edge-context-server's HTTP API or central Neo4j queries. Hybrid retrieval (vectors + graph traversal) is the consumer's responsibility.
- **Not multi-model embedding orchestration in v1.** Spec'd in the profile config (each source type can name an embedder URL + dim) but only one embedder model is actually used per workspace. Multi-model support is a v1.x optimization.
- **Not a tree-sitter grammar distribution mechanism.** Grammars are bundled per-language at build time; users don't install grammars separately. New language support requires a code release of `@agentx/context-loader-core`.
- **Not a long-running daemon.** Each loader invocation is one CLI process per "load run" (one CLI per job, per the spawn-worker integration). State persists in the graph backend, not in the loader process.
- **Not a generic file-walker / corpus indexer.** Source types are explicitly enumerated; matching files that don't fit any registered source type are logged-and-skipped, not silently embedded as fallback. Better to fail loudly than embed garbage.
- **Not a license-policy gate.** License is *tracked* on each ingested OSS node (`license: 'Apache-2.0'`); whether to ingest GPL code is a downstream policy decision, not the loader's call.
- **Not an MCP host.** Per repo-wide `feedback_no_mcp` policy. Tools that need MCP integration are out of scope.

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
| Memory `project_central_grounding_bidirectional.md` | Backend-agnostic write contract — same loader emits writes for both edge Kuzu and central Neo4j |

**Naming refactor:** Per the design discussion landing in this PRD, the term `graphrag` (as a CLI namespace and concept) is replaced by `context source`. The retrieval pattern (graph + RAG) keeps the academic name internally if useful, but user-facing surfaces use the new vocabulary. Existing PRD references to `graphrag` get updated.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Iris (installer / new user)** | Run `agentx-load <repo>` once on a laptop to populate a Neo4j or local Kuzu without setting up the harness triad. |
| **Daisy (developer at keyboard)** | From inside her workspace, add a new OSS dep to the context graph: `harness context source add --type oss-code react@18.2.0`. Get progress in the TUI. |
| **Owen (operator / SRE)** | Inspect what's in the context graph: `harness context source list`. Audit a problematic source type's ingest rules: `harness context source types describe oss-issues`. Refresh stale OSS issues nightly via cron. |
| **Maya (multi-tenant admin)** | Each tenant's context graph isolated; sources tagged with tenant id; central loader respects tenancy when writing to Neo4j. |
| **Future contributor** | Add a new source type (e.g., Slack-thread, Notion-page) by writing a profile entry + chunker + minimal documentation. Doesn't need to touch core loader engine. |

User stories:

- *As Iris*, I run `agentx-load https://github.com/openai/openai-cookbook --type oss-code --backend neo4j://localhost:7687`. The loader clones, walks, parses with tree-sitter, embeds via TEI, writes to Neo4j. I never run a triad.
- *As Daisy*, I run `harness context source add --type oss-code react@18.2.0`. The harness-server spawns a worker container running `agentx-load`. The TUI shows live progress: "1234 files walked, 5678 chunks embedded, 9 errors." I can press `c` to cancel the job.
- *As Owen*, I run `agentx-load oss refresh-issues react`. The loader fetches new closed-with-fix issues since the last run and incrementally adds them. The schedule runs from cron via `harness submit ingest --schedule daily`.
- *As Maya*, every node written by the loader carries `tenantId` from the worker's job context. Central Neo4j enforces tenant filtering at the application layer (per `project_central_graph_store_choice.md` — Community Edition has no DB-level RBAC).
- *As a future contributor*, I add `slack-thread` as a new source type by writing 60 lines: a matcher (Slack API URL pattern), a chunker (thread = parent chunk; replies = children), a graph schema (`SlackThread`, `SlackMessage` nodes; `RepliedTo`, `Mentions` edges). I register it in the profiles registry. It works.

## 6. Functional Requirements

### 6.1 Source Type Catalog (the "list of types")

| ID | Requirement |
|---|---|
| F1 | The package ships a built-in catalog of source types. v1 catalog (13 entries): `code-full`, `oss-code`, `prose-markdown`, `crawled-web`, `oss-docs`, `oss-issues`, `structured-schema`, `config`, `issue-tracker`, `image-described`, `pdf`, `learned`, `skip`. Each entry has its own `{ matcher, chunker, graph-schema, embedder?, options }`. |
| F2 | Each source type's matcher is per-file (or per-source-item for non-file inputs like URLs/issues): an include-glob list, an exclude-glob list, and an optional size cap. First-match-wins when a file matches multiple matchers; matcher order in the catalog defines precedence. |
| F3 | Each source type names a **chunker** by id (e.g., `tree-sitter`, `heading-based`, `issue-thread`, `pdf-page`, `whole-file`, `image-vision`). Chunkers are registered code; new types can either reuse an existing chunker with config or register a new one. |
| F4 | Each source type defines a **graph schema fragment**: which node labels it produces (e.g., `Function`, `Class`, `Module` for `code-full`) and which edge types it can emit (`Imports`, `Calls`, `Extends`, `SkeletonOf`). Cross-source-type edges (e.g., `code-full:Function ←Documents← oss-docs:Section`) are declared so the backend layer knows the union schema. |
| F5 | Each source type can override the default embedder (URL + model + dimension) for its content. v1: one embedder per workspace; the override field is spec'd but not used. |
| F6 | Source type ids are kebab-case. The catalog is exported as `BUILTIN_SOURCE_TYPES` and merged with user-provided extensions at load time (per F8). |
| F7 | One source type, `skip`, exists explicitly to enumerate file extensions and paths that should never be ingested under any other type (binaries, build artifacts, lock files, large fixtures). It produces no chunks; it documents the deny list. |

### 6.2 User-extensible profile spec

| ID | Requirement |
|---|---|
| F8 | Users can extend the catalog via `<workspace>/.harness/config/context-sources.yml` or `~/.agentx/context-sources.yml` (user-global). User entries are merged into the built-in catalog; user entries can override built-ins by id. |
| F9 | Profile spec is YAML, Zod-validated. Schema is exported from `@agentx/context-loader-core/schema`. Invalid configs throw `SourceTypeValidationError` with path-rooted messages on the first invocation that touches them. |
| F10 | Built-in chunkers are referenced by id in user configs (`chunker: { type: tree-sitter, granularity: function-class, ... }`). User-defined chunkers (out of scope for v1) would require code registration; v1 supports config-only customization of existing chunkers. |
| F11 | The catalog supports config inheritance: a user-defined source type can extend a built-in (`extends: code-full`) and override specific fields. Useful for project-specific tweaks (different exclude globs, different size caps). |

### 6.3 Backend abstraction

| ID | Requirement |
|---|---|
| F12 | Single TypeScript interface `GraphIngestionBackend` with `upsertNode`, `upsertEdge`, `upsertVector`, plus bulk variants and `ensureSchema(profile)`. |
| F13 | Two adapters ship with v1: `KuzuIngestionBackend` (writes to a local Kuzu directory or via UDS to edge-context-server), `Neo4jIngestionBackend` (writes via Bolt protocol to a Neo4j endpoint). |
| F14 | Backend selection at runtime via CLI flag (`--backend kuzu://path` or `--backend neo4j://host:port`) or programmatic config. Loader code paths are backend-agnostic — they emit `GraphNode`/`GraphEdge`/`Vector` records; the backend translates to Cypher / Kuzu's dialect. |
| F15 | Idempotent writes via content-hash dedup (per `prd-edge-context-server.md` F5). The backend computes content hashes per node and skips upserts when the hash matches an existing node. Re-running ingestion is safe. |
| F16 | Backend implementations handle their own connection pooling, transaction batching, and error retries. The loader engine treats the backend as a write-only sink with `Promise<void>` return on each upsert (for backpressure). |

### 6.4 Dual CLI surface

| ID | Requirement |
|---|---|
| F17 | `@agentx/context-loader-cli` ships a single binary `agentx-load`. Built with Bun for fast cold start. |
| F18 | `agentx-load` accepts subcommands matching the `harness context source` namespace: `add`, `list`, `describe`, `refresh`, `remove`, `crawl`, `upload`, `types` (with sub-subcommands). |
| F19 | Standalone mode: when invoked without harness-server reachable, the CLI writes directly to the configured backend. No triad required. |
| F20 | Job mode: when invoked as a worker container's entrypoint (detected via `JOB_ID` env + `--output-events-uds=<path>` flag), the CLI emits structured progress events to the named UDS instead of stdout. The harness-server bridges those events into JobBus → SSE → TUI. |
| F21 | `@agentx/harness-cli` exposes `harness context source <verb>` as a thin shim. Internally it either (a) imports `@agentx/context-loader-core` directly and executes in-process, or (b) shells out to `agentx-load` (for cancellation simplicity). v1 default: import-and-execute path; (b) is a fallback for future job submissions. |
| F22 | Help text for every subcommand explains the source type the verb operates on. `agentx-load --help` and `harness context source --help` produce equivalent output. |

### 6.5 Source-type-specific behaviors

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
| F34 | **`learned`**: Different lifecycle from other source types — written by harness-server's end-of-job evaluator phase, not by user-triggered ingestion. The loader exposes a programmatic API for this path: `loader.upsertLearning({ jobId, productId, content, derivedFrom })`. CLI surface for user-triggered ingestion of this type does not exist (it's not user-driven). |
| F35 | **`skip`**: Lists denylist patterns (`.exe`, `.zip`, `.pyc`, `.otf`, `.gz`, `.psd`, `.bmpr`, `.dll`, `.so`, `.dylib`, lock files, `.terraform/providers/**`). Files matching this type produce zero chunks; the matcher logs at debug level and continues. |

### 6.6 Standalone vs job mode integration

| ID | Requirement |
|---|---|
| F36 | Standalone mode is the default invocation: `agentx-load <args>` runs in the current process, writes to the configured backend, exits when done. No assumption of harness-server. |
| F37 | Job mode is detected via the `--output-events-uds=<path>` flag plus `JOB_ID` env. When present, the CLI: (a) routes structured events to the UDS instead of stdout, (b) uses `JOB_ID` as a job-tag on every emitted event, (c) catches `SIGTERM` for graceful cancellation. |
| F38 | harness-server's `spawnWorker` (per `packages/harness-server/src/spawn-worker.ts`) gains a code path for ingestion jobs: when a job's body has `kind: 'ingestion'`, the generated devcontainer override sets `agentx-load` as the entrypoint, mounts the workspace `.harness/run/` for the events UDS, and passes the source spec via env. |
| F39 | Job submission API: `harness submit ingest --type <source-type> <target>`. Internally constructs a job body `{ kind: 'ingestion', sourceType, target, profile?, options? }`, registers it via the existing `POST /v1/jobs` route, harness-server spawns the worker. |
| F40 | Multiple ingestion jobs run in parallel (one worker container each). All workers share the same embedder service (HTTP fan-in handled by TEI's `--max-concurrent-requests`). Backend writes serialize at the storage layer (Kuzu WAL or Neo4j Bolt session). |

### 6.7 Event types for progress streaming

| ID | Requirement |
|---|---|
| F41 | `IngestionEvent` is a discriminated union with at least these kinds: `source-resolved` (input → list of items to process), `item-walked` (per file/page/issue: `{ id, type, sizeBytes }`), `chunk-produced` (`{ chunkCount, totalTokens }`), `chunk-embedded` (`{ chunkId, vectorDim, embedderLatencyMs }`), `node-written` (`{ nodeId, label }`), `edge-written` (`{ from, to, type }`), `source-completed` (`{ filesIngested, chunksWritten, vectorsWritten, errors }`), `error` (`{ phase, item, message }`). |
| F42 | Events are JSON-serializable; the same shape works on stdout (standalone) and over UDS (job mode). |
| F43 | The TUI's events viewer (`harness jobs-tui`) and the in-process CLI (`harness:run`-style surface) consume `IngestionEvent` directly to render progress. The shape is shared in `@agentx/context-loader-core/events`. |

## 7. Non-Functional Requirements

### 7.1 Latency targets

| Operation | p95 (warm) | p99 (warm) |
|---|---|---|
| `agentx-load --help` cold start | <100ms | <250ms |
| Per-chunk embed roundtrip (CPU TEI) | <80ms | <200ms |
| Per-node graph upsert (Kuzu local) | <2ms | <10ms |
| Per-node graph upsert (Neo4j Bolt over LAN) | <20ms | <80ms |
| Tree-sitter parse of a 50KB TS file | <200ms | <500ms |

### 7.2 Throughput targets

| Configuration | Throughput |
|---|---|
| Standalone, jina-v3 via TEI CPU, code-full profile, 1 worker | ~50-150 chunks/s end-to-end |
| Job mode, 4 parallel workers, shared TEI sidecar | ~150-400 chunks/s end-to-end (fan-in at embedder) |
| Full skoolscout-com repo (~5K source files) | <5 min end-to-end |
| OSS dep skeleton-only ingestion (`react@18.2.0`) | <2 min |

### 7.3 Reliability

- Survives partial failures: a single file failing to parse doesn't abort the run; it produces an `error` event and the loader continues.
- Survives backend disconnects: the `GraphIngestionBackend` adapter retries transient failures with exponential backoff (default 3 attempts). Persistent failures abort the run with `error` event.
- Idempotent on re-run: content-hash dedup means re-running on an unchanged corpus is a no-op (mod hash computation).
- Cancellable: `SIGTERM` (job mode) or `SIGINT` (standalone) flushes in-flight buffers and exits cleanly within 5 seconds.

### 7.4 Resource

- Idle RSS: <100 MB (loader process; embedder service excluded).
- Active RSS during ingestion: <500 MB at typical workloads (chunk batches in memory).
- Per-grammar disk: ~5-20 MB (tree-sitter wasm binaries shipped with the package).

## 8. Public API

```ts
// @agentx/context-loader-core
import { ingest, type SourceTypeId, type GraphIngestionBackend } from '@agentx/context-loader-core';

// Standalone programmatic API
await ingest({
  source: { type: 'code-full', path: '/path/to/repo' },
  backend: new KuzuIngestionBackend({ path: '/data/context' }),
  embedder: { url: 'http://localhost:8080/v1', model: 'jinaai/jina-embeddings-v3', dim: 1024 },
  onEvent: (e) => console.log(e),
  signal: abortSignal,
});

// OSS-specific helpers
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

# Default backend
backend:
  type: kuzu                        # 'kuzu' | 'neo4j'
  path: ./data/context              # relative to workspace
  # OR
  # type: neo4j
  # uri: neo4j://localhost:7687
  # username: neo4j
  # password: ...

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
      maxFileBytes: 524288          # bump from 256KB to 512KB
    matcher:
      exclude:
        - '**/test-resources/**/*.json'   # project-specific exclude
```

## 10. CLI Surface

```bash
# Standalone CLI (binary: agentx-load)
agentx-load <target>                                    # auto-detect type
agentx-load --type code-full ./my-repo
agentx-load --type oss-code react@18.2.0
agentx-load oss add react@18.2.0                        # the trio of code/docs/issues
agentx-load oss add react@18.2.0 --only oss-code
agentx-load oss list
agentx-load oss refresh react

# Crawling
agentx-load crawl https://react.dev --scope site --max-depth 3

# Inspection
agentx-load list                                        # known sources
agentx-load describe <source-id>                        # what was ingested
agentx-load types                                       # built-in catalog
agentx-load types describe oss-code                     # rules for that type
agentx-load stats                                       # node/edge/vector counts

# Dry run
agentx-load dry-run <target>                            # what would happen, no writes

# Backend selection
agentx-load <target> --backend kuzu://./data/context
agentx-load <target> --backend neo4j://localhost:7687

# Workspace shim (in harness-cli)
harness context source add <target>
harness context source add --type oss-code react@18.2.0
harness context source list
harness context source describe <source-id>
harness context source refresh <source-id>
harness context source remove <source-id>
harness context source crawl <url>
harness context source upload <file>
harness context source types
harness context source types describe oss-code

# Submitting as a job (for parallelism + observability):
harness submit ingest --type oss-code react@18.2.0      # spawns worker container
```

## 11. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Library name | `@agentx/context-loader-core` (matches `harness-core` convention) | Multiple consumers (cli, edge-context-server, harness-cli shim) — `-core` is appropriate suffix |
| D2 | Standalone CLI name | `@agentx/context-loader-cli`, binary `agentx-load` | Verb describes action; pairs with the lib name |
| D3 | Concept naming | "context source" / "source type" | Aligns with existing `context` vocabulary; replaces `graphrag` |
| D4 | Reuse harness-core orchestrator? | **No** | Wrong abstraction — ingestion is data flow, not agent invocation |
| D5 | Reuse `@agentx/agent-adapter` for vision/summarization? | **Yes** | `image-described` and `oss-issues` profile steps need LLM calls — use `createAgent` directly, not via runJob |
| D6 | Backend abstraction shape | One interface, two adapters (Kuzu, Neo4j) | Same loader code, different sinks. Matches `project_central_grounding_bidirectional.md`'s "ship text to either tier" decision |
| D7 | Standalone vs job mode | Both supported; same binary | Standalone for solo use; job mode for engineering workflows. Feature-flagged via `--output-events-uds` presence |
| D8 | One CLI per job (in job mode) | Yes | Reuses spawn-worker pattern; no daemon; cancellation works via container kill |
| D9 | Multiple embedder *processes* | Spec'd via load balancer config; not used in v1 | TEI's `--max-concurrent-requests` handles ingestion-scale fan-in; LB only needed at much higher throughput |
| D10 | Multiple embedder *models* | Spec'd in profile config; not actually used in v1 | Single embedder per workspace simplifies storage + query routing. Multi-model is v1.x. |
| D11 | Source type catalog versioning | Catalog is part of `@agentx/context-loader-core`'s major version | New built-in source type = minor release. Renamed/removed = major release. |
| D12 | License tracking on OSS sources | Yes — `license` is a required property on OSS-* node types | Tag, don't filter. Downstream policy decides whether to ingest GPL. |
| D13 | Tree-sitter grammars distribution | Bundled with package (wasm) | Avoids per-machine install dance. Grammars for v1: TS/JS/Java/Kotlin/Python/Go/Rust/C/C++. |
| D14 | Cross-source-type edges | Declared in source type schema; backend layer enforces | Otherwise the union schema across types becomes implicit — fragile |

### Open

| # | Question |
|---|---|
| O1 | **Auto-detect deps from `package.json`/`pom.xml`?** Walks the manifest, registers each dep as an `oss-code` source automatically. **Lean: explicit `agentx-load oss add` for v1; auto-detect for v1.x.** |
| O2 | **Profile inheritance vs override syntax** — should user configs use `extends: builtin-id` (single inheritance) or merge-deep (additive)? **Lean: single inheritance for v1; clearer mental model.** |
| O3 | **Schema migrations** — when a source type's graph schema changes between versions, how does an existing graph get migrated? **Lean: out of scope for v1; require `agentx-load <source> --rebuild` to drop and re-ingest.** |
| O4 | **Multi-version coexistence** — store multiple versions of the same OSS dep simultaneously (`react@17` + `react@18`)? **Lean: yes for v1.x; only-active-version for v1 to avoid query-routing complexity.** |
| O5 | **Refresh semantics** — `refresh` does what exactly? Re-walks and only updates changed content? Drops old and re-ingests? **Lean: incremental via content-hash dedup (no work for unchanged content).** |
| O6 | **GitHub rate-limit handling for `oss-issues`** — backoff, reduce concurrency, or fail-loud? **Lean: backoff on 429; fail-loud on auth errors.** |
| O7 | **Sandboxing user chunkers** — when v1.x adds user-defined chunkers, do we sandbox them (worker_threads) or trust them (eval)? **Lean: out of scope for v1.** |

## 12. Implementation Phases

**Phase A — Skeleton + types** (~1 day)
1. Two-package skeleton (`packages/context-loader-core`, `packages/context-loader-cli`).
2. Public-API types in `core/types.ts` — `GraphNode`, `GraphEdge`, `SourceType`, `SourceTypeId`, `IngestionEvent`, `GraphIngestionBackend`.
3. `BUILTIN_SOURCE_TYPES` registry stub (just the ids + matcher patterns; no chunkers yet).

**Phase B — Two source types end-to-end** (~3 days)
4. `code-full` source type with TS + Python tree-sitter grammars.
5. `prose-markdown` source type.
6. `KuzuIngestionBackend` (writes to a local Kuzu directory).
7. `agentx-load` binary in standalone mode; emits events to stdout.
8. Smoke test: `agentx-load --type code-full ./packages/harness-core` writes to a Kuzu instance; verify nodes/edges/vectors are present.

**Phase C — Backend pluggability** (~2 days)
9. `Neo4jIngestionBackend` (Bolt protocol).
10. CLI flag `--backend` switches at runtime.
11. Smoke test: same source ingests cleanly into both Kuzu and Neo4j; same node counts.

**Phase D — OSS triple** (~3 days)
12. `oss-code` source type (skeleton-only).
13. `oss-docs` source type (clone-or-crawl, version-aware).
14. `oss-issues` source type (GitHub API, curation filters).
15. Cross-source-type edge emission (`Documents`, `FixedIn`, `Mentions`).
16. `agentx-load oss add` CLI surface end-to-end.
17. Smoke test: ingest `react@18.2.0` triple; verify graph has cross-references.

**Phase E — Multi-media + secondary types** (~2 days)
18. `image-described` (uses `agent-adapter` to call vision LLM at `http://agent-vl:8080`).
19. `pdf` (text + scanned fallback).
20. `crawled-web` (Mozilla Readability extraction).
21. `structured-schema`, `config` source types.

**Phase F — Job mode + workspace shim** (~2 days)
22. `--output-events-uds` flag in CLI; UDS event emitter.
23. harness-server gains `kind: 'ingestion'` job type discrimination in `spawnWorker`.
24. `harness submit ingest` command in harness-cli.
25. `harness context source <verb>` shim (imports `@agentx/context-loader-core`).

**Phase G — Polish + docs** (~2 days)
26. Tests: unit (chunkers, matchers), integration (Kuzu + Neo4j round-trips), e2e (full repo).
27. README in each package; examples in `examples/`.
28. Update `prd-edge-context-server.md` to reference this PRD for ingestion semantics.

**Total estimate: ~15 focused days for v1.**

**Sequencing notes:**
- Phase B unblocks 80% of agentic uses (own-code retrieval works).
- Phase D is the OSS-deps unlock — qualitative leap in agent capability.
- Phase F gates the harness-cli integration; until it lands, ingestion runs only standalone.

## 13. Future Work (v2+)

- **Multi-model embedding** (D10) — different embedders for different source types; multiple vector indexes per node.
- **Incremental refresh** (O5 evolved) — file-watcher daemon mode that re-ingests on changes; not just on-demand.
- **User-defined chunkers** (O7) — plugin system for new chunkers without core releases.
- **Auto-detect deps from manifests** (O1) — walks `package.json`/`pom.xml`/`Cargo.toml` and offers OSS sources as a batch.
- **Late-interaction retrieval** (ColPali-style) — different storage shape; v2 if quality demands it.
- **Schema migrations** (O3) — automated graph migrations on source-type schema bumps.
- **Multi-version coexistence** (O4) — query-time version filtering across multiple ingested versions of the same OSS dep.
- **Telemetry** — emit metrics (chunks/sec, embedder latency, backend throughput) to Prometheus or similar.

## 14. Out-of-Scope Forever (intentional)

- **MCP support of any kind.** Same blanket constraint as agent-adapter-lib. Sources that require MCP are rejected.
- **Synchronous read API.** This package writes; it does not read. Hybrid retrieval is the consumer's responsibility (edge-context-server provides HTTP query routes; central Neo4j has its own).
- **Embedding API hosting.** The package is a *client* of an embedder service (TEI / OpenAI-compatible). It does not run inference itself.
- **Pipeline orchestration.** This is not a generic pipeline engine. If a use case wants "chain step A → step B → step C with cancellation and observability," that's harness-core's job. The loader is a single-purpose data-ingestion tool.
- **Schema design service.** Source-type graph schemas are declared per type; the loader doesn't infer or evolve schemas at runtime.
- **Bundling embedder models.** The package never ships LLM weights or embedding-model files. Those are sidecar concerns.

## 15. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `@agentx/agent-auth-lib` | `CredentialBroker` for GitHub/Jira/Confluence ingestion | **Hard** |
| `@agentx/agent-adapter` | When a source-type step needs an LLM (vision for `image-described`, optional summarization for `oss-issues`) | **Hard** |
| `tree-sitter` (Node binding) + per-language grammars | AST chunking for `code-full`, `oss-code`, `structured-schema` | **Hard** |
| `kuzu` (Node binding) | `KuzuIngestionBackend` | **Soft** (only required if Kuzu backend selected) |
| `neo4j-driver` | `Neo4jIngestionBackend` | **Soft** |
| `cheerio` + `@mozilla/readability` | HTML extraction for `crawled-web` | **Soft** |
| `pdfjs-dist` | PDF parsing for `pdf` source type | **Soft** |
| `js-yaml` | `context-sources.yml` parsing | **Hard** |
| `zod` | Config schema validation | **Hard** |
| `commander` (or yargs) | CLI arg parsing in `context-loader-cli` | **Hard** (CLI package only) |
| Bun (runtime for CLI) | Fast cold-start; consistent with harness-cli's runtime choice | **Hard** (CLI package only) |

---

*End of Context Loader PRD.*
