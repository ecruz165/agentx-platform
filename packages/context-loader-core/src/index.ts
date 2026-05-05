/**
 * @agentx/context-loader-core — public barrel.
 *
 * Phase A: types + catalog stubs. Programmatic ingest() lands in Phase B.
 *
 * See:
 *   - .plans/2026-05-05-prd-context-loader-core.md (lib design)
 *   - .plans/2026-05-05-prd-context-loader-cli.md (CLI design; this lib's primary consumer)
 */

// Public-API types (PRD §8)
export type {
  SourceTypeId,
  SourceType,
  SourceTypeMatcher,
  SourceTypeSchema,
  SourceRef,
  EmbedderConfig,
  ChunkerRef,
  GraphNode,
  GraphEdge,
  GraphIngestionBackend,
  IngestionEvent,
  IngestSpec,
  IngestFn,
  IngestionSummary,
} from './types.ts';

// Built-in catalog
export {
  BUILTIN_SOURCE_TYPES,
  BUILTIN_SOURCE_TYPE_IDS,
  getBuiltinSourceType,
} from './catalog/index.ts';

// Phase B.0 — real ingest() for prose-markdown via path sources.
// Other source types throw with explicit "not yet implemented" until
// Phase B.1+ wires tree-sitter / crawl / API sources.
export { ingest } from './core/ingest.ts';

// Backends
export { InMemoryGraphBackend, Neo4jBackend, type Neo4jBackendOptions } from './backends/index.ts';

// Embedder client (for consumers wiring custom HTTP clients or mocks)
export {
  createHttpEmbedderClient,
  EmbedderError,
  type EmbedderClient,
  type FetchFn,
} from './core/embedder-client.ts';

// Chunkers (for direct programmatic use; ingest() picks them automatically)
export { chunkHeadingBased } from './core/chunkers/heading-based.ts';
export type {
  ChunkInput,
  ChunkOutput,
} from './core/chunkers/heading-based.ts';
export { chunkCodeFull, pickGrammar } from './core/chunkers/tree-sitter.ts';
export type {
  CodeFullChunkInput,
  CodeFullChunkOutput,
} from './core/chunkers/tree-sitter.ts';
export { chunkWholeFile } from './core/chunkers/whole-file.ts';
export type {
  WholeFileChunkInput,
  WholeFileChunkOutput,
} from './core/chunkers/whole-file.ts';

// Matcher + walker (lower-level, for custom orchestration)
export { compileMatcher, type MatcherFn, type MatcherSpec } from './core/matcher.ts';
export { walk, type WalkOptions, type WalkResult } from './core/walk.ts';

// OSS provenance (manifest → Package + Version + BelongsTo nodes/edges)
export {
  readOssPackageMeta,
  buildProvenanceGraph,
  type OssPackageMeta,
} from './core/oss-meta.ts';
