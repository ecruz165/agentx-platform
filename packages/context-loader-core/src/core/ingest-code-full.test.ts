/**
 * Smoke test for Phase B.2 — ingest the harness-core package's TS source
 * end-to-end (walk → tree-sitter chunk → embed → InMemoryGraphBackend).
 * Validates the dispatch path in ingest.ts when source.type is 'code-full'.
 *
 * Uses the in-memory backend + a deterministic mock embedder, so no Neo4j
 * or external services needed.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { InMemoryGraphBackend } from '../backends/in-memory.ts';
import { ingest } from './ingest.ts';
import type { EmbedderClient, IngestionEvent } from '../index.ts';

function mockEmbedder(dim = 8): EmbedderClient {
  let counter = 0;
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        counter++;
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = (counter * (i + 1)) % 7;
        return v;
      });
    },
  };
}

describe('ingest() — code-full (smoke)', () => {
  it('ingests harness-core source and emits File + Function/Class nodes with vectors', async () => {
    const harnessCorePath = resolve(__dirname, '../../../harness-core');
    const backend = new InMemoryGraphBackend();
    const events: IngestionEvent[] = [];

    const summary = await ingest({
      source: { type: 'code-full', ref: { kind: 'path', path: harnessCorePath } },
      backend,
      embedderClient: mockEmbedder(8),
      onEvent: (e) => events.push(e),
    });

    // We expect the eight .ts files (including .test.ts) under harness-core/src.
    // Exact count tracks the package's actual layout; we assert "more than zero
    // and equal to chunksWritten == vectorsWritten" rather than pinning a number.
    expect(summary.filesIngested).toBeGreaterThan(0);
    expect(summary.errors).toBe(0);
    expect(summary.chunksWritten).toBeGreaterThan(0);
    expect(summary.vectorsWritten).toBe(summary.chunksWritten);

    // Every ingested .ts file should produce one File node.
    const fileNodes = backend.nodesByLabel('File');
    expect(fileNodes.length).toBe(summary.filesIngested);

    // The package has at least these classes/functions; confirm a few land.
    const symbolNames = backend.nodesByLabel('Function')
      .concat(backend.nodesByLabel('Class'))
      .map((n) => n.properties.name);
    expect(symbolNames.length).toBeGreaterThan(0);

    // Every per-symbol node should have a vector written.
    const symbolNodes = backend.nodesByLabel('Function').concat(backend.nodesByLabel('Class'));
    let vectorsForSymbols = 0;
    for (const n of symbolNodes) {
      if (backend.vectors.has(n.id)) vectorsForSymbols++;
    }
    expect(vectorsForSymbols).toBe(symbolNodes.length);

    // Every symbol should be Contained by its File parent.
    const containsEdges = backend.edgesByLabel('Contains');
    expect(containsEdges.length).toBe(symbolNodes.length);
    for (const e of containsEdges) {
      expect(fileNodes.some((f) => f.id === e.from)).toBe(true);
    }

    // Sanity: the catalog's `code-full` schema was registered.
    expect(backend.schemas).toHaveLength(1);
    expect(backend.schemas[0]!.nodes).toContain('File');
    expect(backend.schemas[0]!.nodes).toContain('Function');

    // Sanity: events were emitted at every phase.
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('item-walked')).toBe(true);
    expect(kinds.has('chunk-produced')).toBe(true);
    expect(kinds.has('node-written')).toBe(true);
    expect(kinds.has('edge-written')).toBe(true);
    expect(kinds.has('chunk-embedded')).toBe(true);
    expect(kinds.has('source-completed')).toBe(true);
  });
});
