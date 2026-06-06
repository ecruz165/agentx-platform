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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { BUILTIN_SOURCE_TYPES } from '../catalog/index.ts';
import type { IngestionSummary, IngestSpec, SourceType } from '../types.ts';
import { type ChunkOutput, chunkHeadingBased } from './chunkers/heading-based.ts';
import { classifyDomain } from './domain.ts';
import { chunkCodeFull } from './chunkers/tree-sitter.ts';
import { chunkWholeFile } from './chunkers/whole-file.ts';
import { createHttpEmbedderClient, type EmbedderClient } from './embedder-client.ts';
import { compileMatcher } from './matcher.ts';
import { buildProvenanceGraph, readOssPackageMeta } from './oss-meta.ts';
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
    filesSkipped: 0,
    chunksWritten: 0,
    vectorsWritten: 0,
    errors: 0,
  };

  const sourceType = resolveSourceType(spec.source.type);
  const embedder = await resolveEmbedder(spec);

  // Phase B.0/B.2 only handles path-rooted source refs.
  if (spec.source.ref.kind !== 'path') {
    throw new Error(
      `Phase B: only SourceRef { kind: 'path' } is implemented; got ${spec.source.ref.kind}`,
    );
  }
  // Chunker dispatch — what's wired today: heading-based (B.0),
  // tree-sitter (B.2), whole-file (learned source type). Other types
  // throw a clear "not yet implemented" rather than silently producing
  // zero chunks.
  const chunkerType = sourceType.chunker.type;
  if (
    chunkerType !== 'heading-based' &&
    chunkerType !== 'tree-sitter' &&
    chunkerType !== 'whole-file'
  ) {
    throw new Error(
      `Phase B: source type '${sourceType.id}' uses chunker '${chunkerType}' which is not yet implemented`,
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

  // Provenance preamble: when the source type opts into 'oss-package'
  // provenance, read its manifest (package.json today; Cargo.toml /
  // pom.xml in future slices) and emit Package + Version nodes once
  // before the per-file loop. Each File then gets a BelongsTo → Version
  // edge below. Ingesting a directory without a manifest still works
  // — provenance is just skipped.
  let ossVersionNodeId: string | null = null;
  if (sourceType.provenance === 'oss-package') {
    const meta = await readOssPackageMeta(root);
    if (meta) {
      const provenance = buildProvenanceGraph(meta, sourceType.id, root);
      await spec.backend.upsertNodesBulk(provenance.nodes);
      await spec.backend.upsertEdgesBulk(provenance.edges);
      for (const node of provenance.nodes) {
        spec.onEvent?.({ kind: 'node-written', nodeId: node.id, label: node.label });
      }
      for (const edge of provenance.edges) {
        spec.onEvent?.({
          kind: 'edge-written',
          from: edge.from,
          to: edge.to,
          type: edge.label,
        });
      }
      ossVersionNodeId = provenance.versionNodeId;
    }
  }

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

    const chunked: ChunkOutput = await dispatchChunker(
      sourceType.chunker,
      item.relativePath,
      content,
      sourceType.id,
      root,
      bodyExceptionsMatcher,
    );

    spec.onEvent?.({
      kind: 'chunk-produced',
      chunkId: item.relativePath,
      chunkCount: chunked.chunks.length,
      totalTokens: chunked.chunks.reduce(
        (acc: number, c: { text: string }) => acc + Math.ceil(c.text.length / 4),
        0,
      ),
    });

    // Tier 2: tag every node of this file with a coarse semantic domain
    // (deterministic, path-based) so workers can scope retrieval by domain.
    const domain = classifyDomain(item.relativePath, sourceType.id);
    for (const n of chunked.nodes) n.properties.domain = domain;

    // Incremental hash gate. The file's root node (File/Doc) carries a
    // contentHash; if a prior ingest stored the same hash, the file is
    // unchanged — skip the expensive embed + all writes. `force` bypasses.
    // Hash includes the source-type id so re-typing a path re-ingests.
    const fileHash = createHash('sha256')
      .update(sourceType.id)
      .update('\0')
      .update(content)
      .digest('hex');
    const rootNode = chunked.nodes.find(
      (n) => n.label.endsWith('File') || n.label.endsWith('Doc'),
    );
    if (rootNode) rootNode.properties.contentHash = fileHash;
    if (!spec.force && rootNode && typeof spec.backend.getContentHashes === 'function') {
      const existing = await spec.backend.getContentHashes([rootNode.id]);
      if (existing.get(rootNode.id) === fileHash) {
        summary.filesSkipped += 1;
        spec.onEvent?.({ kind: 'item-unchanged', itemId: item.relativePath });
        continue;
      }
    }

    // Write nodes + edges
    await spec.backend.upsertNodesBulk(chunked.nodes);
    for (const node of chunked.nodes) {
      spec.onEvent?.({ kind: 'node-written', nodeId: node.id, label: node.label });
    }

    // OSS provenance: link this file's root-document node back to the
    // package Version. Each chunker emits one root node per file —
    // tree-sitter calls it `File` / `OssFile`, heading-based calls it
    // `Doc` / `OssDoc`. We match either suffix so the BelongsTo edge
    // works for both code and docs source types under oss-package
    // provenance.
    const provenanceEdges =
      ossVersionNodeId !== null
        ? chunked.nodes
            .filter((n) => n.label.endsWith('File') || n.label.endsWith('Doc'))
            .map((rootNode) => ({
              from: rootNode.id,
              to: ossVersionNodeId!,
              label: 'BelongsTo',
              sourceTypeId: sourceType.id,
            }))
        : [];

    await spec.backend.upsertEdgesBulk([...chunked.edges, ...provenanceEdges]);
    for (const edge of [...chunked.edges, ...provenanceEdges]) {
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
      const vectors = await embedder.embed(chunked.chunks.map((c: { text: string }) => c.text));
      if (vectors.length !== chunked.chunks.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${chunked.chunks.length} chunks (file: ${item.relativePath})`,
        );
      }
      const elapsed = Date.now() - t0;
      const items = chunked.chunks.map((c: { nodeId: string; text: string }, i: number) => ({
        nodeId: c.nodeId,
        vector: vectors[i]!,
        meta: { sourceTypeId: sourceType.id, sourceId: root },
      }));
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

  // Cross-source-type linking (Phase C.7). After EITHER oss-code or
  // oss-docs ingest completes, ask the backend (if it supports it) to
  // MERGE Documents edges from OssSection nodes into OssFunction/OssClass
  // nodes whose name appears in the section text.
  //
  // Bidirectional fire — runs at the tail of either source type:
  //   - oss-docs ingest: links the just-written sections to existing
  //     code symbols. The first-time-loading path.
  //   - oss-code ingest: links existing sections to the just-written
  //     code symbols. Catches the "package v2 adds new functions"
  //     case where re-ingesting code should pick up doc references
  //     to new symbols.
  // The link query is idempotent (MERGE), so the second pass after both
  // sides exist just refreshes timestamps; no duplicate edges.
  //
  // Conditions:
  //   - We know the package name (provenance preamble succeeded).
  //   - The backend implements linkDocumentsToSymbols (Neo4jBackend
  //     does; InMemoryGraphBackend doesn't, and this is fine for
  //     test isolation).
  if (
    (sourceType.id === 'oss-docs' || sourceType.id === 'oss-code') &&
    ossVersionNodeId !== null &&
    typeof (spec.backend as { linkDocumentsToSymbols?: unknown }).linkDocumentsToSymbols ===
      'function'
  ) {
    // Extract package name from the version node id ('<name>@<version>').
    const packageName = ossVersionNodeId.split('@')[0]!;
    try {
      const link = (
        spec.backend as unknown as {
          linkDocumentsToSymbols: (n: string) => Promise<number>;
        }
      ).linkDocumentsToSymbols.bind(spec.backend);
      await link(packageName);
    } catch (err) {
      // Linking is best-effort; a failure shouldn't fail the ingest.
      // Surface it as an error event for diagnostics.
      summary.errors += 1;
      spec.onEvent?.({
        kind: 'error',
        phase: 'link-documents',
        message: (err as Error).message,
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  spec.onEvent?.({
    kind: 'source-completed',
    filesIngested: summary.filesIngested,
    filesSkipped: summary.filesSkipped,
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
    `Unknown source type '${typeIdOrCustom}'. v1 catalog: ${Object.keys(BUILTIN_SOURCE_TYPES).join(', ')}`,
  );
}

async function resolveEmbedder(spec: IngestSpecExt): Promise<EmbedderClient> {
  if (spec.embedderClient) return spec.embedderClient;
  if (!spec.embedder) {
    throw new Error(
      'ingest() requires either spec.embedder (config) or spec.embedderClient (pre-built; for tests)',
    );
  }
  return createHttpEmbedderClient({ config: spec.embedder });
}

/** Per-file chunker dispatch. The catalog's chunker.type is the
 *  authoritative selector; this function maps each one to its concrete
 *  implementation + the appropriate input shape. New chunker types
 *  (pdf-page, image-vision, crawler, issue-thread) plug in here. */
async function dispatchChunker(
  chunker: SourceType['chunker'],
  relativePath: string,
  content: string,
  sourceTypeId: string,
  sourceId: string,
  bodyExceptionsMatcher: ((p: string) => boolean) | null,
): Promise<ChunkOutput> {
  switch (chunker.type) {
    case 'heading-based':
      return chunkHeadingBased({
        docId: relativePath,
        title: basename(relativePath),
        content,
        sourceTypeId,
        sourceId,
        maxTokens: chunker.maxTokens,
        overlapTokens: chunker.overlapTokens,
        // oss-docs declares 'Oss' to emit OssDoc + OssSection labels
        // (matches its declared graphSchema).
        labelPrefix: chunker.labelPrefix,
      });
    case 'tree-sitter':
      return chunkCodeFull({
        relativePath,
        content,
        sourceTypeId,
        sourceId,
        // Mode picks per-file:
        //   - bodyExtraction: true  → 'full' for everything
        //   - bodyExtraction: false → 'skeleton-only' by default,
        //     except paths matching bodyExceptions get 'full' (e.g.,
        //     examples/ + READMEs in oss-code)
        mode:
          chunker.bodyExtraction === false
            ? bodyExceptionsMatcher?.(relativePath)
              ? 'full'
              : 'skeleton-only'
            : 'full',
        // Source-type-declared label prefix. oss-code → 'Oss' so
        // emitted nodes (OssFile/OssFunction/OssClass) match the
        // schema's declared labels and the schema's vector indexes
        // actually contain rows.
        labelPrefix: chunker.labelPrefix,
      });
    case 'whole-file':
      return chunkWholeFile({
        docId: relativePath,
        content,
        sourceTypeId,
        sourceId,
      });
    default:
      // Unreachable — the type guard at the top of ingest() rejects
      // unimplemented chunker types before we get here. The exhaustive
      // switch shape lets tsc enforce that future ChunkerRef variants
      // either get a case here or fail typecheck.
      throw new Error(
        `internal: dispatchChunker fell through for chunker type '${(chunker as { type: string }).type}'`,
      );
  }
}
