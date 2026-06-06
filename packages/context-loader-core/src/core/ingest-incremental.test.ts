/**
 * Tests for incremental hash-gated ingest (Tier 5).
 *
 * Re-ingesting an unchanged tree should skip the expensive embed + all
 * writes for every unchanged file (gated on the root node's contentHash).
 * Changing a file re-ingests just that file; `force` bypasses the gate.
 *
 * Uses InMemoryGraphBackend + a counting mock embedder so we can assert
 * that nothing was re-embedded on a full-skip run. No external services.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryGraphBackend } from '../backends/in-memory.ts';
import type { EmbedderClient } from '../index.ts';
import { ingest } from './ingest.ts';

/** Mock embedder that records how many texts it was asked to embed. */
function countingEmbedder(dim = 8): EmbedderClient & { texts: number } {
  const e = {
    dim,
    texts: 0,
    async embed(texts: string[]): Promise<Float32Array[]> {
      e.texts += texts.length;
      return texts.map((_, j) => {
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = ((j + 1) * (i + 1)) % 7;
        return v;
      });
    },
  };
  return e;
}

const SRC = { type: 'code-full', ref: { kind: 'path' as const, path: '' } };
let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ingest-incr-'));
  mkdirSync(join(workdir, 'src'));
  writeFileSync(join(workdir, 'src', 'a.ts'), 'export function aaa() {\n  return 1;\n}\n');
  writeFileSync(join(workdir, 'src', 'b.ts'), 'export function bbb() {\n  return 2;\n}\n');
});

describe('ingest() — incremental hash gating', () => {
  it('skips unchanged files on re-ingest (no re-embed, no vectors written)', async () => {
    const backend = new InMemoryGraphBackend();
    const first = await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: countingEmbedder(),
    });
    expect(first.filesIngested).toBe(2);
    expect(first.filesSkipped).toBe(0);
    expect(first.vectorsWritten).toBeGreaterThan(0);

    const emb = countingEmbedder();
    const second = await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: emb,
    });
    expect(second.filesIngested).toBe(0);
    expect(second.filesSkipped).toBe(2);
    expect(second.vectorsWritten).toBe(0);
    expect(emb.texts).toBe(0); // nothing re-embedded — the whole point
  });

  it('re-ingests only the file whose content changed', async () => {
    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: countingEmbedder(),
    });

    writeFileSync(join(workdir, 'src', 'a.ts'), 'export function aaa() {\n  return 999;\n}\n');
    const second = await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: countingEmbedder(),
    });
    expect(second.filesIngested).toBe(1);
    expect(second.filesSkipped).toBe(1);
  });

  it('force:true re-ingests everything regardless of hash', async () => {
    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: countingEmbedder(),
    });

    const emb = countingEmbedder();
    const second = await ingest({
      source: { ...SRC, ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: emb,
      force: true,
    });
    expect(second.filesSkipped).toBe(0);
    expect(second.filesIngested).toBe(2);
    expect(emb.texts).toBeGreaterThan(0);
  });
});
