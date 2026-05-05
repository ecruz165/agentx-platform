/**
 * Top-level ingest() — Phase B.0 implementation.
 *
 * Currently supports:
 *   - SourceRef.kind === 'path' with source type id 'prose-markdown'
 *
 * Planned (Phase B.1+):
 *   - 'code-full' source type via tree-sitter chunker
 *   - Other matched source types via dispatch on detected type
 *   - URL/package/issue-tracker sources
 *
 * Dispatch flow:
 *   1. Resolve source type (explicit or auto-detect from matcher)
 *   2. ensureSchema on backend
 *   3. Walk + match files (for path sources)
 *   4. Per file: read → chunker.split → embedder.embed → backend.upsertNode/Edge/Vector
 *   5. Emit IngestionEvent at each phase boundary
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { BUILTIN_SOURCE_TYPES } from '../catalog/index.ts';
import type {
  IngestSpec,
  IngestionSummary,
  SourceType,
} from '../types.ts';
import {
  chunkHeadingBased,
  type ChunkOutput,
} from './chunkers/heading-based.ts';
import { chunkCodeFull } from './chunkers/tree-sitter.ts';
import {
  createHttpEmbedderClient,
  type EmbedderClient,
} from './embedder-client.ts';
import { compileMatcher } from './matcher.ts';
import { walk } from './walk.ts';

/**
 * Minimal extension to IngestSpec for tests: allow injecting a pre-built
 * EmbedderClient instead of constructing one from `embedder.url`. Production
 * code should use `embedder` (config-driven); tests use `embedderClient`
 * (mock-driven).
 */
export interface IngestSpecExt extends IngestSpec {
  embedderClient?: EmbedderClient;
}

export async function ingest(spec: IngestSpecExt): Promise<IngestionSummary> {
  const startedAt = Date.now();
  const summary = {
    filesIngested: 0,
    chunksWritten: 0,
    vectorsWritten: 0,
    errors: 0,
  };

  const sourceType = resolveSourceType(spec.source.type);
  const embedder = await resolveEmbedder(spec);

  // Phase B.0/B.2 only handles path-rooted source refs.
  if (spec.source.ref.kind !== 'path') {
    throw new Error(
      `Phase B: only SourceRef { kind: 'path' } is implemented; got ${spec.source.ref.kind}`
    );
  }
  // Chunker dispatch — what's wired today: heading-based (B.0) and
  // tree-sitter (B.2). Other chunker types throw a clear "not yet
  // implemented" rather than silently producing zero chunks.
  const chunkerType = sourceType.chunker.type;
  if (chunkerType !== 'heading-based' && chunkerType !== 'tree-sitter') {
    throw new Error(
      `Phase B: source type '${sourceType.id}' uses chunker '${chunkerType}' which is not yet implemented`
    );
  }

  await spec.backend.ensureSchema(sourceType.graphSchema);

  const root = resolve(spec.source.ref.path);
  const matcher = compileMatcher(sourceType.matcher);

  // bodyExceptions: paths that should index with full bodies even when
  // the source type defaults to skeleton-only (oss-code uses this to
  // capture examples/ + READMEs at full fidelity while keeping the rest
  // of the dependency at ~10× compression). Compile once per ingest run;
  // re-used per-file in the dispatch below.
  const bodyExceptionsMatcher =
    sourceType.chunker.type === 'tree-sitter' &&
    sourceType.chunker.bodyExtraction === false &&
    Array.isArray(sourceType.chunker.bodyExceptions) &&
    sourceType.chunker.bodyExceptions.length > 0
      ? compileMatcher({ include: sourceType.chunker.bodyExceptions })
      : null;

  // Per-file processing
  for await (const item of walk({
    root,
    match: matcher,
    maxFileBytes: sourceType.matcher.maxFileBytes,
  })) {
    if (spec.signal?.aborted) {
      summary.errors += 1;
      spec.onEvent?.({
        kind: 'error',
        phase: 'walk',
        item: item.relativePath,
        message: 'aborted',
      });
      break;
    }

    spec.onEvent?.({
      kind: 'item-walked',
      itemId: item.relativePath,
      itemType: 'file',
      sizeBytes: item.sizeBytes,
    });

    let content: string;
    try {
      content = await readFile(item.absolutePath, 'utf8');
    } catch (err) {
      summary.errors += 1;
      spec.onEvent?.({
        kind: 'error',
        phase: 'read',
        item: item.relativePath,
        message: (err as Error).message,
      });
      continue;
    }

    const chunked: ChunkOutput =
      sourceType.chunker.type === 'heading-based'
        ? chunkHeadingBased({
            docId: item.relativePath,
            title: basename(item.relativePath),
            content,
            sourceTypeId: sourceType.id,
            sourceId: root,
            maxTokens: sourceType.chunker.maxTokens,
            overlapTokens: sourceType.chunker.overlapTokens,
          })
        : await chunkCodeFull({
            relativePath: item.relativePath,
            content,
            sourceTypeId: sourceType.id,
            sourceId: root,
            // Mode picks per-file:
            //   - bodyExtraction: true  → 'full' for everything
            //   - bodyExtraction: false → 'skeleton-only' by default,
            //     except paths matching bodyExceptions get 'full' (e.g.,
            //     examples/ + READMEs in oss-code)
            mode:
              sourceType.chunker.bodyExtraction === false
                ? bodyExceptionsMatcher && bodyExceptionsMatcher(item.relativePath)
                  ? 'full'
                  : 'skeleton-only'
                : 'full',
            // Source-type-declared label prefix. oss-code → 'Oss' so
            // emitted nodes (OssFile/OssFunction/OssClass) match the
            // schema's declared labels and the schema's vector indexes
            // actually contain rows.
            labelPrefix: sourceType.chunker.labelPrefix,
          });

    spec.onEvent?.({
      kind: 'chunk-produced',
      chunkId: item.relativePath,
      chunkCount: chunked.chunks.length,
      totalTokens: chunked.chunks.reduce(
        (acc: number, c: { text: string }) => acc + Math.ceil(c.text.length / 4),
        0
      ),
    });

    // Write nodes + edges
    await spec.backend.upsertNodesBulk(chunked.nodes);
    for (const node of chunked.nodes) {
      spec.onEvent?.({ kind: 'node-written', nodeId: node.id, label: node.label });
    }
    await spec.backend.upsertEdgesBulk(chunked.edges);
    for (const edge of chunked.edges) {
      spec.onEvent?.({
        kind: 'edge-written',
        from: edge.from,
        to: edge.to,
        type: edge.label,
      });
    }

    // Embed each chunk + write vectors
    if (chunked.chunks.length > 0) {
      const t0 = Date.now();
      const vectors = await embedder.embed(
        chunked.chunks.map((c: { text: string }) => c.text)
      );
      if (vectors.length !== chunked.chunks.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${chunked.chunks.length} chunks (file: ${item.relativePath})`
        );
      }
      const elapsed = Date.now() - t0;
      const items = chunked.chunks.map(
        (c: { nodeId: string; text: string }, i: number) => ({
          nodeId: c.nodeId,
          vector: vectors[i]!,
          meta: { sourceTypeId: sourceType.id, sourceId: root },
        })
      );
      await spec.backend.upsertVectorsBulk(items);
      for (const it of items) {
        spec.onEvent?.({
          kind: 'chunk-embedded',
          chunkId: it.nodeId,
          vectorDim: embedder.dim,
          latencyMs: Math.round(elapsed / chunked.chunks.length),
        });
      }
      summary.vectorsWritten += items.length;
    }

    summary.filesIngested += 1;
    summary.chunksWritten += chunked.chunks.length;
  }

  const durationMs = Date.now() - startedAt;
  spec.onEvent?.({
    kind: 'source-completed',
    filesIngested: summary.filesIngested,
    chunksWritten: summary.chunksWritten,
    vectorsWritten: summary.vectorsWritten,
    errors: summary.errors,
  });

  return { ...summary, durationMs };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function resolveSourceType(typeIdOrCustom: string): SourceType {
  if (typeIdOrCustom in BUILTIN_SOURCE_TYPES) {
    return BUILTIN_SOURCE_TYPES[typeIdOrCustom as keyof typeof BUILTIN_SOURCE_TYPES];
  }
  throw new Error(
    `Unknown source type '${typeIdOrCustom}'. v1 catalog: ${Object.keys(BUILTIN_SOURCE_TYPES).join(', ')}`
  );
}

async function resolveEmbedder(spec: IngestSpecExt): Promise<EmbedderClient> {
  if (spec.embedderClient) return spec.embedderClient;
  if (!spec.embedder) {
    throw new Error(
      'ingest() requires either spec.embedder (config) or spec.embedderClient (pre-built; for tests)'
    );
  }
  return createHttpEmbedderClient({ config: spec.embedder });
}
