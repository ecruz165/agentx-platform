/**
 * Public API types for @agentx/context-loader-core.
 *
 * The shapes here are the contract between:
 *   - Consumers calling ingest() programmatically
 *   - The CLI (@agentx/context-loader-cli) wrapping them
 *   - Backend adapters (Neo4j) implementing GraphIngestionBackend
 *   - Source-type chunkers producing nodes/edges/vectors
 *
 * See .plans/2026-05-05-prd-context-loader-core.md §8 for the full design.
 */

// ─── Source types ─────────────────────────────────────────────────────────

/**
 * Stable id for each registered source type. The 13-entry v1 catalog is
 * declared in `./catalog/`; user extensions via context-sources.yml can
 * override built-ins or add new ids.
 */
export type SourceTypeId =
  | 'code-full'
  | 'oss-code'
  | 'prose-markdown'
  | 'crawled-web'
  | 'oss-docs'
  | 'oss-issues'
  | 'structured-schema'
  | 'config'
  | 'issue-tracker'
  | 'image-described'
  | 'pdf'
  | 'learned'
  | 'skip';

/**
 * Reference to a single ingestion target. The variants are the input shapes
 * for each source type — file path for code/prose, URL for crawl, package
 * spec for OSS, etc.
 */
export type SourceRef =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'package'; name: string; version: string; sourceRepo?: string }
  | { kind: 'github-issues'; owner: string; repo: string }
  | { kind: 'jira'; project: string; baseUrl: string };

/**
 * A registered source type — the per-content-type rules describing how the
 * loader should handle that kind of source. The full shape includes the
 * chunker fn and graph-schema declaration; this is the public-facing slice.
 */
export interface SourceType {
  /** Stable id (see SourceTypeId or user extensions). */
  id: string;
  /** Brief human-readable description. Shown by `agentx-load types`. */
  description: string;
  /** Default matcher (consumers can override via context-sources.yml). */
  matcher: SourceTypeMatcher;
  /** Declared graph schema this type produces (for backend ensureSchema()). */
  graphSchema: SourceTypeSchema;
  /** Optional embedder override; falls back to workspace default if absent. */
  embedder?: EmbedderConfig;
  /** Implementation-detail chunker reference; see ./core/chunkers/. */
  chunker: ChunkerRef;
  /**
   * Provenance scheme — runs once per ingest before the per-file loop,
   * emitting tier-anchor nodes that the chunker's outputs link back to.
   *
   *   - `'oss-package'` — read package.json (or future Cargo.toml,
   *     pom.xml, …) at the source root; emit Package + Version + a
   *     BelongsTo edge per File. Used by oss-code and oss-docs.
   *   - undefined — no provenance preamble (default for first-party
   *     code-full + workspace prose-markdown).
   */
  provenance?: 'oss-package';
}

export interface SourceTypeMatcher {
  /** Glob patterns relative to the source root. Matched in order. */
  include?: string[];
  /** Patterns to exclude (build outputs, binaries, fixtures). */
  exclude?: string[];
  /** Optional max bytes per file; files larger are skipped + logged. */
  maxFileBytes?: number;
}

export interface SourceTypeSchema {
  /** Node labels this source type produces. */
  nodes: string[];
  /** Edge labels this source type emits. */
  edges: string[];
  /**
   * Cross-source-type edges this type emits *into* other types' nodes.
   * E.g., oss-docs declares `Documents` edges into oss-code's `OssFunction`
   * nodes. Backend layer uses this to set up the union schema.
   */
  crossTypeEdges?: Array<{
    edge: string;
    targetSourceTypeId: string;
    targetNodeLabel: string;
  }>;
}

export interface EmbedderConfig {
  /** OpenAI-compatible HTTP endpoint (e.g., http://embedder:8080/v1). */
  url: string;
  /** Model id to pass to /v1/embeddings (e.g., 'ai/qwen3-embedding' locally, 'bedrock-titan-v2' via LiteLLM). */
  model: string;
  /** Output vector dimension (must match the backend's vector index). */
  dim: number;
}

/**
 * Chunker references — the concrete implementations live under
 * ./core/chunkers/. Phase A only ships the type stub; Phase B implements.
 */
export type ChunkerRef =
  | {
      type: 'tree-sitter';
      granularity: 'function-class' | 'module';
      skeletonExtraction?: boolean;
      bodyExtraction?: boolean;
      bodyExceptions?: string[];
      grammars?: string[];
      /**
       * Optional prefix prepended to every chunker-emitted node label.
       * `oss-code` sets this to 'Oss' so its chunker emits OssFile /
       * OssFunction / OssClass instead of plain File / Function / Class.
       * Aligns with the source type's declared graphSchema; without
       * this, the schema's vector indexes would be created on labels
       * the chunker never produces (the indexed labels are empty).
       * Default: '' (no prefix; first-party code keeps File/Function/Class).
       */
      labelPrefix?: string;
    }
  | {
      type: 'heading-based';
      maxTokens?: number;
      overlapTokens?: number;
      /**
       * Optional prefix prepended to the Doc + Section node labels
       * (mirrors the tree-sitter chunker's labelPrefix from Phase C.3).
       * `oss-docs` sets this to 'Oss' so emitted nodes (OssDoc /
       * OssSection) match its declared graphSchema. Default '': plain
       * Doc / Section labels for prose-markdown.
       */
      labelPrefix?: string;
    }
  | { type: 'whole-file' }
  | { type: 'pdf-page'; visionFallback?: boolean }
  | { type: 'image-vision' }
  | { type: 'issue-thread'; issueBodyMinChars?: number; commentMinChars?: number }
  | { type: 'crawler'; scope?: 'page' | 'subtree' | 'site'; maxDepth?: number; rateLimitPerHost?: number };

// ─── Graph data shapes ────────────────────────────────────────────────────

/**
 * A node to be upserted into the graph. The backend translates these
 * into Cypher executed via the Neo4j Bolt driver.
 */
export interface GraphNode {
  /** Stable id (typically content-hash-derived for dedup). */
  id: string;
  /** Node label (e.g., 'Function', 'OssDocSection'). */
  label: string;
  /** Free-form properties; backend serializes to JSON / native types. */
  properties: Record<string, unknown>;
  /** Required for OSS source types: license (e.g., 'Apache-2.0'). Tag, don't filter. */
  license?: string;
  /** Source type that produced this node (for filtering/cleanup). */
  sourceTypeId: string;
  /** Logical source id (e.g., 'react@18.2.0', 'workspace-skoolscout-com'). */
  sourceId: string;
}

/**
 * An edge to be upserted.
 */
export interface GraphEdge {
  /** From node id. */
  from: string;
  /** To node id. */
  to: string;
  /** Edge label (e.g., 'Imports', 'Documents', 'FixedIn'). */
  label: string;
  /** Free-form properties. */
  properties?: Record<string, unknown>;
  /** Source type that emitted this edge. */
  sourceTypeId: string;
}

// ─── Backend abstraction ──────────────────────────────────────────────────

export interface GraphIngestionBackend {
  /** Idempotent node upsert (content-hash dedup at backend level). */
  upsertNode(node: GraphNode): Promise<void>;
  /** Idempotent edge upsert. */
  upsertEdge(edge: GraphEdge): Promise<void>;
  /**
   * Idempotent vector upsert. Vector is associated with a node; backend
   * stores in its native vector index.
   */
  upsertVector(
    nodeId: string,
    vector: Float32Array,
    meta: Record<string, unknown>
  ): Promise<void>;

  // Bulk variants (preferred for throughput; backend may batch).
  upsertNodesBulk(nodes: GraphNode[]): Promise<void>;
  upsertEdgesBulk(edges: GraphEdge[]): Promise<void>;
  upsertVectorsBulk(
    items: Array<{ nodeId: string; vector: Float32Array; meta: Record<string, unknown> }>
  ): Promise<void>;

  /**
   * Ensure the backend has the schema this source type needs (vector index
   * on the right node label, etc.). Idempotent; called once per source type
   * at the start of an ingestion run.
   */
  ensureSchema(schema: SourceTypeSchema): Promise<void>;

  /** Flush buffers and close connections. */
  close(): Promise<void>;
}

// ─── Ingestion events ─────────────────────────────────────────────────────

/**
 * Structured progress events emitted during an ingestion run. Same shape
 * works on stdout (standalone CLI), over UDS (job-mode CLI), and over
 * HTTP/SSE (when consumed by edge-context-server's ingestion routes).
 */
export type IngestionEvent =
  | { kind: 'source-resolved'; source: SourceRef; itemCount: number }
  | { kind: 'item-walked'; itemId: string; itemType: string; sizeBytes: number }
  | { kind: 'chunk-produced'; chunkId: string; chunkCount: number; totalTokens: number }
  | { kind: 'chunk-embedded'; chunkId: string; vectorDim: number; latencyMs: number }
  | { kind: 'node-written'; nodeId: string; label: string }
  | { kind: 'edge-written'; from: string; to: string; type: string }
  | {
      kind: 'source-completed';
      filesIngested: number;
      chunksWritten: number;
      vectorsWritten: number;
      errors: number;
    }
  | { kind: 'error'; phase: string; item?: string; message: string };

// ─── Top-level ingestion API ──────────────────────────────────────────────

export interface IngestSpec {
  /** What to ingest. */
  source: { type: SourceTypeId | string; ref: SourceRef };
  /** Where to write. */
  backend: GraphIngestionBackend;
  /** Embedder service (defaults to workspace embedder if absent). */
  embedder?: EmbedderConfig;
  /** Event callback (stdout printer, UDS writer, SSE bridge). */
  onEvent?: (event: IngestionEvent) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Programmatic entry point. Phase A: not yet implemented (throws).
 * Phase B: implements code-full + prose-markdown end-to-end.
 */
export type IngestFn = (spec: IngestSpec) => Promise<IngestionSummary>;

export interface IngestionSummary {
  filesIngested: number;
  chunksWritten: number;
  vectorsWritten: number;
  errors: number;
  durationMs: number;
}
