import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryGraphBackend } from '../backends/in-memory.ts';
import type { EmbedderClient, IngestionEvent } from '../index.ts';
import { ingest } from './ingest.ts';

/** Deterministic mock embedder — returns constant-shape vectors so tests
 *  exercise the full pipeline without a real embedder service. */
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

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ctx-loader-'));
});

afterEach(() => {
  // Best-effort cleanup; test temp dirs are small.
});

describe('ingest() — prose-markdown', () => {
  it('walks a directory of markdown files and writes nodes/edges/vectors', async () => {
    writeFileSync(
      join(workdir, 'README.md'),
      '# Project\n\nIntro.\n\n## Setup\n\nInstall steps.\n'
    );
    writeFileSync(
      join(workdir, 'guide.md'),
      '# Guide\n\n## Getting started\n\nDo this.\n\n## Advanced\n\nDo that.\n'
    );
    mkdirSync(join(workdir, 'subdir'));
    writeFileSync(
      join(workdir, 'subdir', 'nested.md'),
      '## A\n\ntext\n'
    );

    const backend = new InMemoryGraphBackend();
    const events: IngestionEvent[] = [];

    const summary = await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
      onEvent: (e) => events.push(e),
    });

    expect(summary.filesIngested).toBe(3);
    expect(summary.errors).toBe(0);
    expect(summary.chunksWritten).toBeGreaterThan(0);
    expect(summary.vectorsWritten).toBe(summary.chunksWritten);

    // Each markdown file → one Doc node
    expect(backend.nodesByLabel('Doc')).toHaveLength(3);

    // Sections: README has 2 (Project + Setup), guide has 3 (Guide + 2 H2s),
    // nested has 1 (just the H2 — there's no H1)
    const sections = backend.nodesByLabel('Section');
    expect(sections.length).toBeGreaterThanOrEqual(6);

    // Every section should have a Contains edge from its parent Doc
    const contains = backend.edgesByLabel('Contains');
    expect(contains.length).toBe(sections.length);

    // Every section should have a vector
    for (const s of sections) {
      expect(backend.vectors.has(s.id)).toBe(true);
    }

    // Schema was registered
    expect(backend.schemas).toHaveLength(1);
    expect(backend.schemas[0]!.nodes).toContain('Doc');
    expect(backend.schemas[0]!.nodes).toContain('Section');
  });

  it('emits structured events through the full pipeline', async () => {
    writeFileSync(join(workdir, 'a.md'), '# A\n\n## section\n\ncontent\n');

    const backend = new InMemoryGraphBackend();
    const events: IngestionEvent[] = [];

    await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
      onEvent: (e) => events.push(e),
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('item-walked');
    expect(kinds).toContain('chunk-produced');
    expect(kinds).toContain('node-written');
    expect(kinds).toContain('edge-written');
    expect(kinds).toContain('chunk-embedded');
    expect(kinds).toContain('source-completed');

    const completed = events.find((e) => e.kind === 'source-completed');
    expect(completed).toBeDefined();
  });

  it('skips files matching exclude patterns', async () => {
    mkdirSync(join(workdir, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(
      join(workdir, 'node_modules', 'lib', 'README.md'),
      '# lib\n\ntext\n'
    );
    writeFileSync(join(workdir, 'real.md'), '# real\n\ntext\n');

    const backend = new InMemoryGraphBackend();

    const summary = await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    expect(summary.filesIngested).toBe(1); // only real.md
    expect(backend.nodesByLabel('Doc')).toHaveLength(1);
    expect(backend.nodesByLabel('Doc')[0]!.id).toBe('real.md');
  });

  it('refuses unimplemented source types with a clear error', async () => {
    const backend = new InMemoryGraphBackend();
    await expect(
      ingest({
        source: { type: 'code-full', ref: { kind: 'path', path: workdir } },
        backend,
        embedderClient: mockEmbedder(8),
      })
    ).rejects.toThrow(/only source type 'prose-markdown' is implemented/);
  });

  it('refuses unimplemented source-ref kinds with a clear error', async () => {
    const backend = new InMemoryGraphBackend();
    await expect(
      ingest({
        source: {
          type: 'prose-markdown',
          ref: { kind: 'url', url: 'https://example.com' },
        },
        backend,
        embedderClient: mockEmbedder(8),
      })
    ).rejects.toThrow(/only SourceRef \{ kind: 'path' \} is implemented/);
  });

  it('vector count equals chunk count regardless of file count', async () => {
    writeFileSync(join(workdir, 'a.md'), '# A\n\ntext\n');
    writeFileSync(join(workdir, 'b.md'), '# B\n\ntext\n## sub\n\nmore\n');

    const backend = new InMemoryGraphBackend();
    const summary = await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    expect(summary.vectorsWritten).toBe(summary.chunksWritten);
    expect(backend.vectors.size).toBe(summary.vectorsWritten);
  });
});

describe('InMemoryGraphBackend — vector search smoke test', () => {
  it('searchVectors returns top-K cosine matches', async () => {
    writeFileSync(
      join(workdir, 'a.md'),
      '# A\n\nfirst\n\n## sub\n\nsecond\n'
    );
    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    const sections = backend.nodesByLabel('Section');
    const firstId = sections[0]!.id;
    const queryVec = backend.vectors.get(firstId)!.vector;

    const results = backend.searchVectors(queryVec, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.nodeId).toBe(firstId);
    expect(results[0]!.score).toBeCloseTo(1, 5);
  });
});

describe('embedder client — error path (no real network)', () => {
  it('rejects when embedder returns wrong number of vectors', async () => {
    writeFileSync(join(workdir, 'a.md'), '# A\n\ntext\n');
    const backend = new InMemoryGraphBackend();
    const brokenEmbedder: EmbedderClient = {
      dim: 8,
      async embed(): Promise<Float32Array[]> {
        return []; // wrong count
      },
    };
    await expect(
      ingest({
        source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
        backend,
        embedderClient: brokenEmbedder,
      })
    ).rejects.toThrow();
  });
});

// Use vi to silence unused-import warnings when test cases get pruned
void vi;
