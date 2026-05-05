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

// Phase A stub — fleshed out in Phase B with real chunker dispatch + backend writes
export async function ingest(): Promise<never> {
  throw new Error(
    'ingest() not yet implemented. Phase A ships types + catalog only; ' +
      'see .plans/2026-05-05-prd-context-loader-core.md §11 Phase B for the next milestone.'
  );
}
