/**
 * @ecruz165/context-loader-core — public barrel.
 *
 * Phase A: types + catalog stubs. Programmatic ingest() lands in Phase B.
 *
 * See:
 *   - .plans/2026-05-05-prd-context-loader-core.md (lib design)
 *   - .plans/2026-05-05-prd-context-loader-cli.md (CLI design; this lib's primary consumer)
 */

// Backends
export { InMemoryGraphBackend, Neo4jBackend, type Neo4jBackendOptions } from './backends/index.ts';

// Built-in catalog
export {
  BUILTIN_SOURCE_TYPE_IDS,
  BUILTIN_SOURCE_TYPES,
  getBuiltinSourceType,
} from './catalog/index.ts';
export type {
  ChunkInput,
  ChunkOutput,
} from './core/chunkers/heading-based.ts';
// Chunkers (for direct programmatic use; ingest() picks them automatically)
export { chunkHeadingBased } from './core/chunkers/heading-based.ts';
export type {
  CodeFullChunkInput,
  CodeFullChunkOutput,
} from './core/chunkers/tree-sitter.ts';
export { chunkCodeFull, pickGrammar } from './core/chunkers/tree-sitter.ts';
export type {
  WholeFileChunkInput,
  WholeFileChunkOutput,
} from './core/chunkers/whole-file.ts';
export { chunkWholeFile } from './core/chunkers/whole-file.ts';
// Embedder client (for consumers wiring custom HTTP clients or mocks)
export {
  createHttpEmbedderClient,
  type EmbedderClient,
  EmbedderError,
  type FetchFn,
} from './core/embedder-client.ts';
// Phase B.0 — real ingest() for prose-markdown via path sources.
// Other source types throw with explicit "not yet implemented" until
// Phase B.1+ wires tree-sitter / crawl / API sources.
export { ingest } from './core/ingest.ts';
// Semantic-domain classifier (Tier 2 — deterministic domain tagging)
export { classifyDomain, DOMAINS, type Domain } from './core/domain.ts';
// Matcher + walker (lower-level, for custom orchestration)
export { compileMatcher, type MatcherFn, type MatcherSpec } from './core/matcher.ts';
// OSS provenance (manifest → Package + Version + BelongsTo nodes/edges)
export {
  buildProvenanceGraph,
  type OssPackageMeta,
  readOssPackageMeta,
} from './core/oss-meta.ts';
export { type WalkOptions, type WalkResult, walk } from './core/walk.ts';
// Public-API types (PRD §8)
export type {
  ChunkerRef,
  EmbedderConfig,
  GraphEdge,
  GraphIngestionBackend,
  GraphNode,
  IngestFn,
  IngestionEvent,
  IngestionSummary,
  IngestSpec,
  SourceRef,
  SourceType,
  SourceTypeId,
  SourceTypeMatcher,
  SourceTypeSchema,
} from './types.ts';
